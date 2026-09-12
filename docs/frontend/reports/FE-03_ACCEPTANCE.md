# FE-03 验收报告 · 语音状态与字幕显示（复核补证）

- 性质：**复核补证报告**（2026-09-13，goal worker）。原始实现早于本文、无执行者自测记录；按当前 HEAD 实跑定向测试据实补证。
- SPEC：[FE-03](../specs/FE-03.md)。基线 commit：`191b89f`。

## 命令与退出码（2026-09-13 实跑，aika-crossplatform 下）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/hooks src/presentation src/domain/conversation.test.ts src/domain/captionHighlight.test.ts` | 10 文件 / 143 passed | 0 |
| `npx vitest run src/services/voice src/domain/language.test.ts`（更宽范围） | 118 passed | 0 |

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| FE-03-A fake STT 事件更新字幕、立即发送/清空只调一次 | `presentation/voicePresenter.test.ts` 16 例（fake STT → 字幕状态；`sendNow` 4 处专测各只触发一次提交）；`domain/captionHighlight.test.ts` | PASS（状态层） | production+fixture |
| FE-03-B fake TTS 逐句高亮、取消清理 | `voicePresenter.test.ts`「点朗读：按句入队，高亮落在正在念的那句，念完自动清空」「同一条再点一次＝停止」；`captionHighlight` 高亮区间 | PASS（状态层） | production+fixture |
| FE-03-C 三种降级可见仍可文字聊天 | `services/voice/outputEngine.test.ts` 9 例降级标注（点名云端未配置必须标降级）+ presenter 降级状态；文字聊天路径 FE-01-B 同源用例 | PASS（状态层） | production+fixture |

## 未测/边界

- SPEC 证据要求「组件测试、浏览器操作记录和截图」：**浏览器操作记录与截图 NOT RUN**（归 INT-01 人工队列）；本报告只覆盖状态层。
- 真实麦克风/TTS 声学：NOT RUN（STT-03/TTS-03 DEFERRED）。
