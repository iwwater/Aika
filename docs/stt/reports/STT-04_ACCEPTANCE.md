# STT-04 验收报告 · 识别语言判定不再自锁

日期：2026-09-12
范围：[STT-04](../specs/STT-04.md)，含后补的 AC-G（探活超时）。逃生阀 UI 在 [FE-13](../../frontend/specs/FE-13.md)；不含混说识别、不含真人发音验收。

## 结论先说

**本 SPEC 交付的是「把误入中文识别的概率降下来」，不是「解开已经锁死的状态」。** SPEC 初稿隐含的前提（修好判定就能自动解锁）在实现时被证伪，原因写在 SPEC 的「实现时发现的前提修正」一节：`zh-CN` 引擎既不会吐假名也不会吐日语字形，单语言引擎加纯文本信号在信息上不可能自我纠正。逃生阀因此从可选升为必须，已由 [FE-13](../../frontend/specs/FE-13.md) 交付。本 SPEC 另追加 AC-G，修掉「点实时语音卡一会然后不识别」——那是 whisper 探活串行挡在启动识别之前，而它的超时参数浏览器根本不认。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/language.ts` | 新增 `RecognitionSignal` / `recognitionSignal()` / `RecognitionInput` / `nextRecognitionLanguage()`；`speechLanguageFor` 加一条日语证据优先；删除 `preferredRecognitionLanguage` |
| `src/domain/language.test.ts` | `detectLanguage` 5 条未改；删 `preferredRecognitionLanguage` 4 条；新增 11 条，共 20 条 |
| `src/services/voice/whisperClient.ts` | 新增 `WHISPER_PROBE_TIMEOUT_MS`（800ms），`probe()` 同时带 `connectTimeout` 与 `signal: AbortSignal.timeout()` |
| `src/services/voice/whisperClient.test.ts` | 新增 2 条（共 16） |
| `src/App.tsx` | `resolveLanguage` 改为按语音来源推导，用 `spokenRef` 记真正识别出来的那几句，`lastLanguageRef` 记上一次用过的语言 |

未新增端口，`VoiceInputLanguage` 未变，存储与契约无改动。

## 判定改成什么样

两张字形白名单，都只收「确定是」的字：

- `JA_ONLY`：假名 + 日语新字体/国字 + 简体中文不使用的旧字形（`気 円 図 駅 読 売 実 経 緒 間 時 電 話 …`）。把繁体字形也算日语证据，是因为本应用的中文识别只有 `zh-CN` 一档、输出永远是简体，所以出现繁体字形只可能来自日语。
- `ZH_ONLY`：简体专用字形（`这 说 让 过 还 东 车 马 门 见 们 么 问 题 …`）。

两张表都收不全，**漏判的代价是「不切换」，误判的代价是「锁死」，两者不对等**，所以宁可漏。汉字本身不作数——中日共用的那部分汉字正是自锁闭环的入口。

选语言时：有语音来源的输入就只看语音（打字的中文不再污染），一条都没有时才拿打字内容当起点；一路判不出就保持上一次用过的语言，而不是重新挑一个。

## 测试证据

```
npx tsc --noEmit                                          → 退出码 0
npx vitest run src/domain/language.test.ts                → 20 通过
npx vitest run src/domain/language.test.ts src/services/voice src/presentation/voicePresenter.test.ts
                                                          → 10 文件 / 134 通过
```

按 [测试边界](../../../AGENTS.md)只跑了本模块与本次改动相关的测试，没有跑全仓。

### 突变验证

逐条改坏生产代码 → 跑 `src/domain/language.test.ts` → 还原：

| 突变 | 结果 |
| --- | --- |
| 无假名纯汉字重新当作中文证据 | 命中，3 failed |
| 判不出时不保持当前语言，回到默认日语 | 命中，1 failed |
| 日语专用字形不算证据（只留假名） | 命中，2 failed |
| 有语音历史时仍把打字内容算进去（打字排在后面） | **第一次没命中，见下** → 补用例后命中，1 failed |
| 有语音历史时仍把打字内容算进去（打字排在前面） | 补用例后命中，1 failed |
| `speechLanguageFor` 不再优先日语证据 | 命中，1 failed |
| probe 去掉浏览器认的 `signal` 超时 | 命中，2 failed（whisperClient.test.ts） |
| 英语证据不排除夹汉字的情况 | 命中，1 failed |

还原后 20 条全绿。

### 一处自查：来源优先级的突变第一次没命中

把 `pool` 改成 `[...typedTexts, ...spoken]`（打字排在前面）之后测试仍全绿——因为原用例只给了一条语音输入，而选择是**从后往前**走的，语音那句排在后面，先被读到，混不混进打字内容都不影响结果。

这说明覆盖有缺口而不是这段代码多余：真实场景恰恰是「先说日语 → 打一句中文 → 接着说日语」，打字那句是**最新**的。已补两条断言把两个方向都钉住：打字内容排在后面也不许参与，语音那几句全都没证据时也不许倒回去拿打字的（应保持当前语言，而不是改成中文）。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| STT-04-A 证据判定 | PASS | 5 条用例：假名与日语字形 → ja；简体字形 → zh；十个中日共用纯汉字样本逐个 → none；不夹汉字的纯拉丁 → en；空串与纯标点 → none |
| STT-04-B 不再误入 | PASS | 「没有假名的日语不再把语言切到中文」（`大丈夫`/`今日`/`本当` 序列下保持 `ja-JP`）；「拿到确凿证据才切」中日英三方向各一条 |
| STT-04-C 来源优先级 | PASS | 四条路径各一条用例，含上面补的两条断言 |
| STT-04-D 可见降级 | **不做（改判）** | 理由见 SPEC 的 AC-D 与下节 |
| STT-04-E TTS 音色 | PASS | `電話`/`元気` → `ja-JP`；`先休息一下吧。` 仍 `zh-CN`、`Take your time.` 仍 `en-US`、`……` 仍 `ja-JP`，与改动前逐字一致 |
| STT-04-G 探活超时 | PASS | 「probe 带上浏览器也认的超时」（断言 init 同时有 `connectTimeout` 与 `AbortSignal`）；「probe 超时后认输」（只有 abort 能结束的 fetch 下仍返回 false 且不挂住）。浏览器实跑：点「实时语音」到「我在听…」**140ms**，改之前 1766～2023ms |
| STT-04-F 语义与用例范围 | PASS（含一处修正） | `detectLanguage` 5 条一字未改且全绿；`preferredRecognitionLanguage` 与其 4 条用例一并删除 |

### AC-D 为什么不做

原文要求 `auto` 退回 Web Speech 时把 `degraded` 置 true。实现前查了消费方：`voicePresenter.ts:706` 是 `if (resolved.degraded) setError(resolved.note)`。`auto` 是默认配置，本机没开 whisper 就一定走这条路，置 true 等于每次打开语音页都挂一条错误——把预期行为渲染成故障，用户很快就不看那一栏了，真出错时反而被淹掉。

另外 `note` 只在开语音页时生成一次，而识别语言是逐段变的，把语言写进 note 得到的是一个会过期的值。真正有用的是「当前这一段按哪个语言识别」的实时显示，它和逃生阀是同一件事，一起交给前端 SPEC。

### AC-F 为什么改了

原文写「现有 11 条用例一字不改」。实现后 `preferredRecognitionLanguage` 已无生产调用方，留着它就是这个仓库自己批评过的那种「没有任何生产调用方的代码」（见 `runtimePlugin.ts` 的注释）。删函数就得删它那 4 条用例。`detectLanguage` 的 5 条——也就是 AC-F 真正想保护的那部分——一字未改。

## 共享接口影响

`domain/language.ts` 是 STT 与 TTS 共用的判定模块。

- 删除 `preferredRecognitionLanguage`：全仓唯一调用方是 `App.tsx`，已改用 `nextRecognitionLanguage`。
- `speechLanguageFor` 行为变化：只在「有日语字形证据」时与过去不同，其余路径逐字一致。受影响消费者是 `speechQueue.requestFor`，其定向测试（`speechQueue.test.ts`）全绿。
- 未新增或修改任何端口，[共享契约](../../modules/CONTRACTS.md) 无需追加。

## 待联调项与未覆盖范围

- **NOT RUN：真机语音**。全部证据来自纯函数的定向测试。字形白名单在真实 ASR 输出上的命中率没有量过——尤其是 `ZH_ONLY` 对短中文句的召回（`今天有点累` 一个专用字形都没有，判定为无证据）。要量它得有真人发音样本，属 [STT-03](../specs/STT-03.md) 的 DEFERRED 范围。
- **已锁死的状态解不开**。见开头。用户如果现在就在 `zh-CN` 上，本次改动帮不到他，得先手打一句带假名的日文，或者把 whisper-server 起起来。
- **逃生阀已交付**：见 [FE-13](../../frontend/specs/FE-13.md)。它的浏览器实跑第一次打开就复现了用户报的 `en-US` 闩。「Web Speech 的 confidence 持续偏低自动退回」仍未做，需要真机 confidence 分布才能定阈值。
- **探活超时是 800ms，不是 0**：第一次进语音页仍有最多 800ms 的等待（实测常在 140ms 就返回）。要做到零等待得把探活挪到后台、先按上次成功的链路起——没做，因为那要引入「上次结果」的缓存与中途换引擎，收益不及复杂度。
- **根治仍是本地 whisper**：`whisperClient` 固定送 `language: "auto"`，走那条链路整个问题不存在。本机 `http://127.0.0.1:8080` 实测连不上。
