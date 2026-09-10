# TTS-03 · 音频验收（DEFERRED）

## 架构与接口依据

本 SPEC 必须实现 [模块架构与接口](../ARCHITECTURE.md) 中对应阶段的端口、事件、状态与错误语义；通过 adapter 兼容现有实现。下方 AC 同时验证这些契约，无需启动其他真实模块。

需求与边界见 [模块 PRD](../PRD.md)，依赖遵循 [共享契约](../../modules/CONTRACTS.md)。

用户恢复设备验收后，使用固定三语文本和实际输出后端，仅测 TTS 自身。

| AC | 模块内验收 |
| --- | --- |
| TTS-03-A | 15 句（三语各 5）均播放正确文本且顺序一致；逐条记录合成失败、音色和可懂度问题，不把统一音色愿景当已实现 |
| TTS-03-B | 10 次外部 stop 命令→真实音频停止 P95 ≤300ms；停止后不自恢复 |
| TTS-03-C | 记录 enqueue→firstAudio 的 P50/P95 与设备/后端；优化前冻结本模块目标，无实测不填 0ms |

用户开口检测、回声与 SpeechEnd→FirstAudio 属于集成，不是 TTS 小阶段门禁；声音训练和 Live2D 不在当前模块阶段。

只执行当前 SPEC 的本模块测试；其他模块使用 fake/mock。验收报告放 `../reports/TTS-03_ACCEPTANCE.md`。全流程测试仅在必须联调或大任务完成时按 [集成 SPEC](../../integration/SPEC.md) 执行；真人设备后置项不自动恢复。
