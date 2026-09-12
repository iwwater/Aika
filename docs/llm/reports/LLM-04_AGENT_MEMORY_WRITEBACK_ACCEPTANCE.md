# LLM-04 验收报告 · 单次生成与后台维护

- 执行：goal worker（2026-09-13）。SPEC：[LLM-04](../specs/LLM-04_AGENT_MEMORY_WRITEBACK.md)。基线 commit：`c877210`。
- 前置审阅：CORE-01～09 / LLM-01～03、06～10 已 REVIEWED_AUTO（见 GOAL_RUN_LEDGER）；既有 `services/memory/writeback.ts` 仅有内存队列、presenter 内联 flush，本 SPEC 按其重写为唯一后台 worker 并切换装配。

## 改动文件

| 生产 | 测试 |
| --- | --- |
| `services/memory/writeback.ts` 重写：`createMemoryMaintenance`（批次快照/稳定批次 ID/单 worker 链/指数退避 1s→30s/至多 3 次/epoch 作废/journal 持久化/8 轮阈值触发/容量上限/候选快照复原） | `services/memory/writeback.test.ts` 重写：13 例 |
| `services/memory/maintenanceJournal.ts` 新增：存储 KV 单记录原子替换的 journal 适配（localStorage 无多键事务下的最强提交边界） | — |
| `services/providerClient.ts`：`RequestMetric` + 每次物理尝试 started/completed/failed/cancelled 计量；streamChat 受控 fallback 每次尝试独立计数；requestJson/requestPlainText 接受 options | `services/providerClient.test.ts` +3 例 |
| `services/memory/extractor.ts`：extract/summarize 接受维护计量上下文（purpose=maintenance + turnId） | — |
| `services/runtime/providerAdapter.ts`：前台生成透传 purpose=foreground、turnId、计量 sink | — |
| `presentation/companionPresenter.ts`：装配 maintenance（journal=存储 KV）；抽取候选入队不再内联 flush；成功轮经 runBackgroundMemoryWork 推进阈值；开关位 setEnabled；dispose 释放；deps 增加 `maintenanceTurnThreshold?`（默认 8） | — |

## 命令与退出码（2026-09-13 实跑，aika-crossplatform 下）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/services/memory/writeback.test.ts` | 13 passed | 0 |
| `npx vitest run src/services/providerClient.test.ts src/services/memory` | 87 passed + 1 skipped（crossSession.real 环境门控） | 0 |
| `npx vitest run src/presentation src/hooks src/services/runtime src/app/composition.test.ts src/app/plugins src/services/memory src/services/providerClient.test.ts` | 274 passed + 1 skipped | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 | 0 |

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| LLM-04-A 每轮实时请求恰好一次；后台/重试分别计量 | 计量在唯一网络出口 providerClient：`受控 fallback 的每次尝试独立计数 = attempt 1/2/3`、sendChat 单尝试 started→completed（providerClient.test）；前台 purpose=foreground+turnId 由 adapter 透传；抽取/摘要 purpose=maintenance（extractor ctx）。20 轮恰好一次由既有 companionRuntime 套件覆盖（每 turn 一次 streamChat，无追加实时请求） | PASS（fixture） | production+fixture |
| LLM-04-B 后台不延迟正文；重复批次/重启不重复写入；关闭后不继续提交 | 队列操作 fire-and-forget（noteTurn/enqueue 不 await）；`同一来源重复投递不生成第二批；done 后重复投递不再执行`、`重启恢复：日志里 running 批次回 pending`、`关闭维护：待处理批次作废，重新开启不复活`、`提交边界：等待期间关闭，已提交不回滚，批次不再重跑`（writeback.test） | PASS（fixture） | production+fixture |
| LLM-04-C 断流/取消/畸形候选不非法写回；正文后不重放；首正文前降级单独计量 | `空候选与畸形候选都不进队列`；取消轮计 cancelled 不冒充 completed（providerClient.test）；正文后失败不重放为既有契约（`已经吐过内容再断就报错`）；fallback 单独 attempt 计量见上 | PASS（fixture） | production+fixture |
| LLM-04-D 四协议 fixture；真实服务分列 | 四协议（openai-compatible/openai-responses/anthropic/gemini）fixture 用例在 providerClient.test 既有全绿；真实服务联通 NOT RUN（无凭证不调用） | PASS（fixture）；真实 NOT RUN | production+fixture |

## 实现中做的判断

1. **批次快照整存 KV 单记录**（maintenanceJournal）：SQLite 多键事务语义归存储层/INT-01；localStorage 侧按审阅结论用单记录原子替换，不假性强加 SQL。
2. **阈值触发点在 runBackgroundMemoryWork 内、候选入队之后**：结算路径先触发会跑空队列；抽取失败不影响计数（noteTurn 在 try/catch 之后）。
3. **deps.maintenanceTurnThreshold 测试 seam（默认 8）**：hook 集成测试关注「每轮后写回已落库」的重试语义，注入 1 保持其意图；生产默认 8 的阈值行为由 writeback.test `noteTurn 按阈值触发` 覆盖。
4. **dispose 不做异步 flush**：sessionEnd 是显式事件，不能依赖进程退出时异步 flush 一定成功（SPEC 审阅结论）；关闭前未满阈值的批次（<8 轮窗口）随进程退出丢失，属 SPEC 接受的边界。
5. **维护队列不做网络请求**：维护用途的真实网络请求只有抽取/摘要，经 extractor ctx 计量；队列本身只写存储。

## 共享接口 / 消费者

- `MemoryExtractor` 接口新增可选第三参（向后兼容，既有 fake 实现不受影响）；`ProviderRequestOptions` 新增三个可选字段（向后兼容）；`ProviderStreamEvent` 无变化；`docs/modules/CONTRACTS.md` 无需变更（无跨模块端口签名变化）。
- 受影响消费者：companionPresenter（已切换）、useCompanionSession 集成测试（注入阈值 1）、FE-26/LLM-12 未来消费 RequestMetric。
- 集成待测项：真实 Tauri/plugin-sql 下的 KV journal 与事务语义（INT-01）；真实凭证下的四协议真实轨（NOT RUN）。

## 未测/边界

- 真实模型/真实凭证：NOT RUN（不调用）。
- 崩溃恢复的物理进程级验证：以 journal 状态手工构造模拟（writeback.test），真实进程崩溃注入属 INT-01/人工。
