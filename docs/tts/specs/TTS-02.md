# TTS-02 · 停止与交付状态

需求与边界见 [模块 PRD](../PRD.md)，依赖遵循 [共享契约](../../modules/CONTRACTS.md)。

交付幂等 stop(turnId)、旧 generation 屏蔽、语言和风格白名单、进度精度标注。

| AC | 模块内验收 |
| --- | --- |
| TTS-02-A | 播放/合成中停止后注入迟到 chunk/onEnd，旧音频不重新播放；新 turn 可正常排队 |
| TTS-02-B | 重复 stop、dispose 后回调不产生成功完成；停止请求与真实停止事件不混淆 |
| TTS-02-C | 无实际音频测量时 started/stopped 标 proxy；未知语气回退默认，未知语言后端明确降级 |

只执行当前 SPEC 的本模块测试；其他模块使用 fake/mock。验收报告放 `../reports/TTS-02_ACCEPTANCE.md`。全流程测试仅在必须联调或大任务完成时按 [集成 SPEC](../../integration/SPEC.md) 执行；真人设备后置项不自动恢复。
