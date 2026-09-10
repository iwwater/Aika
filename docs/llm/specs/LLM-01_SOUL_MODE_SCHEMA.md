# LLM-01 · Soul、Mode 与输出协议

状态：已自测 6 文件/85 测试通过；LLM-01-D 只有 fixture，真实模型质量 NOT RUN；待审阅，不新增完成声明。

## 目标与边界

- 输入：当前文本、固定 CharacterSoul、Mode/场景配置、Provider 原始流式结果。
- 输出：稳定的 Soul/Mode 配置、ReplyEnvelopeV1 与正文增量事件。
- 前置：仅需要既有回复链路；不依赖 STT/TTS/UI。
- 负责范围：domain/soul、companion、prompt、streamingReply、模式设置适配；Provider 与会话仅改协议接入点。
- 不做：不开发模式按钮、React 页面、自动画像沉淀或新 Runtime。

## 架构与接口设计

当前实现位于 `src/domain/soul.ts`、`companion.ts`、`prompt.ts`、`streamingReply.ts`；本节区分已存在的领域类型与拟完善的边界。优先修复/适配现有代码，不重复建立第二套 Soul。

```mermaid
flowchart LR
  C[CharacterSoul + ModeConfig] --> P[Prompt Builder]
  P --> A[Provider Adapter]
  A --> D[Incremental Decoder]
  D --> E[ReplyEnvelopeV1]
  E --> O[Runtime Consumer]
```

```ts
// 沿用 domain/soul.ts 的现有字段。
type ModeId = "companion" | "oral_practice" | "scenario_practice";
interface ModeConfig {
  schemaVersion: 1;
  mode: ModeId;
  targetLanguage: "ja-JP" | "zh-CN" | "en-US";
  correctionPreference: "none" | "gentle" | "explicit";
  replyLength: "short" | "normal" | "long";
  scenario?: ScenarioConfig; // 沿用现有场景字段
}
// 已有纯函数；不得写存储或改变传入对象。
normalizeModeConfig(value: unknown): ModeConfig;
exitScenarioMode(current: ModeConfig): ModeConfig;
modePolicyText(config: ModeConfig): string;
// 拟定配置端口，实际函数名可由兼容 adapter 映射。
interface ModeStore {
  load(): Promise<ModeConfig>;
  save(config: ModeConfig): Promise<void>;
}
```

`CharacterSoul` 继续使用已有 schemaVersion/id/name/systemPrompt/stableTraits/boundaries；`UserSoul` 继续使用带 sources 的稳定字段。两者不包含当前 Mode 或场景身份。`ReplyEnvelopeV1` 复用已有 mood/replyText/translation/memoryCandidates/actions，工具只允许实际支持的白名单动作。

| 边界 | 契约与失败行为 |
| --- | --- |
| 设置读取 | 缺失/旧版/无效配置规范化到 companion；存储异常作为可见降级，不伪称读取成功 |
| 设置保存 | 持久化成功才确认保存；失败返回错误且不污染原配置，场景退出不改 Soul |
| 输出字段 | canonical 字段优先；仅在 canonical 缺失时取旧字段，不能拼接两套正文造成重复 |
| 流式解码 | 同轮追加分片；支持 JSON 转义与 Unicode 跨片，输出增量不得回退或重复；结尾完整校验，失败不形成完整成功回复 |
| 旧消费者 | 在边界生成 japaneseText/chineseTranslation 兼容视图；UI/TTS 不解析 Provider JSON |

验收补充：LLM-01-A/C 覆盖设置失败与不变性；LLM-01-B 覆盖同轮同时出现新旧字段的优先规则。这里只增加上述 AC 的明确样例，不另建重复报告。

## 实施内容与验收条件

交付：CharacterSoul/UserSoul 基础类型、companion/oral_practice/scenario_practice 三种 Policy、模式与场景配置读写、旧协议到 ReplyEnvelopeV1 的适配。只提供模式操作接口，不开发新 UI。场景临时身份退出后清除；用户画像自动沉淀留 LLM-03/04。

| AC | 模块内验收 |
| --- | --- |
| LLM-01-A | 三模式互切、退出场景和持久化重载后，角色 ID/人格/记忆/关系不被重置，场景身份不残留 |
| LLM-01-B | PRD 与旧 japanese_text/chinese_translation/mood/sticker 协议正常归一；转义、半截 JSON、Unicode 分片无重复正文，无需完整 JSON 才产生正文事件 |
| LLM-01-C | 未知 mood 回退中性，未知动作拒绝；坏回复显式失败，下一轮可正常调用；旧配置无模式时保留 companion |
| LLM-01-D | 三模式各 10 个固定文本场景，保留实际输出供审阅：角色/边界冲突 0，暂停纠正/中文求助/退出场景均生效；fixture 只能证明编排，不能替代输出质量 |

测试种类：生产 prompt/解析器/配置适配单测及 headless 会话测试。不要启动 TTS，也不要求 FE 模式按钮实现。

## 模块内执行与交付

1. 先确认上述接口与负责范围，再实现当前 SPEC；不要顺带执行下一份 SPEC。
2. 对本次修改的生产逻辑准备定向测试名单。只 mock 外部依赖，不 mock 本模块被验收逻辑；无需启动其他模块。
3. 报告每条 AC 的测试文件/样本、真实命令及退出码，质量样本标明实际模型或 fixture。证据不足保留 NOT RUN/BLOCKED，不能降低门槛。
4. 交付 `../reports/LLM-01_ACCEPTANCE.md`；原任务审阅证据。只在 [集成触发条件](../../integration/SPEC.md) 满足时安排全流程调试，当前小 SPEC 不默认跑全仓测试或产品打包。

共享规则见 [模块测试规则](../../modules/TESTING.md)；输入输出遵循 [共享契约](../../modules/CONTRACTS.md)。
