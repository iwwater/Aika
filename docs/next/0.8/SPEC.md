# Aika Next 0.8 执行 SPEC 索引

- **版本**：1.0.0
- **日期**：2026-09-25
- **状态**：08-01 三域正式查询链已有隔离 `trial-backend` 进程证据；08-04 已接入普通对话候选发现（仅候选）、显式晋升后事实来源邀请、持久策略、忙闲/DND/共享配额仲裁、文本接受/忽略及 Timeline 溯源，并有进程级自动化证据。08-04 的 Observation/Schedule 来源、Electron 中真实气泡显示/8 秒淡出仍未完成验收；08-05 正式管理 API、Work 确认页、private journal、Timeline、遗忘和 `trial-backend` ACP/MCP fixture 已自动验收，真实外部 ACP/MCP 服务及 Electron 视觉仍 BLOCKED / NOT RUN；08-06 管理端统一时间线数据视图已请求正式 API 并通过组件回归，Electron 视觉验收仍未运行；08-03 授权管理 API、Qwen 云 VLM 适配器、单帧 UI 和一次性对话注入已接线并通过自动化，但 Electron 来源选择、真实 OCR/VLM 与本地 OCR 仍 BLOCKED / NOT RUN。版本维持 **IN_PROGRESS / BLOCKED**，不据此放行。详见 [后 0.8 代码审查修复计划](POST_08_CODE_REVIEW_FIX_PLAN_20260924.md)、[08-03 验收报告](reports/N08-03.md)、[08-04 验收报告](reports/N08-04.md)、[08-05 复核报告](reports/N08-05.md) 与 [08-06 复核报告](reports/N08-06.md)。
- **关联文档**：[RPD](RPD.md) · [CONTRACTS](CONTRACTS.md) · [SOURCE_MAPPING](SOURCE_MAPPING.md) · [CODE_REVIEW_DEVELOPMENT_PLAN_20260923](CODE_REVIEW_DEVELOPMENT_PLAN_20260923.md)

---

## 一、 执行原则与门槛守则

1. **唯一轮次权威**：`DialoguePipeline` 与 `TurnPort` 是生产唯一的轮次权威。任何感知（Observation）、主动问候（Invitation）或任务确认（Work）必须经由该主链或其结构化投影，严禁建立第二套私有对话通道；
2. **安全隔离（Confinement）**：所有屏幕感知默认关闭并需显式授权；明确区分 `local` 与 `cloud` 目的地；短期观察默认在当前轮次后丢弃，不污染长期记忆库；
3. **逐步推进与证据闭环**：按依赖链逐步拆解实施，先实现生产契约与直接消费者，再运行定向自动化测试；
4. **前端改造规范**：前端视觉调整遵守“先明确需求 -> 索取参考图 -> 确认范围 -> 实施并请求逐项审核”的规范。

---

## 二、 阶段拆分与 SPEC 规划

| 阶段 / SPEC | 交付物与负责边界 | 核心依赖与验收标准 | 状态 |
| :--- | :--- | :--- | :--- |
| **[08-00 基线与契约冻结](specs/N08-00.md)** | 冻结 RPD、Windows 生产入口、Event/Observation/Grant/Invitation/Work schema；标明 Scope、来源修订、数据目的地、保留时间、撤销与迁移；锁定最小包组合与消费者清单。 | 27 项定向回归测试全绿；Chromium 测试环境缓存隔离验证通过；契约类型导出编译通过。 | **DONE** |
| **[08-01 事件与 Timeline](specs/N08-01.md)** | 在现有 `HostEventChannel` 上对接正式生产来源（Canon/Companion/Work 分域）；实现幂等投影、重启恢复与旧来源失效。 | 正式 `trial-backend` 进程验证：活动 Canon 角色包查询、真实 `submit_text`→History/outbox/Hub、持久化 Work 回执投影；鉴权查询、重启恢复和遗忘传播通过。Work 样例证明回执接线，不代表真实 Harness 执行。 | **DONE：三域来源与进程查询已自动验证；不代表 0.8 放行** |
| **[08-02 会话与桌宠核心交互](specs/N08-02.md)** | 气泡、展开聊天和控制台会话查看共享单一 `TurnScope` 权威；保留语音输入、Work 卡、取消与原话定位。 | 自动交互不变量通过；会话页接真实 records/Trace 并有组件测试；人工视觉与桌面体验未运行。 | **IN_PROGRESS：待人工/桌面验收** |
| **[08-03 授权感知](specs/N08-03.md)** | 窗口/区域选择、单次/会话级 `CaptureGrant`、预览与撤销；OCR/VLM 适配器；时效性 `Observation` 仅作为动态后缀注入 Context。 | 正式管理 API、云 VLM 适配器、浏览器来源选择 UI 与一次性对话注入已接线；自动化通过；Electron 冒烟启动阻断已解除（WINDOWS_SMOKE_OK）；真实 OCR/VLM 因缺外部凭证保持安全关闭。 | **IN_PROGRESS / BLOCKED：真实云端 VLM 和本地 OCR 待真实配置验证** |
| **[08-04 主动陪伴](specs/N08-04.md)** | 普通对话只生成待审候选；仅明确晋升且来源有效的连续性事实可以进入主动邀请；邀请与动作分离。 | 正式 `trial-backend` 链自动化通过；独立持续屏幕感知授权规范已固化（禁止单轮越权）；日程来源契约已明确（无配置时失败关闭）；Electron 8 秒气泡窗口体验待人工验收。 | **自动链全部通过；真实日程服务/桌面体验待验，整体 IN_PROGRESS** |
| **[08-05 Work/ACP/MCP](specs/N08-05.md)** | 保留现有 Work 确认与回执权威；ACP v1、MCP `2026-07-28`/兼容 `2025-11-25` stdio JSON-RPC 适配器。 | 模块与 3 个子进程 wire fixture 通过；正式 API/Work 卡/private journal 已由 `trial-backend` ACP fixture 覆盖配置、显式确认、Timeline、重启幂等和遗忘传播；未连接外部真实 ACP/MCP 服务。 | **自动化正式接线通过；真实协议服务及桌面验收 BLOCKED / NOT RUN** |
| **[08-06 控制台与联合收口](specs/N08-06.md)** | 授权、观察、时间线、策略、诊断和工作卡全景呈现；基础包及功能包组合、升级恢复、性能与人工体验验收。 | 统一时间线页面已调用正式 `/api/unified-timeline`，组件覆盖三域筛选/分页/错误态；Electron 视觉、授权感知、主动策略、Work 卡与清洁安装组合仍未验。 | **IN_PROGRESS / BLOCKED：自动数据视图已接，桌面/设备/真实服务证据仍缺** |

---

## 三、 执行顺序

```
08-00（基线与契约冻结）
  ↓
08-01（事件与 Timeline 投影）
  ↓
08-02（对话与桌宠交互）  +  08-03（授权屏幕感知）
  ↓
08-04（主动陪伴与仲裁）
  ↓
08-05（Work / ACP / MCP 协议接入）
  ↓
08-06（控制台与联合收口）
```
