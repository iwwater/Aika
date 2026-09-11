# LLM-08 Trace 余下三个事件源 — 验收报告

日期：2026-09-12
范围：`provider_request`（provider 适配器）、`memory_extract`（CompanionPresenter）、`tts`（VoicePresenter），以及让 `tts` 能挂到同一轮上的一处契约追加。

## 需求

LLM-07 让 Runtime 发了四个事件，这三个还空着。SPEC 与取舍见 [LLM-08](../specs/LLM-08_TRACE_SOURCES.md)。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/services/providerClient.ts` | 新增导出 `describeChatRequest(config, systemPrompt, history, stickerIds, stream)` → `{ url, bodyChars }`：**只读**，复用内部 `prepare()`，不发请求。 |
| `src/services/runtime/providerAdapter.ts` | 新增可选 `trace`；发 `provider_request`（protocol / model / 真实 endpoint / 真实请求体字符数 / instructions 长度与摘要）。顺带去掉一处重复拼装：`history` 原来在 `streamChat` 调用处现拼，现在与描述请求共用同一份。 |
| `src/domain/voiceRuntime.ts` | `VoiceTurnRequest` 新增可选 `runtimeTurnId`（Runtime 的轮次 uuid）。与既有 `turnId`（语音回合号 number）是两回事，注释写明不许合并、缺失时不许编。 |
| `src/presentation/companionPresenter.ts` | 新增可选 `trace` 依赖；`runBackgroundMemoryWork` 收一个 `runtimeTurnId` 入参并发 `memory_extract`（成功记条数，抛错记 `failed: true`）；语音轮发起时写 `request.runtimeTurnId`。 |
| `src/presentation/voicePresenter.ts` | 新增可选 `trace` 依赖；`finishSpeaking` 发 `tts`（句数 / 是否真播过 / 失败句数），**仅当** `request.runtimeTurnId` 存在。 |
| `src/app/plugins/runtimePlugin.ts`、`presentationPlugin.ts` | 把 recorder 传给 provider 适配器与两个 Presenter（都走 `optional` + `tryResolve`）。 |
| 四个测试文件 | 新增 4 + 2 + 2 条；三处 `providerClient` 的 `vi.mock` 改成 `importOriginal` 局部替换（见下）。 |

## 三处各自的取舍

1. **endpoint 必须问 providerClient 要**。URL 由内部 `prepare()` 按四种协议各自拼（Gemini 还要 `:streamGenerateContent` 加 query）。在适配器里照抄一份，迟早和真实请求漂移，那时 Trace 报的地址就是假的——排查问题时最坏的情况是「日志骗你」。所以导出只读描述函数复用同一段逻辑。
2. **抽取失败要记一条 `failed: true`**，不是不记。不记的话「记忆怎么一条都没有」永远查不出是抽取一直在失败。
3. **`tts` 拿不到 Runtime 轮次就不记**。`VoiceTurnRequest.turnId` 是语音回合号，拿它编一个 trace id 会把不同轮的事件混在一起——伪造归组比没有归组更坏。

## 测试证据

```
npx vitest run src/services/runtime/providerAdapter.test.ts src/presentation/companionPresenter.test.ts \
  src/presentation/voicePresenter.test.ts
→ 退出码 0：providerAdapter 7、companionPresenter 21、voicePresenter 12
npx vitest run src        → Test Files 68 passed | 1 skipped (69)，Tests 829 passed | 1 skipped (830)
npx tsc --noEmit          → 退出码 0
```

### 两处自查记录

**一、全量跑抓到了定向跑漏掉的 15 个失败。** 适配器开始调 `describeChatRequest` 之后，三个测试文件里对 `providerClient` 的 `vi.mock` 没有这个导出，于是 mock 缺项 → 适配器抛错 → `useCompanionSession.integration.test.ts` 等 15 条挂掉。定向运行只覆盖了我改的那几个文件，看不到这些。修法是把这几处 mock 改成 `importOriginal` 局部替换（只替 `streamChat`），顺带让用例跑在**真实 URL 逻辑**上——这比补一个假的 `describeChatRequest` 证据更强。

**二、一条用例的理由是错的，突变把它揪出来了。** 我原先写「聊天页点朗读不记 tts」来验守卫，突变（故意用语音回合号编 id）却没让它失败。原因是点击朗读走 `queue.speak` 自己的 `onDrained`（`clearBubblePlayback`），**压根不经过 `finishSpeaking`**，所以它永远不会记 tts，跟守卫没关系。真正被守卫挡住的是「会话轮但没有 runtimeTurnId」。已改成验那个路径，突变随即命中；原来那条保留但改成验「没有多记」，并在注释里写明理由。

### 突变验证

| 突变 | 结果 |
| --- | --- |
| `provider_request.endpoint` 改成在适配器里手拼 `${baseUrl}/chat/completions` | 2 failed ——「报的是 providerClient 真正会用的 endpoint」「Gemini 的 key 已经不在了」 |
| 抽取抛错时不记 `memory_extract` | 1 failed ——「抽取抛错时记 failed，而不是干脆不记」 |
| 没有 `runtimeTurnId` 时拿语音回合号编一个 | 1 failed ——「会话轮但没有 runtimeTurnId：不记」（**第一版用例没命中，见上文自查二**） |

三处均已还原，`grep -rn MUTANT src/` 无命中。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| LLM-08-A protocol / model / 真实 endpoint | PASS | 「报的是 providerClient 真正会用的 endpoint」：断言 `https://example.com/v1/chat/completions`（由 `baseUrl` + 协议规则推出，且走的是真实 `prepare()`）；Gemini 用例断言 `:streamGenerateContent` |
| LLM-08-B key 已砍掉；instructions 摘要受开关控制 | PASS | Gemini 用例：`endpoint` 与整个事件 JSON 都搜不到 `SECRET-KEY-123`；「instructions 摘要受正文开关控制」 |
| LLM-08-C 候选条数；失败记 `failed: true` | PASS | 两条 Presenter 用例，第二条断言 `failed === true && candidates === 0` 且事件确实存在 |
| LLM-08-D 与 drain 结果一致；缺 `runtimeTurnId` 不记 | PASS | 「会话轮」用例断言 `turnId === "run-uuid-1"`、`played === true`、`errorCount === 0`；「没有 runtimeTurnId」用例断言无事件 |
| LLM-08-E 三处都是旁路 | PASS | 适配器「不传 trace 时什么都不记，也不影响生成」；recorder 自身的 try/catch 已在 LLM-07 验过（sink 抛错不冒泡）；两个 Presenter 走同一个 recorder |

## 共享接口影响

- `VoiceTurnRequest.runtimeTurnId`（可选，新增）：既有实现不设它也照常工作，只是不记 tts。按「v1 之后的追加」记入 [共享契约](../../modules/CONTRACTS.md)。
- `providerClient` 新增导出 `describeChatRequest`（只读，不发请求）。
- `StreamChatProviderOptions.trace`、`CompanionPresenterDeps.trace`、`VoicePresenterDeps.trace` 三个可选入参。
- 未改事件协议字段、未改存储契约、未新增 token。

## 待后续

- F3 至此完整：七种事件全部有真实来源。**但都还没有界面**——F2 开发者模式入口与 F4 Trace 查看页是下一步。
- `turn_end.tokens.reportedTotal` 仍是 null（provider 不上报 usage），F9 成本页要真实数字得先改 `providerClient` 解析 usage。
- NOT RUN：真实模型下的一轮完整事件流目视确认；真实 Tauri 落盘。留 INT-01。
