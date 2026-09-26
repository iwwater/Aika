# -*- coding: utf-8 -*-
"""SER-06 dataset manifest validation and RAVDESS inventory builder."""
from __future__ import annotations

import hashlib
import json
import os
import argparse
from pathlib import Path

from ser_metrics import PRED_CLASSES, normalize_label

SCHEMA_VERSION = "ser-dataset/1"
RAVDESS_EMOTIONS = {
    "01": "neutral", "02": "other", "03": "happy", "04": "sad",
    "05": "angry", "06": "fearful", "07": "disgusted", "08": "surprised",
}


class ManifestError(ValueError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def validate_manifest(records, data_root, verify_hash=True):
    """Validate records and return normalized copies with resolved_path added."""
    root = Path(data_root).resolve(strict=True)
    seen = set()
    validated = []
    errors = []
    required = ("sample_id", "dataset", "audio_path", "speaker_id", "language",
                "label_raw", "label_canonical", "license_scope", "content_sha256")

    for index, source in enumerate(records):
        row = dict(source)
        sid = row.get("sample_id") or f"<row:{index}>"
        row_errors = []
        for field in required:
            if not isinstance(row.get(field), str) or not row[field].strip():
                row_errors.append(f"{field} 必须是非空字符串")
        if sid in seen:
            row_errors.append("sample_id 重复")
        seen.add(sid)
        if not isinstance(row.get("text_id"), (str, type(None))):
            row_errors.append("text_id 必须是字符串或 null")

        raw_path = row.get("audio_path", "")
        if isinstance(raw_path, str) and raw_path:
            candidate = Path(raw_path)
            if candidate.is_absolute() or ".." in candidate.parts:
                row_errors.append("audio_path 必须是数据根内的相对路径且不得包含 ..")
            else:
                lexical = root.joinpath(candidate)
                try:
                    resolved = lexical.resolve(strict=True)
                    if not _inside(resolved, root):
                        row_errors.append("audio_path 或符号链接越出数据根")
                    elif not resolved.is_file():
                        row_errors.append("audio_path 不是文件")
                    else:
                        row["resolved_path"] = str(resolved)
                        if verify_hash and isinstance(row.get("content_sha256"), str):
                            actual = sha256_file(resolved)
                            if actual.lower() != row["content_sha256"].lower():
                                row_errors.append(
                                    f"content_sha256 不符 expected={row['content_sha256']} actual={actual}")
                except FileNotFoundError:
                    row_errors.append("audio_path 文件不存在")

        try:
            canonical = normalize_label(row.get("label_canonical"))
            if canonical != row.get("label_canonical"):
                row_errors.append("label_canonical 必须已经是规范英文标签")
        except ValueError as exc:
            row_errors.append(str(exc))

        if row_errors:
            errors.append({"sample_id": sid, "errors": row_errors})
        else:
            validated.append(row)

    if errors:
        detail = "; ".join(
            f"{item['sample_id']}: {', '.join(item['errors'])}" for item in errors)
        raise ManifestError(detail)
    return validated


def load_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as stream:
        for line_no, line in enumerate(stream, 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ManifestError(f"{path}:{line_no}: 非法 JSON: {exc}") from exc
    return rows


def write_jsonl(path, records):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in records:
            clean = {k: v for k, v in row.items() if k != "resolved_path"}
            stream.write(json.dumps(clean, ensure_ascii=False, sort_keys=True) + "\n")


def build_ravdess_manifest(data_root):
    root = Path(data_root).resolve(strict=True)
    records, invalid = [], []
    for path in sorted(root.glob("*.wav")):
        parts = path.stem.split("-")
        if len(parts) != 7 or parts[2] not in RAVDESS_EMOTIONS:
            invalid.append({"file": path.name, "reason": "文件名不符合 RAVDESS 7段编码"})
            continue
        label = RAVDESS_EMOTIONS[parts[2]]
        records.append({
            "sample_id": f"ravdess-{path.stem}",
            "dataset": "ravdess-speech",
            "audio_path": path.name,
            "speaker_id": f"actor-{parts[6]}",
            "text_id": f"statement-{parts[4]}",
            "language": "en",
            "label_raw": label if parts[2] != "02" else "calm",
            "label_canonical": label,
            "excluded": parts[2] == "02",
            "license_scope": "public-research",
            "content_sha256": sha256_file(path),
        })
    return records, invalid


def audit_manifest(records, invalid=None):
    invalid = invalid or []
    by_label, speakers, texts = {}, set(), set()
    for row in records:
        by_label[row["label_raw"]] = by_label.get(row["label_raw"], 0) + 1
        speakers.add(row["speaker_id"])
        if row.get("text_id") is not None:
            texts.add(row["text_id"])
    return {
        "schemaVersion": SCHEMA_VERSION,
        "n_samples": len(records),
        "n_speakers": len(speakers),
        "n_texts": len(texts),
        "by_label_raw": dict(sorted(by_label.items())),
        "n_invalid": len(invalid),
        "invalid": invalid,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build and audit a RAVDESS SER manifest")
    parser.add_argument("--ravdess-root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--audit", required=True)
    args = parser.parse_args(argv)
    records, invalid = build_ravdess_manifest(args.ravdess_root)
    validated = validate_manifest(records, args.ravdess_root, verify_hash=True)
    write_jsonl(args.manifest, validated)
    audit = audit_manifest(records, invalid)
    audit_path = Path(args.audit)
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    with audit_path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(audit, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")
    print(json.dumps(audit, ensure_ascii=False, sort_keys=True))
    return 0 if not invalid else 1


if __name__ == "__main__":
    raise SystemExit(main())
