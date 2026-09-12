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

## 详细接口入口

LLM 各自的 `docs/llm/specs/LLM-01…05` 文件内写明实现级接口；[STT](../stt/ARCHITECTURE.md)、[TTS](../tts/ARCHITECTURE.md)、[前端](../frontend/ARCHITECTURE.md) 按共享架构文件引用对应阶段。代码块是拟定逻辑契约，现有类型通过兼容 adapter 映射；不能以名称尚未存在推断已实现，也不要机械新增重复接口。

发生冲突先依据用户最新范围和 SPEC 的行为约束统一接口，在同一改动中更新文档/适配及针对性契约测试。接口细化不自动触发全仓重构或全流程测试。
