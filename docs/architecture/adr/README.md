# ADR 索引

ADR（Architecture Decision Record）只记录已经形成、需要长期保留的架构取舍。它回答“为什么这样设计”，不替代 RPD 的需求说明或 SPEC 的执行步骤。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [ADR-001](ADR-001-single-runtime.md) | 保持单一 Runtime/Pipeline 权威 | Accepted |
| [ADR-002](ADR-002-plugin-boundary.md) | 能力包与插件边界 | Accepted |
| [ADR-003](ADR-003-memory-authority.md) | History、Memory、Timeline、Wiki 的数据权威 | Accepted |
| [ADR-004](ADR-004-character-pack.md) | Character Pack 与 Continuity 分层 | Accepted |
| [ADR-005](ADR-005-console-boundary.md) | Console、Desktop Bridge 与表现层边界 | Accepted |
| [ADR-006](ADR-006-streaming-voice-pipeline.md) | STT/TTS 流式语音管线 | Proposed |

## 状态含义

- **Proposed**：已提出，后续实现前仍需冻结具体契约。
- **Accepted**：当前主线应遵守；若改变，新增替代 ADR 并注明迁移影响。
- **Superseded**：被新的 ADR 替代，保留用于解释历史。

新增 ADR 使用 [模板](../../templates/ADR.md)，编号只递增，不复用已经发布的编号。
