# -*- coding: utf-8 -*-
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ser_splits import (SplitError, speaker_folds, strict_feasibility,
                        validate_speaker_isolation, write_split_version)


def records(n_speakers=10):
    return [
        {"sample_id": f"s{s}-x{t}", "speaker_id": f"s{s}", "text_id": f"t{t}"}
        for s in range(n_speakers) for t in range(2)
    ]


class TestSpeakerFolds(unittest.TestCase):
    def test_reproducible_and_isolated(self):
        data = records()
        first = speaker_folds(data, n_splits=5, seed=42)
        second = speaker_folds(list(reversed(data)), n_splits=5, seed=42)
        self.assertEqual(first, second)
        counts = validate_speaker_isolation(data, first, 5)
        self.assertTrue(all(value > 0 for value in counts.values()))
        self.assertLessEqual(max(counts.values()) - min(counts.values()), 2)

    def test_detects_speaker_leak(self):
        data = records(5)
        splits = speaker_folds(data, 5, 1)
        same_speaker = [i for i, row in enumerate(data) if row["speaker_id"] == "s0"]
        splits[same_speaker[1]]["fold"] = (splits[same_speaker[0]]["fold"] + 1) % 5
        with self.assertRaisesRegex(SplitError, "speaker 跨折"):
            validate_speaker_isolation(data, splits, 5)

    def test_not_enough_speakers(self):
        with self.assertRaisesRegex(SplitError, "少于折数"):
            speaker_folds(records(2), 5)

    def test_strict_missing_text_blocked(self):
        data = records()
        data[0]["text_id"] = None
        result = strict_feasibility(data)
        self.assertEqual(result["status"], "BLOCKED")
        self.assertIn(data[0]["sample_id"], result["samples"])

    def test_strict_connected_dataset_blocked(self):
        result = strict_feasibility(records(), n_splits=5)
        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(result["n_components"], 1)

    def test_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "v1"
            write_split_version(target, [{"sample_id": "a", "fold": 0}], {"v": 1})
            with self.assertRaises(FileExistsError):
                write_split_version(target, [], {})
            self.assertEqual(json.loads((target / "metadata.json").read_text()), {"v": 1})

    def test_same_input_is_byte_identical(self):
        data = records()
        first = speaker_folds(data, 5, 42)
        second = speaker_folds(list(reversed(data)), 5, 42)
        with tempfile.TemporaryDirectory() as td:
            one, two = Path(td) / "one", Path(td) / "two"
            write_split_version(one, first, {"seed": 42})
            write_split_version(two, second, {"seed": 42})
            self.assertEqual((one / "splits.jsonl").read_bytes(),
                             (two / "splits.jsonl").read_bytes())
            self.assertEqual((one / "metadata.json").read_bytes(),
                             (two / "metadata.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
