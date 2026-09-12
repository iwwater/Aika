# FE-23 验收报告 · Live Inspector 外壳与实时订阅

- 执行：goal worker（2026-09-13）。SPEC：[FE-23](../specs/FE-23.md)。基线 commit：`d326d74`。
- 状态：**AUTO_PASS（待人工验收）**——A/B/C 可自动 AC 全过；D 的 Presenter 部分通过，拖拽/键盘/窄窗目视留人工。

## 改动文件

| 生产 | 测试 |
| --- | --- |
| `services/trace/traceSettings.ts`：`TraceSettingsService` 新增 `onChanged(listener): () => void`（监听器异常隔离） | 既有 settings 消费者全绿 |
| `services/trace/observableSink.ts` 新增：可观察 sink 包装（append 先落真 sink 再逐监听器通知；每个监听器独立事件副本；同步抛错 + 异步 rejection 双重隔离） | `inspectorPresenter.test.ts` 7 例 |
| `app/plugins/tracePlugin.ts`：组合 sink 包装为 observable（所有消费者同源） | — |
| `presentation/inspectorPresenter.ts` 新增：订阅先行→缓冲→tail→turnId+seq 去重合并；有界淘汰（50 轮/5000 条/512KB，超限如实提示）；查询失败仍接实时并标 unavailable；迟到的查询按 session 作废；设置订阅构造期建立（Trace 关→清视图退订，重开→自动恢复；includeText 切换→同一 redactTraceEvent 重投影显示）；快照只读投影 | — |
| `presentation/tokens.ts` + `app/plugins/presentationPlugin.ts`：`InspectorPresenterToken` 注册（sink/settings 缺任一显示引导） | — |
| `components/LiveInspector.tsx` 新增 + `App.css`：浮层（拖拽/Esc 关闭/折叠胶囊/窄窗胶囊/淘汰与屏蔽提示），devMode + 工作台打开时挂载 | — |

## 命令与退出码（2026-09-13 实跑，aika-crossplatform 下）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/presentation/inspectorPresenter.test.ts` | 7 passed | 0 |
| `npx vitest run src/presentation src/services/trace src/app/plugins src/app/composition.test.ts src/hooks src/domain/pluginGraph.test.ts` | 18 文件 / 184 passed | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 | 0 |

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| FE-23-A 查询期间并发事件不丢不重；迟到查询不污染 | `订阅先行：tail 慢的时候…合并后恰好一次`（挂起查询 + 实时 2 条 + 历史 1 条 → 3 键恰一次）；`关窗后迟到的查询结果不污染新快照`（被作废查询里的 stale:2 不出现；真实落盘 stale:1 重开后可见——合并历史正确行为） | PASS | production+fixture |
| FE-23-B 监听器与 sink 异常互不影响主链路；关闭零泄漏 | `监听器同步抛错与异步 rejection 都被隔离`（good 监听器照常收到）；`关闭后零订阅泄漏`（close 后 append 不入视图；退订函数经 observableSink 语法保证）；sink.append 抛错由 recorder 既有 try 隔离 | PASS | production+fixture |
| FE-23-C trace 关显示引导不自行开启；includeText 关后重投影 | `Trace 关闭：显示引导…重新开启自动恢复采集`（禁用期间事件不入视图；恢复后实时+历史合并）；`includeText 切换：同一 redact 函数重投影`（turn_start.text null↔正文）；UI 提示「显示屏蔽不删落盘」 | PASS | production+fixture |
| FE-23-D Presenter 测试通过；拖拽/键盘/窄窗/滚动另列浏览器目视 | Presenter 7 例全过；快照提供 events/historyStatus/evictionNote/maskingNote 供外壳渲染 | PASS（Presenter）；浏览器目视 NOT RUN（人工） | production+fixture / human（待） |

## 实现中做的判断

1. **不为浮层造 epoch**：身份就是既有 turnId+seq（SQLite 落盘同键）；实时与历史同键去重，无需协议变更。
2. **无游标分页**：历史 = 一次有界 tail（5000 条上限），超限淘汰提示「落盘历史不受影响」。
3. **字节上限独立于条数**：512KB 总量 + 5000 条 + 50 轮三重边界，淘汰从最旧开始。
4. **设置订阅生命周期**：构造期建立、随 Presenter 存活（不是随开窗）——Trace 关→开的竞态才能恢复采集；sink 订阅随 open/close。
5. **重投影语义**：落盘正文在写入时已按当时策略脱敏；显示重投影只做进一步屏蔽，includeText 重新打开不能恢复已脱敏历史（写入即脱敏的协议决定），UI 说明只称「显示屏蔽」。

## 共享接口 / 消费者

- `TraceSettingsService` 新增必选 `onChanged`（破坏性）：消费者 = tracePlugin 内部、devToolsPresenter（只用 get，无影响）、inspectorPresenter；测试内无手写 fake 实现（全部走 createTraceSettings）。
- `TraceSinkToken` 装的现在是 observable 包装（TraceSink 超集）：既有消费者（devToolsPresenter、recorder）不受影响。
- CONTRACTS：TraceSettingsService.onChanged 记录于本报告；FE-24/25 将消费 InspectorPresenter 的数据面。

## 未测/人工项

- 拖拽/键盘关闭/窄窗胶囊/聊天滚动并行：浏览器目视（人工，LiveInspector 已实现对应结构）。
- 真实 Tauri/SQLite 下的 tail 查询时延与大数据量表现：INT-01。
