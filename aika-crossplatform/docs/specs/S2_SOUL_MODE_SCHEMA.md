# S2 · Soul / Mode / Schema 拆分

> 2026-09-10：本阶段以 LLM 文本回复开发为主。真人麦克风、TTS、声学指标不作为准入或通过门槛；保留已有语音适配回归。文本对话质量由固定样本与审阅验证。

状态：待实现；前置 S1。目标：改变陪练策略不会把角色换成另一个人。

## 范围与契约

- `CharacterSoul`：版本、角色 ID、稳定人格、语言风格、背景、边界；不存用户事实和课程策略。
- `UserSoul`：稳定偏好/目标及来源引用，用户可编辑；近期状态交给事件记忆。
- `ModeConfig`：`companion` / `oral_practice`、练习语言、纠正偏好、回复长度；不覆写角色背景。陪练细则沿用 ORAL_PRACTICE_V1_PLAN 的非冲突部分。
- `RelationshipState`：复用现有关系计算，独立提供阶段与知识可见级别，不因切 Mode 重置；不引入关系衰减。
- `ReplyEnvelopeV1`：`schemaVersion`、`replyText`、`translation`、`emotion`、`expression`、`motion`、`memoryCandidates`、`toolCalls`。附加字段可空，动作/工具必须校验白名单；文本非空才可朗读。
- 在适配层兼容现有 `japanese_text/chinese_translation/mood/sticker`；新旧协议统一到内部结构，流式解析须兼容转义、半截字段和 Unicode。
- 约束优先：产品边界与输出契约 → Character Soul → Mode 策略；用户当轮偏好可覆盖 Mode 默认，不改稳定人格。先结构化重组再接入 UI，不要求此阶段完成高级记忆或工具执行。

实现入口：`domain/character.ts`、`prompt.ts`、`companion.ts`、`streamingReply.ts`、设置持久化和会话 Hook。交付独立类型、组合规则、兼容适配器和最小模式选择入口。

## 验收条件

| ID | 方法 | 通过条件 |
| --- | --- | --- |
| S2-AC01 | 自动：两种 Mode 互切并重启 | 角色 ID/人格、既有记忆、关系保持；模式设置恢复，无混入另一 Mode 的纠正规则 |
| S2-AC02 | 自动：新旧回复和分片输入 | 原文/翻译保持一致；首句无需完整 JSON 即可进入队列；无重复字句 |
| S2-AC03 | 自动：无效枚举/未知动作/畸形 JSON | 未知表现回退中性，未知工具不执行；文本不可用时显式报错，不朗读 JSON |
| S2-AC04 | 人工：两模式各 10 轮固定场景 | 身份和边界冲突 0 次；陪练中停止纠正/放慢/中文求助均生效；陪伴模式不自动变课堂 |
| S2-AC05 | 自动：旧配置与旧聊天库升级 | 原数据可读、迁移重复运行无副作用；无模式设置时保留原陪伴默认 |

高级课程、发音评分与人格滑块不在范围内。自然语言抽样记录输入输出和人工判定，不以单个 prompt 快照作为行为验收。
