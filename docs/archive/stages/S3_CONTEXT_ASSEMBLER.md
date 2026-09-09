# S3 · ContextAssembler

> 历史阶段规格：已由 [模块 SPEC](../../modules/README.md) 和 [模块测试规则](../../modules/TESTING.md) 替代。下方旧串行顺序及全仓小阶段门禁不再执行；保留原要求与历史证据追溯。

> 2026-09-10：本阶段以 LLM 文本回复开发为主。真人麦克风、TTS、声学指标不作为准入或通过门槛；保留已有语音适配回归。文本对话质量由固定样本与审阅验证。

状态：待实现；前置 S2。目标：每轮上下文由一个可观察、可限额的入口构造。

## 范围与接口

拟定入口 `assembleContext(input): ContextBundle`。input 包含 turnId、当前输入、近期对话/摘要、CharacterSoul、UserSoul、Mode、RelationshipState、时钟/时区、可选 memories/knowledge/environment 及预算。外部检索由调用方完成；Assembler 不再调用 LLM、不自行访问网络。

输出：结构化 sections、来源引用、保留/丢弃原因、估算 token 数、schemaVersion。统一供文字、语音及主动消息路径使用，主动消息显式标记来源。

- 时间使用用户设备时区，可注入测试时钟；角色世界时间单独标记，不再用角色所在时区冒充用户当前时间。
- 预算为模型输入上限扣除输出预留与安全余量；无精确 tokenizer 时记录估算算法与保守余量。
- 优先保留边界/协议、角色核心与当前请求，再保留近期对话、相关记忆/知识、摘要和环境。先裁低优先证据，同级按相关性与时间稳定排序；不截断为无效消息结构。
- 必需内容本身超过预算时返回明确错误，不静默截断当前请求。空记忆/知识/环境有效，可降级聊天。
- 检索内容作为有来源的数据，不允许其覆盖系统指令；调试记录默认只含计数和来源 ID，不记录密钥或完整聊天。

交付建议位置 `services/context/` 与 `domain/context.ts`（拟新增）；从 `domain/prompt.ts` 和会话 Hook 迁移拼接职责，保留 Provider 格式适配。

## 验收条件

| ID | 方法 | 通过条件 |
| --- | --- | --- |
| S3-AC01 | 自动：固定输入/时间、重复运行 | sections 与排序一致；所有丢弃项有原因；无隐藏 LLM/网络调用 |
| S3-AC02 | 自动：小预算/超长历史/必需内容超限 | 不超配置预算；核心约束保留；不可容纳请求明确失败 |
| S3-AC03 | 自动：跨午夜、时区变化 | 时间、日期、相对时间按注入时钟与用户时区计算，不使用固定日本时间 |
| S3-AC04 | 集成：文字/语音/主动消息 | 三入口经过同一装配逻辑；来源与当前轮次正确 |
| S3-AC05 | 自动+人工：证据内含“忽略指令” | 来源仍为数据，不能改变 Mode/边界/工具白名单；缺失可选 section 时仍可回复 |

本阶段不实现完整检索算法，S4/S6/S7 接入预留 section。

## PRD v0.4 增补：CompanionRuntime

本阶段同时建立独立于 React 的 CompanionRuntime，接管 Turn 生命周期、Context 装配、Agent 请求/取消、会话存储和状态通知；以注入的 Provider/Storage/Clock/检索源实现，无 React import。Hook 仅桥接订阅与 UI 事件；S1 文本/取消/播放状态语义保持兼容。后台候选沉淀与 Action 决策在 S5 扩展同一 Runtime，禁止另建第二套编排。

ContextBundle 中明确提供结构化 AgentContext（clock、characterSoul、userSoul、relationship、mode、recentConversation、summary、memories、knowledge、environment），sections 是其渲染结果。可选源应独立超时/捕获异常并返回缺失原因；核心请求失败仍显式报错。PC Runtime 是本地与手机远程请求的单一业务入口，手机不维护第二份记忆库；CLI 只要求 headless 测试可复用，暂不开发新 CLI 产品。

| ID | 方法 | 通过条件 |
| --- | --- | --- |
| S3-AC06 | 自动：无 React 的 Runtime 集成测试 | 可发送、订阅流式状态、取消并开始下一轮；生产 Hook 使用同一个 Runtime，S1 完成/中断历史行为不回退 |
| S3-AC07 | 集成：Memory/RAG/Sensor 分别超时或抛错 | 每项单独故障时仍可生成回复，trace 记录失效源；不将错误文本当知识注入 |
| S3-AC08 | 集成：本地与 Remote 入口 | 共用 PC Runtime 与存储，无第二份 Memory；当前身份/Mode/turnId 传递一致 |
