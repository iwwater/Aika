# -*- coding: utf-8 -*-
"""Reproducible leakage-safe split generation for SER-06."""
from __future__ import annotations

import hashlib
import json
import argparse
from collections import defaultdict
from pathlib import Path


class SplitError(ValueError):
    pass


def _stable_fold(group, seed, n_splits):
    token = f"{seed}:{group}".encode("utf-8")
    return int(hashlib.sha256(token).hexdigest(), 16) % n_splits


def speaker_folds(records, n_splits=5, seed=20260922):
    if n_splits < 2:
        raise SplitError("n_splits 必须 >= 2")
    speakers = sorted({r["speaker_id"] for r in records})
    if len(speakers) < n_splits:
        raise SplitError(f"说话人数 {len(speakers)} 少于折数 {n_splits}")
    sample_counts = defaultdict(int)
    for row in records:
        sample_counts[row["speaker_id"]] += 1
    # Largest groups first; seeded hash is only a deterministic tie breaker. Each group goes
    # to the currently lightest fold, preventing hash collisions from creating unusable folds.
    ordered = sorted(speakers, key=lambda s: (-sample_counts[s], _stable_fold(s, seed, 2**31), s))
    fold_loads = {fold: 0 for fold in range(n_splits)}
    assignment = {}
    for speaker in ordered:
        fold = min(fold_loads, key=lambda f: (fold_loads[f], f))
        assignment[speaker] = fold
        fold_loads[fold] += sample_counts[speaker]
    rows = [{"sample_id": r["sample_id"], "fold": assignment[r["speaker_id"]]}
            for r in sorted(records, key=lambda x: x["sample_id"])]
    validate_speaker_isolation(records, rows, n_splits)
    return rows


def validate_speaker_isolation(records, split_rows, n_splits):
    by_id = {r["sample_id"]: r for r in records}
    if len(split_rows) != len(records) or {r["sample_id"] for r in split_rows} != set(by_id):
        raise SplitError("split 必须恰好覆盖全部 sample_id")
    speaker_folds_seen = defaultdict(set)
    fold_counts = {fold: 0 for fold in range(n_splits)}
    for item in split_rows:
        fold = item["fold"]
        if fold not in fold_counts:
            raise SplitError(f"非法 fold: {fold}")
        source = by_id[item["sample_id"]]
        speaker_folds_seen[source["speaker_id"]].add(fold)
        fold_counts[fold] += 1
    leaking = {s: sorted(v) for s, v in speaker_folds_seen.items() if len(v) != 1}
    if leaking:
        raise SplitError(f"speaker 跨折泄漏: {leaking}")
    if any(count == 0 for count in fold_counts.values()):
        raise SplitError(f"存在空折: {fold_counts}")
    return fold_counts


def strict_feasibility(records, n_splits=5):
    """Check if connected speaker/text components can form strict folds."""
    missing = [r["sample_id"] for r in records if not r.get("text_id")]
    if missing:
        return {"status": "BLOCKED", "reason": "存在缺失 text_id 的样本", "samples": missing}
    graph = defaultdict(set)
    for r in records:
        speaker, text = "s:" + r["speaker_id"], "t:" + r["text_id"]
        graph[speaker].add(text)
        graph[text].add(speaker)
    components, visited = [], set()
    for node in sorted(graph):
        if node in visited:
            continue
        stack, component = [node], set()
        while stack:
            current = stack.pop()
            if current in component:
                continue
            component.add(current)
            stack.extend(graph[current] - component)
        visited.update(component)
        components.append(component)
    if len(components) < n_splits:
        return {
            "status": "BLOCKED",
            "reason": f"speaker/text 二部图只有 {len(components)} 个连通分量，无法形成 {n_splits} 个双隔离折",
            "n_components": len(components),
        }
    return {"status": "PASS", "n_components": len(components)}


def write_split_version(output_dir, split_rows, metadata):
    target = Path(output_dir)
    if target.exists():
        raise FileExistsError(f"拒绝覆盖已有 split 目录: {target}")
    target.mkdir(parents=True)
    with (target / "splits.jsonl").open("w", encoding="utf-8", newline="\n") as stream:
        for row in split_rows:
            stream.write(json.dumps(row, sort_keys=True) + "\n")
    with (target / "metadata.json").open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(metadata, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build leakage-safe SER speaker folds")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--seed", type=int, default=20260922)
    args = parser.parse_args(argv)
    from ser_dataset import load_jsonl
    records = load_jsonl(args.manifest)
    rows = speaker_folds(records, args.folds, args.seed)
    counts = validate_speaker_isolation(records, rows, args.folds)
    strict = strict_feasibility(records, args.folds)
    metadata = {
        "schemaVersion": "ser-splits/1",
        "manifest": str(args.manifest),
        "n_splits": args.folds,
        "seed": args.seed,
        "n_samples": len(records),
        "n_speakers": len({r['speaker_id'] for r in records}),
        "fold_sample_counts": counts,
        "strict_speaker_text": strict,
    }
    write_split_version(args.output_dir, rows, metadata)
    print(json.dumps(metadata, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
