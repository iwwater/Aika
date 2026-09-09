# S2 · Soul / Mode / Schema 拆分

> 历史阶段规格：已由 [模块 SPEC](../../modules/README.md) 和 [模块测试规则](../../modules/TESTING.md) 替代。下方旧串行顺序及全仓小阶段门禁不再执行；保留原要求与历史证据追溯。

> 2026-09-10：本阶段以 LLM 文本回复开发为主。真人麦克风、TTS、声学指标不作为准入或通过门槛；保留已有语音适配回归。文本对话质量由固定样本与审阅验证。

状态：待实现；前置 S1。目标：改变陪练策略不会把角色换成另一个人。

## 范围与契约

- `CharacterSoul`：版本、角色 ID、稳定人格、语言风格、背景、边界；不存用户事实和课程策略。
- `UserSoul`：稳定偏好/目标及来源引用，用户可编辑；近期状态交给事件记忆。
- `ModeConfig`：`companion` / `oral_practice` / `scenario_practice`、场景参数、练习语言、纠正偏好、回复长度；不覆写角色背景。陪练细则沿用 ORAL_PRACTICE_V1_PLAN 的非冲突部分。
- `RelationshipState`：复用现有关系计算，独立提供阶段与知识可见级别，不因切 Mode 重置；不引入关系衰减。
- `ReplyEnvelopeV1`：`schemaVersion`、`replyText`、`translation`、`mood`、`expression`、`motion`、`memoryCandidates`、`actions`、可选 `sticker`。附加字段可空，动作/工具必须校验白名单；文本非空才可朗读。
- 在适配层兼容现有 `japanese_text/chinese_translation/mood/sticker`；新旧协议统一到内部结构，流式解析须兼容转义、半截字段和 Unicode。
- 约束优先：产品边界与输出契约 → Character Soul → Mode 策略；用户当轮偏好可覆盖 Mode 默认，不改稳定人格。先结构化重组再接入 UI，不要求此阶段完成高级记忆或工具执行。

实现入口：`domain/character.ts`、`prompt.ts`、`companion.ts`、`streamingReply.ts`、设置持久化和会话 Hook。交付独立类型、组合规则、兼容适配器和最小模式选择入口。

## 验收条件

| ID | 方法 | 通过条件 |
| --- | --- | --- |
| S2-AC01 | 自动：三种 Mode 互切并重启 | 角色 ID/人格、既有记忆、关系保持；模式设置恢复，无混入另一 Mode 的纠正规则 |
| S2-AC02 | 自动：新旧回复和分片输入 | 原文/翻译保持一致；首句无需完整 JSON 即可进入队列；无重复字句 |
| S2-AC03 | 自动：无效枚举/未知动作/畸形 JSON | 未知表现回退中性，未知工具不执行；文本不可用时显式报错，不朗读 JSON |
| S2-AC04 | 固定样本审阅：三模式各 10 轮场景 | 身份和边界冲突 0 次；陪练中停止纠正/放慢/中文求助均生效；陪伴模式不自动变课堂 |
| S2-AC05 | 自动：旧配置与旧聊天库升级 | 原数据可读、迁移重复运行无副作用；无模式设置时保留原陪伴默认 |

高级课程、发音评分与人格滑块不在范围内。自然语言抽样记录输入输出和人工判定，不以单个 prompt 快照作为行为验收。

## PRD v0.4 增补（适用本阶段）

- 场景模式使用独立 scenarioId/设定/临时身份/结束条件；切回 companion 后清除临时身份，不改 CharacterSoul。目标语言由 Mode 配置，不把日语主线硬编码为所有模式默认。
- UserSoul 基础字段：stableFacts/preferences/dislikes/goals/habits/importantPeople/communicationPreferences，均预留来源；S2 不开启自动画像覆盖。
- mood 沿用受控标签，旧 emotion 只在适配层转换；PRD `reply_text/memory_candidates/action` 与旧 `japanese_text/chinese_translation/mood/sticker/toolCalls` 归一到本 SPEC 内部字段。空 actions 不执行，未知动作拒绝；本阶段不新增工具执行器。
- 关系升级后置；当前不重新计算既有用户阶段，S3/S5 不通过 assistant 生成回调额外增加互动计数。

| ID | 方法 | 通过条件 |
| --- | --- | --- |
| S2-AC06 | 自动+固定对话审阅：进入咖啡店/面试场景→退出→重启 | 场景参数恢复符合设置，退出后临时身份不残留；三种模式下角色 ID 与稳定人格一致 |
| S2-AC07 | 自动：PRD/旧协议转换 | 合法字段无损归一，mood 先于正文可消费；未知动作不执行，不重复渲染或等待全部 JSON |
