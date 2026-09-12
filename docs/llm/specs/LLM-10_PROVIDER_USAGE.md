# LLM-10 · Provider usage 上报

状态：已自测。A–F 六条 AC 全 PASS；九处突变全部命中（2026-09-13 复核更正：原误记"八处"，报告表列 9 行）。证据见 [验收报告](../reports/LLM-10_ACCEPTANCE.md)。前置 [LLM-07](LLM-07_TRACE_WIRING.md)（Trace 接入 Runtime）已通过。

## 为什么需要它

`turn_end.tokens.reportedTotal` **目前一律 null**——`providerClient` 拿到响应之后只取正文，`usage` 整个丢掉。于是：

- 规划文档的 F9 成本页做不了。只有估算值的成本页不叫成本页，叫猜测页；
- 「这一轮到底烧了多少 token」在四种协议下全都答不上来，而这恰恰是本地优先应用唯一会产生真实费用的地方。

Trace 协议这一侧早就留好了位置（[LLM-06](LLM-06_TRACE_PROTOCOL.md) 的 `TraceTokens.reportedTotal`，注释写着「provider 侧还没把 usage 透出来。写 0 会让成本页把『不知道』画成『不花钱』」）。这一份就是去把它填上。

## 目标与边界

- 输入：四种协议（openai-compatible / openai-responses / anthropic / gemini）在**流式与非流式**下的响应。
- 输出：`turn_end.tokens.reportedTotal` 是平台真实上报的数字；拿不到仍然是 null。
- **不做**：成本换算（单价表、货币、按模型计费）——那是 F9 页面的事，且单价会变，不该埋进 provider 层；不做跨轮聚合；不改回复解析与 `ReplyEnvelopeV1`。
- **不做**：为了拿 usage 牺牲流式。见 AC-C。

## 设计

### 1. 解析，不发明

```ts
export interface ProviderUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** 平台报了就用平台的；只报了两个分项就相加；都没有是 null。 */
  totalTokens: number | null;
}
```

各协议的字段名不同（`prompt_tokens` / `input_tokens` / `promptTokenCount`…），但语义一致，所以归一成上面三个字段。

**相加是算术，不是发明**：Anthropic 只报 `input_tokens` / `output_tokens`，两者之和就是这一轮的总量。但只有**两项都有**时才相加——缺一项时 total 是 null，不拿半个数字当全量。

### 2. 流式要主动要

- `openai-compatible`：流式默认**不**返回 usage，要在请求体里加 `stream_options: { include_usage: true }`，平台会在 `[DONE]` 之前多发一个 `choices: []` 且带 `usage` 的 chunk。
- `openai-responses`：`response.completed` 事件里自带 `response.usage`，不需要额外字段。
- `anthropic`：`message_start` 带 input，`message_delta` 带 output，两者合并。
- `gemini`：chunk 里带 `usageMetadata`，取最后一次出现的。

### 3. 不认识 `stream_options` 的中转站

这是唯一一处有回归风险的改动：中转站五花八门，多塞一个字段可能被 400 掉，而流式失败会退回非流式——**为了统计 token 把流式弄没了，是本末倒置**。

所以：`post()` 抛的错误带上 HTTP 状态码；流式在**收到第一个 chunk 之前**因 400/422 失败时，去掉 `stream_options` **再流式重试一次**，仍失败才走既有的非流式兜底。状态码不是 4xx（网络断了、500）时不重试——那跟请求体没关系，重试只是浪费一次请求。

### 4. 送到 Trace

`ProviderStreamEvent` 增加一种：`{ type: "usage"; usage: ProviderUsage }`。Runtime 收到就记在这一轮上，`settle()` 写 `turn_end` 时带出去。

为什么走事件而不是塞进 `reply`：usage 在流式里**可能比 reply 先到也可能后到**（Anthropic 的 input 在 `message_start`），而且取消与失败的轮次根本没有 reply——那时候已经烧掉的 token 同样要报。

| AC | 模块内验收 |
| --- | --- |
| LLM-10-A | 四种协议的非流式响应都能解析出 usage；字段缺失为 null 不补 0；只有两个分项时 total 相加，缺一项则 total 为 null |
| LLM-10-B | 四种协议的流式都能拿到 usage：openai-compatible 靠 `stream_options.include_usage`，responses 靠 `response.completed`，anthropic 合并 `message_start` 与 `message_delta`，gemini 取最后一次 `usageMetadata` |
| LLM-10-C | 中转站 400 掉 `stream_options` 时，去掉它重试流式并成功拿到回复（**流式不退化**）；非 4xx 错误不做这次重试 |
| LLM-10-D | 平台不报 usage 时 `reportedTotal` 仍是 null，绝不用 `estimatedPrompt` 冒充 |
| LLM-10-E | `turn_end.tokens.reportedTotal` 写的是上报值；**取消与失败的轮次**同样带出已经拿到的部分 |
| LLM-10-F | usage 事件不影响回复解析与既有事件顺序：`delta` / `reply` / `error` 的语义和条数一字不变 |

证据：`src/services/providerClient.test.ts`、`src/services/runtime/companionRuntime.test.ts`、`src/services/runtime/providerAdapter.test.ts` 的定向运行。四种协议用协议 fixture（假 fetch），**不连真实平台**——真实计费口径的核对留 INT-01。

## 模块内执行与交付

1. 只改 provider 侧与 Runtime 的记账，不碰回复解析、上下文装配与存储。
2. `ProviderStreamEvent` 的联合类型加成员，按「v1 之后的追加」记进 [共享契约](../../modules/CONTRACTS.md)，并核对所有对它做穷举的地方。
3. 交付 `../reports/LLM-10_ACCEPTANCE.md`。
