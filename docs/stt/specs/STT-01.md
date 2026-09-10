# STT-01 · 输入契约与识别适配

## 架构与接口依据

本 SPEC 必须实现 [模块架构与接口](../ARCHITECTURE.md) 中对应阶段的端口、事件、状态与错误语义；通过 adapter 兼容现有实现。下方 AC 同时验证这些契约，无需启动其他真实模块。

需求与边界见 [模块 PRD](../PRD.md)，依赖遵循 [共享契约](../../modules/CONTRACTS.md)。

交付 start/stop/cancel/dispose 生命周期，Whisper 自动语言与 Web Speech 可见降级；分段 ID、时间戳和来源精度。

| AC | 模块内验收 |
| --- | --- |
| STT-01-A | 假输入设备驱动重复启动/关闭/重开：无重复监听，dispose 后不产生有效事件 |
| STT-01-B | 固定 ASR 响应覆盖成功、空文本、超时、断开与取消；错误可见，下一段恢复，不要求真实 LLM/TTS |
| STT-01-C | Whisper 使用音频结束时间，Web Speech 估算明确标记；缺本地服务时降级信息与实际后端一致 |

只执行当前 SPEC 的本模块测试；其他模块使用 fake/mock。验收报告放 `../reports/STT-01_ACCEPTANCE.md`。全流程测试仅在必须联调或大任务完成时按 [集成 SPEC](../../integration/SPEC.md) 执行；真人设备后置项不自动恢复。
