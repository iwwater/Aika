# 0.8 后代码审查修复执行报告

- 日期：2026-09-25
- 分支：`aika-next`
- 源码根：`windows/code/desktop-pet/`
- 计划与审查发现：[后 0.8 代码审查修复计划](../POST_08_CODE_REVIEW_FIX_PLAN_20260924.md)
- 联合验收状态：[08-06 复核报告](N08-06.md)

## 已完成

- Grant 的目标或 local/cloud 目的地变化会撤销原授权并要求重新授权；新 revision 必须由显式确认生成。
- 感知处理按授权目的地选择处理器；缓存绑定 Grant/角色等作用域，设置 TTL 和容量上限，撤销或会话结束时清除正文和缓存。单次 Grant 的“当前轮次可读”标记现在也有 TTL 和硬容量上限；会话结束会清理已消费单次授权遗留的 Observation。
- Work 无真实 executor/handler 时失败关闭。取消通过 AbortSignal 传入执行器，取消未确认、取消后普通执行错误、取消超时均不能声称成功或确定已取消；`uncertain` 回执不能被迟到结果或重复取消覆盖。
- 统一时间线拒绝缺少明确执行器或合法 Work 状态的回执，避免合成成功事件。
- 正式 `trial-backend` 接入 Canon 活动包查询、真实对话 History/outbox 投影与持久化 Work 回执投影；进程自动化覆盖三域鉴权查询、重启恢复和对话遗忘。Work 测试仅证明已确认回执接线，不代表真实 Harness/ACP/MCP 执行。
- 正式主动陪伴还覆盖连续性来源链：真实已保存用户文本 → N079 writer 候选（不会自动晋升）→ 管理端显式晋升 → evidence-eligible 事实候选 → 策略/DND/忙闲/共享配额仲裁 → 通用文本邀请 → 不启用麦克风的普通 text TurnScope → Timeline 来源/遗忘。进程集成还覆盖重启、幂等、拒绝未支持来源与策略持久化。此证据仅涵盖连续性文本来源，不包括 Observation/Schedule 或 Electron 视觉验收。
- 08-04 仲裁模块拒绝缺少来源或无效时间窗的候选；正式 Continuity runtime 默认关闭，接受事实只来自显式晋升且 evidence-eligible 的 active 条目，采用 30 秒延迟/15 分钟 TTL，并在展示、接受和忽略时复验 source ID/version；过期、终态与重复命令失败关闭。管理端策略跨进程保存；文本接受走普通 TurnScope、无麦克风；renderer 8 秒展示后淡出由假计时器测试。Observation/Schedule 与真实 Electron UX 仍阻塞。
- ACP v1 与 MCP `2026-07-28`/兼容 `2025-11-25` 的 stdio JSON-RPC adapter 已接认证管理 API、Work 卡和正式 `trial-backend` composition root；本地子进程 fixture 覆盖协议帧及正式进程链。真实兼容服务仍未运行。
- Work 协议层 SQLite journal 位于产品数据目录并与 Timeline source revocation 同步遗忘；派发前原子保存请求与 pairing，重启时将已尝试但缺终态的任务固定为 `uncertain`，禁止重发；回执先持久化，Timeline listener 失败时保持 outbox 未确认，并以稳定 `eventId` 重放。自动化另覆盖 journal 遗忘与 Timeline source 撤销之间的 crash window。
- 控制台会话历史通过 records/Trace API 读取数据，隐藏失效正文并提供错误态；修复刷新和 Trace 按钮事件回调接线。为防止误导，08-06 测试名称和验收报告明确标注 in-process fixture 的范围。
- 控制台新增“统一时间线”标签，消费正式 `/api/unified-timeline`，展示 Canon/Companion/Work 事件、来源明细和 Work 状态，支持组合领域筛选、游标加载、显式重试与错误态。mock-DOM 覆盖请求、内容、过滤、分页和失败恢复；正式 API/进程由管理集成回归覆盖，Electron/browser 视觉验收仍未运行。
- SPEC、N08-05、N08-06 与 STATUS 按正式接线和真实服务证据校正；旧 08-06 “ALL_PASS”结论已撤回。

## 自动验证

在 `windows/code/desktop-pet/` 执行：

| 命令 | 结果 |
| --- | --- |
| `npm run test:next08` | 76 项通过，0 失败；命令包含 TypeScript 与 WeChat 构建 |
| `node --test dist/tests/management/integration.test.js` | 2 项通过，0 失败，约 319 秒；包含正式 `trial-backend` 进程级 Timeline/主动邀请，以及 ACP/MCP Work 卡配置、确认、回执、重启、重复确认、遗忘传播 |
| `node --test tests/management/routes.test.mjs tests/management/modern-timeline-view.test.mjs` | 9 项通过，0 失败；含 5 项时间线页面测试 |
| `node --test dist/tests/management/server.test.js` | 2 项通过，0 失败；验证真实 HTTP 管理 server 的鉴权、来源隔离和路由行为 |
| `npm run check` | 通过 |
| `npm run build` | 通过 |
| `npm run build:desktop` | 通过 |
| `node --check desktop/main.mjs`、`desktop/invitation-auto-dismiss.mjs`、`management/ui/proactive-view.mjs` | 通过 |
| `git diff --check` | 通过 |

## 尚未完成的验收

本轮及后续 08-01 回归已启动正式 `trial-backend` 隔离子进程，证明 Timeline 三域查询、真实对话投影、Work 回执重放与遗忘/重启。模块套件与模拟 DOM 仍不代替 Electron、真实设备或外部协议验收。

- 08-01 正式 Timeline 三域查询与进程自动化：**DONE**；不代表 0.8 发布通过。
- 08-06 Unified Timeline 管理视图：**数据/API 自动接线通过**；Electron 视觉、浏览器联机体验与整体联合验收仍 **BLOCKED / NOT RUN**。
- 0.79 N079-08 候选写入和 N079-09 Host/Flow 跨进程回放自动化已通过。旧库升级恢复、可启动 Electron 的六个 UI 场景、跨日/长时运行仍是发布准入项：**BLOCKED / NOT RUN**。
- Windows 实际授权、屏幕采集、OCR/VLM、锁屏/目标丢失和撤销：**BLOCKED / NOT RUN**；正式入口无 CaptureGrant/Observation 装配，Electron 环境有 GPU 子进程启动问题。
- 08-04 Continuity text 子链：**自动进程验收通过**；覆盖保存对话到待审候选、显式晋升、首次展示配额/DND/忙闲仲裁、普通 text turn、审计来源、策略重启和遗忘。Observation/Schedule、clarify/voice 对应真实设备动作及 Electron 窗口体验：**BLOCKED / NOT RUN**。
- 08-04 状态管理：**自动回归通过**；覆盖来源版本、15 分钟过期和失效擦除、终态幂等、共享配额/冷却及假计时 8 秒展示后淡出。Electron 计时器集成于模块单测，不代表实际 renderer 窗口体验通过。
- ACP/MCP 本地协议 wire fixture：**3/3 PASS**；Work journal 恢复/outbox、遗忘 tombstone 与生产工作卡/组合根自动进程链：**PASS**；真实兼容服务握手、真实外部副作用、取消和断连：**BLOCKED / NOT RUN**。
- 干净安装包组合与逐页人工体验：**NOT RUN**。此前一次 `npm run test:windows:ui` 在本机 GPU 子进程退出码 `-1073741515` 后以 `ERR_FAILED (-2)` 结束，renderer 未加载；视觉验收 **BLOCKED**。本轮未重复启动 Electron。

因此 08-01 自动化生产入口证据已通过，08-04 的 Continuity text invitation 子链和 08-05 正式 Work 管理/ACP/MCP fixture 链有自动进程验收；08-02/08-06 桌面视觉、08-03 感知生产、08-04 Observation/Schedule 来源和 Electron 实际气泡行为、外部真实 ACP/MCP 服务仍未完成。不得据此将 0.8 标为 `DONE` 或 `ACCEPTED`。
