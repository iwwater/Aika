# Aika 文档入口

> **2026-09-15 更新**：MVP 0.5 六份 SPEC 已有实现/模块交付，产品与发行验收未完成（见 [Handoff](HANDOFF_MVP_0.5.md)），PET-01～06 已交付、PET-07 的 Aiki 宿主侧闭环 A/B 已 PASS；FE-27/28/29 已 SUPERSEDED、FE-30 部分替代。
>
> 2026-09-14 桌宠策略更新：[Aiki Desktop Pet Integration RPD](frontend/RPD_DESKTOP_PET_INTEGRATION.md) → [PET-01～08 SPEC](frontend/SPEC_DESKTOP_PET.md)。0.5 集成 OpenPet，0.6 当前规划见 [Pet Shell RPD](RPD_MVP_0.6.md)，NyaDeskPet 为已搁置的历史候选；停止自研桌宠 Runtime 路线。（原文「当前完成文档，非实现验收」指 09-14 当时状态，现已进入实现与验收。）

整个项目唯一的文档目录是仓库根 `docs/`。业务源码仍在 `aika-crossplatform/src/`；不在子工程或 src 内再建另一套 docs。目录 README 可保留最小使用说明并链接到这里。

## 当前开发

- [模块 SPEC 总入口](modules/README.md)：LLM、STT、TTS、前端四模块与当前状态。
- [LLM SPEC](llm/SPEC.md) · [STT SPEC](stt/SPEC.md) · [TTS SPEC](tts/SPEC.md) · [前端 SPEC](frontend/SPEC.md)
- [CORE SPEC](core/SPEC.md)：运行时内核与装配层，方案见 [重构计划书](core/REFACTOR_PLAN.md)、接口见 [内核架构](core/ARCHITECTURE.md)。
- [共享接口](modules/CONTRACTS.md) · [模块内测试规则](modules/TESTING.md) · [模块验收模板](modules/ACCEPTANCE_TEMPLATE.md)
- [调试工作台 · 进度与未完成项](WORKBENCH_PROGRESS.md)：F1～F8 已交付什么、F9 与增量待执行项，以及全局未验证项。
- [集成验收](integration/SPEC.md)：跨模块链路、全量回归与打包。
- [旧阶段映射](modules/MIGRATION.md)：旧 S1–S8 要求与证据归属。

**2026-09-15 状态**：0.5 主线六份 SPEC（MVP-01～06）已有实现/模块报告，MVP-03/06 整体验收仍为 PARTIAL，收口与遗留清单见 [MVP 0.5 Handoff](HANDOFF_MVP_0.5.md)；需要你亲自验的项见 [验收计划](ACCEPTANCE_PLAN.md)；桌宠按 [PET 线](frontend/SPEC_DESKTOP_PET.md)（FE-20/27/28/29 已 SUPERSEDED）。CORE-01～09、LLM-01～12 已交付、待审阅：全仓只剩一条对话编排路径，内核契约已在 [共享接口](modules/CONTRACTS.md) 冻结；云端合成已有用户入口（TTS-04）但**真实云 TTS 仍未试听**。真实模型质量仅部分取证（DeepSeek 有真实样本，另三协议仍 fixture）。小阶段只测试本模块，必须联调或大任务完成后才全流程调试。S1 的历史通过记录保留，不代表新模块已全部完成。

## 产品与计划

- [PRD v0.4（含最新开发规则）](PRD_V0.4.md) · [PRD 落地对照](PRD_ALIGNMENT.md)
- [开发方案](archive/DEVELOPMENT_PLAN.md) · [下一步](archive/NEXT_STEPS.md)
- [口语陪练细则](llm/further/ORAL_PRACTICE_V1_PLAN.md) · [交接记录](archive/HANDOFF.md) · [实机记录](stt/further/FIELD_TEST_NOTES.md)
- [主工程运行说明](../aika-crossplatform/README.md)

## 角色与后续能力

- [角色包](frontend/further/CHARACTER_PACK.md) · [角色模板](frontend/further/CHARACTER_BRIEF_TEMPLATE.md)
- [Live2D 工作流](frontend/further/COMFYUI_LIVE2D_WORKFLOW.md) · [声音工坊](tts/further/VOICE_WORKSHOP.md)

## 研究资料与历史

- [研究路线](archive/research/AFFECT_RESEARCH_ROADMAP.md) · [研究开发计划](archive/research/AFFECT_IMPLEMENTATION_PLAN.md) · [论文资料](archive/research/affect/README.md)
- [旧阶段 SPEC](archive/stages/README.md) · [S1 验收证据](archive/stages/reports/S1_ACCEPTANCE.md) · [后置真人验收](archive/stages/HUMAN_ACCEPTANCE.md)
- Android 原型：[构建](archive/ANDROID_PROTOTYPE.md) · [架构](archive/ARCHITECTURE.md) · [状态](archive/IMPLEMENTATION_STATUS.md)

研究与历史文档不作为当前模块派发指令。论文原件仍保持 Git 忽略。

模块需求：[LLM PRD](llm/PRD.md) · [TTS PRD](tts/PRD.md) · [STT PRD](stt/PRD.md) · [前端 PRD](frontend/PRD.md)。Agent 自动读取根 [AGENTS.md](../AGENTS.md)。原始导入稿保留在 [归档](archive/PRD_V0.4_ORIGINAL.md)。

## v0.5 与安全批量执行

[PRD v0.5](PRD_V0.5.md) · [审阅结论](REVIEW_V0.5_AND_BACKLOG.md) · [执行顺序及跳过规则](GOAL_EXECUTION_PLAN.md) · [另一位worker提示词](GOAL_WORKER_PROMPT.md)

[Runtime SPEC](runtime/SPEC.md) · [Gateway SPEC](gateway/SPEC.md) · [Agent SPEC](agents/SPEC.md)

## v0.6 规划（待确认）

[派发方案审阅与修订](REVIEW_DISPATCH_2026-09-15.md)：0.5欠账、独立小任务、0.6决策及技术前置；本轮只改文档，不执行。

[RPD_MVP_0.6](RPD_MVP_0.6.md)：Pet Shell（OpenPet fork ＋ Live2D 换装）规划稿。[SPEC 索引与 MVP-07～13 明细](integration/SPEC_MVP_0.6.md)已拆为草案；MVP-12 未纳入，其他项仍待决策与实施授权。独立小任务见 [KB-01](llm/specs/KB-01.md)。

[TODO 工作池](TODO.md)：用户方向性需求的登记与状态看板（愿望池，非执行授权）。

## Aika Next 文档

Next 的版本路线、SPEC 与报告见 [Next 文档入口](README_NEXT.md)；旧主工程与 Next 文档保持各自版本边界。
