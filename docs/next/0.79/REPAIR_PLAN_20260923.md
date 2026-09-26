# 真实试用控制台修复与下一位 Worker 交接计划

日期：2026-09-23。依据：[现场 TOFIX](../0.75/TOFIX_20260923.md)、[真实实例证据索引](evidence/acceptance-20260923/README.md)、[0.79 SPEC](SPEC.md) 与 [N079-09 报告](reports/N079-09.md)。本文件是执行计划，不代表缺陷已修复或版本验收通过。

## 1. 先统一状态

- 正式试用实例是 `windows/`，管理端 `127.0.0.1:5406`；`127.0.0.1:10158` 是隔离 harness。截图 11–16 属于正式实例，01–10 只作 harness 历史记录。端口只是本次验收记录，Worker 开始时须重新核对进程、构建修订和数据源。
- 当前工作树的 N079-02～07 有不同程度的实现和自动 PASS；这不等于正在运行的正式实例已加载相同构建，也不等于人工验收通过。N079-08 仅 Companion Timeline 子链通过，User Wiki/Soul 候选自动沉淀未接。N079-09 仍为 IN_PROGRESS。
- 正式 Trace 有 8 轮，16 个 user/reply 栏位中 8 个非摘要格式；这是优先处理的隐私缺陷。正式知识库为空，模块健康为 0 个已观察项，微信未连接且 disabled；后两者不能推断模块或微信故障。
- 工作树已有大量未提交改动。先读 `AGENTS.md`、目标 SPEC/报告，并检查目标文件差异；保留现有改动，不 reset、不覆盖他人工作。默认一次 Worker 只负责一个明确模块及直接消费者。

## 2. 修复顺序与完成条件

| 顺序 | 范围与当前证据 | 主要定位 | 本次完成条件 |
| --- | --- | --- | --- |
| P0 | **Trace 默认脱敏不一致**：正式实例 8/16 个正文栏位不是 digest；N079-02 新写入和按需 History 正文自动测试已通过 | `core/trace-store.ts`、`core/dialogue-pipeline.ts`、`management/server.ts`、`management/ui/views.mjs`、真实运行 Trace 读取适配 | 先只读区分旧记录、当前写入、API 序列化和 UI 显示来源；列表/API 默认不返回可识别正文，历史记录也须安全展示；鉴权后按需从 History 查看，隐藏/刷新清除；遗忘后不可再读。用字段类别、计数和测试哨兵验证，不能输出用户正文。若库内已有明文，另列存量清理方案与恢复验证，不直接改正式库。 |
| P1 | **长期记忆详情缺遗忘入口**：正式截图仍无入口；N079-03 报告称另一条 `memory-dynamics-view` 正式忘记流程的 Electron E2E 通过 | `management/ui/views.mjs` 的 `recordEditor` 目前只显示保存；`management/ui/memory-dynamics-view.mjs` 已有遗忘操作；对应路由/构建资源及 `/api/memory/forget` | 在用户实际打开的“长期记忆详情”路径找到并完成可见的忘记入口，复用正式遗忘生命周期与冲突/确认语义，不做前端假删除或第二套 ID 逻辑；核对运行实例是否旧构建。成功后刷新列表，取消/冲突/断线有明确结果；用合成数据做 Electron/HTTP 验证，正式实例人工只核对控件，不点击真实记忆。 |
| P2 | **0.79 其余现场回归**：情绪 loading、Live2D 预览空白、TTS 长 URL、鼠标穿透下聊天控件、时间问候开启后即时可验 | `management/ui/emotion-view.mjs`、`presentation-view.mjs`、`management/ui/style.css`、`desktop/electron/main.mjs`、`desktop/main.mjs`、`desktop/local-greeting.ts` | 逐项先在当前正式构建复现，再做最小修复。FIX-03/04 的旧根因只是猜测，不据此删除校验或重接渲染器。N079-04～07 自动 PASS 只能作为基线；补实际页面/窗口行为、窄窗与缩放、穿透点击、问候开关即时预览及取消/冷却。 |
| P3 | **0.79 连续性与准入收口**：Companion Timeline 子链已自动 PASS；User Wiki/Soul 候选、实际 Flow、旧库恢复和长时场景未过 | `app/backend-session.ts`、`memory/continuity-*`、`management/ui/app.mjs` 的 timeline 路由、N079-08/09 SPEC | 完成候选事实的生产来源、审核/遗忘/恢复链；控制台时间线查询真实 Companion 事件，而非普通记忆列表；验证旧库迁移/恢复与实际对话所用 Host/Flow。未运行项标 NOT RUN，长期画像主动陪伴保持关闭。 |
| 后续 0.8 | **Knowledge/管理信息分域与占位页**：真实 Knowledge API 可读但空库，页面混合用户事实和外部资料；Packages/Flow 为占位。屏幕观察、主动邀请、Work/ACP/MCP 等仍属 0.8 规划 | `management/ui/modern-knowledge-view.mjs`、`management/ui/app.mjs`、`management/ui/next65-view.mjs`、[0.8 RPD](../0.8/RPD.md) | 先拆 0.8 SPEC 与真实数据契约，再分别实现 Knowledge Library、Memory/User Wiki/Soul、Timeline、包/Flow 页面。空库仅能验空态，不能宣布导入/检索/更新通过；不借 0.79 修复任务提前打开采集、轮询或付费能力。 |

附带观察：正式页面有 `/assets/aika-avatar.png` 404；Trace Token 总值 732 的来源/准确性未核实；模块健康 registry 当前无观测记录。这些单独复核和登记，不用一次修复任务顺带扩展范围，也不把“0 个观察项”当作模块故障。

## 3. 下一位 Worker 的首单任务：Trace 隐私

**目标**：先把正式 Trace 列表与其 API 的默认正文暴露风险关住，并解释 8/16 非 digest 的来源。只负责 Trace 写入、读取、显示及其直接消费者；不要顺带实现 0.8 页面。

1. 读取 `AGENTS.md`、`N079-02` SPEC/报告、`TOFIX` ACCEPT-11 与证据 README；核对当前文件 Git 差异、运行进程的构建修订、管理端实际连接的数据库。不要假设当前源码等于已启动实例。
2. 只用聚合 SQL 或类型判定确认非摘要字段的创建时间、写入路径和比例；禁止读取、打印、截图、复制或提交真实 user/reply、History/Memory 正文、session token、凭据及数据库副本。先用合成旧格式记录写失败测试。
3. 最小化修复默认列表/API 视图；保持 N079-02 的鉴权后 History 按需查看能力，并覆盖历史旧记录、已遗忘/清理、无稳定关联、隐藏/刷新、未授权及跨 Origin。检查 stage details、原始事件、导出等直接暴露面。
4. 若发现正式 SQLite 持久层存有明文，先交付幂等清理程序、合成库测试、只读影响计数与恢复方案；正式用户库的数据变更另列为待执行操作，不在诊断阶段直接运行。不能用遮住 UI 冒充存储风险已消除。
5. 定向测试通过后核对正式运行实例的构建/重启部署路径；先不触发推理或新对话。以无正文的 16/16 字段格式复验及鉴权/遗忘测试作为证据。报告按 `AGENTS.md` 写入 `reports/N079-02.md`，区分代码修复、实例加载和人工验收，随后更新 TOFIX 状态。

**执行边界**：本轮交接不授权模型推理、语音/TTS、微信轮询、主动探测付费端点、真实记忆遗忘、真实数据库迁移、导出私密正文或对外发送消息。正式实例的只读检查可以继续；如需真实数据变更，先把影响、备份与回滚步骤做成可审阅结果。用户记忆页的可访问文本曾在自动化工具响应中暴露一次，后续自动化只读标题、计数和控件存在性，不遍历按钮全文。

## 4. 状态更新规则

每完成一个范围，写明源码/产物修订、实际运行实例是否加载、修改路径、契约与直接消费者、测试命令/结果、真实服务与合成 fixture 的区别、未运行项。只把有证据的模块项标 PASS；N079-09 门槛与用户人工验收未过前，0.79/0.8 均不得标整体通过。
