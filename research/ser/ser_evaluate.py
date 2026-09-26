# -*- coding: utf-8 -*-
"""Unified evaluation adapter; scoring formulas remain owned by ser_metrics."""
from __future__ import annotations

from ser_metrics import score_run


def evaluate_prediction_rows(rows):
    records = []
    for row in rows:
        status = row.get("status", "success")
        records.append({
            "file": row["sample_id"],
            "target_raw": row.get("target_canonical", "neutral"),
            "pred_raw": row.get("prediction", "unknown"),
            "excluded": bool(row.get("excluded", False)),
            "status": status,
            "scores": row.get("scores"),
        })
    metrics = score_run(records)
    assert metrics["n_attempted"] == metrics["n_success"] + metrics["n_failed"]
    return metrics
