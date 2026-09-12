# Aika v0.5 · Personal Agent Runtime

日期：2026-09-13。状态：规划已拆分，尚未实现/验收；本文件是本次开发范围裁决，用户原文保存在 [原始更新计划](PRD_V0.5_INPUT.md)。

Aika 维持同一角色、Soul 与受权限保护的 Memory，通过既有 CompanionRuntime 接受桌面、远程终端及消息渠道输入，独立 AgentSessionManager 管理外部执行器。身份相同不代表会话历史与敏感记忆无条件共享。

## 范围与阶段裁决

| 层次 | 交付 | SPEC |
| --- | --- | --- |
| 旧版收口 | 自动审查、文本集成、后台维护/RAG | 既有 CORE/LLM/STT/TTS/FE；INT-01 |
| 可观测性增量 | 快照、实时浮层、时间线、上下文、成本 | LLM-11/12；FE-23～26 |
| Runtime 基础 | 契约、身份隔离、权限、来源 | RT-01～04 |
| 第一渠道 | Telegram 已绑定私聊，先文本后附件 | GW-01～03 |
| 远程设备 | 复用 AikaLink，配对与逐设备撤权 | FE-14～17；GW-04 |
| 外部执行 | ACP 宿主、Codex、Claude、远程审批 | AGT-01～05 |
| v0.5 核心里程碑 | 已授权远程修复临时项目并返回证据 | INT-04，发布仍须 INT-03 |
| 后续增量 | Feishu/QQ、Scheduler、主动投递 | GW-05/06；RT-05/06 |
| 保持后置 | 环境/桌宠真实采集、Live2D、语音人工 | FE-18～22；STT-03/TTS-03/INT-02 |
| 后续待立项 | Relay/云Runtime、原生Android扩展、移动Push、自动LAN发现、VLM等Stage3 | 仅backlog，不是本轮执行授权 |

原文 Phase 1 的多个渠道目标以分阶段表为准；首渠道先限制绑定私聊。先实现权限再开远程执行。Tauri 现有 HTTP 长轮询可继续使用，LAN WebSocket 是后续传输选择，不强制一次性迁移。手机浏览器先证明远程终端，不能宣称原生 Android 已交付。宿主退出后 Runtime 不在线，缓冲服务不能替代 Runtime；Always-on 需真实运行证据。

ACP 是协议而非权限隔离设施。适配器可能拥有自己的文件/终端工具；必须验证其权限模式，不能用 Aika 审批 UI 假装拦住未经控制的写入。worktree 仅隔离改动，不能充当安全沙箱。

## 模块需求入口

[Runtime](runtime/PRD.md) · [Gateway](gateway/PRD.md) · [Agents](agents/PRD.md) · [执行计划](GOAL_EXECUTION_PLAN.md) · [审阅结论](REVIEW_V0.5_AND_BACKLOG.md)

## 外部协议依据（2026-09-13 查阅）

ACP 标准使用 session/prompt、session/update、session/request_permission 和 session/cancel；spawn/approve 是 Aika 的内部 facade，需要适配映射，不能当作 ACP 同名方法。[ACP 官方协议](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx)

Codex ACP 旧仓库已提示迁移；实现前应核实新维护仓库、固定版本及平台能力，不能沿用未经核验的旧包名。[维护迁移说明](https://github.com/zed-industries/codex-acp)
