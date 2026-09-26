#!/usr/bin/env python
"""生成 Cubism 导入用 PSD（cubism-import-v2.psd）。

与 v1 的差别：
  1. 不再包含 00_remaining_visible_pixels_REVIEW —— 夹缝像素已在 v2-layers 中归入
     所属部件，剩余 13 处缺口走 ZZ_gap_worklist（人工补画），不混进导入文件；
  2. 每层唯一命名、单一像素层（Cubism 导入规范）；
  3. 图层顺序沿用 v1 PSD 的实测顺序（背面在下、配件在上）；
  4. 去掉 99_REFERENCE_HIDDEN 参考层（Cubism 不应有该层）；
  5. 顶部保留画布尺寸 2048x4096 / RGB 8bit。

同时输出 cubism-import-layers.txt 供人工核对，以及逐层校验 JSON。

用法：
  python build-cubism-import-psd.py --layers <v2_layers_dir> --order <psd> --out <psd>
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--layers", required=True, help="v2-layers 目录（含 53 部件 PNG）")
    ap.add_argument("--order", required=True, help="v1 PSD，用于取权威图层顺序")
    ap.add_argument("--out", required=True)
    ap.add_argument("--canvas", default="2048x4096")
    args = ap.parse_args()

    w, h = (int(v) for v in args.canvas.lower().split("x"))

    # 权威顺序：PSD 从上到下；排除参考层与残留层
    src = PSDImage.open(args.order)
    order: list[str] = []

    def walk(g):
        for l in g:
            if l.is_group():
                walk(l)
            else:
                order.append(l.name)

    walk(src)
    order = [
        n for n in order
        if n != "00_remaining_visible_pixels_REVIEW" and not n.startswith("REFERENCE_")
    ]

    avail = {f[:-4] for f in os.listdir(args.layers) if f.endswith(".png") and not f.startswith("ZZ_")}
    missing = [n for n in order if n not in avail]
    extra = sorted(avail - set(order))
    if missing:
        print(f"ERROR: layers referenced by order but missing on disk: {missing}", file=sys.stderr)
        return 2
    if extra:
        print(f"NOTE: layers on disk not present in order, appending at top: {extra}")

    final_top_to_bottom = extra + order  # 额外层放最上面

    # Cubism 需要透明底：使用 RGBA 模式（与 v1 PSD 一致，4 通道）
    psd = PSDImage.new(mode="RGBA", size=(w, h))
    created = []
    # 逐层加入：psd-tools 的 append 会放在末尾（视觉最上）；为得到精确顺序，
    # 按「底部优先」依次 append，最后 reverse 由 PSD 自行管理不可行，
    # 故改为：从最上层开始逐次 append 并接受其位于最上——psd-tools 语义为 append 到顶层。
    # 为保证顺序，我们从「最底层」开始 append：每 append 一层，它成为新的顶层，
    # 因此按 bottom->top 追加即可得到正确叠放。
    for name in reversed(final_top_to_bottom):
        png = os.path.join(args.layers, name + ".png")
        img = Image.open(png).convert("RGBA")
        if img.size != (w, h):
            img = img.resize((w, h), Image.NEAREST)
        arr = np.array(img)
        # Cubism 不透明度来自 alpha，不需要隐藏层
        layer = PixelLayer.frompil(img, psd, name=name, top=0, left=0)
        psd.append(layer)
        created.append(name)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    psd.save(args.out)

    # 复核
    chk = PSDImage.open(args.out)
    got = []

    def walk2(g):
        for l in g:
            if l.is_group():
                walk2(l)
            else:
                got.append(l.name)

    walk2(chk)
    report = {
        "out": os.path.abspath(args.out),
        "canvas": [w, h],
        "expected_top_to_bottom": final_top_to_bottom,
        "actual_top_to_bottom": got,
        "n_layers": len(got),
        "unique_names": len(set(got)) == len(got),
        "order_matches": got == list(reversed(created)),
        "residual_excluded": "00_remaining_visible_pixels_REVIEW" not in got,
        "reference_excluded": not any(n.startswith("REFERENCE_") for n in got),
        "size_bytes": os.path.getsize(args.out),
    }
    with open(os.path.splitext(args.out)[0] + "-import-layers.txt", "w", encoding="utf-8") as fh:
        fh.write("\n".join(got) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["unique_names"] and report["residual_excluded"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
