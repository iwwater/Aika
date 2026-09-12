# FE-13 验收报告 · 语音页露出识别语言并允许改掉

日期：2026-09-12
范围：[FE-13](../specs/FE-13.md)。不含 confidence 自动退回、不含混说识别、不含把指定持久化。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/presentation/voicePresenter.ts` | 快照加 `language` / `languagePinned`；新增 `setLanguage()`（pin + 立刻 abort 重开）；`close()` 清掉 pin；`startRecognition` 在 pin 时不再调推导 |
| `src/presentation/voicePresenter.test.ts` | 新增 4 条（共 16）；fake 输入引擎新增 `languages` 记录每次 `start` 收到的语言码 |
| `src/hooks/useVoiceConversation.ts` | 转发 `setLanguage` |
| `src/components/VoiceModal.tsx` | 新增语言按钮与 `LANGUAGE_LABELS` |
| `src/App.tsx` | `NEXT_LANGUAGE` 循环顺序，接上 `onCycleLanguage` |
| `src/App.css` | `.voice-language` 一段 |

未新增端口，`VoiceInputLanguage` 未变，存储与共享契约无改动。

## 测试证据

```
npx tsc --noEmit                                        → 退出码 0
npx vitest run src/presentation/voicePresenter.test.ts  → 16 通过（原 12）
```

### 突变验证

逐条改坏生产代码 → 跑定向测试 → 还原：

| 突变 | 结果 |
| --- | --- |
| `setLanguage` 不置 pin | 命中，2 failed |
| `startRecognition` 无视 pin，照旧用推导 | 命中，2 failed |
| `setLanguage` 不重开识别（等下一段自然结束） | 命中，2 failed |
| `close()` 不清掉 pin | 命中，1 failed |
| 快照不带 `language`（写死 ja-JP） | 命中，1 failed |

五处全部命中并已还原。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| FE-13-A 快照带真实语言并显示 | PASS | 「快照里带着这一段实际用的语言」：推导给 `en-US`，fake 引擎收到的就是 `en-US`，`languagePinned` 初始 false；浏览器实跑见下 |
| FE-13-B 点一下立刻生效且不被推翻 | PASS | 「点一下就换，不等下一段自然结束」（`aborts` 为 1，下一段 `start` 收到 `ja-JP`）；「指定过之后不再让推导推翻它」（`resolveLanguage` 调用次数不再增长） |
| FE-13-C 退出后指定失效 | PASS | 「退出语音页后指定失效，下次仍然自动跟随」 |
| FE-13-D 页面只转发 | PASS | `VoiceModal` 里只有 `LANGUAGE_LABELS` 与一个 `onCycleLanguage` 回调，当前语言与 pin 状态都来自快照；循环顺序在 `App.tsx` 的 `NEXT_LANGUAGE` |

## 浏览器实跑

`npm run dev` + 无头浏览器，零 console 报错。

**第一次打开就复现了用户报的那个状态**：控件显示「当前按 **英语** 识别 · 自动跟随 · 听错了点一下换」——这台机器的历史里有过纯拉丁的识别结果，判定就停在 `en-US` 上，正是用户说日语被识别成英文的那个闩。

连点四次的读数：

```
当前按 英语 识别 / 自动跟随 · 听错了点一下换
当前按 日语 识别 / 已手动指定 · 点一下换
当前按 中文 识别 / 已手动指定 · 点一下换
当前按 英语 识别 / 已手动指定 · 点一下换
当前按 日语 识别 / 已手动指定 · 点一下换
```

截图：[FE_13_VOICE_LANGUAGE.png](evidence/FE_13_VOICE_LANGUAGE.png)

顺带量到的一个数（属 [STT-04](../../stt/specs/STT-04.md) AC-G 的改动效果）：**点「实时语音」到标题变成「我在听…」是 140ms**。改之前那里要等 whisper 探活失败，实测 1766～2023ms，用户在那段时间里说的话没人听。

## 待联调项与未覆盖范围

- **NOT RUN：真人发音与真机麦克风**。控件本身在浏览器里验过，但「说日语点成日语之后是否真的认对了」需要真人样本，属 [STT-03](../../stt/specs/STT-03.md) 的 DEFERRED 范围。
- **桌面 Tauri 未验**。WebView2 的 Web Speech 支持情况与 Chrome 不同，可能连 `isAvailable()` 都是 false；那时这个控件没有意义但也不会出错。留 INT-01。
- **confidence 自动退回没做**。这是更好的方案（用户不必注意到就能自己纠正），但要真机 confidence 分布才能定阈值。
- **根治仍是本地 whisper**：`language: "auto"` 之下整个闩不存在，这个控件也就不需要了。本机 `http://127.0.0.1:8080` 实测连不上。
