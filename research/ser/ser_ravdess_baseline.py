# -*- coding: utf-8 -*-
"""
实验 2：RAVDESS 英文 baseline 验证（见 docs/ser/SPEC_SER-02.md 第 3 节）

目的：用公开英文数据验证 emotion2vec+ 的 baseline 能力，
     排除「模型本身有问题」的干扰解释，给 base-vs-large 偏置结论上双保险。

数据来源：本地 E 盘（由 ser_download_ravdess.py 用 requests 直连下载，
     绕开 hf_hub 的 hf_xet 0 字节 bug）。文件名保留 7-part 命名，靠文件名解析情绪。

流程：读本地 1440 段 wav → 48k→16k 重采样 → emotion2vec+ large 分类
      → 8 类映射到 9 类(calm→other 剔除) → UAR / 准确率 / 混淆矩阵。

用法：
    python ser_ravdess_baseline.py                 # 全量
    python ser_ravdess_baseline.py --max 10        # 前 10 段(探针/调试)

产物（SER-03 R2）：每次运行写独立目录
    output/baseline_ravdess/runs/<时间戳>_<模型名>[_maxN]/
    ├─ metrics.json / confusion.json / samples.jsonl
    └─ provenance.json（模型、参数、规则版本、日志路径、产物清单）
目录已存在则拒绝运行（历史证据不可变，不静默覆盖）。
"""
import json, os, sys, time, argparse, glob
from collections import Counter
from datetime import datetime
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ser_common import (RAVDESS_DATA_DIR, SER_ROOT, parse_emotion2vec_result,
                        setup_environment)
from ser_log import setup_logger
from ser_metrics import RULE_VERSION, score_run  # SER-03：计分唯一入口（漏计修复见 docs/ser/specs/SER-03.md）

# 缓存重定向 + DLL 修复（显式环境变量优先，否则落 research/ser/.cache）
setup_environment()

OUT_DIR = os.path.join(SER_ROOT, "output", "baseline_ravdess")
RUNS_DIR = os.path.join(OUT_DIR, "runs")   # SER-03 R2：生产产物一律落独立 run 目录
DATA_DIR = RAVDESS_DATA_DIR

# RAVDESS 8 类 → emotion2vec+ 9 类标签（tokens.txt 实测）
RAV_TO_E2V = {
    "neutral": "neutral",
    "calm": "other",        # 无对应 → other，计分时剔除
    "happy": "happy",
    "sad": "sad",
    "angry": "angry",
    "fearful": "fearful",
    "disgust": "disgusted",  # RAVDESS 拼 "disgust"，emotion2vec 拼 "disgusted"
    "surprised": "surprised",
}
EXCLUDED_RAV = {"calm"}          # 计分时剔除（映射到 other，无真实监督）
SCORE_CLASSES = ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"]

# RAVDESS 文件名第 3 段 → 情绪字符串
EMOTION_CODE = {
    "01": "neutral", "02": "calm", "03": "happy", "04": "sad",
    "05": "angry", "06": "fearful", "07": "disgust", "08": "surprised",
}


def parse_ravdess(fname):
    """03-01-05-01-01-01-01.wav -> (emotion_str, channel)。channel 01=speech。"""
    parts = os.path.basename(fname).replace(".wav", "").split("-")
    return EMOTION_CODE.get(parts[2], "other"), parts[1]


def parse_pred(res):
    """从 model.generate 返回里取 {归一化label: score}。

    SER-04：标签规则统一走 ser_common.parse_emotion2vec_result
    （「中文/英文」复合标签归一化、<unk>→unknown；数量不符/非数值分数显式报错），
    与探针、服务输出同一规则。
    """
    return parse_emotion2vec_result(res)


def load_16k(wav_path):
    """读 48k wav，重采样到 16kHz。"""
    import soundfile as sf
    import librosa
    y, sr = sf.read(wav_path, dtype="float32")
    if sr != 16000:
        y = librosa.resample(y, orig_sr=sr, target_sr=16000).astype(np.float32)
    return y


def make_run_dir(runs_root, run_id):
    """SER-03 R2：生产落盘目录 <runs_root>/<run_id>。

    已存在则明确拒绝（历史证据不可变，不静默覆盖；需要新目录请换 run_id）。
    """
    d = os.path.join(runs_root, run_id)
    if os.path.exists(d):
        raise FileExistsError(
            f"运行目录已存在，拒绝覆盖: {d}（历史证据不可变；"
            f"如确为新一轮运行请用新的 run_id）")
    os.makedirs(d)
    return d


def format_metric(v):
    """SER-03 R4：None（不可计算）与 0 分区分呈现；JSON 侧保留 null 不经此函数。"""
    return "N/A（不可计算）" if v is None else f"{v:.4f}"


def missing_reason(metrics):
    """UAR/accuracy 不可计算时给出人类可读原因。"""
    if metrics["n_scored"] == 0:
        return "无计分样本（全部失败或全部剔除）"
    missing = metrics.get("missing_classes") or []
    if missing:
        return f"计分类别缺失: {', '.join(missing)}"
    return "未知原因"


def main(argv=None, model=None, data_dir=None, out_root=None, run_id=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="iic/emotion2vec_plus_large")
    ap.add_argument("--max", type=int, default=0, help="限制段数(调试用，0=全量)")
    args = ap.parse_args(argv)

    data_dir = DATA_DIR if data_dir is None else data_dir
    out_root = RUNS_DIR if out_root is None else out_root
    log, logpath = setup_logger("ravdess_baseline", "baseline_ravdess")
    log.info("实验 2 启动：RAVDESS 英文 baseline", extra={
        "model": args.model, "params": {"max": args.max}})

    # ---- 读本地 wav ----
    wavs = sorted(glob.glob(os.path.join(data_dir, "03-01-*.wav")))
    n = len(wavs)
    log.info(f"本地 speech wav 数 {n}", extra={"params": {"n": n, "dir": data_dir}})
    if n == 0:
        log.error("本地无数据，请先跑 ser_download_ravdess.py")
        sys.exit(3)

    # ---- 加载模型 ----
    log.info("加载 emotion2vec+ 模型", extra={"model": args.model})
    if model is None:
        from funasr import AutoModel
        model = AutoModel(model=args.model)
    log.info("模型加载完成", extra={"model": args.model})

    emot_counter = Counter(parse_ravdess(w)[0] for w in wavs)
    log.info("情绪分布(应 8 类齐全)", extra={"params": dict(emot_counter)})

    # ---- SER-03 R2：独立 run 目录（推理前先建，同名冲突立刻拒绝，不静默覆盖）----
    mname = args.model.split("/")[-1]
    if run_id is None:
        run_id = f"{datetime.now():%Y%m%d_%H%M%S}_{mname}"
        if args.max:
            run_id += f"_max{args.max}"      # --max 调试产物与全量批次天然分离
    try:
        run_dir = make_run_dir(out_root, run_id)
    except FileExistsError as e:
        log.error(f"运行目录冲突：{e}")
        print(f"[baseline] {e}", file=sys.stderr)
        sys.exit(4)
    log.info("产物目录", extra={"params": {"run_id": run_id, "run_dir": run_dir}})

    # ---- 探针：先跑 1 段确认 numpy 输入返回结构正常 ----
    log.info("探针：验证 numpy 输入返回结构")
    _w = wavs[0]
    try:
        _y = load_16k(_w)
        _res = model.generate(input=_y, granularity="utterance", extract_embedding=False)
        _pm = parse_pred(_res)
        log.info("探针返回结构", extra={
            "params": {"n_labels": len(_pm) if _pm else None,
                       "labels_sample": list(_pm.keys()) if _pm else None,
                       "n_samples": int(len(_y))}})
        if _pm is None:
            raise RuntimeError("探针解析失败，返回结构异常: %r" % (_res,))
    except Exception:
        log.exception("探针失败，返回结构异常")
        sys.exit(2)

    # ---- 全量循环 ----
    records = []
    t_all = time.time()
    targets = wavs[:args.max] if args.max else wavs
    for i, wav in enumerate(targets):
        fname = os.path.basename(wav)
        rav, channel = parse_ravdess(fname)
        t0 = time.time()
        try:
            y16 = load_16k(wav)
            res = model.generate(input=y16, granularity="utterance", extract_embedding=False)
            pred_map = parse_pred(res)
            dt = time.time() - t0
            if pred_map is None:
                raise RuntimeError("返回结构解析失败: %r" % (res,))
            pred = max(pred_map, key=pred_map.get)  # argmax
            target = RAV_TO_E2V.get(rav, "other")
            records.append({"file": fname, "target_raw": target, "pred_raw": pred,
                            "excluded": rav in EXCLUDED_RAV, "status": "success",
                            "scores": pred_map})
            log.info(f"处理完成 {rav:>9} -> {pred:>9}", extra={
                "audio": fname, "slug": rav, "kind": "ravdess",
                "elapsed_s": round(dt, 3), "model": args.model})
        except Exception:
            records.append({
                "file": fname, "target_raw": RAV_TO_E2V.get(rav, "other"),
                "pred_raw": None, "excluded": rav in EXCLUDED_RAV,
                "status": "failed", "scores": None,
            })
            log.exception(f"处理失败 {rav} {fname}", extra={
                "audio": fname, "slug": rav, "kind": "ravdess",
                "model": args.model})
        if (i + 1) % 200 == 0:
            log.info(f"进度 {i+1}/{len(targets)}", extra={
                "params": {"done": i + 1, "total": len(targets)}})

    t_total = time.time() - t_all

    # ---- 统计（SER-03 计分：other/unknown 预测进分母记错，不再漏计）----
    metrics = score_run(records)
    acc, uar = metrics["accuracy"], metrics["uar"]   # SER-03 R4：None=不可计算，JSON 保留 null

    metrics.update({
        "model": args.model,
        "n_total": metrics["n_success"],  # 兼容旧字段：语义=成功推理数
        "elapsed_total_s": round(t_total, 1),
        "run_id": run_id,
    })

    # ---- 落盘（SER-03 R2：只写本 run 目录，历史证据不可变）----
    body = {k: v for k, v in metrics.items() if k != "records"}
    artifact_names = ["metrics.json", "confusion.json", "samples.jsonl"]
    with open(os.path.join(run_dir, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    with open(os.path.join(run_dir, "confusion.json"), "w", encoding="utf-8") as f:
        json.dump(metrics["confusion"], f, ensure_ascii=False, indent=2)
    with open(os.path.join(run_dir, "samples.jsonl"), "w", encoding="utf-8") as f:
        for r in records:  # 输入格式（target_raw/pred_raw/status），可被 score_run 离线复算
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    provenance = {
        "run_id": run_id,
        "model": args.model,
        "params": {"max": args.max, "n_input": len(wavs), "data_dir": data_dir},
        "rule_version": RULE_VERSION,
        "log": logpath,
        "created": datetime.now().isoformat(timespec="seconds"),
        "outputs": artifact_names,
    }
    with open(os.path.join(run_dir, "provenance.json"), "w", encoding="utf-8") as f:
        json.dump(provenance, f, ensure_ascii=False, indent=2)

    log.info("实验 2 完成", extra={
        "params": {"n_total": metrics["n_total"], "n_failed": metrics["n_failed"],
                   "accuracy": acc, "uar": uar, "run_dir": run_dir}})
    print(f"\n===== 结果 =====\n尝试 {metrics['n_attempted']} 段 | 失败 {metrics['n_failed']} | "
          f"计分 {metrics['n_scored']} | 准确率 {format_metric(acc)} | "
          f"UAR(7类) {format_metric(uar)} | 耗时 {t_total:.0f}s")
    if acc is None or uar is None:  # SER-03 R4：不可计算给原因，不冒充 0 分
        print(f"[baseline] 指标不可计算：{missing_reason(metrics)}", file=sys.stderr)
    print(f"metrics/confusion/samples/provenance 已存 {run_dir}\n")
    sys.exit(1 if metrics["n_failed"] else 0)


if __name__ == "__main__":
    main()
