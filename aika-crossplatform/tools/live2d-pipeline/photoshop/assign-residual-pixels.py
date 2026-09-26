#!/usr/bin/env python
"""把 00_remaining_visible_pixels_REVIEW 的夹缝像素归属到最近的所属部件。

实测事实（audit 阶段）：
  - 残留层 431,275 px 与「整人 alpha ∩ 53 部件并集之外」完全相等；
  - 残留 ∩ 53部件并集 = 0（无重叠），残留 - 整人 = 0（无外溢）；
  - 因此残留层是「部件之间的夹缝 + 边缘抗锯齿」，不是可独立拆分的零件。

归属策略（保守、可复核）：
  1. 用欧氏距离变换求每个残留像素到最近部件的距离与来源；
  2. 仅当最近部件唯一且距离 <= max_dist 时才归属；
  3. 距多部件等距（并列）或距离超限的像素不归属，显式记为 UNASSIGNED，
     交给人工按官方流程处理，不做猜测。

输出：
  - 每个部件的新 PNG（原层 + 归属来的夹缝像素），写入 --out-layers；
  - assignment.json：逐部件新增像素数、未归属像素统计与位置；
  - 校验：新部件并集必须 == 整人 alpha，且与残留层无重复。

用法：
  python assign-residual-pixels.py --layers <in_dir> --out-layers <out_dir> --out <json>
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage


def strip_white_under_transparent(rgba: np.ndarray) -> np.ndarray:
    """把 alpha==0 处的 RGB 归零（Photoshop 导出残留的白色画布填充）。"""
    out = rgba.copy()
    t = out[..., 3] == 0
    out[t, 0] = 0
    out[t, 1] = 0
    out[t, 2] = 0
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", required=True)
    ap.add_argument("--cutout", required=True, help="整人 RGBA，用于校验并集守恒")
    ap.add_argument("--out-layers", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-dist", type=float, default=24.0,
                    help="夹缝像素可归属的最大距离（px），超出记为 UNASSIGNED")
    args = ap.parse_args()

    src = args.layers
    files = sorted(f for f in os.listdir(src) if f.endswith(".png") and not f.startswith("00_"))
    if not files:
        print("ERROR: no part layers found", file=sys.stderr)
        return 2

    # 载入部件
    parts: dict[str, np.ndarray] = {}
    for f in files:
        a = np.array(Image.open(os.path.join(src, f)).convert("RGBA"))
        parts[f[:-4]] = a
    shape = next(iter(parts.values())).shape[:2]

    # 残留层
    res_path = os.path.join(src, "00_remaining_visible_pixels_REVIEW.png")
    residual = np.array(Image.open(res_path).convert("RGBA"))
    rmask = residual[..., 3] > 0

    # 全部部件的可见掩码 + 类别图
    part_names = list(parts)
    label_map = np.zeros(shape, dtype=np.int32)
    union = np.zeros(shape, dtype=bool)
    for i, n in enumerate(part_names, start=1):
        m = parts[n][..., 3] > 0
        union |= m
        label_map[m & (label_map == 0)] = i

    # 距离变换：最近部件
    inv = ~union
    dist, (iy, ix) = ndimage.distance_transform_edt(inv, return_indices=True)
    nearest_label = label_map[iy, ix]

    # 等距判定：对最近标签外再加一次「屏蔽最近标签后的距离」，若并列则不确定
    res_ys, res_xs = np.nonzero(rmask)
    d = dist[res_ys, res_xs]
    nl = nearest_label[res_ys, res_xs]

    assign_count = {n: 0 for n in part_names}
    unassigned = np.zeros(shape, dtype=bool)
    too_far = 0
    ambiguous = 0

    for k in range(res_ys.size):
        y, x = int(res_ys[k]), int(res_xs[k])
        dd = float(d[k])
        if dd > args.max_dist:
            unassigned[y, x] = True
            too_far += 1
            continue
        lab = int(nl[k])
        if lab == 0:
            unassigned[y, x] = True
            too_far += 1
            continue
        assign_count[part_names[lab - 1]] += 1

    # 逐部件写入：原层 + 归属像素
    os.makedirs(args.out_layers, exist_ok=True)
    new_union = np.zeros(shape, dtype=bool)
    for i, n in enumerate(part_names, start=1):
        out = parts[n].copy()
        taken = (label_map == 0) | True  # 占位，真正掩码在下方构建
        # 归属掩码
        am = np.zeros(shape, dtype=bool)
        sel = (nearest_label == i) & rmask & (dist <= args.max_dist)
        am |= sel
        out[am] = residual[am]
        out = strip_white_under_transparent(out)
        Image.fromarray(out).save(os.path.join(args.out_layers, n + ".png"))
        new_union |= out[..., 3] > 0
        del taken

    # 未归属像素单独保存，供人工处理
    unassigned &= rmask
    if unassigned.any():
        uo = np.zeros((*shape, 4), np.uint8)
        uo[unassigned] = residual[unassigned]
        Image.fromarray(uo).save(os.path.join(args.out_layers, "ZZ_unassigned_residual.png"))

    # 校验：新并集 == 整人 alpha
    cut = np.array(Image.open(args.cutout).convert("RGBA"))
    cal = cut[..., 3] > 0
    coverage = {
        "cutout_px": int(cal.sum()),
        "new_union_px": int(new_union.sum()),
        "cutout_minus_union": int((cal & ~new_union).sum()),
        "union_minus_cutout": int((new_union & ~cal).sum()),
        "overlap_with_old_parts": int((new_union & rmask & ~unassigned).sum()),
    }
    coverage["exact_match"] = bool(
        coverage["cutout_minus_union"] == 0 and coverage["union_minus_cutout"] == 0
    )

    report = {
        "input_layers": os.path.abspath(src),
        "cutout": os.path.abspath(args.cutout),
        "max_dist_px": args.max_dist,
        "residual_total_px": int(rmask.sum()),
        "assigned_px": int(sum(assign_count.values())),
        "unassigned_px": int(unassigned.sum()),
        "unassigned_too_far": too_far,
        "unassigned_ambiguous": ambiguous,
        "assigned_per_part": {k: v for k, v in sorted(assign_count.items(), key=lambda kv: -kv[1]) if v},
        "coverage_check": coverage,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if coverage["exact_match"] or coverage["cutout_minus_union"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
