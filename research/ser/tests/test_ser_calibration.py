# -*- coding: utf-8 -*-
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ser_calibration import (calibration_metrics, fit_temperature, risk_coverage,
                             select_threshold, softmax)


class TestCalibration(unittest.TestCase):
    def test_softmax_contract(self):
        probabilities = softmax(np.array([[1.0, 2.0], [-2.0, 4.0]]), 1.3)
        self.assertTrue(np.isfinite(probabilities).all())
        self.assertTrue((probabilities >= 0).all())
        np.testing.assert_allclose(probabilities.sum(axis=1), 1.0)

    def test_temperature_improves_overconfident_nll(self):
        logits = np.array([[8.0, 0.0], [8.0, 0.0], [0.0, 8.0], [0.0, 8.0]])
        targets = np.array([0, 1, 1, 0])
        before = calibration_metrics(softmax(logits), targets)["nll"]
        temperature = fit_temperature(logits, targets)
        after = calibration_metrics(softmax(logits, temperature), targets)["nll"]
        self.assertGreater(temperature, 1.0)
        self.assertLess(after, before)

    def test_rejection_keeps_explicit_counts(self):
        probabilities = np.array([[0.9, 0.1], [0.55, 0.45], [0.2, 0.8], [0.6, 0.4]])
        targets = np.array([0, 1, 1, 0])
        row = risk_coverage(probabilities, targets, 0.6)
        self.assertEqual(row["n_accepted"] + row["n_rejected"], 4)
        threshold, curve = select_threshold(probabilities, targets, min_coverage=0.5)
        self.assertIn(threshold, [item["threshold"] for item in curve])


if __name__ == "__main__":
    unittest.main()
