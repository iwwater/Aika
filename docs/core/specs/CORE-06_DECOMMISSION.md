# CORE-06 · 旧路径下线与契约冻结

状态：A–E 五条 AC 自测 PASS；全仓单一编排路径，内核契约已冻结；**触发 INT-01**（跨模块文本链路验证待排期）；待审阅。证据见 [验收报告](../reports/CORE-06_ACCEPTANCE.md)。

## 目标与边界

- 输入：CORE-01…05 的验收报告与已切换到 kernel 的运行结果。
- 输出：删除的 legacy 编排与开关、更新后的共享契约、CORE 模块收尾报告。
- 前置：CORE-05 通过，且 CORE-03 的默认值已为 kernel 并稳定运行过一段真实使用。
- 负责范围：删除 `useCompanionSession` 的 legacy 分支与 `core.orchestrator` 开关；清理不再被引用的旧装配代码；更新 `docs/modules/CONTRACTS.md`、`docs/modules/README.md`、`docs/README.md`。
- 不做：不借收尾之名做新功能、新重构或顺手优化；不删除任何仍被引用的模块；不改测试断言来凑通过。

这一份存在的唯一理由：**两条路径长期共存是本次重构最坏的结局。** 未执行 CORE-06，CORE 模块不算完成。

## 架构与接口设计

删除清单在执行时按实际引用关系确认，预期包含：

- `hooks/useCompanionSession.ts` 内的 legacy `send()` 分支与 `busyRef` / `requestSeqRef` / `activeRequestRef` 私有计数。
- `core.orchestrator` 设置项的读写与分支；已写入该设置的旧库读到时忽略，不报错、不迁移。
- `services/storage/index.ts` 中标注 deprecated 的转发导出（`openStorage`、`secretStore` 等），前提是全仓已无调用方。
- `hooks/hookHarness.ts`：若 Presenter 测试已不再需要模拟 React，则删除；仍有必要保留时在报告中说明具体哪个测试还依赖它，不含糊带过。

契约更新：在 `docs/modules/CONTRACTS.md` 增加内核相关行——服务注册表与插件契约的所有者、`resolve` 的使用位置约束、token 的分散所有权（无中央清单）、「能力缺失即 token 不注册」的降级语义、`runtimeTurnId` 与旧 `turnId` 的并存规则。这是共享契约变更，须记录版本与受影响消费者。

## 实施内容与验收条件

交付单一路径与冻结的契约。

| AC | 模块内验收 |
| --- | --- |
| CORE-06-A | 单一编排：全仓生产代码只有一条对话编排路径；`providerClient` 的调用方只剩 Runtime 侧适配与 memory extractor；静态扫描 `core.orchestrator` 与 legacy 分支已无残留 |
| CORE-06-B | 无死代码：删除后 `tsc` 无未使用导出报错，被删模块无任何引用；已写入旧设置项的存储读取时被忽略且不报错 |
| CORE-06-C | 测试不缩水：CORE 模块相关测试数量与覆盖范围不低于 CORE-01 之前的基线；任何删除的测试在报告中列出替代证据，不得因迁移静默减少断言 |
| CORE-06-D | 契约已更新：`docs/modules/CONTRACTS.md` 记录内核契约、`resolve` 位置约束、能力缺失语义与 turnId 并存规则，并标注受影响消费者与版本 |
| CORE-06-E | 完成定义达标：内核与 Presenter 的测试不依赖 `hookHarness`；`useCompanionSession.ts` 不 import 任何 `services/` 实现；示例插件的扩展点结论仍成立（重跑 CORE-05-C）；CORE-01-C 的内核零业务词汇扫描与 CORE-02-D 的无总表扫描重跑仍通过 |

## 模块内执行与交付

1. 先确认上述接口与负责范围，再实现当前 SPEC；不要顺带执行下一份 SPEC。
2. 对本次修改的生产逻辑准备定向测试名单。只 mock 外部依赖，不 mock 本模块被验收逻辑；无需启动其他模块。
3. 报告每条 AC 的测试文件/样本、真实命令及退出码，质量样本标明实际模型或 fixture。证据不足保留 NOT RUN/BLOCKED，不能降低门槛。
4. 交付 `../reports/CORE-06_ACCEPTANCE.md`，同时写一份 CORE 模块收尾结论；原任务审阅证据。

本 SPEC 删除生产路径并更新共享契约，属于 [集成 SPEC](../../integration/SPEC.md) INT-01 的触发条件：执行完成后安排一次文本链路的跨模块验证。全量回归与打包按 INT-03 另行安排，不在本 SPEC 内声称发布通过。共享规则见 [模块测试规则](../../modules/TESTING.md)；输入输出遵循 [共享契约](../../modules/CONTRACTS.md)。
