# TTS SPEC 执行索引

需求见 [模块 PRD](PRD.md)，一次下发一份独立 SPEC。

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [TTS-01](specs/TTS-01.md) | 分句与队列 | 已补证（2026-09-13 复核报告）：定向 54/118 测试全绿；「全失败不称成功」专测证据弱 |
| [TTS-02](specs/TTS-02.md) | 停止与交付状态 | 已补证（2026-09-13 复核报告）：输出契约 12 例+presenter 16 例全绿；真实音频 NOT RUN |
| [TTS-03](specs/TTS-03.md) | 音频验收（DEFERRED） | DEFERRED |

已有适配不等于新 SPEC 全部验收通过；设备与后置范围保持原状态。

## 历史登记（2026-09-11；现已拆TTS-04/05）

云端语音合成的实现已经进主线：`services/voice/cloudTtsOutput.ts`（OpenAI 兼容 `POST /audio/speech`）与 `services/voice/outputEngine.ts`（`auto / cloud-tts / system` 选择与降级），随 CORE-05-G 输出侧补齐一并落地，证据见 [CORE-05 验收报告](../core/reports/CORE-05_ACCEPTANCE.md)。**它目前没有用户入口**，下面两件事现分别由TTS-04与TTS-05承接：

- 设置页能选输出链路并填云端配置；`createOutputEngine` 返回的 `note` / `degraded` 必须一路送到界面——**点名要云端却配置不全时的降级要当错误显示**，悄悄降级的结果是用户以为新音色和语速已经生效。
- 一次真实云服务试听，验证音质、延迟与计费。当前全部证据走假 `HttpFetch`，真实云 TTS 是 NOT RUN。

## 2026-09-13 新增执行项

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [TTS-04](specs/TTS-04.md) | 云端输出设置与降级错误 | READY，仅本地实现 |
| [TTS-05](specs/TTS-05.md) | 真实云 TTS 试听 | 条件执行；真实服务NOT RUN |

当前执行按[安全计划](../GOAL_EXECUTION_PLAN.md)。早期无报告项状态为未核实/待补证，不认定未实现或通过；已有报告项仍待审阅。
