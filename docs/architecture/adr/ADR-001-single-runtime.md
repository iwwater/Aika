# ADR-001：保持单一 Runtime 与 Dialogue Pipeline 权威

状态：Accepted  
日期：2026-09-23  
来源：[总路线图](../../next/RPD_ROADMAP.md)、[0.65 契约](../../next/0.65/CONTRACTS.md)

## Context

Aika Next 需要扩展 Provider、Memory、Continuity、桌宠和能力包。如果每个模块再创建一套轮次、取消、Context 或对话 Runtime，会造成迟到结果、记忆提交和权限失效的多重权威。

## Decision

沿用现有 Runtime/Pipeline 作为唯一的轮次、作用域、取消、Context 组装和对话调用权威。新能力通过公开端口、adapter 或 capability 接入，不复制第二套对话 Runtime。

## Consequences

- 新模块必须明确消费或提供哪个公共契约。
- UI、Provider 和实验 harness 不能自行提交正式 Memory 或生成伪造的对话成功状态。
- 如果上游缺少扩展点，先用契约测试证明缺口，再做最小适配。
- 结构重构可以改变目录，但不能改变唯一轮次和终态语义。
