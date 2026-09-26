# -*- coding: utf-8 -*-
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ser_splits import speaker_folds
from ser_ssl_probe import evaluate_probe, model_artifact_path, validate_matrix


class TestSslProbe(unittest.TestCase):
    def test_model_artifact_stays_in_configured_cache(self):
        self.assertEqual(model_artifact_path().name, "model.pt")
        self.assertIn("iic--emotion2vec_plus_large", str(model_artifact_path()))

    def test_matrix_contract(self):
        validate_matrix(np.ones((2, 1024)), ["a", "b"], ["a", "b"], 1024)
        for matrix, ids in ((np.ones((2, 10)), ["a", "b"]),
                            (np.full((2, 1024), np.nan), ["a", "b"]),
                            (np.ones((2, 1024)), ["b", "a"])):
            with self.assertRaises(ValueError):
                validate_matrix(matrix, ids, ["a", "b"], 1024)

    def test_linear_probe_prediction_contract(self):
        rng = np.random.default_rng(8)
        labels = ["neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"]
        records, vectors = [], []
        for speaker in range(10):
            for label_index, label in enumerate(labels):
                records.append({"sample_id": f"s{speaker}-{label}", "speaker_id": f"s{speaker}",
                                "text_id": "t", "label_canonical": label, "excluded": False})
                vector = rng.normal(0, 0.03, 16)
                vector[label_index] += 3
                vectors.append(vector)
        splits = speaker_folds(records, 5, 42)
        metrics, predictions, folds = evaluate_probe(
            records, np.asarray(vectors), splits, "embedding_linear")
        self.assertEqual(len(predictions), 70)
        self.assertEqual(len({row["sample_id"] for row in predictions}), 70)
        self.assertEqual(len(folds), 5)
        self.assertGreater(metrics["uar"], 0.75)


if __name__ == "__main__":
    unittest.main()
