# LLM-09 reply 事件 — 验收报告

日期：2026-09-12
范围：第八种 Trace 事件 `reply`；「同一句」判定收成全仓唯一实现。

## 需求

规划文档 §0.1 的「长效手段」：FE-04 修了显示（同句不渲染次级字幕），但**退化本身仍不可统计**——到底是偶发还是每轮都这样，没人答得出。SPEC 见 [LLM-09](../specs/LLM-09_REPLY_EVENT.md)。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/conversation.ts` | 私有的同句比较键抽成导出的 `isSameSentence(left, right)`；`displayTranslation` 改走它。 |
| `src/domain/trace.ts` | 新增第八种事件 `reply`：mood / 正文与翻译字数 / `translationDuplicatesReply` / sticker / actions 种类。**不记正文内容**，所以退化统计不受正文开关影响。 |
| `src/services/runtime/companionRuntime.ts` | 回包成型时（`emit(generated)` 之前）发 `reply`。 |
| `src/domain/traceView.ts`、`src/pages/TracePage.tsx` | 补第八种事件的标签与一句话摘要（同句时显示 `⚠ 正文与翻译同句`）。 |
| 三个测试文件 | 新增 3 + 4 条；既有「一轮走完」用例的事件序列从四个改成五个。 |

## 两个刻意的决定

1. **记布尔，不记正文**。`translationDuplicatesReply` 在任何脱敏设置下都有效，而它恰恰是最需要长期盯的一项。记正文就只能在「连正文一起记」打开时才有统计。
2. **判定只能有一处**。比较键从私有改为导出，显示侧与 Trace 侧共用。两处各写一份的话，界面说「重复」而统计说「不重复」这种事迟早发生。

> 类型检查在这里真起了作用：加第八种 kind 之后，`traceView` 的穷举 `Record` 与 `TracePage` 的穷举 `switch` 立刻报缺失。两处都是穷举而不是带 default 的兜底，所以漏不掉。

## 测试证据

```
npx vitest run src/services/runtime/companionRuntime.test.ts src/domain/conversation.test.ts
→ 退出码 0：companionRuntime 29、conversation 36
npx vitest run src   → Test Files 71 passed | 1 skipped (72)，Tests 859 passed | 1 skipped (860)
npx tsc --noEmit     → 退出码 0
```

突变验证：

| 突变 | 结果 |
| --- | --- |
| `translationDuplicatesReply` 恒 false | 1 failed ——「正文与翻译是同一句时标出来」 |
| `isSameSentence` 改成逐字相等 | **5 failed，横跨显示侧与统计侧**——「翻译和正文是同一句时不带这个字段」（FE-04 的 remote payload）、「只差空白、标点或大小写仍算同一句」、「空白、标点、英文大小写的差别不算两句话」、「显示侧与 Trace 侧同源」、「正文与翻译是同一句时标出来」 |

第二个突变一次打断两侧，正是「唯一实现」这个主张的证据——如果两处各有一份，它只会打断一边。两处均已还原，`grep -rn MUTANT src/` 无命中。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| LLM-09-A 序位正确 | PASS | 「一轮走完」用例：`turn_start / context_assemble / provider_stream_meta / reply / turn_end`，seq `[1..5]` |
| LLM-09-B 同句 true、不同句 false、空翻译 false | PASS | 三条用例，含「仅差句末标点」的真实退化形态与「空翻译不是重复而是没有」 |
| LLM-09-C mood / sticker / actions 一致；无 sticker 为 null | PASS | 「mood / sticker / actions 与回包一致」 |
| LLM-09-D 判定同源 | PASS | 「显示侧与 Trace 侧同源」用例 + 上表第二个突变 |
| LLM-09-E 失败轮不发空壳 | PASS | 「失败轮没有回包，就不发 reply 事件」：`reply` 为空而 `turn_end` 仍有一条 |

## 共享接口影响

- `TraceEventKind` 增加 `"reply"`，`TraceEventV1` 增加一个成员。**既有七种事件的字段未动**；对 kind 做穷举的地方必须补一个分支（仓库内两处，已补）。按「v1 之后的追加」记入 [共享契约](../../modules/CONTRACTS.md)。
- `domain/conversation.ts` 新增导出 `isSameSentence`；`displayTranslation` 行为不变（实现换成调它）。

## 待后续

- 展示与统计：F5 能力调用视图会用 mood/sticker/actions，F9 成本页会用退化率。
- NOT RUN：真实模型下确认 qwen-plus 的退化率。这条现在**可测了**——真机跑几轮，Trace 里 `reply` 事件的 `translationDuplicatesReply` 比例就是答案。这也是本 SPEC 最直接的价值。
