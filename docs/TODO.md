# Aika TODO · 用户工作池

> **用途**：收集用户提出的方向性需求，维护状态与去向。本文件是**愿望池＋进度看板**，不是执行授权——开工一律走 RPD/SPEC 流程（AGENTS.md：一次一个 SPEC，逐 AC 验收，禁止依据本表直接开工）。
> **维护规则**：用户提出新条目即登记；每轮工作收尾同步状态；条目升格为规划时在「规划归宿」列挂 RPD/SPEC 链接；与 RPD/SPEC 冲突时以后者为准；不把本表当成第二套计划。
> 创建：2026-09-15 · 最后更新：2026-09-16

> 派发口径经[2026-09-15审阅](REVIEW_DISPATCH_2026-09-15.md)修订：可准备SPEC不等于已授权执行；设备就绪不等于产品验收通过。记忆双轨需决策；KB-01独立于研究型RAG；本轮仅修改方案。

## 状态图例

愿望（仅登记）→ 待澄清（需拍板范围）→ 已规划（有 RPD/SPEC 归宿）→ 进行中 → 完成（有验收报告）

## 工作池

| ID | 条目 | 现状 / 已有基础 | 目标（初步理解） | 规划归宿 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| TODO-01 | 非桌宠主对话的后端改造 | 0.5 已收口唯一 CompanionRuntime（CORE-01~09），主窗聊天/流式/取消闭环 | **待澄清范围**：要改哪一层——流式体验、延迟、Provider 协议，还是结构重构？ | 待立项（先澄清再拆 SPEC） | P1 | 待澄清 |
| TODO-02 | LLM wiki | 用户自研线；仓库已有知识库 Wiki 管理（MVP-06：版本化条目＋FTS 检索＋设置页入口） | 由用户研究后定义 | 登记，不派发（用户自研） | — | 愿望 |
| TODO-03 | OCR 陪伴功能 | MVP-04 已交付：OCR 观察→词表门禁→真实 Provider 主动轮落库；三层授权＋锁屏门禁 | 扩展场景/词表，远期接 VLM 理解 | 基础已完成；扩展待立项 | P2 | 愿望（基础已有） |
| TODO-04 | RAG 系统（agentic、graph） | SQLite FTS＋Token 预算已收口，真实结果 10/10、门槛≥9/10（LLM-05） | H1 混合检索→H2 agentic→H3 GraphRAG；动手前先固化评测集 | [RPD_MVP_0.6 §7](RPD_MVP_0.6.md) backlog RAG-H1~3 | P2 | 已规划（backlog，未授权执行） |
| TODO-05 | 记忆系统插件 | MVP-06 已有后台抽取候选→人工确认、滚动摘要、写回 epoch 与开关；回复内嵌候选尚无消费点 | **待澄清**：指记忆插件化，还是可插拔记忆后端/增强插件？ | 待立项 | P2 | 待澄清 |
| TODO-06 | TTS / STT 优化接入 | TTS-04 设置入口已交付；TTS-05 真实云试听 DEFERRED；STT-03 真机验收 DEFERRED；Whisper/云引擎端口已有 | 降延迟、云 TTS 真实验收、引擎选择扩展 | 既有 tts/stt SPEC 待办位（TTS-05、STT-03） | P1 | 已规划（遗留 DEFERRED 项） |
| TODO-07 | 换装创意工坊 | 0.6 已定义 costume slot（MVP-11）；`tools/live2d-pipeline` 素材流水线在库 | 素材生产→导入→管理 UI 工坊化 | 前置＝[RPD_MVP_0.6](RPD_MVP_0.6.md) MVP-11；工坊本体待立项 | P1 | 已规划（前置在 0.6） |
| TODO-08 | Three.js 3D 接入 | 0.6 已定义 renderer 插件槽（sprite/Live2D） | 第三 renderer：Three.js（MIT）＋开放格式模型（如 VRM）；模型素材许可逐个登记 | 前置＝0.6 MVP-10 插件槽接口冻结；待立项 | P2 | 已规划（前置在 0.6） |
| TODO-09 | 插件市场（按需加载） | kernel 插件注册表/事件总线已有；MVP-01 已交付可选能力生命周期（off/starting/running/stopping/failed＋失败隔离）；现有能力插件均随主程序打包 | 插件的发现/安装/更新/卸载＋运行时按需加载；涉及分发格式、签名与安全（装插件＝装代码，需权限与隔离设计）、共享契约版本兼容（CONTRACTS.md）、按需启停 | 待立项；前置＝MVP-01 生命周期语义＋契约版本化；pet-shell 插件槽（0.6 MVP-10）为表现层先例 | P2 | 愿望 |
| TODO-10 | Streaming Voice Pipeline V2（流式 ASR/TTS 改造） | 0.5 现状＝Silero VAD 切整段→Whisper 整段识别，「流式收音但非流式识别」；`SpeechInputEngine` 契约（speechStart/segmentFinal/turnReady）已就位，Web Speech 路线已支持 interim | 新增 `StreamingAsrInput`（WebSocket 长连接 ASR Session，partial→UI、final→turnReady），Silero 与 Streaming ASR 并行；P1 另含 LLM Phrase Chunker、Streaming TTS；**不重写架构、不全项目 WebSocket 化**，保留 VAD/turnReady/一回合一次 LLM | 资料已沉淀：[STT further 笔记](stt/further/STREAMING_ASR_PIPELINE_V2_NOTES.md)；待立项拆 SPEC（候选 STT-05，与 TODO-06 相关） | P1 | 愿望（已登记资料） |
| KB-01 | 知识库文件批量导入 | index已有importDocuments；尚需管理端口、文件读取宿主与UI，不只是选择器 | 复用事务/去重/归属/限额，首版支持格式在SPEC冻结；不引入研究型RAG | [KB-01 草案](llm/specs/KB-01.md) | P2 | SPEC已拆，未派发 |
| MEM-DEC-01 | 回复候选与后台抽取双轨 | memoryCandidates无生产消费点，当前确认流依赖后台抽取 | 接通candidate确认流或从生成协议删除；两者都需去重/来源/撤权或兼容处理，不估作半小时 | [派发审阅C档](REVIEW_DISPATCH_2026-09-15.md) | P1 | 待决策 |
| TODO-11 | 桌宠气泡位置修正（2026-09-16 用户提出） | 气泡由 pet-shell 渲染：`.pet-bubble` 固定在**窗口顶部居中**（pet-shell `src/styles.css:1052`，`top:18px; left:50%`），会盖住模型头部；MVP-15 (b) 接通 `/api/say` 后每次点击回应都冒泡，问题更显眼 | **待拍板目标位置**：宠物头顶上方（不遮脸，随窗口尺寸自适应）？还是气泡在窗口外侧/跟随模型位置？拍板后大概率是 pet-shell 一处 CSS/布局小修（含四种气泡样式 preview 一致性） | 待立项（pet-shell 侧 UI 小修，先拍板位置再动手） | P2 | 待澄清 |

## 当前唯一在推进的规划

- **0.6 Pet Shell**（[RPD_MVP_0.6.md](RPD_MVP_0.6.md)，MVP-07~13）：fork OpenPet→剪枝/插件化/品牌替换→四端点接 Aika→Live2D 换装。**待拍板**：① pet-shell 正式命名；② 是否对外分发；③ MVP-12（双向交互）是否纳入本轮。
- TODO-07/08 的前置都在 0.6 内完成；[0.6 SPEC 索引与明细](integration/SPEC_MVP_0.6.md)已拆为草案，待决策与实施授权。

0.6确认后的顺序以RPD v1.2为准：07基线与技术可行性出口→10槽位→08品牌/生命周期→09兼容→11 Live2D→13验收。MVP-12按选定范围与依赖排入。现阶段仅审阅，不开工。

## 已完成大事件（参考）

- 0.5主线逻辑/模块面已收口，**产品验收与发布未全部完成**：Voice闭环、MVP-03-B五入口、FE-33适用项/BUG-02/03及宿主偶发退出仍须留账，见[Handoff](HANDOFF_MVP_0.5.md)与[修订验收清单](REVIEW_DISPATCH_2026-09-15.md)。
- 桌宠 PET-01~07：OpenPet 集成闭环（Aiki 宿主侧 device PASS）；协议 fixtures 冻结。
- INT-03 发布门禁部分 PASS（MSI 全绿；NSIS BLOCKED、安装卸载回归 NOT RUN）。
