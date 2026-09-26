# NEXT-04 验收报告 · 文本主链与上游 Memory 保真

- 执行：goal worker（2026-09-20）。SPEC：[NEXT-04](../specs/NEXT-04.md)。需求：N06-R05。
- 状态：**AUTO_PASS**。
- 基线：`aa63a63`（NEXT-03 后）。本轮生产新增仅 `core/turn-port.ts`（薄适配），其余为测试。

## 1. 实际范围

- `core/turn-port.ts`：NextTurnPort 薄适配——submit 即接受即返回（不等待整轮）、订阅先注册、终态由 pipeline 自身 outcome 合成且每轮恰好一次、cancel 幂等（stale scope 无操作）。无第二套轮次状态机；上游 TurnController 是唯一权威。
- `tests/next/textMainChain.test.ts`：5 个端到端用例（46 个测试总数），被测链路=NextTurnPort → DialoguePipeline → SqliteLifecycleMemoryPort（生产 prepareTurn/commitTurn/source-graph/修订守卫）→ 真实临时 SQLite；仅 Provider（对话/计划/摘要/维护 propose）为可控 fake。
- 未移植旧 CompanionRuntime/Kernel；未新增记忆抽取器或维护队列（RPD 边界）。

## 2. 命令与退出码（cwd `windows/code/desktop-pet/`，2026-09-20 实跑）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run test:next`（实现后） | 0 | 46 tests / 46 pass（41→46，新增 5 个主链用例） |
| `npm run test:next`（第 2 遍） | 0 | 46/46；剥离耗时后两遍逐行一致 |
| `node --test --test-concurrency=1 dist/tests/memory/*.test.js dist/tests/providers/*.test.js` | 0 | **563/563**（上游 Memory/Provider 全量回归，覆盖本轮调用面） |
| `node tools/run-tests.mjs default`（并行模式） | 1 | 556/563：7 个失败全部为 `windowsAcl … (timeout)`（registered-voices/minimax-tts 等重 ACL 用例）；**隔离重跑 39/39、串行全量 563/563 全绿**——判定为本机并行负载下的 ACL 校验超时抖动，与本轮改动无关（本轮零生产修改）；已登记为 NEXT-08 的串行/降并发注意事项 |

TDD 修正记录：主链用例 5 处首版预期与上游真实语义不符（详见 §4 契约语义），全部以实测为准修正；生产代码零改动。

## 3. 逐 AC

| ID | 结论 | 证据 |
| --- | --- | --- |
| 04-A | **PASS** | 两轮真实对话经生产 Pipeline+LifecyclePort+SQLite：第 2 轮请求 context.recent 同时含上轮 user 与 assistant 文本；`inputTokenBudget` 来自固定配置（5000）；单一 TurnPort/Controller，无双 Runtime |
| 04-B | **PASS** | 同会话 A(gate)→B：A 终态 cancelled 且恰好一次；迟到 provider 回复 resolve 后未进入真实存储（后续轮 context 无「迟到的回复」，B 的回复完好）；cancel(A)×2 幂等无新事件；每轮 media release 必达 |
| 04-C | **PASS** | 双 NextTurnPort（不同 sessionId）共享一个生产存储：A 会话 cancel 不影响 B 活跃轮（completed）；`maxRecentMessages:2` 配置下所有请求 recent ≤2（预算真实执行） |
| 04-D | **PASS** | 关库重开：transcript 保留；生产 prepareTurn 全流程 add→correction→forget 全部 `applied` 且 `retrievalInvalidated`；纠正后检索只见新值、旧值消失；遗忘后不可检索；**迟到维护任务**（restore 引用过期版本）被拒（`maintenance_memory_mismatch` 异常，内容未复活） |
| 04-E | **PASS** | provider 抛错轮：终态 failed、无 reply 事件、无伪 assistant 落库；下一轮正常 completed 且上下文含失败轮的真实 user 消息 |

## 4. 实测上游契约语义（对本 SPEC 及后续 SPEC 有约束力）

1. **纠正（correction）轮的 source disposition**：被改记忆引用的原始来源必须随本轮显式 suppress（当前消息+记忆既有 sourceIds），新值改引保留片段别名（`f0`），并须对当前消息保留证据片段（`retainSources`，code point 坐标）——否则 `unresolved_source_disposition`/`new_evidence_will_be_suppressed`/`correction_current_without_retained_evidence` 拒绝。
2. **遗忘（forget）轮**：soft_delete 目标记忆外，还需 suppress 其来源链（含此前纠正产生的片段父记录），否则 `unresolved_source_disposition`。
3. **维护任务路径（MemoryPort.maintain）**：prepareMaintenance 校验消息与记忆的存储身份（`maintenance_message_mismatch`/`maintenance_memory_mismatch`），过期引用直接异常拒绝——任务失败、内容不复活。
4. **显式 cancel 后 begin() generation +2**（NEXT-01 已记，主链用例沿用）。
5. recent 上下文为陪伴者共享流（NEXT-01 已记，04-C 按此断言）。

以上均为上游原版行为；NEXT-05（Timeline 与遗忘联动）与 NEXT-06 必须按此对齐。

## 5. 已知限制与待办

1. TurnPort 的 `replyDelta` 事件缺位：上游在 transport 层聚合 SSE，端口层仅有整段 reply——已在 CONTRACT_MAP 登记，UI 按整段回复渲染（0.6 可接受）。
2. ACL 重 ACL 测试在并行全量时的超时抖动：NEXT-08 全量回归建议串行或降并发（证据见 §2）。
3. 语音链、Timeline 未涉及（各自 SPEC）；本步保真不含旧数据库迁移。
