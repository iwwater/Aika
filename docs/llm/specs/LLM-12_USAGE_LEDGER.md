# LLM-12 · Provider用量记录与成本数据端口

状态：已全文审阅，READY（本地实现）；未执行。前置LLM-10、LLM-04。需求：[F9成本页](../../frontend/specs/FE-26.md)，接口：[共享契约](../../modules/CONTRACTS.md)。

## 问题与范围

ProviderUsage已解析prompt/completion/total，但TraceTokens只保留estimatedPrompt/reportedTotal；现有数据不足以按输入输出定价，也不能覆盖物理重试与后台用途。修改domain用量类型、providerClient/adapter请求计量边界、Runtime与维护调用的用途传递、新用量store及token/组合根，补对应契约测试。不改变模型请求/重试策略，不调用真实服务，不在Provider层写价目表。

## 契约

UsageRecordV1{schemaVersion:1,id,logicalRequestId,attemptId,turnId?,scope?,purpose,providerId,protocol,model,startedAt,endedAt?,status,promptTokens:number|null,completionTokens:number|null,totalTokens:number|null,coverage:'reported'|'partial'|'unknown'}。purpose为foreground/maintenance/summary/proactive/unknown，由实际调用方赋值，不按字符串猜。每次物理请求独立attemptId，开始时登记、usage/终态按ID幂等upsert；计数为0与unknown分开。

缺末包usage/取消记unknown；确切已报一部分则partial，不能用估计补齐。只收到total时保留total，input/output仍null，不能拆分。重试/回退不同attempt分别记录；现有Provider接口聚合多尝试时必须在物理send边界取证，不能只记最终合并值。无scope的旧记录保持legacy/unknown，不混入新主体账本。

记录不含正文/密钥/完整URL，以稳定provider配置ID区分同模型不同endpoint。和Trace开关语义一致：采集关闭时不新写记录，关掉正文不影响纯数字；历史覆盖范围必须可见。写失败旁路化、队列有界、诊断可见，不阻塞或重试原模型请求。SQLite与浏览器临时存储都提供相同读写语义；query支持固定顺序及cursor分页，默认保留期限有明确设置/常量和截断提示。

## AC

| AC | 要求 |
| --- | --- |
| LLM-12-A | 四协议生产解析fixture通过，真实物理attempt与逻辑request不重复汇总；前台/维护/摘要/主动用途真实接线，未采集显式unknown |
| LLM-12-B | 取消/失败/重试/末包缺失/仅total/显式0分别验证，不能把未知算0或按比例拆分 |
| LLM-12-C | 持久upsert幂等、重启恢复、cursor翻页不丢不重；失败store不改变原请求次数与对话终态 |
| LLM-12-D | Trace关闭0新记录，secret canary不落库，scope隔离/旧记录分组/截断覆盖率如实可见 |

报告：../reports/LLM-12_ACCEPTANCE.md，逐AC记录实际命令、退出码、数据fixture和生产范围。真实计费仍NOT RUN，不冒充官方账单。按[执行计划](../../GOAL_EXECUTION_PLAN.md)只跑定向测试。
