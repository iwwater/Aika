# LLM SPEC 执行索引

> 2026-09-15 文档修订：[KB-01 文件批量导入](specs/KB-01.md)已拆独立草案，未派发、AC 全部 NOT RUN，不依赖 0.6 或研究型 RAG。MVP-06 的真实 Voice 与记忆双轨裁决见 [0.5 收口索引](../integration/SPEC_MVP_0.5.md)，不因已有模块结果清账。

需求见 [LLM PRD](PRD.md)。每次只下发一份下面的 SPEC；相关测试在本模块完成，不依赖真实 STT/TTS/前端。

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [LLM-01](specs/LLM-01_SOUL_MODE_SCHEMA.md) | Soul / 三模式 / 输出协议 | 已自测 6 文件/85 测试通过；LLM-01-D 只有 fixture，真实模型质量 NOT RUN；待审阅，不新增完成声明 |
| [LLM-02](specs/LLM-02_RUNTIME_CONTEXT.md) | Runtime / Context / 取消 | 已自测 4 文件/46 测试通过；真实模型样本与 Hook 接入 NOT RUN；待审阅，不新增完成声明 |
| [LLM-03](specs/LLM-03_MEMORY_USER_SOUL.md) | Memory / User Soul | 已自测通过；已接入存储与运行时；真实 SQLite 已跑通；AC-D 真实模型 10 样本 REAL RUN（10/10 命中、0 伪造）；回复质量待审阅 |
| [LLM-04](specs/LLM-04_AGENT_MEMORY_WRITEBACK.md) | 单次 Agent / 后台写回 | 已实现（2026-09-13）：MemoryMaintenance 唯一 worker + RequestMetric 计量；定向回归 274 测试全绿；真实服务 NOT RUN。见[验收报告](reports/LLM-04_AGENT_MEMORY_WRITEBACK_ACCEPTANCE.md) |
| [LLM-05](specs/LLM-05_KNOWLEDGE_RAG.md) | Knowledge / RAG | **A～E 全 PASS（2026-09-15 补跑）**：A/B/C/E 自动全过（真实 SQLite FTS5，15/15 命中）；AC-D 真实模型问答 09-15 补跑 **10/10 grounded**（首轮 8/10 经逐题核对判为判定器假阴性，只扩容同义判定词表）。见[验收报告](reports/LLM-05_ACCEPTANCE.md)、[MVP-06 报告 §3 AC-F](reports/MVP-06_ACCEPTANCE.md) |
| [LLM-06](specs/LLM-06_TRACE_PROTOCOL.md) | Trace 采集协议与 Sink 端口（F3 数据底座） | 已自测 A–E 全 PASS；两实现同用例包 31 测试通过，五处突变各命中；无生产消费者（本阶段预期如此）；待审阅 |
| [LLM-07](specs/LLM-07_TRACE_WIRING.md) | Trace 接入（Runtime 侧与开关） | 已自测 A–F 全 PASS；三处突变各命中；里程碑全量 820 测试通过；待审阅 |
| [LLM-08](specs/LLM-08_TRACE_SOURCES.md) | Trace 余下三个事件源 | 已自测 A–E 全 PASS；三处突变各命中（其中一条用例的理由被突变证伪后已修正）；全量 829 测试通过；待审阅 |
| [LLM-09](specs/LLM-09_REPLY_EVENT.md) | reply 事件（回包要素与语义退化标记） | 已自测 A–E 全 PASS；两处突变命中；待审阅 |
| [LLM-10](specs/LLM-10_PROVIDER_USAGE.md) | Provider usage 上报（F9 成本页前置） | 已自测 A–F 全 PASS；八处突变命中；四协议fixture；DeepSeek已有真实样本（见frontend/reports/REAL_TURN_VERIFICATION.md），另三协议真实NOT RUN；待审阅 |

LLM-01 已有 [验收报告](reports/LLM-01_ACCEPTANCE.md)，其中真实模型质量未执行；本次拆文档不重新跑测试、不追认通过。LLM-02 已有 [验收报告](reports/LLM-02_ACCEPTANCE.md)，只验 headless 编排与装配逻辑，Hook 接入与真实模型样本未执行。LLM-03 已有 [验收报告](reports/LLM-03_ACCEPTANCE.md)，AC-A/B/C/D 全部通过（含真实 SQLite FTS5 与真实模型 qwen-plus 跨会话 10 样本：10/10 命中、0 伪造、0 候选当确证），回复自然度待审阅。LLM-04–05 已交付（LLM-04 见专名报告；LLM-05 的 AC-D 于 2026-09-15 补跑转 PASS），均待审阅。

## 2026-09-13 新增执行项

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [LLM-11](specs/LLM-11_CONTEXT_SNAPSHOT.md) | 上下文装配快照 | AUTO_PASS（2026-09-13）：A~D 全过，516 测试回归全绿；消费 traceView/pluginGraph/TracePage 已同步。见[验收报告](reports/LLM-11_ACCEPTANCE.md) |
| [LLM-12](specs/LLM-12_USAGE_LEDGER.md) | Provider物理请求用量记录（F9输入输出/用途前置） | AUTO_PASS（2026-09-13）：A~D 自动 AC 全过，定向 98 + 全量 1104 回归全绿；真实计费 NOT RUN。见[验收报告](reports/LLM-12_ACCEPTANCE.md) |

当前执行按[安全计划](../GOAL_EXECUTION_PLAN.md)。早期无报告项状态为未核实/待补证，不认定未实现或通过；已有报告项仍待审阅。
