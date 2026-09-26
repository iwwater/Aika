# -*- coding: utf-8 -*-
import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ser_dataset import ManifestError, audit_manifest, build_ravdess_manifest, validate_manifest


def digest(data):
    return hashlib.sha256(data).hexdigest()


def row(name="a.wav", sid="one", speaker="s1", label="happy", data=b"wav"):
    return {
        "sample_id": sid, "dataset": "fixture", "audio_path": name,
        "speaker_id": speaker, "text_id": "t1", "language": "ja",
        "label_raw": label, "label_canonical": label,
        "license_scope": "test-only", "content_sha256": digest(data),
    }


class TestManifestValidation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "a.wav").write_bytes(b"wav")

    def tearDown(self):
        self.tmp.cleanup()

    def test_valid_row(self):
        result = validate_manifest([row()], self.root)
        self.assertEqual(result[0]["sample_id"], "one")
        self.assertTrue(result[0]["resolved_path"].endswith("a.wav"))

    def test_duplicate_and_empty_speaker_rejected_with_id(self):
        with self.assertRaisesRegex(ManifestError, "one.*speaker_id.*重复"):
            validate_manifest([row(speaker=""), row()], self.root)

    def test_unknown_label_missing_file_and_bad_hash(self):
        cases = [
            (row(label="banana"), "非法标签"),
            (row(name="missing.wav"), "文件不存在"),
            ({**row(), "content_sha256": "0" * 64}, "content_sha256 不符"),
        ]
        for candidate, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ManifestError, message):
                validate_manifest([candidate], self.root)

    def test_path_escape_rejected(self):
        candidate = row(name="../a.wav")
        with self.assertRaisesRegex(ManifestError, "不得包含"):
            validate_manifest([candidate], self.root)

    def test_symlink_escape_rejected_when_supported(self):
        outside = self.root.parent / (self.root.name + "-outside.wav")
        outside.write_bytes(b"wav")
        link = self.root / "link.wav"
        try:
            link.symlink_to(outside)
        except OSError as exc:
            outside.unlink(missing_ok=True)
            self.skipTest(f"symlink unavailable: {exc}")
        try:
            with self.assertRaisesRegex(ManifestError, "越出数据根"):
                validate_manifest([row(name="link.wav")], self.root)
        finally:
            outside.unlink(missing_ok=True)


class TestRavdessBuilder(unittest.TestCase):
    def test_filename_protocol_and_audit(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "03-01-05-02-01-02-24.wav").write_bytes(b"x")
            (root / "bad.wav").write_bytes(b"x")
            records, invalid = build_ravdess_manifest(root)
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["label_raw"], "angry")
            self.assertEqual(records[0]["speaker_id"], "actor-24")
            self.assertEqual(records[0]["text_id"], "statement-01")
            summary = audit_manifest(records, invalid)
            self.assertEqual(summary["n_invalid"], 1)
            self.assertEqual(summary["n_speakers"], 1)


if __name__ == "__main__":
    unittest.main()
