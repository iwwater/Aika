# Voice Contract

状态：Active baseline；流式细节由 [ADR-006](../adr/ADR-006-streaming-voice-pipeline.md) Proposed。

STT 与 TTS 是独立 capability，不互相拥有对方的生命周期。具体 adapter 必须声明 batch/streaming、来源类型、取消、终态、错误、资源释放和设备需求。

## 边界

- STT 只产生受作用域约束的识别结果/分段，不直接写 Memory 或触发未经授权的外部动作。
- TTS 只消费已提交或明确允许播放的文本/音频段；播放回执属于输出阶段证据。
- 停止采集、撤销权限和取消当前轮必须即时生效；不以“重启后才停止”替代撤销。
- 云端、本地服务和 managed-local 的认证、资源所有权与费用字段分开表达。
- 缺失可选语音包返回 unavailable，不创建空 adapter 或伪造成功。

在流式 chunk、回压和播放回执尚未冻结前，版本 SPEC 的已冻结语义优先于本概览。
