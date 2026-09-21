# STT-03 真人复验记录

> **2026-09-22 更新**：本地 Whisper（turbo）路径的真人量化验收已完成，见
> [STT-03_ACCEPTANCE_2026-09-22](STT-03_ACCEPTANCE_2026-09-22.md)（本文件保留的是 2026-09-13
> Web Speech 退路时期的排查历史，其中 NOT RUN 状态已被新报告部分取代）。

2026-09-13 用户明确恢复真人语音测试。宿主为当前 master 的 Tauri 开发版；系统 Web Speech 退路，本地 Whisper 未运行。当前不构成 STT-03 通过。

## 最新真人复验结论（2026-09-13）

修复提交 `3b7a097` 后，用户反馈：“真人完成了暂时没发现问题”。本次问题复验记为 **PASS（用户实测反馈，暂未发现问题）**，无需继续标成未复验。未提供测试轮数、固定台词或计时数据，不据此推定全部 STT-03 AC、声学延迟或设备恢复通过。下文排查过程中的 FAIL / NOT RUN 是当时记录，由本节更新现场复验结论。

## 本次错误记录与交接结论

基线提交：`b637c99`。本次记录及修复由用户要求提交到远端。

| 现场问题 | 当前结论 |
| --- | --- |
| 说完等待超过 20 秒 | 最新真人复验暂未发现问题；延迟根因及量化指标仍未确认 |
| 鼠标放在麦克风上一直转圈 | 已修正禁用按钮误用 wait 光标，证据见 FE-13 报告 |
| 没说完即被截停、提交 | 已补原生开口信号；用户完成修复后真人复验，暂未发现问题 |
| 连续三句以上后文字消失，像回退上一轮 | 已修复空 final 清文字、跨会话序号缺口及 final/interim 顺序；用户完成真人复验，暂未发现问题 |

排查不足：最初先修光标和开口信号，随后仅覆盖空 final；两次都未覆盖系统 stop 迟到结果及混合 result 回调，用户仍然复现丢字。测试曾通过不能证明现场恢复。后续应先采集脱敏事件时序并复现完整多轮回调，再判断根因；不要连续以单一候选路径的测试通过宣告问题解决。

交接：代码修复与本次用户真人复验已完成，暂未发现问题；完整规格量化验收仍未完成。未提交聊天数据库、凭证、录音或包含私人对话的截图。本次仅更新报告，不触发工程测试。

## 真人反馈与修复

- 用户报告说完等待超过 20 秒；延迟发生在文字出现前还是出现后尚未确认，未取得真实 speechEnd 时间，不能归因或写成通过。
- 用户随后报告尚未说完即被提交，截图显示部分日语输入已进入 thinking。此轮抢话反馈记为 FAIL；尚未完成固定 20 样本。
- 发现并通过测试复现一条可能导致该现象的生产路径：Web Speech 适配器只从 interim 文字产生 speechStart，未订阅原生 speechstart。上一段 final 后，即使用户重新开口，下一段文字尚未返回时 Presenter 仍会按上一段尾静音提交。
- 修复 `webSpeechInput.ts`：原生 speechstart 立即报告已有 SpeechStartEvent，仍保留 interim 作为不提供原生事件的宿主退路；onend 无结果时沿用空 final 释放该段。共享接口及停顿阈值不变。接口依据：[MDN speechstart](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/speechstart_event)。

## 回归证据

生产 Web Speech adapter + 生产 VoicePresenter，原生识别器、权限、时钟及输出替换为 fake；不调用模型，不冒充真实音频。

- 修复前：`npx --no-install vitest run src/services/voice/webSpeechInput.test.ts`，退出码 1；新增两项均失败。前一段已提交，且原生开口未转发。
- 修复后：`npx --no-install vitest run src/services/voice/webSpeechInput.test.ts src/presentation/voicePresenter.test.ts src/domain/turnEnd.test.ts`，退出码 0；3 文件、44 项通过。
- 验证下一段开口后 2500ms 无文字期间不提交，随后 final 到达并满足尾静音时，两段只提交一次；另验证开口但无结果的 onend 释放。
- `git diff --check` 退出码 0，仅工作区 LF/CRLF 提示。
- Vite 已报告识别适配器修改触发页面重载。修复后真人复验 NOT RUN；不承诺宿主原生事件必然及时，也不代表 20 秒延迟已经解决。

## AC 状态

### 再次反馈：文字仍然消失（并未退出语音页）

用户确认上一轮修复后仍丢文字。重新定位并复现两条不同路径：

1. stop 迟到 final 在旧 epoch 被丢弃，但 adapter 已递增序号。新会话的 final 被连续序号闸门等待，interim 却已清空。修复为非连续输入每次 start 重置排序起点为 null；连续 Whisper 的跨段乱序等待保持不变。四轮测试加入 stop 补发空 final，修复前第三轮预期已提交 3 次、实际仅 1 次。
2. 同一个 result 同时带旧 final 与新 interim 时，原实现先 interim 后 final，最终清掉新文字。改为先处理 final 再处理 interim。修复前事件顺序断言失败。

第一轮定向回归：11 文件，144 PASS、1 FAIL，失败在契约 fixture。该 fixture 原来把同一段的 interim 和 final 放在同一结果列表且 interim 在前；[MDN results](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionEvent/results) 规定 final 在前、interim 在后。修正 fixture 为同一段的两次回调，契约 AC 断言不变。

定向复验 `npx --no-install vitest run src/services/voice/speechInput.conformance.test.ts src/services/voice/webSpeechInput.test.ts src/presentation/voicePresenter.test.ts src/domain/asrSegments.test.ts`：退出码 0，4 文件 40 PASS。`git diff --check` 退出码 0。现场尚未采集原生事件时序，以上为生产代码可复现缺陷；修复后真人效果仍 NOT RUN，不能据此宣称现场已恢复。

### 追加反馈：多轮后临时文字消失

用户提供两张截图：第四段附近的「まあ」显示为识别中，随后消失、只剩上一轮回复。生产 adapter 在没有 final 的 onend 上发送空 final，Presenter 原先无条件清空 interim；已用生产 adapter + Presenter、fake 原生识别器及模型/输出连续三轮后复现第四轮文字消失。并非证明存在固定“三轮上限”。

修复：空 final 保留 interim，显示“未能确认，请重说”；重启识别不清提示，重说产生新 interim/final 后恢复。未确认文字期间暂停提交，避免只发送此前确认的半句。未把 interim 冒充最终识别结果；共享接口不变。尚未确认真实宿主缺少 final 的原因。

修复前定向测试退出码 1（预期「まあ」，实际为空）；修复后 `npx --no-install vitest run src/services/voice src/presentation/voicePresenter.test.ts src/domain/turnEnd.test.ts` 退出码 0，10 文件 141 项通过。后补验证第四轮已有确认前缀时，不因临时结果丢失而提交半句，重说后前缀合并并只提交一次。真人连续多轮复验 NOT RUN。

| AC | 状态 | 证据 / 待执行 |
| --- | --- | --- |
| STT-03-A | NOT RUN（完整固定样本验收） | 原现场抢话反馈已修复并完成用户复验，暂未发现问题；未取得中日英混说各 5 样本、停顿及提交次数证据 |
| STT-03-B | NOT RUN | 无真实 ASR 完成、尾静音及 turnReady 配对样本，不能计算 P95 |
| STT-03-C | NOT RUN | 权限拒绝、设备断开和恢复尚未测试 |

本次现场问题复验已结束；后续正式量化验收再安排固定样本。仅记录系统识别退路的现场结果；Whisper、完整打断、声学延迟和耳机/外放回声尚未验收。
