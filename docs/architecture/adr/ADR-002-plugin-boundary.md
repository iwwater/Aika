# ADR-002：能力包与插件边界

状态：Accepted  
日期：2026-09-23  
来源：[0.65 RPD](../../next/0.65/RPD.md)、[0.65 契约](../../next/0.65/CONTRACTS.md)

## Context

LLM、TTS、STT 和未来的 OCR/VLM 需要可替换、按需加载，并且不能把所有引擎和模型依赖强行装进普通产品包。

## Decision

采用“独立内核 + 普通产品包 + 可按需导入的能力包”。内置包与导入包使用同一公开契约；Capability、Adapter、SourceInstance、ModelProfile、Binding 分层；只初始化所选来源及其依赖闭包。

## Consequences

- 插件不能访问宿主私有对象，也不能复制宿主的轮次和生命周期。
- 管理端分别表达 installed、enabled、loaded、ready、failed 和 pendingRestart。
- 版本更新以重启边界切换，不能把 ESM 模块仍在缓存中说成“已完全卸载”。
- 插件市场和不受信任代码沙箱不属于当前能力包契约的默认承诺。
