# CORE-08 · 消息删除端口

状态：已自测。A–E 五条 AC 全 PASS；两个真实实现跑同一份用例包 36 测试通过；真实 plugin-sql 执行留 INT-01。证据见 [验收报告](../reports/CORE-08_ACCEPTANCE.md)。

## 为什么需要它

[规划文档](../../PLAN_DEV_DEBUG_WORKBENCH.md) F1 的四项交互——重试失败轮、撤回、重新生成、Rewind——全部卡在同一个缺口上：**`AikaStorage` 没有任何删除消息的接口**，只有 `deleteMemory` 与整库 `clearMessages`。

规划文档把「error 气泡上直接重试按钮」标为「小改」，事实不是：

- 失败气泡由 `presentation/companionPresenter.ts` 的 `finish()` 在判失败后 `await persist(failure)` 落库，是一条真实的 assistant 行。
- 用户那句话也已落库：`services/runtime/companionRuntime.ts` 在生成前就 `await persist(turn, asked)`（注释写明「后面生成失败，这一句也不该丢」）。
- `CompanionRuntime.submit()` 每轮都新建 uuid 并重新持久化用户消息，所以直接重投会留下**两条相同的用户消息**加一条永久失败气泡。

因此重试必须先能删掉这两行。删除语义属端口契约，与界面无关，单独立项。

## 目标与边界

- 输入：既有 `AikaStorage` 契约、两个真实实现（`sqliteStorage`、`localStorageStorage`）、既有端口一致性用例包 `storage.conformance.ts`。
- 输出：`AikaStorage` 上一个删除消息的方法、两个实现、用例包中的对应断言、共享契约记录。
- 负责范围：端口契约与两个实现的行为一致性。
- 不做：**不加界面、不加 Presenter 命令、不改 `CompanionRuntime` 契约**（`RuntimeStorage` 不需要删除能力，保持不变）；不做 Rewind 的截断语义与摘要 gap 标注；不碰记忆连带删除的决策；不引入迁移框架。

## 接口设计

```ts
export interface AikaStorage {
  // …既有成员不变
  /** 按 id 删除消息。未知 id 静默忽略，重复调用幂等。 */
  deleteMessages(ids: readonly string[]): Promise<void>;
}
```

设计取舍：

- **批量而不是单条**：重试要一次删掉「用户那条 + 失败气泡」两行，Rewind 要删一段。单条接口会让调用方循环发 N 次请求，SQLite 侧也拿不到单条语句的原子性。
- **必选而不是可选**：两个实现都能实现它，没有平台差异。放进 `STORAGE_OPTIONAL` 等于允许某个实现悄悄不支持，调用方就得写降级分支——而「删不掉」没有合理的降级。
- **不连带作废摘要**：与 `clearMessages()` 明确区分。删掉最近一条失败消息不该触发整段摘要重压缩；摘要覆盖的是更早的消息。摘要里可能残留已删内容，这与 [规划文档](../../PLAN_DEV_DEBUG_WORKBENCH.md) §7 问题 1 的建议（摘要不回滚 + 标注 gap）一致，gap 标注留给 Rewind 的 SPEC。
- **不连带删除记忆**：撤回是否该撤掉该轮抽取的记忆候选是产品决策（规划文档 §7 问题 4），端口不替调用方决定。

## AC

| AC | 模块内验收 |
| --- | --- |
| CORE-08-A | 两个真实实现跑**同一份**用例包全绿：删掉的读不到，未列出的一条不动 |
| CORE-08-B | 幂等与边界：未知 id 不抛错，同一 id 删两次不抛错，空数组是 no-op 且不影响既有数据 |
| CORE-08-C | 派生查询随之更新：`listMessageTimestamps`、`countMessagesSince`、`countProactiveSince` 在删除后与剩余消息一致 |
| CORE-08-D | 不连带：删除消息后 `latestSummary()` 与 `listMemories()` 不变；`clearMessages()` 仍照旧连带作废摘要（既有用例不回归） |
| CORE-08-E | 用例包不可稀释：把任一实现的删除行为改坏（如只删第一个 id），对应用例必须失败；改回后复跑全绿 |

证据：`npx vitest run src/services/storage/storage.conformance.test.ts` 的退出码与用例数，两个 harness 各自全绿；突变验证记录。

## 模块内执行与交付

1. 先确认上述接口与负责范围，再实现；不要顺带执行 FE 侧的重试按钮。
2. 只 mock 外部依赖：localStorage 走 stub 过的全局，SQLite 走 `nodeSqlite.harness` 的真实 node:sqlite 引擎，两边都跑生产代码。
3. 共享契约按「v1 之后的追加」记录在 [共享契约](../../modules/CONTRACTS.md)：新增必选方法、兼容方式、受影响消费者。
4. 交付 `../reports/CORE-08_ACCEPTANCE.md`。不默认跑全仓测试、全局 build 或 Tauri 打包。

输入输出遵循 [共享契约](../../modules/CONTRACTS.md)，测试规则见 [模块测试规则](../../modules/TESTING.md)。
