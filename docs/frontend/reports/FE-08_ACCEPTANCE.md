# FE-08 Rewind（回到这里）— 验收报告

日期：2026-09-12
范围：domain 截断计划 + Presenter `rewind` 命令 + 摘要 gap 标注 + 气泡二次确认入口。不新增存储端口。

## 需求

[规划文档](../../PLAN_DEV_DEBUG_WORKBENCH.md) F1 的最后一项。SPEC 与边界见 [FE-08](../specs/FE-08.md)。

## §7 问题 1 的处理（这是取舍，不是查证结论）

规划文档 §7 问题 1 问 Rewind 对滚动摘要该「不回滚 + 标注 gap」还是「摘要可重建」。**本 SPEC 按规划文档自己的建议执行前者**：摘要没有可用的消息溯源（`saveSummary` 只记 `coversUntil`），没法只摘掉其中一句；整段作废会让每次回退都触发一次重新压缩。所以留着摘要原文，在末尾追加一行说明，让她不把摘要里已经不存在的事当成真发生过。

**如果要求「摘要可重建」，本决定可被推翻**，改动落在 LLM 侧（重新压缩剩余消息），FE 侧把这一次追加换成一次重建调用即可。

只有回退点早于 `coversUntil` 时才标注——回退点更新时，被摘要覆盖的消息一条都没删，什么都不该动。

## 为什么不需要新的存储端口

规划文档推测 Rewind 需要「按时间截断」。实际不需要：`listMessages` 返回的是**最近** N 条，锚点既然在已加载窗口里，它之后的消息必然也都在窗口里，`deleteMessages(ids)` 就够。这一点写在 `rewindPlan` 的注释里。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/conversation.ts` | 新增 `rewindPlan(messages, anchorId)` → `{ ids, anchorAt } \| null`：锚点保留、它之后全删；开场白既不是回退目标也永不进删除范围（从来不落库）；锚点之后没有消息时返回 null。 |
| `src/presentation/companionPresenter.ts` | 契约新增 `rewind(messageId)`。`dropTurn` 改名 `dropMessages(ids)`（Rewind 删的不是一轮），撤回/重投/回退三条路径共用；`refreshTimestamps()` 从撤回里抽出来共用；新增 `markSummaryGap(anchorAt)` 与 `REWIND_GAP_NOTE` 常量。落 gap 时先 `deleteSummaries?.()` 再 `saveSummary`——sqlite 的 `latestSummary` 按 `covers_until` 排序取一条，同 `coversUntil` 追加一行可能拿回旧那条。 |
| `src/hooks/useCompanionSession.ts` | 转发 `rewind`（73 行，仍在 architecture 门禁 150 行内）。 |
| `src/components/MessageActions.tsx` | 加「回到这里」，**二次确认**：第一下只把按钮换成「删掉后面全部，确定」+「取消」，第二下才派发命令。armed 状态是组件自己的，命令仍由 Presenter 执行。 |
| `src/App.tsx`、`src/App.css` | 接线与 `.message-actions button.danger` 一条样式。 |
| `src/domain/conversation.test.ts` | 新增 `rewindPlan` 6 条。 |
| `src/presentation/companionPresenter.test.ts` | 新增 5 条用例；fake storage 的摘要从「永远 null」升级为真的存起来（`latestSummary`/`saveSummary`/`deleteSummaries` 三个都按真实语义实现），否则验不了 gap；`seedTurnRows` 支持 id 后缀，便于一个用例里落两轮。 |

## 测试证据

命令（cwd = `aika-crossplatform`）：

```
npx vitest run src/domain/conversation.test.ts src/presentation/companionPresenter.test.ts
```

退出码 0：conversation 33 passed（新增 6），companionPresenter 19 passed（新增 5）。

定向回归（本次范围最大的一次，因为改动碰了三条共用路径）：

```
npx vitest run src/domain src/presentation src/hooks src/services src/kernel src/app
→ 退出码 0，Test Files 63 passed | 1 skipped (64)，Tests 771 passed | 1 skipped (772)
npx tsc --noEmit → 退出码 0
```

> 那 1 个 skipped 是既有的 `src/services/memory/crossSession.real.test.ts`（LLM-03-D 真实模型样本，按环境变量 `describe.skipIf` 关掉），与本 SPEC 无关，不是本次跳过的。

突变验证：

| 突变 | 结果 |
| --- | --- |
| `rewindPlan` 用 `slice(index)`（把锚点也删掉） | 6 failed（domain 4 + Presenter 2）——「锚点保留」「锚点之后什么都没有时不给回退」等 |
| `markSummaryGap` 去掉 `anchorAt >= summaryCoversUntil` 判断 | 1 failed ——「回退点比摘要覆盖范围更新时，摘要一字不动」 |
| `markSummaryGap` 去掉 gap 去重判断 | 1 failed ——「摘要不回滚，但覆盖到被删范围时标一个 gap，且不重复标」 |

**第三条突变第一次没命中**：原用例只往 fake storage 里 push 了一行，没更新 Presenter 的内存列表，`rewindPlan` 因此返回 null，第二次回退根本没执行，走不到去重分支。已把用例改成真的再跑一轮对话再回退，突变随即命中。三处均已还原，`grep -rn MUTANT src/` 无命中，复跑 19 passed。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| FE-08-A 锚点保留、之后全删、timestamps 刷新 | PASS | 「回退：锚点留下…」用例：`storage.rows` 只剩锚点，`relationship.totalMessageCount` 由 2 变 1（只有刷新了 timestamps 才成立） |
| FE-08-B 记忆联动与撤回同规则 | PASS | 「回退连带记忆」用例（生产仓储）：候选 `最近很累` 消失，`喜欢咖啡`(confirmed) 保留 |
| FE-08-C 摘要不回滚、按需标 gap、不重复标 | PASS | 两条用例分别覆盖「覆盖到被删范围 → 追加一行且原文不变、summaries 仍只有一行」与「回退点更新 → 一字不动」 |
| FE-08-D 三种不给入口 | PASS | domain：开场白、锚点之后为空、锚点不存在各一条；Presenter：`sending` 守卫与「锚点之后什么都没有时不动手」；组件按 `rewindPlan` 渲染 |
| FE-08-E domain 纯函数 + 无 React 驱动 | PASS | `rewindPlan` 6 条；Presenter 5 条用例用 fake Runtime + fake storage + 生产记忆仓储 |

## 共享接口影响

- `CompanionPresenter` 新增 `rewind`。未改存储契约、未改 `CompanionRuntime`、未新增 kernel token。
- domain 新增导出 `rewindPlan` / `RewindPlan`。
- 行为上新增一条：回退可能改写已落库的摘要内容（追加 gap 标注行）。摘要的 `coversUntil` 不变，消费者（提示词组装）不需要改。

## 待联调项与未覆盖范围

- NOT RUN：真机目视。二次确认是组件本地状态，无 DOM 测试环境，以「armed 只影响渲染、命令仍走 Presenter」为可审阅依据。
- 已知边界（未做）：
  - **回退不可撤销**，只有一次确认。多步撤销/重做需要保留已删数据或软删除，未做。
  - gap 标注是一行固定中文，不带「回退到了哪儿」的细节；也不会在界面上显示（只进提示词）。
  - 分页：回退只能选已加载窗口（最近 200 条）里的锚点。更早的消息要先加载出来，与本 SPEC 的截断语义无关。
  - `writeback` 队列里尚未落库的候选不参与联动（与 FE-06 同一项）。
