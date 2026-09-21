# STT-06 · Whisper 推理后端切换（CPU → CUDA）与延迟预算标定

## 架构与接口依据

本 SPEC 针对 [模块架构与接口](../ARCHITECTURE.md) 中 **ASR Provider 的运行时后端**：`AsrPort.transcribe` 之下、whisper.cpp 进程之内。适配层契约（`Segment` / `Transcript` / `InputEvent`）不变，生产 `whisperClient` 不变。

需求与边界见 [模块 PRD](../PRD.md)，依赖遵循 [共享契约](../../modules/CONTRACTS.md)。

**上游依据**：[STT-05](STT-05.md) 已给出识别质量基线，并明确「换模型/改后端属新 SPEC」。本 SPEC 承接其结论 E 的修复方向 #3（先让 whisper 走 GPU，再评估换模型）。

## 现象与前提

STT-05 取证结论：57 段素材**判成中文 0 段**，但真人情绪化语音的解码质量是真瓶颈——**CER 中位 0.22（真人）vs 0.0（合成），22 倍差，真人 0/6 全对**。当时给出的修复方向是「先让 whisper 走 GPU，再评估换模型」。

理由链条是：**质量瓶颈 → 唯一杠杆是模型规模 → 更大模型在 CPU 上会吃掉延迟预算 → 所以必须先解决后端**。而这条链的最后一环此前**没有任何测量数据**（见 F9）。

同时存在一个明确的**意图与部署不一致**（F4）：客户端选型时写明理由是「官方预编译包带 cuBLAS，装个驱动就能用 GPU」，但实际部署的是 CPU 包且启动脚本硬编码 `-ng`。

### 已查证的事实（2026-09-18 本次）

| # | 事实 | 查证方式 |
| --- | --- | --- |
| F1 | 现有部署是**纯 CPU 构建**：`runtime\Release\` 只有 `ggml-cpu-*.dll`（8 个变体）+ `ggml-base.dll`，**无 `ggml-cuda.dll`、无 cudart/cublas** | 目录枚举 + 原包 zip 清单 |
| F2 | 该包来自 release **b5130** 的 CPU 资产 `whisper-bin-x64.zip`（8.2 MB，SHA256 `f9ec6c52…`） | [配置记录](../reports/LOCAL_WHISPER_SETUP_20260917.md) |
| F3 | **同一 release 提供 CUDA 资产**：`whisper-cublas-12.4.0-bin-x64.zip`（**643.3 MB**，下载量 2082）、`whisper-cublas-11.8.0-bin-x64.zip`（260.3 MB）。即**换包即可，无需自建**；x64 上 12.4.0 是最新的 CUDA 预编译版本 | GitHub Releases API（`tags/b5130`，published 2026-09-11） |
| F4 | 启动脚本硬编码 `-ng`（`Start-Whisper.ps1` L9）；而客户端注释写明选它的理由正是「官方预编译包带 cuBLAS，装个驱动就能用 GPU」（`whisperClient.ts` L8-9）→ **设计意图是 GPU，部署成了 CPU** | 两文件原文 |
| F5 | 运行时自报 `use gpu = 1` / `flash attn = 1` / `devices = 1` / `backends = 1`，随即 `whisper_backend_init_gpu: no GPU found` → 二进制含 GPU 代码路径但无 CUDA 后端可加载 | `whisper-cli` stderr |
| F6 | 本机 GPU：**RTX 5060（Blackwell）**，8151 MiB，驱动 **581.80**（支持 CUDA 13.x）；**未安装 CUDA Toolkit**（无 `nvcc`、无 `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA`） | `nvidia-smi` + 目录枚举 |
| F7 | 上游 CI **未指定** `CMAKE_CUDA_ARCHITECTURES` 且 `GGML_NATIVE=OFF` → 走 ggml 默认列表。CUDA 12.4 包覆盖 `50/61/70-virtual`、`75/80-virtual`、`86-real`、`89-real`、`90-virtual`——**不含 sm_120**（`120a-real` 需 CUDA ≥ 12.8，见该文件 L40-51） | `release.yml` L494-504 + `ggml/src/ggml-cuda/CMakeLists.txt` L27-55 |
| F8 | 该构建启用 `GGML_BACKEND_DL=ON` → 后端是**可动态加载的独立 DLL**，CPU 变体与 CUDA 可并存 | `release.yml` L501 |
| F9 | STT-05 产物**无任何计时字段**（`server_results.json` 字段列表已核）→ 现行延迟**没有基线**。全仓仅有的一个延迟数据点是 jfk.wav 的**单次** `elapsedMs = 888.28`（11.0 s 英文） | STT-05 产物 + `evidence/LOCAL_WHISPER_20260917.json` |
| F10 | 训练与推理共用同一块 8 GB GPU（GPT-SoVITS 走 conda env `GPTSoVits`）；显存是本 SPEC 的硬约束 | 既有环境记录 |
| F11 | 生产客户端只依赖两点：`GET /` 探活（超时 800 ms）、`POST /inference` multipart（`file`/`language=auto`/`response_format=json`/`temperature=0`/`no_context=true`）→ 取 `data.text` | `whisperClient.ts` L74-133 |
| F12 | 已有可复用的生产契约 harness：`aika-crossplatform/tmp/whisperLocal.device.test.ts`，真实调用 `createWhisperClient`、真实 Node fetch，并落 `elapsedMs` 证据 | 文件在库（1.9 KB） |

### 待验证假设

- **H1 后端可用性（最高风险，必须先测）**：F7 表明预编译 CUDA 包**没有 sm_120 的 SASS**，唯一可行路径是 **`90-virtual` PTX 由驱动 581.80 在首次运行时 JIT 到 sm_120**。若该路径不成立（`cudaErrorNoKernelImageForDevice`）或 cuBLAS 12.4 缺 Blackwell kernel，则**预编译包不可用**，唯一出路是源码构建 `-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120`——而本机**既无 MSVC 也无 CUDA Toolkit ≥12.8**（F6），成本量级完全不同。**这是本 SPEC 的可行性门，必须在任何下载投入之前判定。**
- **H2 收益幅度**：GPU 相对 CPU 的后端加速倍数，以及该倍数是否足以把更大模型拉进预算。
- **H3 显存共存**：whisper(GPU) 与 GPT-SoVITS 能否在 8 GB 内共存；不能则需互斥/降级策略。
- **H4 CPU 侧剩余空间**：当前仅用 `-t 6`（本机 20 线程，F5 自报 `n_threads = 4 / 20`），CPU 本身可能还有未开采的余量，属零成本对照臂。

## 目标

1. **量化现行 CPU 基线**：延迟 / RTF / 每次调用的固定开销（whisper 按 30 s 窗口计算，固定开销可能不随音频变短而下降——这一点必须测出来，它决定预算怎么算）。
2. **使 GPU 后端在本机可用**，并**证明真的在用 GPU**（不是「装了包」）。
3. 产出 **(后端 × 模型规模)** 的延迟 / RTF / 峰值显存矩阵，落到一句可判定的话：**哪个模型能进预算**。
4. 给出 8 GB 下的共存或互斥策略，以及启动脚本的改法建议（**不含生产代码改动**）。

产出分两层：**证据**（可逐条复核的原始数据）与**结论**（证据支持的判断 + 明确列出未被证据支持的部分）。

## 范围

| 项 | 内容 |
| --- | --- |
| 新增 | 新工具链目录 `E:\Work\toolchains\whisper-b5130-cuda\`（**与现有 CPU 部署并列，不覆盖**）；取证脚本 `GPT-SoVITS/tools/stt_probe/probe_latency.py`（纯标准库）；产物与报告 |
| 允许写 | 上述新工具链目录、`GPT-SoVITS/tools/stt_probe/`、`docs/stt/reports/`、`docs/stt/specs/` 内本 SPEC 相关登记 |
| 禁止改 | `aika-crossplatform/src/**` 任何文件（含 `whisperClient.ts`）；**`E:\Work\toolchains\whisper-b5130\` 现状**（保证 CPU 部署可随时回退） |
| 需用户确认 | 下载 643 MB CUDA 包；下载任一更大模型（体积见下） |
| 依赖 | 现有 `models/ggml-base.bin`；RTX 5060 + 驱动 581.80；网络仅用于下载 |

### 接口契约（不得改变）

生产链路只依赖 F11 的两点。**换后端后必须原样满足**：同一 release 的 `whisper-server.exe`，同一 `/inference` 字段面与响应结构（`{"text": ...}`）。

任何要求改动 `whisperClient.ts` 才能工作的方案，**不属本 SPEC**——那说明换的不是后端而是方案，另立 SPEC。

### 素材与测试集

| 组 | 来源 | 用途 |
| --- | --- | --- |
| jfk.wav | `whisper-b5130/jfk.wav`（11.0 s 英文，官方样例） | 与 F9 的唯一历史数据点对齐比对 |
| jfk-with-silence.wav | 同上目录（437.5 KB） | 含静音段，检验 VAD/固定开销 |
| R/A/C 18 段 | `demo/aika-emotion-demo/audio/{ref,A,C}/mood01..06.wav` | 与研究目标同语种同分布的日语素材，含精确 ground truth（复用 STT-05 口径） |

**长/短对比**：R 组 3~5 s、jfk 11 s——用于分离「固定开销」与「随音频增长的增量」。

### 变量与矩阵

- **自变量**：`backend ∈ {cpu(-ng), cuda}`；`model ∈ {base（必做）, 更大模型（需确认，且以 H1 通过为前提）}`；**控制臂**：CPU 线程数 `-t {6, 12}`（F5/H4，零下载成本）
- **因变量**：
  - 单次请求墙钟延迟（ms），分**冷启动首次**（含 PTX JIT / 权重加载）与**稳态**（重复）两组报告
  - **RTF** = 延迟 ÷ 音频时长；以及**固定开销**（用长短音频差值估计）
  - 峰值显存（`nvidia-smi --query-gpu=memory.used` 轮询采样，含采样时刻的 GPU 占用背景值）
  - 转写文本（同参数下与 CPU 结果的差异需逐条列出；差异不得当作「更好/更差」，只作事实记录）
  - CER（对 R/A/C 的精确 ground truth，复用 STT-05 口径）
- **固定**：与生产**完全一致**的请求参数（F11）；同一批素材；同一模型文件；**测量期间禁止训练进程占用 GPU**（F10）
- **重复**：每组合至少 3 次，报告中给中位数与极值，**不得用单次值下结论**

### 候选模型（体积为 HF 实测值；下载需确认）

| 模型 | 文件大小 | 说明 |
| --- | --- | --- |
| base | 141.1 MB | **已有**，必做基线 |
| small | 465.0 MB | 4× base |
| small-q5_1 | 181.3 MB | 量化，体积接近 base |
| medium | 1462.7 MB | 11× base |
| medium-q5_0 | 514.2 MB | 量化 medium |
| large-v3-turbo | 1549.3 MB | 809 M 参数、4 层解码器 |
| large-v3-turbo-q5_0 | 547.4 MB | 量化 turbo |

### 复现命令（执行时以此为准）

```text
# 解包（不覆盖现有部署）
展开 whisper-cublas-12.4.0-bin-x64.zip → E:\Work\toolchains\whisper-b5130-cuda\runtime\Release\
模型沿用绝对路径：-m E:\Work\toolchains\whisper-b5130\models\ggml-base.bin

# CPU 臂（现有部署，行为不变）
whisper-server.exe -m <model> --host 127.0.0.1 --port 8080 -l auto -t 6 -ng

# GPU 臂
whisper-server.exe -m <model> --host 127.0.0.1 --port 8081 -l auto -t 6

# 后端是否真的生效：看启动 stderr，期望出现
#   ggml_cuda_init: found 1 CUDA devices: Device 0: NVIDIA GeForce RTX 5060 ...
#   并出现 CUDA0 buffer / model size 行；若仍是 "no GPU found" 则 H1 未通过
```

请求侧一律走生产字段面（F11），由 `probe_latency.py` 构造 multipart 发出，**不通过改客户端来测**。

## AC

| AC | 验收 |
| --- | --- |
| STT-06-A | **可行性门**：明确判定 H1。通过 = GPU 组合启动且日志出现 `ggml_cuda_init: found 1 CUDA devices` 与 CUDA0 相关行（**「装了包」不等于「跑起来了」**）；不通过 = 原样记录精确报错与推断。若失败，后续依赖 GPU 的 AC 记为 BLOCKED 而非跳过 |
| STT-06-B | **CPU 基线量化**：对测试集给出延迟 / RTF / 估计固定开销，冷热分开、重复 ≥3 次、脚本零人工退出码 0，产物逐段可复核；并与 F9 的历史单点（jfk 888 ms）对齐说明差异 |
| STT-06-C | **GPU 对照**：同素材、同请求参数下的同指标矩阵；给出加速比及其分布（中位 + 极值）。报告须区分冷启动与稳态，**不得把 PTX JIT 成本写成持久开销** |
| STT-06-D | **显存与共存**：给出各模型峰值显存实测值，并明确回答「与 GPT-SoVITS 能否共存」。未实测的组合必须标注未测，不得外推。给出启动脚本的互斥/降级建议 |
| STT-06-E | **契约保持**：复用 `tmp/whisperLocal.device.test.ts` 对 GPU 端口复跑（或等价请求），证明 `GET /` 探活与 `/inference` 字段面、响应结构未变；同时记录该次 `elapsedMs` |
| STT-06-F | **模型规模可行性**：对 base 与**至少一个**更大模型给出 (延迟, RTF, 显存, CER) 对照，结论落到「能否进预算」。未下载的模型标为未验证；CER 变化只作事实记录，**不得据此声称准确率提升** |
| STT-06-G | **零改动**：`git status` / `git diff --stat` 证明未触碰 `aika-crossplatform/src/**`；且 `E:\Work\toolchains\whisper-b5130\` 的文件清单与校验和在执行前后一致 |
| STT-06-H | 报告落 `docs/stt/reports/STT-06_ACCEPTANCE.md`，逐 AC 附证据；每个汇总数字都能指回产物文件的具体字段与行集合 |

## 判定规则（防止把观察写成结论）

- **不得**把「CPU → CUDA 的延迟下降」写成「日语识别问题已解决」。识别质量是 STT-05 已界定的另一失败面；本 SPEC 只解决**预算**，不触碰质量结论。
- **不得**声称 GPU 提升了识别**准确率**——除非实测 CER 确有差异，且该差异可重复。
- **不得**在 H1 未通过时用「改用别的包/自己编译」悄悄替换方案；那需要用户决策并另立 SPEC。
- 单次测量不作结论；显存与延迟数字必须注明当时的 GPU 占用背景（F10）。
- 预编译包**没有 sm_120 的 SASS**（F7）是**已查证事实**，报告不得表述为「官方包不支持 Blackwell」这类超出证据的断言——证据只支持「该包的 arch 列表不含 sm_120，能否经 PTX JIT 运行由实测决定」。
- 预算阈值：本 SPEC **不自造端到端预算**。采用「ASR 单次调用 ≤ 500 ms」作为**工作阈值**（来源：为 INT-02 的首句 1.5 s 预算留余量，属假设），最终以 INT-02 实测为准并在报告中写明该假设。

## 不在本 SPEC

- **修改 `whisperClient.ts`**（模型选择、超时、language 参数）：参数面修复方向待本 SPEC 矩阵出来后再定，另立 SPEC。
- **把更大模型设为生产默认**：需先有矩阵 + 用户决策，另立 SPEC。
- **源码构建 CUDA 版**：仅在 H1 失败且用户决定投入时考虑（需 MSVC + CUDA Toolkit ≥12.8），另立 SPEC。
- **Web Speech 退路 / 真人麦克风验收**：分属 STT-04 与 STT-03（DEFERRED），不自动恢复。
- **INT-02 端到端实时验收**：本 SPEC 只到「单次 ASR 调用」这一层。

## 为什么先做后端

三件事同时成立，所以顺序不能反：

1. **质量瓶颈已定位但无杠杆**：STT-05 证明问题在解码质量（真人 CER 0.22），而提升解码质量的唯一现实杠杆是更大的模型。
2. **更大模型被预算锁死**：而预算从未被测量过（F9，全仓只有一个单点）。先量预算，才知道「要多大」和「要快到什么程度」。
3. **后端是一个成本极低的既成缺口**：同一 release 有配套 CUDA 包（F3）、后端是动态加载 DLL（F8）、客户端本就为此而选（F4）——**换后端不需要改一行生产代码**，且全程可回退。

代价上界很清楚：一次下载（643 MB）+ 一轮测量，不动生产代码、不动现有部署。而这一切的前提是 **H1 必须先判定**（F7 表明存在真实的不可用风险）。

执行与报告规则见 [测试规则](../../modules/TESTING.md)；只跑本模块相关验证，其他模块用 fake。验收报告放 `../reports/STT-06_ACCEPTANCE.md`。
