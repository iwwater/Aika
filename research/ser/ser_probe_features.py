#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ser_probe_features.py — SER M0 POC：demo 6 情绪音频的可解释韵律特征提取 + 可区分性分析

背景：验证「日语语音的情绪确实编码在韵律/音色特征里，且可被这些特征区分」。
数据：demo 的 A/C 两组（同一句台词「お兄ちゃん、おはよう。今日も一緒に頑張ろうね。」× 6 情绪，
      A=自训声线, C=底模声线）+ ref 6 段真人参考（不同台词）。
关键设计：A/C 是「同文本 × 不同情绪」→ 词义恒定，若特征能区分情绪，则证明区分靠的是「语气」而非「词义」。

只依赖 librosa + numpy（GPTSoVits 环境已装），无其他新依赖。
"""
import json
import os
import sys
import numpy as np
import librosa

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ser_common import DEMO_DIR, OUTPUT_DIR, setup_environment

setup_environment()

OUT_DIR = OUTPUT_DIR
DATA_JSON = os.path.join(DEMO_DIR, "data.json")
SR = 16000


def load_audio(path, sr=SR):
    y, sr = librosa.load(path, sr=sr, mono=True)
    return y, sr


def extract_features(y, sr):
    """提取可解释韵律特征。所有特征物理意义明确，便于「为什么能判断情绪」的解释。"""
    f = {}
    dur = len(y) / sr
    f["dur"] = float(dur)

    # --- F0（音高）---
    f0, voiced, _ = librosa.pyin(y, fmin=60.0, fmax=600.0, sr=sr, fill_na=np.nan)
    f0v = f0[~np.isnan(f0)]
    if len(f0v) > 2:
        f["f0_mean"] = float(np.mean(f0v))
        f["f0_std"] = float(np.std(f0v))
        f["f0_cv"] = float(np.std(f0v) / np.mean(f0v))
        st = 12.0 * np.log2(f0v / np.median(f0v))
        f["f0_range_st"] = float(np.percentile(st, 95) - np.percentile(st, 5))
        # jitter（周期级微扰动，音色/颤音度量）
        d = np.abs(np.diff(f0v))
        f["jitter"] = float(np.mean(d) / np.mean(f0v))
    else:
        f["f0_mean"] = f["f0_std"] = f["f0_cv"] = f["f0_range_st"] = f["jitter"] = np.nan

    # --- 能量（响度）---
    rms = librosa.feature.rms(y=y)[0]
    rms_pos = rms[rms > 1e-6]
    f["rms_mean"] = float(np.mean(rms))
    if len(rms_pos) > 10:
        f["rms_dyn_db"] = float(20 * np.log10(np.percentile(rms_pos, 95) / np.percentile(rms_pos, 5) + 1e-9))
        # shimmer（能量相邻帧微扰动）
        d = np.abs(np.diff(rms_pos))
        f["shimmer"] = float(np.mean(d) / np.mean(rms_pos))
    else:
        f["rms_dyn_db"] = f["shimmer"] = np.nan

    # --- 语速（音节率：能量包络峰数 / 时长）---
    env = rms
    th = np.median(env) * 1.2
    peaks = np.sum((env[1:-1] > th) & (env[1:-1] > env[:-2]) & (env[1:-1] > env[2:]))
    f["rate_sylps"] = float(peaks / dur) if dur > 0 else np.nan

    # --- 频谱（音色）---
    cent = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    f["spec_centroid"] = float(np.mean(cent))
    # 频谱斜率（高频 vs 低频能量比，用频谱滚降点近似）
    roll = librosa.feature.spectral_rolloff(y=y, sr=sr)[0]
    f["spec_rolloff"] = float(np.mean(roll))
    f["spec_flatness"] = float(np.mean(librosa.feature.spectral_flatness(y=y)[0]))

    # --- MFCC（前 6 维均值，频谱包络粗描述）---
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=6)
    for i in range(6):
        f[f"mfcc{i+1}_mean"] = float(np.mean(mfcc[i]))

    return f


FEATURE_KEYS = [
    "f0_mean", "f0_cv", "f0_range_st", "jitter",
    "rms_mean", "rms_dyn_db", "shimmer", "rate_sylps",
    "spec_centroid", "spec_rolloff", "spec_flatness",
    "mfcc1_mean", "mfcc2_mean", "mfcc3_mean",
]


def zscore(matrix):
    m = np.asarray(matrix, dtype=float)
    mu = np.nanmean(m, axis=0)
    sd = np.nanstd(m, axis=0)
    sd[sd == 0] = 1.0
    return (m - mu) / sd, mu, sd


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(DATA_JSON, encoding="utf-8") as fh:
        data = json.load(fh)

    rows = []
    for it in data["items"]:
        src = os.path.join(DEMO_DIR, it["src"])
        ref = os.path.join(DEMO_DIR, it["ref_src"])
        y, sr = load_audio(src)
        feat = extract_features(y, sr)
        feat.update({"combo": it["combo"], "num": it["num"],
                     "slug": it["slug"], "zh": it["zh"], "src": it["src"]})
        rows.append(feat)
        # 真人参考音频（不同台词，单独记录，不做词义隔离）
        yr, _ = load_audio(ref)
        rfeat = extract_features(yr, sr)
        rfeat.update({"combo": "ref", "num": it["num"],
                      "slug": it["slug"], "zh": it["zh"], "src": it["ref_src"]})
        rows.append(rfeat)

    # 落盘特征矩阵
    with open(os.path.join(OUT_DIR, "features.json"), "w", encoding="utf-8") as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=1)

    # ---- 可区分性分析：A/C 组（同句 × 6 情绪）----
    ac = [r for r in rows if r["combo"] in ("A", "C")]
    # 每个情绪取 A/C 两点的特征向量均值作为该情绪的代表点
    rep = {}
    for r in ac:
        rep.setdefault(r["slug"], []).append(r)
    emo_keys = sorted(rep.keys())

    # 类内距离（同情绪 A vs C）与类间距离（不同情绪代表点之间）
    def vec(r):
        return np.array([r[k] if not np.isnan(r[k]) else 0.0 for k in FEATURE_KEYS])

    Z, mu, sd = zscore([vec(r) for r in ac])
    # 每个情绪代表点 = A/C 标准化向量的均值
    centers = {}
    for slug in emo_keys:
        idx = [i for i, r in enumerate(ac) if r["slug"] == slug]
        centers[slug] = Z[idx].mean(axis=0)

    intra = []
    for slug in emo_keys:
        idx = [i for i, r in enumerate(ac) if r["slug"] == slug]
        if len(idx) == 2:
            intra.append(np.linalg.norm(Z[idx[0]] - Z[idx[1]]))
    inter = []
    pairs = []
    for i in range(len(emo_keys)):
        for j in range(i + 1, len(emo_keys)):
            d = np.linalg.norm(centers[emo_keys[i]] - centers[emo_keys[j]])
            inter.append(d)
            pairs.append((emo_keys[i], emo_keys[j], float(d)))

    intra_mean = float(np.mean(intra)) if intra else np.nan
    inter_mean = float(np.mean(inter)) if inter else np.nan
    ratio = inter_mean / intra_mean if intra_mean else np.nan

    # 每个特征在情绪间的区分度（F 统计量近似：组间方差/组内方差）
    disc = {}
    for k in FEATURE_KEYS:
        vals = np.array([r[k] for r in ac if not np.isnan(r[k])])
        # 按情绪分组
        groups = {}
        for r in ac:
            if not np.isnan(r[k]):
                groups.setdefault(r["slug"], []).append(r[k])
        if len(groups) < 2:
            continue
        gm = np.array([np.mean(v) for v in groups.values()])
        between = np.var(gm) * 2  # 2 声线/情绪，近似组间
        within = np.mean([np.var(v) for v in groups.values()]) + 1e-9
        disc[k] = float(between / within)

    disc_sorted = sorted(disc.items(), key=lambda x: -x[1])

    report = []
    report.append("# SER M0 POC — 情绪可区分性分析\n")
    report.append(f"数据：demo A/C 两组（同句「お兄ちゃん、おはよう。今日も一緒に頑張ろうね。」× 6 情绪），n={len(ac)} 段合成语音。\n")
    report.append("**词义恒定（同一句台词），若特征能区分情绪，则证明区分靠「语气」而非「词义」。**\n")
    report.append("\n## 1. 可区分性总指标（标准化特征空间）\n")
    report.append(f"- 同情绪 A/C 类内距离均值：**{intra_mean:.3f}**")
    report.append(f"- 异情绪类间距离均值：**{inter_mean:.3f}**")
    report.append(f"- 类间/类内比：**{ratio:.2f}**（>1 表示情绪间可区分，越大越好）\n")
    report.append("\n## 2. 区分度最高的特征（组间/组内方差比）\n")
    report.append("| 特征 | 物理含义 | 区分度 |")
    report.append("|---|---|---|")
    for k, v in disc_sorted[:8]:
        report.append(f"| {k} | {FEATURE_MEANING.get(k, '')} | {v:.2f} |")
    report.append("\n## 3. 情绪两两距离（标准化特征空间）\n")
    report.append("| 情绪对 | 距离 |")
    report.append("|---|---|")
    for a, b, d in sorted(pairs, key=lambda x: -x[2]):
        report.append(f"| {a} ↔ {b} | {d:.3f} |")
    report.append("\n## 4. 每情绪特征摘要（A/C 均值）\n")
    report.append("| 情绪 | f0_cv | f0_range_st | jitter | rms_dyn_db | rate_sylps |")
    report.append("|---|---|---|---|---|---|")
    emo_zh = {r["slug"]: r["zh"] for r in rows if r["combo"] == "A"}
    for slug in emo_keys:
        idx = [i for i, r in enumerate(ac) if r["slug"] == slug]
        av = {}
        for k in ["f0_cv", "f0_range_st", "jitter", "rms_dyn_db", "rate_sylps"]:
            av[k] = np.nanmean([r[k] for r in [ac[i] for i in idx]])
        report.append(f"| {emo_zh.get(slug, slug)} | {av['f0_cv']:.3f} | {av['f0_range_st']:.2f} | {av['jitter']*100:.2f}% | {av['rms_dyn_db']:.1f} | {av['rate_sylps']:.2f} |")

    with open(os.path.join(OUT_DIR, "report.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(report) + "\n")

    print(f"[ok] 特征矩阵 -> {os.path.join(OUT_DIR, 'features.json')}")
    print(f"[ok] 报告 -> {os.path.join(OUT_DIR, 'report.md')}")
    print(f"[info] 类内 {intra_mean:.3f} / 类间 {inter_mean:.3f} / 比 {ratio:.2f}")
    print("[info] 区分度 Top5: " + ", ".join(f"{k}={v:.1f}" for k, v in disc_sorted[:5]))


FEATURE_MEANING = {
    "f0_cv": "基频变异系数（音高起伏程度）",
    "f0_range_st": "基频半音跨度（音高动态范围）",
    "f0_mean": "平均基频",
    "jitter": "基频周期级微扰动（颤音/音色）",
    "rms_mean": "平均响度",
    "rms_dyn_db": "响度动态范围",
    "shimmer": "响度周期级微扰动",
    "rate_sylps": "语速（音节/秒）",
    "spec_centroid": "频谱质心（声音亮暗）",
    "spec_rolloff": "频谱滚降点（高频能量分布）",
    "spec_flatness": "频谱平坦度（噪声性）",
    "mfcc1_mean": "MFCC1（整体频谱倾斜）",
    "mfcc2_mean": "MFCC2",
    "mfcc3_mean": "MFCC3",
}


if __name__ == "__main__":
    main()
