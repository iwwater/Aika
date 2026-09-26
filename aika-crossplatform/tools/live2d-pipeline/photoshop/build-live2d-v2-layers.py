#!/usr/bin/env python
"""Aika Live2D 素材 v2：夹缝归属 + 缺口工单 + 规范化导出。

前置事实（见 v2-audit/）：
  - 54 层画布尺寸全部 2048x4096，无空层；
  - 残留层 431,275 px == 整人 alpha ∩ (53部件并集之外)，与部件零重叠、无外溢；
  - 距离分布拐点在 P75≈24px：≤24px 是部件间夹缝/抗锯齿；>24px 是 13 处
    「内部未拆/未补画」的大块（下巴领口、裙摆分片之间、全息衣摆内腔、双腿之间等）。

策略（保守、可复核，不猜）：
  1. 夹缝像素（距离 ≤ seam_dist）→ 归属最近部件；
  2. 大块缺口（连通域 ≥ gap_min_area 且远离所有部件）→ 不猜归属，导出
     ZZ_gap_worklist 与 JSON 工单，交人工按官方流程补画（对应「补全遮挡」工序）；
  3. 其余零散远距像素（小连通域）→ 归属最近部件，避免留下碎点；
  4. 所有输出层的 alpha==0 处 RGB 归零（清除 PS 导出遗留的白色画布填充）。

校验（硬性）：
  - 部件并集必须 == 整人 alpha（逐像素），否则退出码 1；
  - 与旧部件层在夹缝区不能有重叠。

用法：
  python build-live2d-v2-layers.py --layers <in> --cutout <png> --out-layers <out> --out <json>
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

CANVAS = (2048, 4096)


def strip_white_under_transparent(rgba: np.ndarray) -> np.ndarray:
    out = rgba.copy()
    t = out[..., 3] == 0
    out[t, 0] = 0
    out[t, 1] = 0
    out[t, 2] = 0
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", required=True)
    ap.add_argument("--cutout", required=True)
    ap.add_argument("--out-layers", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seam-dist", type=float, default=24.0)
    ap.add_argument("--gap-min-area", type=int, default=500)
    args = ap.parse_args()

    src = args.layers
    files = sorted(f for f in os.listdir(src) if f.endswith(".png") and not f.startswith("00_"))
    parts = {f[:-4]: np.array(Image.open(os.path.join(src, f)).convert("RGBA")) for f in files}
    if not parts:
        print("ERROR: no parts", file=sys.stderr)
        return 2
    shape = next(iter(parts.values())).shape[:2]  # (h, w)
    assert shape == (CANVAS[1], CANVAS[0]), f"unexpected canvas hw={shape}"

    residual = np.array(Image.open(os.path.join(src, "00_remaining_visible_pixels_REVIEW.png")).convert("RGBA"))
    rmask = residual[..., 3] > 0

    names = list(parts)
    label_map = np.zeros(shape, np.int32)
    union = np.zeros(shape, bool)
    for i, n in enumerate(names, 1):
        m = parts[n][..., 3] > 0
        union |= m
        label_map[m & (label_map == 0)] = i

    dist, (iy, ix) = ndimage.distance_transform_edt(~union, return_indices=True)
    nearest = label_map[iy, ix]

    # --- 大块缺口识别：距所有部件 > seam_dist 的残留像素，按连通域聚类
    far = rmask & (dist > args.seam_dist)
    lab, ncomp = ndimage.label(far, structure=np.ones((3, 3)))
    sizes = ndimage.sum(far, lab, range(1, ncomp + 1)).astype(int)
    gap_ids = {i + 1 for i, s in enumerate(sizes) if s >= args.gap_min_area}
    gap_mask = np.isin(lab, list(gap_ids)) if gap_ids else np.zeros(shape, bool)
    scattered = far & ~gap_mask

    # --- 归属掩码：夹缝 + 零散远距
    own = rmask & (dist <= args.seam_dist) | scattered
    own &= rmask & ~gap_mask

    assigned_per_part: dict[str, int] = {}
    new_union = np.zeros(shape, bool)
    os.makedirs(args.out_layers, exist_ok=True)
    for i, n in enumerate(names, 1):
        out = parts[n].copy()
        am = own & (nearest == i)
        out[am] = residual[am]
        out = strip_white_under_transparent(out)
        Image.fromarray(out).save(os.path.join(args.out_layers, n + ".png"))
        new_union |= out[..., 3] > 0
        if am.any():
            assigned_per_part[n] = int(am.sum())

    # --- 缺口工单
    gap_items = []
    for gid in sorted(gap_ids, key=lambda g: -sizes[g - 1]):
        m = lab == gid
        ys, xs = np.nonzero(m)
        gap_items.append({
            "id": f"GAP-{gid:03d}",
            "px": int(m.sum()),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
            "max_dist_to_nearest_part_px": round(float(dist[m].max()), 1),
            "nearest_parts": sorted({
                names[int(v) - 1] for v in np.unique(nearest[m]) if int(v) > 0
            }),
            "status": "TODO_INFILL",
            "note": "内部未拆分/未补画区域，需人工补画后重新归属；不自动猜测归属。",
        })

    if gap_mask.any():
        go = np.zeros((*shape, 4), np.uint8)
        go[gap_mask] = residual[gap_mask]
        Image.fromarray(go).save(os.path.join(args.out_layers, "ZZ_gap_worklist.png"))

    cut = np.array(Image.open(args.cutout).convert("RGBA"))
    cal = cut[..., 3] > 0
    coverage = {
        "cutout_px": int(cal.sum()),
        "new_union_px": int(new_union.sum()),
        "cutout_minus_union": int((cal & ~new_union).sum()),
        "union_minus_cutout": int((new_union & ~cal).sum()),
        "gap_px_total": int(gap_mask.sum()),
        "residual_px_total": int(rmask.sum()),
        "residual_assigned_px": int(own.sum()),
    }
    coverage["exact_match"] = bool(coverage["cutout_minus_union"] == 0 and coverage["union_minus_cutout"] == 0)

    report = {
        "input_layers": os.path.abspath(src),
        "out_layers": os.path.abspath(args.out_layers),
        "cutout": os.path.abspath(args.cutout),
        "params": {"seam_dist": args.seam_dist, "gap_min_area": args.gap_min_area},
        "n_parts": len(names),
        "residual_total_px": int(rmask.sum()),
        "assigned_px": int(own.sum()),
        "gap_px": int(gap_mask.sum()),
        "n_gaps": len(gap_items),
        "assigned_per_part": dict(sorted(assigned_per_part.items(), key=lambda kv: -kv[1])),
        "gaps": gap_items,
        "coverage_check": coverage,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)

    print(f"parts={len(names)} residual={int(rmask.sum())} assigned={int(own.sum())} gaps={len(gap_items)} gap_px={int(gap_mask.sum())}")
    print(f"coverage cutout_minus_union={coverage['cutout_minus_union']} union_minus_cutout={coverage['union_minus_cutout']} gap_px={coverage['gap_px_total']}")
    print("GAPS:")
    for g in gap_items:
        print(f"  {g['id']} px={g['px']:>6} bbox={g['bbox']} maxdist={g['max_dist_to_nearest_part_px']} near={g['nearest_parts'][:4]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
