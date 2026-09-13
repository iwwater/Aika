# runtime SPEC 索引

需求：[模块PRD](PRD.md)。执行状态见报告与[执行计划](../GOAL_EXECUTION_PLAN.md)，READY不表示实现。

| SPEC | 交付 | 前置 | 状态 |
| --- | --- | --- | --- |
| [RT-01](specs/RT-01.md) | v0.5 契约与单 Runtime 宿主边界 | CORE-01～09 自动审查；INT-01 可自动部分 | AUTO_PASS（2026-09-13）：A~D 自动 AC 全过（信封/身份六类型冻结、桌面兼容映射、HostLifecycle 三态、facade 门禁）；真实宿主回归 NOT RUN。见[验收报告](reports/RT-01_ACCEPTANCE.md) |
| [RT-02](specs/RT-02.md) | 身份绑定与会话隔离 | RT-01 | AUTO_PASS（2026-09-13）：A~E 全过（真实生产 Runtime+SQLite 双主体 0 串线、绑定 fail-closed、有界队列、cancel 归属）；真实 Tauri 迁移 NOT RUN。见[验收报告](reports/RT-02_ACCEPTANCE.md) |
| [RT-03](specs/RT-03.md) | Permission Runtime 与审批状态机 | RT-02 | AUTO_PASS（2026-09-13）：A~D 全过（重放/跨用户/跨会话/过期/参数变化拒、原子认领、重启不自动批准、fail-closed、Windows 路径边界）；真实执行入口 NOT RUN。见[验收报告](reports/RT-03_ACCEPTANCE.md) |
| [RT-04](specs/RT-04.md) | 来源与记忆写回信任边界 | RT-02、RT-03、LLM-04 | AUTO_PASS（2026-09-13）：A~D 全过（信任分级/模型不自行提升/画像归属门/writeback 提交前重查/旧记录兼容）；真实渠道写回 NOT RUN。见[验收报告](reports/RT-04_ACCEPTANCE.md) |
| [RT-05](specs/RT-05.md) | 持久 Scheduler | RT-03 | AUTO_PASS（2026-09-13）：A~D 全过（三触发建模/misfire skip/幂等键/权限重查/unknown 不重放/重试上限/坏时区 unsupported）；真实宿主长跑 NOT RUN。见[验收报告](reports/RT-05_ACCEPTANCE.md) |
| [RT-06](specs/RT-06.md) | 跨渠道主动投递策略 | RT-05、GW-01、AGT-05 | READY（本地实现） |
