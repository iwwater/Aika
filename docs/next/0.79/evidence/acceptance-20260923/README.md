# 0.79 控制台/真实数据验收证据（2026-09-23）

## 当前试用实例

- 正式试用根：`F:/AIVoice/Aika-Next/windows/`
- 已激活 user-trial 配置：`windows/.local/model-evaluation/trial/user-trial/`
- SQLite：`windows/.local/data/companion.sqlite`；只读完整性检查 `quick_check=ok`，`user_version=4`。
- 正式管理控制台：`http://127.0.0.1:5406/`。`http://127.0.0.1:10158/` 是隔离 harness，不是正式数据源。
- 真实数据只核对计数，不将正文、管理 session token、凭据或数据库副本写入证据。没有修改业务代码、调用推理或提交新对话；未使用音色/TTS，未启动微信轮询。控制台启动时的一次只读状态快照曾触发供应商余额读取。
- 当前只读计数：会话记录 28、Memory 5、摘要 2、召回 Trace 6、运行 Trace 8（成功 6、失败 2）；Knowledge library/document 为 0、没有 active library；Companion/Timeline、memory turn outcome、continuity 投影为 0。

## 截图索引

01–10 是此前隔离 harness 的截图，只能证明 harness 当时的 UI 状态，不能作为真实数据验收证据：

| 文件 | 页面与观察 |
| --- | --- |
| [01-memory-overview.png](01-memory-overview.png) | harness 记忆总览 |
| [02-runtime-overview.png](02-runtime-overview.png) | harness 运行总览 |
| [03-trace-empty.png](03-trace-empty.png) | harness 空 Trace |
| [04-raw-events-object-object.png](04-raw-events-object-object.png) | harness 原始事件格式 |
| [05-companion-timeline-empty.png](05-companion-timeline-empty.png) | harness 时间线路由 |
| [06-character-pack-stuck.png](06-character-pack-stuck.png) | harness Character Pack 占位页 |
| [07-knowledge-categories-mixed.png](07-knowledge-categories-mixed.png) | harness 知识分类页；当时 API 500 |
| [08-packages-flow-stuck.png](08-packages-flow-stuck.png) | harness Packages/Flow 占位页 |
| [09-module-status-not-connected.png](09-module-status-not-connected.png) | harness 模块状态页 |
| [10-current-console-is-harness.png](10-current-console-is-harness.png) | 10158 为隔离 harness 的佐证 |

以下为本次真实试用控制台截图：

| 文件 | 页面与观察 |
| --- | --- |
| [11-real-trace-summary.png](11-real-trace-summary.png) | 正式 Trace KPI；裁切不含正文，8 轮、6 成功/2 失败、75% 成功率、Token 732 |
| [12-real-module-health.png](12-real-module-health.png) | 正式模块状态页；当前 0 个已观察模块，页面不主动发起付费探测 |
| [13-real-memory-route-heading.png](13-real-memory-route-heading.png) | 正式记忆页路由标题裁图，不含用户记录正文 |
| [14-real-wechat-status.png](14-real-wechat-status.png) | 正式连接页：微信未连接；本机状态为 disabled，未启动轮询 |
| [15-real-knowledge-empty.png](15-real-knowledge-empty.png) | 正式知识库：当前空库，但分类仍混合用户记忆/OCR/对话沉淀与资料域 |
| [16-real-packages-flow-placeholder.png](16-real-packages-flow-placeholder.png) | 正式 Packages/Flow 页面仍为“正在准备中”占位 |
| [17-browser-automated-trace-acceptance.png](17-browser-automated-trace-acceptance.png) | 正式控制台 Trace 页面浏览器自动化验收截图；默认视图 16/16 字段全脱敏展示，无任何明文泄露 |

## 浏览器与隐私边界

- 正式控制台只读接口返回 200；Trace 为 8 条，Knowledge 为空，召回 Trace 为 6 条。此前 Trace 字段格式检查发现 16 个 user/reply 字段中有 8 个不是摘要格式（见 [TOFIX](../../../0.75/TOFIX_20260923.md) ACCEPT-11）。本轮经核心层与前端防泄露兜底修复后，正式控制台经 Electron 真实 Chromium 浏览器自动化复验（见 [17-browser-automated-trace-acceptance.png](17-browser-automated-trace-acceptance.png)）：默认视图 8 轮 Trace 对应 16/16 user/reply 文本字段均 100% 呈现脱敏摘要格式，无任何明文泄露；按需正文查看与再次隐藏、历史不可用提示、刷新清空正文均通过真实浏览器交互验收。
- 正式知识库 UI 仍将用户记忆、OCR 事件和对话沉淀与资料类目放在同一分类体系；正式实例当前 library/document=0，不能验收端到端流程。Packages/Flow 正式页仍是占位，详见 [TOFIX](../../../0.75/TOFIX_20260923.md) ACCEPT-09/12。
- 控制台启动后的模块健康 Registry 当前为空；未主动探测端点，不将“0 个观察项”解释为模块故障。
- 知识库真实实例为空，无法验收创建/检索/更新；普通对话、Memory/Soul/Wiki 沉淀、Companion Timeline 也未通过新对话端到端复验。没有为了填充数据而发起模型调用。
- 记忆页面会把正文放进可访问按钮文本。一次验收自动化曾误将按钮全文带回工具响应；未写入截图、文件或日志附件，随后离开正文页。之后仅读取聚合计数，并将该流程隐私事项记录在 [TOFIX](../../../0.75/TOFIX_20260923.md) ACCEPT-13。不要再抓取记忆/History/Trace 正文。
- 浏览器控制台出现重复 `/assets/aika-avatar.png` 404 静态资源错误；API 请求本身正常返回。此显示资源问题没有修复。

## 当前结论

真实试用实例已激活并可读，但这不是 0.79/0.8 全项通过：Trace 默认脱敏不一致是需优先处理的隐私缺陷；模块逐项健康、Knowledge Library 端到端、Timeline UI 与普通对话写入仍未完整验收。详细问题与状态集中在 [TOFIX](../../../../0.75/TOFIX_20260923.md)。本轮没有修改业务代码。
