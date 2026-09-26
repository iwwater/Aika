#!/usr/bin/env python
"""把 13 处「缺口」像素按显式规则归属到语义正确的部件。

背景：这些缺口与母稿逐像素一致（有可用源色），且各自邻接 3–4 个部件。
谁「应该」拥有它属绑定决策，因此不做几何猜测，而用**显式规则表**，
规则全部写在此文件顶部的 RULES 中，可人工审查与覆盖。

规则依据（按部位解剖与形变意图）：
  - 领口/内领缺口 → neck（颈部形变时随之移动；归属 dress_front 会在低头时撕裂领口）
  - 裙摆分片之间 → dress_front（前裙是主形变体，侧缝归背片会导致摆幅错位）
  - 全息衣摆内腔 → holo_coattail_*（该腔体是衣摆自身的镂空，随衣摆摆动）
  - 双腿之间 → 按 x 中线就近腿（该处为大腿内侧面，属腿形变）
  - 袖口内 → cuff_*（袖口独立形变）
  - 发束与袖之间的空隙 → hair_back_*（后发覆盖优先级最低但体量最大，
    且该空隙在母稿中属后发的可见边缘）

用法：
  python assign-gaps-v3.py --layers <v2-layers> --gaps <v2-build.json> --out-layers <v3-layers> --out <json>
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

# 显式规则：gap_id -> 归属部件（屏幕左右语义已按 bbox 中心 x 判定）
RULES: dict[str, str] = {
    "GAP-011": "neck",                   # 领口内领（y 830-928, 居中）
    "GAP-066": "dress_front",            # 前裙右侧分片缝（主形变体）
    "GAP-110": "dress_front",            # 裙摆中缝（双腿上方）
    "GAP-139": "holo_coattail_screenRight",
    "GAP-138": "holo_coattail_screenLeft",
    "GAP-053": "hair_back_screenLeft_outer",
    "GAP-107": "hair_back_screenRight_lower",
    "GAP-010": "hair_back_screenLeft_outer",
    "GAP-063": "hair_back_screenRight_outer",
    "GAP-089": "cuff_screenRight",
    "GAP-094": "cuff_screenLeft",
    "GAP-194": "leg_screenRight",
    "GAP-136": "holo_coattail_screenRight",
}

CANVAS_W = 2048


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", required=True)
    ap.add_argument("--gaps", required=True, help="v2-build.json")
    ap.add_argument("--out-layers", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--strict", action="store_true", help="有未覆盖的 gap 时退出码 1")
    args = ap.parse_args()

    build = json.load(open(args.gaps, encoding="utf-8"))
    gaps = build["gaps"]

    src = args.layers
    files = sorted(f for f in os.listdir(src) if f.endswith(".png") and not f.startswith("ZZ_"))
    layers = {f[:-4]: np.array(Image.open(os.path.join(src, f)).convert("RGBA")) for f in files}
    shape = next(iter(layers.values())).shape[:2]

    gapimg = np.array(Image.open(os.path.join(src, "ZZ_gap_worklist.png")).convert("RGBA"))
    gmask_all = gapimg[..., 3] > 0
    # 每个 gap 的 mask：用连通域按 id 关联（build 阶段已保证 id 与连通域一致）
    lab, n = ndimage.label(gmask_all, structure=np.ones((3, 3)))

    applied = []
    unmatched = []
    new_union = np.zeros(shape, bool)
    for name, arr in layers.items():
        new_union |= arr[..., 3] > 0

    for g in gaps:
        gid = g["id"]
        target = RULES.get(gid)
        if target is None or target not in layers:
            unmatched.append({"id": gid, "reason": "no rule or target missing", "target": target})
            continue
        x0, y0, x1, y1 = g["bbox"]
        # 在该 bbox 内找 gap 连通域
        sub = gmask_all[y0:y1 + 1, x0:x1 + 1]
        sel = np.zeros(shape, bool)
        sel[y0:y1 + 1, x0:x1 + 1] = sub
        placed = int(sel.sum())
        if placed == 0:
            unmatched.append({"id": gid, "reason": "empty selection"})
            continue
        dst = layers[target]
        dst[sel] = gapimg[sel]
        applied.append({"id": gid, "target": target, "px": placed,
                        "center_x": (x0 + x1) // 2, "center_y": (y0 + y1) // 2})

    os.makedirs(args.out_layers, exist_ok=True)
    for name, arr in layers.items():
        t = arr[..., 3] == 0
        arr[t, :3] = 0
        Image.fromarray(arr).save(os.path.join(args.out_layers, name + ".png"))

    # 校验：新并集 vs 整人
    cut = np.array(Image.open(build["cutout"]).convert("RGBA"))
    cal = cut[..., 3] > 0
    union2 = np.zeros(shape, bool)
    for name in layers:
        union2 |= np.array(Image.open(os.path.join(args.out_layers, name + ".png")).convert("RGBA"))[..., 3] > 0

    cov = {
        "cutout_px": int(cal.sum()),
        "v3_union_px": int(union2.sum()),
        "cutout_minus_union": int((cal & ~union2).sum()),
        "union_minus_cutout": int((union2 & ~cal).sum()),
    }
    cov["exact_match"] = cov["cutout_minus_union"] == 0 and cov["union_minus_cutout"] == 0

    report = {
        "in_layers": os.path.abspath(src),
        "out_layers": os.path.abspath(args.out_layers),
        "n_gaps": len(gaps),
        "n_applied": len(applied),
        "n_unmatched": len(unmatched),
        "applied": applied,
        "unmatched": unmatched,
        "coverage_check": cov,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    json.dump(report, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    print(f"gaps={len(gaps)} applied={len(applied)} unmatched={len(unmatched)}")
    print(f"coverage cutout_minus_union={cov['cutout_minus_union']} union_minus_cutout={cov['union_minus_cutout']} exact={cov['exact_match']}")
    for a in applied:
        print(f"  {a['id']} -> {a['target']} ({a['px']}px)")
    for u in unmatched:
        print(f"  UNMATCHED {u}")

    if args.strict and cov["cutout_minus_union"] != 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
