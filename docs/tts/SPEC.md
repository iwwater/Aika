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
| [TTS-04](specs/TTS-04.md) | 云端输出设置与降级错误 | AUTO_PASS（2026-09-13）：A~D 可自动 AC 全过，233 测试回归全绿；真实试听属 TTS-05。见[验收报告](reports/TTS-04_ACCEPTANCE.md) |
| [TTS-05](specs/TTS-05.md) | 真实云 TTS 试听 | 条件执行；真实服务NOT RUN |
| [TTS-06](specs/TTS-06.md) | 本地声线 sidecar（GPT-SoVITS，P1） | **PASS（2026-09-20 F 真机联调完成）**：首句冷中位 **1066 ms < 1500 ms**；守门 0/18 触发；断开后无残留；ASR 回转写初筛无词级重复（CER 中位 0.000），人工听音待用户。真机暴露并修复 latin-1 响应头崩溃（新增回归测试，17/17）；`x-aika-style` 契约改为 percent-encoded。显存：sidecar 净增约 1.9 GB。见[验收报告](reports/TTS-06_ACCEPTANCE.md) F 节 |
| [TTS-07](specs/TTS-07.md) | 本地声线应用接入与端到端真机验收（P2/P3） | **冻结（2026-09-20）：触碰前端，等合作者重构 aika-crossplatform 落地**（见 docs/DEV_TASKS_VOICE.md 协作约束）。SPEC 中的文件级路径届时须先对照重构后代码复核。另：短句播放时长可能小于单句合成延迟（实测最慢 1965 ms），speechQueue 分句粒度需考虑短句合并预取 |

当前执行按[安全计划](../GOAL_EXECUTION_PLAN.md)。早期无报告项状态为未核实/待补证，不认定未实现或通过；已有报告项仍待审阅。

## 2026-09-21 代码优化规格

| SPEC | 交付 | 状态 |
| --- | --- | --- |
| [TTS-08](specs/TTS-08.md) | 独立语音 Demo 网关职责拆分与保行为验证 | 已实施；[报告](reports/TTS-08_ACCEPTANCE.md)记录54测试与浏览器9/9；真实 CLI 启动已于 2026-09-22 生产冒烟补证（页面哈希==基线、真实 STT 经 turbo 转写、用户会话文件未动）；真人设备/听音仍 NOT RUN |

四SPEC复核与剩余项见[接续清单](../ser/reports/OPTIMIZATION_REVIEW_20260921.md)。TTS-08 不替代 TTS-07，不解除其冻结，也不代表 TTS-06-F 听音或播放延迟已验收。
