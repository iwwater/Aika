# STT-08 · 更大模型落地为生产默认 + 显存共存实测

状态：READY（部署切换与契约复跑可自动验收；显存共存为实测项）。
需求来源：[STT-07](STT-07.md) 的「不在本 SPEC」两条：修改 `whisperClient`（模型选择/超时/参数面）与「把更大模型设为生产默认」均需矩阵 + 用户决策后另立 SPEC。执行规则：[安全执行计划](../../GOAL_EXECUTION_PLAN.md)。

## 前置与范围

- 前置：STT-07 已产出完整 (模型 × 延迟 × 显存 × CER) 矩阵，结论 **large-v3-turbo-q5_0 是甜点**（jfk 稳态 215.95 ms，比 medium 快 29%；真人 CER 0.0794，-64%；547 MB；显存净增 1024 MiB）。四档模型全部进「≤500 ms 且 ≤8 GB」预算。
- 本 SPEC 把该结论落地：将生产 whisper-server 从 CPU + base 切到 CUDA + large-v3-turbo-q5_0，并实测它与 GPT-SoVITS 在 8 GB 显存下能否共存——这是「实时对话集成」的前置（INT-02 依赖）。
- 修改范围：部署侧启动脚本（`E:\Work\toolchains\whisper-b5130\Start-Whisper.ps1`，去 `-ng`、exe 指向 CUDA 目录、模型换 turbo）；客户端侧仅在确需「模型可配置化」时改 `whisperClient.ts`（MVP 不做模型选择 UI，默认模型在服务端启动参数，客户端不感知）。不动现有 CPU 部署、不动 base 模型、不动 CUDA 运行时目录（保留可回退）。
- 非目标：真人麦克风验收（STT-03 DEFERRED）、Web Speech 退路（STT-04）、流式 ASR 改造（TODO-10）、全精度模型。

## 已查证的事实（继承 STT-06/07，不重复取证）

| # | 事实 |
| --- | --- |
| F1 | CUDA 运行时已就位：`E:\Work\toolchains\whisper-b5130-cuda\runtime\Release\`，sm_120 经 `900` PTX 由驱动 JIT，无需源码构建 |
| F2 | large-v3-turbo-q5_0 已下载：`E:\Work\toolchains\whisper-b5130\models\ggml-large-v3-turbo-q5_0.bin`（547.4 MB），AC-A 已证可加载且 CUDA 后端生效 |
| F3 | turbo 稳态（jfk 11.0 s，生产字段面，5 次中位）215.95 ms，RTF 低；显存净增 1024 MiB |
| F4 | 首次调用 33.8 s PTX JIT，缓存命中后 220 ms，缓存落 `%APPDATA%\NVIDIA\ComputeCache`，跨进程持久 |
| F5 | 生产启动现状：`Start-Whisper.ps1` 硬编码 `-ng`（CPU），模型 `ggml-base.bin`，端口 8080 |
| F6 | 生产客户端只依赖 `GET /` 探活 + `POST /inference`（`language=auto`/`response_format=json`/`temperature=0`/`no_context=true`），取 `data.text`；模型选择在服务端，客户端不感知 |
| F7 | whisper 侧显存净增最大 1024 MiB（turbo）；GPT-SoVITS 推理 fp16 约 3 GB（PLAN 风险表估计值，未实测） |

### 待验证假设

- **H1 部署切换零回归**：CUDA + turbo 下，生产客户端契约（探活 + 转写 + 延迟）复跑通过，文本质量不低于 base（STT-07 已证 CER 更低，此处只确认链路连通与延迟，不重复 CER 全量）。
- **H2 显存共存**：whisper(turbo) 与 GPT-SoVITS 同时加载推理，8 GB 内是否 OOM；若共存，记录峰值显存；若不共存，给出降级方案（TTS 常驻、whisper 按需加载，或反之）。
- **H3 首次 JIT 可管理**：换机/清缓存后的 33.8 s 首次成本能被部署文档 + 预热步骤消化，不表现为「服务起来了但第一次说话卡半分钟」。

## 目标

1. **部署切换**：`Start-Whisper.ps1` 去 `-ng`、exe 指向 CUDA 目录、模型换 `ggml-large-v3-turbo-q5_0.bin`；启动日志出现 `using CUDA0 backend` + turbo model size，探活 200。
2. **契约复跑**：用真实 `createWhisperClient`（生产字段面）对 turbo 服务复跑，探活延迟、转写延迟中位、文本稳定。
3. **显存共存实测**：whisper(turbo) + GPT-SoVITS 同跑，`nvidia-smi` 记录峰值显存与 OOM 与否，落到一句可判定的话：**能否共存**。
4. **首次 JIT 处理**：部署文档写明首次调用 33.8 s 现象、缓存位置、预热步骤（可选的启动即 warm 一次）。

## 范围

| 项 | 内容 |
| --- | --- |
| 允许写 | `E:\Work\toolchains\whisper-b5130\Start-Whisper.ps1`（部署脚本）；`docs/stt/reports/`、`docs/stt/specs/` 内本 SPEC 相关登记；`docs/stt/further/` 部署说明（JIT 预热） |
| 允许改（如确需） | `aika-crossplatform/src/services/voice/whisperClient.ts`（仅「模型可配置化」一类改动，MVP 默认不改；若改须在报告单列 diff 与理由） |
| 禁止改 | 现有 CPU 部署文件（`whisper-b5130\runtime\Release\`）；base 模型；CUDA 运行时目录；`aika-crossplatform/src/**` 其他文件 |
| 依赖 | CUDA 运行时 + turbo 模型（均已就位）；GPT-SoVITS 环境（`D:\ANACONDA\envs\GPTSoVits`）用于共存实测；RTX 5060 8 GB |

### 复现命令（执行时以此为准）

```text
# 生产切换后（去 -ng，指向 CUDA 目录，模型换 turbo）
E:\Work\toolchains\whisper-b5130-cuda\runtime\Release\whisper-server.exe \
  -m E:/Work/toolchains/whisper-b5130/models/ggml-large-v3-turbo-q5_0.bin \
  --host 127.0.0.1 --port 8080 -l auto -t 6

# 契约复跑（生产客户端，真实 fetch）
cd aika-crossplatform && STT08_ENDPOINT=http://127.0.0.1:8080 STT08_REPEATS=5 \
  npx vitest run tmp/whisperLocal.device.test.ts
```

## AC

| AC | 验收 |
| --- | --- |
| STT-08-A | **部署切换生效**：启动脚本去 `-ng`、指向 CUDA 目录、模型换 turbo；启动日志出现 `using CUDA0 backend` + turbo model size 行；探活 200 |
| STT-08-B | **显存共存实测**：whisper(turbo) + GPT-SoVITS 同时加载推理，给出峰值显存实测值（含采样背景）与是否 OOM；不共存则给出降级方案。未实测的组合标未测，不外推 |
| STT-08-C | **契约复跑**：真实 `createWhisperClient` 对 turbo 服务复跑，探活 + 转写 + 延迟中位（生产字段面，重复 ≥3 次），文本稳定 |
| STT-08-D | **首次 JIT 处理**：部署文档写明首次调用 33.8 s 现象、缓存位置（`%APPDATA%\NVIDIA\ComputeCache`）、预热步骤；文档能解释「服务起来了但第一次说话卡半分钟」 |
| STT-08-E | **零改动边界**：`git status` 证明未触碰 `aika-crossplatform/src/**`（若有 whisperClient 改动则单列 diff）；现有 CPU 部署与 base 模型校验和不变，可回退 |

## 判定规则

- **不得**声称「换模型提升准确率」——STT-07 已证 CER 下降是**方向性观察**（n=6），本 SPEC 只确认链路连通与延迟，不重提准确率。
- **不得**把显存共存「估计值」当实测——PLAN 里 GPT-SoVITS ~3 GB 是估计，必须实测。
- 单次测量不作结论；延迟与显存数字必须注明当时的 GPU 占用背景。
- 预算阈值沿用 STT-06 的「ASR 单次调用 ≤500 ms」工作阈值假设，最终以 INT-02 实测为准。

## 不在本 SPEC

- **CER 全量复测**（STT-07 已做，n=6 方向性结论）；**真人麦克风验收**（STT-03）；**Web Speech 退路**（STT-04）；**流式 ASR 改造**（TODO-10）；**模型选择 UI**（MVP 不做，服务端 `-m` 决定）；**源码构建**。

## 为什么现在做

STT-07 已经证明 turbo 是「又快又准」的甜点，但那是**取证环境**的结论。本 SPEC 把它搬进生产部署，并回答最后一个前置问题——whisper 与 GPT-SoVITS 在 8 GB 里能否共存。代价上界清楚：改一个启动脚本 + 一轮实测，不动生产代码、保留完整回退。

执行与报告规则见 [测试规则](../../modules/TESTING.md)。验收报告放 `../reports/STT-08_ACCEPTANCE.md`。
