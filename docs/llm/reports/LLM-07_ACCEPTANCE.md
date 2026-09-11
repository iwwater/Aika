# LLM-07 Trace 接入（Runtime 侧与开关）— 验收报告

日期：2026-09-12
范围：`TraceRecorder`、三个 token、trace 插件与装配、Runtime 侧四个事件、开关服务。**provider_request / memory_extract / tts 三个事件源不在本 SPEC**；设置页勾选框属 F2。

## 需求

LLM-06 立了协议与两个 sink，但没有任何人发事件。SPEC 与取舍见 [LLM-07](../specs/LLM-07_TRACE_WIRING.md)。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/services/trace/traceRecorder.ts` | 新增。按 `turnId` 持有 seq 计数器；填 `schemaVersion` / `at`；**全仓唯一**调用 `redactTraceEvent` 的地方；关掉时连事件对象都不构造；自身再兜一层 try/catch。另导出 `NO_TRACE` 空实现，调用点因此不用写 `?.`。 |
| `src/services/trace/traceSettings.ts` | 新增。可变开关服务；`defaultTraceSettings()` 按 `import.meta.env.DEV` 取默认，**读不到构建标记时按关处理**（默认不留痕比默认留痕安全）。 |
| `src/services/trace/tokens.ts` | 新增 `TraceSinkToken` / `TraceRecorderToken` / `TraceSettingsToken`，按 CORE-02-D 定义在接口旁边。 |
| `src/app/plugins/tracePlugin.ts` | 新增。两个 sink 同时挂（内存给工作台实时看、落盘给「昨天那次怎么回事」），`fanOut` 写两份、查询走内存那份；localStorage 宿主拿不到 SQL 执行器时只留内存一份，而不是造个假落盘。 |
| `src/app/plugins/runtimePlugin.ts` | `optional: [TraceRecorderToken]` + `tryResolve ?? NO_TRACE`：「能力缺失即 token 不注册」，没装 trace 插件时不需要任何运行时开关分支。 |
| `src/app/plugins/index.ts` | `capabilityPlugins()` 装上 `tracePlugin()`。 |
| `src/services/runtime/companionRuntime.ts` | 新增可选 `trace` 入参（默认 `NO_TRACE`）；`Turn` 加 `startedAt` 与 `estimatedPromptTokens`；发四个事件：`turn_start`（run 开头）、`context_assemble`（既有 emitTrace 旁边）、`provider_stream_meta`（流结束后，成功/失败/取消都经过）、`turn_end`（`settle` —— 所有终态的唯一漏斗，挂一处不漏不重）。既有 `onTrace` 一字未改。 |
| `src/services/storage/contracts.ts`、`sqliteStorage.ts`、`storage.conformance*` | `AikaStorage` 新增**可选** `sqlExecutor`（见下）；用例包加一条声明一致性断言，localStorage harness 如实声明 `unsupported: ["sqlExecutor"]`。 |
| `src/services/trace/traceRecorder.test.ts`、`src/services/runtime/companionRuntime.test.ts` | 新增 7 + 8 条。 |

## 两处协议/契约修正

### 1. `instructions` 摘要从 `context_assemble` 挪到 `provider_request`

LLM-06 把 `instructionsChars` / `instructionsDigest` 放在 `context_assemble` 上。接入时发现**装配阶段还没有这个字符串**：`AgentContext` 只有结构化字段，最终 instructions 是 provider 适配器用 `buildInstructions` 拼出来的。

放在拿不到它的事件上，唯一的出路是拿别的字段凑（我第一版就错拿了 `context.query`，那是用户原话不是 instructions）。所以改协议：这两个字段挪到 `provider_request`，脱敏规则跟着挪。`context_assemble` 只报装配阶段真有的东西。

### 2. `AikaStorage` 新增可选 `sqlExecutor`

Trace 落盘要在同一个库里建自己的表。把 trace 的读写塞进 `AikaStorage` 才是真越界，所以露出执行器，让自带表的消费者各管各的表——这个接口不该为每个新表长大一次。沿用 `memoryV2?` 的「可选能力」模式：SQLite 实现有，localStorage 实现没有并如实声明。

## 测试证据

命令（cwd = `aika-crossplatform`）：

```
npx vitest run src/services/runtime/companionRuntime.test.ts src/services/trace
→ 退出码 0，Test Files 5 passed (5)，Tests 50 passed (50)
npx tsc --noEmit → 退出码 0
```

里程碑全量（M2 的接入面横跨 runtime / 装配 / 存储契约，跑一次全仓确认没有连带破坏）：

```
npx vitest run src
→ Test Files 68 passed | 1 skipped (69)，Tests 820 passed | 1 skipped (821)
```

> 那 1 个 skipped 仍是既有的 `crossSession.real.test.ts`（真实模型样本，按环境变量关）。全量运行不是本阶段的默认动作，这次是因为改到了共享契约与装配。

突变验证：

| 突变 | 结果 |
| --- | --- |
| `firstChunkAt ??=` 改成每片都更新（首片时间变末片时间） | 1 failed ——「stream_meta：chunk 数是真实片数，firstTokenMs 是首片耗时」 |
| 没收到片时 `firstTokenMs` 写 0 而不是 null | 1 failed ——「一片都没收到时 firstTokenMs 是 null，不是 0」 |
| `turn_end.status` 一律写 completed | 1 failed ——「失败轮带 errorCode，取消轮标 cancelled」 |

三处均已还原，`grep -rn MUTANT src/` 无命中。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| LLM-07-A 四个事件按序、seq 连续 | PASS | 「一轮走完」用例：kinds 为 `turn_start / context_assemble / provider_stream_meta / turn_end`，seq `[1,2,3,4]`，turnId 全一致 |
| LLM-07-B 失败/取消的 status 与 durationMs | PASS | 「turn_end」用例：failed 带 `PROVIDER_FAILED`、`durationMs` 为注入时钟推进的 500、cancelled 正确；`tokens.reportedTotal` 为 null 而 `estimatedPrompt` > 0 |
| LLM-07-C chunk 数与 firstTokenMs（无片时 null） | PASS | 两条用例：2 片 / firstTokenMs 200；失败轮 0 片 / null |
| LLM-07-D 关掉时零事件；includeText 生效 | PASS | 「关掉开关」用例（一轮跑完事件为空）+「正文开关」用例（null vs 原话），recorder 侧另有两条 |
| LLM-07-E 旁路 fail-open | PASS | 「sink 每次 append 都抛错，这一轮照样完整完成」：结算 `{completed, persisted:true}` 且落库 1 条；recorder 侧另有一条 |
| LLM-07-F 按 turnId 独立编号 | PASS | recorder 的「两轮交错发」用例：各自 `[1,2]` |

## 共享接口影响

按「v1 之后的追加」记入 [共享契约](../../modules/CONTRACTS.md)：

- 新增三个 token（`llm.traceSink` / `llm.traceRecorder` / `llm.traceSettings`），都是**新增注册**，没有改动既有 token。
- `CompanionRuntimeOptions` 新增可选 `trace`；不传等于 `NO_TRACE`，既有调用方零改动。
- `AikaStorage` 新增可选 `sqlExecutor`。
- `SETTING_KEYS` 新增 `traceEnabled` / `traceIncludeText` 两个键。
- 既有 `onTrace` / `TurnTrace` **未改**：Trace 是并行的第二条路，不是替换。

## 待后续

- 另外三个事件源：`provider_request`（provider 适配器，同时补上 instructions 摘要）、`memory_extract`（Presenter）、`tts`（VoicePresenter）——下一份 SPEC。
- 设置页勾选框与开发者模式入口：F2（FE 侧）。
- 持久化开关值的读写（启动时把库里的值灌进 `TraceSettings`）：随 F2 一起做，本 SPEC 只交付服务与键。
- NOT RUN：真实 Tauri 环境。`plugin-sql` 上的建表/清理与 `import.meta.env.DEV` 在生产构建下的实际取值都留 INT-01。
