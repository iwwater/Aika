# STT-02 验收报告 · 分段排序与回合提交（复核补证）

- 性质：**复核补证报告**（2026-09-13，goal worker）。原始实现早于本文、无执行者自测记录；按当前 HEAD 实跑定向测试据实补证。
- SPEC：[STT-02](../specs/STT-02.md)。基线 commit：`eba6e3c`。

## 命令与退出码（2026-09-13 实跑）

| 命令（aika-crossplatform 下） | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/domain/vadSegmenter.test.ts src/domain/turnEnd.test.ts src/domain/asrSegments.test.ts src/services/voice/speechInput.conformance.test.ts src/services/voice/webSpeechInput.test.ts src/services/voice/whisperClient.test.ts src/hooks/useVoiceConversation.integration.test.ts` | 76 passed | 0 |
| `npx vitest run src/presentation/voicePresenter.test.ts`（并入上面 49 例批次） | 16 passed | 0 |

## 实现落点（生产代码核实）

- 分段/回合管线在 `presentation/voicePresenter.ts`：`pendingAsr: Set<string>`（在途 ASR 集合，:200）、`inputEpoch` 旧会话失效（:313 起多处 epoch 比对）、提交门 `pendingAsr.size > 0` 不提交（:419/:427）、`sendNow()`（:121/:806）、`clearPending()`（:122）。
- 领域积木：`domain/vadSegmenter.ts`（VAD 切段/回补/回滞）、`domain/turnEnd.ts`（尾静音预算 `silenceBudgetMs`/`shouldSubmit`/`mergeFragment`）、`domain/asrSegments.ts`（乱序重排器）。均被 presenter/hooks/runtime 生产消费。

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| STT-02-A 虚拟时钟/一次提交 | `vadSegmenter.test.ts` 13 例（说完一次切一次 speech-end、句中短停顿不切段、段区间递增）；`turnEnd.test.ts`（空缓冲不提交、句中停顿 900ms 不提交、基准 1.2～1.5s、犹豫上限兜底）；presenter 提交门与 `pendingAsr` | PASS | production+fixture |
| STT-02-B 乱序/迟到合并 | `asrSegments.test.ts` 3 例（等缺失前段按原序释放、重复/迟到旧结果不再释放、打断后新一轮重新起算）；presenter `pendingAsr` 增删与门控 | PASS | production+fixture |
| STT-02-C 会话失效/立即发送/清空 | presenter `inputEpoch` 失效旧结果（含打断换 epoch）；`voicePresenter.test.ts` 4 处 `sendNow` 用例（:151/:198/:362/:403） | PASS（sendNow 有专测）；**clearPending 幂等性未见专测，证据弱** | production+fixture |

## 未测/边界

- `clearPending` 的显式幂等负例：证据弱（生产实现递增 epoch + `pendingAsr.clear()`，逻辑上幂等，但无专测断言）。后续如改此路径应补一例。
- 真实麦克风/真机：NOT RUN（STT-03 DEFERRED）。
- SPEC 审阅结论要求「ASR 失败也必须从 pending 集合移除并记录丢段」：presenter :352 `pendingAsr.delete(result.segmentId)` 在错误路径生效；丢段计数走 voiceDiagnostics，未逐例核对——如实标注。
