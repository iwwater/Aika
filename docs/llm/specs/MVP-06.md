# MVP-06 · Memory / Wiki / RAG收口

依据：[RPD](../../RPD_MVP_0.5.md) MVP-R06；前置MVP-05。

范围：现有MemoryRepository、Knowledge/ContextSource、上下文装配、设置与Wiki查看编辑入口。先核实已有能力，补差距，不重写存储或ReplyEnvelope。统一候选来源/scope，近期会话保留；模型一次输出回复/情绪/动作/候选。

> 2026-09-15 文档校正：实现/模块证据保留，整体验收 PARTIAL；F 的 Voice 闭环未测，G 的产品收口不得提前判定。下表新增解释不追认历史报告通过，也不授权修改代码。

| AC | 验收 |
| --- | --- |
| A | 稳定事实保存、确认/编辑/删除可用，OCR来源可溯源；未经确认原始OCR不自动持久化 |
| B | Wiki最少可查看/编辑/删除稳定条目，User/Character归属明确；已有数据向后兼容 |
| C | Recent+Memory Top-K+Wiki Top-K构成有预算Context，两个源分别超时/失败仍能回答 |
| D | Memory关闭禁止长期读写；RAG关闭禁止额外检索；在途禁用结果不注入/写回 |
| E | 分列固定聊天事实的长期检索召回与获授权 OCR 的当前轮参考上下文，进入一次生产 Runtime 前台生成；不将 OCR 当前轮上下文当长期记忆召回。物理 attempt 与后台维护调用单独计量 |
| F | 真实Provider语义演示与现有Voice输入→Agent→Pet实机闭环单列；缺设备/凭证不伪造PASS |
| G | 复验MVP-05矩阵及必要全量回归，列出0.5 DoD通过/未测，未完成不得宣告冻结发布 |

报告llm/reports/MVP-06_ACCEPTANCE.md。真人声学质量仍按原INT-02数量单独验，不以一次demo替代。

## 尚未裁决的候选双轨

`memoryCandidates` 回复字段无生产消费点，已有确认流来自后台抽取。MEM-DEC-01 待用户决定接入或删除，不因 A 的已有确认流通过就宣称回复候选闭环完成。若接入，另拆来源/轮次/epoch、去重、与后台抽取冲突及禁用在途写回的 AC；若删除，另拆 prompt/schema/parser/fixtures 与兼容 AC。本份不擅自选路线或承诺半小时落地。

文件批量导入由 [KB-01](KB-01.md) 单独规划；不将其草案状态算作本份已交付，也不扩展 LLM-05 的研究型 RAG。
