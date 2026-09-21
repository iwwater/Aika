# Aika 语音情感识别（SER）研究计划

> 承接 `SPEC_SER-01.md`（方向已定：纯语音 + 日语主攻）。
> 本计划回答「怎么一步步做出来」，面向 2027-01 中旬日本大学院口述考试。
> 创建：2026-09-20 · 状态：执行中

---

## 0. 目标与时间线

**终极交付**：一份可答辩的研究陈述 —— 证明「日语语音的情绪可以从纯韵律/音色特征中识别出来，且我清楚哪些特征、为什么、证据是什么」。

| 阶段 | 时间 | 目标 | 产出 |
|---|---|---|---|
| M0 | 09 下旬（本周） | 环境 + 特征可区分性 POC | 特征↔情绪对应表（初版）+ 可区分性证据 |
| M1 | 10 月 | eGeMAPS 基线 + 可解释分析（RQ1） | 正式基线 + 特征消融 |
| M2 | 11 月 | 自监督方法（RQ4：HuBERT/emotion2vec） | SSL vs 手工特征对照 |
| M3 | 12 月 | 词义隔离实验（RQ2/RQ3） | 「靠语气而非词义」的证据链 |
| M4 | 2027-01 上旬 | 材料合成 + 口述排练 | 陈述稿 + 试听包 + 想定问答 |

---

## 1. 数据策略（不申请路线，2026-09-20 定）

### 1.1 核心现实：零申请、即下即用的日语情绪语音数据「基本不存在」

用户明确：不申请（作者邮件 / NII IDR 表单都太耗时）。查证结论——日语情绪语音数据**全线都要申请**：

- JTES / OGVC / Keio-ESD / MELD-ST → 向作者发邮件或走 NII IDR 申请表单；
- STUDIES / STUDIES-2（东大高道研，免费）→ 仍要填 NII IDR 表单（免费但审批）；
- Qlean（Visual Bank，2026-08 rights-cleared）→ 新闻稿提到日语情绪对话数据，但 HF 公开列表尚未直接可见，暂不能「即下即用」。

**但「不申请也能干」** —— 走三条零门槛路线（1.3）。

### 1.2 核心红线（不变，与申请无关）

**合成语音不能当训练数据**：SER 学的是「真人情绪 → 声学特征」映射，用 TTS 合成情绪训练 = 学到合成器情绪指纹，对真人 distribution shift 崩塌（文献里合成只做 augmentation，从不替代真人）。

**GPT-SoVITS 声线的正确位置（两处工具，非训练数据）**：① RQ3 词义隔离实验（受控生成「同句×6情绪」）② 应用落地闭环（SER 感知 → TTS 用对应情绪回应）。

### 1.3 「不申请」三条路 + 一条辅助线

| 路线 | 数据/工具 | 获取 | 用途 |
|---|---|---|---|
| **A 预训练模型（主力）** | emotion2vec+（9 类情绪，ACL 2024，FunASR） | HF/ModelScope 直接下，零申请 | zero-shot 日语情绪识别 + 强 baseline |
| **B 公开英语数据** | RAVDESS / CREMA-D / TESS | HF 直接下，零申请 | 训练自己的 SER，方法成熟后迁移日语 |
| **C 自建素材** | 用户 ASMR 情感切片（7 mood） | 已有（真实日语情绪化） | 真实日语评测集 + emotion2vec+ few-shot 微调 |
| **D 合成受控（辅助）** | demo A/C 组（同句×6情绪） | 已有 | RQ3 词义隔离实验（非训练） |

### 1.4 这条路的科研叙事（面试亮点，比「用现成数据集」更高级）

因为**日语标注情绪数据稀缺（全要申请）**，「用预训练模型 + 少样本真实日语情绪数据」做情绪识别，本身就是日语 SER 空白里的一个可讲贡献：

- emotion2vec+ 在真实日语情绪化语音（ASMR）上到底好不好用？—— 没人系统评过，这是你的**评测贡献**；
- 用公开英语数据训练 + 日语少样本适配，验证「情绪线索跨语言通用」—— 呼应 SPEC 的跨语言泛化 RQ。

### 1.5 关键约束（诚实）

- ASMR 素材量小（7 mood），只能做方向性评测 + few-shot，不能做大规模训练结论。
- emotion2vec+ 是预训练模型，用它做的是「评估 / 适配」，**不是从零训练自己的模型**——面试时要说清这个边界。
- 若将来要「训练自己的日语 SER」，仍绕不开带标签真人数据（申请 or 自建），那是 M2+ 的事，不在当前时间预算内。

---

## 2. 环境与工具

- **独立 Python 环境**（不污染 GPTSoVits 训练环境，避免重蹈 torch 被换的覆辙）。
- ✅ **已建**：`research/ser/.venv`（Python 3.11.16，E 盘，不碰 C 盘/GPTSoVits）+ `torch 2.11.0+cu128`（CUDA 可用，RTX 5060）+ `funasr 1.4.16` + `modelscope 1.40.1`。模型缓存已重定向到 `research/ser/.cache/`（E 盘，用户要求不装 C 盘）。
- M0 用 `librosa`（F0/能量/MFCC）+ `numpy/scipy`。
- M1 加 `opensmile`（eGeMAPS 88 维，业界标准特征）。
- M2 加 `transformers`（HuBERT/emotion2vec）+ `torch`（CUDA）—— 后两者 M0 已提前装好。

---

## 3. 本周第一批任务（M0，立即执行）

1. **特征提取脚本** `tools/ser_probe/ser_probe_features.py`：对 demo 6 情绪音频提取可解释韵律特征（F0 均值/变异系数/半音跨度、能量动态、语速、频谱质心、jitter/shimmer 近似）。
2. **可区分性分析**：验证「同情绪不同声线（A/C）特征接近、异情绪特征远离」—— 情绪可区分性的直接证据。
3. **产出** `output/ser_probe/`：特征矩阵 JSON + 可区分性报告 + 特征↔情绪对应表初版。

---

## 4. 风险

- JTES 授权延迟 → M1 依赖它，若卡住则 M1 用自建素材暂代（量小，仅方向性）。
- 自建素材 M1 硬阻塞（等 ≥10 分钟授权）→ 不影响 M0，影响 M3 的真人验证。
- 合成语音 POC 结果 ≠ 真人结论 → 全程标注「合成 vs 真人」边界，不夸大。

---

## 5. M0 实证进展（2026-09-20 更新）

### 5.1 emotion2vec+ zero-shot 首测（18 段，真人 + 合成混测）

**评测对象**：`iic/emotion2vec_plus_base`（~90M，4788h finetune，9 类：angry / disgusted / fearful / happy / neutral / other / sad / surprised / unknown）。数据 = demo 18 段（6 情绪 × 3 来源：ref 真人 / 自训A / 底模C）。脚本 `research/ser/ser_emotion2vec_probe.py`，产物 `research/ser/output/emotion2vec_probe.json`。

**核心结果（方向性观察，n=18）**：

| 真实情绪 | emotion2vec+ 预测（置信度） |
|---|---|
| 温柔 / 安心 / 亲密 / 恳求 | **fearful**（0.966 ~ 1.00） |
| 嘲讽 / 毒舌 | **surprised**（0.889 ~ 1.00；毒舌真人段另带 disgusted 0.33） |

**三条结论**：

1. **纯语音情绪区分可行（RQ2 正证据，观察）**：模型输入只有 16kHz 波形、**不接收转写文本**，却把 18 段干净分成「柔软类 → fearful」与「攻击类 → surprised/disgusted」两簇 —— 韵律/音色确实携带可区分的情绪信息，这是「语气 → 情绪」可行性的直接证据。**边界（SER-03 校正）**：不接收文本输入 ≠ 已隔离词义——波形本身携带语义信息（模型可从音位/词形线索间接获取语义），本实验不能冒充「已隔离全部词义」；严格的内容-语气隔离留待 RQ3。

2. **现成 SOTA 对日语娇柔声线有系统偏差（研究空白实证）**：把「温柔/亲密/恳求」这类示弱、撒娇、气声的女声声线统一判成「恐惧」，把「嘲讽/毒舌」判成「吃惊」。emotion2vec+ 用英语/普通话数据训练，其「fearful」学到的声学特征（高音、气声、示弱）与日语女性娇柔声线高度重叠。这正是「日语 SER 空白」的第一手证据，也是本研究的切入贡献点 —— 直接支撑 1.4 节「预训练模型在真实日语上到底好不好用」的评测命题。

3. **真人 vs 合成在 emotion2vec+ 分类输出上不可分（观察）**：同一情绪下 ref/A/C 三组预测几乎一致（都接近 1.0）—— 自训声线在**分类标签层面**与真人一致。边界：top1 标签一致不能证明 embedding 特征空间不可分（5.3 的 UMAP 显示真人嘲讽与合成嘲讽在空间中分离）；也不能由此推断合成数据可作训练监督。

**局限**：n=18、单模型（base）、CPU 推理（单段 0.03~0.05s，RTF ~0.009，实时可用）。

### 5.2 emotion2vec+ large 对照（base 90M/4788h vs large 300M/42526h）

> **SER-03 校正**：base 与 large **同时**改变了参数容量与训练数据规模/构成，本节是「换用更大模型的对照观察」，**不是单变量控制实验**——不能把预测差异归因于「规模」或「数据量」单一因素。

**动机**：5.1 的「fearful 垄断」是 base 独有，还是与模型训练总量相关？换 large 重测同一批 18 段（同架构、同标签集 9 类）。脚本同 `ser_emotion2vec_probe.py --model iic/emotion2vec_plus_large`，对比脚本 `ser_compare_base_large.py`。

**结果（top1 预测，6 情绪 × 3 来源）**：

| 情绪 | base（90M/4788h） | large（300M/42526h） |
|---|---|---|
| 温柔 | fearful ×3 | happy(真人0.99) / surprised(合成C) / **unk**(合成A 0.82) |
| 安心 | fearful ×3 | surprised ×3 |
| 亲密 | fearful ×3 | surprised ×3 |
| 恳求 | fearful ×3 | **fearful ×3（稳定）** |
| 嘲讽 | surprised ×3 | surprised / happy 混合 |
| 毒舌 | surprised ×3 | **angry(真人0.62)** / surprised(合成) |

**四条结论（观察；5.2 校正后不再称「控制变量实验」）**：

1. **柔软类「fearful 垄断」从 base 的 12/12 降到 large 的 3/12（只剩恳求）**——与 large 的训练数据规模/多样性更大一致（观察），但因 base/large 同时改变容量与数据，不归因于单一变量。方向上支撑「日语数据稀缺 = 研究空白」的立项动机（假设，待 M2+ 验证）。

2. **恳求→fearful 在两模型、三来源上稳定一致（观察）**——哀求/示弱的「音高下坠 + 气声 + 低能量」在英/日语料中可能共有（假设）。「跨语言普适」是待验证解释，n=18 的稳定性本身不能证明跨语言普适。

3. **毒舌真人段被 large 正确修正**（surprised→angry 0.62）：毒舌是攻击性情绪，angry 比 surprised 更对；而合成毒舌仍 surprised——large 能捕捉真人攻击性，却对合成语音的「夸张/变形」情绪印记不买账。既证 large 更准，又旁证「合成 ≠ 真人」的分布差异。

4. **反讽（嘲讽）两个模型都做不好**：surprised/happy 混乱——讽刺语音与词义冲突、纯韵律线索弱，是 SER 公认难点，也正是「日语反讽情绪识别」的切入贡献点。

**新增技术事实**：① large 标签集与 base 完全一致（9 类，tokens.txt 相同）——HuggingFace 某 README 称 large 为 5 类是**过时错误信息**；② large 首次出现 `<unk>`（合成A 温柔 0.82），是模型「低置信→未知」的诚实信号，反衬 base 对未知样本的「盲目自信 fearful 1.00」。

**局限与下一步**：n=18、方向性观察，不做因果断言。待做：`extract_embedding=True` 提 embedding 做 UMAP 看 6 情绪真实分布；RAVDESS/CREMA-D 英文验证 baseline 能力（排除模型本身问题）。

### 5.3 实验 1：embedding + UMAP（按 SPEC_SER-02 执行，2026-09-20 完成）

**执行**：SPEC 先行（`SPEC_SER-02.md`，含日志规范）→ `ser_log.py` 统一结构化日志 → `ser_embedding_umap.py` 跑通。18 段全部成功，embedding 维度 **1024**（large）；PCA 1024→17（累计方差 1.000，n=18 上限）→ UMAP 2D（random_state=42 可复现）。产物在 `research/ser/output/embedding/`，日志在 `output/logs/`（JSONL，每段 shape+耗时打点）。

**四条发现（上图，观察；SER-03 校正：单次 UMAP 二维布局受随机态与降维失真影响，不能证明原空间距离或因果来源）**：

1. **亲密是唯一三来源聚簇的情绪**：ref/A/C 三点在右上角紧聚（x≈2.8~3.4），与 5.2 分类实验「亲密 3/3 稳定判 surprised」方向一致 —— 亲密的声学表现在真人/合成间较一致（观察）。

2. **真人嘲讽混进亲密簇，合成嘲讽在别处**：hiniku 真人段落在亲密簇内，而合成 A/C 落在左下 —— 真人与合成的嘲讽在 embedding 空间的 2D 投影上分离（观察）。这是「合成 ≠ 真人」的一个分布线索，但单次二维布局不能证明原空间可分性，更非因果证明。

3. **毒舌三来源最分散**：真人段在左下角、合成段在中部 —— 与 5.2 毒舌标签摇摆（surprised/disgusted/angry）呼应，毒舌是 6 mood 里最不稳定的情绪。

4. **整体分布紧凑**：18 点聚集在很小坐标范围内 —— 所有语音共享 emotion2vec 的「语音底座」表征，情绪差异是局部变化。**柔软类与攻击类在 embedding 空间没有形成清晰的情绪簇**，再次佐证「现成模型对日语娇柔声线的表征区分度不足 = 研究空白」。

**技术事实（勿重复踩）**：`extract_embedding=True` 时 `model.generate()` 返回 dict 多一个 `feats` 字段（utterance 粒度 = `np.mean(feats, axis=0)` 时间均值），large 维度 1024；matplotlib 默认字体无中文，图例须用英文标签（已修）。n=18 是 UMAP 探索性下限，不做因果断言。

### 5.4 实验 2：RAVDESS 英文 baseline（按 SPEC_SER-02 §3 执行，2026-09-20 完成）

**目的**：用公开英文数据验证 emotion2vec+ baseline 能力，排除「模型本身有问题」这个干扰解释。

**执行**：`ser_download_ravdess.py`（requests 直连下载 1440 段 speech，绕开 hf_hub hf_xet 0 字节 bug）→ `ser_ravdess_baseline.py`（48k→16k 重采样 + large zero-shot + `calm`→`other` 计分剔除）。产物 `output/baseline_ravdess/{metrics,confusion}_emotion2vec_plus_large.json` + `report.md`。

**结果（1440 段全成功，剔除 calm 后七类计分 1248 段；2026-09-21 SER-03 校正后数值）**：

| 指标 | v2 校正后 | 原报告值 |
|---|---|---|
| **准确率** | **0.9215** | 0.9215（不变：分母本就含未知预测） |
| **UAR（七类）** | **0.9234** | ~~0.9241~~（漏计 1 条 `<unk>` 预测） |
| 每类 recall | disgusted **0.974（原 0.979，v2 分母 +1）** / angry 0.974 / neutral 0.948 / happy 0.932 / surprised 0.917 / fearful 0.870 / sad 0.849（最弱，不变） | disgusted 0.979 |

> **勘误（SER-03，2026-09-21）**：原计分把预测为 `other/<unk>` 的样本从混淆矩阵丢弃（矩阵总数 1247 ≠ n_scored 1248），致 recall 分母偏小。漏计样本：`03-01-07-01-02-02-07.wav`（disgust → `<unk>`）。修复后按七类 × 九预测类重算，全部产物与逐样本证据见 `output/baseline_ravdess/recomputed_20260920_212308/`（含 provenance 与 SHA-256）。计分规则冻结在 `research/ser/ser_metrics.py`（ser-metrics/2）。

主要混淆均为相邻情绪（sad→neutral 16、fearful→sad 10、surprised→disgusted 6、happy→neutral 6）。

**结论（按 SER-03 校正后表述）**：

1. **模型能力正常（观察）**：英文 RAVDESS 剔除 calm 后**七类**计分 92% 准确。注意：与 emotion2vec 论文 IEMOCAP 4 类 71.79% **不构成直接排名**——数据集、类别数与评测协议均不同，只作能力量级参照。它支持的推断是「模型在英文 acted 语音上工作正常」，从而 5.1 的「日语娇柔声线判 fearful」更可能是语言/文化分布偏置（假设），而非模型缺陷。
2. **sad 是相对最弱类（0.845，观察）**：与 fearful/neutral 声学邻近，跨语料成立（呼应 5.2 恳求→fearful 稳定映射）。
3. 边界：acted 语音仅作 sanity check，不迁移日语自然语音；本指标不用于与其他模型/论文排名比较。

**技术事实（勿重复踩）**：
- **hf_hub 的 hf_xet 库在本机下载 xet 存储文件生成 0 字节**（TwinkStart parquet / MahiA wav 两镜像均复现，禁用 `HF_HUB_DISABLE_XET` 无效），requests 直连 xet-bridge CDN 正常 → 绕开 hf_hub 用 requests 下载。RAVDESS 用 `MahiA/RAVDESS`（文件名保留 7-part 命名，part2=声道、part3=情绪）。
- **large 的 tokens.txt 是「中文/英文」格式**（`生气/angry`…`<unk>`），base 是纯英文（`angry`…`unknown`）→ 用 large 的 labels 做字符串比较前必须归一化（取 `/` 后英文部分），否则 target==pred 全错（首跑准确率 0.0000 即此 bug）。
- **ser venv 用 GPTSoVits 的 conda python 创建**，标准库 `_lzma` 依赖 base conda 的 `liblzma.dll` → 需 `os.add_dll_directory(r"D:\ANACONDA\Library\bin")`（已固化进 `ser_log.py` 一处修复全局受益）。
