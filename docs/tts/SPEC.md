# TTS SPEC 执行索引

需求见 [模块 PRD](PRD.md)，一次下发一份独立 SPEC。

| SPEC | 交付 |
| --- | --- |
| [TTS-01](specs/TTS-01.md) | 分句与队列 |
| [TTS-02](specs/TTS-02.md) | 停止与交付状态 |
| [TTS-03](specs/TTS-03.md) | 音频验收（DEFERRED） |

已有适配不等于新 SPEC 全部验收通过；设备与后置范围保持原状态。

## 待下发（2026-09-11 登记，尚无 SPEC 编号）

云端语音合成的实现已经进主线：`services/voice/cloudTtsOutput.ts`（OpenAI 兼容 `POST /audio/speech`）与 `services/voice/outputEngine.ts`（`auto / cloud-tts / system` 选择与降级），随 CORE-05-G 输出侧补齐一并落地，证据见 [CORE-05 验收报告](../core/reports/CORE-05_ACCEPTANCE.md)。**它目前没有用户入口**，下面两件事需要一份 TTS SPEC 才能做：

- 设置页能选输出链路并填云端配置；`createOutputEngine` 返回的 `note` / `degraded` 必须一路送到界面——**点名要云端却配置不全时的降级要当错误显示**，悄悄降级的结果是用户以为新音色和语速已经生效。
- 一次真实云服务试听，验证音质、延迟与计费。当前全部证据走假 `HttpFetch`，真实云 TTS 是 NOT RUN。
