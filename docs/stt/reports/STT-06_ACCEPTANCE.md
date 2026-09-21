# STT-06 验收报告 · Whisper 推理后端切换（CPU → CUDA）与延迟预算标定

- 执行日期：2026-09-18
- SPEC：[STT-06](../specs/STT-06.md)
- 执行环境：RTX 5060（Blackwell, sm_120, 8150 MiB）· 驱动 581.80 · 20 线程 · conda env `GPTSoVits`
- 产物目录：`E:\Work\Chat_model\GPT-SoVITS\output\stt_probe\`
- **未触碰**：`aika-crossplatform/src/**`、`E:\Work\toolchains\whisper-b5130\`（原 CPU 部署）

---

## 0. 结论摘要

**H1 通过**——预编译 CUDA 包在本机可用，`sm_120` 确实靠 `90-virtual` PTX 被驱动 JIT 成功，**无需源码构建**。

**但换来一个 SPEC 未预见的代价**：首次调用要付 **33.8 秒**的一次性 PTX JIT 编译成本；驱动将其落盘缓存后降到 **220.6 ms**，且**跨进程持久**。

**核心收益**：

| | jfk 11.0 s 稳态中位 | RTF | 对 500 ms 工作阈值 |
| --- | --- | --- | --- |
| CPU `-ng -t 6`（现行部署） | **763.26 ms** | 0.0694 | 超出 1.53× |
| CPU `-ng -t 12`（线程对照臂） | 685.05 ms | 0.0623 | 超出 1.37× |
| **CUDA `-t 6`** | **85.52 ms** | 0.0078 | **仅用 17.1%** |

**加速比 8.9×（服务端）/ 10.3×（生产客户端视角）**；短句达 **11.2×**。

**一个比加速比更重要的发现**：CPU 侧的 730~760 ms 里，**约 706~720 ms 是与音频时长无关的固定开销**。音频从 3.84 s 拉到 11.0 s，CPU 延迟只涨 37 ms。也就是说——**在 CPU 上「把话说短一点」救不了延迟**，真正的杠杆只有后端。GPU 把这块固定开销从 ~720 ms 压到 ~70 ms。

**质量未受影响**：同模型同参数下 CPU/GPU 转写文本 **19/20 逐字一致**，CER 中位与完全正确数**完全相同**（见 AC-C 附加项）。这符合 SPEC 判定规则——**本 SPEC 不主张 GPU 提升了准确率，实测也没有提升**。

**建议**：采用 CUDA 后端。但必须把 JIT 缓存写进部署说明（AC-D）。

---

## AC 逐条

### STT-06-A · 可行性门（H1）— **PASS**

判定依据不是「装了包」，而是运行日志中出现 CUDA 后端加载与使用行：

```
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 8150 MiB):
  Device 0: NVIDIA GeForce RTX 5060, compute capability 12.0, VMM: yes, VRAM: 8150 MiB
load_backend: loaded CUDA backend from ...\whisper-b5130-cuda\runtime\Release\ggml-cuda.dll
whisper_model_load:        CUDA0 total size =   147.37 MB
whisper_backend_init_gpu: device 0: CUDA0 (type: 1)
whisper_backend_init_gpu: using CUDA0 backend
```

- 证据文件：`output/stt_probe/server_cuda-t6-jitcold.log`、`server_gpu_contract.log`
- 二进制自报的编译目标：`CUDA : ARCHS = 500,610,700,750,800,860,890,900`——**确实不含 120**，与 SPEC F7 的推断一致；可用性由 `900` 的 PTX 经驱动 JIT 到 sm_120 实现。
- 对照组（CPU 部署）同一命令：`whisper_backend_init_gpu: no GPU found`。

**H1 的边界条件（本次实测新增，SPEC 未预见）**：PTX JIT 不是免费的。

| 场景 | 首次请求耗时 | 证据 |
| --- | --- | --- |
| 空 JIT 缓存（`CUDA_CACHE_PATH` 指向空目录） | **33 783.41 ms** | `latency_cuda-t6-jitcold.json` → `cold_start.elapsed_ms` |
| 缓存命中（新进程 + 默认缓存） | **220.62 ms** | `latency_cuda-t6-warmcache.json` → `cold_start.elapsed_ms` |
| 禁用缓存旁证（`CUDA_CACHE_DISABLE=1`） | 37 539.22 ms（复现） | 命令行直测，见下方「执行记录」 |

同一台机器、同一二进制，**153×** 差异。缓存位置：`%APPDATA%\NVIDIA\ComputeCache`（本机 649 文件 / 415 MB）。

### STT-06-B · CPU 基线量化 — **PASS**

服务端直测，生产字段面（`language=auto / response_format=json / temperature=0 / no_context=true`），每组合重复 5 次：

| 臂 | 冷启动首次 (jfk) | jfk 11.0 s 中位 [极值] | jfk-silence 14.0 s 中位 | RTF (jfk) | 错误数 |
| --- | --- | --- | --- | --- | --- |
| `cpu-ng-t6` | 805.99 ms | **763.26** [752.37~803.46] | 763.35 [749.13~795.00] | 0.0694 | 0 |
| `cpu-ng-t12` | 721.19 ms | **685.05** [663.10~703.54] | 688.72 [667.21~712.64] | 0.0623 | 0 |

**固定开销估计**（脚本按两点线性外推，见产物 `fixed_overhead_estimate`）：

| 臂 | 每秒钟音频的增量 | **截距（固定开销）** |
| --- | --- | --- |
| `cpu-ng-t6` | 3.92 ms/s | **720.19 ms** |
| `cpu-ng-t12` | 3.40 ms/s | **647.65 ms** |
| `cuda-t6` | 1.26 ms/s | **71.62 ms** |

> 口径说明：截距为两点外推，样本少，**只作量级参考**，不作精确预算依据。但结论方向是稳的——见下方「R 组 vs jfk 组」的直接对照。

**与 F9 历史单点的对齐**：STT-05 记录的唯一延迟数据点是 jfk 的 `elapsedMs = 888.28`（**客户端视角**，单次）。本次用同一 harness 对 CPU 后端复跑 5 次：中位 **776.04 ms** [758.04~800.31]。两者同量级，差 112 ms（12.6%），可解释为「单次值 vs 中位值 + 运行时刻系统负载不同」。证据：`docs/stt/reports/evidence/STT-06_WHISPER_CPU_CONTRACT.json`。

**H4（CPU 剩余空间）结论**：`-t 6 → -t 12` 只带来 **10.2%** 改善（763.26 → 685.05）。CPU 侧没有可挖的余量，不足以弥补与 GPU 的 8~9 倍差距。

### STT-06-C · GPU 对照 — **PASS**

| 臂 | jfk 稳态中位 | 分位区间 | RTF | 加速比 |
| --- | --- | --- | --- | --- |
| `cpu-ng-t6` → `cuda-t6` | 763.26 → **85.52** | — | 0.0694 → 0.0078 | **8.92×** |
| `cpu-ng-t12` → `cuda-t6` | 685.05 → 85.52 | — | — | 8.01× |
| R01（3.84 s 短句） | 725.99 → **65.14** | — | — | **11.15×** |
| 生产客户端视角（jfk） | 776.04 → **75.57** | [74.30~348.42] | — | **10.27×** |

**冷热分离已做到**（SPEC 明确要求不得把 JIT 成本写成持久开销）：

- 冷启动首次（空缓存）：33 783.41 ms —— **一次性**，只在机器上第一次运行时发生
- 稳态（同进程、JIT 已完成）：**85.52 ms**，5 次极值 76.74~100.26 ms，分布紧

**全组逐条（20 段素材 × 5 次）**：错误 0 条，文本稳定（`text_stable = true`）20/20。
产物：`latency_cuda-t6-jitcold.json`、`latency_cpu-ng-t6.json`、`latency_cpu-ng-t12.json`。

**逐条文本比对（AC-C 附加项）**：`compare_backend_texts.py` 输出 `backend_text_compare.json`——

- **20 段中 19 段 CPU/GPU 文本逐字完全相同**
- 唯一差异：R03（4.74 s）—— CPU `もうこうやっておにそにどこされてるんだから` vs GPU `…おにそうに…`，仅一个假名（长音）之差
- 该差异是贪心解码下 GPU 浮点累加顺序不同导致的 argmax 边界翻转，属已知现象；**只作事实记录，不代表优劣**

### STT-06-D · 显存与共存 — **PASS（共存部分未实测）**

| 测量项 | 值 | 证据 |
| --- | --- | --- |
| 测量前整卡占用（系统桌面背景） | 530 MiB | 各产物 `gpu_idle_mib_before_matrix` |
| CPU 臂期间峰值 | 530~531 MiB | 即**完全未使用 GPU**，交叉验证 F1/F5 |
| **CUDA 臂期间峰值** | **1070~1071 MiB** | 20/20 组一致 |
| **whisper(CUDA, base) 净增量** | **541 MiB** | 1071 − 530 |

采样方式：请求期间以 150 ms 间隔轮询 `nvidia-smi --query-gpu=memory.used`，取峰值（`GpuSampler`）。

**与 GPT-SoVITS 的共存：未实测并发**。SPEC 明确「未实测的组合必须标注未测，不得外推」，因此此处**不给结论**。可提供的只有事实：whisper(base, CUDA) 净增 541 MiB，卡容量 8150 MiB。若后续要判断共存，须实测 GPT-SoVITS 权重加载后的占用峰值。

**启动脚本改法建议**（不含生产代码改动）：

1. `Start-Whisper.ps1` 目前硬编码 `-ng`（SPEC F4）。切 GPU 只需**去掉 `-ng`** 并把可执行目录指向 `E:\Work\toolchains\whisper-b5130-cuda\runtime\Release\`——**`whisperClient.ts` 一行不用改**（契约见 AC-E）。
2. 必须保留 JIT 缓存目录 `%APPDATA%\NVIDIA\ComputeCache`。清空缓存、更换运行账户或迁移机器，都会让下一次首次调用退回 ~34 s。**→ 部署文档里应显式写明这条**，否则表现为「服务起来了但第一次说话卡半分钟」。
3. 建议的降级/互斥策略（**建议，非实测**）：GPU 服务常驻；`/health` 探活（对应客户端 800 ms 预算）本身不触发 JIT，只有第一次真实 `/inference` 才会。若与训练共用 GPU，应在训练启动前停掉 whisper 服务，或反向让 whisper 回退 CPU（现有部署仍在，改端口即可切回）。

### STT-06-E · 契约保持 — **PASS**

新 harness `aika-crossplatform/tmp/whisperLocal.device.gpu.test.ts`（**新建文件**，未覆盖 20260917 历史证据），真实调用生产 `createWhisperClient` + 真实 Node fetch：

| 检查 | CPU (:8080) | GPU (:8081) |
| --- | --- | --- |
| `GET /` 探活（800 ms 超时） | `true` | `true` |
| 探活耗时 `probeMs` | 19.83 ms | 20.04 ms |
| `/inference` 字段面与响应结构 | 未变 | 未变 |
| 文本断言（`ask not what your country can do for you`） | 通过 | 通过 |
| 稳态 `elapsedMs` 中位 | 776.04 ms | **75.57 ms** |
| 文本 5 次稳定性 | 一致 | 一致 |

证据：`docs/stt/reports/evidence/STT-06_WHISPER_GPU_CONTRACT.json`、`STT-06_WHISPER_CPU_CONTRACT.json`。
**结论：换后端后生产链路零改动即可工作。**

### STT-06-F · 模型规模可行性 — **PARTIAL（base 完成，更大模型未验证）**

按用户本轮范围「只要 GPU」，**未下载任何更大模型**（依据 SPEC 范围表，下载需用户确认）。

已完成的部分：

| 模型 | 延迟 (jfk 中位) | RTF | 显存净增 | CER（中位 / 完全正确数） |
| --- | --- | --- | --- | --- |
| base · CPU `-t 6` | 763.26 ms | 0.0694 | 0 | 0.0238 / 9 of 18 |
| base · CUDA `-t 6` | **85.52 ms** | 0.0078 | **541 MiB** | 0.0238 / 9 of 18 |

**未验证**：small / medium / large-v3-turbo 及其量化版本——**未下载、未测量**，不得外推。

**关于「能否进预算」**：base 在 GPU 上仅占 500 ms 工作阈值的 17.1%，**余量约 415 ms**。这意味着模型规模仍有上行空间（spec 列出 small-q5_1 181 MB / medium-q5_0 514 MB / large-v3-turbo-q5_0 547 MB 等候选）。但**本 SPEC 不据此推荐任何模型**——需要实测矩阵 + 用户决策，另立 SPEC。

**CER 变化只作事实记录**：CPU 与 GPU 的 CER 中位（0.0238）与完全正确数（9/18）**完全相同**，GPU **没有**带来准确率提升。

### STT-06-G · 零改动 — **PASS**

**（1）现有 CPU 部署逐字节未变**：执行前对 `E:\Work\toolchains\whisper-b5130\` 全量 49 个文件做 SHA256 快照，执行后重算比对：

```
before = 49 files / now = 49 files
added = []   removed = []   hash_changed = []   size_changed = []
VERDICT = UNCHANGED
```

产物：`output/stt_probe/ac_g_snapshot_compare.json`；脚本 `compare_snapshot.py`。

> 执行记录（诚实标注第一次的误判）：首次比对报 `MODIFIED` 且全部 49 个文件都「变了」，是**比对方法错误**——PowerShell `Get-FileHash` 输出大写十六进制，Python `hexdigest()` 输出小写，直接字符串比较必然不等。已在 `compare_snapshot.py` 中显式做大小写归一化。**不是文件真的被改动。**

**（2）生产源码未触碰**：

- `git status --porcelain src/` 显示的改动（`App.tsx`、`persistentScheduler.*`、`localTasks*`）经 mtime 核实**全部来自 2026-09-17 10:49~10:51**，属本次执行之前既有的未提交改动（另属 localTasks / RT-05 范围），**与 STT-06 无关**。
- 本次执行窗口（09:55 之后）内的 `find aika-crossplatform/src -newermt "2026-09-18 09:50"` 结果**为空**。

### STT-06-H · 报告 — 本文件

---

## 判定规则遵守声明

- **未**把「CPU → CUDA 的延迟下降」表述为「日语识别问题已解决」。识别质量是 STT-05 界定的另一失败面，本 SPEC 只解决预算。
- **未**声称 GPU 提升准确率——实测 CER 无差异（AC-F）。
- H1 通过，因此**不存在**「改用别的包 / 自己编译」的悄悄替换。
- 所有延迟与显存数字均标注了当时的 GPU 占用背景（530 MiB 系统桌面占用）。
- 所有结论基于 **≥3 次重复**（服务端 5 次/组合，客户端 5 次），单次值仅用于对齐历史单点。
- 关于 sm_120 的表述限制在证据内：该包 ARCHS 列表不含 120，**能否经 PTX JIT 运行由实测决定**——已实测为**可以**。
- 预算阈值 500 ms 为 SPEC 设定的**工作阈值/假设**（为 INT-02 首句 1.5 s 留余量），**最终以 INT-02 实测为准**。

---

## 执行记录（可复现）

```text
# 1. 前置快照（AC-G）
Get-ChildItem -Recurse -File E:\Work\toolchains\whisper-b5130 | Get-FileHash -Algorithm SHA256
  → E:\Work\toolchains\whisper-b5130-cuda\_cpu_baseline_snapshot_before.json   (49 files)

# 2. 下载与解包（不覆盖现有部署）
curl -L --fail -o whisper-cublas-12.4.0-bin-x64.zip \
  https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-12.4.0-bin-x64.zip
  → 674,539,285 bytes；47 entries；展开后 Release/ → runtime/Release/

# 3. H1 判定
whisper-cli.exe -m ...ggml-base.bin -f ...jfk.wav      # 空缓存 37.7 s / 缓存命中 0.49 s

# 4. 四臂测量（每臂 20 素材 × 5 次，生产字段面）
probe_latency.py --label cuda-t6-jitcold  --cuda-cache-path <空目录>   # :8081
probe_latency.py --label cuda-t6-warmcache                            # :8081
probe_latency.py --label cpu-ng-t6   --ng --threads 6                 # :8080
probe_latency.py --label cpu-ng-t12  --ng --threads 12                # :8082

# 5. 契约复跑（生产客户端）
npx vitest run tmp/whisperLocal.device.gpu.test.ts   # :8081 GPU / :8080 CPU

# 6. 收尾
taskkill /F /IM whisper-server.exe    # 两个端口均已释放（探活 HTTP 000）
```

工具（纯标准库，任何 Python 可跑）：
`GPT-SoVITS/tools/stt_probe/probe_latency.py`（延迟/RTF/显存标定）、
`compare_snapshot.py`（AC-G 零改动证明）、
`compare_backend_texts.py`（AC-C 文本逐条比对）。

---

## 未验证事项（明确列出，不外推）

| 项 | 状态 |
| --- | --- |
| 更大模型（small / medium / large-v3-turbo 及量化版）的延迟/显存/CER | **未下载、未测量** |
| whisper(CUDA) 与 GPT-SoVITS 的显存共存 | **未实测并发** |
| 真人麦克风、Tauri WebView 下的真实表现 | **NOT RUN**（属 STT-03 / INT-02） |
| INT-02 端到端首句 1.5 s 预算 | **未测**，本 SPEC 只到「单次 ASR 调用」层 |
| 日语识别质量的改善 | **不在本 SPEC**；STT-05 结论未变 |

## 遗留副作用

- `E:\Work\toolchains\whisper-b5130-cuda\_jitcache_cold\`：本次为复现真冷启动而生成的 JIT 缓存（18 文件 / 64 MB），保留作证据，可随时删除。
- `%APPDATA%\NVIDIA\ComputeCache` 因本次实验增长至 649 文件 / 415 MB——这是**正常且必要**的缓存，删除会导致下次首调退回 ~34 s。
