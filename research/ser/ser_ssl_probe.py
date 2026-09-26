# -*- coding: utf-8 -*-
"""SER-08 frozen emotion2vec embedding extraction and speaker-independent probes."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, recall_score
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from ser_common import setup_environment
from ser_dataset import load_jsonl
from ser_evaluate import evaluate_prediction_rows
from ser_metrics import SCORE_CLASSES
from ser_splits import speaker_folds, validate_speaker_isolation

PIPELINE_VERSION = "ser-ssl-probe/1"
MODEL_ID = "iic/emotion2vec_plus_large"


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def model_artifact_path():
    setup_environment()
    return (Path(os.environ["MODELSCOPE_CACHE"]) / "models" /
            "iic--emotion2vec_plus_large" / "snapshots" / "master" / "model.pt")


def validate_matrix(matrix, sample_ids, expected_ids, expected_dim=None):
    if matrix.ndim != 2 or matrix.shape[0] != len(sample_ids):
        raise ValueError(f"embedding矩阵/ID数量不一致: {matrix.shape}, {len(sample_ids)}")
    if expected_dim is not None and matrix.shape[1] != expected_dim:
        raise ValueError(f"embedding维度应为{expected_dim}，得到{matrix.shape[1]}")
    if list(sample_ids) != list(expected_ids) or len(set(sample_ids)) != len(sample_ids):
        raise ValueError("embedding sample_id顺序或唯一性不符合manifest")
    if not np.isfinite(matrix).all():
        raise ValueError("embedding含NaN/Inf")


def extract_embeddings(records, data_root, output_npz, model=None):
    setup_environment()
    if model is None:
        from funasr import AutoModel
        model = AutoModel(model=MODEL_ID)
    root = Path(data_root).resolve(strict=True)
    vectors = []
    for index, record in enumerate(records, 1):
        path = (root / record["audio_path"]).resolve(strict=True)
        result = model.generate(input=str(path), granularity="utterance", extract_embedding=True)
        row = result[0] if isinstance(result, list) else result
        vector = np.asarray(row["feats"], dtype=np.float32)
        if vector.ndim != 1:
            raise ValueError(f"{record['sample_id']} embedding shape异常: {vector.shape}")
        vectors.append(vector)
        if index % 50 == 0 or index == len(records):
            print(f"[embedding] {index}/{len(records)}", flush=True)
    matrix = np.stack(vectors)
    ids = [row["sample_id"] for row in records]
    validate_matrix(matrix, ids, ids, 1024)
    target = Path(output_npz)
    target.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(target, X=matrix, sample_ids=np.array(ids))
    return matrix


def load_matrix(path, expected_ids, expected_dim=None):
    with np.load(path, allow_pickle=False) as data:
        matrix, ids = data["X"], data["sample_ids"].tolist()
    validate_matrix(matrix, ids, expected_ids, expected_dim)
    return matrix


def _model(kind, value):
    if kind in ("embedding_linear", "fusion_linear"):
        estimator = LogisticRegression(C=value, class_weight="balanced", max_iter=5000,
                                       random_state=20260922)
    elif kind == "embedding_mlp":
        estimator = MLPClassifier(hidden_layer_sizes=(128,), alpha=value, max_iter=400,
                                  early_stopping=False, random_state=20260922)
    else:
        raise ValueError(f"未知probe: {kind}")
    return make_pipeline(StandardScaler(), estimator)


def _candidates(kind):
    return (0.1, 1.0, 10.0) if kind != "embedding_mlp" else (0.0001, 0.001)


def _macro_recall(y_true, y_pred):
    return recall_score(y_true, y_pred, labels=sorted(set(y_true)),
                        average="macro", zero_division=0)


def choose_parameter(kind, matrix, labels, speakers, seed):
    pseudo = [{"sample_id": str(i), "speaker_id": str(s), "text_id": None}
              for i, s in enumerate(speakers)]
    rows = speaker_folds(pseudo, 3, seed)
    fold_by_id = {row["sample_id"]: row["fold"] for row in rows}
    scores = {}
    for value in _candidates(kind):
        fold_scores = []
        for fold in range(3):
            test = np.array([fold_by_id[str(i)] == fold for i in range(len(labels))])
            model = _model(kind, value)
            model.fit(matrix[~test], labels[~test])
            fold_scores.append(_macro_recall(labels[test], model.predict(matrix[test])))
        scores[str(value)] = float(np.mean(fold_scores))
    best = max(_candidates(kind), key=lambda value: (scores[str(value)], -value))
    return best, scores


def evaluate_probe(records, matrix, split_rows, kind, seed=20260922):
    fold_by_id = {row["sample_id"]: row["fold"] for row in split_rows}
    scored = np.array([not bool(row.get("excluded", False)) for row in records])
    labels = np.array([row["label_canonical"] for row in records])
    speakers = np.array([row["speaker_id"] for row in records])
    predictions, fold_reports = [], []
    for fold in sorted(set(fold_by_id.values())):
        outer_test = np.array([fold_by_id[row["sample_id"]] == fold for row in records])
        train = ~outer_test & scored
        best, inner = choose_parameter(kind, matrix[train], labels[train], speakers[train], seed + fold)
        model = _model(kind, best)
        model.fit(matrix[train], labels[train])
        predicted = model.predict(matrix[outer_test])
        indices = np.where(outer_test)[0]
        test_scored = np.array([scored[i] for i in indices])
        fold_reports.append({
            "fold": fold, "best_parameter": best, "inner_macro_recall": inner,
            "n_train": int(train.sum()), "n_test": int(outer_test.sum()),
            "n_test_scored": int(test_scored.sum()),
            "macro_f1": float(f1_score(labels[indices][test_scored], predicted[test_scored],
                                       labels=SCORE_CLASSES, average="macro", zero_division=0)),
        })
        for index, pred in zip(indices, predicted):
            row = records[index]
            predictions.append({"sample_id": row["sample_id"], "fold": fold,
                                "target_canonical": row["label_canonical"],
                                "prediction": str(pred),
                                "excluded": bool(row.get("excluded", False)),
                                "status": "success"})
    predictions.sort(key=lambda row: row["sample_id"])
    metrics = evaluate_prediction_rows(predictions)
    used = [row for row in predictions if not row["excluded"]]
    metrics["macro_f1"] = round(f1_score(
        [row["target_canonical"] for row in used], [row["prediction"] for row in used],
        labels=SCORE_CLASSES, average="macro", zero_division=0), 6)
    return metrics, predictions, fold_reports


def _dump(path, value):
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")


def _dump_jsonl(path, rows):
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--splits", required=True)
    parser.add_argument("--embedding-cache", required=True)
    parser.add_argument("--egemaps-cache", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)
    setup_environment()
    output = Path(args.output_dir)
    if output.exists():
        raise FileExistsError(f"拒绝覆盖已有run目录: {output}")
    output.mkdir(parents=True)
    records, split_rows = load_jsonl(args.manifest), load_jsonl(args.splits)
    validate_speaker_isolation(records, split_rows, len(set(row["fold"] for row in split_rows)))
    ids = [row["sample_id"] for row in records]
    embedding_path = Path(args.embedding_cache)
    embeddings = (load_matrix(embedding_path, ids, 1024) if embedding_path.exists()
                  else extract_embeddings(records, args.data_root, embedding_path))
    with np.load(args.egemaps_cache, allow_pickle=False) as data:
        egemaps, egemaps_ids = data["X"], data["sample_ids"].tolist()
    validate_matrix(egemaps, egemaps_ids, ids, 88)
    inputs = {
        "embedding_linear": embeddings,
        "embedding_mlp": embeddings,
        "fusion_linear": np.concatenate([embeddings, egemaps], axis=1),
    }
    summary = {}
    for kind, matrix in inputs.items():
        metrics, predictions, folds = evaluate_probe(records, matrix, split_rows, kind)
        _dump(output / f"metrics_{kind}.json", metrics)
        _dump_jsonl(output / f"predictions_{kind}.jsonl", predictions)
        _dump(output / f"folds_{kind}.json", folds)
        summary[kind] = {key: metrics[key] for key in ("accuracy", "uar", "macro_f1")}
        print(f"[{kind}] {summary[kind]}", flush=True)
    artifact = model_artifact_path()
    _dump(output / "metadata.json", {
        "pipelineVersion": PIPELINE_VERSION, "modelId": MODEL_ID,
        "modelArtifactSha256": file_sha256(artifact) if artifact.is_file() else None,
        "embeddingDimension": int(embeddings.shape[1]), "nSamples": len(records),
        "manifestSha256": file_sha256(args.manifest), "splitsSha256": file_sha256(args.splits),
        "embeddingCacheSha256": file_sha256(embedding_path),
        "egemapsCacheSha256": file_sha256(args.egemaps_cache), "models": summary,
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
