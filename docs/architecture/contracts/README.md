# 公共契约索引

公共契约（CONTRACT）记录跨模块稳定的边界：输入输出、所有权、权限、生命周期、取消、错误和兼容策略。它不是某个版本的任务清单，也不是源码符号的自动目录。

## 契约文件

| 契约 | 主要内容 | 版本补充 |
| --- | --- | --- |
| [runtime](runtime.md) | Scope、Turn、取消、终态、Context 和 Pipeline | [0.65 CONTRACTS](../../next/0.65/CONTRACTS.md) |
| [memory](memory.md) | History、Memory、Continuity、投影和失效 | [0.79 N079-08](../../next/0.79/reports/N079-08.md) |
| [character](character.md) | Character Pack、Soul、Wiki、Timeline、Relationship | [0.7 RPD](../../next/0.7/RPD.md) |
| [provider](provider.md) | Capability、Adapter、Source、Profile、Binding | [0.65 PROVIDERS](../../next/0.65/PROVIDERS.md) |
| [voice](voice.md) | STT/TTS 能力、流式边界、播放回执和设备权威 | [ADR-006](../adr/ADR-006-streaming-voice-pipeline.md) |
| [knowledge](knowledge.md) | 知识库选择、来源、查看、删除和撤销 | [0.75 CONTRACTS](../../next/0.75/CONTRACTS.md) |
| [desktop-bridge](desktop-bridge.md) | Console、Electron preload、Bridge、renderer | [0.75 SOURCE_AUDIT](../../next/0.75/SOURCE_AUDIT.md) |
| [management-api](management-api.md) | 鉴权、配置、诊断、live runtime 投影和错误 | [0.79 SPEC](../../next/0.79/SPEC.md) |

## 使用规则

1. 新增公共字段先写契约和兼容策略，再改生产消费者；不能单边修改接口后把构建失败留给下一步。
2. 版本目录中的 `CONTRACTS.md`、`PROVIDERS.md` 是本版本新增/修改说明；长期语义回写本目录，避免多个文件逐渐分叉。
3. `IMPLEMENTED`、`EXPOSED` 或测试通过不自动等于所有消费者已接入；接线状态由对应 REPORT 和 STATUS 说明。
4. 契约中的“必须”是公共保障；可选能力缺失必须返回明确 unavailable，不能返回伪成功。
