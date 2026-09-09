# S1 LLM 回复 Runtime 阶段验收报告

- 阶段 / SPEC 版本：S1 / `S1_VOICE_RUNTIME.md`（2026-09-10）
- 日期：2026-09-10
- 验收人：Codex 工程执行任务；原任务已批准当前 LLM 范围
- 修复前 commit：`fdb735bcb40dc6aa3ffcdd3ba3b39c8fa425eaed`
- 变更归属：本报告仅覆盖本次 S1 LLM 范围与后置项；既有用户改动不在本次提交中
- 阶段范围：**当前主线只验收 LLM 文本回复；语音实机 AC03–AC07 后置**
- 执行任务自测：**已完成**
- 原任务验收 / 批准：**已通过（当前 LLM 范围）**；S1-AC03–AC07 继续 DEFERRED，不宣称声学/真人通过
- 技术状态：S1-LLM01/02 生产会话路径与 Provider 流式 fixture 已通过定向自动测试；Tauri 构建已通过；真实设备与声学验收按用户决定后置

## 修订后 LLM 门槛与证据

| ID | 生产路径要求 | 当前证据与结果 | 状态 |
| --- | --- | --- | --- |
| S1-LLM01 | 调用生产 `useCompanionSession.send(content, "text")`，不传 `VoiceTurnRequest`；合法回复可展示、保存，下一轮可继续 | [`useCompanionSession.integration.test.ts:251`](../../../../aika-crossplatform/src/hooks/useCompanionSession.integration.test.ts:251) 驱动真实 Hook；文本回复完成后检查 Hook 展示与 storage 落库，并连续发送第二轮。测试未创建 TTS 或 playback callback，定向结果 3/3 passed | **自测通过，待原任务验收** |
| S1-LLM02 | 生产 Provider 适配覆盖分片、转义、半截 JSON、首片前回退、已输出后断流与取消；失败不形成完整成功回复，下一轮可用 | [`providerClient.test.ts:123`](../../../../aika-crossplatform/src/services/providerClient.test.ts:123)、[`:164`](../../../../aika-crossplatform/src/services/providerClient.test.ts:164)、[`:176`](../../../../aika-crossplatform/src/services/providerClient.test.ts:176)、[`:194`](../../../../aika-crossplatform/src/services/providerClient.test.ts:194)、[`:203`](../../../../aika-crossplatform/src/services/providerClient.test.ts:203)；会话错误/断流边界见 [`useCompanionSession.integration.test.ts:297`](../../../../aika-crossplatform/src/hooks/useCompanionSession.integration.test.ts:297)。联合定向结果 2 files / 19 tests passed | **自测通过，待原任务验收** |

本轮 20 条 `Invoke-RestMethod` DashScope 请求只作为 endpoint 联通补充，不计入 S1-LLM01/02 的生产会话证据。

## 设备、Provider 与数据边界

- Node.js：`v24.18.0`；npm：`11.16.0`
- `rustc` / `cargo`：已安装官方 `stable-x86_64-pc-windows-msvc`（Rust 1.98.1 / Cargo 1.98.1）；用户 PATH 已加入 `%USERPROFILE%\.cargo\bin`，本轮构建命令显式确认使用该目录
- Windows 硬件查询被权限拒绝；本报告不猜测 CPU/GPU 型号
- 麦克风、TTS 声学回采、耳机/外放：本轮不执行，统一登记为后置真人验收；不将缺失的实机样本写成 PASS
- 输入引擎：自动测试覆盖 Web Speech 事件契约；本地 Whisper 代码路径有序列/时间实现，但本轮没有运行中的 `127.0.0.1:8080` 服务
- TTS：代码级 fake/队列测试使用 `webSpeechOutput` 契约；真实声学播放与回采后置到真人验收
- LLM Provider：用户授权使用 DashScope `qwen-plus` 做 20 条本地转录模拟，20/20 成功；没有把该模拟延迟当作实机首音频或调度延迟
- 随机种子 / 固定台词：自动测试使用固定 fixture；本轮另用用户提供的前 20 条固定转录做 Provider 联通模拟，实机 20 轮未运行

## 修复前冻结目标

目标已在修改代码前登记于 [`S1_BASELINE.md`](S1_BASELINE.md)：

- 调度开销 P95 ≤ **250 ms**。
- 首音频绝对 P50/P95：必须在真人验收时用同设备、同输入引擎、同 Provider/TTS 参数补测修复前/当前对照；本轮暂不注册绝对数值，**不阻塞当前工程阶段**。
- 取消安全性：旧轮不得播放、追加完整回复、写入完整 assistant 或启动记忆抽取；已展示片段只能标 `interrupted`，上下文不得视为完整回复。

## 自动检查与逐项 AC

| AC ID | 方法 / 命令 | 实际结果 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| S1-AC01 | `npm test`；ASR 序列、VAD 末端时间、迟到 ASR 回合 fixture、真实 Hook harness | 29 个测试文件、287 个测试通过（退出码 0）。`asrSegments` 按音频序号释放乱序结果；VAD 暴露 `lastVoiceSample`；Hook harness 驱动真实 pending ASR/说话状态，等待在途集合清空后只提交一次并检查 segment→turn 关联 | **PASS**（自动确定性契约） | [`asrSegments.test.ts`](../../../../aika-crossplatform/src/domain/asrSegments.test.ts)、[`turnEnd.test.ts`](../../../../aika-crossplatform/src/domain/turnEnd.test.ts)、[`vadSegmenter.test.ts`](../../../../aika-crossplatform/src/domain/vadSegmenter.test.ts)、[`useVoiceConversation.integration.test.ts`](../../../../aika-crossplatform/src/hooks/useVoiceConversation.integration.test.ts) |
| S1-AC02 | `npm test`；迟到 TTS `onEnd`/chunk、AbortSignal、重复取消、中断上下文、会话持久化与存储竞争 fixture | 旧队列 generation 结果被屏蔽；首句 TTS 失败后续句仍可播放；全 TTS 失败不按听过收尾；Provider 取消不 fallback 重发；真实 Hook/会话 harness 覆盖生成中取消、播放 drained 前取消、新轮成功；中断 assistant 只保存 `completion=interrupted`，不进入 `toCompanionTurns`；语音完整回复延迟到播放 drained 才持久化/启动记忆 | **PASS**（自动确定性契约） | [`speechQueue.test.ts`](../../../../aika-crossplatform/src/services/voice/speechQueue.test.ts)、[`providerClient.test.ts`](../../../../aika-crossplatform/src/services/providerClient.test.ts)、[`conversation.test.ts`](../../../../aika-crossplatform/src/domain/conversation.test.ts)、[`useVoiceConversation.integration.test.ts`](../../../../aika-crossplatform/src/hooks/useVoiceConversation.integration.test.ts)、[`useCompanionSession.integration.test.ts`](../../../../aika-crossplatform/src/hooks/useCompanionSession.integration.test.ts)、[`messagePersistence.test.ts`](../../../../aika-crossplatform/src/services/storage/messagePersistence.test.ts) |
| S1-BUILD | `cargo test --manifest-path src-tauri/Cargo.toml`；`npm run tauri build` | Rust 单测 5 passed / 0 failed；前端 production build、Rust release、Windows MSI 与 NSIS 安装包全部成功。产物：`src-tauri/target/release/aika-crossplatform.exe`、`src-tauri/target/release/bundle/msi/Aika_0.3.0_x64_en-US.msi`、`src-tauri/target/release/bundle/nsis/Aika_0.3.0_x64-setup.exe` | **PASS**（本机构建门禁） | [`S1_COMMAND_LOG.md`](evidence/S1_COMMAND_LOG.md) |
| S1-AC03 | 实机 20 轮固定中文/日语/英语/混说语料，含短停顿与犹豫 | 真人麦克风 20 轮按用户决定后置，不把本地模拟样本冒充实机结果 | **DEFERRED（真人验收）** | [`HUMAN_ACCEPTANCE.md`](../HUMAN_ACCEPTANCE.md)；后续补真人记录 |
| S1-AC04 | 实机时序报告；记录 `speechEnd/asrFinal/turnCommitted/firstText/firstAudio`，计算 P50/P95 | `firstAudio` 当前只能作为引擎代理指标；真实首音频与同设备修复前基线后置真人验收 | **DEFERRED（真人验收）** | [`voiceRuntime.ts`](../../../../aika-crossplatform/src/domain/voiceRuntime.ts)、[`useVoiceConversation.ts`](../../../../aika-crossplatform/src/hooks/useVoiceConversation.ts)、[`HUMAN_ACCEPTANCE.md`](../HUMAN_ACCEPTANCE.md) |
| S1-AC05 | 实机 10 次打断（生成中 5、播放中 5），测检测到打断→停止播放 P95 及首词截断 | 自动代码已接 AbortSignal、turn epoch、queue stop 与迟到屏蔽；真实麦克风/播放链路的 10 次打断按用户决定后置 | **DEFERRED（真人验收）** | [`useVoiceConversation.ts`](../../../../aika-crossplatform/src/hooks/useVoiceConversation.ts)、[`speechQueue.test.ts`](../../../../aika-crossplatform/src/services/voice/speechQueue.test.ts) |
| S1-AC06 | 实机权限拒绝、ASR 断开、LLM 断流、TTS 失败、关页重开 | Provider 模拟、自动错误路径与 Tauri 构建均已通过；真实权限/设备/ASR/TTS 场景按用户决定后置，文字退路仍保留 | **DEFERRED（真人验收）** | [`providerClient.test.ts`](../../../../aika-crossplatform/src/services/providerClient.test.ts)、[`speechQueue.test.ts`](../../../../aika-crossplatform/src/services/voice/speechQueue.test.ts)、[`useVoiceConversation.ts`](../../../../aika-crossplatform/src/hooks/useVoiceConversation.ts) |
| S1-AC07 | 耳机及外放各 10 次，回声误触发打断为 0 | 自动配置保留 `echoCancellation/noiseSuppression/autoGainControl`；耳机/外放声学验证按用户决定后置，不关闭打断逻辑来换取当前阶段通过 | **DEFERRED（真人验收）** | [`audioCapture.ts`](../../../../aika-crossplatform/src/services/voice/audioCapture.ts)、[`micActivity.ts`](../../../../aika-crossplatform/src/services/voice/micActivity.ts) |

## 性能与事件

| 指标 | 样本数 | 基线 P50/P95 | 当前 P50/P95 | 目标 | 失败样本数 |
| --- | ---: | --- | --- | --- | --- |
| `turnCommitted` 调度开销 | 0 实机样本 | 未测 | 未测 | P95 ≤ 250 ms | 未测 |
| `firstAudio − speechEnd` | 0 实机样本 | 后置真人验收 | 后置真人验收 | 真人验收时登记修复前/当前绝对 P50/P95 且不回退 | 待真人验收 |
| 打断检测→播放停止 | 0 实机样本 | 后置真人验收 | 后置真人验收 | P95 ≤ 300 ms | 待真人验收 |
| 模拟转录→DashScope Provider 响应 | 20 模拟样本 | 不适用 | 1,371 / 2,491 ms | 仅参考，不是 S1 首音频/调度目标 | 0 |

运行时事件使用 `performance.now()`/音频采样换算做单调耗时，另记录 UTC 字符串；`firstAudio` 明确标记 `engine-onStart`，没有冒充真实声学开始。未保存任何隐私录音或聊天样本。

## 代码与数据变更

- 计时与输入契约：`src/domain/voiceRuntime.ts`、`src/services/voice/contracts.ts`、`src/services/voice/audioCapture.ts`、`src/domain/vadSegmenter.ts`；本地诊断收集、导出与 SPEC 指标聚合：`src/services/voice/voiceDiagnostics.ts`。
- ASR 顺序与迟到保护：`src/domain/asrSegments.ts`、`src/services/voice/whisperInput.ts`、`src/services/voice/webSpeechInput.ts`、`src/hooks/useVoiceConversation.ts`。
- 取消链：`src/services/providerClient.ts` 的 `AbortSignal`/SSE reader、`useVoiceConversation` 的 turn controller、`speechQueue` 的 turnId 与 generation。
- 中断历史：`src/domain/conversation.ts` 的 `completion/playbackStatus/turnId`；SQLite `messages` 增加 `turn_id`、`completion_status`、`playback_status` 并提供幂等逐列迁移；旧消息缺字段时按完整旧数据读取。
- 取消后的持久化边界：语音 assistant 完整消息等播放 drained 后才持久化并启动背景记忆；取消只保存用户消息与已展示的 `interrupted` 片段，不启动记忆抽取。
- 回归测试：`src/hooks/useVoiceConversation.integration.test.ts`、`src/hooks/useCompanionSession.integration.test.ts`、`src/services/voice/voiceDiagnostics.test.ts`、`src/services/storage/sqliteStorage.test.ts`、`src/services/storage/storageCompatibility.test.ts`、`src/services/storage/messagePersistence.test.ts`，以及既有队列/Provider/回合/上下文测试扩展。

未修改 Android `app/`、Live2D、人格/Mode、论文研究或后续 SPEC；未提交、未推送。

## 问题、限制与阶段结论

1. 初始环境确实没有 Rust 工具链，导致修复前 `npm run tauri build` 退出码 1（`cargo metadata ... program not found`）。本轮已安装官方 `stable-msvc` 工具链并确认用户 PATH；随后 `cargo test --manifest-path src-tauri/Cargo.toml` 以 5 passed / 0 failed 通过，`npm run tauri build` 以退出码 0 完成前端、Rust release、MSI 与 NSIS 打包。前端 `npm test` 与 `npm run build` 也通过。
2. 本轮使用用户提供的本地 MP3 与 DashScope key 完成 20 条模拟 Provider 请求（20/20）；真实 TTS 声学回采、麦克风、耳机/外放、修复前同设备基线和人工记录按用户决定后置到真人验收。AC03～AC07 当前不宣称实机 PASS，但也不再作为本阶段工程阻塞。
3. `firstAudio` 在当前 Web Speech 契约中只能取引擎 `onStart` 代理指标；`playbackStopped` 现在明确标记为 `status=stopRequested` / `precision=proxy`，不冒充真实声学停止；必须由外部录音/实机校验声学延迟。
4. 自动测试使用 fake input/provider/storage/TTS 只验证生产编排路径和取消边界；没有伪造真实硬件或声学结果。失败样本、录音与聊天正文均未写入仓库；脱敏命令摘要见 [`evidence/S1_COMMAND_LOG.md`](evidence/S1_COMMAND_LOG.md)。真实验收清单保留在 AC03～AC07，后续由真人一次性补测。

**执行任务自测：完成。原任务批准：已通过（当前 LLM 范围）。** 本轮完成 S1-LLM01/02 的生产路径定向自测与既有构建门禁；S1-AC03～AC07 明确后置为真人验收，不宣称声学/真人通过。提交完成后等待原任务派发 S2，本执行任务不自行开始 S2。
