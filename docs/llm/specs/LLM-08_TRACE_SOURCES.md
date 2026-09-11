# LLM-08 · Trace 余下三个事件源

状态：已自测。A–E 五条 AC 全 PASS。证据见 [验收报告](../reports/LLM-08_ACCEPTANCE.md)。前置：[LLM-07](LLM-07_TRACE_WIRING.md) 已通过。

## 目标与边界

LLM-07 让 Runtime 发了四个事件，`provider_request` / `memory_extract` / `tts` 三个还空着——它们的数据分别只有 provider 适配器、`CompanionPresenter`、`VoicePresenter` 拿得到。

- 输入：LLM-06 的协议、LLM-07 的 `TraceRecorder` 与 token。
- 输出：三个事件源接上，加上让 `tts` 能挂到同一轮上的一处契约追加。
- 不做：不改事件载荷字段（协议在 LLM-06/07 已定）；不做页面；不做成本统计口径（F9）。

## 三处各自的难点

1. **`provider_request` 要报真实 endpoint，不能猜**。URL 由 `providerClient` 内部的 `prepare()` 按四种协议各自拼出来（Gemini 还要 `:streamGenerateContent` 加 query）。所以从 providerClient **导出一个只读描述函数**复用同一段逻辑，而不是在适配器里照抄一遍 URL 规则——照抄的那份迟早和真实请求漂移。key 仍在 URL 里，由 recorder 统一砍掉 query。

2. **`memory_extract` 要挂在正确的轮次上**。`runBackgroundMemoryWork` 现在只收消息数组，不知道自己属于哪一轮；调用点有 `handle.turnId`，补一个入参即可。

3. **`tts` 的轮次 id 得跨模块传**。`VoiceTurnRequest.turnId` 是语音回合号（number），不是 Runtime 的轮次 uuid，而 Trace 按 uuid 归组。所以给 `VoiceTurnRequest` 加一个可选 `runtimeTurnId`，由 `CompanionPresenter` 在发起这一轮时写进去。**拿不到它就不记**——聊天页点朗读（FE-07）压根不属于任何一轮，给它编一个 turnId 是伪造。

| AC | 模块内验收 |
| --- | --- |
| LLM-08-A | `provider_request`：protocol / model 与当前配置一致；endpoint 是 providerClient 真实用的那个 URL；四种协议都对 |
| LLM-08-B | endpoint 里的 key 在落到 sink 时已被砍掉（含 Gemini 的 `?key=`）；`instructionsDigest` 受正文开关控制 |
| LLM-08-C | `memory_extract`：候选条数正确；抽取抛错时记一条 `failed: true` 而不是不记 |
| LLM-08-D | `tts`：句数、是否真的播过、失败句数与 drain 结果一致；`runtimeTurnId` 缺失时（聊天页点朗读）不记任何事件 |
| LLM-08-E | 三处都是旁路：recorder 抛错不影响生成、记忆抽取与播放收尾 |

证据：`providerClient.test.ts`、`providerAdapter.test.ts`、`companionPresenter.test.ts`、`voicePresenter.test.ts` 的定向运行。

## 模块内执行与交付

1. 先确认范围再实现；不要顺带做页面。
2. `VoiceTurnRequest.runtimeTurnId` 按「v1 之后的追加」记录在 [共享契约](../../modules/CONTRACTS.md)。
3. 交付 `../reports/LLM-08_ACCEPTANCE.md`。
