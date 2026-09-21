# -*- coding: utf-8 -*-
"""
实验 1：emotion2vec+ embedding 提取 + UMAP 可视化（见 docs/ser/SPEC_SER-02.md §2）。

把 demo 18 段的 utterance-level embedding 提取出来，PCA 预处理后 UMAP 降到 2D，
看 6 情绪在特征空间的真实分布。所有事件走 ser_log.py 结构化日志。

用法：
    python ser_embedding_umap.py                      # 默认 large
    python ser_embedding_umap.py --model iic/emotion2vec_plus_base
"""
import json, os, sys, time, argparse
import numpy as np
from ser_log import setup_logger
from ser_common import OUTPUT_DIR, build_demo_samples, run_batch, ensure_dimred_input, setup_environment

# 缓存重定向 + DLL 修复（显式环境变量优先，否则落 research/ser/.cache）
setup_environment()

OUT_DIR = os.path.join(OUTPUT_DIR, "embedding")

MOOD_ZH = {
    "yasashii": "温柔", "anshin": "安心", "shinmitsu": "亲密",
    "hiniku": "嘲讽", "dokuzetsu": "毒舌", "kongan": "恳求",
}


def build_samples():
    """兼容包装：样本构造统一走 ser_common（SER-04，probe/embedding 同一清单）。"""
    return build_demo_samples()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="iic/emotion2vec_plus_large")
    args = ap.parse_args()

    log, logpath = setup_logger("embedding_umap", "embedding_umap")
    log.info("启动", extra={
        "model": args.model,
        "params": {"granularity": "utterance", "extract_embedding": True},
    })

    from funasr import AutoModel
    log.info("加载模型...")
    model = AutoModel(model=args.model)
    log.info("模型加载完成", extra={"model": args.model})

    samples = build_samples()
    log.info(f"待处理 {len(samples)} 段")

    # ---- 批处理（SER-04：单样本失败继续；attempted = success + failed）----
    def _extract(s):
        t0 = time.time()
        res = model.generate(input=s["path"], granularity="utterance", extract_embedding=True)
        dt = time.time() - t0
        r0 = res[0] if isinstance(res, list) else res
        feat = np.asarray(r0["feats"], dtype=np.float32)
        if feat.ndim != 1:
            raise ValueError(f"embedding 维度异常 shape={feat.shape}")
        log.info(f"embedding 提取成功 shape={tuple(feat.shape)}", extra={
            "audio": s["path"], "slug": s["slug"], "kind": s["kind"],
            "elapsed_s": round(dt, 3),
        })
        return feat, round(dt, 3)

    batch = run_batch(samples, _extract, describe=lambda s: f"{s['kind']}/{s['slug']}")
    embeds = [v[0] for _, v in batch.results]
    meta = [{"slug": s["slug"], "kind": s["kind"], "zh": s["zh"], "ja": s["ja"]}
            for s, _ in batch.results]
    failed = [f["item"]["path"] for f in batch.failures]
    for f in batch.failures:  # 失败带完整堆栈落日志（SER-02 日志规范）
        log.error(f"embedding 提取失败 {f['error']}", extra={
            "audio": f["item"]["path"], "slug": f["item"]["slug"],
            "kind": f["item"]["kind"], "params": {"traceback": f["traceback"]}})

    if not embeds:
        log.error("无任何成功样本，终止")
        sys.exit(1)
    # 降维有效输入门槛：不足即明确结束，不输出伪图
    try:
        ensure_dimred_input(len(embeds))
    except RuntimeError as e:
        log.error(str(e))
        sys.exit(2)

    X = np.stack(embeds)
    log.info(f"embedding 矩阵 shape={X.shape}，"
             f"attempted={batch.attempted} success={batch.success} failed={batch.failed}")

    os.makedirs(OUT_DIR, exist_ok=True)
    mname = args.model.split("/")[-1]
    npz_path = os.path.join(OUT_DIR, f"{mname}_embeddings.npz")
    np.savez(npz_path, X=X, meta=np.array(meta, dtype=object))
    log.info(f"embedding 已存 {npz_path}")

    # PCA 预处理（18 样本高维直接 UMAP 会退化，先降到 n-1 维）
    n = X.shape[0]
    pca_n = min(n - 1, 50)
    from sklearn.decomposition import PCA
    pca = PCA(n_components=pca_n, random_state=42)
    Xp = pca.fit_transform(X)
    log.info(f"PCA: {X.shape} -> {Xp.shape}（累计方差 {float(pca.explained_variance_ratio_.sum()):.3f}）")

    import umap
    reducer = umap.UMAP(n_components=2, n_neighbors=min(8, n - 1), min_dist=0.3, random_state=42)
    X2 = reducer.fit_transform(Xp)
    log.info(f"UMAP: {Xp.shape} -> {X2.shape}")

    coords = []
    for i, m in enumerate(meta):
        coords.append({"slug": m["slug"], "kind": m["kind"], "zh": m["zh"],
                       "ja": m["ja"], "x": float(X2[i, 0]), "y": float(X2[i, 1])})
    coord_path = os.path.join(OUT_DIR, f"{mname}_umap_coords.json")
    with open(coord_path, "w", encoding="utf-8") as f:
        json.dump(coords, f, ensure_ascii=False, indent=2)
    log.info(f"UMAP 坐标已存 {coord_path}")

    # 散点图（标签用英文 slug 规避中文字体问题）
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    slugs = list(MOOD_ZH)
    kind_en = {"ref(真人)": "ref(human)", "合成A": "synthA", "合成C": "synthC"}
    kind_marker = {"ref(真人)": "o", "合成A": "s", "合成C": "^"}
    fig, ax = plt.subplots(figsize=(9, 7))
    for m, (x, y) in zip(meta, X2):
        c = slugs.index(m["slug"])
        ax.scatter(x, y, c=[plt.cm.tab10(c / len(slugs))], marker=kind_marker.get(m["kind"], "x"),
                   s=110, alpha=0.85, edgecolors="white", linewidths=0.8,
                   label=f"{m['slug']} {kind_en.get(m['kind'], m['kind'])}")
    # 去重图例（按 slug 一个色 + 按 kind 一个形状）
    handles, labels = ax.get_legend_handles_labels()
    by_label = dict(zip(labels, handles))
    ax.legend(by_label.values(), by_label.keys(), bbox_to_anchor=(1.02, 1), loc="upper left", fontsize=9)
    ax.set_title(f"emotion2vec+ embedding UMAP ({mname}, n={n})")
    ax.set_xlabel("UMAP dim 1")
    ax.set_ylabel("UMAP dim 2")
    fig.tight_layout()
    png_path = os.path.join(OUT_DIR, f"{mname}_umap_scatter.png")
    fig.savefig(png_path, dpi=150, bbox_inches="tight")
    log.info(f"散点图已存 {png_path}")

    ok = n - len(failed)
    log.info(f"实验 1 完成：成功 {ok}/{n}，失败 {len(failed)}", extra={"params": {"failed": failed}})
    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    main()
