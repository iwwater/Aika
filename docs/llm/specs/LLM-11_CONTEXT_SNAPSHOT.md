# LLM-11 · 上下文装配快照

状态：READY（仅授权本地实现与自动验证；真实服务/人工 AC 未执行）。
需求来源：[v0.5 与增量需求](../../PRD_V0.5.md)；执行规则：[安全执行计划](../../GOAL_EXECUTION_PLAN.md)。

## 前置与范围

- 前置：LLM-06～10 自动审查；不等待 v0.5 Gateway。
- 修改范围：domain/trace.ts、装配结果诊断字段、companionRuntime、唯一 redactTraceEvent。源码根为 aika-crossplatform；优先复用现有端口，不为文档目录迁移源码。
- 非目标：本份范围外功能、发布、公网部署、真实账号操作。前置自动契约通过可开发；需要真实安全属性的集成不可由 fake 放行。

## 行为与接口

新增可选 context_snapshot；候选在裁剪前采集诊断，最终 retained 与 trimmed 同源，不从最终 context 猜被裁内容。带块顺序、预算四元数、历史计数、snippet 来源/保留状态/原因；估算明确标 estimated。instructionsBlocks 可选，缺失显示未知。

所有新增公共字段需在 CONTRACTS 登记版本、兼容 adapter 与消费者；持久化使用临时数据库验证升级与失败回退，不触碰用户库。

## 验收条件

| AC | 要求 |
| --- | --- |
| LLM-11-A | Trace开启时每个成功装配轮恰好一条；保留与裁掉的 fixture 均逐字段匹配 |
| LLM-11-B | includeText=false 时所有正文及敏感标题/路径经唯一脱敏点处理，订阅/落盘/导出一致，无原始 prompt/key |
| LLM-11-C | Trace 关闭不构造正文快照；sink 故障不阻断回复 |
| LLM-11-D | 旧事件回放与所有 kind 穷举消费者兼容；取消/装配失败不伪造快照 |

## 验证与交付

先读当前生产实现与既有测试，列出定向命令；测试必须走本模块生产实现，fake 只替代外部依赖。记录命令、退出码、逐 AC 证据、影响消费者、未执行的真实/人工项。逻辑测试不证明 UI 可用、真机或真实服务通过。
报告路径：../reports/LLM-11_ACCEPTANCE.md。仅所有可自动 AC 通过才能写 AUTO_PASS / 待人工验收；FAIL 不可改为 NOT RUN 来推进依赖。完整验收维持待人工；不自动提交或推送。


## 全文审阅：诊断结构与隐私

Trace开启且本轮成功装配时恰好一条snapshot（不是允许永远0条的“至多”）；快照在装配时观察裁剪，不能重新运行检索以重建诊断。diagnostics可选注入/惰性构建，Trace关时不生成诊断正文。Trace在构建期间被关闭也须在record前复核。

快照字段冻结为budget{inputLimit,outputReserve,safetyReserve,available,estimatedUsed}、requiredBlocks{name,estimatedTokens}、history{inputCount,normalizedCount,recentLimitDropped,budgetDropped,kept}、summary{state,estimatedTokens}、sections{memory,knowledge,environment}。snippet携带source、可空id/category/precision/temporal、ordinal、estimatedTokens、kept/trimmed、reason、content:string|null。ordinal只是诊断序号，不冒充Memory ID；precision包含proxy，不将unknown当confirmed。available=max(0,inputLimit-outputReserve-safetyReserve)，不是平台真实预算。

元信息自由文本（source/id/title/path）也可能携带敏感信息：用受控来源名/不透明ID，正文开关关闭时不复制自由文本至替代字段。复用唯一脱敏函数，密钥测试用canary；类型没有key字段不保证正文里没有key，不承诺识别任意未知秘密。设事件字节与snippet数量上限，截断明确记录counts/truncated，不能把截断清单叫全量。

旧kind穷举修改属于本份范围（TracePage摘要、traceView、pluginGraph等）；不是要求工作台一行不改。AC增加：关→开/开→关竞态、旧事件缺快照、超限截断、无id/proxy片段、被recentTurnLimit丢掉的历史分别验证，预算/Provider行为不变。
