# runtime SPEC 索引

需求：[模块PRD](PRD.md)。执行状态见报告与[执行计划](../GOAL_EXECUTION_PLAN.md)，READY不表示实现。

| SPEC | 交付 | 前置 | 状态 |
| --- | --- | --- | --- |
| [RT-01](specs/RT-01.md) | v0.5 契约与单 Runtime 宿主边界 | CORE-01～09 自动审查；INT-01 可自动部分 | READY（本地实现） |
| [RT-02](specs/RT-02.md) | 身份绑定与会话隔离 | RT-01 | READY（本地实现） |
| [RT-03](specs/RT-03.md) | Permission Runtime 与审批状态机 | RT-02 | READY（本地实现） |
| [RT-04](specs/RT-04.md) | 来源与记忆写回信任边界 | RT-02、RT-03、LLM-04 | READY（本地实现） |
| [RT-05](specs/RT-05.md) | 持久 Scheduler | RT-03 | READY（本地实现） |
| [RT-06](specs/RT-06.md) | 跨渠道主动投递策略 | RT-05、GW-01、AGT-05 | READY（本地实现） |
