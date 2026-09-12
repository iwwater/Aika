# TTS-02 验收报告 · 停止与交付状态（复核补证）

- 性质：**复核补证报告**（2026-09-13，goal worker）。原始实现早于本文、无执行者自测记录；按当前 HEAD 实跑定向测试据实补证。
- SPEC：[TTS-02](../specs/TTS-02.md)。基线 commit：`eba6e3c`。

## 命令与退出码（2026-09-13 实跑）

| 命令（aika-crossplatform 下） | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/services/voice/speechOutput.conformance.test.ts` | 12 passed（web+cloud 两实现共用契约包，含 stop 探针） | 0 |
| `npx vitest run src/domain/sentences.test.ts src/services/voice/speechQueue.test.ts src/services/voice/outputEngine.test.ts src/services/voice/webSpeechOutput.test.ts` | 54 passed | 0 |
| `npx vitest run src/presentation/voicePresenter.test.ts` | 16 passed | 0 |

## 实现落点（生产代码核实）

- 停止语义归属验证在队列/Presenter adapter 层（底层 `SpeechOutputEngine.stop` 无 turnId，按 SPEC 审阅结论）：`presentation/voicePresenter.ts` 停止即换 epoch 并清状态；`services/voice/speechOutput.conformance.ts` 用例包含 `stopCalls` 探针与迟到 chunk/onEnd 不重播断言。
- 交付状态/降级：`services/voice/outputEngine.ts`（auto/cloud-tts/system 选择，`note`/`degraded` 随结果返回）。

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| TTS-02-A 停止后旧音频不重播/新 turn 可排队 | `speechOutput.conformance.test.ts` 12 例（stop 探针、停止后迟到事件不产生有效播放）；`voicePresenter.test.ts`「同一条再点一次＝停止：引擎收到 stop，状态清空，不重头念」 | PASS | production+fixture |
| TTS-02-B 重复 stop/dispose 不产生成功完成 | 契约包 dispose/stop 路径断言在位；**重复 dispose 幂等专测未逐例核对，证据弱** | PASS（部分）/ 证据弱项如实标注 | production+fixture |
| TTS-02-C 状态标注与降级 | `outputEngine.test.ts` 9 例：默认系统合成、点名云端未配置必须标降级、auto 安静回退不算降级、isAvailable 随配置；未知语气/语言回退默认走 speakable/队列「语气」组 | PASS | production+fixture |

## 未测/边界

- 真实音频/真机：NOT RUN（TTS-03 DEFERRED）。
- 真实云 TTS 试听：NOT RUN（TTS-05 条件执行，禁止空集通过）。
- 「无实测音频时 started/stopped 标 proxy」：`voiceRuntime.ts` `PlaybackStatus = "unknown" \| "played"` 在位，消费于 presenter；未逐例断言。
