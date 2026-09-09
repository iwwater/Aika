# LLM 模块 SPEC

职责：从文本与上下文生成角色回复，管理模式、记忆、知识和回复生命周期。包含 Provider、CompanionRuntime、ContextAssembler、Memory/RAG 与本地存储；不负责录音、语音播放和页面布局。

输入为文本/Mode/来源；输出为 turnId 与结构化流式事件，见 [接口契约](../CONTRACTS.md)。真实 STT/TTS/前端均不是本模块测试前置。现有 S1 证据可作基线，不表示以下新增小阶段已完成。

## LLM-01 · Soul、Mode 与输出协议（当前）

交付：CharacterSoul/UserSoul 基础类型、companion/oral_practice/scenario_practice 三种 Policy、模式与场景配置读写、旧协议到 ReplyEnvelopeV1 的适配。只提供模式操作接口，不开发新 UI。场景临时身份退出后清除；用户画像自动沉淀留 LLM-03/04。

| AC | 模块内验收 |
| --- | --- |
| LLM-01-A | 三模式互切、退出场景和持久化重载后，角色 ID/人格/记忆/关系不被重置，场景身份不残留 |
| LLM-01-B | PRD 与旧 japanese_text/chinese_translation/mood/sticker 协议正常归一；转义、半截 JSON、Unicode 分片无重复正文，无需完整 JSON 才产生正文事件 |
| LLM-01-C | 未知 mood 回退中性，未知动作拒绝；坏回复显式失败，下一轮可正常调用；旧配置无模式时保留 companion |
| LLM-01-D | 三模式各 10 个固定文本场景，保留实际输出供审阅：角色/边界冲突 0，暂停纠正/中文求助/退出场景均生效；fixture 只能证明编排，不能替代输出质量 |

测试种类：生产 prompt/解析器/配置适配单测及 headless 会话测试。不要启动 TTS，也不要求 FE 模式按钮实现。

## LLM-02 · Runtime 与 Context

交付独立 React 的 CompanionRuntime；注入 Provider/Storage/Clock 和检索源，统一 turn 生命周期、取消、存储与状态订阅。AgentContext 含时间、Soul、关系、Mode、近期历史/摘要、Memory/Knowledge/环境数据。Hook 接入若需跨前端修改，由 FE-01/INT-01 消费适配；本阶段先验 headless 生产逻辑。

| AC | 模块内验收 |
| --- | --- |
| LLM-02-A | 无 React、麦克风或 TTS 时可流式回复、完成落库；取消后迟到 chunk 不影响新轮，文本完成不等待播放 |
| LLM-02-B | 固定输入/时钟产生稳定 Context；用户时区与跨午夜正确；估算 token 不超过预算，必需内容超限显式报错 |
| LLM-02-C | Memory/RAG/环境数据源各自超时/抛错时仍可回复并记录降级原因，不注入错误文本或将检索内容提升为指令 |
| LLM-02-D | 交付状态用 fixture 模拟：complete/interrupted/cancelled 与未知播放范围不会把未交付文本当已听完；旧消息迁移不丢失 |

## LLM-03 · Memory 与 User Soul

交付来源/类型/重要度/置信度/有效期/访问时间及 candidate/confirmed/superseded 状态；SQLite FTS5/BM25+recency+importance，浏览器可见词法降级。去重、更正、删除联动摘要/画像；原始重复来源不能让删除记忆复活。至少两轮独立证据才自动晋升画像，明确用户纠正可直接生效。

| AC | 模块内验收 |
| --- | --- |
| LLM-03-A | 固定 ≥30 条记忆、20 个问题：15 个有答案中 ≥13 个 Top-5 命中，5 个无答案不硬塞无关内容；覆盖三语 |
| LLM-03-B | 更正与有效期优先规则可解释；访问不自动确认；删除→重载→抽取不复活，旧库迁移两次无丢失/重复 |
| LLM-03-C | 单候选/重复来源不覆盖画像；两个独立证据可沉淀；明确用户纠正生效且来源保留 |
| LLM-03-D | 10 个跨会话文本样本 ≥8 个正确自然引用事实，伪造来源或把未确认当已确认为 0 |

## LLM-04 · 单次生成与后台维护

交付成功回复内的 memoryCandidates 校验与后台幂等队列，8 个成功轮或 session end 触发合并，后台并发 1、实时优先；actions 默认空，不扩展外部工具。

| AC | 模块内验收 |
| --- | --- |
| LLM-04-A | 20 个正常无工具回合每轮实时生成请求恰好一次；后台和重试分别计量，无分类/情绪/记忆追加实时请求 |
| LLM-04-B | 后台延迟 30 秒不延迟正文事件；重复批次/重启不重复写入，关闭记忆维护后不继续提交写入 |
| LLM-04-C | 断流、取消、畸形候选不会完成非法写回；已出正文后不重放，首正文前降级尝试单独计数 |
| LLM-04-D | 四种 Provider 生产协议 fixture 通过；真实服务联通证据与 fixture 分列，不调用其它模块 |

## LLM-05 · Knowledge/Wiki

交付 Markdown/JSON 切块、来源/type/tags/unlockStage、FTS/BM25 检索和 Context 注入，覆盖 character/world/oral/scenario；过滤先于 Top-K，关系阶段进入缓存键。无图谱/向量库。

| AC | 模块内验收 |
| --- | --- |
| LLM-05-A | 中日英各 5 个有答案问题 ≥13/15 Top-5 命中；5 个无答案返回无可靠证据 |
| LLM-05-B | 10 个未解锁查询隐藏 chunk 注入数 0，Mode/角色/阶段变化后缓存正确 |
| LLM-05-C | 新增/更新/删除/失败重建无旧索引残留，失败保留上个可用版本；FTS 不可用可见降级 |
| LLM-05-D | 10 个实际文本问答 ≥9 个与来源一致；无伪造来源，无执行知识内指令 |

上述各小阶段只运行对应 LLM 范围的测试。合计通过后再进入集成，不要求在每阶段复测全部 LLM 小阶段。
