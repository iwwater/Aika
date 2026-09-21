# -*- coding: utf-8 -*-
"""
base vs large 对比：读两个模型的评测 JSON，输出逐段对比表 + 偏置变化汇总。

用法：
    python ser_compare_base_large.py
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ser_common import OUTPUT_DIR, parse_emotion2vec_result

OUT = OUTPUT_DIR
BASE = os.path.join(OUT, "emotion2vec_probe_emotion2vec_plus_base.json")
LARGE = os.path.join(OUT, "emotion2vec_probe_emotion2vec_plus_large.json")

# 6 mood -> 两类（研究假设：柔软/示弱类 vs 攻击/尖锐类）
SOFT = {"yasashii": "温柔", "anshin": "安心", "shinmitsu": "亲密", "kongan": "恳求"}
HARD = {"hiniku": "嘲讽", "dokuzetsu": "毒舌"}

def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def top_pred(row, k=3):
    """返回 [(英文标签, 分数), ...] 按分数降序。

    SER-04：标签规则统一走 ser_common.parse_emotion2vec_result
    （兼容历史 JSON 里 pred_labels/pred_scores 的原始复合/`<unk>` 格式）。
    """
    labels = row.get("pred_labels") or []
    scores = row.get("pred_scores") or []
    try:
        pred_map = parse_emotion2vec_result({"labels": list(labels), "scores": list(scores)})
    except (ValueError, TypeError):
        return []
    ranked = sorted(pred_map.items(), key=lambda x: -x[1])
    return ranked[:k]

def main():
    base = load(BASE)
    large = load(LARGE)

    # 按 (kind, slug) 建索引
    def idx(data):
        d = {}
        for r in data:
            d[(r["kind"], r["slug"])] = r
        return d

    ib, il = idx(base), idx(large)

    print("=" * 100)
    print("逐段对比：真实情绪 -> base 预测 vs large 预测")
    print("=" * 100)

    # 用 ref 真人段的真实情绪代表该 mood 的情绪标签
    rows = []
    for slug in list(SOFT) + list(HARD):
        zh = SOFT.get(slug) or HARD.get(slug)
        cls = "柔软/示弱" if slug in SOFT else "攻击/尖锐"
        for kind in ["ref(真人)", "合成A", "合成C"]:
            rb, rl = ib.get((kind, slug)), il.get((kind, slug))
            if not rb or not rl:
                continue
            tb = top_pred(rb); tl = top_pred(rl)
            rows.append((kind, slug, zh, cls, tb, tl))

    for kind, slug, zh, cls, tb, tl in rows:
        b_str = " / ".join(f"{en}:{sc:.2f}" for en, sc in tb)
        l_str = " / ".join(f"{en}:{sc:.2f}" for en, sc in tl)
        print(f"[{kind:>8}] {zh}({slug}) [{cls}]")
        print(f"    base : {b_str}")
        print(f"    large: {l_str}")

    # 汇总：偏置变化
    print("\n" + "=" * 100)
    print("偏置变化汇总（top1 情绪）")
    print("=" * 100)

    def top1_label(r):
        return top_pred(r, 1)[0][0]

    for cls, group in [("柔软/示弱类", SOFT), ("攻击/尖锐类", HARD)]:
        print(f"\n【{cls}】")
        for slug, zh in group.items():
            b_agg, l_agg = {}, {}
            for kind in ["ref(真人)", "合成A", "合成C"]:
                rb, rl = ib.get((kind, slug)), il.get((kind, slug))
                if rb:
                    b_agg[top1_label(rb)] = b_agg.get(top1_label(rb), 0) + 1
                if rl:
                    l_agg[top1_label(rl)] = l_agg.get(top1_label(rl), 0) + 1
            print(f"  {zh}({slug}): base->{dict(sorted(b_agg.items()))}  large->{dict(sorted(l_agg.items()))}")

    print("\n完成。")

if __name__ == "__main__":
    main()
