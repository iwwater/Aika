# 端口一致性增量计划 · 从「能加插件」到「能换实现」

写于 2026-09-10，基础 commit `4bc2992`（CORE-01 已完成）。本文件是增量方案，[CORE-07](specs/CORE-07_PORT_SWAPPABILITY.md) 是它的执行 SPEC。

## 一、这个增量要换来的结论

现有 CORE-01…06 能证明的是：**加一个能力不用改内核**（CORE-05-C 的示例插件 diff）。

这个增量要证明一件更强的事：**LLM、Memory、STT、TTS、Context Source、Storage 都能换实现，而消费侧一行不改。**

两者的差别在于，前者只说明扩展点存在，后者才说明抽象是真的——一个只有单一实现的接口，无论写得多漂亮，都没有被验证过它抽象对了。

## 二、现状查证

`4bc2992` 上逐一核对：

| 端口（**全部已存在，本增量不新造**） | 现有实现 | 现状 |
| --- | --- | --- |
| `AikaStorage` | `sqliteStorage`、`localStorageStorage` | 2 个 |
| `MemoryV2Store` | `sqliteMemoryStore`、`localMemoryStore` | 2 个 |
| `SpeechInputEngine` | `webSpeechInput`、`whisperInput` | 2 个 |
| `SpeechOutputEngine` | `webSpeechOutput`、`cloudTtsOutput` | 2 个（第 2 个 2026-09-11 从 `stash@{0}` 取回，见第六节） |
| `RuntimeProvider` | `providerAdapter` 覆盖 4 种协议（openai-responses / openai-compatible / anthropic / gemini） | 1 个适配器 4 条分支 |
| `ContextSource` | `memorySource` | 1 个 |
| `SecretStore` | 单个对象内部 `inTauri()` 分叉 | 0 个真正可替换的实现 |

关键事实：**多数端口本来就有两个实现，但没有一份「两个实现都必须过」的共用用例。**

现有测试全都绑实现：`sqliteMemoryStore.test.ts` 在断言 `BEGIN → 写内容 → 同步 FTS → COMMIT` 这样的 SQL 语句序列，`storageCompatibility.test.ts` 只有 2 条旧字段兼容用例。这些测试换个实现一条都跑不了，所以「可替换」从来没被验证过——它只是看起来成立。

`SecretStore` 是反面典型：分叉写在实现内部，所以它根本不是「两个实现」，是「一个实现两条路」。CORE-02 拆宿主插件时它才会变成两个。

## 三、做法：共用用例包，不是新抽象层

**一个新 interface 都不加。** 用例包针对的就是上表里已经存在的那些接口。

```ts
/** 用例包要的不是实现，是「怎么造一个被测实现」。 */
export interface PortHarness<T> {
  name: string;
  create(): Promise<{ subject: T; dispose(): Promise<void> }>;
  /**
   * 这个实现明确不支持的可选能力。
   * 必须显式声明——用例包会去验证它「确实以可识别的方式不支持」，
   * 而不是允许悄悄跳过。跳过是稀释用例包最常见的方式。
   */
  unsupported?: readonly string[];
}

export function runStorageConformance(harness: PortHarness<AikaStorage>): void;
export function runMemoryStoreConformance(harness: PortHarness<MemoryV2Store>): void;
export function runSpeechInputConformance(harness: PortHarness<SpeechInputEngine>): void;
// …每个端口一份
```

约定：

- 文件命名 `<port>.conformance.ts`，**不带 `.test.`**，因此不会被 vitest 直接收集；由各实现自己的测试文件 import 后调用。这样「谁在跑这份用例」在 import 图上看得见。
- 用例包只依赖端口接口与领域类型，不依赖内核、不依赖 React、不依赖任何具体实现。
- 断言只写**契约层面可观测的行为**：写入后读得到、删除后读不到、并发写不串、错误如何暴露、可选能力缺失时给什么信号。不断言 SQL 语句、不断言 localStorage 键名——那些是实现细节，写进用例包就等于把两个实现焊死。

## 四、防止用例包变成「最小公分母」

这是这类工作最容易滑向的失败模式：为了让两个实现都过，把用例削到只剩双方都支持的部分，最后证明了一件毫无信息量的事。

三条对策：

1. **`unsupported` 是声明，会被验证。** 声明不支持 `deleteSummaries` 的实现，用例包要断言它确实以约定方式表示缺失（可选方法未定义，或调用后返回明确的不支持信号），而不是静默无事发生。声明了却其实支持，也算不一致。
2. **突变验证。** 沿用 CORE-01 的做法：把某个实现的一条真实行为改坏，对应用例必须失败。用例包如果永远绿，它和没写一样。
3. **契约层面 ≠ 全面等价。** 报告里必须写清楚：用例包证明的是**行为契约可替换**，不证明性能、并发度与持久性等价（SQLite 的事务性和 localStorage 的非原子性显然不等价）。不允许拿用例包全绿去暗示两者随便换。

## 五、增量怎么落，才不会把这轮重构扩大 N 倍

用例包**随各 SPEC 就地增量**，不新设阶段。每份现有 SPEC 只多一条 AC，因为那份 SPEC 本来就要动那个端口：

| 端口 | 落在 | 建议新增 AC |
| --- | --- | --- |
| `AikaStorage`、`SecretStore` | CORE-02（本来就在拆宿主插件） | **CORE-02-G** 两种存储实现与两种密钥实现跑同一份用例包全绿；`unsupported` 声明与实际行为一致 |
| `RuntimeProvider` | CORE-03（本来就在接 Runtime） | **CORE-03-H** 4 种协议 fixture 跑同一份 provider 用例包全绿，流式增量、错误码、取消语义一致 |
| `MemoryV2Store`、`ContextSource` | CORE-03（本来就在接记忆与上下文源） | **CORE-03-I** 两种记忆存储跑同一份用例包全绿；ContextSource 用例包至少覆盖真实实现与一个确定性 stub |
| `SpeechInputEngine`、`SpeechOutputEngine` | CORE-05（本来就在做语音插件化） | **CORE-05-G** 两种输入引擎、两种输出引擎跑同一份用例包全绿（输出引擎的第二实现由 `stash@{0}` 的 `cloudTtsOutput` 提供）—— **已完成** |

只有一份**新增** SPEC：[CORE-07](specs/CORE-07_PORT_SWAPPABILITY.md)，排在 CORE-06 之后。它不写新实现、不改接口、不动消费侧，只做两件事：跑替换矩阵，给结论。

`ContextSource` 只有一个真实实现，用例包自带一个确定性 stub 作为第二个被测对象——这一点在结论里要如实标注为「用例包已建立，可替换性证据弱于其他端口」，不能和有两个真实实现的端口混为一谈。

## 六、`stash@{0}` 在这里有了归宿（2026-09-11 已落地）

那批语音输出改造（`cloudTtsOutput`、`outputEngine`、`speakable`、`speechQueue` 扩展）正好是 `SpeechOutputEngine` 的第二个真实实现。原计划是 CORE-01 完成后把它变成独立分支：

```bash
git stash branch feat/tts-output stash@{0}   # ← 最终没有这么做，原因见下
```

**实际做法与计划的出入，如实记录。**

1. CORE-05 / CORE-07 首次执行时判定「stash 不存在」，据此把输出侧标了 BLOCKED。这个判断是错的：`git stash show` 只列**已跟踪**改动，而 `cloudTtsOutput` 是未跟踪文件，藏在 stash 的第三个父提交 `dee8f4b` 里。用 `git log --all -S"cloudTts"` 一次就能找到。
2. 没有走 `git stash branch`，也没有 pop。stash 里同时还躺着 Live2D 流水线脚本、AIRI 移植笔记、`App.tsx` / `useVoiceConversation` 的 UI 改动等与本增量无关的东西；整包落地会把无关改动混进提交，正是 AGENTS.md 禁止的。改为**只从 `dee8f4b` 取语音输出那一组文件**，其余留在 stash 里原样不动，stash 未 drop。
3. 取回后并入的是 HEAD 版本，不是 stash 版本：`contracts.ts` 与 `speechQueue.ts` 在 CORE 阶段已经加了 `turnId` / `SpeechQueueDrainResult`，这些保留，stash 那边的 `prefetch?` / `speed` 手工并入。
4. 唯一一处对 stash 原文的改动：`cloudTtsOutput` / `outputEngine` 的 HTTP 出口改为可注入（默认仍是 `activeFetch`），好让用例包和替换矩阵按本计划的约定不依赖过渡转发。

结论：它既没有污染 CORE 的基础 commit，也没有烂在 stash 里；stash 剩下的部分（Live2D、UI）仍待各自模块认领。

## 七、明确不做

- **不做 Cordis 式的运行期热替换。** 本增量证明的是**装配期可替换 + 消费侧零改动**：换实现意味着改组合根装哪个插件，然后重启。服务在运行中出现/消失、消费侧反应式重连，需要 token 级的 availability 订阅和消费侧重建协议，那是另一个量级——真要做，另立 SPEC，不塞进这轮。
- **不新造端口接口。** LLM、STT、TTS、Storage 的接口全部沿用现有定义。
- **不为了凑第二个实现而写实现。** `ContextSource` 的 stub 是用例包的测试替身，不是产品能力，不进生产装配。
- **不把用例包变成集成测试。** 它测单个端口的行为契约；跨端口的联动仍归 INT-01/02。

## 八、这个增量的成功判据

CORE-07 通过时，报告要能逐端口回答一句话：**「这个端口有几个真实实现，它们跑的是不是同一份用例，切换它需要改哪些文件。」**

其中第三问的答案必须是「只有组合根里选插件的那几行」，且由 `git diff --name-only` 作证，而不是靠阅读判断。
