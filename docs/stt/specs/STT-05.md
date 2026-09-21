# STT-05 · Whisper 自动语言判定取证与失败归因

## 架构与接口依据

本 SPEC 为**取证类**任务，不修改生产代码；它验证的是 [模块架构与接口](../ARCHITECTURE.md) 中 ASR 阶段在**真实本地引擎**（whisper.cpp）上的行为，而不是适配层契约。取证对象是生产路径的实际调用参数，见下方「已查证的事实」。

需求与边界见 [模块 PRD](../PRD.md)，依赖遵循 [共享契约](../../modules/CONTRACTS.md)。

## 现象与前提

用户报告（[Handoff](../../HANDOFF_MVP_0.5.md) 未结案项）：**说日语，识别出来是中文**。此前只在 [STT-04](STT-04.md) 的「Web Speech 退路」语境下处理过。

STT-04 自己写明了它的覆盖边界——「走 whisper 时 `language: "auto"`，整个问题不存在」——并把「根治」挂靠在本地 whisper 上。**因此 whisper 路径上的同一现象从未被取证**：STT-04 假设 whisper 不会犯这个错，这个假设本身未被验证过。

### 已查证的事实（2026-09-18 本次）

| # | 事实 | 查证方式 |
| --- | --- | --- |
| F1 | 本机 whisper-server **当前未运行**（127.0.0.1:8080/8081/8082 全不可连） | 端口探测 + `GET /` 超时 |
| F2 | 生产调用参数：`POST {endpoint}/inference`，multipart，`language=auto`、`response_format=json`、`temperature=0`、`no_context=true`；探活 `GET /` 超时 800ms | `src/services/voice/whisperClient.ts` |
| F3 | 本机 whisper.cpp 为 **b5130**，路径 `E:\Work\toolchains\whisper-b5130`；**唯一模型是 `models/ggml-base.bin`（141 MB）** | 工具链目录枚举 |
| F4 | 取证素材自带**精确 ground truth**：合成音频说的是我们自己喂给 TTS 的台词，不需要人耳校对即可算 CER | `demo/aika-emotion-demo/data.json` + `build.py` |
| F5 | 本机无 pytest，whisper 侧工具为独立 exe；取证脚本可用任意 Python 运行、不占训练环境 | 环境探测（见 STT-04 报告同期记录） |

### 待验证假设

- **H1 模型规模不足**：`base` 是多语言档里最小的一档，日语识别与语言检测本就弱。这是**当前唯一可用的模型**，即生产实际能力。
- **H2 音频条件**：短句（3~5 s）、情绪化韵律（f0_cv 0.10~0.23）、合成声线（非自然人声）导致语言检测漏判。
- **H3 解码参数**：生产固定 `no_context` 且不送 initial prompt，缺少任何语言先验；`temperature=0` 无回退。

三个假设**互不排斥**，本 SPEC 的目标是把它们分开，而不是先选一个去证明。

## 目标

在不改动任何生产代码的前提下，用可逐条复核的批处理证据回答三个问题：

1. 现行配置下，日语被判成中文的**比例**是多少？（不是「有没有」）
2. `language=auto` 与 `language=ja` 固定的转写结果差多少？差在语言判定还是解码质量？
3. 失败样本与哪些维度相关——**模型规模 / 音频来源（真人 vs 合成）/ 时长 / 情绪**？

产出分两层交付：**证据**（可复核的数据）与**结论**（证据支持的判断 + 明确列出未被证据支持的部分），以及按成本排序的修复建议。**本 SPEC 不含任何生产修改**。

## 范围

| 项 | 内容 |
| --- | --- |
| 新增 | 取证脚本（放 `E:\Work\Chat_model\GPT-SoVITS\tools\stt_probe\`，纯标准库，任何 Python 可跑）；产物与报告 |
| 允许写 | 上述取证目录、`docs/stt/reports/`、`docs/stt/specs/` 内本 SPEC 相关登记 |
| 禁止改 | `aika-crossplatform/src/**` 任何文件（含 `whisperClient.ts`）；`docs/stt/` 以外的模块文档 |
| 依赖 | 本机 whisper.cpp b5130 + base 模型；网络（仅当执行「可选扩展」下载更大模型时，需用户另行确认） |

### 素材

| 组 | 段数 | 来源 | ground truth | 说明 |
| --- | --- | --- | --- | --- |
| R | 6 | `demo/aika-emotion-demo/audio/ref/mood01..06.wav` | 各自 `ref_ja`（互不相同） | **真人**日语（ASMR 授权素材切片） |
| A | 6 | `demo/aika-emotion-demo/audio/A/mood01..06.wav` | 同一句 `target_ja` | 合成：自训 aika v1 声线 |
| C | 6 | `demo/aika-emotion-demo/audio/C/mood01..06.wav` | 同一句 `target_ja` | 合成：底模 zero-shot |
| S | 39 | `GPT-SoVITS/output/slicer_opt/*.wav` | `slicer_opt.list` 的**ASR 产出文本**（非人工校对） | 真人长音频；**仅用于语言判定统计，不用于 CER**；同目录 `output/review_v1.md` 已标 7 条可疑（该目录在仓库外，路径见执行报告） |

R/A/C 共 18 段是主素材：有精确 ground truth，且天然构成「真人 vs 合成」对照。S 组扩样本量，但文本不可当参照。

### 变量与指标

- **自变量**：`language ∈ {auto, ja}`；`model ∈ {base（必做）, 更大模型（可选扩展，需用户确认）}`
- **因变量**：
  - 检测语言与置信度（whisper.cpp 会打印 `auto-detected language: <lang> (p = <p>)`）
  - 判为非 ja 的段数与比例（按素材组分别统计）
  - 转写文本的 CER（对 ground truth，字符级 Levenshtein ÷ 参照长度）
  - 假名字符占比（判别「输出的是不是中文引擎风格」的直接指标）
  - 是否命中 `whisperClient.ts` 的幻听表
- **解码参数对齐生产**：`temperature 0`、`no_context`（cli 侧 `-mc 0`）、beam size 默认。取证必须复现生产条件，否则结论不可用。

### 复现命令（执行时以此为准，路径已核对）

```text
# 语言检测（只探测不转写）
whisper-cli.exe -m models/ggml-base.bin -f <audio> -dl

# 转写（auto / ja 两种）
whisper-cli.exe -m models/ggml-base.bin -f <audio> -l auto -tp 0 -mc 0 -nt -oj -of <out>
whisper-cli.exe -m models/ggml-base.bin -f <audio> -l ja   -tp 0 -mc 0 -nt -oj -of <out>
```

生产路径复现（可选，行有余力时做）：起 `whisper-server.exe`，用与 `whisperClient.transcribe` 完全相同的 multipart 字段发请求，确认 cli 结论与 server 一致。**若两者不一致，以 server 为准并在报告中写明差异。**

## AC

| AC | 验收 |
| --- | --- |
| STT-05-A | 取证脚本零人工介入跑完全部素材（R/A/C 必做，S 可选），退出码 0，产出逐段结构化结果（CSV 或 JSON），每条含：素材标识、组、时长、ground truth、`auto` 检测语言、检测置信度、`auto` 转写、`ja` 转写、CER、假名占比 |
| STT-05-B | 语言判定命中率量化：按组（真人 R / 合成 A / 合成 C）分别给出判为非 ja 的段数与比例，并列出**每一个**判错的样本（不得只报汇总）。**失败样本必须原样保留，不得因「看起来是我方配置问题」而弱化或剔除** |
| STT-05-C | auto 与 ja 差异分解：给出两组转写与 ground truth 的 CER，并区分失败形态——（i）语言判错导致整段变中文风格、（ii）语言判对但解码质量差。两类样本各举实例 |
| STT-05-D | 维度归因：至少就「真人 vs 合成」「时长」「情绪（f0_cv 高的段是否更差）」三个维度给出相关性观察。**观察到相关只写相关，样本量不足以定因果时必须写明** |
| STT-05-E | 结论分层：证据支持的判断、未被证据支持的假设、按成本排序的修复建议（含每条的预期收益与代价）。修复建议不得写成「已修」 |
| STT-05-F | 生产零改动：`git status` / `git diff --stat` 证明执行未触碰 `aika-crossplatform/src/**`；本 SPEC 只新增取证脚本与文档 |
| STT-05-G | 报告落 `docs/stt/reports/STT-05_ACCEPTANCE.md`，并逐 AC 附证据；数值结论必须可追溯到产物文件的具体字段，不允许只在报告里给结论数字 |

每条数值结论须可由产物逐条复核；报告中的每个汇总数字都要能指回原始行的集合。

## 判定规则（防止把观察写成结论）

- **不许**用「合成音频上的结果」直接断言「用户报告的真人场景问题已复现或已解决」。合成素材只给下限/上界估计，外推需真人素材。
- **不许**把「auto 判成 zh」直接等同于「模型坏了」——语言判定与转写质量是两个可分离的失败面（AC-C 分开测）。
- base 模型上的结论**只能**表述为「当前生产配置的表现」；换成更大模型是否解决，属未验证项，除非实际跑了该模型。
- 任何「修好了」的表述一律不允许出现在本 SPEC 产物中。

## 不在本 SPEC

- **修改 `whisperClient` 的参数**（如固定 `language: ja`、送 initial prompt、切换模型）：取证结论出来、修复方向有证据支持后**另立 SPEC**。本 SPEC 不预设结论。
- **换模型并落地**：下载 GGUF 模型（medium / large-v3-turbo 等）属可选扩展，且需用户确认流量与磁盘；落地属新 SPEC。
- **真人麦克风验收**：仍按 [STT-03](STT-03.md) 的 DEFERRED 状态，不自动恢复。
- **Web Speech 退路**：已由 STT-04 覆盖，本 SPEC 不重做。
- **混说识别能力**：不属本 SPEC。

## 为什么这次先取证

用户报告的是「偶发」。在原因未被区分前改参数，等于用猜测替换观测：若真因是模型规模（H1），改 `language` 只会把错误从「中文」移到「英文/韩文」；若真因是音频条件（H2），改参数则毫无作用。取证成本约半天、零风险、不占训练 GPU 窗口，且结论本身即口述/交接材料（方法论：先测量再修复）。

执行与报告规则见 [测试规则](../../modules/TESTING.md)；只跑本模块相关验证，其他模块用 fake。验收报告放 `../reports/STT-05_ACCEPTANCE.md`。
