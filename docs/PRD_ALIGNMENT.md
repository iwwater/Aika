# PRD v0.4 落地对照

## 当前安排：按模块开发（2026-09-10）

唯一文档目录为仓库根 `docs/`；原 `aika-crossplatform` 子工程文档目录已迁出。以 [模块 SPEC](modules/README.md)、[测试规则](modules/TESTING.md) 和 [旧阶段映射](modules/MIGRATION.md) 为当前执行依据。

LLM、STT、TTS、前端分别编写 SPEC、分别验收；小阶段只运行本模块相关测试，其他模块用 stub/mock。跨模块链路和全量构建进入 [集成阶段](integration/SPEC.md)，不作为每个小阶段的前置门槛。当前先执行 LLM-01；语音设备验收、Live2D、环境采集继续后置。

既有 S1 当前 LLM 范围已通过并推送 `bc9f5bb`。LLM-01 已有未提交代码与定向自测报告，真实模型质量 NOT RUN，等待审阅；本轮先整理规范，不开始 LLM-02。以下旧阶段安排保留追溯，若与模块计划冲突，以模块计划为准。

---

2026-09-10。[PRD v0.4](PRD_V0.4.md) 已按用户要求补充模块开发规则；原始导入稿保留在 [归档](archive/PRD_V0.4_ORIGINAL.md)。本文与 SPEC 记录工程解释；PRD 的“已实现/部分完成”是导入时产品描述，当前验收以报告为准。

## 范围与优先级

当前继续已确定的 LLM 回复主线 S1→S2→S3→S4→S5→S6。真人语音及新增语音工作、S7/S8 仍后置；导入 PRD 不撤销已有后置决定。PRD 的 MVP 1–4、Stage 2–4 与工程 S1–S8 使用不同编号，不一一对应。PRD 将 Live2D 列入 MVP 4、环境感知列为 Stage 2，同时第 25 节按环境→Live2D 排序；当前均未恢复排期，后续启用时再确定两者实际顺序，不以编号作为硬性技术依赖。

| PRD 内容 | 落地阶段 | 本次对齐 |
| --- | --- | --- |
| §6 CompanionRuntime | S3 建立，S5 完善后台写回/动作决策 | 从 Hook 抽出生产编排，注入依赖，UI 订阅状态 |
| §7 Turn 与中断历史 | S1 已有实现；S3 保持兼容 | 现有 completion/playbackStatus 映射 deliveryStatus；未确认听到的不当完整上下文；文字回复不等 TTS |
| §8–9 Soul/三种 Mode | S2 | 增加 scenario_practice；临时场景身份不覆写角色 |
| §10 User Soul | S2 类型；S4/S5 沉淀 | 重复证据、来源与用户修订；单次模型推断不覆盖画像 |
| §11–13 Memory | S4 数据/检索，S5 写回 | type、importance、有效期、访问时间、candidate/confirmed/superseded；FTS5/BM25 + recency + importance |
| §14 Context | S3 | 有预算的 AgentContext 与单来源失败降级 |
| §15 Knowledge | S6 | character/world/oral/scenario 类型与标签、解锁阶段、来源映射 |
| §16 Relationship | S2 隔离接口；后续升级 | 保留当前关系值与无衰减；新版 activeDays/userTurnCount/meaningfulEvents 后置，不在 S2 偷改评分 |
| §17 协议 | S2/S5 | 规范化 mood/replyText/translation/memoryCandidates/actions；旧字段适配 |
| §18/24 环境与多模态 | S7 及后续支线 | 统一事件外壳；OCR/进程按显式开关，Camera/VLM/Graph 不进入当前主线 |
| §19–20 Live2D/TTS | S8/后置语音 | 保持表现层和 TTS 抽象，不迁 Unity |
| §21 手机端 | S3 保持 Runtime 共用 | PC 唯一记忆源；配对/会话令牌/Bearer 迁移另行规格化，不在本次扩大范围 |

## 协议解释

PRD 的 snake_case JSON 与 camelCase 类型均为示例；SPEC 统一内部 `ReplyEnvelopeV1`，首轮输出顺序采用 mood→replyText→translation→memoryCandidates→actions。`action` 单项和旧 `toolCalls` 可在适配层规范为 actions 数组，内部不长期保留多套含义。模型决定是否使用已召回知识；本地预检索不新增 LLM 请求。确需动态工具后续推理时显式记为工具回合。

## 当前状态快照

S1 当前 LLM 范围已批准并提交/推送 `bc9f5bb`。报告记录前端全量 29 文件/287 测试通过，后续文本/Provider 定向 19 测试通过，Rust 5 测试通过，Tauri MSI/NSIS 构建成功；这些是不同时间的检查，不拼成新的全量测试总数。S1-AC03–07 为 DEFERRED。S2 待执行；S3–S6 未开始；S7/S8 暂缓。本次未重新运行工程测试，未用 PRD 重开已通过的 S1 范围。
