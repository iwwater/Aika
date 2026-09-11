# CORE-08 消息删除端口 — 验收报告

日期：2026-09-12
范围：`AikaStorage` 契约 + 两个真实实现 + 端口一致性用例包。不含界面、Presenter 命令、`CompanionRuntime` 契约变更。

## 需求

`AikaStorage` 只有 `deleteMemory` 与整库 `clearMessages`，没有任何删除消息的接口，[规划文档](../../PLAN_DEV_DEBUG_WORKBENCH.md) F1 的重试/撤回/重新生成/Rewind 全部卡在这里。SPEC 与取舍见 [CORE-08](../specs/CORE-08_MESSAGE_DELETION.md)。

查证结论（更正规划文档把重试称为「小改」）：

- 失败气泡是真实落库行——`presentation/companionPresenter.ts` 的 `finish()` 在判失败后 `await persist(failure)`。
- 用户那句话也已落库——`services/runtime/companionRuntime.ts:507` 在生成前 `await persist(turn, asked)`，注释写明「后面生成失败，这一句也不该丢」。
- `CompanionRuntime.submit()` 每轮新建 uuid 并重新持久化用户消息，直接重投会留下两条相同的用户消息 + 一条永久失败气泡。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/services/storage/contracts.ts` | `AikaStorage` 新增必选方法 `deleteMessages(ids: readonly string[]): Promise<void>`，注释写明与 `clearMessages()` 的分界（不连带摘要、不连带记忆）。 |
| `src/services/storage/sqliteStorage.ts` | 实现：按 id 个数现拼占位符后单条 `DELETE ... WHERE id IN (…)`（plugin-sql 不支持把数组绑成一个 IN 参数）；空数组直接返回，不发语句。 |
| `src/services/storage/localStorageStorage.ts` | 实现：按 id 集合过滤快照后整份写回；空数组直接返回，不触发写。 |
| `src/services/storage/storage.conformance.ts` | 新增 4 条契约断言（见下）。两个实现跑同一份，无实现专属分支。 |
| `src/presentation/companionPresenter.test.ts` | 测试 fake 补上 `deleteMessages`，按真实语义过滤 `rows`（不是空实现）。 |
| `docs/modules/CONTRACTS.md` | 记为「v1 之后的追加（2026-09-12，CORE-08）」：必选方法、兼容方式、受影响消费者、语义边界。 |
| `docs/core/SPEC.md`、`docs/core/specs/CORE-08_MESSAGE_DELETION.md` | SPEC 与索引一行。 |

设计取舍（详见 SPEC）：批量而非单条（重试要一次删两行，Rewind 要删一段）；必选而非可选（「删不掉」没有合理降级，不放进 `STORAGE_OPTIONAL`）；不连带作废摘要（与 §7 问题 1 的建议一致，gap 标注留给 Rewind）；不连带删记忆（§7 问题 4 是产品决策，端口不代替调用方决定）。

## 测试证据

命令（cwd = `aika-crossplatform`）：

```
npx vitest run src/services/storage/storage.conformance.test.ts
```

退出码 0。结果：Test Files 1 passed (1)，Tests 36 passed (36)（此前 28 条 = 14×2，现 18×2；两个 harness 各跑 4 条新用例）。两个 harness 都走生产代码：`localStorageStorage` 用 stub 过的全局 localStorage，`sqliteStorage` 用 `nodeSqlite.harness` 的真实 node:sqlite 引擎，SQL 与迁移一字未改。

定向回归：

```
npx vitest run src/services/storage src/presentation/companionPresenter.test.ts \
  src/app/ports.swapMatrix.test.ts src/app/composition.test.ts
→ 退出码 0，Test Files 9 passed (9)，Tests 89 passed (89)
npx tsc --noEmit → 退出码 0
```

> `tsc --noEmit` 在本 SPEC 不是可选项：新增的是**必选**契约方法，只有类型检查能找出所有需要补实现的 `AikaStorage` fake。它确实找到了一处（`companionPresenter.test.ts:150`），已按真实语义补上。未执行 `npm run build`、全仓 `npm test` 或 Tauri 打包。

突变验证（CORE-08-E，两个实现各验一次）：

| 突变 | 结果 |
| --- | --- |
| `sqliteStorage.deleteMessages` 改成只删 `ids[0]` | Tests 2 failed / 34 passed —— 失败项：「按 id 删除消息：删掉的读不到，没列出的一条不动」「删除后派生查询跟着变」 |
| `localStorageStorage.deleteMessages` 顺带 `write(KEYS.summaries, [])` | Tests 1 failed / 35 passed —— 失败项：「删除消息不连带作废摘要、也不动记忆」 |

两处均已还原，`grep -rn MUTANT src/` 无命中，复跑 36 passed。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| CORE-08-A 两实现跑同一份用例包全绿；删掉的读不到，未列出的不动 | PASS | 「按 id 删除消息」用例 ×2 harness |
| CORE-08-B 未知 id 不抛错、重复删幂等、空数组 no-op | PASS | 「删除是幂等的」用例：连续 `["nope"]`、`[]`、`["a"]`、`["a"]` 四次调用后列表为空且无异常 |
| CORE-08-C 派生查询随之更新 | PASS | 「删除后派生查询跟着变」：`listMessageTimestamps` → `[100]`，`countMessagesSince(0)` → 1，`countProactiveSince(0)` → 0 |
| CORE-08-D 不连带摘要与记忆；`clearMessages` 行为不回归 | PASS | 「删除消息不连带作废摘要、也不动记忆」+ 既有「清空消息会连摘要一起作废」仍全绿 |
| CORE-08-E 用例包不可稀释 | PASS | 上表两次突变各命中对应用例 |

## 共享接口影响

- 新增必选方法 `AikaStorage.deleteMessages`，已记入 [共享契约](../../modules/CONTRACTS.md) 的「v1 之后的追加（2026-09-12，CORE-08）」。
- 既有成员语义零改动，生产消费侧 0 改动（本 SPEC 尚无调用方）。`RuntimeStorage` 窄接口不变，Runtime 不获得删除能力。
- 对后续 fake 的约束：任何新的 `AikaStorage` 替身必须实现该方法，由 `tsc` 与用例包共同守住。

## 待后续（本 SPEC 不做）

- FE 侧重试按钮（消费该端口）——下一份 SPEC。
- 撤回是否连带撤销该轮记忆候选（规划文档 §7 问题 4）：端口不决定，留给界面侧 SPEC 与用户确认。
- Rewind 的截断语义与摘要 gap 标注（§7 问题 1）：需要的是「按时间截断」而不只是「按 id 删除」，届时再评估是否追加第二个方法。
- NOT RUN：真实 Tauri 桌面环境下的 `plugin-sql` 执行。本报告的 SQLite 证据来自 node:sqlite 真实引擎跑生产 SQL，`IN (…)` 占位符在 plugin-sql 上的绑定行为待 INT-01 一并验证。
