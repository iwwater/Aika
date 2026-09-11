# FE-07 点击朗读 — 验收报告

日期：2026-09-12
范围：`VoicePresenter` 两个命令 + 一个快照字段、按行映射高亮的 domain 纯函数、气泡正文与操作行。不新增音频逻辑、不改 TTS 契约。

## 需求

[规划文档](../../PLAN_DEV_DEBUG_WORKBENCH.md) F1 的「点击发音」。SPEC 与边界见 [FE-07](../specs/FE-07.md)。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/captionHighlight.ts` | 新增 `splitCaptionLines(text, range)`：按行切开并把高亮换算到行内坐标。气泡是按行渲染的（每行一个 flex 子元素），而 `range` 是整段文本的下标——不换算就会亮在别的行上。跨行的句子只亮它在本行的那一截。 |
| `src/presentation/voicePresenter.ts` | 契约新增 `speakMessage(messageId, text)`、`stopSpeaking()`；`VoiceViewModel` 新增 `speakingMessageId`。朗读复用既有 `SpeechQueue.speak()` 与当前装配的输出引擎，逐句 `locateSentence` 推进高亮（定位失败就不亮）；`clearBubblePlayback()` 只清聊天页朗读的状态，不动语音会话的字幕状态。 |
| `src/hooks/useVoiceConversation.ts` | 转发两个命令（69 行，仍在 architecture 门禁 150 行内）。 |
| `src/components/MessageBody.tsx` | 新增。气泡正文按 `splitCaptionLines` 的结果渲染，正在念的那句包一层 `<mark class="speaking">`；组件本身没有判断逻辑。 |
| `src/components/MessageActions.tsx` | 加「朗读 / 停止」入口：只对她说的话出现（用户自己那句不需要读回来，失败气泡没什么可念的），语音会话开着时不出现。 |
| `src/App.tsx` | 正文换成 `<MessageBody … range={voice.speakingMessageId === message.id ? voice.speakingRange : null} />`；朗读回调派发 `voice.speakMessage`。 |
| `src/App.css` | 新增 `mark.speaking` 一条。 |
| `src/domain/captionHighlight.test.ts` | 新增 `splitCaptionLines` 4 条。 |
| `src/presentation/voicePresenter.test.ts` | 新增朗读 describe 6 条；既有 fake 输出引擎补 `texts()` 与 `failAt()` 两个观测口（原来只有 `stopCount` 与 `drain`）。 |

## 两条边界的取舍（写进 SPEC 与代码注释）

1. **语音会话开着时不接朗读请求**：机器只有一套嗓子，输出队列也只有一个。会话进行中点气泡会 `queue.begin` 掉正在播的那一轮，让那一轮的交付回执永远等不到（只能靠 `armDeliveryTimer` 超时兜底）。所以会话开着时说话权归会话，入口也隐藏。
2. **同一条再点一次＝停止**：用户第二次点同一条的意思只可能是「别念了」。

## 测试证据

命令（cwd = `aika-crossplatform`）：

```
npx vitest run src/domain/captionHighlight.test.ts src/presentation/voicePresenter.test.ts
```

退出码 0：captionHighlight 14 passed（新增 4），voicePresenter 9 passed（新增 6）。

定向回归：

```
npx vitest run src/domain src/presentation src/hooks src/services/voice \
  src/services/storage src/kernel/architecture.test.ts src/app
→ 退出码 0，Test Files 47 passed (47)，Tests 589 passed (589)
npx tsc --noEmit → 退出码 0
```

突变验证：

| 突变 | 结果 |
| --- | --- |
| 去掉 `if (isOpen) return`（会话开着也接朗读） | 1 failed —— 「语音会话开着时不接朗读：说话权归会话」 |
| 去掉「同一条再点＝停止」的切换 | 1 failed —— 「同一条再点一次＝停止：引擎收到 stop，状态清空，不重头念」 |
| `onDrained` 里不清状态 | 1 failed —— 「念完整段：状态与高亮都清空，不留一条永远亮着的消息」 |

三处均已还原，`grep -rn MUTANT src/` 无命中，复跑 9 passed。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| FE-07-A 按句入队、`speakingMessageId` 指向这一条、念完清空 | PASS | 「点朗读」用例：`texts()` 逐句推进为 `["おかえり。"]` → `["おかえり。","今日はどうだった？"]`；「念完整段」用例断言两个字段都回到 null |
| FE-07-B 高亮逐句推进；定位失败不亮；停止后清空 | PASS | 「点朗读」用例用 `locateSentence` 自身的结果比对（不硬编码下标）；`splitCaptionLines` 的 `range: null` 用例；停止用例断言 `speakingRange` 为 null |
| FE-07-C 同一条再点＝停止 | PASS | 「同一条再点一次」用例：stop 计数 +1（基线不是 0，`queue.speak` 自带的 begin 会先 stop 上一轮——已在用例注释里写明）、没有新句子入队 |
| FE-07-D 会话开着时被拒；单句失败可见但不打断 | PASS | 「语音会话开着时不接朗读」；「单句合成失败」用例：`error` 含引擎消息，且第二句仍然入队 |
| FE-07-E 按行映射是 domain 纯函数并单测覆盖 | PASS | `splitCaptionLines` 4 条：只亮所在行、null 原样返回、跨行只亮本行那一截、单行与 `splitCaption` 一致 |

## 共享接口影响

- `VoicePresenter` 新增两个命令，`VoiceViewModel` 新增 `speakingMessageId`（新增字段，既有字段语义未变）。实现只有一个。
- 未改 `SpeechOutputEngine` / `SpeechQueue` / `CompanionRuntime` / 存储契约，未新增 kernel token。
- `domain/captionHighlight` 新增导出 `splitCaptionLines`，`splitCaption` 未改。

## 待联调项与未覆盖范围

- NOT RUN：真实声音与真机目视。fake 输出引擎只能证明「句子按什么顺序交给引擎、状态与高亮怎么变」，证明不了音色、语速与真实播放体验——那属 INT-03。
- 已知边界（未做）：朗读不写 `TurnTrace`、不计入成本账本（那要等 F3）；不支持连播多条；朗读期间切换输出引擎设置不会热切当前这一段；Live2D 口型不在范围内（后置规则仍有效）。
