# FE-25 验收报告 · 上下文布局、记忆清单与实时数据流

- 执行：goal worker（2026-09-13）。SPEC：[FE-25](../specs/FE-25.md)。基线 commit：`129c2c0`。
- 状态：**AUTO_PASS（待人工验收）**——A/B/C/D 可自动 AC 全过；浮层目视留人工。

## 改动文件

| 生产 | 测试 |
| --- | --- |
| `domain/contextLayout.ts` 新增：`buildContextLayout` —— 逻辑块按 ContextAssembler 装配顺序（必需块→history→summary→memory/knowledge/environment），kept/trimmed/notRetrieved 三态严格区分；content=null=正文未记录（不回查存储）；未知值=null 不推算为 0；缺快照=supported:false 不编造；截断 notes 明示非全量 | `contextLayout.test.ts` 6 例 |
| `components/LiveInspector.tsx`：事件流/上下文布局切换；上下文 pane 渲染块清单（状态/token/trimmed 原因/precision 标注/正文未记录提示） | — |

## 命令与退出码（2026-09-13 实跑，aika-crossplatform 下）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/domain/contextLayout.test.ts` | 6 passed | 0 |
| `npx vitest run src/domain src/presentation src/services/trace src/app/plugins` | 44 文件 / 577 passed | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 | 0 |

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| FE-25-A 布局与 fixture 快照逐字段匹配；kept/trimmed/未检索严格区分 | `kept/trimmed/notRetrieved 不混装`：kept 带 id/category/precision/token/正文；trimmed 带 reason；knowledge/environment 空段=notRetrieved 不伪造；`recentLimit 裁剪导致历史全被丢时，reason 说清楚是哪种裁剪`（recentLimit 裁 5 / 预算裁 0 分列） | PASS | production+fixture |
| FE-25-B content=null 显示正文未记录，不回查存储 | `正文开关关闭的快照：kept 片段 content=null` + notes「不回查存储绕过开关」 | PASS | production+fixture |
| FE-25-C 同事件序列与工作台 turnFlow 结论相同 | `turnFlow 标 done 的阶段 ⇔ 时间线有该阶段`（含 context_snapshot 新阶段，双向断言） | PASS | production+fixture |
| FE-25-D 超预算、空历史、旧协议缺字段与失败轮均可显示 | 缺快照 → supported=false + 引导（不编造）；截断 → notes 明示非全量；proxy 精度、诊断无 id 片段均有字段承载；失败轮与正常轮共用同一布局函数（状态来自 turn 事件而非快照） | PASS | production+fixture |

## 实现中做的判断

1. **显示的是装配逻辑块顺序**，不声称是最终 Provider 消息顺序；instructionsBlocks 字段协议里不存在（LLM-11 冻结字段无此项），因此不单列最终请求块——旧协议/缺失如实显示不支持。
2. **缺快照不从当前 Memory 库补历史**：buildContextLayout 只吃快照，无任何回查通道。
3. **notRetrieved 不进入 kept/trimmed 计数**：空 section 单独成块并说明「本轮没有检索到任何片段」。
4. **proxy 精度与无 id 片段**：precision 原样带出并在 UI 标注（非 confirmed 加后缀），snippetId=null 合法显示。

## 共享接口 / 消费者

- `domain/contextLayout` 为新增纯函数模块，无既有消费者受影响；LiveInspector 为唯一 UI 消费者；FE-26（成本页）不依赖本模块。

## 未测/人工项

- 上下文 pane 视觉与交互：浏览器目视（人工）。
- 真实 Tauri 下快照事件经 SQLite tail 的端到端表现：INT-01。
