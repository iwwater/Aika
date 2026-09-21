# -*- coding: utf-8 -*-
"""
SER 公共工具（SER-04）：路径推导、环境初始化、样本构造、结果标签规则、批处理。

规格：docs/ser/specs/SER-04.md。设计约束：
- 路径全部由本文件位置推导（无盘符硬编码），带空格目录可解析；
- 显式缓存环境变量（MODELSCOPE_CACHE/HF_HOME/TORCH_HOME）优先，否则落到本项目
  research/ser/.cache，不回退 C 盘用户目录；
- 标签归一化复用 ser_metrics.normalize_label（SER-03 计分仍是唯一公式入口，不另立一套）；
- 批处理：单样本失败继续、最终可判定退出码，attempted = success + failed 恒成立。
"""
import json
import os
import sys
import traceback

# ---- 路径（由代码位置推导；本文件位于 <project>/research/ser/）----
SER_ROOT = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SER_ROOT))
DEMO_DIR = os.path.join(PROJECT_ROOT, "demo", "aika-emotion-demo")
DEMO_DATA_JSON = os.path.join(DEMO_DIR, "data.json")
DEMO_AUDIO_DIR = os.path.join(DEMO_DIR, "audio")
OUTPUT_DIR = os.path.join(SER_ROOT, "output")
LOG_DIR = os.path.join(OUTPUT_DIR, "logs")
CACHE_ROOT = os.path.join(SER_ROOT, ".cache")
RAVDESS_DATA_DIR = os.path.join(SER_ROOT, "data", "ravdess", "speech")

_DLL_DIRS = [r"D:\ANACONDA\Library\bin"]  # base conda：ser venv 标准库 _lzma 依赖 liblzma.dll
_ENV_INITIALIZED = False


def setup_environment():
    """环境初始化（幂等）：Windows DLL 搜索路径 + 缓存重定向。

    - 已有 DLL 修复（原 ser_log.py 内联）集中到此；ser_log import 时自动调用。
    - 缓存环境变量仅在未设置时 setdefault，用户显式设置优先，不回退 C 盘。
    """
    global _ENV_INITIALIZED
    if _ENV_INITIALIZED:
        return
    for d in _DLL_DIRS:
        if os.path.isdir(d):
            os.add_dll_directory(d)
    os.environ.setdefault("MODELSCOPE_CACHE", os.path.join(CACHE_ROOT, "modelscope"))
    os.environ.setdefault("HF_HOME", os.path.join(CACHE_ROOT, "huggingface"))
    os.environ.setdefault("TORCH_HOME", os.path.join(CACHE_ROOT, "torch"))
    _ENV_INITIALIZED = True


# ---- 样本构造（probe / embedding 共用；固定顺序 ref×6 → 合成A×6 → 合成C×6）----

def _mood_slug_order():
    """6 mood 固定顺序（data.json items 的出现顺序即 A 组顺序）。"""
    return ["yasashii", "anshin", "shinmitsu", "hiniku", "dokuzetsu", "kongan"]


def build_demo_samples(data_json=None):
    """从 demo data.json 构造 18 段样本清单（不读音频内容，只解析路径与标签）。

    返回 list[dict]：{kind, slug, ja, zh, path}。
    kind ∈ {"ref(真人)", "合成A", "合成C"}；顺序固定：ref 6 → A 6 → C 6。
    """
    data_json = data_json or DEMO_DATA_JSON
    with open(data_json, encoding="utf-8") as f:
        d = json.load(f)
    samples = []
    for it in d["items"]:
        if it["combo"] == "A":
            ref_path = os.path.join(os.path.dirname(data_json),
                                    it["ref_src"].replace("/", os.sep))
            samples.append({"kind": "ref(真人)", "slug": it["slug"], "ja": it["ja"],
                            "zh": it["zh"], "path": ref_path})
    for it in d["items"]:
        src_path = os.path.join(os.path.dirname(data_json),
                                it["src"].replace("/", os.sep))
        samples.append({"kind": f"合成{it['combo']}", "slug": it["slug"], "ja": it["ja"],
                        "zh": it["zh"], "path": src_path})
    return samples


# ---- 结果标签规则（探针 / baseline / 服务同一份）----
# 归一化公式唯一来源 = ser_metrics.normalize_label（ser-metrics/2）


def parse_emotion2vec_result(res):
    """解析 model.generate() 的情绪分类返回 → {归一化label: float score}。

    - label 归一化走 ser_metrics.normalize_label（中文/英文复合、<unk>→unknown）
    - 异常输入（空返回、非 dict、缺 labels/scores、数量不符、非数值分数）显式报错，
      失败不冒充有效结果。
    """
    if res is None:
        raise ValueError("模型返回为空（res=None）")
    r0 = res[0] if isinstance(res, list) else res
    if not isinstance(r0, dict):
        raise ValueError(f"模型返回结构异常（期望 dict）: {res!r}")
    labels, scores = r0.get("labels"), r0.get("scores")
    if labels is None or scores is None:
        raise ValueError(f"模型返回缺少 labels/scores: {r0!r}")
    if not isinstance(labels, list) or not isinstance(scores, list):
        raise ValueError(f"labels/scores 必须是列表: {type(labels).__name__}/{type(scores).__name__}")
    if len(labels) == 0:
        raise ValueError("labels 为空返回")
    if len(labels) != len(scores):
        raise ValueError(f"labels({len(labels)}) 与 scores({len(scores)}) 数量不符")

    from ser_metrics import normalize_label
    out = {}
    for l, s in zip(labels, scores):
        try:
            sv = float(s)
        except (TypeError, ValueError):
            raise ValueError(f"非数值分数: label={l!r} score={s!r}")
        if sv != sv:  # NaN
            raise ValueError(f"NaN 分数: label={l!r}")
        out[normalize_label(l)] = sv
    return out


def top1(pred_map):
    """{label: score} → (label, score)，分数降序第一；空 dict 返回 (None, None)。"""
    if not pred_map:
        return None, None
    label = max(pred_map, key=pred_map.get)
    return label, pred_map[label]


# ---- 批处理（单样本失败继续；attempted = success + failed）----


class BatchSummary:
    """批处理结果。attempted = success + failed 恒成立（由构造保证）。"""

    def __init__(self):
        self.results = []    # [(item, value)]
        self.failures = []   # [{"index", "item", "error"}]
        self.attempted = 0

    @property
    def success(self):
        return len(self.results)

    @property
    def failed(self):
        return len(self.failures)

    def report(self, describe=lambda x: str(x)[:80]):
        """失败清单文本（写 stderr / 日志用），含每条错误信息。"""
        lines = []
        for f in self.failures:
            lines.append(f"[batch] 第 {f['index']} 项失败 {describe(f['item'])}: {f['error']}")
        return "\n".join(lines)


def run_batch(items, fn, describe=lambda x: str(x)[:80]):
    """逐项执行 fn(item)：单项异常不中断批次，最终汇总。

    - 失败项立即向 stderr 报明（不静默吞掉证据）；
    - 返回 BatchSummary；attempted = success + failed。
    """
    summary = BatchSummary()
    for i, item in enumerate(items):
        summary.attempted += 1
        try:
            summary.results.append((item, fn(item)))
        except Exception as e:  # noqa: BLE001 —— 单项失败必须继续批次
            summary.failures.append({
                "index": i, "item": item, "error": repr(e),
                "traceback": traceback.format_exc(),
            })
            print(f"[batch] 第 {i} 项失败 {describe(item)}: {e!r}", file=sys.stderr)
    return summary


# ---- 降维有效输入门槛（当前安装依赖的有效输入要求，依 ser_embedding_umap 现有流程）----
# PCA(n_components=min(n-1, 50)) 需要 n ≥ 2；UMAP(n_neighbors=min(8, n-1)) 需要
# n_neighbors ≥ 2 且实践中 n 过小无法形成有意义的邻域图 → 取 n_success < 4 为不足。
MIN_SAMPLES_FOR_DIMRED = 4


def ensure_dimred_input(n_success):
    """成功样本不足以执行现有降维流程时抛 RuntimeError（调用方非零退出，不输出伪图）。"""
    if n_success < MIN_SAMPLES_FOR_DIMRED:
        raise RuntimeError(
            f"成功样本 {n_success} 不足（<{MIN_SAMPLES_FOR_DIMRED}），"
            f"无法执行现有 PCA+UMAP 流程；不输出伪图，请检查音频与模型后重跑")
