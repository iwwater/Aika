# -*- coding: utf-8 -*-
"""SER-09 leakage-safe temperature scaling and uncertainty rejection."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy.optimize import minimize_scalar
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from ser_dataset import load_jsonl
from ser_evaluate import evaluate_prediction_rows
from ser_metrics import SCORE_CLASSES
from ser_splits import speaker_folds, validate_speaker_isolation
from ser_ssl_probe import choose_parameter, file_sha256, load_matrix

PIPELINE_VERSION = "ser-calibration/1"
THRESHOLDS = (0.0, 0.5, 0.6, 0.7, 0.8, 0.9)


def _model(c_value):
    return make_pipeline(StandardScaler(), LogisticRegression(
        C=c_value, class_weight="balanced", max_iter=5000, random_state=20260922))


def softmax(logits, temperature=1.0):
    scaled = np.asarray(logits, dtype=np.float64) / float(temperature)
    scaled -= scaled.max(axis=1, keepdims=True)
    exp = np.exp(scaled)
    probabilities = exp / exp.sum(axis=1, keepdims=True)
    if not np.isfinite(probabilities).all() or np.any(probabilities < 0):
        raise ValueError("概率含非法值")
    if not np.allclose(probabilities.sum(axis=1), 1.0, atol=1e-7):
        raise ValueError("概率行和不为1")
    return probabilities


def nll(probabilities, targets):
    return float(-np.log(np.clip(probabilities[np.arange(len(targets)), targets], 1e-12, 1)).mean())


def brier(probabilities, targets):
    truth = np.eye(probabilities.shape[1])[targets]
    return float(np.mean(np.sum((probabilities - truth) ** 2, axis=1)))


def ece(probabilities, targets, bins=15):
    confidence = probabilities.max(axis=1)
    correct = probabilities.argmax(axis=1) == targets
    total = len(targets)
    value = 0.0
    edges = np.linspace(0, 1, bins + 1)
    for index in range(bins):
        selected = ((confidence >= edges[index]) &
                    (confidence < edges[index + 1] if index < bins - 1 else confidence <= 1))
        if selected.any():
            value += selected.sum() / total * abs(float(correct[selected].mean()) -
                                                   float(confidence[selected].mean()))
    return float(value)


def calibration_metrics(probabilities, targets):
    return {"ece_15": ece(probabilities, targets), "nll": nll(probabilities, targets),
            "brier": brier(probabilities, targets)}


def fit_temperature(logits, targets):
    result = minimize_scalar(lambda log_t: nll(softmax(logits, np.exp(log_t)), targets),
                             bounds=(-3.0, 3.0), method="bounded")
    if not result.success:
        raise RuntimeError(f"temperature拟合失败: {result.message}")
    return float(np.exp(result.x))


def risk_coverage(probabilities, targets, threshold):
    confidence = probabilities.max(axis=1)
    accepted = confidence >= threshold
    coverage = float(accepted.mean())
    risk = (float(1 - (probabilities[accepted].argmax(axis=1) == targets[accepted]).mean())
            if accepted.any() else None)
    return {"threshold": float(threshold), "coverage": coverage,
            "selective_risk": risk, "n_accepted": int(accepted.sum()),
            "n_rejected": int((~accepted).sum())}


def select_threshold(probabilities, targets, min_coverage=0.8):
    rows = [risk_coverage(probabilities, targets, value) for value in THRESHOLDS]
    eligible = [row for row in rows if row["coverage"] >= min_coverage]
    best = min(eligible, key=lambda row: (row["selective_risk"], -row["coverage"], row["threshold"]))
    return best["threshold"], rows


def _oof_logits(matrix, labels, speakers, c_value, seed):
    pseudo = [{"sample_id": str(i), "speaker_id": str(s), "text_id": None}
              for i, s in enumerate(speakers)]
    folds = speaker_folds(pseudo, 3, seed)
    fold_by_id = {row["sample_id"]: row["fold"] for row in folds}
    logits = None
    classes = None
    for fold in range(3):
        test = np.array([fold_by_id[str(i)] == fold for i in range(len(labels))])
        model = _model(c_value)
        model.fit(matrix[~test], labels[~test])
        current_classes = model[-1].classes_.tolist()
        if classes is None:
            classes = current_classes
            logits = np.empty((len(labels), len(classes)), dtype=np.float64)
        elif current_classes != classes:
            raise ValueError("OOF折类别顺序漂移")
        logits[test] = model.decision_function(matrix[test])
    return logits, classes


def evaluate_calibrated(records, matrix, split_rows, seed=20260922):
    fold_by_id = {row["sample_id"]: row["fold"] for row in split_rows}
    scored = np.array([not bool(row.get("excluded", False)) for row in records])
    labels = np.array([row["label_canonical"] for row in records])
    speakers = np.array([row["speaker_id"] for row in records])
    prediction_rows, folds = [], []
    raw_probs_all, calibrated_probs_all, target_indices_all = [], [], []
    for fold in sorted(set(fold_by_id.values())):
        outer_test = np.array([fold_by_id[row["sample_id"]] == fold for row in records])
        train = ~outer_test & scored
        c_value, inner_scores = choose_parameter(
            "embedding_linear", matrix[train], labels[train], speakers[train], seed + fold)
        oof_logits, classes = _oof_logits(
            matrix[train], labels[train], speakers[train], c_value, seed + 100 + fold)
        class_index = {label: index for index, label in enumerate(classes)}
        train_targets = np.array([class_index[label] for label in labels[train]])
        temperature = fit_temperature(oof_logits, train_targets)
        oof_probabilities = softmax(oof_logits, temperature)
        threshold, train_curve = select_threshold(oof_probabilities, train_targets)

        model = _model(c_value)
        model.fit(matrix[train], labels[train])
        if model[-1].classes_.tolist() != classes:
            raise ValueError("最终模型类别顺序与OOF不一致")
        indices = np.where(outer_test)[0]
        logits = model.decision_function(matrix[outer_test])
        raw_probabilities = softmax(logits)
        calibrated = softmax(logits, temperature)
        test_scored = np.array([scored[index] for index in indices])
        scored_probabilities = calibrated[test_scored]
        test_targets = np.array([class_index[labels[index]] for index in indices[test_scored]])
        folds.append({
            "fold": fold, "c": c_value, "inner_macro_recall": inner_scores,
            "temperature": temperature, "selected_threshold": threshold,
            "n_train": int(train.sum()), "n_test": int(outer_test.sum()),
            "n_test_scored": int(test_scored.sum()), "train_oof_curve": train_curve,
            "raw": calibration_metrics(raw_probabilities[test_scored], test_targets),
            "calibrated": calibration_metrics(scored_probabilities, test_targets),
            "test_selected": risk_coverage(scored_probabilities, test_targets, threshold),
        })
        raw_probs_all.append(raw_probabilities[test_scored])
        calibrated_probs_all.append(scored_probabilities)
        target_indices_all.append(test_targets)
        for local, index in enumerate(indices):
            probability = calibrated[local]
            confidence = float(probability.max())
            predicted = classes[int(probability.argmax())]
            rejected = bool(scored[index] and confidence < threshold)
            prediction_rows.append({
                "sample_id": records[index]["sample_id"], "fold": fold,
                "target_canonical": records[index]["label_canonical"],
                "raw_probabilities": {label: float(raw_probabilities[local, pos])
                                      for pos, label in enumerate(classes)},
                "calibrated_probabilities": {label: float(probability[pos])
                                             for pos, label in enumerate(classes)},
                "confidence": confidence, "threshold": threshold, "rejected": rejected,
                "prediction_before_rejection": predicted,
                "prediction": "unknown" if rejected else predicted,
                "excluded": bool(records[index].get("excluded", False)), "status": "success",
            })
    prediction_rows.sort(key=lambda row: row["sample_id"])
    raw_all = np.concatenate(raw_probs_all)
    calibrated_all = np.concatenate(calibrated_probs_all)
    targets_all = np.concatenate(target_indices_all)
    metrics = evaluate_prediction_rows(prediction_rows)
    used = [row for row in prediction_rows if not row["excluded"]]
    metrics["macro_f1"] = round(f1_score(
        [row["target_canonical"] for row in used], [row["prediction"] for row in used],
        labels=SCORE_CLASSES, average="macro", zero_division=0), 6)
    aggregate = {
        "raw": calibration_metrics(raw_all, targets_all),
        "calibrated": calibration_metrics(calibrated_all, targets_all),
        "fixed_threshold_curve": [risk_coverage(calibrated_all, targets_all, value)
                                  for value in THRESHOLDS],
        "selected_threshold_result": {
            "coverage": float(np.mean([not row["rejected"] for row in used])),
            "selective_risk": float(1 - np.mean([
                row["prediction_before_rejection"] == row["target_canonical"]
                for row in used if not row["rejected"]])),
            "n_accepted": sum(not row["rejected"] for row in used),
            "n_rejected": sum(row["rejected"] for row in used),
        },
    }
    return metrics, aggregate, prediction_rows, folds


def _dump(path, value):
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--splits", required=True)
    parser.add_argument("--embedding-cache", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)
    output = Path(args.output_dir)
    if output.exists():
        raise FileExistsError(f"拒绝覆盖已有run目录: {output}")
    output.mkdir(parents=True)
    records, split_rows = load_jsonl(args.manifest), load_jsonl(args.splits)
    validate_speaker_isolation(records, split_rows, len(set(row["fold"] for row in split_rows)))
    matrix = load_matrix(args.embedding_cache, [row["sample_id"] for row in records], 1024)
    metrics, calibration, predictions, folds = evaluate_calibrated(records, matrix, split_rows)
    _dump(output / "metrics_rejected.json", metrics)
    _dump(output / "calibration.json", calibration)
    _dump(output / "folds.json", folds)
    with open(output / "predictions.jsonl", "w", encoding="utf-8", newline="\n") as stream:
        for row in predictions:
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    _dump(output / "metadata.json", {
        "pipelineVersion": PIPELINE_VERSION, "nSamples": len(records),
        "manifestSha256": file_sha256(args.manifest), "splitsSha256": file_sha256(args.splits),
        "embeddingCacheSha256": file_sha256(args.embedding_cache),
        "thresholdCandidates": THRESHOLDS, "minimumCalibrationCoverage": 0.8,
    })
    print(json.dumps({"metrics": {key: metrics[key] for key in ("accuracy", "uar", "macro_f1")},
                      "calibration": calibration}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
