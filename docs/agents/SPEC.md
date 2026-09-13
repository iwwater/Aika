# agents SPEC 索引

需求：[模块PRD](PRD.md)。执行状态见报告与[执行计划](../GOAL_EXECUTION_PLAN.md)，READY不表示实现。

| SPEC | 交付 | 前置 | 状态 |
| --- | --- | --- | --- |
| [AGT-01](specs/AGT-01.md) | AgentSessionManager 生命周期 | RT-03 | AUTO_PASS（2026-09-13）：A~D 全过（Session/Run 分离、幂等、取消宽限、recover、脱敏日志；fake adapter 跑生产实现）；真实 ACP NOT RUN。见[验收报告](reports/AGT-01_ACCEPTANCE.md) |
| [AGT-02](specs/AGT-02.md) | ACP 客户端与受限进程宿主 | AGT-01、RT-03 | READY（本地实现） |
| [AGT-03](specs/AGT-03.md) | Codex ACP 适配 | AGT-02 | READY（本地实现） |
| [AGT-04](specs/AGT-04.md) | Claude ACP 适配 | AGT-02 | READY（本地实现） |
| [AGT-05](specs/AGT-05.md) | 远程审批、进度与结果投递 | AGT-03或AGT-04、GW-02或GW-04、RT-04 | READY（本地实现） |
