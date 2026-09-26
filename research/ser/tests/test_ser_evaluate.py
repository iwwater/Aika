# -*- coding: utf-8 -*-
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ser_evaluate import evaluate_prediction_rows


class TestEvaluateAdapter(unittest.TestCase):
    def test_unknown_and_failure_are_preserved(self):
        rows = [
            {"sample_id": "a", "target_canonical": "happy", "prediction": "happy"},
            {"sample_id": "b", "target_canonical": "happy", "prediction": "unknown"},
            {"sample_id": "c", "target_canonical": "sad", "status": "failed"},
        ]
        result = evaluate_prediction_rows(rows)
        self.assertEqual(result["ruleVersion"], "ser-metrics/2")
        self.assertEqual(result["n_attempted"], 3)
        self.assertEqual(result["n_success"], 2)
        self.assertEqual(result["n_failed"], 1)
        self.assertEqual(result["confusion"]["happy"]["unknown"], 1)
        self.assertEqual(result["accuracy"], 0.5)

    def test_excluded_sample(self):
        rows = [{"sample_id": "calm", "target_canonical": "other",
                 "prediction": "happy", "excluded": True}]
        result = evaluate_prediction_rows(rows)
        self.assertEqual(result["n_excluded"], 1)
        self.assertEqual(result["n_scored"], 0)


if __name__ == "__main__":
    unittest.main()
