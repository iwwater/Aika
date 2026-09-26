# ADR-006：STT/TTS 流式语音管线

状态：Proposed  
日期：2026-09-23  
来源：[0.65 Provider 设计](../../next/0.65/PROVIDERS.md)、[插件开发规范](../../development/PLUGIN_DEVELOPMENT.md)

## Context

STT、TTS 可能同时存在 cloud batch、cloud streaming、local service 和 managed-local 等来源。它们的取消、分段、回压、播放和设备生命周期不同，不能通过一个“语音 Provider”布尔值掩盖差异。

## Proposed decision

STT 与 TTS 作为可独立启停的 capability package，通过版本化流式契约声明 chunk、终态、取消、错误和资源释放语义。语音 adapter 不拥有全局轮次、Memory 或角色写入权；输出阶段通过现有 Runtime/Scope 接入。

## Open questions

- chunk 顺序、重复和回压是否由宿主统一处理？
- 播放回执如何与 Trace 的音频阶段关联？
- 设备占用、权限撤销和服务停止的即时语义如何跨 Windows renderer 与本地 service 保持一致？

在这些问题冻结前，新增语音实现只能遵守版本 SPEC 中已经明确的契约，不能把本 ADR 当作完整实现授权。
