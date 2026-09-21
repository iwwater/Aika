# -*- coding: utf-8 -*-
"""
emotion2vec+ zero-shot 评测：对 demo 18 段（ref 真人 + A/C 合成，6 情绪）
直接跑预训练情绪识别，观察「语气 → 情绪」的可行性，以及用户的 6 mood
在标准 SER 情绪空间里的落点。

用法：
    python ser_emotion2vec_probe.py            # 默认 emotion2vec_plus_base
    python ser_emotion2vec_probe.py --model iic/emotion2vec_plus_large

失败语义（SER-04 R1，见 docs/ser/reports/OPTIMIZATION_REVIEW_20260921.md）：
- 逐样本隔离：缺文件、推理异常、解析异常统一记失败行（pred 字段全 None），
  绝不携带前一条样本的预测；
- 单样本失败不中断批次；有任何失败入口非零退出（exit 1）。
"""
import json, os, sys, time, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ser_common import (SER_ROOT, build_demo_samples, parse_emotion2vec_result,
                        run_batch, setup_environment)

# 缓存重定向 + DLL 修复（显式环境变量优先，否则落 research/ser/.cache）
setup_environment()

OUT_DIR = os.path.join(SER_ROOT, "output")


def _success_row(s, res, dt):
    """成功样本 → 输出行。所有预测变量都在本函数内局部求解，无跨样本残留。"""
    pred_map = parse_emotion2vec_result(res)  # 失败即抛，由 run_batch 记为失败
    ranked = sorted(pred_map.items(), key=lambda x: -x[1])
    top_label = ranked[0][0] if ranked else None
    top_score = ranked[0][1] if ranked else None
    top = " / ".join(f"{t}:{sc:.2f}" for t, sc in ranked[:3])
    r0 = res[0] if isinstance(res, list) else res
    row = {
        "kind": s["kind"], "slug": s["slug"], "ja": s["ja"], "zh": s["zh"],
        "path": s["path"], "elapsed_s": round(dt, 3),
        # 原始 labels/scores 保留（ser_compare_base_large.py 兼容）
        "pred_labels": r0.get("labels"), "pred_scores": r0.get("scores"),
        "pred_top": top_label, "pred_top_score": top_score,
        "status": "success",
    }
    print(f"[{s['kind']:>10}] 真={s['zh']:>3}({s['ja']}) -> {top}  ({dt:.2f}s)")
    return row


def _failed_row(s, err):
    """失败样本 → 输出行。pred 字段全 None，错误信息入 error 字段可追溯。"""
    return {
        "kind": s["kind"], "slug": s["slug"], "ja": s["ja"], "zh": s["zh"],
        "path": s["path"], "elapsed_s": None,
        "pred_labels": None, "pred_scores": None,
        "pred_top": None, "pred_top_score": None,
        "status": "failed", "error": err,
    }


def main(argv=None, samples=None, model=None, out_dir=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="iic/emotion2vec_plus_base")
    args = ap.parse_args(argv)

    if samples is None:
        samples = build_demo_samples()
    out_dir = OUT_DIR if out_dir is None else out_dir
    if model is None:
        from funasr import AutoModel
        model = AutoModel(model=args.model)

    print(f"待评测 {len(samples)} 段 | 模型 {args.model}")

    def predict_one(s):
        if not os.path.exists(s["path"]):
            raise FileNotFoundError(f"音频缺失: {s['path']}")
        t0 = time.time()
        res = model.generate(input=s["path"], granularity="utterance",
                             extract_embedding=False)
        dt = time.time() - t0
        return _success_row(s, res, dt)

    # 生产批处理入口（ser_common.run_batch）：单项失败写 stderr 并继续，
    # attempted = success + failed，失败明细含 traceback
    summary = run_batch(samples, predict_one,
                        describe=lambda s: f"{s['slug']}({s['kind']})")

    # 按样本原顺序合并成功/失败行：失败行插回原位，pred 字段全 None
    fail_by_index = {f["index"]: f for f in summary.failures}
    rows, si = [], 0
    for i, s in enumerate(samples):
        f = fail_by_index.get(i)
        if f is not None:
            rows.append(_failed_row(s, f["error"]))
        else:
            rows.append(summary.results[si][1])
            si += 1

    os.makedirs(out_dir, exist_ok=True)
    mname = args.model.split("/")[-1]  # emotion2vec_plus_base / _large
    out = os.path.join(out_dir, f"emotion2vec_probe_{mname}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)

    print(f"\n成功 {summary.success} / 失败 {summary.failed} / 共 {summary.attempted} 段")
    print(f"结果已存 {out}")
    if summary.failed:
        print(f"[probe] {summary.failed} 段失败（明细见 stderr 与输出 error 字段），退出码 1",
              file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
