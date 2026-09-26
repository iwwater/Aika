# ADR-003：记忆、时间线与知识的数据权威

状态：Accepted  
日期：2026-09-23  
来源：[总路线图](../../next/RPD_ROADMAP.md)、[0.79 N079-08](../../next/0.79/reports/N079-08.md)

## Context

History、长期 Memory、Companion Timeline、Canon Timeline、User Wiki 和 Character Wiki 都可能保存与对话有关的信息。若它们互相直接写入或互相冒充权威，遗忘、纠正、撤销和重建就无法保持一致。

## Decision

- History DB 是对话消息的基础记录权威。
- Memory 负责从历史中选择、维护、纠正和遗忘长期内容。
- Companion Timeline 是当前用户与角色实际经历的投影，不是另一份对话事实源。
- Canon Timeline 表达作品/角色的原作事实；User Wiki 与 Character Wiki 表达有来源的长期知识。
- 派生数据必须保留来源标识、修订或截止点，并随根事实撤销而失效。

## Consequences

- UI 只能通过管理 API 读取或发起受控操作，不能直接写 SQLite 形成第二条生命周期。
- 目前 Companion Timeline 已有正式投影证据；User Wiki/Soul 候选沉淀仍以 [0.79 状态](../../STATUS.md) 标记为未接通。
- 不能把短期 Context 快照或实验性 direct SQL 写入当作正式记忆闭环。
