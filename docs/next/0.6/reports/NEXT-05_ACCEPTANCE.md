# NEXT-05 验收报告 · 最小 Chat Timeline

- 执行：goal worker（2026-09-20）。SPEC：[NEXT-05](../specs/NEXT-05.md)。需求：N06-R06。
- 状态：**AUTO_PASS**。
- 基线：`df9ca9c`（NEXT-04 后）。产出：`management/aika-timeline.ts`、`core/turn-port.ts` 增加 `accepted` 事件、7 个 Timeline 契约用例（总计 53）。

## 1. 实际范围

- `AikaTimelineStore`：最小独立 SQLite 表（better-sqlite3，无新 ORM）；`append`（eventId 主键：同 ID 同 payload=duplicate，不同 payload=`TimelineConflictError`，redacted 行永不复活）；`list`（持久化 sort_key 稳定分页，limit 1–100 校验，session 过滤）；`redactByMessageIds`（幂等，tombstone 保留）。
- `AikaTimelineRecorder`：订阅 TurnPort 的 accepted/reply/terminal——userMessage 在接受时记一次，assistantTerminal 仅终态记一次；cancelled/failed 保留部分文本但 status 明确；≤3 次有界重试、耗尽后 onError 可观测、不再重试；重放不重复。
- 未做：token 级日志、屏幕采集、Timeline→Context 检索（RPD 排除项）；查询 UI 留 NEXT-07（真实查询接口已按 05-C 验收）。

## 2. 共享文件变化

| 文件 | 变化 | 影响 |
| --- | --- | --- |
| `core/turn-port.ts` | TurnPortEvent 新增 `accepted` 变体（submit 接受时发出，携带文本） | 既有事件与语义不变；现有用例全绿 |
| `management/aika-timeline.ts` | 新增 Next 模块（独立表，不触碰上游 SqliteMemoryStore schema） | 无上游消费者 |

## 3. 命令与退出码（cwd `windows/code/desktop-pet/`）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run test:next`（第 1 遍） | 0 | 53 tests / 53 pass（46→53） |
| `npm run test:next`（第 2 遍） | 0 | 53/53；剥离耗时后两遍逐行一致 |

TDD 记录：先写测试（RED：模块缺失），实现后 3 处测试侧问题修正（Windows 下 WAL `-shm` 清理锁→改默认 journal；node:test after 钩子顺序→单钩子先 close 后 rm；中文报错正则）。存储实现侧以 `store_close_hook` 之外的顺序问题零生产改动解决；测试中 fault 注入用真实存储包装器实现（未 mock 掉 Timeline）。

## 4. 逐 AC

| ID | 结论 | 证据 |
| --- | --- | --- |
| 05-A | **PASS** | recorder 用例：accepted→userMessage 一次、terminal→assistantTerminal 一次；completed 带完整文本；cancelled 带部分文本且 status=cancelled（不冒充完整）；failed 可观测（errors 数组） |
| 05-B | **PASS** | 同 ID 同 payload=`duplicate`；同 ID 不同 payload=`TimelineConflictError`；20 个并发 `Promise.all` 全部 inserted 且查询恰 20 条（主键唯一性） |
| 05-C | **PASS** | 关库重开可查询；30 条同 occurredAt 事件按 limit 7 分页遍历 30/30 无漏无重、顺序稳定；跨 session 过滤精确（session-z 恰 1 条）；limit 0/101 抛 ManagementError |
| 05-D | **PASS** | fault 包装器：失败 2 次后第 3 次成功落库（恰好 3 次尝试）；连续失败时 onError 恰 1 次且尝试数止于 3；成功重放同 eventId=`duplicate`；对话回复不受影响（recorder 全异步旁路） |
| 05-E | **PASS** | redact ×2 幂等；正文置空；重放同事件=`duplicate` 且文本不复活；tombstone 重开仍在；集成用例：来源消息 seed:user 被删/遗忘后其 Timeline 正文不可查，无关事件（assistant）文本保留 |
| 05-F | **PASS** | recorder stop 后监听器数 0；停止后重启抛 ManagementError；端口侧 unsubscribe 对称；二次 recorder 正常启动/停止 |

## 5. 与 Memory forget 的联动边界（如实登记）

`redactByMessageIds` 已按 messageId（上游 transcript 记录 id，如 `turnId:user`）对齐：management 遗忘路由（NEXT-07 接线）在删除来源消息时调用即可同步清理正文。上游 lifecycle forget（dynamics suppress）不产生消息级事件推送，自动联动需要一个上游未暴露的钩子——本 SPEC 提供接口与验证，自动接线在 NEXT-07/08 集成时以显式调用补齐，不静默宣称已自动联动。

## 6. 待人工项

无（本 SPEC 全自动验收）。
