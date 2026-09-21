# STT-07 · Whisper 更大模型在 GPU 下的延迟与识别质量标定

## 架构与接口依据

本 SPEC 为**取证类**任务，不修改生产代码。它验证 [模块架构与接口](../ARCHITECTURE.md) 中 ASR Provider 运行时后端在**不同模型规模**下的表现：`AsrPort.transcribe` 之下、whisper.cpp 进程之内。适配层契约（`Segment` / `Transcript` / `InputEvent`）与生产 `whisperClient` 不变。

需求与边界见 [模块 PRD](../PRD.md)，依赖遵循 [共享契约](../../modules/CONTRACTS.md)。

**上游依据**：[STT-05](STT-05.md) 已证明质量瓶颈在**解码质量**（真人情绪语音 CER 中位 0.22 vs 合成 0.0），唯一现实杠杆是模型规模；[STT-06](STT-06.md) 已使 GPU 后端可用（base 稳态 85.5 ms，加速 8.9×）并标定预算基线（base 只占 500 ms 工作阈值的 17%，余量约 415 ms）。本 SPEC 承接 STT-06 的 AC-F，把「更大模型能否进预算」从空谈变成可判定事实。

## 现象与前提

STT-05/06 之后，链条只差最后一环：**更大模型在 GPU 下，延迟涨多少、显存涨多少、CER 降多少**。三者此前均无测量数据——STT-06 明确将更大模型标为「未下载、未验证」。

### 已查证的事实（继承 STT-06，不重复取证）

| # | 事实 |
| --- | --- |
| F1 | GPU 后端可用：CUDA 包解在 `E:\Work\toolchains\whisper-b5130-cuda\runtime\Release\`，sm_120 经 `900` PTX 由驱动 JIT，无需源码构建 |
| F2 | base 稳态延迟（jfk 11.0 s，生产字段面，5 次中位）= **85.52 ms**，RTF 0.0078，峰值显存净增 **541 MiB** |
| F3 | CPU 侧约 720 ms 固定开销，GPU 压到 ~70 ms；固定开销与音频时长几乎无关 |
| F4 | JIT 缓存跨进程持久（`%APPDATA%\NVIDIA\ComputeCache`）；首机首次 33.8 s，之后 220 ms |
| F5 | 质量基线（STT-05）：真人 R 组 CER 中位 0.22、合成 A/C 组 0.0；`language=ja` 零收益 |
| F6 | 测量期间禁止训练进程占 GPU（GPT-SoVITS 与 whisper 共用 8 GB） |
| F7 | 生产客户端只依赖 `GET /` 探活 + `POST /inference`（`language=auto`/`response_format=json`/`temperature=0`/`no_context=true`），取 `data.text` |

### 待验证假设

- **H1 质量-规模单调性**：更大模型能否**显著且可重复**地降低真人情绪语音的 CER（相对 base 的 0.22）。这是 STT-05「杠杆是模型规模」这一判断的实证检验——之前它只是一个未验证的方向，不是结论。
- **H2 预算约束**：哪些模型在 GPU 下的稳态延迟 ≤ 500 ms 工作阈值（沿用 STT-06 的假设阈值）。
- **H3 显存约束**：哪些模型的峰值显存可在 8 GB 内与 GPT-SoVITS 共存。

三个假设独立成立与否，都作为事实记录，不做「更好/更差」的越界断言。

## 目标

在 GPU 后端下，对**至少两档**更大模型（量化优先）与 base 做同素材、同请求参数、同测量脚本的对照，产出：

1. **(模型 × 素材) 的延迟 / RTF / 峰值显存矩阵**，落到一句可判定的话：**哪个模型能进预算（≤500 ms 且 ≤8 GB 显存）**。
2. **(模型 × 素材组) 的 CER 对照**（真人 R / 合成 A / 合成 C 分开），落到一句可判定的话：**更大模型是否显著降低真人情绪语音的 CER**。
3. 显存共存建议（与 GPT-SoVITS 的互斥/降级判断，未实测组合标未测，不外推）。

产出分两层：**证据**（可逐条复核的原始数据）与**结论**（证据支持的判断 + 明确列出未被证据支持的部分）。

## 范围

| 项 | 内容 |
| --- | --- |
| 新增 | 更大模型文件（下载到 `E:\Work\toolchains\whisper-b5130\models\`，与 base 并列）；测量/分析脚本（`GPT-SoVITS/tools/stt_probe/`，纯标准库）；产物与报告 |
| 允许写 | 上述模型目录、`GPT-SoVITS/tools/stt_probe/`、`docs/stt/reports/`、`docs/stt/specs/` 内本 SPEC 相关登记 |
| 禁止改 | `aika-crossplatform/src/**` 任何文件（含 `whisperClient.ts`）；`E:\Work\toolchains\whisper-b5130\` 现有文件（含 base 模型与 CPU 运行时）；CUDA 运行时目录 |
| 需用户确认 | 下载哪些模型（组合见下） |
| 依赖 | 现有 base 模型；RTX 5060 + 驱动 581.80；网络仅用于下载 |

### 素材与测试集

沿用 STT-06 口径：

| 组 | 来源 | 用途 |
| --- | --- | --- |
| jfk.wav | `whisper-b5130/jfk.wav`（11.0 s 英文） | 与 STT-06 基线对齐 |
| R | `demo/aika-emotion-demo/audio/ref/mood01..06.wav`（真人日语，精确 ground truth） | **CER 主判据** |
| A | `demo/aika-emotion-demo/audio/A/mood01..06.wav`（合成，自训声线） | CER 对照（合成侧） |
| C | `demo/aika-emotion-demo/audio/C/mood01..06.wav`（合成，底模 zero-shot） | CER 对照（合成侧） |

### 变量与矩阵

- **自变量**：`model ∈ {base（基线，已有）, 更大模型（见下，需确认下载）}`
- **因变量**：单次请求墙钟延迟（冷/热分开）、RTF、峰值显存（`nvidia-smi` 轮询）、转写文本、CER（对 R/A/C 精确 ground truth，复用 STT-05 口径）
- **固定**：与生产一致的请求参数（F7）；同一批素材；同一 CUDA 后端；同一测量脚本
- **重复**：每组合 ≥3 次，报告中位 + 极值，不得用单次值下结论

### 候选模型（体积为 HF 实测值）

| 模型 | 文件大小 | 说明 |
| --- | --- | --- |
| base | 141.1 MB | 已有，基线 |
| small-q5_1 | 181.3 MB | 量化 small，体积接近 base |
| small | 465.0 MB | 4× base，全精度 |
| medium-q5_0 | 514.2 MB | 量化 medium，质量跳跃最大的一档 |
| medium | 1462.7 MB | 11× base，全精度 |
| large-v3-turbo-q5_0 | 547.4 MB | 量化 turbo（809 M 参数、4 层解码器），专为低延迟设计，最可能「又快又准」 |

**推荐组合（供确认）**：`small-q5_1` + `medium-q5_0` + `large-v3-turbo-q5_0`（共约 1.24 GB，覆盖三档，能画出质量-延迟曲线）。

### 复现命令（执行时以此为准）

```text
# GPU 臂（后端已可用，沿用 STT-06）
whisper-server.exe -m <model> --host 127.0.0.1 --port 8081 -l auto -t 6

# 请求侧走生产字段面（F7），由 probe_latency.py 构造 multipart 发出
```

## AC

| AC | 验收 |
| --- | --- |
| STT-07-A | **模型就位**：每个下载模型文件存在、大小与 HF 记录一致、能被 whisper-server 正常加载（启动日志出现对应 model size 行） |
| STT-07-B | **延迟矩阵**：对 base 与每个更大模型，同素材、同参数给出稳态延迟（中位 + 极值）、RTF、估计固定开销，重复 ≥3 次、脚本退出码 0、产物逐段可复核 |
| STT-07-C | **显存**：每个模型给出峰值显存实测值（含采样时的 GPU 占用背景），并明确回答「8 GB 内与 GPT-SoVITS 能否共存」；未实测组合标未测，不外推 |
| STT-07-D | **质量对照**：每个模型对 R/A/C 的 CER（真人/合成分开），并与 base 的 0.22 / 0.0 对齐。CER 变化只作事实记录 |
| STT-07-E | **预算判定**：落到「哪些模型 ≤500 ms 且 ≤8 GB」的可判定结论；超预算的模型给出超出的具体数字 |
| STT-07-F | **零改动**：`git status` / `git diff --stat` 证明未触碰 `aika-crossplatform/src/**`；现有部署与 base 模型校验和不变 |
| STT-07-G | 报告落 `docs/stt/reports/STT-07_ACCEPTANCE.md`，逐 AC 附证据；每个汇总数字都能指回产物文件的具体字段 |

## 判定规则（防止把观察写成结论）

- **不得**把「更大模型 CER 下降」写成「识别问题已解决」。只有真人 R 组的 CER 出现**实质且可重复**的下降，才可表述为「模型规模对真人情绪语音的解码质量有改善」，且必须给出幅度与样本量。
- **不得**声称「换模型提升准确率」——本 SPEC 只记录 CER 事实与预算事实，不替代真机验收。
- 单次测量不作结论；显存与延迟数字必须注明当时的 GPU 占用背景（F6）。
- 预算阈值沿用 STT-06 的「ASR 单次调用 ≤500 ms」工作阈值假设（来源：为 INT-02 首句 1.5 s 预算留余量），最终以 INT-02 实测为准并在报告中写明该假设。
- base 上的结论只能表述为「当前生产配置的表现」；更大模型结论只针对已实测的模型，未下载的模型标未验证。

## 不在本 SPEC

- **修改 `whisperClient.ts`**（模型选择、超时、参数面）：矩阵出来后的修复方向另立 SPEC。
- **把更大模型设为生产默认**：需矩阵 + 用户决策，另立 SPEC。
- **源码构建 CUDA 版**、**真人麦克风验收**（STT-03 DEFERRED）、**Web Speech 退路**（STT-04）：均不在本 SPEC。
- **全精度 small/medium**（465 MB / 1462.7 MB）：量化版优先；仅当量化版结论不明确且用户确认时才下载。

## 为什么现在做

STT-05 说「杠杆是模型规模」——但那是一个**未验证的方向**；STT-06 说「GPU 余量 415 ms」——但那是一个**未被使用的余量**。本 SPEC 用一次下载 + 一轮测量，把这两个悬空的判断接成一句可证伪的话。代价上界清楚：≤1.3 GB 下载 + 一轮测量，不动生产代码、不动现有部署。

执行与报告规则见 [测试规则](../../modules/TESTING.md)；只跑本模块相关验证，其他模块用 fake。验收报告放 `../reports/STT-07_ACCEPTANCE.md`。
