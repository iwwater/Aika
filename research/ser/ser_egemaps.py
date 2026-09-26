# -*- coding: utf-8 -*-
"""SER-07 eGeMAPSv02 extraction, nested speaker CV, and feature-group ablation."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, recall_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import LinearSVC

from ser_dataset import load_jsonl
from ser_evaluate import evaluate_prediction_rows
from ser_metrics import SCORE_CLASSES
from ser_splits import speaker_folds, validate_speaker_isolation

PIPELINE_VERSION = "ser-egemaps/1"
C_VALUES = (0.1, 1.0, 10.0)


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def feature_group(name):
    if name.startswith(("F0", "loudness_", "loudnessPeaks", "VoicedSegments",
                        "MeanVoiced", "StddevVoiced", "MeanUnvoiced", "StddevUnvoiced")):
        return "prosody_timing"
    if name.startswith(("jitter", "shimmer", "HNR", "logRelF0")):
        return "voice_quality"
    if name.startswith(("F1", "F2", "F3")):
        return "formants"
    return "spectral_mfcc"


def validate_feature_matrix(sample_ids, names, matrix, expected_ids=None):
    if matrix.ndim != 2 or matrix.shape[1] != 88:
        raise ValueError(f"eGeMAPSv02 Functionals 必须为88维，得到 {matrix.shape}")
    if len(names) != 88 or len(set(names)) != 88:
        raise ValueError("特征列名必须为88个唯一名称")
    if len(sample_ids) != matrix.shape[0] or len(set(sample_ids)) != len(sample_ids):
        raise ValueError("sample_id数量/唯一性与特征矩阵不一致")
    if expected_ids is not None and list(sample_ids) != list(expected_ids):
        raise ValueError("特征顺序与manifest顺序不一致")
    if not np.isfinite(matrix).all():
        bad = np.argwhere(~np.isfinite(matrix))[0]
        raise ValueError(f"特征含NaN/Inf: row={bad[0]} col={bad[1]}")
    groups = {feature_group(name) for name in names}
    if groups != {"prosody_timing", "voice_quality", "formants", "spectral_mfcc"}:
        raise ValueError(f"特征分组不完整: {groups}")


def extract_egemaps(records, data_root, output_npz):
    import opensmile
    smile = opensmile.Smile(feature_set=opensmile.FeatureSet.eGeMAPSv02,
                            feature_level=opensmile.FeatureLevel.Functionals)
    rows, names = [], None
    root = Path(data_root).resolve(strict=True)
    for index, record in enumerate(records, 1):
        path = (root / record["audio_path"]).resolve(strict=True)
        frame = smile.process_file(str(path))
        current_names = list(frame.columns)
        if names is None:
            names = current_names
        elif current_names != names:
            raise RuntimeError(f"特征列漂移: {record['sample_id']}")
        rows.append(frame.iloc[0].to_numpy(dtype=np.float64))
        if index % 100 == 0 or index == len(records):
            print(f"[extract] {index}/{len(records)}")
    matrix = np.vstack(rows)
    sample_ids = [r["sample_id"] for r in records]
    validate_feature_matrix(sample_ids, names, matrix, sample_ids)
    target = Path(output_npz)
    target.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(target, X=matrix, sample_ids=np.array(sample_ids),
                        feature_names=np.array(names))
    return matrix, sample_ids, names, opensmile.__version__


def load_features(path, expected_ids=None):
    with np.load(path, allow_pickle=False) as data:
        matrix = data["X"]
        sample_ids = data["sample_ids"].tolist()
        names = data["feature_names"].tolist()
    validate_feature_matrix(sample_ids, names, matrix, expected_ids)
    return matrix, sample_ids, names


def _model(kind, c_value):
    if kind == "logreg":
        estimator = LogisticRegression(C=c_value, class_weight="balanced", max_iter=5000,
                                       random_state=20260922)
    elif kind == "linear_svm":
        estimator = LinearSVC(C=c_value, class_weight="balanced", max_iter=10000,
                              random_state=20260922)
    else:
        raise ValueError(f"未知模型: {kind}")
    return make_pipeline(StandardScaler(), estimator)


def _macro_recall(y_true, y_pred):
    present = sorted(set(y_true))
    return recall_score(y_true, y_pred, labels=present, average="macro", zero_division=0)


def choose_c(kind, matrix, labels, groups, seed):
    pseudo = [{"sample_id": str(i), "speaker_id": str(group), "text_id": None}
              for i, group in enumerate(groups)]
    folds = speaker_folds(pseudo, n_splits=3, seed=seed)
    fold_by_id = {row["sample_id"]: row["fold"] for row in folds}
    scores = {}
    for c_value in C_VALUES:
        values = []
        for fold in range(3):
            test = np.array([fold_by_id[str(i)] == fold for i in range(len(labels))])
            model = _model(kind, c_value)
            model.fit(matrix[~test], labels[~test])
            values.append(_macro_recall(labels[test], model.predict(matrix[test])))
        scores[str(c_value)] = float(np.mean(values))
    best = max(C_VALUES, key=lambda value: (scores[str(value)], -value))
    return best, scores


def evaluate_cv(records, matrix, split_rows, kind, feature_indices=None, seed=20260922):
    by_id = {row["sample_id"]: i for i, row in enumerate(records)}
    fold_by_id = {row["sample_id"]: row["fold"] for row in split_rows}
    scored = np.array([not bool(row.get("excluded", False)) for row in records])
    labels = np.array([row["label_canonical"] for row in records])
    speakers = np.array([row["speaker_id"] for row in records])
    selected = matrix if feature_indices is None else matrix[:, feature_indices]
    predictions, fold_reports = [], []
    for fold in sorted(set(fold_by_id.values())):
        outer_test = np.array([fold_by_id[row["sample_id"]] == fold for row in records])
        train = ~outer_test & scored
        best_c, inner_scores = choose_c(kind, selected[train], labels[train], speakers[train], seed + fold)
        model = _model(kind, best_c)
        model.fit(selected[train], labels[train])
        pred = model.predict(selected[outer_test])
        test_indices = np.where(outer_test)[0]
        fold_scored = np.array([scored[i] for i in test_indices])
        fold_reports.append({
            "fold": fold, "best_c": best_c, "inner_macro_recall": inner_scores,
            "n_train": int(train.sum()), "n_test": int(outer_test.sum()),
            "n_test_scored": int(fold_scored.sum()),
            "macro_f1": float(f1_score(labels[test_indices][fold_scored], pred[fold_scored],
                                       labels=SCORE_CLASSES, average="macro", zero_division=0)),
        })
        for index, predicted in zip(test_indices, pred):
            row = records[index]
            predictions.append({
                "sample_id": row["sample_id"], "fold": fold,
                "target_canonical": row["label_canonical"], "prediction": str(predicted),
                "excluded": bool(row.get("excluded", False)), "status": "success",
            })
    predictions.sort(key=lambda row: row["sample_id"])
    metrics = evaluate_prediction_rows(predictions)
    scored_predictions = [row for row in predictions if not row["excluded"]]
    metrics["macro_f1"] = round(f1_score(
        [r["target_canonical"] for r in scored_predictions],
        [r["prediction"] for r in scored_predictions], labels=SCORE_CLASSES,
        average="macro", zero_division=0), 6)
    return metrics, predictions, fold_reports


def _json_dump(path, value):
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")


def _jsonl_dump(path, rows):
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--splits", required=True)
    parser.add_argument("--feature-cache", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)
    output = Path(args.output_dir)
    if output.exists():
        raise FileExistsError(f"拒绝覆盖已有run目录: {output}")
    output.mkdir(parents=True)
    records = load_jsonl(args.manifest)
    split_rows = load_jsonl(args.splits)
    validate_speaker_isolation(records, split_rows, len(set(r["fold"] for r in split_rows)))
    expected_ids = [r["sample_id"] for r in records]
    cache = Path(args.feature_cache)
    if cache.exists():
        matrix, sample_ids, names = load_features(cache, expected_ids)
        import opensmile
        opensmile_version = opensmile.__version__
    else:
        matrix, sample_ids, names, opensmile_version = extract_egemaps(records, args.data_root, cache)
    groups = {group: [i for i, name in enumerate(names) if feature_group(name) == group]
              for group in sorted({feature_group(name) for name in names})}
    summary = {}
    for kind in ("logreg", "linear_svm"):
        metrics, predictions, folds = evaluate_cv(records, matrix, split_rows, kind)
        _json_dump(output / f"metrics_{kind}.json", metrics)
        _jsonl_dump(output / f"predictions_{kind}.jsonl", predictions)
        _json_dump(output / f"folds_{kind}.json", folds)
        summary[kind] = {"accuracy": metrics["accuracy"], "uar": metrics["uar"],
                         "macro_f1": metrics["macro_f1"]}
        print(f"[{kind}] {summary[kind]}")
    ablations = []
    for removed, removed_indices in groups.items():
        keep = [i for i in range(len(names)) if i not in set(removed_indices)]
        metrics, _, folds = evaluate_cv(records, matrix, split_rows, "logreg", keep)
        ablations.append({"removed_group": removed, "removed_features": len(removed_indices),
                          "remaining_features": len(keep), "accuracy": metrics["accuracy"],
                          "uar": metrics["uar"], "macro_f1": metrics["macro_f1"],
                          "folds": folds})
    _json_dump(output / "ablations_logreg.json", ablations)
    metadata = {
        "pipelineVersion": PIPELINE_VERSION, "opensmileVersion": opensmile_version,
        "featureSet": "eGeMAPSv02", "featureLevel": "Functionals", "n_features": 88,
        "n_samples": len(records), "manifest_sha256": file_sha256(args.manifest),
        "splits_sha256": file_sha256(args.splits), "feature_cache_sha256": file_sha256(cache),
        "feature_groups": {k: len(v) for k, v in groups.items()}, "models": summary,
        "licenseBoundary": "openSMILE research/non-commercial use; no direct product use",
    }
    _json_dump(output / "metadata.json", metadata)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
