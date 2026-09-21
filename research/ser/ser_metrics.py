# -*- coding: utf-8 -*-
"""
SER 纯计分模块（SER-03，规则版本 ser-metrics/2）。

规格：docs/ser/specs/SER-03.md「计分定义」。本模块是 SER 计分的唯一入口；
不依赖 numpy/funasr/torch，任何 Python 3.11 可跑，便于离线复核。

计分定义（与规格逐条对应）：
1. 计分真实标签固定 7 类；calm 等按约定剔除的样本由调用方以 excluded=True 标记，
   剔除依据是真实标签（不因预测内容剔除样本）。
2. recall(c) = (target=c 且 pred=c) / target=c 的全部成功推理样本数。
   预测为 other/unknown 仍进入该类分母，记为错误。
3. accuracy 分母 = 全部成功推理且未被剔除的样本（n_scored）。
   UAR = 七类 recall 的算术平均；任一应计分类没有样本时 UAR=None 并列出缺失类。
4. 标签归一化：「中文/英文」复合标签取英文；<unk> 与 unknown 统一为 unknown；
   已知 other 保留。非法标签显式报错（ValueError），不静默丢弃。
5. 混淆矩阵 = 7 个真实类 × 9 个预测类；矩阵总数必须等于 n_scored。
   计数守恒：n_attempted = n_success + n_failed；n_success = n_excluded + n_scored。

输出 schemaVersion=2：保留 accuracy/uar/per_class_recall 名称与旧 n_total（语义=成功数），
新增计数字段与逐样本 records。
"""
import json

RULE_VERSION = "ser-metrics/2"

# 7 个计分真实类（剔除 calm 后）
SCORE_CLASSES = ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"]
# 9 个预测类 = 7 计分类 + other + unknown
PRED_CLASSES = SCORE_CLASSES + ["other", "unknown"]

_VALID = set(PRED_CLASSES)


class ScoringError(ValueError):
    """非法标签或不合法记录。调用方不得捕获后继续计分。"""


def normalize_label(raw):
    """归一化一个情绪标签。

    - 「中文/英文」复合标签 → 英文段（emotion2vec+ large 的 tokens.txt 格式）
    - <unk> → unknown
    - 结果必须在 9 个已知预测类内，否则 raise ScoringError
    """
    if not isinstance(raw, str):
        raise ScoringError(f"标签必须是字符串，得到 {type(raw).__name__}: {raw!r}")
    s = raw.strip()
    if not s:
        raise ScoringError("标签为空字符串")
    if "/" in s:
        parts = [p.strip() for p in s.split("/")]
        if len(parts) != 2 or not all(parts):
            raise ScoringError(f"非法复合标签 {raw!r}（须为「中文/英文」两段非空格式）")
        s = parts[1]
    if s == "<unk>":
        s = "unknown"
    if s not in _VALID:
        raise ScoringError(f"非法标签 {raw!r}（归一化后 {s!r}，不在 9 个已知类内）")
    return s


def score_run(records):
    """对一次完整运行的逐样本记录计分。

    records: iterable of dict，字段：
      file        str  文件名（用于重复检测，覆盖全部 attempted 记录）
      target_raw  str  真实标签（可为复合格式；excluded 样本如 calm→other）
      pred_raw    str  模型原始预测标签（可为复合格式 / <unk>）
      excluded    bool True=按约定剔除（calm），不进计分但计入 n_success
      status      str  "success" 或 "failed"；failed 不计分
      scores      dict|None  可选；历史重建无 scores 时必须为 None

    返回 metrics dict（schemaVersion 2）。任何非法输入 raise ScoringError。
    """
    recs = [dict(r) for r in records]
    seen = set()
    n_failed = 0
    parsed = []  # (file, target, pred, excluded, scores) for success rows

    for r in recs:
        f = r.get("file")
        if not f or not isinstance(f, str):
            raise ScoringError(f"记录缺少 file 字段: {r!r}")
        if f in seen:
            raise ScoringError(f"重复记录: {f}（同一文件出现多次，禁止静默计分）")
        seen.add(f)

        status = r.get("status", "success")
        if status not in ("success", "failed"):
            raise ScoringError(f"{f}: 非法 status {status!r}")
        if status == "failed":
            n_failed += 1
            continue

        target = normalize_label(r.get("target_raw"))
        pred = normalize_label(r.get("pred_raw"))
        excluded = bool(r.get("excluded", False))
        scores = r.get("scores")
        if scores is not None and not isinstance(scores, dict):
            raise ScoringError(f"{f}: scores 必须是 dict 或 None")
        if excluded and target not in ("other",):
            # 当前唯一剔除约定是 calm→other；若未来扩充剔除类，先改规格再改这里
            raise ScoringError(f"{f}: excluded 样本的 target 应为 other，得到 {target!r}")
        if not excluded and target not in SCORE_CLASSES:
            raise ScoringError(
                f"{f}: 计分样本 target {target!r} 不在 7 个计分类内（剔除类必须标 excluded=True）")
        parsed.append({"file": f, "target": target, "pred": pred,
                       "excluded": excluded, "scores": scores})

    n_success = len(parsed)
    n_attempted = n_success + n_failed
    scored = [p for p in parsed if not p["excluded"]]
    n_excluded = n_success - len(scored)
    n_scored = len(scored)

    # 守恒（内部一致性，防御编程）
    assert n_attempted == n_success + n_failed
    assert n_success == n_excluded + n_scored

    # accuracy：分母 = 全部成功非剔除样本
    correct = sum(1 for p in scored if p["target"] == p["pred"])
    accuracy = (correct / n_scored) if n_scored else None

    # 混淆矩阵：7 真实 × 9 预测；全部 scored 样本都进矩阵
    confusion = {t: {p: 0 for p in PRED_CLASSES} for t in SCORE_CLASSES}
    for p in scored:
        confusion[p["target"]][p["pred"]] += 1
    n_matrix_total = sum(sum(row.values()) for row in confusion.values())
    assert n_matrix_total == n_scored, "矩阵总数必须等于 n_scored"

    # recall：分母 = target=c 的全部成功样本（pred=other/unknown 也进分母记错）
    per_class_recall, missing_classes = {}, []
    for c in SCORE_CLASSES:
        denom = sum(confusion[c].values())
        if denom == 0:
            per_class_recall[c] = None
            missing_classes.append(c)
        else:
            per_class_recall[c] = confusion[c][c] / denom

    if missing_classes:
        uar = None  # 不悄悄改成六类平均
    else:
        uar = sum(per_class_recall.values()) / len(SCORE_CLASSES)

    metrics = {
        "schemaVersion": 2,
        "ruleVersion": RULE_VERSION,
        "score_classes": list(SCORE_CLASSES),
        "pred_classes": list(PRED_CLASSES),
        "n_attempted": n_attempted,
        "n_success": n_success,
        "n_failed": n_failed,
        "n_excluded": n_excluded,
        "n_scored": n_scored,
        "n_matrix_total": n_matrix_total,
        "accuracy": round(accuracy, 6) if accuracy is not None else None,
        "uar": round(uar, 6) if uar is not None else None,
        "missing_classes": missing_classes,
        "per_class_recall": {k: round(v, 6) for k, v in per_class_recall.items()
                             if v is not None},
        "confusion": confusion,
        "records": parsed,
    }
    return metrics


def metrics_to_files_payload(metrics):
    """拆出落盘用的三个子集（不含逐样本，样本单独落 JSONL）。"""
    m = dict(metrics)
    records = m.pop("records", [])
    return m, records


def load_metrics_with_records(path):
    """从 v2 metrics JSON + samples JSONL 重新装配完整 metrics 并复算校验。

    用于 AC-D：离线再次计算出相同指标（证明指标可由逐样本证据独立复现）。
    """
    with open(path, encoding="utf-8") as f:
        m = json.load(f)
    samples_path = path.replace("metrics_", "samples_").replace(".json", ".jsonl")
    records = []
    with open(samples_path, encoding="utf-8") as f:
        for line in f:
            records.append(json.loads(line))
    rem = score_run(records)
    rem_records = rem.pop("records")
    return m, rem, rem_records
