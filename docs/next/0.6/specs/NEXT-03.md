# NEXT-03 · 多 Provider 适配

状态：NOT RUN。需求：N06-R04。前置：NEXT-01、02。

## 边界与接口

实现/复用 OpenAI-compatible 和 Gemini 的 DialogueAdapter。DeepSeek 用兼容协议配置覆盖。只改适配器、注册/选择和必要配置；禁止为 Provider 重写 DialoguePipeline、Memory 或 Voice。Anthropic 独立协议不在范围。

## TDD 步骤

复用 Legacy providerClient/provider conformance 的协议 fixture，先写上游契约下失败测试；测试成功流、分片截断、非 2xx、非法 JSON、空回复、超时、取消和旧轮迟到。实现最小 adapter，再按相同契约验证两个协议。

## AC

| ID | 验收 |
| --- | --- |
| 03-A | 两个协议通过同一行为契约；兼容配置中的 endpoint/model 确实用于请求 |
| 03-B | UTF-8/协议事件任意分片重组不丢/不重复文本，正常终态一次 |
| 03-C | AbortSignal 能传播，迟到片段不对外生效；错误类别清晰可恢复，无无限重试 |
| 03-D | 替换 Provider 仅改变配置/adapter 装配，流水线实现无 Provider 专属分支 |
| 03-E | 请求/日志不泄漏 Key，HTTP fixture 断言必要 header/body 但证据脱敏 |
| 03-F | 至少一条现有真实 Provider 固定样本回放通过或明确 BLOCKED；其它协议只经 fixture 的事实单列，不冒称全模型实测 |

运行两协议契约及受影响配置/Context 消费测试，不要求每个模型都联网。真实必需路径可在 NEXT-08 复核，但其缺失不能最终被忽略。
