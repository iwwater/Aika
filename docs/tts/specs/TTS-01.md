# TTS-01 · 分句与队列

## 架构与接口依据

本 SPEC 必须实现 [模块架构与接口](../ARCHITECTURE.md) 中对应阶段的端口、事件、状态与错误语义；通过 adapter 兼容现有实现。下方 AC 同时验证这些契约，无需启动其他真实模块。

需求与边界见 [模块 PRD](../PRD.md)，依赖遵循 [共享契约](../../modules/CONTRACTS.md)。

交付 sentenceId/turnId、逐句语言/风格、队列顺序、started/completed/drained/error 事件。

| AC | 模块内验收 |
| --- | --- |
| TTS-01-A | 固定分片文本覆盖标点、空串、三语与混说，首个完整句可提前入队，尾句不丢，无重复分句 |
| TTS-01-B | 假引擎以不同时序完成合成/播放，句序一致，只在队列确实清空时发 drained |
| TTS-01-C | 单句合成失败可跳过并上报，后续句可继续；全失败不得宣称交付成功 |

只执行当前 SPEC 的本模块测试；其他模块使用 fake/mock。验收报告放 `../reports/TTS-01_ACCEPTANCE.md`。全流程测试仅在必须联调或大任务完成时按 [集成 SPEC](../../integration/SPEC.md) 执行；真人设备后置项不自动恢复。

## 全文审阅结论

规范可执行；B的“清空”须同时满足endTurn、队列空、无在途合成/播放；追加流尚未结束时的暂时空队列不能drained。C的跳过失败句保留error计数和交付unknown/interrupted，drained不代表每句都已听到。重复sentenceId幂等按架构测试。
