# Whisper CUDA 部署说明 · 首次 JIT 与预热（STT-08 AC-D）

适用范围：`E:\Work\toolchains\whisper-b5130\`（生产启动脚本）+
`E:\Work\toolchains\whisper-b5130-cuda\`（CUDA 运行时，未改动）。
结论来源：[STT-08 验收报告](../reports/STT-08_ACCEPTANCE.md)、[STT-06](../reports/STT-06_ACCEPTANCE.md)。

## 部署形态（2026-09-22 起）

| 项 | 值 |
| --- | --- |
| 启动脚本 | `whisper-b5130\Start-Whisper.ps1`（CUDA + turbo） |
| 可执行 | `whisper-b5130-cuda\runtime\Release\whisper-server.exe`（sha256 `4e6905841f62d7f2…`） |
| 模型 | `whisper-b5130\models\ggml-large-v3-turbo-q5_0.bin`（573.40 MB，sha256 `394221709cd5ad1f…`） |
| 参数 | `-m <turbo> --host 127.0.0.1 --port 8080 -l auto -t 6`（**不含 `-ng`**，`-ng` 会强制 CPU 后端） |
| 回退 | 运行 `whisper-b5130\Start-Whisper.cpu.ps1`（CPU + base，原样保留，未改动） |

启动成功的标志（`server.stdout.log`）：

```text
load_backend: loaded CUDA backend from ...\whisper-b5130-cuda\runtime\Release\ggml-cuda.dll
whisper_init_with_params_no_state: use gpu    = 1
whisper_model_load:        CUDA0 total size =   573.45 MB
whisper_backend_init_gpu: using CUDA0 backend
```

「服务起来了但第一次说话卡半分钟」的原因与处理：见下。

## 为什么首次调用会慢（PTX JIT）

本机是 RTX 5060（compute capability **12.0 / sm_120**），而 b5130 官方 CUDA 包只带了
到 `sm_90` 的 SASS 与 PTX，日志里能看到 arch 列表：

```text
CUDA : ARCHS = 500,610,700,750,800,860,890,900
```

没有 `120`。驱动于是走 **PTX JIT**：首次用 `900` 的 PTX 为本机 SM 现编译内核，
这次编译的耗时就变成**第一次推理的额外延迟**（STT-06 实测 33.8 s）。
编译结果落盘缓存后，后续调用恢复正常（本机 217〜227 ms，见 STT-08 AC-C）。

- 缓存位置：`%APPDATA%\NVIDIA\ComputeCache`（跨进程、跨重启持久）
- 触发条件：换机、换驱动大版本、手动清空该缓存目录、或首次部署该 CUDA 包
- 不是「模型加载慢」：模型加载是独立阶段，日志里 `model size` 之后服务即可探活

## 预热步骤（部署后建议执行一次）

换机或清过缓存时，先打一次真实推理，把 JIT 成本挡在用户第一次说话之前：

```powershell
# 1. 启动服务
& 'E:\Work\toolchains\whisper-b5130\Start-Whisper.ps1'
# 2. 等探活通过（GET / 返回 200）
Invoke-WebRequest -Uri 'http://127.0.0.1:8080/' -UseBasicParsing | Select-Object StatusCode
# 3. 打一次真实转写（预热；冷缓存时这一发约 30 s 量级，之后就快了）
curl.exe -s -X POST http://127.0.0.1:8080/inference `
  -F "file=@E:\Work\toolchains\whisper-b5130\jfk.wav" `
  -F "response_format=json" -F "language=auto" -F "temperature=0" -o NUL
```

预热完成的判据：紧接着的第二次转写在数百毫秒内返回（本机 220 ms 左右）。

## 运行时观察

- 常驻显存：turbo 净增约 **1055 MiB**（本机实测 666 → 1721 MiB，无 sidecar）
- 与 GPT-SoVITS sidecar 共存：两服务同加载 + 同时推理，峰值 **3570 MiB / 8151 MiB**，
  无 OOM（详见 STT-08 AC-B 证据）
- 并发推理时的互相影响：whisper 单发 226〜374 ms（独占时中位 217.6 ms），
  sidecar 合成约 1.6 s/句——两者同跑仍都在各自预算内
