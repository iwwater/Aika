# -*- coding: utf-8 -*-
"""SER-10 deterministic acoustic perturbation and latency benchmark."""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import librosa
import numpy as np
from sklearn.metrics import f1_score

from ser_calibration import calibration_metrics, risk_coverage, softmax
from ser_common import setup_environment
from ser_dataset import load_jsonl
from ser_evaluate import evaluate_prediction_rows
from ser_metrics import SCORE_CLASSES
from ser_splits import validate_speaker_isolation
from ser_ssl_probe import file_sha256, load_matrix, _model

PIPELINE_VERSION = "ser-robustness/1"
CONDITIONS = ("clean", "noise_snr20", "noise_snr10", "noise_snr0",
              "gain_minus12", "gain_plus12", "window_1s", "window_0p5s")


def seed_for(sample_id, condition):
    digest = hashlib.sha256(f"{sample_id}|{condition}".encode()).digest()
    return int.from_bytes(digest[:8], "big")


def perturb(audio, condition, sample_id, sample_rate=16000):
    y = np.asarray(audio, dtype=np.float32)
    if condition == "clean":
        return y.copy()
    if condition.startswith("noise_snr"):
        snr = float(condition.removeprefix("noise_snr"))
        rng = np.random.default_rng(seed_for(sample_id, condition))
        noise = rng.normal(size=len(y)).astype(np.float32)
        signal_rms = float(np.sqrt(np.mean(y ** 2)))
        noise_rms = float(np.sqrt(np.mean(noise ** 2)))
        scale = signal_rms / (10 ** (snr / 20) * max(noise_rms, 1e-12))
        return np.clip(y + noise * scale, -1, 1).astype(np.float32)
    if condition == "gain_minus12":
        return (y * 10 ** (-12 / 20)).astype(np.float32)
    if condition == "gain_plus12":
        return np.clip(y * 10 ** (12 / 20), -1, 1).astype(np.float32)
    if condition in ("window_1s", "window_0p5s"):
        seconds = 1.0 if condition == "window_1s" else 0.5
        length = min(len(y), int(sample_rate * seconds))
        start = max(0, (len(y) - length) // 2)
        return y[start:start + length].copy()
    raise ValueError(f"未知扰动条件: {condition}")


def validate_embedding_cache(matrix, ids, expected_ids):
    if matrix.shape != (len(expected_ids), 1024):
        raise ValueError(f"鲁棒性embedding shape异常: {matrix.shape}")
    if list(ids) != list(expected_ids) or len(set(ids)) != len(ids):
        raise ValueError("鲁棒性embedding ID顺序/唯一性异常")
    if not np.isfinite(matrix).all():
        raise ValueError("鲁棒性embedding含NaN/Inf")


def extract_condition(records, data_root, condition, cache_path, model=None):
    ids = [row["sample_id"] for row in records]
    cache = Path(cache_path)
    if cache.exists():
        with np.load(cache, allow_pickle=False) as data:
            matrix, cached_ids = data["X"], data["sample_ids"].tolist()
            elapsed, durations = data["elapsed_s"], data["duration_s"]
        validate_embedding_cache(matrix, cached_ids, ids)
        return matrix, elapsed, durations
    setup_environment()
    if model is None:
        from funasr import AutoModel
        model = AutoModel(model="iic/emotion2vec_plus_large", disable_update=True)
    root = Path(data_root).resolve(strict=True)
    vectors, elapsed, durations = [], [], []
    for index, record in enumerate(records, 1):
        audio, _ = librosa.load(root / record["audio_path"], sr=16000, mono=True)
        changed = perturb(audio, condition, record["sample_id"])
        started = time.perf_counter()
        result = model.generate(input=changed, granularity="utterance", extract_embedding=True,
                                disable_pbar=True, disable_log=True)
        elapsed.append(time.perf_counter() - started)
        durations.append(len(changed) / 16000)
        row = result[0] if isinstance(result, list) else result
        vector = np.asarray(row["feats"], dtype=np.float32)
        if vector.shape != (1024,):
            raise ValueError(f"{record['sample_id']} embedding shape异常: {vector.shape}")
        vectors.append(vector)
        if index % 100 == 0 or index == len(records):
            print(f"[{condition}] {index}/{len(records)}", flush=True)
    matrix = np.stack(vectors)
    validate_embedding_cache(matrix, ids, ids)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache, X=matrix, sample_ids=np.array(ids),
                        elapsed_s=np.asarray(elapsed), duration_s=np.asarray(durations))
    return matrix, np.asarray(elapsed), np.asarray(durations)


def latency_summary(elapsed, durations):
    elapsed = np.asarray(elapsed)
    durations = np.asarray(durations)
    return {"mean_s": float(elapsed.mean()), "p50_s": float(np.percentile(elapsed, 50)),
            "p95_s": float(np.percentile(elapsed, 95)),
            "real_time_factor": float(elapsed.sum() / durations.sum()),
            "total_inference_s": float(elapsed.sum()), "total_audio_s": float(durations.sum())}


def evaluate_condition(records, clean_matrix, condition_matrix, split_rows, calibration_folds):
    fold_by_id = {row["sample_id"]: row["fold"] for row in split_rows}
    calibration_by_fold = {row["fold"]: row for row in calibration_folds}
    labels = np.array([row["label_canonical"] for row in records])
    speakers = np.array([row["speaker_id"] for row in records])
    raw_rows, rejected_rows = [], []
    all_probabilities, all_targets = [], []
    for fold in sorted(calibration_by_fold):
        test = np.array([fold_by_id[row["sample_id"]] == fold for row in records])
        train = ~test
        settings = calibration_by_fold[fold]
        model = _model("embedding_linear", settings["c"])
        model.fit(clean_matrix[train], labels[train])
        classes = model[-1].classes_.tolist()
        class_index = {label: index for index, label in enumerate(classes)}
        logits = model.decision_function(condition_matrix[test])
        probabilities = softmax(logits, settings["temperature"])
        indices = np.where(test)[0]
        targets = np.array([class_index[labels[index]] for index in indices])
        all_probabilities.append(probabilities)
        all_targets.append(targets)
        for local, index in enumerate(indices):
            probability = probabilities[local]
            predicted = classes[int(probability.argmax())]
            confidence = float(probability.max())
            rejected = confidence < settings["selected_threshold"]
            base = {"sample_id": records[index]["sample_id"], "fold": fold,
                    "target_canonical": records[index]["label_canonical"],
                    "confidence": confidence, "threshold": settings["selected_threshold"],
                    "probabilities": {label: float(probability[pos])
                                      for pos, label in enumerate(classes)},
                    "excluded": False, "status": "success"}
            raw_rows.append({**base, "prediction": predicted, "rejected": False})
            rejected_rows.append({**base, "prediction_before_rejection": predicted,
                                  "prediction": "unknown" if rejected else predicted,
                                  "rejected": rejected})
    raw_rows.sort(key=lambda row: row["sample_id"])
    rejected_rows.sort(key=lambda row: row["sample_id"])
    probabilities, targets = np.concatenate(all_probabilities), np.concatenate(all_targets)
    raw_metrics = evaluate_prediction_rows(raw_rows)
    rejected_metrics = evaluate_prediction_rows(rejected_rows)
    for metrics, rows in ((raw_metrics, raw_rows), (rejected_metrics, rejected_rows)):
        metrics["macro_f1"] = float(f1_score(
            [row["target_canonical"] for row in rows], [row["prediction"] for row in rows],
            labels=SCORE_CLASSES, average="macro", zero_division=0))
    accepted = np.array([not row["rejected"] for row in rejected_rows])
    correct = np.array([row["prediction_before_rejection"] == row["target_canonical"]
                        for row in rejected_rows])
    selection = {"coverage": float(accepted.mean()), "n_accepted": int(accepted.sum()),
                 "n_rejected": int((~accepted).sum()),
                 "selective_risk": float(1 - correct[accepted].mean()) if accepted.any() else None}
    return {"raw_metrics": raw_metrics, "rejected_metrics": rejected_metrics,
            "calibration": calibration_metrics(probabilities, targets),
            "selection": selection}, rejected_rows


def _dump(path, value):
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--splits", required=True)
    parser.add_argument("--clean-embedding", required=True)
    parser.add_argument("--calibration-folds", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args(argv)
    output = Path(args.output_dir)
    if output.exists():
        raise FileExistsError(f"拒绝覆盖已有run目录: {output}")
    output.mkdir(parents=True)
    all_records, split_rows = load_jsonl(args.manifest), load_jsonl(args.splits)
    validate_speaker_isolation(all_records, split_rows, len(set(row["fold"] for row in split_rows)))
    records = [row for row in all_records if not row.get("excluded", False)]
    scored_ids = [row["sample_id"] for row in records]
    clean_all = load_matrix(args.clean_embedding, [row["sample_id"] for row in all_records], 1024)
    positions = {row["sample_id"]: index for index, row in enumerate(all_records)}
    clean = clean_all[[positions[sample_id] for sample_id in scored_ids]]
    scored_splits = [row for row in split_rows if row["sample_id"] in set(scored_ids)]
    calibration_folds = json.loads(Path(args.calibration_folds).read_text(encoding="utf-8"))
    setup_environment()
    from funasr import AutoModel
    model = AutoModel(model="iic/emotion2vec_plus_large", disable_update=True)
    summaries = {}
    for condition in CONDITIONS:
        cache = Path(args.cache_dir) / f"ravdess_ser10_{condition}.npz"
        matrix, elapsed, durations = extract_condition(
            records, args.data_root, condition, cache, model=model)
        result, predictions = evaluate_condition(
            records, clean, matrix, scored_splits, calibration_folds)
        result["latency"] = latency_summary(elapsed, durations)
        summaries[condition] = result
        with open(output / f"predictions_{condition}.jsonl", "w", encoding="utf-8", newline="\n") as stream:
            for row in predictions:
                stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        print(f"[{condition}] UAR={result['raw_metrics']['uar']} "
              f"coverage={result['selection']['coverage']:.4f} "
              f"risk={result['selection']['selective_risk']:.4f}", flush=True)
    _dump(output / "summary.json", summaries)
    _dump(output / "metadata.json", {
        "pipelineVersion": PIPELINE_VERSION, "conditions": CONDITIONS,
        "nSamplesPerCondition": len(records), "microphoneStatus": "BLOCKED",
        "microphoneReason": "no authorized recording session/device/environment record",
        "manifestSha256": file_sha256(args.manifest), "splitsSha256": file_sha256(args.splits),
        "cleanEmbeddingSha256": file_sha256(args.clean_embedding),
        "calibrationFoldsSha256": file_sha256(args.calibration_folds),
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
