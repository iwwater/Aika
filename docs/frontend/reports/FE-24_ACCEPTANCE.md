# FE-24 验收报告 · 泳道时间线、检查器与导出

- 执行：goal worker（2026-09-13）。SPEC：[FE-24](../specs/FE-24.md)。基线 commit：`bcb9bcd`。
- 状态：**AUTO_PASS（待人工验收）**——A/B/C/D 可自动 AC 全过；浮层视觉/拖拽目视留人工。

## 改动文件

| 生产 | 测试 |
| --- | --- |
| `domain/traceView.ts`：新增 `buildTurnTimeline` / `TurnTimeline` / `TurnTimelineStage`——重复按 turnId+seq 吞掉、乱序排序修复；只有真实配对（turn_end.durationMs、provider_stream_meta.firstTokenMs）给耗时；其余为相邻事件差=阶段间隔；负时钟差 intervalMs=null；缺 turn_end → running/totalMs=null；首可见正文（reply 间隔）与首字节分开命名；usage 缺失=null（未知） | `traceView.timeline.test.ts` 6 例 |
| `presentation/inspectorPresenter.ts`：`turnSummaries()`（锁定列表）、`selectTurn(id|null)`（锁定历史轮/回到最新）、`timeline(turnId)`、`exportJsonl(turnId?)`（与页面同一投影函数+同一 store → 逐字节一致；coverageNote 注明有界缓存范围，不代表完整 Session；选中轮被淘汰时回退最新） | `inspectorPresenter.test.ts` +2 例 |
| `components/LiveInspector.tsx` + `App.css`：轮次选择（锁定/最新）、时间线渲染（间隔/未知显示）、事件详情 JSON 面板、导出按钮（下载 JSONL + 覆盖范围提示） | — |

## 命令与退出码（2026-09-13 实跑，aika-crossplatform 下）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/domain/traceView.timeline.test.ts src/presentation/inspectorPresenter.test.ts` | 15 passed | 0 |
| `npx vitest run src/presentation src/domain/traceView.test.ts src/domain/traceView.timeline.test.ts src/domain/pluginGraph.test.ts src/services/trace src/app/plugins` | 16 文件 / 170 passed | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 | 0 |

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| FE-24-A 乱序/重复/取消/缺 turn_end/负时钟差不显示虚假耗时 | `乱序输入被排序修复；负时钟差的间隔为 null`；`重复事件只计一次`；`缺 turn_end：running 且 totalMs=null，不从相邻差补算`；取消轮 status=cancelled 如实 | PASS | production+fixture |
| FE-24-B 缺 usage/TTFT 显示未知；首可见正文与首字节分别命名 | timeline 模型 firstTokenMs/replyIntervalMs/usage 分列且 null=未知（`取消轮…usage 缺失显示 null`）；UI 渲染 null →「未知」 | PASS | production+fixture |
| FE-24-C 详情与脱敏事件一致；导出注明覆盖范围 | 详情面板渲染的就是快照投影事件（同一对象序列化）；coverageNote 含轮数/条数与「不代表完整 Session」；截断（淘汰）时说明更严格 | PASS | production+fixture |
| FE-24-D 导出与页面 JSONL 逐字节一致；不夹带密钥/未授权正文 | `导出与页面投影逐字节一致`（split("\n") 与页面行数组 toEqual，includeText 两种取值下都成立）；canary 在 includeText=false 时不出现在导出体 | PASS | production+fixture |

## 实现中做的判断

1. **总耗时只用 turn_end.durationMs**（采集端实测），绝不由相邻差补算；缺 turn_end 显示 running。
2. **首 token = 采集测点**（provider_stream_meta.firstTokenMs），明确不冒充平台 TTFB；「首可见正文」是 reply 事件相对 turn_start 的间隔，分开命名。
3. **导出即页面投影**：exportJsonl 与 getSnapshot 用同一 redactTraceEvent + 同一 store + 同一 toJsonl，天然逐字节一致；不需要「导出前重新脱敏」的特殊路径。
4. **覆盖范围说明放在导出结果的 coverageNote**（UI 显示），JSONL 体保持纯净逐字节可比。

## 共享接口 / 消费者

- `domain/traceView` 新增纯函数与类型（追加式，既有消费者不受影响）；`InspectorPresenter` 新增四个方法（追加式）。
- FE-25（上下文视图）将复用 inspectorPresenter 的选中轮与投影。

## 未测/人工项

- 浮层时间线视觉/交互（拖拽、详情面板滚动）：浏览器目视（人工）。
- 真实 SQLite 大历史下的 tail 覆盖范围：INT-01。
