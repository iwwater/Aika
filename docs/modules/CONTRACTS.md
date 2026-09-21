# 模块接口与责任

这些是稳定的逻辑接口；现有函数可通过适配器兼容，不要求一次性重命名所有源码。源码仍在 `aika-crossplatform/src/`，项目文档统一位于根 `docs/`。

| 接口 | 所有者 | 输入 | 输出/保证 |
| --- | --- | --- | --- |
| SpeechInput | STT | start/stop/cancel、输入语言策略 | speechStart、segmentFinal、turnReady、error；带 sessionId/segmentId、单调音频时间及精度 |
| CompanionRuntime | LLM | submit(text, source, mode)、cancel(turnId)、交付状态通知 | turnId、replyDelta、replyCompleted、failed/cancelled、只读状态订阅 |
| SpeechOutput | TTS | enqueue(turnId, sentenceId, text, language, style)、stop(turnId) | started、sentenceCompleted、drained、stopped/error；代理播放指标须标注 |
| Presentation | 前端 | 用户操作、Runtime/STT/TTS 状态 | 展示与操作命令；不自行抽取 Memory、调用 Provider 或计算检索排名 |

- STT `segmentId` 只代表识别段，不能当对话 turnId；CompanionRuntime 为提交的对话分配 turnId。新提交不得受旧轮 busy 残留阻塞。
- 所有下游异步事件带 turnId，取消幂等；旧轮结果不得覆盖新轮。STT 的取消输入会话不能被误用于清掉用户正在说的新片段。
- 文本回复在生成完成后可保存，不依赖 TTS。语音回复的 generated 与 delivered 分开；TTS 提供进度/终态，LLM 决定保存为 complete/interrupted/cancelled。拿不到真实播放范围时标 unknown，不伪称用户已听过。
- 前端语音桥接负责把“用户重新开口”转为 Runtime cancel + TTS stop，并继续接收 STT；三模块完整联动属于 INT-02，不要求任一模块小阶段启动另外两个真实服务。
- LLM 内部统一 ReplyEnvelopeV1：schemaVersion、mood、replyText、translation、memoryCandidates、actions，允许 sticker/expression/motion。旧协议由 LLM 适配；前端不解析未闭合模型 JSON。
- 表达参数是受控枚举，TTS 不接受任意脚本。未知动作/工具不得执行；当前没有完整外部 Tool Runtime。

## 共享文件

| 当前文件/区域 | 主责 | 修改约束 |
| --- | --- | --- |
| services/providerClient、domain/prompt/character/memory/conversation、services/storage、useCompanionSession | LLM | 小阶段只测试改动涉及的 LLM/存储行为 |
| services/voice/input*、whisper*、webSpeechInput、audioCapture、sileroVad；domain/asrSegments/vadSegmenter/turnEnd | STT | 使用假时钟/录音 fixture，Provider/TTS 不作为依赖 |
| services/voice/speechQueue、webSpeechOutput；domain/sentences | TTS | 使用输出引擎 stub 与固定文本，不调用 LLM |
| components、App、样式、domain/captionHighlight、界面设置 | 前端 | 用 fake Runtime/STT/TTS 状态验收交互 |
| services/voice/contracts、domain/voiceRuntime、useVoiceConversation、voiceDiagnostics | 跨模块契约/桥接 | 按变更行为标明归属；跨边界部分进入 INT-01/02，禁止各模块复制一套契约 |

新增模块接口允许在本模块增加类型与 adapter；破坏共享契约时先记录版本/兼容方式及受影响方，只跑必要的契约检查，不用“模块内通过”掩盖未完成联调。

## 内核契约（CORE-01…06 冻结，v1）

内核是装配层，不是业务层；下面几条是**共享契约**，任何模块的消费方式都受它们约束。

| 契约 | 所有者 | 内容 | 受影响消费者 |
| --- | --- | --- | --- |
| 服务注册表与插件契约 | CORE（`src/kernel/`） | token（不透明标识）、factory、plugin（requires/optional/provides）、生命周期。注册表对外只读，写入只能经插件的作用域 registrar；`activate` 返回后 registrar 立即失效，未声明即抛错 | 所有注入服务的模块、宿主插件、`src/app/` |
| `resolve()` 只允许出现在三处 | CORE | 组合根（`app/composition.ts`）、插件 `activate`（经 registrar）、React 的 `useService`（`app/kernelContext.tsx`）。业务代码经构造参数拿依赖 | 全部模块；由 `kernel/architecture.test.ts` 静态扫描守住 |
| token 分散所有权，无中央清单 | 各接口所在模块 | 每个 token 定义在它描述的接口旁边并由该模块导出；不存在 `CoreTokens` / `HostCapabilities` 之类总表，也不存在汇总桶文件 | 新增能力方、CORE-02-D 扫描 |
| 「能力缺失即 token 不注册」 | 宿主插件 | 平台没有某能力时该 token 根本不注册；消费方在 `optional` 里声明并 `tryResolve`，拿到 null 就降级、隐藏入口，不弹错、不阻断启动。缺失是常态 | Remote、麦克风、表情包、记忆 V2、云 TTS 等 |
| 单一编排路径 | CORE（`CompanionRuntime`） | 对话轮次的顺序、取消、终态**只**由 `CompanionRuntime` 的 `RuntimeEvent` 保证；内核事件不含 turn 语义；`presentation/` 里的 Presenter 消费它，不再有第二套编排 | 前端 Hook/组件、Remote 手机入口、LLM-04 后台维护 |
| `runtimeTurnId` 与旧 `turnId` 并存 | LLM + 存储 | `ChatMessage.turnId?: number` 是语音回合号，已落库、不改语义；新增 `ChatMessage.runtimeTurnId?: string` 是 Runtime 的轮次 id。旧数据缺 `runtimeTurnId` 正常，不得回填假值、不得把 undefined 当 0 | 前端桥接、Remote、消息存储、INT-01 兼容检查 |
| 展示层依赖注入 | 前端 + CORE | Presenter 由注册表提供（`presentation.companion` / `presentation.voice`），依赖经构造参数注入；Hook 只订阅快照与派发命令，不 import `services/` 实现 | 前端 Hook/组件、后续能力插件 |

版本：以上为 v1，随 CORE-06 冻结。旧库中残留的 `core.orchestrator` 设置值会被当作未知设置忽略，不报错、不迁移。变更这些契约须记录版本、兼容方式与受影响消费者，并在 INT-01 安排消费者兼容测试。

### v1 之后的追加（2026-09-11，向后兼容，不改 v1 语义）

补齐 CORE-05-G 输出侧时动了 TTS 侧的接口。三处都是**可选追加**，没有改变任何已有字段的语义，现有消费方不改一行也照常工作：

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `SpeechOutputEngine.prefetch?(request)` | `services/voice/contracts.ts` | 可选方法。调用方一律写 `engine.prefetch?.(…)`，没实现就是没有这一步；系统合成不实现它 | `speechQueue`（唯一调用方）；两个输出引擎 |
| `VoiceEngineKind` 增加 `"cloud-tts"` | 同上 | 联合类型加一个成员，既有成员不变 | 任何对 `kind` 做穷举的地方（当前只有测试与诊断显示） |
| `SpeechQueueOptions.speed?` | `services/voice/speechQueue.ts` | 可选。不设时等于 1，`rate` 计算结果与此前逐字相同 | `defaultSpeechEngines`；`VoicePresenter` 经 `createQueue` 间接使用 |

`defaultSpeechEngines()` 同时增加了两个可选入参（输出配置、`HttpFetch`）。默认 `DEFAULT_VOICE_OUTPUT.output = "system"`，不传参时装出来的仍是 `webSpeechOutput`，生产装配行为不变。

### v1 之后的追加（2026-09-12，CORE-08，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `AikaStorage.deleteMessages(ids)` | `services/storage/contracts.ts` | **必选**方法，两个实现都提供（`sqliteStorage`、`localStorageStorage`）。既有成员语义一字未改；没有调用方的代码不受影响 | 目前无生产消费者（FE 侧重试/撤回/Rewind 的前置）；`AikaStorage` 的任何新 fake 必须实现它，`storage.conformance.ts` 会验 |

语义边界（写进用例包，不只是约定）：未知 id 静默忽略、重复删幂等、空数组是 no-op；删除后 `listMessageTimestamps` / `countMessagesSince` / `countProactiveSince` 跟着变；**不**连带作废摘要、**不**连带删记忆——与 `clearMessages()` 的连带作废明确区分。`RuntimeStorage`（`companionRuntime.ts` 里的窄接口）不含删除能力，保持不变。

### v1 之后的追加（2026-09-12，LLM-06/07 Trace，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `TraceSinkToken` / `TraceRecorderToken` / `TraceSettingsToken` | `services/trace/tokens.ts` | 全是新增注册。Trace 是**可选能力**：不装 `tracePlugin` 时这三个 token 根本不注册，消费方在 `optional` 里声明并 `tryResolve`，拿到 null 退回 `NO_TRACE` | `runtimePlugin`（目前唯一消费者）；后续工作台页面 |
| `CompanionRuntimeOptions.trace` | `services/runtime/companionRuntime.ts` | 可选入参，不传等于 `NO_TRACE`。既有 `onTrace` / `TurnTrace` 语义**一字未改**——Trace 是并行的第二条路，不是替换 | 只有 `runtimePlugin` 传它 |
| `AikaStorage.sqlExecutor` | `services/storage/contracts.ts` | **可选**成员，沿用 `memoryV2?` 的「能力缺失即不提供」模式：SQLite 实现有，localStorage 实现没有并在用例包里如实声明 `unsupported`。拿到它的代码负责自己的表，不许改别人的表、不许绕过既有方法改消息与记忆 | Trace 落盘；后续存储浏览页 |
| `SETTING_KEYS.traceEnabled` / `traceIncludeText` | 同上 | 新增键。旧库里没有这两个键时用按构建取的默认值（开发开、生产关；读不到构建标记按关） | 设置页（F2 未做） |

| `VoiceTurnRequest.runtimeTurnId` | `domain/voiceRuntime.ts` | 可选字段（LLM-08）。与既有 `turnId`（语音回合号 number）**是两回事，不要合并**；不设它的调用方照常工作，只是不记 `tts` 事件。聊天页点朗读没有轮次，那里必须留空而不是编一个 | `CompanionPresenter`（写入）、`VoicePresenter`（读取） |

| `PluginRecord.requires` / `optional` / `provides` | `kernel/diagnostics.ts` | 诊断输出新增三个必填字段（CORE-09），都是 token **key 字符串**——不给 token 实例，拿到实例等于能绕过注册表 resolve。登记时记录，所以 `pending`/`failed`/`skipped` 的插件也带着声明。插件契约 `AikaPlugin` 未改 | 对 `describe().plugins` 做深相等断言的测试（仓库内一处，已更新）；F6 数据流图 |

| `TraceEventKind` 增加 `"reply"` | `domain/trace.ts` | 联合类型加一个成员（LLM-09），既有七种事件字段未动。对 kind 做**穷举**的地方必须补分支——仓库内两处（`traceView` 的标签表、`TracePage` 的摘要 switch），都已补，且因为是穷举而不是带 default 的兜底，漏不掉 | 任何消费 Trace 事件的页面与统计 |

### v1 之后的追加（2026-09-12，FE-11 记忆管理页，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `MemoryAccess.onChanged(listener)` / `notifyChanged()` | `services/memory/tokens.ts` | 接口新增**必选**成员，由 `memoryPlugin` 实现；`MemoryRepository` 与 `onInvalidate` 的语义一字未改。任何 `MemoryAccess` 的 fake 都要补这两个成员（仓库内一处测试 fake，已更新） | `memoryPlugin`（扇出）、`companionPresenter`（订阅后重读右栏列表、自身改动后喊一声）、`memoryPresenter`（管理页改完调用） |

分工必须分清，否则等于把摘要作废滥用成刷新信号：`onInvalidate` 的语义是**摘要作废**，只在 `forget` 时发；`onChanged` 的语义是**记忆内容变了**（确认、编辑、删除都算）。删除时两个都发，**顺序是先 invalidate 后 changed**——摘要先作废，界面再重读，读到的才是作废之后的状态。`notifyChanged()` 只发 changed 这一组：确认与编辑不该让摘要失效。

### v1 之后的追加（2026-09-12，LLM-10 Provider usage，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `ProviderUsage` | `domain/providers.ts` | 新类型。放 domain 而不是 providerClient 旁边：Runtime 与 Trace 都要认识它，让编排层为拿类型去 import 一个 HTTP 客户端等于把实现拖进来 | Runtime、providerAdapter、后续 F9 成本页 |
| `ProviderStreamEvent` 增加 `{ type: "usage" }` | `services/runtime/companionRuntime.ts` | 联合类型加成员，既有三种事件语义一字未改。对 kind 做**穷举**的地方要补分支——仓库内一处（Runtime 事件循环，已补）；`provider.conformance.ts` 只断言特定事件，不受影响 | 任何自实现 `RuntimeProvider` 的适配器（不发这个事件＝不报用量，照常工作） |
| `ProviderRequestOptions.onUsage` | `services/providerClient.ts` | **可选**入参，不传等于不收；至多回调一次（内部退回非流式时合并后再叫） | providerAdapter；记忆抽取等其它调用方不传 |
| `ProviderHttpError`（带 status） | 同上 | `extends Error`，错误文案一字未改；靠 `instanceof Error` 或 message 判断的代码不受影响 | 流式重试判定 |

请求体变化：openai-compatible **流式**多带 `stream_options: { include_usage: true }`（其余三家流式本来就报用量，不多塞）。中转站 400/422 掉它且还没吐内容时，去掉该字段再流式重试一次，仍失败才退非流式——多出来的是一次不烧 token 的失败请求，换的是流式不退化。

Trace 事件协议本身（`domain/trace.ts` 的 `TraceEventV1`）自带 `schemaVersion`，后续加字段先冻结已有字段再扩展。**apiKey 永不入 Trace**：不是靠过滤，而是没有任何事件带 key 字段，且 `provider_request.endpoint` 的 query string 整段砍掉。

INT-01 的兼容检查项：云端合成一旦在设置页可选，`createOutputEngine` 的 `note` / `degraded` 必须送到界面，降级当错误显示——现在这两个值在 `defaultSpeechEngines` 里被丢弃。

### v1 之后的追加（2026-09-13，LLM-12 用量台账，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `UsageRecordV1` / `UsagePurpose` / `UsageCoverage` / `UsageLedgerQuery` / `UsageLedgerPage` / `RequestUsageSample` | `domain/usageLedger.ts` | 新类型（`schemaVersion: 1`）。`RequestUsageSample` 放 domain 是因为 usage 服务不许 import HTTP 客户端模块（providerClient 的调用方门禁不变） | `services/usage/*`、FE-26 成本页 |
| `UsageLedgerToken` | `services/usage/tokens.ts` | 新注册，**可选能力**：不装 `usagePlugin` 时 token 不存在，adapter/extractor 原样发请求不记账 | `runtimePlugin`、`presentationPlugin`（都 optional 声明） |
| `UsageLedgerStore` / `UsageLedgerRecorder` | `services/usage/contracts.ts` | 新端口。两个实现（`sqliteUsageLedger`、`memoryUsageLedger`）跑同一份 `usageLedger.conformance.ts` 用例包 | FE-26 经 presenter 查询（后续 SPEC） |
| `ProviderRequestOptions.onRequestUsage` / `requestPurpose` 词汇表扩展 | `services/providerClient.ts` | `onRequestUsage` 是**可选**新回调（每次物理尝试 started+终态各一条样本）；`requestPurpose` 联合类型从 `foreground\|maintenance` 扩到含 `summary\|proactive`，未声明时计量 purpose 记 `unknown`（原缺省 foreground 是在猜，属行为修正）。不传新回调的调用方行为不变 | `providerAdapter`、`extractor`（已接线）；LLM-04 的 `RequestMetric.purpose` 同步扩词汇 |
| `usagePlugin` | `app/plugins/usagePlugin.ts` | 新插件（`capabilityPlugins` 已装配）。采集开关与 Trace `enabled` 同源：关着不新写记录；保留期默认 30 天（`DEFAULT_USAGE_RETENTION_DAYS`） | FE-26；诊断经 `recorder.diagnostics()` |

语义边界：记录按**物理尝试**记（重试/回退各自 attemptId，同一逻辑请求共享 `logicalRequestId`），按 id 幂等 upsert（终态覆盖开始登记）；缺末包 usage/取消记 `coverage: "unknown"`，确切上报一部分记 `partial`，只报 total 保留 total 不拆分；记录不含正文/密钥/完整 URL（同模型不同 endpoint 靠 `providerId` 区分）；写失败旁路化、待写队列有界、丢弃与失败计数在 `diagnostics()` 可见；无 scope 的记录归 `USAGE_LEGACY_SCOPE` 分组，不与任何主体混算。

### v1 之后的追加（2026-09-13，RT-01 身份/来源/宿主契约，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `SourceEnvelope` / `SourceOrigin` / `SourceTrust` / `desktopEnvelope()` / `unknownEnvelopeForLegacy()` / `messageDedupeKey()` / `legacySourceOrigin()` | `domain/sourceEnvelope.ts` | 新类型 + 纯函数，不改任何既有签名。`TurnSource`（text/voice/proactive）语义一字未动。`authenticated` trust 携带不导出 brand：只有认证端口（RT-03）能构造；本地映射 `local`、历史消息一律 `unverified`+unknown 归属。RT-01 仅冻结形状与桌面适配，**尚无生产 submit 调用方**（接线归 RT-02） | RT-02 会话隔离、RT-03 权限、GW/AGT 外部入口 |
| `PrincipalIdentityV1` / `ConversationV1` / `ThreadRefV1` / `RuntimeTurnRefV1` / `AgentSessionRefV1` / `DeviceSessionV1` / `buildCapabilityMatrix()` | `domain/identity.ts` | 新类型，全部带 `version: 1`。runtimeTurn 显式声明为既有 `CompanionRuntime` turnId（uuid）的引用关系，不新增第二套 turn id | RT-02/RT-03、AGT-01、GW-04 |
| `HostLifecycle` / `createHostLifecycle()` / `HostLivenessState` | `services/runtime/hostLifecycle.ts` | 新端口（可注入心跳/租约/时钟/定时器），无生产装配调用方（宿主接线归 GW/INT-01 真实轨）；三态 online/offline/recovering 只描述本进程，**不宣称云端接管** | RT-02、GW-05、FE 工作台状态展示（后续） |
| 单 Runtime facade 门禁 | `app/runtimeFacade.test.ts` | 新增架构测试（不改变行为）：`RuntimeToken`/`companionRuntime` 的生产 import 白名单——app/composition、runtimePlugin、presentationPlugin、runtime/tokens、providerAdapter、provider.conformance | 未来 ACP/远程入口的贡献者（进白名单需审阅） |

### v1 之后的追加（2026-09-13，RT-02 会话隔离，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `AccountKeyV1`（platform,botAccount,tenant,sender）/ `ConversationScopeV1` / `canonicalScopeKey` / `canonicalAccountKey` / `LOCAL_CONVERSATION_SCOPE` | `domain/identity.ts` | 新类型+纯函数。旧数据归属 legacy 本地会话（`conversationId "local"`），可回退 | BindingService、Runtime、GW/AGT 外部入口 |
| `ChatMessage.conversationId?` / `SessionSummary.conversationId?` | `domain/conversation.ts`、`domain/summary.ts` | **可选**字段：旧数据无字段=legacy 本地，读取方归一，不回填假值 | 两个存储实现、Runtime、Presenter |
| `listMessages(limit, scope?)` / `listMessageTimestamps(scope?)` / `latestSummary(scope?)` | `services/storage/contracts.ts` | **可选**参数：不传=旧行为（单主体口径）；传了只返回该会话（local 匹配含 NULL legacy 行）。SQLite 由 12 变 16 次 try-ALTER（messages/summaries 各加 conversation_id，NULL=legacy），localStorage 版本化 JSON 同语义；升级在临时库验证 | 两个存储实现、`createScopedRuntimeStorage`、`storage.conformance` |
| `SubmitRequest.conversation?` / `cancel(turnId, scope?)` / `CompanionRuntimeOptions.createScopeView?` / `MAX_WAITING_TURNS=8` / `SESSION_QUEUE_FULL` | `services/runtime/companionRuntime.ts` | 全部可选增量：不传 conversation=legacy 本地（旧行为一字不变，含「新提交取消旧轮」立即接管时序）；跨会话提交进有界队列不取消别人的轮，满则显式 `SESSION_QUEUE_FULL`；cancel 带 scope 校验归属；每轮经 `createScopeView` 拿专属存储视图，单生成槽在 settled+存储完成后才换 scope | runtimePlugin（已接线 scopedStorage）、未来 ACP/远程入口 |
| `createScopedRuntimeStorage(storage, scope)` | `services/runtime/scopedStorage.ts` | 新函数：AikaStorage → 按会话过滤的 RuntimeStorage 视图 | runtimePlugin |
| `ContextSourceScope.conversationId?/principalId?` + `AssembleInput` 同名字段 | `services/context/contextAssembler.ts` | 可选透传字段；`memorySource` 据此守门：**principalId 非本地（含 unknown/空/外部）→ 个人记忆 0 片段**（legacy 未声明=本地行为不变） | contextSourcesPlugin 的 memorySource、未来 knowledge/environment 来源 |
| `TraceEventBase.conversationId?` | `domain/trace.ts` | 可选增量字段，runtime 6 个事件源已写入；redact 走 `...event` 透传；旧事件无字段=legacy 本地 | TracePage/inspector/统计消费方（读不到时按旧逻辑） |
| `BindingService`（issueBindingCode/claim/principalFor/unbind/list）+ `SETTING_KEYS.identityBindings` | `services/identity/binding.ts` | 新服务：一次性/限期/防暴力/解绑即失效；绑定存储损坏按「无任何绑定」fail-closed。本地可信界面签码、外部入口凭码+四元组账户键认领；外部声明 userId 无效 | RT-03 权限端口、GW-01 渠道入口、FE 绑定 UI（后续） |

### v1 之后的追加（2026-09-13，GW-01 渠道网关，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `GatewayPayload`（text/voice/image/file/command 判别联合）/ `GatewayInboundMessageV1` / `inboxKeyOf` / `validatePayload` | `domain/gateway.ts` | 新类型+纯函数。附件上限 20MB、media type 白名单、未知类型拒绝；第一版不做图像/转写理解（显式附件表示） | Gateway、GW-02 适配器、GW-03 文件端口 |
| `InboxRecordV1`（received/accepted/running/completed/failed/unknown）/ `OutboundMessageV1`（queued/sent/failed/unknown） | 同上 | 持久唯一键=平台账户+会话+messageId；出站目的地固定绑定原请求；重试上限 3（可配更低）、容量 200、TTL 24h | `channelGateway`、GW-02 |
| `ChannelGateway` / `GatewayRuntimePort` / `GatewayTransport` / `GatewayBindingPort` | `services/gateway/channelGateway.ts` | 新服务；三窄端口——适配器与 Gateway **不 import** 任何 LLM/Memory/Runtime 实现（测试内架构断言）。崩溃窗口口径：先持久接收再确认平台 offset；提交后崩溃标 unknown 绝不自动重跑；发送不确认（无幂等键声明）标 unknown 终态 | GW-02 适配器、RT-03 审批（任意新目标）、AGT |

### v1 之后的追加（2026-09-13，GW-02/GW-03 Telegram 适配与附件端口，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `parseTelegramUpdate` / `splitTelegramText` / `redactTelegramUrl` / `createTelegramPoller` / `sendTelegramSlice` | `services/gateway/telegramAdapter.ts` | 新模块（fixture 轨）：token 在 URL 路径——审计只含 method/status/retryAfter；offset 只在 Gateway 持久接收后推进；409 不自动 deleteWebhook | GW-01 ChannelGateway、宿主启停（GW-02 设置入口后续） |
| `validateAttachmentFile` / `buildControlledDownloadUrl` / `assertAllowedDownloadHost` / `downloadWithLimits` / `AudioTranscriptionPort` / `createFileTranscriptionPort` / `createTempAttachment` | `services/gateway/attachmentPipeline.ts` | 新模块：文件白名单（txt/md/json/受支持音频；image/PDF/office/压缩包明确不支持）；只收平台受控下载地址+重定向再校验；转写端口与麦克风 `SpeechInputEngine` 完全分离（注入 decode→16kHz 单声道→WhisperClient）；能力缺失明确 unsupported | GW-03 入口适配、STT 模块 |

### v1 之后的追加（2026-09-13，FE-14 远程协议内核，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `OutboundFrameV1`（reply/status/trace 判别）/`RemoteReplyV1` 白名单/`OutboundCommandV1`/`AuthenticatedCommand`/`AuthorizedTarget`/`OutboundTransport` | `services/outbound/contracts.ts` | 新类型。reply 四字段白名单投影（无 memoryCandidates）；status 只有 code/state/requestId；命令文本 4000 码点上限 | outboundGateway、FE-15/16 传输、AGT-05 |
| `createOutboundGateway` / `OutboundGatewayToken` / `outboundPlugin` / `outbound.conformance` 用例包 | `services/outbound/*` | 新服务：turnId→授权目标映射（未映射零外发）；cursor epoch+seq 单调；submit 去重（主体+会话+messageId）；trace 四门（本地采集+远程外发+主体授权+显式订阅）；慢消费者帧数/字节限额。transport 缺失启动不受阻；无授权端口不接命令（fail-closed） | FE-15/16/17、GW-04 |

### v1 之后的追加（2026-09-13，FE-17-pre 凭证与暴露策略，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `createCredentialRepository`（配对码 TTL5min/原子单次兑换/哈希存储/逐设备 rotate-revoke） | `services/outbound/credentials.ts` | 新服务，存储只留哈希；损坏按「无凭证」fail-closed | FE-15/16 宿主路由、GW-04 设备列表（复用端口不造第二套配对码） |
| `effectiveExposure` / `checkRoute` / `authenticateRequest` | `services/outbound/exposurePolicy.ts` | 纯策略：loopback 默认、LAN 显式、public 无真实 TLS 证据恒 blocked；路由白名单（SQL/秘密/opener/settings 永不进网关）；Origin fail-closed、Bearer、cookie+CSRF | FE-15/16 宿主路由、FE-17-host 验收 |

### v1 之后的追加（2026-09-13，FE-15 tauriTransport，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `createTauriOutboundTransport`（invoke/listen 桥 OutboundTransport；命令事件 outbound://command、帧经 outbound_publish invoke） | `services/outbound/tauriTransport.ts` | 新模块；不做认证（principal 由 Rust 宿主带外注入）；FE-14 conformance 用 fake invoke/listen 复跑 | FE-15 Rust handler、FE-17-host/tauri、手机页 |
| `TauriTransportOptions.gatewayEpoch?` / `.principalId?` | 同上 | **可选**字段；不传时 Rust 沿用已有 epoch、主体取 target 的 principalId。`publish` 的 invoke 参数形状为 `{input:{principal_id,connection_id,conversation_id,frame,epoch}}` | 只有 `tauriTransport.test.ts`（已同步） |
| 宿主侧远程网关与路由（`GET /api/v1/events` 长轮询 ≤25s、`POST /api/v1/commands` 202/503、`GET /api/v1/history`；旧 `/api/messages`、`/api/send` 同一鉴权门不再授予长期权限） | `src-tauri/src/gateway.rs`、`remote.rs` | 新增 Rust 模块与路由；`remote_start` 增可选 `allowed_origins`/`lan_enabled`（默认只绑 loopback）；新增 invoke `outbound_publish`/`outbound_heartbeat`/`outbound_offline`/`outbound_revoke`/`outbound_sessions` | 手机页、FE-17-host/tauri 宿主装配（**尚未接线**） |
| 缓存上限常量（500 帧 / 4MB / 256KB body / epoch 变化或 cursor 过期报 gap） | `src-tauri/src/gateway.rs` | 宿主**只做字节搬运与准入**，不做业务投影（白名单投影仍在 TS 侧 FE-14）；`gap` 如实上报不谎称连续 | 手机页重同步逻辑、FE-17-host 诊断 |

### v1 之后的追加（2026-09-13，FE-17-host/tauri 宿主装配接线，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `outboundTransportPlugin` / `hostLifecyclePlugin` | `app/hosts/plugins.ts` | 两个新宿主插件。**装了才有对应 token**：无 `host.outboundTransport` 即无 `OutboundTransportToken`（浏览器 dev 现状），无 `host.lifecycle` 即无 `HostLifecycleToken`。桌面装前者、两宿主都装后者 | `composition.ts` 启动动作、`outboundPlugin` |
| `OutboundTransportToken`（`outbound.transport`）/ `HostLifecycleToken`（`host.lifecycle`） | `services/outbound/tokens.ts`、`services/runtime/tokens.ts` | 新增两个 token。前者刻意独立成文件，让宿主层只依赖 token 与类型，不拖入 Gateway 实现 | 宿主装配、测试注入 |
| `outboundPlugin` 声明调整 | `services/outbound/outboundPlugin.ts` | `requires:[RuntimeToken]`、`optional:[HostLifecycleToken, OutboundTransportToken]`。入参加入 `fallbackEpoch?`/`commandAuthorizer?`；**`gatewayEpoch` 改由注册表里的宿主存活状态提供**（原为必填参数）——旧调用方不传 epoch 仍可用 | `capabilityPlugins()`（已默认装配）、FE-17-host 测试 |
| `OutboundTransport.ready?()` / `.close?()` | `services/outbound/contracts.ts` | **可选**方法。宿主装配后 await `ready()`（Tauri 的 listen 注册）；纯内存传输不需要 | `tauriTransport`、`wsTransport`、`composition.ts` |
| `RemoteHost.start(port, token, options?)` / `RemoteStartOptions{allowedOrigins?, lanEnabled?}` | `services/remote/bridge.ts` | **可选第三参**；不传时 Rust 侧 `unwrap_or_default()/unwrap_or(false)` = 最严档（只绑 loopback）。invoke 键用 camelCase，Tauri v2 自动映射到 Rust 的 `allowed_origins`/`lan_enabled` | `useRemoteAccess`（暂未传，行为不变）、FE-17-host 后续 |
| `createGatewayRuntimePort` / `createOutboundPluginGateway` | `services/outbound/outboundPlugin.ts` | 新增导出的组装函数：把 `CompanionRuntime` 适配成 `OutboundRuntimePort`（`mode` 经 `normalizeModeConfig` 补全、`done` 收窄）。测试可不经内核直接组装 | FE-17-host 测试、将来的远程轨 |

### v1 之后的追加（2026-09-13，GW-04 设备注册表，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `createDeviceRegistry`（能力交集协商/租约在线读时计算/reconnect epoch+cursor 窗口/authorize 独立授权口） | `services/gateway/deviceRegistry.ts` | 新服务；配对/会话/撤销复用 FE-17-pre 凭证端口；trace/审批授权默认拒绝 | GW-04 设备列表/租约体验、FE 手机页、FE-14 trace 订阅门 |

### v1 之后的追加（2026-09-13，AGT-01 AgentSession/Run，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `AgentSessionV1`/`AgentRunV1`（Session 与 Run 状态机分离）/`AgentRunEventV1`（脱敏）/`createAgentSessionManager`/`AgentAdapter` | `domain/agentSession.ts`、`services/agent/agentSessionManager.ts` | 新服务：spawn/send/cancel 幂等（startRequestId/runId）、并发上限+有界队列、时间预算、取消宽限+强制结束留实际状态、recover 标 interrupted、日志有界脱敏。真实 ACP adapter 待 AGT-03 | AGT-02 权限集成、AGT-05 任务入口 |

### v1 之后的追加（2026-09-13，AGT-02 ACP 客户端，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `parseAcpStream`/`validateProcessConfig`/`buildPermissionResponse`/`denyOptionId`/`ADVERTISED_CAPABILITIES`/`createAcpClientAdapter` | `services/agent/acpProtocol.ts`、`acpClient.ts` | 新模块：实现 AGT-01 AgentAdapter 协议面。可执行白名单+参数数组+cwd 规范化+环境最小化；request_permission 响应原 JSON-RPC id+有效 optionId；六类失败全部终态不悬空。真实进程宿主（Job Object）待真实轨 | AGT-01 manager（经 AgentAdapter）、AGT-03/04 |

### v1 之后的追加（2026-09-13，AGT-03 adapter manifest，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `AgentAdapterManifestV1`/`validateAdapterManifest`/`probeStartup`/`createCanaryRepo` | `services/agent/adapterManifest.ts` | 新模块：manifest 版本固定（latest 拒绝）、权限模式 deny-writes/ask/allow、capabilities 白名单+unsupported 明细；启动探测不自动安装；canary 临时仓库为只读负例取证（不证明全系统沙箱） | AGT-02 acpClient、AGT-05 任务入口、FE 适配器选择页 |

### v1 之后的追加（2026-09-13，AGT-04 适配器注册表，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `createAdapterRegistry`（双适配器独立 manifest/认证槽/失败隔离） | `services/agent/adapterRegistry.ts` | 新服务：认证按 adapter 隔离（LLM API key ≠ 适配器登录态）；选择适配器不改会话/权限语义；实例失败不自动切换 | AGT-05 任务入口、FE 适配器选择页 |

### v1 之后的追加（2026-09-13，AGT-05 TaskCommand facade，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `createTaskCommandFacade`（/agent 结构化命令 parser、workspaceRef 服务端白名单别名、审批单次绑定凭据、进度节流/完成去重/投递失败旁路化、runs() 同 runId 共读） | `services/agent/taskCommand.ts` | 新服务：进入生产 AgentSessionManager；任意本地路径/未知别名/未授权/重放 0 执行 | GW-01 可信命令分支、FE 任务面板、INT-04 端到端 |

### v1 之后的追加（2026-09-13，INT-04 联调 harness，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| INT-04 fixture 链路 harness（生产 TaskCommand 入口→manager→fake ACP→canary→审批→原渠道投递；负例先行+入口×适配器矩阵） | `services/agent/int04.fixture.test.ts` | 测试资产：从生产用户命令入口开始，不绕 parser/认证/路由；真实轨（真实 diff+测试退出码）独立 NOT RUN | INT-04 真实轨、INT-03 发布门禁 |

### v1 之后的追加（2026-09-13，RT-05 持久 Scheduler，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `createPersistentScheduler`（time/interval/event 三触发、misfire skip、幂等 executionKey、到期 authorize 重查 fail-closed、unknown 不重放、重试 3 次退避、容量上限） | `services/runtime/persistentScheduler.ts` | 新服务；KV 持久化重启不重放已消费任务；无时区数据返回 unsupported | RT-06 跨渠道投递、AGT 调度、通知 |

### v1 之后的追加（2026-09-13，RT-06 投递策略，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `createDeliveryPolicy`/`isQuietHour`/`registerOutboxItem`（群私隔离、冷却持久、静默 defer、完成事件去重） | `services/runtime/deliveryPolicy.ts` | 新纯策略模块：唯一 outbox 来自 GW-01；审批不按 urgency 绕过静默 | GW-01 outbox、RT-05 调度投递、AGT-05 完成通知 |

### v1 之后的追加（2026-09-13，GW-05/06 平台适配，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `verifyFeishuEvent`/`parseFeishuMessage`/`createFeishuTokenManager` | `services/gateway/feishuAdapter.ts` | 新模块（fixture 轨）：验签+重放窗口+tenant 隔离；最小交付仅绑定私聊文本；token 失败可见不泄漏 | GW-01 ChannelGateway、真实部署门禁 |
| `QQ_CAPABILITY_GAPS`/`QQ_SUPPORTED_SCOPES`/`parseQqMessage`/`qqRateLimitVerdict` | `services/gateway/qqAdapter.ts` | 新模块（fixture 轨）：能力差异如实 BLOCKED；仅官方确定支持的文本 scope；不使用逆向协议 | GW-01 ChannelGateway、后续账号审核 |

## 详细接口入口

2026-09-17 RT-05 向后兼容追加：`LocalTasksToken` / `createLocalTasks` 提供一次本地提醒 create/list/update/tick/dispose，由 capabilityPlugins 注册、设置页消费。提醒正文独立键 `scheduler.localReminders.v1`，既有 scheduler.tasks.v1 schema 不变。Scheduler 缺 authorize 拒绝；执行前先持久化 unknown，异常不重放。仅本地主体 local:reminder，不影响 GW/outbox 接口。

LLM 各自的 `docs/llm/specs/LLM-01…05` 文件内写明实现级接口；[STT](../stt/ARCHITECTURE.md)、[TTS](../tts/ARCHITECTURE.md)、[前端](../frontend/ARCHITECTURE.md) 按共享架构文件引用对应阶段。代码块是拟定逻辑契约，现有类型通过兼容 adapter 映射；不能以名称尚未存在推断已实现，也不要机械新增重复接口。

发生冲突先依据用户最新范围和 SPEC 的行为约束统一接口，在同一改动中更新文档/适配及针对性契约测试。接口细化不自动触发全仓重构或全流程测试。

### v1 之后的追加（2026-09-14，FE-22 主动策略接线、最终门禁与发送预约，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `createRuleProactivePolicy()`（替换 FE-18 默认 ignore 占位）：game_event 结算类（victory/defeat/pentakill）confidence ≥0.8 直接候选；弱信号 sustainedMs ≥30000 且 60s 窗口 ≥2 次；busy 未知一律 ignore、busy=true 仅结算类；未达门槛 remember（供缓冲累计）；阈值常量冻结 | `services/environment/ruleProactivePolicy.ts`、`environmentPlugin` | 纯函数；`eventAggregationKey` 供缓冲去重计数 | `environmentPlugin`（ProactivePolicyToken 生产实现）、FE-30 |
| `ProactiveReasonKind` 增加 `"game-result"` / `"environment-weak"`；`ProactiveReasonInput.environment?`（受控词表 ID 数组）；`environmentProactiveReason(kind, buffer)` | `domain/proactive.ts` | 可选追加；hint 只引用词表 ID，无 OCR 原文；无穷举 switch 消费方 | presenter reason 构建、Trace |
| `createEnvironmentTrigger({ monitor, policy, busy, clock, gates, attemptSend })` | `presentation/environmentTrigger.ts` | 新模块。remember 缓冲 ≤20/TTL 60s（TTL 先剔再挤）；终门禁=全局 proactive+environmentProactiveEnabled+contextEnabled+source running+事件在摘要 TTL 内+busy 观测 ≤2000ms（决策后等待再复核）；busy 未知零发送（PRO-04）；`attemptSend` 由 presenter 注入走既有路径 | companionPresenter、FE-30 |
| companionPresenter 集成：`deps.environment?`（monitor/policy/busyObserver/clock）+ 共享发送预约 + `proactivePersistUnknown` 对账 | `presentation/companionPresenter.ts` | 可选 deps：缺省（无 monitor 宿主）零行为变化。预约非排队（同刻第二候选 false）；预约后重验 canSend；submit 成功后持久化失败 → 内存视为已发送、阻止后续主动发送、恢复后按同 sentAt/reason 幂等重写，不重复提交 | FE-22 测试、既有 tick 路径（重构为共用 `attemptSendProactive`） |
| `EnvironmentBusyObserverToken`（`environment.busyObserver`）；`SETTING_KEYS.environmentProactiveEnabled`；environmentPresenter `setProactiveEnabled` + view.proactiveEnabled | `services/environment/busySource.ts`、`services/storage/contracts.ts`、`presentation/environmentPresenter.ts` | 新 token/新键（默认 false）/新开关；busy 观测由 tauri 宿主 `busyObserverPlugin` 提供（浏览器宿主不注册→永远 unknown→不发送） | presentationPlugin、App.tsx 环境分组 |

### v1 之后的追加（2026-09-14，FE-21 Screen Event：帧 diff、ROI 与离线英文 OCR，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| Rust `environment_screen_supported/_enable/_capture_region`（`src-tauri/src/screen.rs`）：Windows.Graphics.Capture（windows-capture crate）500ms 采样 → 96×54 灰度（luma）→ 归一平均绝对差 ≥0.03 触发 `environment://screen-change`（仅 emit_to main）；首个有效帧只建基线、分辨率改变重建、全黑帧无效；`environment_capture_region` 相对 ROI → PNG base64（黑帧/越界 None） | 同左、`lib.rs`、Cargo.toml（windows-capture 1.5、image 0.25 png-only） | 新命令。diff 纯函数（`bgra_to_gray_thumb`/`mean_abs_diff`/`is_black_frame`/`roi_to_pixels`）带固定矩阵单测；关闭清空帧缓存与基线 | FE-21 screenSource、FE-30 组合 |
| `DEFAULT_KEYWORD_RULES`（VICTORY/DEFEAT/PENTAKILL→game_event；Error/Failed→screen_keyword；独立词边界、大小写无关；ruleId）/ `matchKeywords(text, wordConfidence)` / `normalizeWordConfidence`（0..100→0..1） | `services/environment/keywordRules.ts` | 新模块。词级证据缺失用保守 0.5（不造 1.0）；事件只携带 ruleId/置信度，OCR 原文不出模块 | FE-22 policy（confidence≥0.8 门禁）、FE-19 contextSource 摘要 |
| `createOcrEngine({ langPath, corePath?, loadTimeoutMs?=15000, recognizeTimeoutMs?=5000, clock?, timers? })`（tesseract.js 懒加载 worker；超时终止并清理 worker，本次无事件，不无限重试；`reset()` 重初始化） | `services/environment/ocrText.ts` | 新模块。离线资源：eng.traineddata（tessdata_fast，Apache-2.0）本地加载不外联 | screenSource、FE-21 冻结集评估、FE-30 安装包验证 |
| `createScreenSource({ capture, ocr, clock, hostEpoch })`（id=`screen`）：变化节流 ≥2s、OCR 并发 1/pending≤1（忙时保留最新候选）、10 次/分钟单调滚动窗口、停止先撤销 generation 再 dispose worker | `services/environment/screenSource.ts` | 新 `EnvironmentSource`。事件 timingPrecision=measured、confidence=词级归一 | `environmentPlugin` sources（tauriHostPlugins 装配）、environmentPresenter（screen 开关） |
| `SETTING_KEYS.environmentScreenEnabled`；fixtures（`src/services/environment/fixtures/`：dev 30 + 冻结验收集 120，manifest 含来源/sha256；eng.traineddata；public/tessdata 供 webview 同源获取） | `services/storage/contracts.ts`、fixtures | 新键默认 false；SET-02 说明文案在设置区 | environmentPresenter、FE-30 组合验收 |

质量证据：冻结集评估 `ocrQuality.eval.test.ts`（生产 OCR+生产规则，120 张）——精确率 100%、召回率 100%、热 OCR P95 96ms（门槛 95%/85%/2000ms）。开发集 30 张用于调参，未与验收集混用。**固定图不证明 WGC 真机识别**（FE-21-I 归设备轨）。

### v1 之后的追加（2026-09-14，FE-20 桌宠窗口与 pet.presentation.v1，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| Rust `pet_window_show/_hide/_set_click_through/_reset_position/_broadcast/_request_snapshot/_focus_main` | `src-tauri/src/petWindow.rs`、`lib.rs`、`capabilities/pet.json` | 新命令。show 幂等（已存在→show+focus）、hide=销毁、reset=工作区居中+关穿透（Windows 用 `rcWork` 物理像素/DPI 换算，窗口超工作区约束尺寸）；**broadcast 只允许 main 调用**（运行时 label 校验 `assert_allowed_caller`，pet 伪造展示帧被拒）；单帧 64KB 上限。pet 窗口 capability 仅 `core:default` | 主窗设置/找回入口、pet 页 |
| `pet.presentation.v1`（schemaVersion/epoch/seq/runtimeTurnId/speaking/mood/currentSubtitle/lastProactive/可选 snapshot 帧；字幕气泡 2000 字符上限） | `src/pet/petPresentation.ts` | 新协议。主窗聚合→Rust 定向中继→pet 校验后渲染；epoch+seq 合并（旧 epoch/seq 零覆盖；**只有 snapshot 帧允许跨 epoch 重同步**）；字幕 speaking 结束 3000ms 淡出、气泡 8000ms；普通朗读 runtimeTurnId=null 不伪造（播放会话 ID 由 FE-29 追加） | FE-28 CharacterView、FE-29 口型消费（可选字段追加兼容旧壳） |
| `createPetViewModel` / `connectPetViewModel` / `createPetRelay` / `createPetWindowManager` | 同上、`src/pet/relay.ts`、`src/pet/manager.ts` | 新模块。relay 节流（默认 250ms）+ 快照请求应答；manager generation 裁决 show/show、show/hide 竞态（迟到窗口立即销毁），关闭解绑中继订阅，**全程零 Runtime cancel/TTS stop**；`src/pet/` 静态扫描禁止 import services/runtime\|storage\|voice | PetApp/PetController/Bubble、usePetWindow、App.tsx 桌宠设置 |
| `SETTING_KEYS.petWindowEnabled` | `services/storage/contracts.ts` | 新键默认 false；打开桌宠不隐式开启传感器 | usePetWindow、App.tsx |

装配：`main.tsx` 按 Tauri 窗口 label（`app/hosts/detect.ts currentWindowLabel`）分流 pet 页；pet 窗口不建内核。主窗保留「找回桌宠/关闭穿透/关闭桌宠」入口。

### v1 之后的追加（2026-09-14，FE-32 屏幕文本上下文 / FE-31 陪伴会话，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `screen-context.v1`（`ScreenContextResult`：schemaVersion/id/sourceId/sourceTrust/captureGeneration/sessionGeneration/reason/window/region/capturedMonotonicMs/expiresAtMonotonicMs/language/confidence/readStatus/excerpts/truncated/retryAtMonotonicMs） | `services/environment/screenContextProjection.ts` | 新协议。`window` **没有标题字段**；摘录 ≤20 段 / ≤2000 字符 / 单段 ≤240（与 `sanitizeRetrievedText` 的出口上限对齐）；`readStatus` 区分 empty / low_confidence / timeout / unavailable / self_obscured / unauthorized / rate_limited / superseded / cancelled——**识别不到文字不等于画面没有内容** | FE-31 陪伴会话、请求装配、FE-30 |
| `ScreenContextSource.readOnce({reason, sessionGeneration, signal})` / `current` / `clear` / `revoke` / `quota` + `WindowCapturePort` | `services/environment/screenContextSource.ts` | 新端口。前台是 pet/主窗 → 改读「最后一个有效外部窗口」并由 Rust 重新验证；TTL 60s 自 capture 计时；撤销后迟到结果一律作废且不落地 | FE-31、`contextSourcesPlugin`、宿主装配 |
| `CaptureScheduler`（并发 1 / pending 1 / 滚动 10 次每分钟 / manual 优先） | `services/environment/captureScheduler.ts` | 新模块。**FE-21 词表轨与 FE-32 全文读屏共用同一实例**，手动请求计入同一份总额；被顶掉/被取消不消耗额度 | `screenSource`（可选 `scheduler`）、`screenContextSource` |
| `OcrResult.lines?` / `collectLines` / `OcrEngineOptions.languages?` | `services/environment/ocrText.ts` | **可选字段与可选选项追加**，缺省 `eng` 与 FE-21 口径一致，旧调用方零影响。`eng` 与 `chi_sim` 两份 traineddata 均随包（tessdata_fast 4.1.0，Apache-2.0，哈希登记见 `THIRD_PARTY_NOTICES.md`），生产装配声明 `eng+chi_sim`，运行时不外联。**注意 tesseract 的 `data` 同时给扁平与嵌套的 lines/words，两者指向同一批内容**——`collectLines`/`collectWords` 优先取最外层扁平数组，否则每行会被数三遍 | FE-32 投影 |
| `createScreenTextContextSource({current, getScreenTextEnabled, clock})` | `services/environment/contextSource.ts` | 新 `ContextSource`，与 FE-19 环境摘要源**分开注册、分开授权**。`load` 即请求装配最终校验点：未授权/过期/撤销一律空数组 | `contextSourcesPlugin`、LLM contextAssembler |
| `SETTING_KEYS.environmentScreenTextEnabled` / `.companionMode` / `.companionConsent` | `services/storage/contracts.ts` | 新键，默认 false / off / false；三层授权（采集 / 摘要 / 文字摘录）互不隐式开启 | environmentPresenter、CompanionSessionController、设置页 |
| Rust `environment_capture_window`（`src-tauri/src/screen.rs`） | 同上 + `lib.rs` | 新命令，**只允许主窗调用**；返回体无窗口标题；pet/主窗覆盖目标客户区且无法排除 → `obscured`；纯函数 `classify_window_capture` / `rects_intersect` / `clamp_rect_to_frame` / `crop_to_png` 可单元测试 | FE-32 capture 端口 |
| `pet.intent.v1`（requestId / petEpoch / kind∈{talk,screen_talk,pause_reading,end_session,open_main} / text≤2000） | `src/pet/petIntent.ts` | 新协议。多余字段（systemPrompt / source / provider / toolCall / path）**不出现在校验结果里**；requestId 去重 120s×256 | pet 页、`intentBridge`、CompanionSessionController |
| Rust `pet_intent_submit` | `src-tauri/src/petWindow.rs` | 新命令，**只允许 pet 调用**（与 `pet_window_broadcast` 的方向/权限相反），8KB 上限；形状白名单不在 Rust 复制，单点在主窗 | pet 页 |
| `pet.presentation.v1` 追加可选 `companion`（mode/readState/notice）与 `petEpoch` | `src/pet/petPresentation.ts` | **可选字段追加**，旧壳照常渲染；只投影状态，pet 端拿不到任何屏幕文字 | pet 页、FE-28/29 |
| `CompanionPresenter.sendEnvironmentProactive(buffer)` | `presentation/companionPresenter.ts` | 接口新增方法，走**既有**共享发送预约与同一份每日额度/勿扰门禁；buffer 只放受控标识，摘录不从主动理由进模型 | `usePetWindow`、FE-30 |
| `useOptionalService` | `app/kernelContext.tsx` | `registry.tryResolve` 的 React 包装；不新增第四个 resolve 入口 | `usePetWindow` |

**装配（本轮才真正接上，并纠正此前 FE-19 节里与源码不符的那句）**：`tauriHostPlugins` 现在构造 foreground + screen 两个 source 与共享 OCR 引擎并注册 `environmentPlugin`；新增 `environmentHostPlugin` 提供 busy 观测者、统一调度器与按需读屏上下文源；`contextSourcesPlugin` 注册环境摘要源与屏幕文字摘录源；`lib.rs` 补上 `.manage(ScreenState::default())`。在此之前这些模块在生产装配里**没有任何调用方**——真机上一个传感器都不会启动。新装配尚未在真实 Tauri 进程里运行过。

`CompanionSessionController` **不进注册表**：它要同时够到 pet 窗口管理器（主窗 Hook 持有）、屏幕上下文源与既有发送路径，与 `PetWindowManager` 同属「主窗 Hook 拥有的会话对象」；放进注册表就得为「宿主没有屏幕能力」造一个假实现。

### v1 之后的追加（2026-09-14，FE-19 前台传感器、摘要授权与可信 busy，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `createForegroundSource(bridge, { hostEpoch })`（id=`foreground`；listen→enable→current 时序、epoch/enableEpoch+seq 去重、enable 失败映射 `EnvironmentSourceError("denied"/"unavailable")`） | `services/environment/foregroundSource.ts` | 新模块；`EnvironmentBridge { invoke, listen }` 注入，不直接 import Tauri。**只取进程名，无标题字段**（2026-09-14 修订删除 `GetWindowTextW`） | `environmentPlugin` sources、FE-21 复用桥形状 |
| Rust `environment_foreground_supported/_enable/_current/_busy_query`（`src-tauri/src/foreground.rs`，hook 线程消息循环、`emit_to("main")` 定向、`WM_QUIT` 退出线程内 Unhook） | `src-tauri/src/foreground.rs`、`lib.rs` | 新命令。busy 判定纯函数 `classify_busy`（锁定/全屏→true、普通可见→false、锁定未知/无前台/最小化→unknown）；进程名失败跳过事件，不编造 | FE-19 source/busySource、真机轨 |
| `BusyObservation { value, observedMonotonicMs, hostEpoch, reasonCode }` / `createBusyObserver(adapter, { clock, hostEpoch })`（观测有效期 2000ms，过期 unknown）/ `createTauriBusyAdapter` | `services/environment/busySource.ts` | 新模块。unknown 不折算 false；观测只在传感器开启期间由消费方触发（FE-22 门禁），模块自身不轮询 | FE-22 ruleProactivePolicy/presenter 门禁、FE-30 |
| `createEnvironmentContextSource({ monitor, getContextEnabled, clock })`（id=`environment`、section=`environment`） | `services/environment/contextSource.ts` | 新 `ContextSource` 实现。授权读取 fail-closed（抛错=未授权）；load 即**每请求装配边界的出口校验接入点**——撤销/停源/TTL 过期后 load 为空，旧摘要不可能进入请求；snippet 只含应用名+时长+词表 ID 计数 | `contextSourcesPlugin`（FE-22 接线）、LLM contextAssembler 消费方 |
| `SETTING_KEYS.environmentForegroundEnabled` / `.environmentContextEnabled` | `services/storage/contracts.ts` | 新键，默认 false；采集与摘要授权分离；关闭先内存撤销再持久化 | environmentPresenter、contextSource、App.tsx 设置区 |
| `createEnvironmentPresenter({ monitor, settings })` / `EnvironmentPresenterToken`（`presentation.environment`） | `presentation/environmentPresenter.ts`、`presentation/tokens.ts` | 新 Presenter，**恒注册**（无 monitor 时 available=false）；启动读取失败按关闭处理；stopAll=撤 generation→关摘要授权→清缓存→等资源释放；快照稳定引用 | App.tsx 环境感知分组（FE-21/22 复用） |

装配：`tauriHostPlugins` 注册 foreground source + environmentPlugin（浏览器宿主不注册，monitor token 缺席、设置分组隐藏）；`presentationPlugin` 提供 EnvironmentPresenter。请求出口校验只落在 contextSource.load（既有 ContextSource 边界），未重写 ContextAssembler。

### v1 之后的追加（2026-09-14，FE-18 环境契约与 monitor，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `ENVIRONMENT_SCHEMA_VERSION` / `EnvironmentEvent`（schemaVersion、sourceId、eventId、hostEpoch、timestamp、receivedMonotonicMs、timingPrecision、confidence、payload 五 kind）/ `normalizeEnvironmentEvent` / `eventRuleId` | `domain/environment.ts` | 新类型+纯函数。对外 payload **无 title/text 字段**——自由文本在规范化入口剥离；confidence 有限且 0..1；`timestamp` 仅展示，窗口/TTL 一律用 monitor 打点的 `receivedMonotonicMs` | FE-19/21/22、未来环境消费者 |
| `EnvironmentSource`（id/kind/start(emit, signal)→幂等 stop）/ `EnvironmentSnapshot` / `EnvironmentMonitor`（snapshot、subscribe、onStateChange、setSourceEnabled、stopAll、statuses、recent、diagnostics、dispose）/ `EnvironmentSourceState`（off/starting/running/stopping/denied/error）/ `EnvironmentSourceError` / `EnvironmentMonitorError` | `services/environment/contracts.ts` | 新端口。source 状态含 generation，stop 同步撤销（零广播）；stopAll 先撤销再等待；错误只含代码 | `environmentPlugin`、FE-19 前台 source / presenter、FE-21 screen source、FE-22 策略接线 |
| `EnvironmentSourcesToken`（`environment.sources`）/ `EnvironmentMonitorToken`（`environment.monitor`）/ `ProactivePolicyToken`（`environment.proactivePolicy`） | 同上 | 新注册。**能力缺失即 token 不注册**：宿主无传感器时不注册 sources 与 monitor（tryResolve 得 null）；policy 恒注册（FE-18 先冻结契约，生产 rulePolicy 归 FE-22） | `environmentPlugin`（装配）、FE-19/21（提供 sources）、FE-22（消费 policy） |
| `ProactivePolicyInput` / `ProactiveDecision` / `ProactivePolicy`（纯函数 evaluate） | 同上 | 新端口；`userBusy: boolean \| null`，null=未知不触发；持续时长/窗口计数由显式输入提供，无隐藏全局计数 | FE-22 ruleProactivePolicy（首个生产实现） |
| `createEnvironmentMonitor(sources, { clock, hostEpoch?, wallClock?, dedupeWindowMs?, maxPerMinute?, recentTtlMs?, recentLimit? })` / `buildEnvironmentSummary(monitor, { clock })` | `services/environment/monitor.ts`、`summary.ts` | 新服务。默认 dedupe 2000ms、maxPerMinute 60、recent TTL 60000ms 上限 20；模型出口 DTO 只含受控 process/kind/词表 ID/置信度/年龄，无原文；conformance 用例包 `environment.conformance.ts`（生产 monitor+fake source 全绿） | FE-19 environmentPresenter、FE-21 screenSource、FE-22 presenter 接线、FE-30 组合 |

语义边界：注册 monitor ≠ 启动 source（初始全 off，开关由 FE-19 控制端口接入）；同一 source 关闭只清其状态与 recent，stopAll 清空全部；去重/频控只约束广播与 recent，前台快照始终落地最新状态；宿主 epoch 不匹配视为旧会话残余丢弃；未来墙钟时间拒绝并单独计数。

### v1 之后的追加（2026-09-13，FE-17 命令下行收口：Rust emit + 生产授权，向后兼容）

命令下行此前的两处断点：Rust `handle_commands` 受理后无 emit（202 是假确认，TS 网关永远收不到）；生产装配 `outboundPlugin()` 未传 `commandAuthorizer`，按 fail-closed 缺省命令监听根本没接。本轮收口：

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `handle_commands` Accepted 分支补 emit | `src-tauri/src/remote.rs` | 回 202 前先 `app.emit("outbound://command", payload)`，payload 形状 `{command:{raw, principal:{principalId}, conversationId, connectionId}}`（与 `AuthenticatedCommand` 对齐，`connectionId` 用 `http:{request_id}`）；**emit 失败回 502 不假确认**。旧行为（无 emit）无消费者依赖，属缺陷修复 | `tauriTransport`（listen 侧）、`outboundGateway.handleCommand`、手机页命令链路 |
| `capabilityPlugins()` 默认 `commandAuthorizer` | `app/plugins/index.ts` | 生产装配补 `commandAuthorizer: (input) => input.principal.principalId === LOCAL_PRINCIPAL_ID`（服务端注入主体核验，伪造主体在 `handleCommand` 之前被拒）。测试可用替换 `outbound.core` 覆盖；缺省无 authorizer 时监听器仍不接（fail-closed 语义不变） | 桌面宿主命令入口、`outboundHostWiring` 测试 |

验证：`outboundHostWiring.test.ts` 10/10（新增「生产装配默认携带本地主体授权」用例，并保留显式无授权端口的 fail-closed 用例）；outbound+hosts 定向 53/53；cargo test 19/19；tsc 0。真实进程命令下行复测 NOT RUN（见 FE-17_ACCEPTANCE.md 追加节）。

## 2026-09-13 拟议扩展登记（尚未实现/冻结）

RT-01～04负责身份/会话/可信来源/Permission；GW-01/04负责Channel与Device；AGT-01/02负责AgentSession与ACP；LLM-11与FE-23负责context_snapshot/实时订阅。详见[v0.5](../PRD_V0.5.md)。实现前登记精确类型、版本、受影响消费者，不据此宣称现有源码已经提供接口。

远程Reply使用白名单投影，不外发memoryCandidates；Trace出站需要主体授权，不能仅依赖本地includeText。安全拒绝路径fail-closed，Trace旁路仍fail-open。新SourceEnvelope不得覆盖既有TurnSource语义；历史来源unknown不获得权限。FE-14～17已将全文审阅合入正文，旧原样转发/TLS ack规则不再生效。

### 全文审阅新增的待实现端口

- LLM-05：ContextSourceInput增加本轮只读mode/character/stage scope，Memory/Knowledge/Environment共享源集合只有一个提供者。
- LLM-12：UsageRecordV1、物理attempt观测及分页存储端口；Provider请求语义不改；FE-26只消费账本，不反推token分项。
- FE-23：TraceSettings.onChanged、Recorder.subscribe及共同隐私投影；事件身份必须与落盘一致。
- GW-03：STT拥有音频文件解码/重采样与转写端口，不复用麦克风start冒充文件识别。
- RT-02：存储/Runtime/Context scope贯通，旧本地数据有显式legacy归属；不新建第二Runtime。
- AGT-01/05：AgentSession与AgentRun分离、TaskCommand用户入口；远程命令是受控schema扩展，不经ReplyEnvelope.actions触发。

以上均为已审阅设计，生产接口尚未实现，不可仅凭本登记解除集成门禁。

### v1 之后的追加（2026-09-14，PET-02 桌宠接入契约，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `desktopPet.integration.v1`：`PetEvent` / `Capability` / `PetResult` / `PetContext` / `PetStatus` / `DesktopPetAdapter` / `DesktopPetService` / `PetConfig` / `normalizeLoopbackEndpoint` / `normalizePetConfig` / `projectPetText` / `deriveCapabilities` / `validatePetProfile` | `services/desktopPet/contracts.ts`、`profile.ts`、`desktopPetService.ts` | **全新可选能力**，不改任何既有类型与字段。`DesktopPetServiceToken`（`desktopPet.service`）只在桌面宿主且启用桌宠时注册；消费方在 `optional` 里声明并 `tryResolve`，拿到 null 就隐藏入口。endpoint 只允许本机 http（`127.0.0.1` / `::1`，`localhost` 归一化为 `127.0.0.1`），非法地址显式抛错 | 桌面宿主装配（PET-06 设置页）、展示桥接（PET-04 presenter）、诊断 |

语义边界：`accepted` 只表示上游受理请求，**不等于已播放**；断线快照必须带 `stale` 且能力回落为 `unknown`，不得当当前可用；`emotion` 是 Aiki 语义能力，OpenPet 没有 `/api/emotion`，0.5 由 profile 的「语义情绪→已验证 animationId」映射表达，映射缺失只保留文本。

profile 键空间：`SEMANTIC_NAME` 允许**下划线与连字符**，因为 Aiki 自己的 `MOODS` 里就有 `gentle_smile`。早期不允许下划线时，profile 里出现这个键会让**整份** profile 校验失败（能力全 `unknown`、一条命令都发不出），而且完全静默——只有真机核对才暴露。仍然拒绝斜杠、点、冒号、空白与大写。

### v1 之后的追加（2026-09-14，PET-04 气泡存活时长，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `PetCallOptions.ttlMs` / `PetContext.ttlMs` | `services/desktopPet/contracts.ts`、`desktopPetService.ts`、`openPetAdapter.ts` | **可选新增**，不传即退回旧行为（等于 `deadlineMs` 的收口值）。语义拆分：`expiresAt` 只说「这条命令还值不值得发」（上限 `PET_DEFAULT_DEADLINE_MS = 4s`），`ttlMs` 说「气泡该显示多久」（收口在 500–10000ms）。早期两者共用一个数，一整句话的气泡只活 4 秒 | `presentation/desktopPetPresenter.ts`（按文本长度给值）；OpenPet adapter（`remainingTtl` 优先用它） |

### v1 之后的追加（2026-09-14，PET-06 生产装配与设置，向后兼容）

| 追加 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `DesktopPetPresenterToken`（`presentation.desktopPet`） | `presentation/tokens.ts` | 新注册，**恒注册**：宿主没有桌宠能力时自身报 `available=false`，界面据此隐藏分组而不是让入口消失 | `presentationPlugin`（提供）、`useDesktopPet` |
| `desktopPetPlugin({ http, process })`（`host.desktopPet`） | `app/hosts/desktopPet.ts` | 新宿主插件，**只有 Tauri 宿主装**：装了才有 `DesktopPetServiceToken`；浏览器宿主不注册，消费方 `tryResolve` 拿 null | `app/hosts/index.ts`、设置页 |
| `DesktopPetServiceDeps.onProfileChange?` / `OpenPetAdapterDeps.endpoint` 接受 getter | `services/desktopPet/desktopPetService.ts`、`openPetAdapter.ts` | **可选**增量。不传 `onProfileChange` 行为不变；`endpoint` 传字符串时与原来完全一致（仍在构造期校验 loopback） | 装配层改端口/换 profile 不需要重建对象 |
| `DesktopPetServiceToken` 在 `presentationPlugin.optional` / `ClockToken` 加入其 optional | `app/plugins/presentationPlugin.ts` | 能力缺失即降级：没有桌宠服务时 Presenter 仍可解析、报 `available=false` | 展示层、诊断面板 |
| `desktop_pet_process_spawn/_alive/_exit_status/_stop/_validate` | `src-tauri/src/lib.rs`、`desktop_pet_process.rs` | 新命令；句柄只存在于 Rust 内存表，无「按名字停止」入口 | `createTauriPetProcessPort` |
| `SETTING_KEYS.desktopPet`（`pet.desktopIntegration.v1`）/ `.desktopPetProfile`（`pet.desktopProfile.v1`） | `services/storage/contracts.ts` | 新增键，默认关闭 / 无 profile。**旧 `pet.windowEnabled` 不会被自动转换成托管启动授权**；读到坏值回落默认且不写回 | `useDesktopPet`、`usePetWindow`（让位判断） |
| 表现出口互斥：集成启用时自研桌宠窗口让位 | `hooks/usePetWindow.ts`、`hooks/useDesktopPet.ts`、`App.tsx` | 行为增量。关闭集成即恢复自研窗口；关窗不取消主窗对话、不停 TTS（FE-20-G 不变） | FE-20/FE-31 设置区、PET-07 |

语义边界：**关着的时候零网络、零进程**——`enabled=false` 时装配完成但不 enable、不请求 localhost、不 spawn；`testConnection()` 也只在启用后才真的探测。桌宠离线、超时或字段变化只影响桌宠表现，不阻塞 Provider/Runtime/存储；`Tool/审阅` 没有真实公开事件，只有受控显式入口，不按文本猜测。
