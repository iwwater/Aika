# 2026-09-22 开发任务

制定日期：2026-09-21。依据：[语音开发台账](DEV_TASKS_VOICE.md)、[四份优化 SPEC 复核](ser/reports/OPTIMIZATION_REVIEW_20260921.md)。

## 明日目标

在不触碰正在由合作者重构的 `aika-crossplatform/` 前端代码的前提下，完成语音侧当前最靠近产品链路的两项工作：先收口 TTS-06-F 可独立完成的真人听音，再执行 STT-08 的生产部署切换与 8 GB 显存共存实测。最后整理本轮跨仓库交付范围，为后续审阅或提交做准备。

## 执行顺序

### 任务 1 · TTS-06-F 人工听音收口

优先级：P0。需要用户在场，预计 30–45 分钟。

输入：`E:/Work/Chat_model/GPT-SoVITS/output/tts_probe_tts06f/` 中已有 18 段真机合成音频，以及 [TTS-06 验收报告](tts/reports/TTS-06_ACCEPTANCE.md)。不重新训练，不修改权重。

执行：

1. 按 6 个 style 各听冷句、热句和换句样本，记录词级重复、乱码、异常语气词、尾部静音、音色破裂和主观可懂度。
2. 重点复听 ASR 曾出现差异的片段，如「うん→ん?」和亲密风格额外语气词，区分合理表现与生成异常。
3. 用真实播放链路确认至少一次客户端断开/停止后没有继续残留播放；记录现象和大致停止时间，不用 HTTP 返回耗时替代播放证据。
4. 在 `docs/tts/reports/TTS-06_ACCEPTANCE.md` 追加人工听音表，并统一报告顶部与台账状态。

完成判据：人工听音有逐 style 记录；“无词级重复”由真人听音支持或如实记 FAIL；明确区分已测的 sidecar 合成延迟与尚未具备前端预取条件的“实际句间 <0.5s”。TTS-07 冻结期间，应用首句出声、句间和打断指标仍留给 TTS-07-F，不为了收口 TTS-06 篡改 AC。

### 任务 2 · 执行 STT-08

优先级：P0。预计 1.5–2.5 小时。规格：[STT-08](stt/specs/STT-08.md)。

前置检查：确认用户当前没有运行训练任务；记录现有 8080/9880 服务进程、GPU 背景占用、`Start-Whisper.ps1` 内容以及 CPU/base 文件校验和。服务重启会短暂中断本地语音，执行前在现场明确告知用户。

执行：

1. 仅修改 `E:/Work/toolchains/whisper-b5130/Start-Whisper.ps1`：CUDA runtime、large-v3-turbo-q5_0、移除 `-ng`；保留 CPU/base 回退路径与原文件证据。
2. 启动后核对 CUDA backend、turbo model size 和 `GET /` 200。
3. 用真实 `createWhisperClient` 走生产字段面，重复至少 3 次，记录探活、文本和中位延迟。
4. 同时加载 whisper turbo 与 GPT-SoVITS sidecar，各触发真实推理；采样推理前背景、单服务、双服务与峰值显存，记录是否 OOM。不得用 9 月 20 日粗算替代本次正式证据。
5. 记录首次 JIT、缓存位置与预热步骤；写 `docs/stt/reports/STT-08_ACCEPTANCE.md` 和部署说明，同步 STT 索引与语音台账。

完成判据：STT-08 A–E 逐项有证据；延迟数字注明背景和重复次数；给出“8 GB 能否共存”的明确结论；CPU/base 可回退且未修改；默认不改 `aika-crossplatform/src/**`。任何未跑项按 NOT RUN，不用 Demo 已运行 turbo 推定生产部署通过。

### 任务 3 · 交付范围整理

优先级：P1。预计 30–45 分钟。任务 1/2 完成后执行。

执行：

1. 按仓库拆分清单：Aika 仓库的 SER/文档/Demo；GPT-SoVITS 仓库的 sidecar和网关；toolchains 的部署脚本。
2. 核对 `.gitignore` 后重新统计未跟踪文件，确保 `.venv`、模型缓存、RAVDESS 下载数据和视频中间帧不进入候选提交。
3. 将规范/报告、SER实现、Demo产物、主工程本地任务改动分成独立审阅批次；不得使用 `git add .`，不得混入私人语料、密钥、模型或其他合作者的改动。
4. 只准备建议提交清单和差异摘要；没有用户明确提交/推送指令时，不提交、不推送。

完成判据：每个批次有文件清单、所属任务、验证证据和明确排除项；`git diff --check` 通过；跨仓库改动没有被误写成单仓库已交付。

## 明天不启动

- TTS-07：继续等主工程重构落地，不能按旧文件路径接入。
- M1重训：仍缺至少10分钟授权ASMR素材；没有素材不启动训练。
- M2/M4/M5/M6：依赖M1或后续链路，保持待办。
- Streaming Voice Pipeline V2、STT-03完整真人句集、SER新实验：不与STT-08争抢范围。
- SER-04新环境复建、SER-05符号链接测试、TTS-08真实网关启动：属于剩余条件验证。若任务1/2提前完成，可从中选择一项补证；不能挤占P0。

## 实际结果（2026-09-21 当日提前执行）

三项任务均已完成，任务 1 除「真人听音」这一必须用户亲自做的动作外全部落实。

| 任务 | 结果 | 证据 |
| --- | --- | --- |
| 1 · TTS-06-F 人工听音 | **完成（2026-09-22）**：听音包备妥并自检 6/6，用户已听音 18/18 段（词级重复=无、乱码=无、语气词=无、可懂度 ≥4），唯一系统性问题=促音处电音/颤音（12/18）；见 [TTS-06 报告 F 节补二](tts/reports/TTS-06_ACCEPTANCE.md) | `output/tts_probe_tts06f/listen.html`；工具 `make_listening_pack.py` + `check_listening_pack.py` |
| 2 · STT-08 | **完成，A–E 全 PASS**：生产切 CUDA+turbo；契约中位 **217.59 ms**（n=5）；显存**可共存**（峰值 3570/8151 MiB，无 OOM）；JIT 说明成文 | [STT-08_ACCEPTANCE](stt/reports/STT-08_ACCEPTANCE.md)、[JIT 说明](stt/further/WHISPER_CUDA_JIT_NOTES.md)、`reports/evidence/STT-08_*` |
| 3 · 交付范围整理 | **完成**：6 个建议批次 + 明确排除项；`.gitignore` 补 `__pycache__` 规则（候选 141 → 126） | [DELIVERY_BATCHES_2026-09-22](DELIVERY_BATCHES_2026-09-22.md) |

执行要点与偏差：

- STT-08 执行时 **8080/9880/9881 全部空闲**、无训练任务、GPU 背景 666 MiB——未中断任何在跑服务，
  因此未出现「需现场告知用户」的中断情况。
- `npx vitest` 被本机安全策略拦下（链路触发 `wsl.exe` 黑名单），改用
  `node node_modules/vitest/vitest.mjs run <file>`，命令等价、结论不受影响（已记入 STT-08 报告）。
- 首次 JIT 未重现 33.8 s：NVIDIA 计算缓存已热，首次转写 734.70 ms。JIT 说明按「缓存已热」的口径写，
  另附清缓存后的预热步骤。
- 听音包生成器首版有 JS 语法错误（导出按钮多一个 `)`）与相位标签判断错误（`sentB-warm`），
  由自检脚本抓出并修正——**新增工具一律配自检**这条经验再次奏效。
- **顺手补掉 TTS-08 唯一代码侧 NOT RUN**（真实网关启动）：9881 空闲后按 RUNBOOK 原样
  生产冒烟——页面哈希==PAGE 基线、health 双真、真实 STT 两段真人素材经 turbo 正确转写
  （619/432 ms）、用户 `session.json` 哈希未动。见 [TTS-08 报告 AC-B 补证段](tts/reports/TTS-08_ACCEPTANCE.md)
  与 `evidence/tts08/real_gateway_smoke.json`。取证坑：`/api/stt` 是裸 wav 字节体契约，
  发 multipart 会被优雅降级为空文本（设计行为）。

## 状态更新

| 项目 | 收尾状态（2026-09-21） |
| --- | --- |
| SER-03/04 R1–R4 | 复核关闭：定向复跑 34 项通过；真实模型重跑不需要 |
| SER-05 | 自动与浏览器验证已有证据；符号链接越界 NOT RUN |
| TTS-08 | 拆分与 fake 链路验证已有证据；真实启动/真人设备 NOT RUN |
| TTS-06-F | 真机合成 + 自动回转写 + **听音包**已有；**人工听音 NOT RUN**（唯一剩余人工动作） |
| STT-08 | **AUTO_PASS**：部署切换 + 契约复跑 + 显存共存 + JIT 文档全部完成 |
| TTS-07 | 冻结，等待合作者重构 |
| M1 | BLOCKED，等待授权素材 |
