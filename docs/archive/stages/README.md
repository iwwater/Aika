# Aika 分阶段 SPEC 与验收

> 历史阶段规格：已由 [模块 SPEC](../../modules/README.md) 和 [模块测试规则](../../modules/TESTING.md) 替代。下方旧串行顺序及全仓小阶段门禁不再执行；保留原要求与历史证据追溯。

日期：2026-09-10。当前主线仅为 LLM 回复开发；S1 当前 LLM 范围已通过原任务工程验收，真人语音项目后置。

本目录细化 DEVELOPMENT_PLAN 的当前执行计划。历史 M0–M7 是既有实现记录，本目录 S1–S8 是新一轮改造阶段，两者不对应。产品仍用 React + Tauri，陪练是独立 Mode。

## PRD 依据

[PRD v0.4 原稿](../../PRD_V0.4.md) 已保存；[落地对照](../../PRD_ALIGNMENT.md) 解释阶段映射与协议归一。S2 增加场景模式，S3 建立 CompanionRuntime，S4 完善 Memory Schema 与画像证据规则。当前 LLM 主线及后置决定保持不变。

## 阶段与准入

| 阶段 | SPEC | 前置门槛 | 交付重点 |
| --- | --- | --- | --- |
| S1 · 已通过（当前范围） | [LLM 回复 Runtime](S1_VOICE_RUNTIME.md) | 已有工程基线 | 流式回复、取消、保存、错误恢复；真人语音后置 |
| S2 | [Soul / Mode / Schema](S2_SOUL_MODE_SCHEMA.md) | S1 通过 | 分离人格与行为模式 |
| S3 | [CompanionRuntime / ContextAssembler](S3_CONTEXT_ASSEMBLER.md) | S2 通过 | 单一装配入口与预算 |
| S4 | [Memory Retrieval](S4_MEMORY_RETRIEVAL.md) | S3 通过 | 可追溯、可纠正、可删除的检索 |
| S5 | [单次 Agent Call](S5_AGENT_CALL.md) | S4 通过 | 流式结构化回复与后台沉淀 |
| S6 | [RAG / Wiki](S6_RAG_WIKI.md) | S5 通过 | 本地知识检索与关系过滤 |
| S7 · 暂缓 | [环境感知](S7_ENVIRONMENT.md) | S6 通过 | 用户可控的环境快照 |
| S8 · 暂缓 | [Live2D](S8_LIVE2D.md) | S7 通过 | 表现层与音频同步 |

当前顺序：S1 → S2 → S3 → S4 → S5 → S6。S7 环境感知、S8 Live2D 与新增语音开发暂缓。每阶段原任务验收通过后由 Luna commit/push，推送成功再继续。

## 共同验收规则

- 每条 AC 均填写 PASS / FAIL / BLOCKED / DEFERRED / NOT RUN，并关联证据。缺服务、设备或人工记录时默认记 BLOCKED；若用户明确将实机/真人验收后置，可记 DEFERRED，但不得写成 PASS，也不得伪造实机证据。
- 在 `aika-crossplatform/` 运行 `npm test` 与 `npm run build`；涉及 Rust 时增加 `cargo test --manifest-path src-tauri/Cargo.toml` 和桌面构建。记录提交号、命令、退出码；阶段无关的既有失败也须注明。
- 自动测试重点覆盖状态竞争、数据迁移、预算与权限边界；真人感、音质、漏音和回声由实机验收。固定输入、模型与参数，失败样本不得从统计中剔除。
- 性能在同一设备、相同模型/网络配置下比较；预热 3 轮不计样本，记录 P50/P95，nearest-rank 算法。失败率单列；不足样本不报告可靠达标结论。
- 确定性 AC 要求全部通过。涉及自然语言质量的样本数和阈值见各阶段；阈值为拟定产品门槛，不是现有性能结论。语音首音频、同设备基线与真实设备测试统一后置，详见 [真人验收清单](HUMAN_ACCEPTANCE.md)。
- 数据结构改动须版本化、旧数据迁移幂等；失败时不破坏原数据。保留 SQLite 主路径与浏览器降级路径，差异在界面和报告中可见。
- 每阶段报告使用 [验收模板](ACCEPTANCE_TEMPLATE.md)。当前范围内的必需 AC 通过即可登记工程验收完成；DEFERRED 不阻塞也不算 PASS。修复后复测受影响项。

## 现在的第一项交付

按修订后的 S1 复核生产文本回复路径和已有自动证据；缺项由 Luna 补齐。语音真人验收不再作为前置条件。S1 当前 LLM 范围已获原任务批准；本次提交完成后等待原任务派发 S2。
