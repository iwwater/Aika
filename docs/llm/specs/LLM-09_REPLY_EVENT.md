# LLM-09 · reply 事件（回包要素与语义退化标记）

状态：已自测。A–E 五条 AC 全 PASS；两处突变命中，其中「同句判定」的突变一次打断显示侧与统计侧 5 条用例。证据见 [验收报告](../reports/LLM-09_ACCEPTANCE.md)。

## 为什么需要它

两个来源指向同一个缺口：

1. **规划文档 §0.1 的「长效手段」**：原话是「协议层回包进 Trace 后，这类『协议合法但语义退化』的回复才能被看见、被统计」。[FE-04](../../frontend/specs/FE-04.md) 修了显示，但那只是让用户看不到重复的字幕——**退化本身仍然不可统计**。到底是偶发还是每轮都这样，现在没人答得出。
2. **F5 能力调用视图**要展示 sticker action，而现有七种事件里没有任何一个携带回包要素（mood / sticker / actions）。

## 目标与边界

- 输出：第八种事件 `reply`；Runtime 在回包成型时发出；「正文与翻译是同一句」作为一个布尔字段被记下来。
- 不做：不改既有七种事件的字段；不在页面上做统计图（F5/F9 各自的事）；不改 `ReplyEnvelopeV1`。

## 设计

```ts
| (TraceEventBase & {
    kind: "reply";
    mood: string;
    replyChars: number;
    translationChars: number;
    /** 正文与翻译是同一句。协议合法但语义退化——§0.1 那个 bug 的可统计形式。 */
    translationDuplicatesReply: boolean;
    sticker: string | null;
    actions: string[];
  })
```

- **不记正文内容**，只记长度与「是否重复」。这样不受正文开关影响：退化统计在任何脱敏设置下都有效，而它恰恰是最需要长期看的东西。
- 「是同一句」的判定**复用 FE-04 的那一套**，不另写一份：`domain/conversation.ts` 里的比较键从私有改为导出 `isSameSentence`，显示侧与 Trace 侧共用。两处各写一份的话，界面说「重复」而统计说「不重复」这种事迟早发生。

| AC | 模块内验收 |
| --- | --- |
| LLM-09-A | Runtime 在回包成型时发 `reply`，seq 排在 `provider_stream_meta` 与 `turn_end` 之间 |
| LLM-09-B | `translationDuplicatesReply`：同句（含仅差标点大小写）为 true，不同句为 false，空翻译为 false |
| LLM-09-C | mood / sticker / actions 与回包一致；没有 sticker 时是 null 而不是空串 |
| LLM-09-D | 判定与显示侧同源：`isSameSentence` 是唯一实现，`displayTranslation` 也走它 |
| LLM-09-E | 失败轮与取消轮没有回包，因此不发 `reply` 事件（不发空壳） |

证据：`companionRuntime.test.ts`、`conversation.test.ts` 的定向运行。

## 模块内执行与交付

交付 `../reports/LLM-09_ACCEPTANCE.md`。协议追加按「v1 之后的追加」记录在 [共享契约](../../modules/CONTRACTS.md)。
