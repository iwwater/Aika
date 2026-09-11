# LLM-07 · Trace 接入（Runtime 侧与开关）

状态：已自测。A–F 六条 AC 全 PASS；三处突变各命中。证据见 [验收报告](../reports/LLM-07_ACCEPTANCE.md)。前置：[LLM-06](LLM-06_TRACE_PROTOCOL.md) 已通过。

## 目标与边界

LLM-06 立了协议与两个 sink，但没有任何人发事件。本 SPEC 让 Runtime 真的产出事件，并把开关交给用户。

- 输入：LLM-06 的 `TraceEventV1` / `TraceSink`、既有 `CompanionRuntime`、内核注册表与组合根、设置存储。
- 输出：`TraceRecorder`（按轮次编号并落 sink 的薄层）、`TraceSinkToken`、trace 插件与装配、Runtime 侧四个事件、`trace.enabled` / `trace.includeText` 两个设置项。
- 不做：**provider_request / memory_extract / tts 三个事件源不在本 SPEC**（分别属 provider 适配器、Presenter、VoicePresenter，下一份）；不做工作台页面；不改 `TurnTrace`（既有 `onTrace` 保持可用，Trace 是并行的第二条路，不是替换）。

## 为什么要 TraceRecorder 这一层

`seq` 必须在一轮内单调递增，而事件源会分散在 Runtime、provider 适配器、两个 Presenter 四处。各自计数一定撞号。Recorder 按 `turnId` 持有计数器，调用方只说「记一条这种事件」，不管编号、不管时钟、不管脱敏。

它同时是**唯一**一处调用 `redactTraceEvent` 的地方——脱敏散落在各个事件源就等于早晚漏一处。

```ts
export interface TraceRecorder {
  /** 记一条。seq、时刻、脱敏都在这里完成；永不抛。 */
  record(turnId: string, event: TraceEventDraft): void;
  /** 这一轮结束了，扔掉它的计数器，别让长会话把 Map 堆大。 */
  endTurn(turnId: string): void;
  enabled(): boolean;
}
```

关掉时 `record` 直接返回，连事件对象都不构造。

## 开关

- `trace.enabled`：默认值按构建取——开发构建默认开，生产默认关（规划文档 §7 问题 2 的建议）。读不到构建标记时按**关**处理。
- `trace.includeText`：默认关。正文进不进盘是用户的选择，默认不进。
- 两个键加进既有 `SETTING_KEYS`，开关本身做成可变服务（`TraceSettingsToken`），recorder 每次记录都重新读一次，设置页一改就生效。
- **界面上的勾选框不在本 SPEC**：它属于 F2 开发者模式入口（FE 侧）。本 SPEC 交付的是开关的服务与键，以及「关掉时一个事件都不产生」的行为。

| AC | 模块内验收 |
| --- | --- |
| LLM-07-A | Runtime 跑完一轮，sink 里按序拿到 `turn_start → context_assemble → provider_stream_meta → turn_end`，seq 从 1 连续递增 |
| LLM-07-B | 失败轮与取消轮的 `turn_end.status` 分别是 `failed`（带 errorCode）与 `cancelled`；`durationMs` 用注入时钟算得出确定值 |
| LLM-07-C | `provider_stream_meta`：chunk 数等于真实 delta 片数；`firstTokenMs` 是首片相对轮次开始的耗时，一片都没有时是 `null` 而不是 0 |
| LLM-07-D | 关掉开关时一个事件都不产生；`includeText` 关时 `turn_start.text` 为 null，开时是原话 |
| LLM-07-E | 旁路与 fail-open：sink 的 `append` 抛错时对话仍正常完成（用故意抛错的 sink 验）；Runtime 不 await 任何 trace 操作 |
| LLM-07-F | Recorder 按 turnId 独立编号：两轮交错发事件时各自的 seq 都从 1 连续 |

证据：`src/services/trace/traceRecorder.test.ts`、`src/services/runtime/companionRuntime.test.ts` 的定向运行；Runtime 侧用既有 fake provider/storage，不连真实模型。

## 模块内执行与交付

1. 先确认接口与范围，再实现；不要顺带把另外三个事件源接上，也不要开始做页面。
2. 新增 token 与设置项按「v1 之后的追加」记录在 [共享契约](../../modules/CONTRACTS.md)。
3. 交付 `../reports/LLM-07_ACCEPTANCE.md`。不默认跑全仓测试、全局 build 或 Tauri 打包。
