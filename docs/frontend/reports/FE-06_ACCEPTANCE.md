# FE-06 撤回与重新生成 — 验收报告

日期：2026-09-12
范围：domain 轮次判定 + Presenter 两个命令 + 气泡操作行。前置 [CORE-08](../../core/specs/CORE-08_MESSAGE_DELETION.md)、[FE-05](../specs/FE-05.md) 已通过。

## 需求

[规划文档](../../PLAN_DEV_DEBUG_WORKBENCH.md) F1 剩下的两项消息级操作。SPEC 与边界见 [FE-06](../specs/FE-06.md)。

## §7 问题 4 的回答

规划文档 §7 建议「撤回=该轮从未发生」，本 SPEC **采纳但收窄**，依据是两处查证：

1. `MemoryRecordV2.sourceMessageIds` 存在，`runBackgroundMemoryWork` 落候选时确实写了它（注释原话：「也是删除联动的依据」）——溯源可行，不需要新增字段。
2. 但抽取输入是 `allMessages.slice(-4)`，一条记忆的来源常跨两轮，「来源有交集」是宽判据。

落地规则：来源与被撤回消息有交集、且状态仍为 `candidate` 的记忆走 `repository.forget()`；**`confirmed` 一律保留**——那是用户明确说过要留的，不能因为一次撤回悄悄消失。V1 记忆路径没有来源字段，撤回只删消息、不动记忆，也不报错。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/conversation.ts` | 把 FE-05 的归组抽成基元 `messageTurn(messages, id)`（任一行都能找回整轮，主动轮 `text` 为空串）；`retryableTurn` 改为基于它的薄包装（语义不变，FE-05 的 6 条用例未改一行仍全绿）；新增 `regeneratableTurn`（assistant 且非 error、非 pending、有用户原话）；新增 `WELCOME_MESSAGE_ID` 常量。 |
| `src/presentation/companionPresenter.ts` | 契约新增 `regenerate(messageId)`、`withdraw(messageId)`。内部抽出 `dropTurn`（先删存储再删界面，失败就整轮留在原处）与 `resubmitTurn`（重试/重新生成共用「先删再投」），`retry` 改为薄包装。`withdraw` 额外做两件事：刷新 `timestamps`（撤回后面没有新一轮来顺带对齐存储，重投有）、调 `forgetCandidatesFrom` 做记忆联动。开场白拒绝撤回。 |
| `src/hooks/useCompanionSession.ts` | 转发两个新命令（69 行，仍在 architecture 门禁 150 行内）。 |
| `src/components/MessageActions.tsx` | 新增，取代 FE-05 的 `MessageRetry.tsx`（已删除）。三个入口合成一排；重试与重新生成互斥（失败给重试、成功给重新生成，不在同一气泡冒两个同义按钮）；开场白一个都不给；判定仍全在 domain。 |
| `src/App.tsx` | 换成 `<MessageActions … />`，三个回调各派发一个 Presenter 命令。 |
| `src/App.css` | `.message-retry` 三条换成 `.message-actions` 八条：默认随 `.message-row:hover` 淡入（失败气泡常显），品红色系只用于错误行。 |
| `src/domain/conversation.test.ts` | 新增 `messageTurn` 3 条、`regeneratableTurn` 5 条。 |
| `src/presentation/companionPresenter.test.ts` | 新增 5 条用例；`setup()` 支持注入记忆能力，记忆侧用**生产** `createMemoryRepository` 跑在 `createInMemoryMemoryStore` 上（手搓假仓储证明不了 `forget` 的真实语义）；新增 `seedTurnRows()` 按真实形状落库（fake Runtime 不落库，而撤回验的正是「库里那几行怎么消失」）。 |

## 测试证据

命令（cwd = `aika-crossplatform`）：

```
npx vitest run src/domain/conversation.test.ts src/presentation/companionPresenter.test.ts
```

退出码 0：conversation 27 passed（新增 8），companionPresenter 14 passed（新增 5）。

定向回归：

```
npx vitest run src/domain src/presentation src/services/storage src/hooks \
  src/kernel/architecture.test.ts src/app
→ 退出码 0，Test Files 39 passed (39)，Tests 483 passed (483)
npx tsc --noEmit → 退出码 0
```

突变验证（三条最容易被写错、且后果最严重的行为）：

| 突变 | 结果 |
| --- | --- |
| 记忆联动去掉 `status === "candidate"` 判断（连 confirmed 一起删） | 1 failed —— 「撤回连带记忆：来源有交集的候选被遗忘，确认过的保留」 |
| 撤回后不刷新 `timestamps` | 1 failed —— 「撤回：整轮从存储与界面消失，timestamps 跟着刷新」 |
| 去掉开场白保护 | 1 failed —— 「撤回：开场白删不掉——它从来不落库」 |

三处均已还原，`grep -rn MUTANT src/` 无命中，复跑 14 passed。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| FE-06-A 撤回：整轮从存储与界面消失；timestamps 随之刷新 | PASS | Presenter 用例：撤回后 `storage.rows` 为空、快照无这两条、`relationship.totalMessageCount` 由 >0 变 0（这个断言只有刷新了 timestamps 才成立） |
| FE-06-B 记忆联动：candidate 被 forget、confirmed 保留、无 V2 仓库时只删消息 | PASS | 「撤回连带记忆」用例（生产仓储）：剩下 `喜欢咖啡`(confirmed) 与 `在东京住`(别轮候选)，`最近很累` 已消失；「没有 V2 仓库时只删消息」用例：`storageError` 为空串且行已删 |
| FE-06-C 重新生成：成功气泡可用，先删整轮再以原话重投，无重复用户消息 | PASS | 「重新生成」用例：删后 `rows` 为空，第二轮 `request.text === "你好"`，结算后无用户消息残留；domain 用例覆盖 pending/error 不可用 |
| FE-06-D 入口互斥且不误现 | PASS | domain：`retryableTurn` 只认 error、`regeneratableTurn` 拒 error/pending/user/proactive/开场白；组件按这两个判定渲染，`disabled={sending}` |
| FE-06-E 判定是 domain 纯函数并单测覆盖；命令在无 React 的 node 环境驱动 | PASS | `messageTurn` 3 条 + `regeneratableTurn` 5 条；Presenter 5 条用例用 fake Runtime + fake storage + 生产记忆仓储，无 React |

## 共享接口影响

- `CompanionPresenter` 新增 `regenerate`、`withdraw`。实现只有一个（兜底路径用的是同一个实例），无第二实现需跟进。
- 未改存储契约、未改 `CompanionRuntime`：重新生成走普通 `submit()`。
- domain 新增导出 `messageTurn` / `regeneratableTurn` / `MessageTurn` / `WELCOME_MESSAGE_ID`；`RetryableTurn` 变为 `MessageTurn` 的别名，FE-05 的调用方无需改动。
- 开场白 id 从 Presenter 的私有字面量提到 domain 常量，Presenter 三处与组件一处共用，消除重复魔法字符串。

## 待联调项与未覆盖范围

- NOT RUN：真机目视。无 DOM 测试环境，按钮接线以「组件只转发 domain 判定与 Presenter 命令」为可审阅依据；真实点击撤回/重新生成的完整表现需一次真实对话（与 CORE-08 的 plugin-sql 执行一并留 INT-01）。
- 已知边界（如实记录，未做）：
  - 撤回**没有撤销确认**。误点会直接删掉那一轮，目前只能靠重新说一遍。加撤销需要保留已删行或加一层软删除，超出本 SPEC。
  - 记忆写回队列（`writeback`）里尚未落库的候选不参与联动：撤回发生在 flush 之前时，那批候选之后仍会落库。需要队列侧支持按来源撤销，属 LLM 侧改动。
  - 重投后的用户消息带新时间戳（FE-05 已记录的同一项）；撤回不触发摘要重压缩，摘要里可能残留已撤回内容——与 §7 问题 1 的「摘要不回滚 + 标注 gap」建议一致，gap 标注仍未做，留 Rewind。
- 不在本 SPEC：Rewind、点击发音、用户消息编辑。
