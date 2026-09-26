# NEXT-01 实际契约映射（CONTRACT_MAP）

状态：AUTO_PASS（2026-09-19）。把 [CONTRACTS](CONTRACTS.md) v0.1 的设计符号逐项映射到已核实的上游类型/端口，并给出证明测试。带 ⚠ 的语义差异必须在对应 SPEC 内以薄适配或契约用例处理。

| 设计符号（CONTRACTS.md） | 上游真实符号（路径已核实） | 映射与证明 |
| --- | --- | --- |
| `Scope{sessionId,turnId,generation}` | `TurnScope{characterId,sessionId,turnId,generation}`（contracts/index.ts:17） | 多 `characterId` 字段；Next 侧 Scope = 上游 TurnScope 投影。证明：`tests/next/turnController.contract.test.ts`（sameScope 全字段比较） |
| 轮次/generation 由权威运行时分配；新提交取消旧轮 | `TurnController.begin()` 先 `cancel()`（abort+generation+1）；`accepts()`/`sameScope()` 过滤 | 证明：同上（新提交取消旧轮、retry generation 严格递增、显式 cancel 语义） |
| 终态恰好一次；终态后不接受 delta | `TurnController.playback()`：`ended` 消费轮次，`stopped`/`error` 额外 abort；终态后 accepts=false | 证明：`tests/next/turnController.contract.test.ts`（terminal events consume the turn exactly once；stop/error abort） |
| 取消/迟到合作方过滤（非合作 Provider 迟到也被作用域过滤） | `DialoguePipeline.current()`+`belongs()`+`StaleTurnError`（core/dialogue-pipeline.ts:33-49,40） | 证明：`tests/next/pipeline.contract.test.ts`（迟到的 provider 回复：旧轮 cancelled、不落库、无 reply 事件） |
| `TurnPort.submit/cancel/subscribe` | 上游无单端口等价物；组合为 `DesktopCommand{submit_text,start_voice,cancel…}`（contracts/index.ts:205）→ `BackendSession`/`DesktopRuntime` → `TurnController` | ⚠ TurnPort 是 Next 薄适配（NEXT-04），不做第二套轮次状态机 |
| `TurnInput.clientRequestId` 会话内幂等 | `TurnInput.clientRequestId` 已存在（contracts/index.ts:21，“Echo of a desktop voice-start intent”） | ⚠ 上游未做幂等去重（回显语义）；幂等保证由 NEXT-04 适配层补，先写失败契约用例 |
| 事件先订阅，submit resolve 前不丢首事件 | `DialoguePipeline.emit`（构造注入）+ `DesktopEvent` 流；UI 订阅先于 submit | 证明：`tests/next/pipeline.contract.test.ts`（reply/error 事件断言）；订阅时序用例归 NEXT-04 |
| `ContextMessage` | `ConversationMessage`（contracts/index.ts:76） | 直接复用；证明：memory.contract.test（append/context 往返） |
| `DialogueAdapter.stream` 异步流 | 上游端口为请求-回复式 `DialogueProvider.reply`（contracts/index.ts:188）；SSE 流式存在于 provider 传输层内部（adapters.test 的 byte-split SSE fixture） | ⚠ delta 流是传输层细节而非端口语义；NEXT-03 的流式 adapter 在 transport 层实现，端口保持 `reply` |
| `ProviderConfig`/credentialRef | `EndpointConfig{endpoint,model,apiKey,authorizer}`（providers/transport.ts:10）+ `config/providers.example.json` models.*（credentialFile 外部绝对路径）+ `denyPaidCalls` 默认拒绝付费 | credentialRef↔credentialFile 映射与 SecretStore 归 NEXT-02；授权语义（CallAuthorizer）KEEP |
| `AikaProfile` 静态角色 | 上游角色 prompt 硬编码在 `companion/prompts.ts`；注入点为 `ContextOptions.prompts`（memory/context.ts）| ⚠ 无 profile 存储；NEXT-02 以 settings-store+prompts 注入实现，不复制第二份 Prompt |
| Context 预算/纠正/遗忘 | `assembleContext`+`ContextOptions{countTokens,relevance,inputTokenBudget,…}`；`SqliteMemoryPort`+dynamics/lifecycle 组 | 证明：`tests/next/memory.contract.test.ts`（abort 边界、共享 recent 流特征化）+ 上游 release 组 |
| 「会话隔离」 | ⚠ 上游 recent 为陪伴者共享历史流，不按 sessionId 分区；会话隔离指轮次状态隔离（TurnController 实例/scope 过滤） | 设计语义收窄记录于此：Timeline 分页按 sessionId 查询（NEXT-05），Memory 层不新增分区，避免与上游 recent 重复注入（RPD §2） |
| `ChatEvent`/`TimelinePort` | 已实现：`management/aika-timeline.ts`（`AikaTimelineStore`：独立 SQLite 表、eventId 幂等/冲突、稳定 sort_key 分页、redact tombstone；`AikaTimelineRecorder`：订阅 TurnPort accepted/reply/terminal，≤3 次有界重试） | 证明：`tests/next/aikaTimeline.test.ts`（05-A～05-F） |
| `AsrSegment`（segmentId/index 聚合） | 上游 `CapturePort/CapturedInput`（media/capture.ts:5-14）整段捕获，无段模型 | ⚠ NEXT-06 在输入侧薄适配段语义；STT segmentId 不当 turnId（上游 generation 才是） |
| `SpeechInputPort/SpeechOutputPort/SpeakRequest` | `CapturePort`、`PlaybackPort.play/stop`+`PlaybackEvent`（contracts/index.ts:191-198）、`desktop/playback-controller.ts` | 打断=TurnPort.cancel+playback.stop 的组合已有 generation 过滤；句序/交付状态语义归 NEXT-06 |
| `MediaAsset` 临时媒体 | `MediaAsset{temporary:true}`+`MediaStorePort.releaseScope`（contracts/index.ts:28,222） | 证明：pipeline 各终态 `released` 断言（成功/失败/取消均释放） |

## 与上游基线的行为差异记录（本次特征化实测）

1. 显式 `cancel()` 后再 `begin()`，generation 增加 2（begin 内部先 cancel）——Next 适配层不得假设 +1。
2. 无 reason 的 `abort()` 在记忆边界抛平台 AbortError（`checkAbort` 回抛 `signal.reason`），`memory_cancelled` 标记仅在无 reason 时出现。
3. recent 上下文跨运行会话共享（见上表「会话隔离」行）。

以上均为上游原版行为，未修改；后续 SPEC 的适配层必须按此对齐，不得静默改语义。
