# ADR-005：Console、Desktop Bridge 与表现层边界

状态：Accepted  
日期：2026-09-23  
来源：[0.75 源码核对](../../next/0.75/SOURCE_AUDIT.md)、[0.79 报告](../../next/0.79/reports/N079-02.md)

## Context

管理控制台、桌宠窗口、Electron preload/bridge 和 Live2D renderer 都需要读写状态。若每个界面直接持有 Provider、Memory 或表现资源，会产生鉴权绕过、状态竞争和重复生命周期。

## Decision

- Management API 是配置、诊断、记忆管理和运行状态投影的入口。
- Console 只持有草稿与视图状态，通过同源、鉴权的 API 操作管理能力。
- Desktop Bridge 只暴露白名单能力；桌宠 renderer 继续拥有 Live2D、尺寸、显示和表现生命周期。
- UI 不直接写数据库、不拼接密钥到 URL、不把空对象或 `loaded: false` 常量当作 live runtime 真相。

## Consequences

- 页面重写必须复用既有鉴权 epoch、请求序号、版本冲突和草稿保留语义。
- 新页面先确认实际 API/Bridge 和错误状态，再进行视觉调整。
- UI fixture 只能证明呈现逻辑，不能替代真实管理服务或生产接线证据。
