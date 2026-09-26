# Memory Contract

## 权威与职责

| 对象 | 职责 | 是否可替代 History |
| --- | --- | --- |
| History DB | 保存对话消息及稳定消息身份 | 否，作为基础记录 |
| Memory | 选择、维护、纠正和遗忘长期内容 | 否 |
| Companion Timeline | 当前用户与角色实际经历的投影 | 否 |
| User/Character Wiki | 保存有来源的长期知识 | 否 |

## 必须保持的语义

- 派生条目保留来源链、修订、截止点或等价元数据。
- 根事实遗忘、纠正、撤销后，派生闭包、Context lease、缓存和在途请求都不能继续暴露旧内容。
- 投影重放必须幂等，冲突不能覆盖新的事实。
- UI 通过管理 API 发起查看、编辑和遗忘；不能直接写第二条 Memory 生命周期。

当前 Companion Timeline 已有正式 `History → outbox → projection` 证据；User Wiki/Soul 候选沉淀仍见 [DEBT-001](../../backlog/DEBT.md)。
