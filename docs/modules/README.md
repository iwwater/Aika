# 模块开发与 SPEC 总入口

> 2026-09-14 桌宠新路线属于前端模块：[集成 RPD](../frontend/RPD_DESKTOP_PET_INTEGRATION.md)、[PET SPEC 索引](../frontend/SPEC_DESKTOP_PET.md)。与旧自研窗口/Live2D 任务冲突时以新路线为准；其余模块与既有证据不变。
>
> **2026-09-15 更新**：0.5 主线（MVP-01～06，跨 CORE/前端/集成/LLM）六份 SPEC 已全部执行完毕，收口与遗留清单见 [HANDOFF_MVP_0.5.md](../HANDOFF_MVP_0.5.md)；发布门禁 INT-03 已执行（**部分 PASS**，NSIS 打包 BLOCKED、安装卸载 NOT RUN）。下表「当前状态」列已按 09-15 口径同步；**逐项权威状态仍以各模块 SPEC.md 索引与 [ACCEPTANCE_PLAN 回填表](../ACCEPTANCE_PLAN.md) 为准**。

2026-09-10 更新：采用 LLM、STT、TTS、前端四模块开发，替代旧 S1→S8 的串行阶段门禁。这里只拆分文档、责任和验收，不在整理时搬动业务源码或重写实现。

| 模块 | 负责什么 | 小阶段 | 当前状态（2026-09-15） |
| --- | --- | --- | --- |
| [CORE](../core/SPEC.md) | 内核、服务注册表、插件与宿主装配、Presenter | CORE-01 → 09 | CORE-01～09 全部自测、**待审阅**；全仓单一编排路径（CORE-06 已删 legacy）；7 个端口全部有可比对象；新增 [MVP-01](../core/specs/MVP-01.md) 可选能力生命周期（A～E PASS） |
| [LLM](../llm/SPEC.md) | Provider、Soul/Mode、Context、Memory、RAG、回复生命周期、Trace、用量 | LLM-01 → 12 | LLM-01～12 已交付、**待审阅**；LLM-04 已实现、LLM-05 的 AC-D 于 09-15 补跑 **10/10 PASS**；Trace（06～09）与用量（10/12）已交付；真实模型质量仅部分取证（DeepSeek 有真实样本，另三协议 fixture） |
| [STT](../stt/SPEC.md) | 麦克风、VAD、ASR、分段排序、输入回合结束 | STT-01 → 04 | STT-01/02 已补证、STT-04 REVIEWED_AUTO；**STT-03 真机麦克风 DEFERRED** |
| [TTS](../tts/SPEC.md) | 分句、语音合成、播放队列、停止、播放进度 | TTS-01 → 05 | TTS-01/02 已补证、TTS-04 已交付（AUTO_PASS）；**TTS-03 音频验收 DEFERRED、TTS-05 真实云试听 NOT RUN** |
| [前端](../frontend/SPEC.md) | 页面、字幕、模式设置、Runtime 状态展示、工作台、桌宠与陪伴 | FE-01 → 33 / PET-01～08 / MVP-02～04 | FE-01～13 已交付待审阅；FE-14/23～26 AUTO_PASS；FE-15～17 PARTIAL；FE-18～22 模块内 PASS、**真机 NOT RUN**；FE-31/32 PARTIAL；**FE-20/27/28/29 SUPERSEDED**（桌宠改走 [PET 线](../frontend/SPEC_DESKTOP_PET.md)，PET-01~06 已交付、PET-07 A/B PASS）/ FE-30、FE-33 未完成 |

CORE 是四模块的装配层，不取代它们的 SPEC；方案见 [重构计划书](../core/REFACTOR_PLAN.md)。四模块可以通过约定接口独立开发，不必等其它模块完成。**（09-15 注：原文「本次先整理规则与独立 SPEC」是 09-10 的落地状态描述，项目现已进入实现与验收阶段；待审阅项、真机项与凭证项见上表与 [ACCEPTANCE_PLAN](../ACCEPTANCE_PLAN.md)。）** 不自动创建或恢复执行任务，不自动恢复真人语音、Live2D 或环境采集。

- [共享接口与归属](CONTRACTS.md)：输入输出、取消语义与共享文件责任。
- [模块测试规则](TESTING.md)：小阶段只测本模块，何时进入集成。
- [验收报告模板](ACCEPTANCE_TEMPLATE.md)：每个模块/小阶段独立记录。
- [集成验收](../integration/SPEC.md)：跨模块契约、完整链路和发布门禁。
- [旧阶段映射](MIGRATION.md)：原 S1–S8 的要求与证据没有丢弃。

规格状态与实现状态分开。既有 S1 通过不代表四模块全部通过；旧自动证据只能按覆盖范围复用，语音 DEFERRED 不改为 PASS。
