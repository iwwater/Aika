# 本机 Whisper 识别服务配置记录（2026-09-17）

范围：用户明确要求解决实时语音「语音识别服务暂时无法连接」。配置既有 Whisper adapter 的本地服务，不修改产品代码或共享接口，不宣称 STT-03 / INT-02 全部通过。

## 结果与原问题

原链路为 Web Speech 系统识别，用户报告在说话后进入 error，错误正文「语音识别服务暂时无法连接」对应 `network`；本记录不声称已经修复 Web Speech 的在线服务。现在已部署既有客户端支持的本地识别服务，无需语音 API Key。

- 官方运行包：whisper.cpp `b5130` 的 `whisper-bin-x64.zip`，来源 <https://github.com/ggml-org/whisper.cpp/releases/tag/b5130>。SHA256 `f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c`，与官方资产 digest 一致。
- 多语言模型：`ggml-base.bin`（非 `.en`），147,951,465 字节，来源 <https://huggingface.co/ggerganov/whisper.cpp>。SHA256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`，与模型仓库 LFS oid 一致。
- 本机目录：`E:\Work\toolchains\whisper-b5130`。启动 `runtime\Release\whisper-server.exe -m E:/Work/toolchains/whisper-b5130/models/ggml-base.bin --host 127.0.0.1 --port 8080 -l auto -t 6 -ng`，后台进程 PID `7536`。
- 当前使用 CPU；没有修改 GPU 驱动、安装 CUDA 或配置系统开机任务。只监听 loopback，不开放局域网。
- 重启机器后可运行 `powershell -NoProfile -File E:\Work\toolchains\whisper-b5130\Start-Whisper.ps1`；脚本发现 8080 已有监听时不再启动，也不终止已有进程。停止本次服务可在确认 PID 仍对应 whisper-server 后执行 `Stop-Process -Id 7536`。

## 验证与证据

| 检查 | 命令 / 证据 | 状态 |
| --- | --- | --- |
| 官方包及模型下载 | `curl.exe -L --fail`，三个下载命令退出码均为 0；包与模型校验匹配 | PASS |
| 服务监听 | `Get-NetTCPConnection -LocalPort 8080 -State Listen` → `127.0.0.1`，PID `7536` | PASS |
| 探活 | `GET http://127.0.0.1:8080/` → HTTP 200 | PASS |
| 真实转写接口 | 官方 `samples/jfk.wav` → `POST /inference`，language=auto / response_format=json / temperature=0 / no_context=true，退出码 0，返回实际英文转写 | PASS（预录样本） |
| 生产客户端 | cwd `aika-crossplatform`，`npx vitest run tmp/whisperLocal.device.test.ts` → 退出码 0，1/1 通过；真实调用 `createWhisperClient`、生产 WAV 编码和 multipart 构造，真实 Node fetch，无假 HTTP 或模型替身 | PASS（本地接口） |
| VAD 静态资源 | `dist/models/silero_vad.onnx` 及 `dist/ort` 资源存在；WASM hash 与已安装 onnxruntime-web 一致 | 已检查，不等同运行通过 |
| Tauri 实际传输 / VAD / 麦克风 | 尚未现场切换并完成输入 | NOT RUN |
| 真人日语五句及 Voice→Agent→Pet | 尚无成功结果 | NOT RUN |

生产客户端原始结果：[LOCAL_WHISPER_20260917.json](evidence/LOCAL_WHISPER_20260917.json)。临时验证 harness 在仓库忽略的 `aika-crossplatform/tmp/whisperLocal.device.test.ts`；运行包、模型与服务日志留在本机 toolchains，不入库。预录样本只证明真实模型接口和客户端连通，不冒充麦克风输入、日语准确性或真人延迟。

## 现场完成步骤

1. Aika 设置 → 语音识别，将识别链路选为「本地识别」（`whisper-local`），地址保持 `http://127.0.0.1:8080`，点「检测本地服务」。输出保持「只用系统合成」，API Key 留空。
2. 关闭当前实时语音页，再进入一次以重新选择输入引擎。底部应显示「本地识别：Silero VAD + Whisper」，不应继续显示「系统语音识别」。
3. 念固定日语第一句，记录识别文本和是否回复；若失败保留首次新错误，不重复重试到成功。成功后继续剩余四句。

当前共享接口影响：无。待联调：Tauri HTTP、VAD / Mic、LLM、系统 TTS 与桌宠真实表现。

## 后续维护结果

用户切到本地识别后仍无响应；已定向修复 Silero v5 缺失音频上下文（[STT-01 报告](STT-01_ACCEPTANCE.md)），重建并重启 release。用户随后反馈识别已可用，但日语偶发转写为中文。早先 JSON 中的 NOT RUN 是接口验证时的历史状态，不改写历史证据；本次新增真人反馈只证明现场识别可用，不代表完整 STT-03 / INT-02 或日语准确性通过。
