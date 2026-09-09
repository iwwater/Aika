# LLM SPEC 执行索引

需求见 [LLM PRD](PRD.md)。每次只下发一份下面的 SPEC；相关测试在本模块完成，不依赖真实 STT/TTS/前端。

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [LLM-01](specs/LLM-01_SOUL_MODE_SCHEMA.md) | Soul / 三模式 / 输出协议 | 已自测 6 文件/85 测试通过；LLM-01-D 只有 fixture，真实模型质量 NOT RUN；待审阅，不新增完成声明 |
| [LLM-02](specs/LLM-02_RUNTIME_CONTEXT.md) | Runtime / Context / 取消 | 未开始 |
| [LLM-03](specs/LLM-03_MEMORY_USER_SOUL.md) | Memory / User Soul | 未开始 |
| [LLM-04](specs/LLM-04_AGENT_MEMORY_WRITEBACK.md) | 单次 Agent / 后台写回 | 未开始 |
| [LLM-05](specs/LLM-05_KNOWLEDGE_RAG.md) | Knowledge / RAG | 未开始 |

LLM-01 已有 [验收报告](reports/LLM-01_ACCEPTANCE.md)，其中真实模型质量未执行；本次拆文档不重新跑测试、不追认通过。LLM-02–05 尚未开始。
