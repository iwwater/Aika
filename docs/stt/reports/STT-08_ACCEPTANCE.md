# STT-08 验收报告 · turbo 落地为生产默认 + 8 GB 显存共存实测

日期：2026-09-22（执行时间 2026-09-21 11:26〜11:40 GMT+9）。规格：[STT-08](../specs/STT-08.md)。
环境：Windows，RTX 5060 8 GB（8151 MiB），driver 581.80；whisper b5130 CPU+CUDA 两套资产；GPT-SoVITS sidecar（conda `GPTSoVits`）。
执行前现场：**8080 / 9880 / 9881 全部空闲**，无训练任务，GPU 背景占用 666 MiB（桌面进程，无计算进程）——服务重启未中断任何在跑业务。

## 改动清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `E:\Work\toolchains\whisper-b5130\Start-Whisper.ps1` | **重写** | exe 指向 CUDA 目录、模型换 turbo、去掉 `-ng`；缺 CUDA exe 时报错并提示回退（1910 字节） |
| `E:\Work\toolchains\whisper-b5130\Start-Whisper.cpu.ps1` | **新增** | 原 CPU/base 启动脚本原样保留，一键回退（1299 字节） |
| `aika-crossplatform\tmp\whisperLocal.stt08.test.ts` | 新增 | 契约复跑 harness（沿 STT-06 范式，独立证据文件；`tmp/` 被 `.gitignore:3` 忽略） |
| `GPT-SoVITS\tools\stt_probe\probe_vram_coexistence.py` | 新增 | 显存共存探针（200 ms 采样 + 四阶段真实请求） |
| `GPT-SoVITS\tools\tts_probe\make_listening_pack.py` / `check_listening_pack.py` | 新增 | 听音包生成器/自检（TTS-06-F 用，见该报告） |

未改动：`whisper-b5130\runtime\Release\**`（CPU 运行时）、`models\ggml-base.bin`、`whisper-b5130-cuda\**`、`aika-crossplatform\src\**`。

## 执行命令与退出码

| 命令 | cwd | 退出码 |
| --- | --- | --- |
| `whisper-b5130-cuda\runtime\Release\whisper-server.exe -m <turbo> --host 127.0.0.1 --port 8080 -l auto -t 6` | `…\whisper-b5130-cuda\runtime\Release` | 0（后台常驻，探活 200） |
| `node node_modules/vitest/vitest.mjs run tmp/whisperLocal.stt08.test.ts`（`STT08_REPEATS=5`） | `E:/Work/AI CHAT/aika-crossplatform` | 0（1 test passed，1.64 s） |
| `python probe_vram_coexistence.py --n 3 --out …STT-08_VRAM_COEXISTENCE.json` | `GPT-SoVITS/tools/stt_probe` | 0 |
| `D:\ANACONDA\envs\GPTSoVits\python.exe aika_tts_server.py --port 9880`（共存对手方） | `E:/Work/Chat_model/GPT-SoVITS` | 0（health `ready`） |

**踩坑记录**：`npx vitest …` 在本机被安全策略拦下（链路触发 `wsl.exe` 黑名单），改用本地入口
`node node_modules/vitest/vitest.mjs run <file>` 通过——命令等价，仅入口不同。

## 逐 AC 结论

### STT-08-A · PASS · 部署切换生效

- 启动脚本已去 `-ng`、exe 指向 CUDA 目录、模型为 turbo（内容见改动清单；回退脚本独立存在）。
- 启动日志（归档：`reports/evidence/STT-08_WHISPER_CUDA_STARTUP.log`，sha256 `fe144cab5f2c28b6…`，9919 字节）逐条命中：
  - `load_backend: loaded CUDA backend from …\ggml-cuda.dll`
  - `whisper_init_with_params_no_state: use gpu    = 1`
  - `whisper_model_load:        CUDA0 total size =   573.45 MB` / `model size =  573.40 MB`
  - `whisper_backend_init_gpu: using CUDA0 backend`
- 探活 `GET /` → **200**（首次 10 ms，契约运行中 probe 18.98 ms）。
- 独立佐证（进程级）：`nvidia-smi --query-compute-apps` 列出在 GPU 上的进程为
  `E:\Work\toolchains\whisper-b5130-cuda\runtime\Release\whisper-server.exe`（pid 23592）——
  GPU 上跑的确实是 CUDA 版而非 CPU 版。

### STT-08-B · PASS · 显存共存（可判定结论：**8 GB 内可共存**）

证据：`reports/evidence/STT-08_VRAM_COEXISTENCE.json`（200 ms 采样，四阶段真实请求，每阶段 3 次）。

加载态观测（同一会话，nvidia-smi）：

| 状态 | used | free | 净增 |
| --- | --- | --- | --- |
| ambient（无 whisper、无 sidecar） | 666 MiB | 7142 MiB | — |
| whisper turbo 已加载、sidecar 未启动 | 1721 MiB | 6087 MiB | whisper ≈ **1055 MiB** |
| 两服务均已加载、无推理 | 3552 MiB | 4256 MiB | sidecar ≈ **1831 MiB** |

推理阶段（两服务全程已加载；`whisper-only`/`sidecar-only` 指「只有该服务在推理」）：

| 阶段 | 峰值 used | 最低 free | 调用（ms） | 是否全成功 |
| --- | --- | --- | --- | --- |
| both-idle | 3552 MiB | 4256 MiB | — | — |
| whisper-only | 3552 MiB | 4256 MiB | 374.0 / 226.0 / 226.0 | 是 |
| sidecar-only | 3570 MiB | 4238 MiB | 1646.1 / 1637.0 / 1643.0 | 是 |
| **concurrent（真并发）** | 3562 MiB | 4246 MiB | whisper 与 sidecar 同时各打 3 次 | 是 |

**结论：可共存。** 全阶段整体峰值 **3570 MiB / 8151 MiB**（余量 ≥4238 MiB），**无 OOM、无请求失败**；
whisper 侧推理不额外抬升显存（compute buffer 在加载期已分配），两服务日志中无 `out of memory` /
`CUDA error`（已核对 `stt08.server.log` 与 `tts08.sidecar.log`）。
峰值读数以 200 ms 采样，±20 MiB 波动视为采样噪声（例如 concurrent 的 3562 低于 sidecar-only 的 3570
属同量级，不代表显存下降）。

### STT-08-C · PASS · 契约复跑

证据：`reports/evidence/STT-08_WHISPER_CUDA_TURBO_CONTRACT.json`（真实 `createWhisperClient` + 真实 Node fetch，jfk.wav 11.0 s，生产字段面）。

| 项 | 值 |
| --- | --- |
| 探活 | true，18.98 ms |
| 首次转写 | 734.70 ms（缓存已热，非 33.8 s 冷态；含首次调用初始化） |
| 稳态中位 | **217.59 ms**（min 217.00 / max 734.70，n=5） |
| 文本 | 5/5 完全一致且正确（"And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country."） |

与 STT-07 取证环境（同一模型，独占 GPU）的中位 215.95 ms 一致，说明**搬进生产未引入回归**。
并发场景下的对照见 AC-B（whisper 226〜374 ms，同时 sidecar 在合成）。

### STT-08-D · PASS · 首次 JIT 已写入部署文档

新增 [`docs/stt/further/WHISPER_CUDA_JIT_NOTES.md`](../further/WHISPER_CUDA_JIT_NOTES.md)，包含：
现象（首次 33.8 s，STT-06 实测）、根因（日志实据 `CUDA : ARCHS = 500,610,700,750,800,860,890,900`，
无 `sm_120` → 驱动 PTX JIT）、缓存位置（`%APPDATA%\NVIDIA\ComputeCache`，跨进程持久）、
预热步骤（启动 → 探活 → 打一次真实转写，判据为第二发回到数百 ms）、以及本机常驻显存参考值。
本次运行首次转写 734.70 ms（缓存已热）与文档描述一致，文档能解释「服务起来了但第一次说话卡半分钟」。

### STT-08-E · PASS · 零改动边界

- `git status --short -- aika-crossplatform/` 前后一致，仅列 8 项**既有**改动
  （`src/App.tsx`、`src/app/plugins/index.ts`、`src/services/runtime/persistentScheduler{,.test}.ts`
  与 4 个 `localTasks*` 新文件——属合作者/前序会话的本地任务工作，**非本次产生**）；
  `whisperClient.ts` **未出现在改动列表**，即模型选择仍在服务端 `-m`，客户端不感知。
- 本次新增的 harness 在 `aika-crossplatform/tmp/`，被 `.gitignore:3`（`tmp/`）忽略，不进入提交候选。
- CPU/base 可回退且未变（前后两次采样一致）：

| 文件 | sha256（前 16） | 状态 |
| --- | --- | --- |
| `whisper-b5130\runtime\Release\whisper-server.exe`（CPU） | `74c13bcb83b94441` | 未变 |
| `whisper-b5130\models\ggml-base.bin` | `60ed5bc3dd14eea8` | 未变 |
| `whisper-b5130-cuda\runtime\Release\whisper-server.exe` | `4e6905841f62d7f2` | 未变 |
| `whisper-b5130\models\ggml-large-v3-turbo-q5_0.bin` | `394221709cd5ad1f` | 未变 |

- `E:\Work\toolchains\` **不是 git 仓库**（无 `.git`），因此该侧以文件校验和而非 `git status` 为证据。

## 接口影响

- **客户端零改动**：`whisperClient.ts` 未动；探活（GET /）与 `/inference` 字段面（`language=auto`、
  `response_format=json`、`temperature=0`、`no_context=true`，取 `data.text`）与切换前一致。
- 唯一对外可感变化是**服务端行为**：模型更大（base 148 MB → turbo 573 MB）、延迟更低、
  常驻显存 +约 1055 MiB（CPU 版为 0）。消费方（INT-02 实时链路）需按 AC-B 的数字规划 8 GB 预算。
- 回退路径：`Start-Whisper.cpu.ps1`（CPU + base），无代码改动，纯脚本切换。

## 未运行 / 不作断言

- **NOT RUN**：真人麦克风验收（STT-03 DEFERRED）；Tauri WebView 内实测；日语真实音频复跑
  （CER 全量属 STT-07，本 SPEC 不重复）。
- **不作断言**：不声称「换模型提升准确率」——STT-07 的 CER 下降是 n=6 方向性观察；
  本次只确认链路连通、延迟与显存。
- 预算阈值仍沿用 STT-06 的「单次 ≤500 ms」工作阈值假设，最终以 INT-02 实测为准。

## 遗留

- 当前 8080（turbo/CUDA）与 9880（sidecar）为本会话启动的常驻进程；重启机器后需用
  `Start-Whisper.ps1` 重新拉起（预热见 AC-D 文档）。
- 与 TTS-06-F 的耦合点：两者共用 8 GB；AC-B 已给出同日并发实测数据，TTS 侧句间预算可据此复核。
