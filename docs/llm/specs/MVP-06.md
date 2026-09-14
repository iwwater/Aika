# MVP-06 · Memory / Wiki / RAG收口

依据：[RPD](../../RPD_MVP_0.5.md) MVP-R06；前置MVP-05。

范围：现有MemoryRepository、Knowledge/ContextSource、上下文装配、设置与Wiki查看编辑入口。先核实已有能力，补差距，不重写存储或ReplyEnvelope。统一候选来源/scope，近期会话保留；模型一次输出回复/情绪/动作/候选。

| AC | 验收 |
| --- | --- |
| A | 稳定事实保存、确认/编辑/删除可用，OCR来源可溯源；未经确认原始OCR不自动持久化 |
| B | Wiki最少可查看/编辑/删除稳定条目，User/Character归属明确；已有数据向后兼容 |
| C | Recent+Memory Top-K+Wiki Top-K构成有预算Context，两个源分别超时/失败仍能回答 |
| D | Memory关闭禁止长期读写；RAG关闭禁止额外检索；在途禁用结果不注入/写回 |
| E | 固定聊天事实与获授权OCR事实可召回进入一次生产Runtime生成请求；物理attempt计数明确 |
| F | 真实Provider语义演示与现有Voice输入→Agent→Pet实机闭环单列；缺设备/凭证不伪造PASS |
| G | 复验MVP-05矩阵及必要全量回归，列出0.5 DoD通过/未测，未完成不得宣告冻结发布 |

报告llm/reports/MVP-06_ACCEPTANCE.md。真人声学质量仍按原INT-02数量单独验，不以一次demo替代。
