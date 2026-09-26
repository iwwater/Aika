# -*- coding: utf-8 -*-
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ser_robustness import latency_summary, perturb


class TestRobustness(unittest.TestCase):
    def test_noise_is_deterministic_and_changes_snr(self):
        audio = np.sin(np.linspace(0, 20, 32000)).astype(np.float32) * 0.1
        first = perturb(audio, "noise_snr10", "sample")
        second = perturb(audio, "noise_snr10", "sample")
        np.testing.assert_array_equal(first, second)
        self.assertFalse(np.array_equal(audio, first))

    def test_gain_and_center_windows(self):
        audio = np.linspace(-0.2, 0.2, 48000, dtype=np.float32)
        self.assertEqual(len(perturb(audio, "window_1s", "x")), 16000)
        self.assertEqual(len(perturb(audio, "window_0p5s", "x")), 8000)
        np.testing.assert_allclose(perturb(audio, "gain_minus12", "x"),
                                   audio * 10 ** (-12 / 20), rtol=1e-6)
        self.assertLessEqual(abs(perturb(audio * 10, "gain_plus12", "x")).max(), 1)

    def test_latency_summary_is_embedding_only_and_finite(self):
        result = latency_summary(np.array([0.1, 0.2]), np.array([1.0, 1.0]))
        self.assertAlmostEqual(result["real_time_factor"], 0.15)
        self.assertTrue(all(np.isfinite(value) for value in result.values()))


if __name__ == "__main__":
    unittest.main()
