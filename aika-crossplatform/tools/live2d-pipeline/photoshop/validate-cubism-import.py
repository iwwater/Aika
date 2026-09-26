#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Cubism PSD 导入前校验（只读）。

对照 Live2D Cubism 官方 PSD 导入规范，逐项检查交付 PSD 是否可被正确导入：

  1. 文档规格：尺寸、色彩模式、位深、透明底
  2. 图层规范：数量、命名唯一性、空层、残留层/参考层
  3. 每层几何：尺寸是否与文档一致、bbox、alpha 覆盖
  4. 图层顺序：后发在最底、配件在最上（与预期顺序逐项比对）
  5. ArtMesh 预算：FREE 版 100 上限的余量提示
  6. 部件语义：按解剖分组，输出标准对话级绑定所需的参数映射输入

输出：
  --out-json  JSON 报告（机器可读）
  --out-md    中文 Markdown 报告（人工审阅）

用法（cwd = 仓库根）：
  C:/Users/BAi/.workbuddy/binaries/python/envs/live2d/Scripts/python.exe \
    tools/live2d-pipeline/photoshop/validate-cubism-import.py \
    --psd output/live2d/production-v1/v3/cubism-import-v3.psd \
    --order output/live2d/production-v1/v3/cubism-import-layers-ps.txt \
    --out-json output/live2d/production-v1/v3/import-validation.json \
    --out-md  output/live2d/production-v1/v3/导入校验报告.md
"""

from __future__ import annotations

import argparse
import io
import json
import os
import struct
import sys

import numpy as np
from PIL import Image
from psd_tools import PSDImage

# --------------------------------------------------------------------------
# 官方规格（Live2D Cubism）
# --------------------------------------------------------------------------
# Cubism 建议的 PSD 上限：单边 <= 4096（2 的幂次更稳妥）。
MAX_DIM = 4096
# FREE 版单模型 ArtMesh 上限。
ARTMESH_LIMIT_FREE = 100
# 不透明区 RGB 允许的最大差（8bit 取整容差：1/255）。
RGB_OPAQUE_TOL = 1
# 允许命名中出现但必须剔除的非部件层关键词。
NON_PART_KEYWORDS = ("remaining", "reference", "参考", "残留", "_bg", "background")

# 期望的图层顺序：自顶（最前）向底（最后）。用于核对绘制顺序是否符合人形遮挡关系。
EXPECTED_ORDER = [
    "halo_orbital",
    "glasses_bridge",
    "glasses_rim_screenLeft",
    "glasses_rim_screenRight",
    "chest_diamond",
    "brow_screenLeft",
    "brow_screenRight",
    "nose",
    "eye_highlight_screenLeft",
    "eye_highlight_screenRight",
    "eye_iris_screenLeft",
    "eye_iris_screenRight",
    "eye_lash_upper_screenLeft",
    "eye_lash_upper_screenRight",
    "eye_white_screenLeft",
    "eye_white_screenRight",
    "mouth_neutral",
    "bang_screenLeft_inner",
    "bang_screenRight_inner",
    "bang_screenLeft_outer",
    "bang_screenRight_outer",
    "hair_braid_screenLeft",
    "hair_braid_screenRight",
    "hair_sideLock_screenLeft",
    "hair_sideLock_screenRight",
    "face_skin",
    "forehead_skin",
    "ear_screenLeft",
    "ear_screenRight",
    "neck",
    "hand_screenLeft",
    "hand_screenRight",
    "cuff_screenLeft",
    "cuff_screenRight",
    "holo_sleeve_screenLeft",
    "holo_sleeve_screenRight",
    "jacket_sleeve_screenLeft",
    "jacket_sleeve_screenRight",
    "jacket_front_screenLeft",
    "jacket_front_screenRight",
    "holo_coattail_screenLeft",
    "holo_coattail_screenRight",
    "dress_front",
    "dress_back_screenLeft",
    "dress_back_screenRight",
    "boot_screenLeft",
    "boot_screenRight",
    "leg_screenLeft",
    "leg_screenRight",
    "hair_back_screenLeft_outer",
    "hair_back_screenRight_outer",
    "hair_back_screenLeft_lower",
    "hair_back_screenRight_lower",
]

# 部件 → 解剖分组。用于生成绑定计划的输入（哪些部件共用同一组变形器）。
PART_GROUP = {
    # 头部（随 ParamAngleX/Y/Z 旋转）
    "head": [
        "face_skin", "forehead_skin", "nose", "ear_screenLeft", "ear_screenRight",
        "brow_screenLeft", "brow_screenRight",
        "eye_white_screenLeft", "eye_white_screenRight",
        "eye_iris_screenLeft", "eye_iris_screenRight",
        "eye_highlight_screenLeft", "eye_highlight_screenRight",
        "eye_lash_upper_screenLeft", "eye_lash_upper_screenRight",
        "mouth_neutral",
        "glasses_bridge", "glasses_rim_screenLeft", "glasses_rim_screenRight",
    ],
    # 头发（部分随头部，部分挂物理）
    "hair_front": [
        "bang_screenLeft_inner", "bang_screenRight_inner",
        "bang_screenLeft_outer", "bang_screenRight_outer",
        "hair_braid_screenLeft", "hair_braid_screenRight",
    ],
    "hair_side": ["hair_sideLock_screenLeft", "hair_sideLock_screenRight"],
    # 身体（随 ParamBodyAngleX 摆动）
    "body": [
        "neck", "jacket_front_screenLeft", "jacket_front_screenRight",
        "jacket_sleeve_screenLeft", "jacket_sleeve_screenRight",
        "holo_sleeve_screenLeft", "holo_sleeve_screenRight",
        "cuff_screenLeft", "cuff_screenRight",
        "hand_screenLeft", "hand_screenRight",
        "dress_front", "dress_back_screenLeft", "dress_back_screenRight",
        "leg_screenLeft", "leg_screenRight",
        "boot_screenLeft", "boot_screenRight",
    ],
    # 配件（多为硬质，随头部或身体；光环可独立动）
    "accessory": [
        "halo_orbital", "chest_diamond",
        "holo_coattail_screenLeft", "holo_coattail_screenRight",
    ],
    # 后发（物理主战场）
    "hair_back": [
        "hair_back_screenLeft_outer", "hair_back_screenRight_outer",
        "hair_back_screenLeft_lower", "hair_back_screenRight_lower",
    ],
}


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------
def read_psd_header(path: str) -> dict:
    """直接读 PSD 文件头，不依赖 psd_tools（用于独立交叉校验）。"""
    with open(path, "rb") as f:
        head = f.read(26)
    sig = head[:4]
    version = struct.unpack(">H", head[4:6])[0]
    channels = struct.unpack(">H", head[12:14])[0]
    height, width = struct.unpack(">II", head[14:22])
    depth, mode = struct.unpack(">HH", head[22:26])
    mode_name = {0: "Bitmap", 1: "Grayscale", 2: "Indexed", 3: "RGB",
                 4: "CMYK", 7: "Multichannel", 8: "Duotone", 9: "Lab"}.get(mode, "?")
    return {
        "signature": sig.decode("latin-1"),
        "version": version,
        "channels": channels,
        "height": height,
        "width": width,
        "depth": depth,
        "color_mode": mode,
        "color_mode_name": mode_name,
    }


def iter_leaf_layers(layer, depth=0):
    """递归展开图层树，产出 (layer, depth)。group 不是像素层，需要下钻。"""
    if layer.is_group():
        for child in layer:
            yield from iter_leaf_layers(child, depth + 1)
    else:
        yield layer, depth


# --------------------------------------------------------------------------
# 主校验流程
# --------------------------------------------------------------------------
def validate(psd_path: str, order_path: str | None) -> dict:
    report: dict = {
        "psd": os.path.basename(psd_path),
        "checks": [],
        "blocking": [],
        "warnings": [],
        "info": [],
    }

    def check(name, ok, detail, blocking=True, hint=""):
        entry = {"check": name, "ok": bool(ok), "detail": detail}
        if hint:
            entry["hint"] = hint
        report["checks"].append(entry)
        if not ok:
            (report["blocking"] if blocking else report["warnings"]).append(
                {"check": name, "detail": detail, "hint": hint}
            )
        return ok

    # ---------- 1. 文件头 ----------
    hdr = read_psd_header(psd_path)
    report["header"] = hdr

    check("文件签名 8BPS", hdr["signature"] == "8BPS",
          "signature=%r" % hdr["signature"])
    check("PSD 版本 1", hdr["version"] == 1, "version=%d" % hdr["version"])
    check("色彩模式 RGB", hdr["color_mode"] == 3,
          "mode=%d (%s)" % (hdr["color_mode"], hdr["color_mode_name"]),
          hint="Cubism 只接受 RGB 模式。")
    check("位深 8bit", hdr["depth"] == 8, "depth=%d" % hdr["depth"],
          hint="Cubism 要求 8bit。")
    check("含 alpha 通道", hdr["channels"] >= 4, "channels=%d" % hdr["channels"],
          hint="需要 RGBA 才能表达透明底。")
    ok_dim = hdr["width"] <= MAX_DIM and hdr["height"] <= MAX_DIM
    check("单边 <= %d" % MAX_DIM, ok_dim,
          "%dx%d" % (hdr["width"], hdr["height"]))
    report["info"].append("文档尺寸 %d x %d" % (hdr["width"], hdr["height"]))

    # ---------- 2. 图层读取 ----------
    psd = PSDImage.open(psd_path)
    # 顺序检查必须用「画布级」的绘制顺序：psd-tools 的 `for layer in psd` 迭代
    # 是自底向上的，这里反转成自顶向下（= 绘制顺序，先画底层）。
    # 注意：若存在图层组，组内顺序需要展开；本 PSD 无组，若将来有组则此处需递归。
    top_down = [l.name for l in reversed(list(psd))]
    groups_present = [l.name for l in psd if l.is_group()]
    leaves = list(iter_leaf_layers(psd))
    names = [l.name for l, _ in leaves]
    report["layer_count"] = len(leaves)
    report["top_down_order"] = top_down
    report["has_groups"] = bool(groups_present)

    doc_w, doc_h = psd.width, psd.height

    check("无图层组（扁平结构）", not groups_present,
          "组=%s" % (groups_present if groups_present else "无"),
          blocking=False,
          hint="Cubism 导入时会展开图层组；扁平结构更可控。")

    # 命名唯一性
    dupes = sorted({n for n in names if names.count(n) > 1})
    check("图层命名唯一", not dupes,
          "重复=%s" % (dupes if dupes else "无"),
          hint="Cubism 用图层名作部件 ID，重名会覆盖。")

    # 非部件层
    non_parts = [n for n in names
                 if any(k.lower() in n.lower() for k in NON_PART_KEYWORDS)]
    check("无残留/参考层", not non_parts,
          "命中=%s" % (non_parts if non_parts else "无"))

    # 通用占位名
    generic = [n for n in names if n.strip().lower() in ("layer", "图层", "copy")]
    check("无未命名占位层", not generic,
          "命中=%s" % (generic if generic else "无"),
          hint="占位名说明生成时未传入 name。")

    # ---------- 3. 逐层几何 ----------
    # 重要：本 PSD 的图层是「裁剪层」（trimmed），layer.numpy() 返回 bbox 尺寸的数据，
    # 位置信息在 layer.bbox = (left, top, right, bottom) 里。因此不能用
    # layer.width/height 去和文档尺寸比较 —— 那是裁剪后的尺寸，属正常。
    # 正确的「尺寸规范」检查是：numpy 数据尺寸 == bbox 尺寸，且 bbox 落在画布内。
    per_layer = []
    empty_layers = []
    size_mismatch = []      # numpy 数据尺寸与 bbox 不符（真正的数据损坏）
    bbox_out_of_canvas = []  # bbox 越出画布
    for layer, depth in leaves:
        try:
            l, t, r, b = layer.bbox
        except Exception:
            bbox_out_of_canvas.append({"name": layer.name, "bbox": None})
            continue
        img = layer.numpy()  # (h, w, 4) float32 0..1，尺寸 = bbox 尺寸
        bh, bw = b - t, r - l
        if img.shape[0] != bh or img.shape[1] != bw:
            size_mismatch.append({
                "name": layer.name,
                "bbox_size": [bw, bh],
                "numpy_size": [img.shape[1], img.shape[0]],
            })
        if l < 0 or t < 0 or r > doc_w or b > doc_h:
            bbox_out_of_canvas.append({
                "name": layer.name, "bbox": [int(l), int(t), int(r), int(b)],
                "canvas": [doc_w, doc_h],
            })

        alpha = img[..., 3] if img.shape[-1] == 4 else None
        if alpha is None:
            empty_layers.append(layer.name)
            continue
        cov = float((alpha > 0.003921).sum())
        if cov == 0:
            empty_layers.append(layer.name)
        ys, xs = np.nonzero(alpha > 0.003921)
        local_bbox = ([int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
                      if cov else None)
        per_layer.append({
            "name": layer.name,
            "z_index": len(per_layer),
            "bbox": [int(l), int(t), int(r), int(b)],
            "bbox_size": [int(bw), int(bh)],
            "local_content_bbox": local_bbox,
            "alpha_coverage_px": int(cov),
            "alpha_coverage_pct": round(cov / (doc_w * doc_h) * 100, 4),
            "semi_transparent_px": int(((alpha > 0.003921) & (alpha < 0.996078)).sum()),
            "trimmed": [int(bw), int(bh)] != [doc_w, doc_h],
        })

    report["layers"] = per_layer
    report["trimming"] = {
        "n_trimmed": sum(1 for x in per_layer if x["trimmed"]),
        "note": "裁剪层（trimmed）是 Photoshop/psd-pipeline 的正常产物，"
                "Cubism 按 bbox 放置，不影响导入。",
    }

    check("无空层", not empty_layers,
          "空层=%s" % (empty_layers if empty_layers else "无"))
    check("图层数据尺寸与 bbox 一致", not size_mismatch,
          "不一致=%s" % (size_mismatch if size_mismatch else "无"),
          hint="不一致说明 PSD 图层数据损坏。")
    check("图层 bbox 落在画布内", not bbox_out_of_canvas,
          "越界=%s" % (bbox_out_of_canvas if bbox_out_of_canvas else "无"),
          hint="bbox 越界会导致该部件错位。")

    # ---------- 4. 文档级透明底 ----------
    comp = psd.numpy()
    if comp.shape[-1] == 4:
        corner = comp[0, 0, 3]
        visible = float((comp[..., 3] > 0.003921).sum())
        total = comp.shape[0] * comp.shape[1]
        report["document_alpha"] = {
            "corner_alpha": float(corner),
            "visible_px": int(visible),
            "visible_pct": round(visible / total * 100, 2),
        }
        check("文档为真透明底（角落 alpha=0）", float(corner) == 0.0,
              "corner_alpha=%.4f" % float(corner),
              hint="若角落不透明，说明透明底丢失（第 4 通道被当作额外通道）。")
        check("可见像素占比非零", visible > 0,
              "visible=%d (%.2f%%)" % (int(visible), visible / total * 100))
    else:
        check("文档含 alpha 通道", False,
              "composite 通道数=%d" % comp.shape[-1])

    # ---------- 5. 顺序校验 ----------
    if order_path and os.path.exists(order_path):
        with io.open(order_path, encoding="utf-8") as f:
            declared = [ln.strip() for ln in f if ln.strip()]
        report["declared_order"] = declared

        # PSD 内实际顺序（自顶向下 = 绘制顺序）
        actual = top_down
        check("实际顺序 == 声明顺序", actual == declared,
              "首个不一致位置=%s" % next(
                  (i for i, (a, b) in enumerate(zip(actual, declared)) if a != b),
                  "无" if actual == declared else "长度不同 (%d vs %d)" % (len(actual), len(declared))),
              hint="不一致说明 PSD 生成时的层序与清单不符。")
        check("顺序 == 期望人形遮挡关系", actual == EXPECTED_ORDER,
              "首个不一致位置=%s" % next(
                  (i for i, (a, b) in enumerate(zip(actual, EXPECTED_ORDER)) if a != b),
                  "无" if actual == EXPECTED_ORDER else "长度不同 (%d vs %d)" % (len(actual), len(EXPECTED_ORDER))))

    # ---------- 6. ArtMesh 预算 ----------
    n = len(leaves)
    report["artmesh"] = {
        "layer_count": n,
        "free_limit": ARTMESH_LIMIT_FREE,
        "headroom": ARTMESH_LIMIT_FREE - n,
    }
    check("FREE 版 ArtMesh 预算", n <= ARTMESH_LIMIT_FREE,
          "%d 层 / %d 上限（余量 %d）" % (n, ARTMESH_LIMIT_FREE,
                                          ARTMESH_LIMIT_FREE - n),
          blocking=False,
          hint="可用 1 层对应 1 个 ArtMesh 的保守估算；实际一个部件可拆多 ArtMesh。")

    # ---------- 7. 分组完整性 ----------
    grouped = [p for parts in PART_GROUP.values() for p in parts]
    missing_in_psd = [p for p in grouped if p not in names]
    ungrouped = [n for n in names if n not in grouped]
    report["groups"] = {k: v for k, v in PART_GROUP.items()}
    check("所有部件已归入解剖分组", not ungrouped,
          "未分组=%s" % (ungrouped if ungrouped else "无"),
          blocking=False,
          hint="未分组不影响导入，但绑定计划需要覆盖全部部件。")

    # 串层提示：一个部件若出现在多个分组，说明分组表有误
    from collections import Counter
    cnt = Counter(grouped)
    multi = [k for k, v in cnt.items() if v > 1]
    check("分组表无重复归属", not multi,
          "重复=%s" % (multi if multi else "无"), blocking=False)

    # ---------- 8. 分区完整性校验（无损性实证）----------
    # 方法说明：本 PSD 的 53 层应当是对整人的「无重叠、无遗漏」分区。
    # 检验分两步，避免浮点 source-over 取整带来的假差异：
    #   (a) alpha 掩码并集 + 重叠计数 —— 这是判定「分区完整性」的正确方法，
    #       不受 source-over 浮点误差影响。
    #   (b) 不透明区 RGB 逐点比较 —— 判定「分色无损」。
    mask = np.zeros((doc_h, doc_w), dtype=bool)
    overlap_px = 0
    sum_per_layer_px = 0
    placed = 0
    canvas_rgb = None
    for layer, _ in leaves:
        l, t, r, b = layer.bbox
        img = layer.numpy().astype(np.float32)
        if img.shape[0] != (b - t) or img.shape[1] != (r - l):
            continue
        placed += 1
        a = img[..., 3] > 0.003921
        sum_per_layer_px += int(a.sum())
        sub = mask[t:b, l:r]
        overlap_px += int((sub & a).sum())
        sub |= a
        # 用位运算合成（每像素保留 alpha 最大的层的 RGB），避免浮点累积
        if canvas_rgb is None:
            canvas_rgb = np.zeros((doc_h, doc_w, 3), dtype=np.uint8)
            canvas_a = np.zeros((doc_h, doc_w), dtype=np.uint8)
        dst_a = canvas_a[t:b, l:r]
        take = img[..., 3] * 255.0 >= dst_a.astype(np.float32)
        rgb8 = np.clip(img[..., :3] * 255.0, 0, 255).round().astype(np.uint8)
        dst_rgb = canvas_rgb[t:b, l:r]
        dst_rgb[take] = rgb8[take]
        dst_a[take] = np.clip(img[..., 3][take] * 255.0, 0, 255).round().astype(np.uint8)

    comp = psd.numpy().astype(np.float32)
    if comp.shape[-1] >= 4:
        comp_mask = comp[..., 3] > 0.003921
        comp_u8 = np.clip(comp[..., :3] * 255.0, 0, 255).round().astype(np.uint8)
        opaque = comp[..., 3] >= 0.996078  # alpha==255

        only_doc = int((comp_mask & ~mask).sum())
        only_layers = int((mask & ~comp_mask).sum())
        d_rgb = np.abs(canvas_rgb.astype(np.int16) - comp_u8.astype(np.int16))

        report["partition"] = {
            "layers_placed": placed,
            "sum_per_layer_visible_px": sum_per_layer_px,
            "union_visible_px": int(mask.sum()),
            "composite_visible_px": int(comp_mask.sum()),
            "overlap_px": overlap_px,
            "only_in_composite_px": only_doc,
            "only_in_layers_px": only_layers,
            "rgb_diff_max_at_opaque": int(d_rgb[opaque].max()) if opaque.any() else 0,
            "rgb_diff_n_at_opaque": int((d_rgb[opaque] > 0).sum()) if opaque.any() else 0,
        }

        check("回贴层数 == 图层数", placed == len(leaves),
              "placed=%d / layers=%d" % (placed, len(leaves)))
        check("层间无重叠（overlap=0）", overlap_px == 0,
              "overlap=%d px" % overlap_px,
              hint="重叠说明两个部件抢同一像素，Cubism 里会出现双重描边。")
        check("层并集 == 文档 composite（无遗漏）",
              only_doc == 0 and only_layers == 0,
              "仅文档有=%d px，仅图层有=%d px" % (only_doc, only_layers),
              hint="「仅文档有」说明有像素没被任何部件覆盖；"
                   "「仅图层有」说明图层有 composite 没有的内容。")
        check("可见像素数一致",
              int(mask.sum()) == int(comp_mask.sum()),
              "union=%d composite=%d" % (int(mask.sum()), int(comp_mask.sum())))
        # RGB 容差：允许 ±1 的 8bit 取整差（unpremultiply 往返 / 浮点 round 的必然产物）。
        # 1/255 不可见，且 Cubism 网格化后本就重采样，但必须在报告里量化而非隐去。
        n_over1 = int((d_rgb[opaque] > RGB_OPAQUE_TOL).sum())
        n_eq1 = int((d_rgb[opaque] == 1).sum())
        check("不透明区 RGB 无损（容差 ±1/255）", n_over1 == 0,
              "max=%d；超出容差=%d px；等于 ±1=%d px（占不透明区 %.6f%%）"
              % (int(d_rgb[opaque].max()) if opaque.any() else 0,
                 n_over1, n_eq1,
                 n_eq1 / max(int(opaque.sum()), 1) * 100),
              hint="±1 是 8bit 取整差，视觉与运行均无影响。")

    report["summary"] = {
        "layers": n,
        "blocking": len(report["blocking"]),
        "warnings": len(report["warnings"]),
        "verdict": "PASS" if not report["blocking"] else "FAIL",
    }
    return report


# --------------------------------------------------------------------------
# Markdown 渲染
# --------------------------------------------------------------------------
def render_md(rep: dict) -> str:
    L = []
    A = L.append
    A("# Cubism PSD 导入前校验报告")
    A("")
    A("文件：`%s`" % rep["psd"])
    A("")
    s = rep["summary"]
    A("**结论：%s**  ——  阻断项 %d，警告 %d，图层 %d"
      % (s["verdict"], s["blocking"], s["warnings"], s["layers"]))
    A("")

    hdr = rep["header"]
    A("## 1. 文档规格")
    A("")
    A("| 项 | 值 |")
    A("| --- | --- |")
    A("| 签名 | `%s` |" % hdr["signature"])
    A("| 版本 | %d |" % hdr["version"])
    A("| 尺寸 | %d × %d |" % (hdr["width"], hdr["height"]))
    A("| 通道数 | %d |" % hdr["channels"])
    A("| 位深 | %d bit |" % hdr["depth"])
    A("| 色彩模式 | %s |" % hdr["color_mode_name"])
    A("")

    if "document_alpha" in rep:
        da = rep["document_alpha"]
        A("## 2. 透明底")
        A("")
        A("| 项 | 值 |")
        A("| --- | --- |")
        A("| 角落 alpha | %.4f |" % da["corner_alpha"])
        A("| 可见像素 | %d (%.2f%%) |" % (da["visible_px"], da["visible_pct"]))
        A("")

    A("## 3. 逐项检查")
    A("")
    A("| 通过 | 检查项 | 实测 |")
    A("| :---: | --- | --- |")
    for c in rep["checks"]:
        A("| %s | %s | %s |" % ("✅" if c["ok"] else "❌", c["check"], c["detail"]))
    A("")

    if rep["blocking"]:
        A("## 4. 阻断项（必须修复后才能正常导入）")
        A("")
        for b in rep["blocking"]:
            A("- **%s**：%s" % (b["check"], b["detail"]))
            if b.get("hint"):
                A("  - 处置：%s" % b["hint"])
        A("")

    if rep["warnings"]:
        A("## 5. 警告（不阻断导入）")
        A("")
        for w in rep["warnings"]:
            A("- **%s**：%s" % (w["check"], w["detail"]))
            if w.get("hint"):
                A("  - 说明：%s" % w["hint"])
        A("")

    A("## 6. 图层清单（自顶向下 = 绘制顺序）")
    A("")
    A("| # | 图层名 | bbox (l,t,r,b) | 裁剪后尺寸 | 覆盖 px | 占比 %% | 半透明 px |")
    A("| ---: | --- | --- | --- | ---: | ---: | ---: |")
    for i, l in enumerate(rep["layers"], 1):
        A("| %d | `%s` | %s | %d×%d | %d | %.4f | %d |"
          % (i, l["name"], tuple(l["bbox"]), l["bbox_size"][0], l["bbox_size"][1],
             l["alpha_coverage_px"], l["alpha_coverage_pct"],
             l["semi_transparent_px"]))
    A("")
    if "trimming" in rep:
        A("> 裁剪层：%d / %d 层的画布被裁剪到内容 bbox（位置由 bbox 记录）。"
          % (rep["trimming"]["n_trimmed"], len(rep["layers"])))
        A("> %s" % rep["trimming"]["note"])
        A("")

    if "partition" in rep:
        rt = rep["partition"]
        A("## 7. 分区完整性校验（无损性实证）")
        A("")
        A("判定方法：53 层应当是对整人的**无重叠、无遗漏分区**。用 alpha 掩码并集 + "
          "重叠计数判定分区完整性（不受 source-over 浮点取整影响），"
          "再用不透明区 RGB 逐点比较判定分色无损。")
        A("")
        A("| 项 | 值 |")
        A("| --- | --- |")
        A("| 回贴层数 | %d |" % rt["layers_placed"])
        A("| 逐层可见像素之和 | %d |" % rt["sum_per_layer_visible_px"])
        A("| 层并集可见像素 | %d |" % rt["union_visible_px"])
        A("| 文档 composite 可见像素 | %d |" % rt["composite_visible_px"])
        A("| **层间重叠** | **%d px** |" % rt["overlap_px"])
        A("| 仅 composite 有（遗漏） | %d px |" % rt["only_in_composite_px"])
        A("| 仅图层有（多余） | %d px |" % rt["only_in_layers_px"])
        A("| 不透明区 RGB 最大差 | %d（差异像素 %d）|"
          % (rt["rgb_diff_max_at_opaque"], rt["rgb_diff_n_at_opaque"]))
        A("")

    A("## 8. 解剖分组（绑定计划输入）")
    A("")
    for g, parts in rep["groups"].items():
        A("- **%s**（%d）：%s" % (g, len(parts), "、".join("`%s`" % p for p in parts)))
    A("")

    A("## 9. ArtMesh 预算")
    A("")
    am = rep["artmesh"]
    A("- 图层数：%d" % am["layer_count"])
    A("- FREE 上限：%d" % am["free_limit"])
    A("- 余量：%d" % am["headroom"])
    A("")
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description="Cubism PSD 导入前校验（只读）")
    ap.add_argument("--psd", required=True)
    ap.add_argument("--order", default=None, help="图层顺序清单 txt")
    ap.add_argument("--out-json", default=None)
    ap.add_argument("--out-md", default=None)
    args = ap.parse_args()

    rep = validate(args.psd, args.order)

    if args.out_json:
        os.makedirs(os.path.dirname(args.out_json), exist_ok=True)
        with io.open(args.out_json, "w", encoding="utf-8") as f:
            json.dump(rep, f, ensure_ascii=False, indent=2)
        print("wrote %s" % args.out_json)
    if args.out_md:
        os.makedirs(os.path.dirname(args.out_md), exist_ok=True)
        with io.open(args.out_md, "w", encoding="utf-8") as f:
            f.write(render_md(rep))
        print("wrote %s" % args.out_md)

    s = rep["summary"]
    print("verdict=%s blocking=%d warnings=%d layers=%d"
          % (s["verdict"], s["blocking"], s["warnings"], s["layers"]))
    if rep["blocking"]:
        for b in rep["blocking"]:
            print("  BLOCK: %s -> %s" % (b["check"], b["detail"]))
    if rep["warnings"]:
        for w in rep["warnings"]:
            print("  WARN : %s -> %s" % (w["check"], w["detail"]))
    return 0 if not rep["blocking"] else 1


if __name__ == "__main__":
    sys.exit(main())
