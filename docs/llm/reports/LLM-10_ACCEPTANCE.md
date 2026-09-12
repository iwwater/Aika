# LLM-10 Provider usage 上报 — 验收报告

日期：2026-09-12
范围：四种协议的用量解析 + 送进 `turn_end.tokens.reportedTotal`。不含成本换算与 F9 页面。

## 需求

`reportedTotal` 此前**一律 null**——`providerClient` 拿到响应只取正文，`usage` 整个丢掉，于是 F9 成本页无从谈起。SPEC 与边界见 [LLM-10](../specs/LLM-10_PROVIDER_USAGE.md)。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/providers.ts` | 新增 `ProviderUsage`（三个字段，缺失一律 null）。**放在 domain 而不是 providerClient 旁边**：Runtime 与 Trace 都要认识这个形状，让编排层 import 一个 HTTP 客户端只为拿类型，等于把实现拖进来。 |
| `src/services/providerClient.ts` | `extractUsage` 按**形状**取用量（`usage` / `response.usage` / `message.usage` / `usageMetadata`），四协议共用一套；`mergeUsage` 按字段合并流式里分两次到的用量；`ProviderHttpError` 带状态码；`ProviderRequestOptions.onUsage` 回调；openai-compatible 流式加 `stream_options: { include_usage: true }`；4xx 且未吐内容时去掉该字段再流式重试一次。 |
| `src/services/runtime/companionRuntime.ts` | `ProviderStreamEvent` 增加 `{ type: "usage" }`；轮次上记 `reportedUsage`；`settle()` 写进 `turn_end.tokens.reportedTotal`。 |
| `src/services/runtime/providerAdapter.ts` | 把 `onUsage` 转成 `usage` 事件推进队列。 |
| `src/services/providerClient.test.ts` | 新增 11 条；改了 1 条既有用例（见下）。 |
| `src/services/runtime/companionRuntime.test.ts` | 受控 Provider 增加 `reportUsage`；新增 3 条。 |
| `src/services/runtime/providerAdapter.test.ts` | 新增 1 条：`onUsage` → `usage` 事件，且排在回复之前也不乱序。 |

## 一处既有行为变化（不是新增，是改）

`streamChat` 在「中转站 400 掉流式」这条路上，现在多一次尝试：**先去掉 `stream_options` 再流式一遍**，仍失败才退非流式。原来是 2 次请求，现在最多 3 次。

代价与收益是明确的：多出来的是一次**失败**请求（不烧 token，只多一次往返）；换来的是「只不认识 `stream_options` 的中转站」不会因为我们想统计 token 而丢掉流式——为了记账把流式弄没了是本末倒置。非 4xx（网络断、500）不做这次重试，那跟请求体无关，重试只是浪费。

既有用例「中转站不支持 stream 时安静退回非流式」已按新序列更新并写明理由，断言从「第 2 次是非流式」变成「第 2 次是不带 `stream_options` 的流式、第 3 次才是非流式」。

## 测试证据

```
npx vitest run src/services/providerClient.test.ts          → 退出码 0：36 通过（新增 11）
npx vitest run src/services/runtime/companionRuntime.test.ts → 退出码 0：32 通过（新增 3）
npx vitest run src/services/runtime/providerAdapter.test.ts  → 退出码 0：8 通过（新增 1）
npx vitest run src → Test Files 74 passed | 1 skipped (75)，Tests 945 passed | 1 skipped (946)
npx tsc --noEmit   → 退出码 0
```

基线对照：LLM-10 之前是 930 passed | 1 skipped，新增正好 15 条（provider 11、Runtime 3、adapter 1）。

突变验证（逐条改生产代码 → 跑定向测试 → 还原）：

| 突变 | 结果 |
| --- | --- |
| 缺一个分项也相加（`?? 0`） | 1 failed ——「缺一个分项时 total 为 null，不拿半个数字当全量」 |
| 全 null 也回调 | 1 failed ——「平台不报 usage 就一次都不回调」 |
| `mergeUsage` 改成后者覆盖前者 | 1 failed ——「anthropic：message_start 与 message_delta 各报一半，合并成一份」 |
| 流式不加 `stream_options` | 1 failed ——「请求带 include_usage，末尾那个空 chunk 的用量收得到」 |
| 任何错误都重试一次流式 | 1 failed ——「500 不重试去 stream_options」 |
| 先判正文再收用量 | 1 failed ——同上「末尾那个空 chunk」（那个 chunk 没有 delta，顺序反了就永远收不到） |
| `turn_end` 仍写死 null | 3 failed ——「平台报了用量，turn_end 写真实数字」等 |
| 收到 usage 事件但不记账 | 3 failed ——同上 |
| adapter 收到 `onUsage` 却不推事件 | 1 failed ——「providerClient 报的用量转成 usage 事件」 |

九处全部命中并已还原；还原后全量 945 通过。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| LLM-10-A 四协议非流式解析；缺失为 null；只有分项时相加 | PASS | 「非流式：四种协议的 usage 都解析得出来」（四组逐一断言，Anthropic 无 total → 70+20=90）；「缺一个分项时 total 为 null」 |
| LLM-10-B 四协议流式都拿得到 | PASS | openai-compatible「末尾那个空 chunk」；anthropic「各报一半合并」；gemini「取最后一次 usageMetadata」；responses「response.completed 里的用量」 |
| LLM-10-C 400 掉 `stream_options` 时流式不退化；非 4xx 不重试 | PASS | 「去掉它再流式一次，流式不退化」（第 2 次仍 `stream: true` 且无 `stream_options`，增量照常到达）；「500 不重试去 stream_options」（只 2 次请求，第 2 次是非流式） |
| LLM-10-D 拿不到就保持 null | PASS | 「平台不报 usage 就一次都不回调」；`turn_end` 既有用例仍断言无上报时 `reportedTotal` 为 null，且 `estimatedPrompt` 不顶替它 |
| LLM-10-E 取消与失败的轮次也带出已拿到的部分 | PASS | 「失败与取消的轮次也带出已经拿到的用量」（失败轮 300、取消轮 125） |
| LLM-10-F 不影响既有事件语义 | PASS | 「用量事件不打扰增量与回复」：用量夹在两片增量之间，`replyDelta` 仍是 `["こん", "にちは"]`，结算 completed；adapter 侧事件序列为 `usage, delta, reply`，用量比正文先到也不乱序；既有 29 条 Runtime 用例判定未改 |

## 共享接口影响

- `ProviderStreamEvent` 联合类型新增 `{ type: "usage"; usage: ProviderUsage }`。对它做穷举的地方：`companionRuntime` 的事件循环（已补分支）、`provider.conformance.ts`（只断言特定事件，未做穷举，无需改）。
- `ProviderRequestOptions.onUsage` 是**可选**入参，不传等于不收；既有调用方一行不改。
- `post()` 现在抛 `ProviderHttpError`（`extends Error`），错误文案一字未改，靠 `instanceof Error` / message 判断的代码不受影响。
- 已按「v1 之后的追加」记进 [共享契约](../../modules/CONTRACTS.md)。

## 待联调项与未覆盖范围

- **NOT RUN：真实平台**。四种协议全部走协议 fixture（假 fetch）。真实平台的字段是否如文档所述、中转站会不会 400 掉 `stream_options`、计费口径与 `usage` 是否一致，都要等 INT-01 真跑一次。**这一条尤其重要：本 SPEC 的价值全在「数字是真的」，而数字来自没验证过的假设。**
- 不做：成本换算（单价表会变，且按模型/按时段不同，埋进 provider 层等于把价目表硬编码进网络客户端）、跨轮聚合、缓存命中 token（OpenAI 的 `prompt_tokens_details.cached_tokens` 之类）的细分。
- `reportedTotal` 只取 total；`promptTokens` / `completionTokens` 目前记在 Runtime 的轮次上但没进 Trace——`TraceTokens` 只有两个字段，拆细要改 Trace 协议，留给 F9 真正需要时再说。
- F9 成本页仍未做：这一份只是把它的前置补上。
