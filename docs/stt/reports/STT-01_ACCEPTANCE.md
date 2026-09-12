# STT-01 验收报告 · 输入契约与识别适配（复核补证）

- 性质：**复核补证报告**（2026-09-13，goal worker）。原始实现早于本文，执行者自测记录缺失；本报告按当前 HEAD 实跑定向测试据实补证，不追认历史数字。
- SPEC：[STT-01](../specs/STT-01.md)。基线 commit：`eba6e3c`（当时 HEAD）。

## 命令与退出码（2026-09-13 实跑）

| 命令（aika-crossplatform 下） | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/services/voice src/domain/language.test.ts` | 118 passed | 0 |
| `npx vitest run src/services/voice/speechInput.conformance.test.ts src/services/voice/webSpeechInput.test.ts src/services/voice/whisperClient.test.ts src/presentation/voicePresenter.test.ts` | 49 passed（15+2+16+16） | 0 |

## 逐条 AC

| AC | 证据（生产+测试） | 结果 | 证据类型 |
| --- | --- | --- | --- |
| STT-01-A 生命周期 | `speechInput.conformance.ts` 用例包（web/whisper 两真实实现共用，15 用例含启停/取消/dispose）；`inputEngine.ts` 后端解析；`useVoiceConversation.integration.test.ts` 会话级启停 | PASS | production+fixture |
| STT-01-B 固定 ASR 响应 | `webSpeechInput.test.ts`、`whisperClient.test.ts`（16 例：成功/空文本/超时/断开/坏流；含 STT-04-G probe 双超时）+ 契约包错误路径；错误经事件上报可恢复 | PASS | production+fixture |
| STT-01-C 时间来源与降级 | `domain/voiceRuntime.ts` `VoiceTimeSource = "audio" \| "estimated"`（Whisper 音频结束时间 vs Web Speech 估算）；`outputEngine`/设置页降级声明；`whisperClient` 缺本地服务超时降级 | PASS（生产实现+测试在位） | production+fixture |

## 未测/边界

- 真实麦克风/真机声学：NOT RUN（归 STT-03 DEFERRED）。
- SPEC 全文审阅结论要求的「识别请求永不返回必须有界超时」负例：`whisperClient.test.ts` 超时用例覆盖。
- 本报告不含真实 LLM/TTS/设备；模块边界遵守测试规则。
