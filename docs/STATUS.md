# Aika Next 当前状态

更新日期：2026-09-24。

本页是导航性 STATUS，不替代版本 SPEC 或执行报告。状态只能由实际证据更新；不能因为规划文件、源码文件或测试数量存在就宣布版本完成。

## 版本总览

| 版本 | 当前状态 | 当前证据入口 | 主要未决门槛 |
| --- | --- | --- | --- |
| 0.6 | 基线已建立，历史验收资料保留 | [RPD](next/0.6/RPD.md)、[报告](next/0.6/reports/) | 以历史 SPEC/验收记录为准 |
| 0.61 | 修复轮已归档并作为后续基线 | [SPEC](next/0.61/SPEC.md)、[报告](next/0.61/reports/) | 人工后置项按既定计划处理 |
| 0.65 | 内核/包体改造有实现和报告，人工验收暂缓 | [SPEC](next/0.65/SPEC.md)、[报告](next/0.65/reports/) | 不能把暂缓写成 ACCEPTED |
| 0.7 | 受控模块已有实现，产品闭环待补齐 | [SPEC](next/0.7/SPEC.md)、[RPD](next/0.7/RPD.md) | 正式接线、管理和产品验收 |
| 0.75 | 前端计划/专项报告保留，后续现场问题由 0.79 承接 | [RPD](next/0.75/RPD.md)、[TOFIX](next/0.75/TOFIX_20260923.md) | 以当前版本安排和 TOFIX 状态为准 |
| **0.79** | **自动开发收口完成；版本准入未过** | [SPEC](next/0.79/SPEC.md)、[报告](next/0.79/reports/) | N079-08 候选写入与 N079-09 Host/Flow 回放自动通过；真实旧库恢复、可启动 Electron UI 环境和长期运行门槛仍为 BLOCKED/NOT RUN |
| 0.8 | **部分正式链自动验收通过；其余生产接线/真实服务/人工验收未完成，IN_PROGRESS/BLOCKED** | [SPEC](next/0.8/SPEC.md)、[修复计划](next/0.8/POST_08_CODE_REVIEW_FIX_PLAN_20260924.md)、[报告](next/0.8/reports/) | 08-01 Timeline 与 08-05 ACP/MCP fixture 组合根链通过；屏幕感知、主动候选生产、外部兼容服务及 Electron/人工矩阵未通过 |
| 0.85 | 规格已编写，尚未实施 | [RPD](next/0.85/RPD.md)、[SPEC](next/0.85/SPEC.md) | 等待 0.79/0.8 前置门槛；N085-00～06 均未开始 |
| 0.9 | 需求已细化，尚未拆执行 SPEC | [RPD](next/0.9/RPD.md) | 先固定高级语音和表现契约 |
| 1.0 | 需求已细化，尚未拆执行 SPEC | [RPD](next/1.0/RPD.md) | 先固定安装、迁移和恢复门槛 |

## 当前工作焦点

1. 0.79 自动开发收口已完成；旧库迁移恢复、可启动 Electron UI 和跨日/长时证据仍为发布准入项。0.8 自动回归绿灯不改变 0.79 的门槛。
2. Companion Timeline 与 User Wiki/Soul 候选均有正式保存、来源、恢复和遗忘自动证据；候选不会自动晋升。
3. 管理端保存/激活的 Flow 已通过真实 `BackendSession`/Host 100 轮跨进程对话回放。真实旧库升级/恢复未验证，旧库升级未放行；3 项 Electron UI 自动场景因当前 Windows 缺失 GPU 子进程 DLL 失败。
4. 现场记录、自动测试、真实 Electron/管理接线和人工体验必须分列；用户要求不做真人逐页审核，因此其状态记为未审核，不将其作为自动开发门槛或发布通过声明。
5. 公共架构决策和长期契约见 [architecture](architecture/README.md)；待办性质的条目见 [backlog](backlog/README.md)。

## 状态判定

- **PLANNED**：只有 RPD，尚未形成可执行 SPEC。
- **IN_PROGRESS**：至少有当前 SPEC，但仍有未完成门槛。
- **AUTO_PASS**：规定的自动门槛通过，仍可能需要人工/设备/真实服务验收。
- **READY_FOR_ACCEPTANCE**：开发门槛完成，等待用户真实验收。
- **ACCEPTED**：用户明确确认版本体验和必需门槛。
- **BLOCKED**：有明确外部依赖或安全前置未满足，并附复现和解阻条件。
