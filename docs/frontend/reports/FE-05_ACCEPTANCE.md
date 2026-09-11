# FE-05 失败轮重试 — 验收报告

日期：2026-09-12
范围：domain 归组纯函数 + Presenter `retry` 命令 + Hook 转发 + 气泡按钮与样式。前置 [CORE-08](../../core/specs/CORE-08_MESSAGE_DELETION.md) 已通过。

## 需求

失败气泡上给一个重试入口。SPEC 与边界见 [FE-05](../specs/FE-05.md)。

重试不是「再发一次」：失败轮在库里留下两行——`companionRuntime.ts:507` 在生成前落的用户消息，和 `companionPresenter.ts` 的 `finish()` 判失败后落的失败气泡。`submit()` 每轮新建 uuid 重新持久化用户消息，所以直接重投会留下两条相同的用户消息加一条永久失败气泡。顺序必须是**先整轮删掉，再用同一句原话提交**。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/conversation.ts` | 新增 `retryableTurn(messages, failureId)` → `RetryableTurn \| null`：给出该轮要删的全部 id、用户原话与原轮 source。归组按 `runtimeTurnId`（Runtime 给用户消息写 `turn.id`，Presenter 给失败气泡写 `handle.turnId`，同轮同号）；旧数据无该字段时回退到「失败气泡之前最近的那条用户消息」；主动消息轮没有用户发言返回 null。 |
| `src/presentation/companionPresenter.ts` | 契约新增 `retry(messageId)`；实现「先删再投」：`sending` 中或不可重试直接返回 null；`deleteMessages` 抛错时写 `storageError` 并**不重投**（留着失败气泡让用户再点，胜过界面与库对不上）；删成功后同步移除界面上的那几条，再 `send(原话, 原 source)`。 |
| `src/hooks/useCompanionSession.ts` | 转发 `retry`（67 行，仍在 architecture 门禁的 150 行以内）。 |
| `src/components/MessageRetry.tsx` | 新增。失败气泡上的按钮，只转发 `retryableTurn` 的判定与 `onRetry` 命令，无自有逻辑；`sending` 时禁用。 |
| `src/App.tsx` | 气泡内挂 `<MessageRetry … onRetry={(id) => void session.retry(id)} />`，一行 import。 |
| `src/App.css` | 新增 `.message-retry` 三条样式（含 hover 与 disabled），沿用失败气泡的品红色系。 |
| `src/domain/conversation.test.ts` | 新增 `retryableTurn` describe，6 条用例。 |
| `src/presentation/companionPresenter.test.ts` | 新增 2 条用例；fake Runtime 增加 `submitted` 数组（`last()` 只看在途轮，数不出「有没有多提交」）。 |

## 测试证据

命令（cwd = `aika-crossplatform`）：

```
npx vitest run src/domain/conversation.test.ts src/presentation/companionPresenter.test.ts
```

退出码 0：conversation 19 passed（新增 6），companionPresenter 9 passed（新增 2）。

定向回归：

```
npx vitest run src/domain/conversation.test.ts src/domain/remote.test.ts src/presentation \
  src/services/storage src/kernel/architecture.test.ts src/app
→ 退出码 0，Test Files 15 passed (15)，Tests 174 passed (174)
npx tsc --noEmit → 退出码 0
```

突变验证：

| 突变 | 结果 |
| --- | --- |
| `retry` 跳过 `deleteMessages` 直接重投 | Tests 1 failed / 8 passed —— 「重试：先整轮删掉再用原话重投，库里不留重复用户消息」失败 |
| `retryableTurn` 只返回失败气泡自己的 id | Tests 4 failed / 24 passed —— 三条 domain 归组用例 + 上述 Presenter 用例全部失败 |

两处均已还原，`grep -rn MUTANT src/` 无命中，复跑全绿。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| FE-05-A 只对失败气泡可用；正常消息与主动轮失败不给入口 | PASS | domain：「不是失败的 assistant 消息一律不可重试」「主动消息轮没有用户原话，返回 null」；Presenter：`retry("welcome")` → null；界面：`MessageRetry` 在两种情况下返回 `null` |
| FE-05-B 先删两行再以原话重投；成功后无重复用户消息、无失败气泡残留 | PASS | Presenter 用例：删后 `rows` 里失败气泡与 `asked-1` 都不在，第二轮 `request.text === "你好"`，结算后快照无 error 消息 |
| FE-05-C `sending` 中不可重复触发；再失败仍可重试 | PASS | Presenter 用例：新一轮在途时 `retry(failure.id)` → null 且 `submitted` 只有两轮（两次真实 send），失败气泡仍在快照里可再次重试；按钮侧 `disabled={sending}` |
| FE-05-D 归组是 domain 纯函数并单测覆盖；Presenter 在无 React 的 node 环境驱动 | PASS | `retryableTurn` 6 条用例（含旧数据回退、同号第三行、语音轮 source、主动轮 null）；Presenter 用例用 fake Runtime + fake storage，无 React |

## 共享接口影响

- `CompanionPresenter` 新增 `retry(messageId)`。实现只有一个（`createCompanionPresenter`，兜底路径 `presentation/fallback.ts` 用的是同一个实例），无第二实现需要跟进。
- 消费 CORE-08 的 `AikaStorage.deleteMessages`，未再改动存储契约。
- `CompanionRuntime` 契约未动：重试走的是普通 `submit()`，Runtime 不需要认识「重试」这件事。

## 待联调项与未覆盖范围

- NOT RUN：真机目视与真实失败重试。本仓库无 DOM 测试环境，按钮接线以「组件无自有逻辑、只转发 domain 判定与 Presenter 命令」为可审阅依据；真实 Provider 失败后点重试的完整表现需一次真实对话（配合 CORE-08 的 plugin-sql 执行留 INT-01）。
- 已知取舍：重投后的用户消息带**新的时间戳**（Runtime 每轮现取 `clock.now()`）。同一天内不影响关系状态统计（按日历天计），跨零点重试会把那句话记到新的一天。修正它需要 Runtime 支持「沿用原时间戳」，超出本 SPEC。
- 不在本 SPEC：撤回、重新生成、Rewind、用户消息编辑；撤回是否连带撤销该轮记忆候选（规划文档 §7 问题 4）仍未回答。
