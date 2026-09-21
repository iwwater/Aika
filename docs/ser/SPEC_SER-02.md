# SPEC SER-02 — M0 剩余实验：embedding/UMAP + 英文 baseline（含日志规范）

> 状态：执行规格（脚本按此实现，验收按此核对）
> 日期：2026-09-20
> 前置：`SPEC_SER-01.md`（方向）、`RESEARCH_PLAN.md` §5.2（base vs large 结论）
> 原则：**出问题有日志可查** —— 所有实验脚本统一走 `ser_log.py` 结构化日志，异常全量落盘可回溯。

---

## 0. 目的

为「base vs large 偏置结论」上双保险，M0 还剩两个验证实验：

1. **实验 1（embedding + UMAP）**：把 18 段音频的 emotion2vec+ 特征向量投影到 2D，看 6 情绪的**真实分布**（谁和谁缠在一起）—— 比只看 top1 分类标签更细粒度。
2. **实验 2（英文 baseline）**：用公开英文数据（RAVDESS）验证 emotion2vec+ 的 baseline 能力，**排除「模型本身有问题」** 这个干扰解释。

---

## 1. 日志规范（核心，先于实验定义）

### 1.1 统一基础设施 `ser_log.py`

所有实验脚本必须用 `research/ser/ser_log.py` 的 `setup_logger()`，**禁止裸 `print`**。它同时输出：

- **console**：人类可读，带时间戳 / 级别，实时看进度；
- **JSONL 文件**：结构化，一行一事件，落 `research/ser/output/logs/`。

日志文件按 `{实验名}_{时间戳}.jsonl` 命名，**只追加、不删除、不滚动**（历史运行全留痕；也规避 safe-delete 拦截）。

### 1.2 JSONL 字段（固定 schema）

| 字段 | 类型 | 说明 |
|---|---|---|
| ts | string | ISO 时间戳（毫秒） |
| level | string | DEBUG / INFO / WARNING / ERROR |
| event | string | 事件描述（一句话说清在干嘛） |
| audio | string | 音频路径（处理音频时必填） |
| model | string | 模型 id（如 `iic/emotion2vec_plus_large`） |
| slug | string | 情绪 slug（yasashii 等） |
| kind | string | 来源（ref真人 / 合成A / 合成C） |
| elapsed_s | number | 单段耗时（秒） |
| params | object | 运行参数（granularity / extract_embedding 等） |
| traceback | string | 异常堆栈（仅 ERROR 且 exc_info 时） |

### 1.3 必须打点的节点（缺一不可）

1. **启动**：记录实验名、模型 id、全部运行参数、日志文件路径。
2. **每段音频处理**：开始 / 成功（带 elapsed_s）/ 失败（带 traceback）—— 出问题能定位到具体音频。
3. **关键外部动作**：模型加载、数据下载（含数据集 id、文件数）、重采样。
4. **结束**：汇总（成功 N / 失败 M / 总耗时），并列出失败清单。

### 1.4 错误处理红线

- **任何异常必须 `log.exception()`**（自动带 traceback），**禁止静默 except 吞掉**。
- 单段音频失败**不中断整个批次**：记错误后继续下一段，最后汇总失败清单。
- 脚本退出码：全成功 = 0，有失败 = 非 0（供自动化 / 回溯判断）。

### 1.5 「出问题可查」验收标准

给定任意一次失败运行，能从日志回答：什么时间 / 哪个实验 / 哪个模型 / 什么参数？失败在哪一步（加载 / 下载 / 某段音频 / 降维）？失败的具体音频路径 + 情绪 + 来源？报错与完整堆栈？

---

## 2. 实验 1：embedding 提取 + UMAP

### 2.1 目标

看 6 情绪在 emotion2vec+ 特征空间（embedding）的真实分布：柔软类（温柔/安心/亲密/恳求）与攻击类（嘲讽/毒舌）是否分簇？6 情绪内部谁和谁最近？

### 2.2 输入

- 数据：demo 18 段（`data.json` + `audio/`），6 情绪 × 3 来源（ref真人 / 合成A / 合成C）。
- 模型：`iic/emotion2vec_plus_large`（主），`iic/emotion2vec_plus_base`（可选对照）。

### 2.3 方法 / 步骤

1. `model.generate(input=..., granularity="utterance", extract_embedding=True)` 提取每段 utterance-level embedding。
2. **先探明返回结构**（打日志看 shape）—— emotion2vec+ 的 embedding 返回结构尚未实测，是本实验首要不确定点，见 §5 风险。
3. 向量预处理：先 PCA 降维（如到 50 维，缓解高维直接 UMAP 的数值问题），再 UMAP 降到 2D。
4. 散点图：按真实情绪着色（6 色），形状区分来源（真人/合成A/合成C）。

### 2.4 输出（落 `research/ser/output/`）

- `embedding/emotion2vec_plus_large_embeddings.npz`：18 × d 向量矩阵。
- `embedding/umap_coords.json`：每段 {slug, kind, x, y}。
- `embedding/umap_scatter.png`：散点图（另用交互图内联展示）。

### 2.5 验收标准

- embedding 矩阵 shape 正确落盘（18 段 × 真实维度）。
- 2D 图能直观看出「柔软 vs 攻击」是否分簇，以及 6 情绪两两距离关系。
- 日志含每段耗时 + 返回结构 shape 记录。

---

## 3. 实验 2：英文 baseline 验证

### 3.1 目标

用公开英文数据验证 emotion2vec+ 的 baseline 能力，排除「模型本身有问题」的干扰解释。

### 3.2 输入

- 数据：**RAVDESS**（8 情绪：neutral/calm/happy/sad/angry/fearful/disgusted/surprised，24 说话人，speech 部分 1440 段，48kHz）。CREMA-D 作可选补充（数据量大，本轮先不做）。
- 获取：Hugging Face 直接下载（执行时锁定可用的镜像 id，如 `jonatasgrosman/ravdess`）。

### 3.3 方法 / 步骤

1. 下载 RAVDESS speech 子集，记录文件数（日志）。
2. **重采样 48kHz → 16kHz**（emotion2vec+ 要求 16kHz，本实验首个已知坑）。
3. 情绪标签映射（RAVDESS 8 类 → emotion2vec+ 9 类）：

| RAVDESS | → emotion2vec+ | 备注 |
|---|---|---|
| neutral | neutral | 直接对应 |
| calm | other | 无对应，映射到 other（标注，计分时剔除） |
| happy | happy | 直接对应 |
| sad | sad | 直接对应 |
| angry | angry | 直接对应 |
| fearful | fearful | 直接对应 |
| disgusted | disgusted | 直接对应 |
| surprised | surprised | 直接对应 |

4. 跑 emotion2vec+ 分类，算 **UAR + 准确率 + 混淆矩阵**。
5. 与已知 benchmark 对照（IEMOCAP 4 情绪 emotion2vec ~71.79%），判断量级是否合理。

### 3.4 输出（落 `research/ser/output/`）

- `baseline_ravdess/metrics.json`：UAR / 准确率 / 每类 recall。
- `baseline_ravdess/confusion.json`：混淆矩阵。
- `baseline_ravdess/report.md`：结论（baseline 是否合理 + 与 §5.2 偏置结论的关系）。

### 3.5 验收标准

- 1440 段全部处理完（或明确记录剔除数）。
- UAR / 准确率落盘且与已知 benchmark 同量级 → 判定模型本身能力正常。
- 日志含下载文件数、重采样参数、失败清单。

---

## 4. 环境与依赖

- venv：`research/ser/.venv`（Python 3.11.16，E 盘）。
- 新增依赖：**实验 1** 需 `umap-learn`（含 numba）；**实验 2** 需 `datasets` / `huggingface_hub`（下载）+ `soundfile`（重采样，已装）。
- 装包纪律：仅装进 venv，不碰 C 盘 / GPTSoVits 环境。

---

## 5. 风险与边界

- **实验 1 首要不确定点**：`extract_embedding=True` 的返回结构未实测（可能返回 embedding 数组，也可能是 labels+embedding 混合）。已用日志打点兜底，先探 shape 再降维。
- **实验 2 重采样**：RAVDESS 是 48kHz，必须重采样到 16kHz，否则特征错位。
- **calm → other 映射**：是权宜映射，计分时明确剔除 calm，不夸大。
- **n 小 / 方向性**：18 段（实验 1）和 1440 段（实验 2）都不做因果/显著断言。
- **数据下载走 C 盘缓存**：HF 下载默认缓存 `~/.cache/huggingface`，须用 `HF_HOME` 重定向到 E 盘（对齐既有约束）。

---

## 6. 执行顺序

1. 写 `ser_log.py`（日志基础设施）。
2. 实验 1：探明 embedding API → 装 umap-learn → 写脚本 → 跑 → 出图。
3. 实验 2：锁定 RAVDESS 镜像 → 下载 → 重采样 → 跑分类 → 出报告。
4. 回填 `RESEARCH_PLAN.md` §5.3 + memory。

---

## 7. 勘误（2026-09-21，SER-03 追加；以下不改动上文原始执行历史）

- **§3 实验 2 计分定义有缺陷**：原实现把预测落在 7 个计分类之外的样本（other / `<unk>`）从混淆矩阵丢弃，矩阵总数 1247 ≠ n_scored 1248，recall 分母偏小。正确定义见 `docs/ser/specs/SER-03.md`「计分定义」，规则冻结于 `research/ser/ser_metrics.py`（ser-metrics/2）。
- **校正后指标**：accuracy 0.921474（不变）、UAR(七类) **0.923363**（原 0.9241）、disgusted recall 0.974（原 0.979，v2 分母 +1）；sad 0.849 不变。漏计样本：`03-01-07-01-02-02-07.wav`（disgust → `<unk>`）。
- **重算证据**：`research/ser/output/baseline_ravdess/recomputed_20260920_212308/`（v2 metrics/confusion + 逐样本 samples.jsonl + provenance.json 含原始日志与原 JSON 的 SHA-256）。
- 原始产物 `metrics/confusion_emotion2vec_plus_large.json` 与日志**原样保留**，未覆写。
