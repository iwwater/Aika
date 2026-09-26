# Aika Next 0.8 后代码审查与修复计划

日期：2026-09-24。审查基线：`8ec5311` 加当前工作树证据，范围为 Windows 正式入口 `windows/code/desktop-pet/` 的 0.8 生产改动及 Timeline 页面。本文件记录审查结论、修复状态与未完成门槛。保留既有未提交改动；没有读写用户业务数据库或用户录音。

## 审查结论

最近报告记录 N079-08 的普通对话候选写入、来源、幂等、重启和遗忘自动回归通过；候选保持待审核，不会晋升事实。N079-09 的 Host/Flow 两进程 100 轮回放也已通过。0.79 只剩旧库迁移恢复、可启动 Electron 的六个 UI 场景及跨日/长时证据，均为发布准入项，不是 08-01 的功能开发前置，也不据此放行版本。0.8 模块测试通过仍不等于正式生产链通过。

| 优先级 | 发现与定位 | 影响及证据 | 修复目标 |
| --- | --- | --- | --- |
| P0（08-01 自动验收完成） | **Unified Timeline 此前未进入正式运行链。** 现已在 `trial-backend.ts` 注册 `CompanionEventHub` / `UnifiedTimelineService` 与鉴权 `/api/unified-timeline`；正式进程验证活动 Canon 包、真实 `submit_text`/History outbox、持久化 Work 回执三域来源。 | 三域查询、Companion outbox 恢复、Work 回执重放幂等、完整重启与遗忘传播由正式进程自动化验证；见 `reports/N08-01.md`。Work fixture 只证明既有回执被投影，不宣称真实 Harness 执行。 | 08-01 自动化阶段标记 DONE；不放行 0.8。不得增加第二份对话正文存储。 |
| P1（已修） | **Unified Timeline 的 History 来源检查曾截断来源 ID。** `memory/unified-timeline.ts` 原先把 `history:<turnId>:user` 截断为 `history`，无法检查对应 History 记录。 | 现在保留完整 `history:` sourceRef 并通过正式进程测试验证实际对话撤销过滤与重启后不复活。 | 已传递完整来源 ID；将该服务级过滤保留为 08-01 回归门槛。 |
| P1（已修） | **邀请接受事件曾被误投影为对话正文。** Companion Timeline 旧投影器把所有 Companion 域事件都解释为 user/assistant 文本。 | 正式 `click_invitation` 接线会产生 `companion.invitation.accepted`；若沿旧路径投影，它的审计 summary 会伪装成一条会话。 | 仅真实 `companion.turn.saved` 进入对话表；接受事件存为字段受限的 Companion 活动，并按来源版本过滤。模块与正式进程均覆盖重复投影和来源遗忘。 |
| P0（状态修订） | **08-06 报告与 0.79 状态存在过时描述。** `reports/N08-06.md` 把 N079-08/09 描述为未完成；当前 `docs/next/0.79/SPEC.md` 与对应报告已经记录候选写入及 Host/Flow 跨进程回放通过。 | 过时前置可能导致重复实现，也会误导 08-01 排期。 | 本任务仅校正 0.8 修复计划与受影响的 08-01 状态/报告；0.79 的剩余准入门槛维持 BLOCKED/NOT RUN。 |
| P1（已修） | **目的地升格曾自动签发云端 Grant。** 旧 `verifyOrReissue()` 在 `local -> cloud` 或目标变化时会撤销旧 Grant 后直接签发 active 新 Grant。 | 旧实现违反显式授权。现由 `reauthorizeGrant(..., userConfirmed)` 将重新确认作为签发新 revision 的必要条件，目的地/目标变化仅使旧 Grant 失效；生产授权 UI 与捕获链仍未接线。 | 模块安全边界和拒绝/确认回归已修；正式 UI 与设备验收仍列为 08-03 停止项。 |
| P1（模块边界已修） | **Work 取消回执曾可能被在途成功覆盖。** 旧 dispatch/cancel 竞态可以让调用者收到取消、持久结果却为成功。 | 模块实现现在传播 AbortSignal、等待执行终态；取消未确认及取消后非 Abort 错误都归为 `uncertain`，迟到成功不能覆盖已结算状态。真实远端取消语义仍需协议接通后验证。 | 保留并发回归；生产 ACP/MCP 的远端任务取消仍须服务级验收。 |
| P1（已修） | **感知文本缓存曾跨 Grant 存活。** 旧 `frameCache` 无 TTL、容量上限和撤销清理。 | 当前缓存按 Grant/会话/角色/目标隔离并设置 TTL/容量；Grant 撤销、会话结束会清理缓存和 Observation 正文。真实屏幕来源尚未接线，需在正式捕获链复验。 | 模块生命周期问题已修；设备端撤销传播仍列为 08-03 验收。 |
| P1（正式 fixture 链已接；真实服务待验） | **ACP/MCP 曾是假成功替身。** 旧代码缺少 executor 时返回成功，MCP handler 缺失时回显参数。 | 假成功现已失败关闭；ACP v1 与 MCP `2026-07-28`/旧版 `2025-11-25` stdio adapters 已接认证管理 API、工作卡、private journal、Timeline 和 trial-backend 关闭生命周期。本地 wire fixture + trial-backend 两协议进程 fixture 覆盖确认、权限、重启、幂等及遗忘；没有真实兼容服务证据。 | 08-05 正式自动化接线已通过；真实 ACP/MCP 服务缺席时仍为 BLOCKED，不能把 fixture 记作外部协议实测。 |
| P2（已修；视觉仍未验） | **控制台 Timeline 页面此前未消费 0.8 `UnifiedTimelineService`。** 页面旧视图只读 records/Trace。 | 现已增加统一活动页并请求受鉴权的 `/api/unified-timeline`，覆盖 Canon/Companion/Work 领域筛选、来源、游标分页与错误态；正式管理进程接口测试和模拟 DOM 组件测试分别通过。Electron/browser 视觉验收仍未运行。 | 自动数据链已接通；保留可启动 Electron 后的视觉/联机验收门槛。 |

## 0.8 后修复顺序

1. **先校准事实与阶段状态**：按最新 N079-08/09 报告更新本计划，保留 0.79 剩余准入为 `BLOCKED/NOT RUN`；将 08-01 目标限定为正式时间线服务、事件总线、查询 API 与真实入口自动验收。N079 的候选写入和 Host/Flow 回放不重复实现。
2. **授权与副作用安全**：修复 Grant 升格、感知缓存生命周期和 Work 取消竞态；先加入可失败的隔离回归，再改生产实现。验收包含拒绝授权后零新采集、撤销后无旧文本缓存、取消后无假成功/假取消。
3. **完成正式接线**：08-01 Canon/Companion/Work 三域来源已从正式 `trial-backend` 子进程验证查询；08-05 认证管理 API、Work 确认页、private profile/journal、ACP+MCP dispatch、Timeline、重启、重复确认不重跑和遗忘传播也在同一隔离 `trial-backend` 子进程覆盖。08-04 已进一步接入对话 candidate → 显式晋升 Continuity fact → 持久策略/首次忙闲与 DND 仲裁 → 普通 text TurnScope 和 Timeline/遗忘路径，并覆盖 8 秒展示后淡出及取消。剩余为 08-03 设备授权感知、Observation/Schedule 来源、真实 Electron UX 和外部真实 ACP/MCP 服务；fixture 不冒充真实设备或外部服务。
4. **真实服务与 UI 收口**：等可用的 Windows Electron 宿主/真实 OCR-VLM 和实际 ACP/MCP 服务可用后，再验证授权观察、候选展示和真实协议动作。当前 `npm run test:windows:ui` 重跑仍在 GPU process `-1073741515`、renderer `ERR_FAILED (-2)` 停止；外部协议服务尚未配置。没有这些资源时将相应项保持 `BLOCKED / NOT RUN`，整体不放行。

## 验收门槛与边界

- 自动：首次审查基线为 32/32；收口后 `npm run test:next08` **76/76**，正式管理/Timeline/主动邀请/ACP/MCP 进程集成 **2/2（约 319 秒）**；`npm run check`、`npm run build` 与 `npm run build:desktop` 通过。本地 fixture 仍不能替代真实设备/外部服务证据。
- 真实：至少一条用户对话写入并可从统一时间线与 Trace 双向追溯；一条 Windows 授权观察及撤销；ACP 和 MCP 各一条真实兼容服务调用。缺资源时单列 `BLOCKED`，不得写 PASS。
- 人工：逐项核对气泡、展开聊天、控制台 Timeline、授权预览/停止、主动邀请和 Work 确认。未获用户确认不代签。
- 范围：本计划是 0.8 后修复，不改旧 Aika、macOS 副本或正式用户库；当前未提交页面改动由其原任务保留，修复时在现有文件上最小增量处理。

## 执行状态（截至 2026-09-25）

| 项目 | 状态 | 已完成内容 / 剩余门槛 |
| --- | --- | --- |
| Timeline 会话页假数据与假撤销（P0） | **已修** | 会话页只读真实 records/Trace；失效正文隐藏；刷新与 Trace 按钮事件测试通过。此页不再展示撤销/工作状态假动作。 |
| Grant 目标/目的地变化（P1） | **已修** | 变化时撤销旧 Grant 并返回 `reauthorization_required`；仅显式确认入口能生成下一 revision。 |
| 感知缓存与正文生命周期（P1） | **已修** | 缓存按 Grant/会话/角色/目标隔离，有 TTL 与容量上限；撤销/会话结束立即清缓存和正文；云端/本地处理通道分开，未配置处理器失败关闭。 |
| Work 取消竞态（P1） | **模块边界已修** | 取消传播 AbortSignal、等待终态；未确认取消、取消后的非 Abort 错误均返回 `uncertain`，重复取消和迟到成功沿用已结算回执。真实远端取消语义仍需协议接通后验证。 |
| 单次 Grant 消费记录保留（补充） | **已修** | 用有过期时间且最多 512 项的 Map 记录单次 Observation 的当前轮次可读资格，避免无界 Set 增长；Observation 与缓存仍受各自 TTL/容量控制。 |
| ACP/MCP/内部任务假成功（P1） | **正式 fixture 链自动验收通过；真实服务 BLOCKED** | trial-backend 认证 API/Work 卡/persistent journal/Timeline 已装配；ACP 与 MCP fixture 覆盖 discovery、explicit confirm、权限策略、结果、重启、幂等和忘记。没有外部兼容服务证据。 |
| N079-08 / N079-09 交付边界 | **自动回归已通过；仅发布准入未完成** | N079-08：普通对话有来源候选写入，幂等/重启/遗忘自动通过，候选不自动晋升。N079-09：Host/Flow 100 轮两进程回放通过。旧库演练副本、可启动 Electron 的 6 个 UI 场景、跨日/长时运行仍为 `BLOCKED/NOT RUN`；0.79 不放行。本轮不为这些门槛加功能修补。 |
| 08-01 三域正式 Timeline 来源 | **自动验收 DONE** | 正式子进程查询活动 Canon 包、真实 `submit_text` 的 History/outbox 投影、持久化 Work 回执；鉴权、启动 drain、重启、来源撤销与不复活通过（进程测试 1/1）。Work 只验证回执投影。 |
| 08-06 管理端统一时间线数据视图 | **数据/API 自动链已接；视觉 BLOCKED** | 管理端会话页新增统一活动标签，调用正式 `/api/unified-timeline`，支持三域筛选、游标追加与错误恢复；模拟 DOM 5/5，正式管理 API/进程集成 2/2。Electron renderer 未能启动，视觉及同浏览器联机验收 NOT RUN。 |
| 08-03 授权感知正式运行时 | **BLOCKED / NOT RUN** | 生产 `trial-backend` 尚无 CaptureGrant/Observation API，Electron 入口尚无屏幕选择/采集实现；需要可启动 Electron/Windows 环境验证权限、范围、预览与停止，并接入真实 OCR/VLM。 |
| 08-04 主动陪伴正式运行时 | **Continuity text 链自动化通过；独立持续授权与 Schedule 契约已固化；整体 IN_PROGRESS** | 真实保存文本经 N079 writer 形成不可自动晋升的 candidate；显式晋升后的有效 fact/milestone 经 30 秒延迟、忙闲/DND 与共享配额仲裁成为通用 text invitation；点击进入正常文本 TurnScope，不启麦；策略跨进程恢复、source version/TTL、Timeline 和遗忘覆盖。renderer 8 秒展示后淡出由假时钟单测覆盖。Observation 严禁借用单轮授权，已补充独立持续授权规范；Schedule 已定义接口与 fail-closed 实现。Electron 实际气泡窗口交互待人工验收。 |
| 08-05 ACP/MCP | **正式 fixture 接线自动化通过；真实服务 BLOCKED / NOT RUN** | 认证 API、Work 卡、private profile/journal、Timeline、重启幂等和遗忘传播已由 trial-backend ACP+MCP fixture 验证；无已选定并可访问的外部兼容服务，fixture 不记为真实协议验收。 |
| 主动陪伴运行诊断 | **已校正** | 管理端已显示持久策略状态；正式来源链是“对话 candidate → 显式晋升 → 有效事实邀请”，由正式集成覆盖首次忙闲/DND 仲裁与文本响应。独立持续感知授权与 Schedule 契约已明确，无配置时失败关闭。 |
| 自动化 | **模块链、正式进程集成与 Electron 冒烟全绿；真实外部服务与视觉待验** | `npm run check`、`npm run build`、`npm run test:next08` **77/77 PASS**、正式管理集成 **2/2**、`npm run build:desktop` 通过。Electron 冒烟阻塞经排查为 timer 闭包丢失 globalThis 导致的 Illegal invocation，修复后 `test:windows:ui` 输出 `WINDOWS_SMOKE_OK` 且退出码 0，Electron 宿主完全正常。真实云端 VLM、本地 OCR 及真实外部 ACP/MCP 服务缺少凭证/服务环境，保持 BLOCKED / NOT RUN。 |

08-01 自动化生产入口、08-04 Continuity fact 主动邀请 text 子链、08-05 Work 管理/ACP/MCP fixture 链均有隔离自动化进程证据；08-02/08-06 桌面视觉、08-03 感知生产、08-04 Observation/Schedule 来源与 Electron 实际 8 秒气泡行为、外部真实 ACP/MCP 服务仍未完成。0.8 整体不得标记版本 DONE/PASS。
