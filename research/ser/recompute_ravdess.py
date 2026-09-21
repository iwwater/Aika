# -*- coding: utf-8 -*-
"""SER-03 离线证据重算：从单次历史运行的 JSONL 日志重建 RAVDESS baseline 指标。

规格：docs/ser/specs/SER-03.md「证据与兼容」。
- 只用单次完整运行日志，不混合多次运行；不用最终矩阵倒造预测。
- 历史日志无 scores 字段 → 逐样本 scores 留空（None）并在产物中说明，禁止补造。
- 原始产物（metrics/confusion/log）原样保留，不覆写；重算产物写 recomputed_<run-id>/。

用法：
    python recompute_ravdess.py \
        --log output/logs/baseline_ravdess_20260920_212308.jsonl
退出码：0=重建成功；2=日志不满足完整重建条件（AC-C 走 BLOCKED）。
"""
import argparse
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ser_metrics import RULE_VERSION, score_run  # noqa: E402

# 与生产脚本 ser_ravdess_baseline.py 保持一致的映射/剔除约定
RAV_TO_E2V = {
    "neutral": "neutral", "calm": "other", "happy": "happy", "sad": "sad",
    "angry": "angry", "fearful": "fearful", "disgust": "disgusted",
    "surprised": "surprised",
}
EXCLUDED_RAV = {"calm"}
EMOTION_CODE = {
    "01": "neutral", "02": "calm", "03": "happy", "04": "sad",
    "05": "angry", "06": "fearful", "07": "disgust", "08": "surprised",
}
DONE_PAT = re.compile(r"^处理完成\s+(\S+)\s+->\s+(\S+)$")
FAIL_PAT = re.compile(r"^处理失败\s+(\S+)\s+(\S+)")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_log(log_path):
    """解析单次运行日志 → (records, meta)。不满足完整重建时 raise RuntimeError。"""
    events, models, runs = 0, set(), 0
    done, failed_files, errors = [], [], []
    for ln, line in enumerate(open(log_path, encoding="utf-8"), 1):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            errors.append(f"第 {ln} 行不是合法 JSON")
            continue
        events += 1
        if r.get("event", "").startswith("实验 2 启动"):
            runs += 1
            if r.get("model"):
                models.add(r["model"])
        m = DONE_PAT.match(r.get("event", ""))
        if m and r.get("audio"):
            done.append({"file": r["audio"], "rav": m.group(1),
                         "pred_raw": m.group(2), "line": ln})
        m = FAIL_PAT.match(r.get("event", ""))
        if m and r.get("audio"):
            failed_files.append({"file": r["audio"], "rav": m.group(1), "line": ln})
        if r.get("level") == "ERROR" and not (m and r.get("audio")):
            errors.append(f"第 {ln} 行 ERROR: {r.get('event', '')[:120]}")

    if runs != 1:
        raise RuntimeError(f"日志含 {runs} 次运行启动事件（要求恰好 1 次，不可混合多次运行）")
    if len(models) != 1:
        raise RuntimeError(f"模型标识不唯一: {models!r}")
    uniq = {d["file"] for d in done} | {f["file"] for f in failed_files}
    dup = [d for d in done if [x["file"] for x in done].count(d["file"]) > 1]
    if dup:
        raise RuntimeError(f"同一文件多条完成记录（不可静默计分）: {dup[:3]}")

    # target 从文件名独立解析（RAVDESS 7-part 第 3 段），与日志里 slug 双重核对
    records = []
    for d in done:
        parts = d["file"].replace(".wav", "").split("-")
        rav_from_name = EMOTION_CODE.get(parts[2], "other")
        if rav_from_name != d["rav"]:
            raise RuntimeError(
                f"{d['file']}: 文件名解析情绪 {rav_from_name} 与日志 slug {d['rav']} 不一致")
        records.append({
            "file": d["file"], "target_raw": RAV_TO_E2V[rav_from_name],
            "pred_raw": d["pred_raw"], "excluded": rav_from_name in EXCLUDED_RAV,
            "status": "success", "scores": None,
        })
    for f in failed_files:
        records.append({
            "file": f["file"], "target_raw": RAV_TO_E2V[f["rav"]],
            "pred_raw": None, "excluded": f["rav"] in EXCLUDED_RAV,
            "status": "failed", "scores": None,
        })

    meta = {
        "model": models.pop(),
        "n_log_events": events,
        "n_attempted_in_log": len(records),
        "n_unique_files": len(uniq),
        "n_failed_in_log": len(failed_files),
        "errors": errors,
    }
    return records, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True, help="baseline_ravdess 的 JSONL 日志路径")
    ap.add_argument("--out-root", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "output", "baseline_ravdess"))
    ap.add_argument("--old-metrics", default="metrics_emotion2vec_plus_large.json")
    args = ap.parse_args()

    log_path = os.path.abspath(args.log)
    run_id = re.search(r"(\d{8}_\d{6})", os.path.basename(log_path))
    if not run_id:
        print("FATAL: 无法从日志文件名提取 run-id（应为 <exp>_YYYYMMDD_HHMMSS.jsonl）")
        sys.exit(2)
    run_id = run_id.group(1)
    out_dir = os.path.join(args.out_root, f"recomputed_{run_id}")

    records, meta = parse_log(log_path)
    print(f"日志解析: {meta['n_attempted_in_log']} attempted / "
          f"{meta['n_unique_files']} 唯一 / {meta['n_failed_in_log']} 失败 / "
          f"模型 {meta['model']}")
    if meta["errors"]:
        print(f"日志内异常行 {len(meta['errors'])} 条（详见 provenance）")

    metrics = score_run(records)
    print(f"v2 计分: attempted={metrics['n_attempted']} success={metrics['n_success']} "
          f"failed={metrics['n_failed']} excluded={metrics['n_excluded']} "
          f"scored={metrics['n_scored']} matrix_total={metrics['n_matrix_total']}")
    print(f"accuracy={metrics['accuracy']} uar={metrics['uar']} "
          f"missing={metrics['missing_classes']}")

    # ---- 旧指标对照（只读，不覆写）----
    old_path = os.path.join(args.out_root, args.old_metrics)
    old = json.load(open(old_path, encoding="utf-8")) if os.path.exists(old_path) else None
    diff = {"old_metrics_file": args.old_metrics, "fields": {}}
    if old:
        for k in ("accuracy", "uar"):
            diff["fields"][k] = {"old": old.get(k), "new": metrics[k]}
        old_total = old.get("n_scored")
        diff["fields"]["n_scored"] = {
            "old": old_total, "new": metrics["n_scored"],
            "note": "旧 n_scored=计分样本数；旧混淆矩阵总数=1247（漏 1 条 <unk>）"}
        # 漏计清单：v2 scored 中 pred 不在 7 计分类的样本（旧计分把它们从矩阵丢弃）
        leaked = [r for r in metrics["records"]
                  if not r["excluded"] and r["pred"] not in metrics["score_classes"]]
        diff["leaked_samples"] = leaked
    print("新旧对照:", json.dumps(diff["fields"], ensure_ascii=False))
    if diff.get("leaked_samples"):
        print("旧计分漏计样本:")
        for r in diff["leaked_samples"]:
            print(f"  {r['file']}  target={r['target']} pred={r['pred']}")

    # ---- 落盘（recomputed_<run-id>/，原始产物不动）----
    # samples.jsonl 落「输入格式」（target_raw/pred_raw/status），保证可离线再次 score_run
    os.makedirs(out_dir, exist_ok=True)
    mname = meta["model"].split("/")[-1]
    body = {k: v for k, v in metrics.items() if k != "records"}
    with open(os.path.join(out_dir, f"metrics_{mname}_v2.json"), "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_dir, f"confusion_{mname}_v2.json"), "w", encoding="utf-8") as f:
        json.dump(metrics["confusion"], f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_dir, "samples.jsonl"), "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    prov = {
        "ruleVersion": RULE_VERSION,
        "schemaVersion": 2,
        "run_id": run_id,
        "source_log": {"path": os.path.relpath(log_path, os.path.dirname(args.out_root)),
                       "sha256": sha256(log_path)},
        "old_metrics": {"path": args.old_metrics,
                        "sha256": sha256(old_path) if old else None},
        "model": meta["model"],
        "n_log_events": meta["n_log_events"],
        "log_errors": meta["errors"],
        "scores_note": "历史日志无逐样本 scores 字段，重建记录 scores 全为 null（禁止补造）",
        "command": "python recompute_ravdess.py --log " + os.path.relpath(log_path),
        "diff_old_new": diff,
    }
    with open(os.path.join(out_dir, "provenance.json"), "w", encoding="utf-8") as f:
        json.dump(prov, f, ensure_ascii=False, indent=2)
    print(f"产物已写 {out_dir}")
    sys.exit(0)


if __name__ == "__main__":
    main()
