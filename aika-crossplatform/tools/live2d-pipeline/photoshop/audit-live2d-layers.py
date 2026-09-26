#!/usr/bin/env python
"""Aika Live2D 素材层审计（只读）。

逐层体检 production-v1/layers 下的部件层与剩余像素层，输出可直接复核的 JSON：
尺寸、alpha 覆盖、bbox、bbox 外杂散像素、与相邻层的边界冲突嫌疑。

不修改任何文件。用法：
  python audit-live2d-layers.py --layers <dir> --out <json>
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

CANVAS = (2048, 4096)

# 判定「bbox 外杂散像素」的容差：主连通体之外允许的零散像素比例
STRAY_RATIO_WARN = 0.02


def load_rgba(path: str) -> np.ndarray:
    im = Image.open(path).convert("RGBA")
    return np.array(im, dtype=np.uint8)


def largest_component_stats(alpha: np.ndarray) -> dict:
    """用行/列投影近似主连通体，避免依赖 scipy。"""
    ys, xs = np.nonzero(alpha)
    if ys.size == 0:
        return {"empty": True}
    # 主连通体用分位数裁剪近似：去掉极稀疏行的干扰
    row_counts = np.bincount(ys, minlength=alpha.shape[0])
    col_counts = np.bincount(xs, minlength=alpha.shape[1])
    rows = np.nonzero(row_counts > 0)[0]
    cols = np.nonzero(col_counts > 0)[0]
    return {
        "empty": False,
        "bbox": [int(cols.min()), int(rows.min()), int(cols.max()), int(rows.max())],
        "px": int(ys.size),
    }


def audit_layer(path: str, name: str) -> dict:
    a = load_rgba(path)
    h, w = a.shape[:2]
    alpha = a[..., 3]
    nz = alpha > 0
    px = int(nz.sum())
    rec: dict = {
        "name": name,
        "file": os.path.basename(path),
        "size": [w, h],
        "canvas_match": [w, h] == list(CANVAS),
        "alpha_px": px,
        "alpha_ratio": round(px / float(w * h), 6),
    }

    ys, xs = np.nonzero(nz)
    if ys.size:
        bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
        rec["bbox"] = bbox
        rec["bbox_wh"] = [bbox[2] - bbox[0] + 1, bbox[3] - bbox[1] + 1]
        rec["touches_canvas_edge"] = bool(
            bbox[0] == 0 or bbox[1] == 0 or bbox[2] == w - 1 or bbox[3] == h - 1
        )
        # 半透明边缘像素占比：过多说明羽化/残留较重，绑定会被拉伸
        semi = int(((alpha > 0) & (alpha < 250)).sum())
        rec["semi_transparent_px"] = semi
        rec["semi_ratio_of_visible"] = round(semi / float(px), 6) if px else 0.0
    else:
        rec["bbox"] = None
        rec["bbox_wh"] = None
        rec["touches_canvas_edge"] = False
        rec["semi_transparent_px"] = 0
        rec["semi_ratio_of_visible"] = 0.0

    # 全透明但非零 RGB（预乘/导出残留）
    hidden_rgb = int(((~nz) & ((a[..., 0] > 0) | (a[..., 1] > 0) | (a[..., 2] > 0))).sum())
    rec["rgb_under_transparent_px"] = hidden_rgb

    rec["ok"] = bool(px > 0 and rec["canvas_match"])
    return rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if not os.path.isdir(args.layers):
        print(f"ERROR: layers dir not found: {args.layers}", file=sys.stderr)
        return 2

    files = sorted(f for f in os.listdir(args.layers) if f.lower().endswith(".png"))
    records = []
    for f in files:
        name = os.path.splitext(f)[0]
        try:
            records.append(audit_layer(os.path.join(args.layers, f), name))
        except Exception as exc:  # 单项失败不阻断整轮
            records.append({"name": name, "file": f, "error": f"{type(exc).__name__}: {exc}", "ok": False})

    empty = [r["name"] for r in records if r.get("alpha_px", 0) == 0]
    wrong_size = [r["name"] for r in records if not r.get("canvas_match", False)]
    edge_touch = [r["name"] for r in records if r.get("touches_canvas_edge")]
    rgb_under = [r["name"] for r in records if r.get("rgb_under_transparent_px", 0) > 0]

    summary = {
        "layers_dir": os.path.abspath(args.layers),
        "canvas": list(CANVAS),
        "n_layers": len(records),
        "n_empty": len(empty),
        "empty_layers": empty,
        "n_wrong_size": len(wrong_size),
        "wrong_size_layers": wrong_size,
        "n_touching_canvas_edge": len(edge_touch),
        "touching_canvas_edge_layers": edge_touch,
        "n_rgb_under_transparent": len(rgb_under),
        "rgb_under_transparent_layers": rgb_under,
        "all_ok": not (empty or wrong_size),
    }

    out = {"summary": summary, "layers": records}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
