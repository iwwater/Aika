# TTS-01 验收报告 · 分句与队列（复核补证）

- 性质：**复核补证报告**（2026-09-13，goal worker）。原始实现早于本文、无执行者自测记录；按当前 HEAD 实跑定向测试据实补证。
- SPEC：[TTS-01](../specs/TTS-01.md)。基线 commit：`eba6e3c`。

## 命令与退出码（2026-09-13 实跑）

| 命令（aika-crossplatform 下） | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/domain/sentences.test.ts src/services/voice/speechQueue.test.ts src/services/voice/outputEngine.test.ts src/services/voice/webSpeechOutput.test.ts` | 54 passed | 0 |
| `npx vitest run src/services/voice src/domain/language.test.ts`（更宽范围） | 118 passed | 0 |

## 实现落点（生产代码核实）

- 分句：`domain/sentences.ts`（句末标点/混说分语言/短片段并回/过长无标点按读点再切）。
- 队列：`services/voice/speechQueue.ts`（流式入队、句序、预取下一句、基线语速）；`speechQueue.test.ts` describe：createSpeechQueue / 流式入队 / 语气 / 预取下一句 / 基线语速。

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| TTS-01-A 固定分片覆盖 | `sentences.test.ts` 8 例：句末标点切分、连续终止符+右引号归属、混说按语言落句、太短片段并回、小数不切、换行分句、去 Markdown、过长段在读点再切（首句早开口） | PASS | production+fixture |
| TTS-01-A 首句提前/尾句不丢/无重复 | `speechQueue.test.ts` 流式入队 + 预取下一句用例组（首句提前入队、预取不重复） | PASS | production+fixture |
| TTS-01-B 异序完成句序一致 | `speechQueue.test.ts` 顺序与预取用例（假引擎完成顺序与句序解耦）；仅真清空才 drained | PASS | production+fixture |
| TTS-01-C 单句失败跳过/全失败不称成功 | speechQueue 用例包含失败跳过路径（createSpeechQueue 组）；**「全失败不得宣称成功」专测未逐例核对，证据弱** | PASS（部分）/ 证据弱项如实标注 | production+fixture |

## 未测/边界

- 真实音频播放/音质：NOT RUN（TTS-03 DEFERRED）。
- 真实云 TTS：NOT RUN（TTS-05 条件执行）。
