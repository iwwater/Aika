# LLM-06 · Trace 采集协议与 Sink 端口

状态：待执行。

## 为什么先做它

[规划文档](../../PLAN_DEV_DEBUG_WORKBENCH.md) F3 是 F4–F9（Trace 页、能力调用视图、数据流图、成本页）共同的数据底座，规划文档本身也写明「先立协议再立页面」。

现状：`companionRuntime.ts` 有一个 `TurnTrace`，只有 5 个字段（降级来源、估算 token、历史丢弃/修复数），经 `onTrace` 回调发一次就没了——没有版本、没有时序、不落盘、查不了。

## 目标与边界

- 输入：既有 `TurnTrace`、`ContextAssemblyResult`、`SqlExecutor` 抽象与 node:sqlite 测试 harness。
- 输出：版本化事件类型 `TraceEventV1`、`TraceSink` 端口、两个真实实现（内存环形缓冲 + SQLite）、脱敏规则、端口一致性用例包。
- 负责范围：协议与两个实现的行为一致性。
- 不做：**本 SPEC 不改 `CompanionRuntime`、不发任何事件、不加界面、不加设置项**（接入是下一份 SPEC）；不引入 OTEL/Phoenix/Langfuse；不做采样、不做远端上报。

## 协议设计

```ts
export const TRACE_SCHEMA_VERSION = 1;

export type TraceEventKind =
  | "turn_start" | "context_assemble" | "provider_request"
  | "provider_stream_meta" | "memory_extract" | "tts" | "turn_end";

interface TraceEventBase {
  schemaVersion: 1;
  turnId: string;
  /** 同一轮内从 1 起单调递增；跨轮各自计数。 */
  seq: number;
  at: number;
  kind: TraceEventKind;
}
```

七种事件的载荷见实现文件。几条刻意的决定：

- **apiKey 靠类型根除，不靠过滤**：没有任何事件带 key 字段。`provider_request` 只留协议、模型与**去掉 query string 的** endpoint——Gemini 把 key 放在 `?key=…` 里，不砍 query 就等于把 key 写进日志。
- **不伪造 token 用量**：`turn_end.tokens.reportedTotal` 目前一律 `null`，因为 provider 侧还没上报 usage；`estimatedPrompt` 是上下文装配的估算值，两者分开字段，不混成一个「tokens」。
- **正文按开关进出**：`turn_start.text` 与 `context_assemble.instructionsDigest` 在 `includeText: false` 时为 `null`，不是空串——缺失与空内容必须分得开。
- **seq 由 sink 调用方给**：事件自带 seq 而不是由 sink 编号，这样落盘顺序与发生顺序脱钩也能还原时序。

## 端口设计

```ts
export interface TraceSink {
  /** 追加一个事件。**永不抛、永不返回 Promise**：Trace 是旁路，主链路不等它、不被它拖住。 */
  append(event: TraceEventV1): void;
  /** 最近若干条，时间倒序。 */
  tail(limit?: number): Promise<readonly TraceEventV1[]>;
  query(filter: TraceQuery): Promise<readonly TraceEventV1[]>;
}
```

- **fail-open 是硬要求**：`append` 内部任何异常（写盘失败、序列化失败）都吞掉，不冒泡到对话链路。
- SQLite 实现的写入是**排队后台落盘**，`append` 只入队；`flush()` 仅供测试与查询前对齐使用。
- 保留策略：SQLite 实现按天滚动清理（默认保留 7 天），清理在写入时顺带做，不另起定时器。

| AC | 模块内验收 |
| --- | --- |
| LLM-06-A | 两个真实实现跑**同一份**用例包全绿：写入可读回、时序按 turnId+seq 还原、`tail` 是倒序且尊重 limit |
| LLM-06-B | fail-open：让底层写入抛错，`append` 不抛，后续事件仍能写（不因一次失败废掉整个 sink） |
| LLM-06-C | 脱敏：`includeText: false` 时正文字段为 null；endpoint 的 query string 一律被去掉；任何事件对象的 JSON 里搜不到 apiKey 值 |
| LLM-06-D | 保留策略：超过保留期的事件被清掉，期内的一条不动（用可注入时钟验，不靠真实等待） |
| LLM-06-E | 用例包不可稀释：对每个实现把一条真实行为改坏，对应用例必须失败；改回后复跑全绿 |

证据：`npx vitest run src/domain/trace.test.ts src/services/trace` 的退出码与用例数；SQLite 侧走 `nodeSqlite.harness` 的真实引擎跑生产 SQL。

## 模块内执行与交付

1. 先确认接口与负责范围，再实现；不要顺带把 Runtime 接上。
2. 只 mock 外部依赖：时钟注入，SQLite 用真实 node:sqlite 引擎。
3. 新增 kernel token 与共享契约按「v1 之后的追加」记录在 [共享契约](../../modules/CONTRACTS.md)。
4. 交付 `../reports/LLM-06_ACCEPTANCE.md`。不默认跑全仓测试、全局 build 或 Tauri 打包。
