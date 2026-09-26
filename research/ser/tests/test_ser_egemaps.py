# -*- coding: utf-8 -*-
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ser_egemaps import (evaluate_cv, feature_group, load_features,
                         validate_feature_matrix)
from ser_splits import speaker_folds


def names88():
    prefixes = (["F0"] * 20 + ["jitter"] * 10 + ["F1"] * 18 + ["mfcc"] * 40)
    return [f"{prefix}_{i}" for i, prefix in enumerate(prefixes)]


class TestFeatures(unittest.TestCase):
    def test_shape_order_and_finite(self):
        names = names88()
        matrix = np.ones((2, 88))
        validate_feature_matrix(["a", "b"], names, matrix, ["a", "b"])
        for bad in (np.ones((2, 87)), np.full((2, 88), np.nan)):
            with self.assertRaises(ValueError):
                validate_feature_matrix(["a", "b"], names, bad, ["a", "b"])

    def test_cache_roundtrip_rejects_wrong_order(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "x.npz"
            np.savez_compressed(path, X=np.ones((2, 88)), sample_ids=np.array(["a", "b"]),
                                feature_names=np.array(names88()))
            matrix, ids, names = load_features(path, ["a", "b"])
            self.assertEqual(matrix.shape, (2, 88))
            with self.assertRaisesRegex(ValueError, "顺序"):
                load_features(path, ["b", "a"])

    def test_groups_cover_names(self):
        self.assertEqual(feature_group("F0_test"), "prosody_timing")
        self.assertEqual(feature_group("jitter_test"), "voice_quality")
        self.assertEqual(feature_group("F2_test"), "formants")
        self.assertEqual(feature_group("mfcc1_test"), "spectral_mfcc")


class TestTraining(unittest.TestCase):
    def test_nested_cv_produces_one_prediction_per_sample(self):
        rng = np.random.default_rng(42)
        labels = ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"]
        records = []
        vectors = []
        for speaker in range(10):
            for label_index, label in enumerate(labels):
                records.append({"sample_id": f"s{speaker}-{label}", "speaker_id": f"s{speaker}",
                                "text_id": "t", "label_canonical": label, "excluded": False})
                vector = rng.normal(0, 0.05, 88)
                vector[label_index] += 4
                vectors.append(vector)
        splits = speaker_folds(records, 5, 42)
        metrics, predictions, folds = evaluate_cv(records, np.array(vectors), splits, "logreg")
        self.assertEqual(len(predictions), len(records))
        self.assertEqual(len({row["sample_id"] for row in predictions}), len(records))
        self.assertEqual(len(folds), 5)
        self.assertEqual(metrics["n_attempted"], len(records))
        self.assertGreater(metrics["uar"], 0.75)


if __name__ == "__main__":
    unittest.main()
