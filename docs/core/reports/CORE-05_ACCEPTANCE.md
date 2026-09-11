# CORE-05 验收报告 · 插件契约与能力注册

- SPEC：[CORE-05_PLUGIN_CAPABILITY.md](../specs/CORE-05_PLUGIN_CAPABILITY.md)，AC A–G 共七项。
- 前置：CORE-04 模块自测 PASS。
- 状态：**A–G PASS；模块整体待审阅**。集成未验收。（G 的输出侧原为 BLOCKED，2026-09-11 取回第二实现后解除，见下方补记。）
- 依赖：能力装配用测试宿主 + 真实 SQLite 存储；语音输入用例包用假 `SpeechRecognition` 与假采集/VAD/转写传输层；输出用例包用假 `speechSynthesis` 与假 `HttpFetch` + 假 `Audio`。没有启动真实模型、音频设备或云服务。

## 交付内容

新增能力与装配：

| 文件 | 作用 |
| --- | --- |
| `services/voice/tokens.ts` | `SpeechEnginesToken`：语音能力包（输入选择 + 输出引擎 + 队列 + 打断监听） |
| `services/stickers/tokens.ts` | `StickerLibraryToken`：表情包清单（空清单是正常状态） |
| `services/memory/tokens.ts` | 追加 `MemoryAccessToken`：仓储 + 删除联动（`onInvalidate` 扇出） |
| `app/plugins/voicePlugin.ts` | voice 能力插件；`createInputEngine` / `createSpeechQueue` 语义不变，改由注册表提供 |
| `app/plugins/stickersPlugin.ts` | stickers 能力插件；清单缺失返回空数组，不阻断启动 |
| `app/plugins/sampleCapabilityPlugin.ts` | 示例扩展点：空操作能力，只证明「加能力不改内核」 |
| `app/plugins/index.ts` | 新增 `capabilityPlugins()`：默认装配的能力插件集合 |
| `services/voice/speechInput.conformance.ts` | 语音输入共用用例包（不带 `.test.`） |
| `services/voice/speechOutput.conformance.ts` | 语音输出共用用例包（不带 `.test.`） |

修改：

| 文件 | 变化 |
| --- | --- |
| `app/plugins/memoryPlugin.ts` | 追加提供 `MemoryAccessToken`；删除联动扇出给多个订阅者 |
| `app/plugins/presentationPlugin.ts` | 改为只声明 `optional` 能力依赖，从注册表取存储/记忆/表情包/语音后注入 Presenter |
| `app/composition.ts` | 默认装配 `capabilityPlugins()`；兜底 Presenter 只在启动失败时构造 |
| `services/voice/whisperInput.ts` | 新增可选 `ports`（采集/VAD/转写）注入，供用例包驱动；生产默认不变 |
| `presentation/companionPresenter.ts` | 支持注入 `MemoryAccess`；订阅删除联动而不是自造第二个仓储 |
| `kernel/architecture.test.ts` | 新增 CORE-05 插件隔离/扩展点门禁；内核禁止 import `app/` |

## 逐条 AC

| AC | 状态 | 证据 |
| --- | --- | --- |
| CORE-05-A 四个能力插件声明与实际一致；少注册 / 多注册 / 未声明依赖三种违约分别触发激活失败与逆序回滚 | PASS | `capabilityPlugins.test.ts`：默认装配下 Runtime / MemoryRepository / MemoryAccess / StickerLibrary / SpeechEngines 均可解析；`liar`（声明未提供）→ `PLUGIN_CONTRACT_VIOLATION` 且前一个插件 `deactivate` 被调用（逆序回滚）；`overreach`（提供未声明）→ `TOKEN_NOT_DECLARED`；`sneaky`（解析未声明）→ `DEPENDENCY_NOT_DECLARED`；三种情况 `kernel.state === "failed"`、`report.activated === []`、外部 `resolve` 抛错 |
| CORE-05-B 无 Remote / 空表情包 / 无麦克风权限三种降级下应用正常启动、入口隐藏、不弹错误 | PASS | 同文件：测试宿主无 Remote 时 `has(RemoteHostToken) === false`、`tryResolve` 返回 null；`stickersPlugin(async () => [])` 下 `report.ok` 且 Presenter `ready` 且 `stickers === []`；假语音引擎 `requestPermission` 拒绝时 `open()` 正常返回、phase=`error`、内核仍 `ready` |
| CORE-05-C 示例插件 diff 只含新文件加一行注册，内核本体与 `App.tsx` 零改动 | PASS | 功能：`capabilityPlugins() + sampleCapabilityPlugin("capability-demo")` 装配成功且 token 可解析，示例插件不写存储（`setSetting` 未被调用）。静态：`architecture.test.ts` 断言 `App.tsx` 不 import `app/plugins`。diff：`git diff --stat -- src/App.tsx src/kernel ':!src/kernel/architecture.test.ts'` 输出为空（内核实为本体与 App.tsx 零改动，见下方命令） |
| CORE-05-D 桌面宿主下 Remote 与本地 UI 解析到同一个 Runtime 实例 | PASS | `capabilityPlugins.test.ts`：装配 `remotePlugin` 后 `resolve(RuntimeToken)` 两次返回同一对象，`activeRuntimeServices()?.runtime` 与注册表实例全等，`ProviderSettingsToken` 同一实例；展示层也是注册表唯一实例 |
| CORE-05-E 语音队列与输入引擎的既有测试在插件装配下全部通过 | PASS | `speechQueue.test.ts`(18) / `webSpeechInput.test.ts`(2) / `whisperClient.test.ts`(14) / `voiceDiagnostics.test.ts`(3) 全绿（见命令） |
| CORE-05-F 插件之间无直接 import；内核不 import 任何插件 | PASS | `architecture.test.ts`：`app/plugins/*.ts`（除 `index.ts` 聚合）无 `./*Plugin` import；内核源码无 `app/` 引用；含突变断言（`import { voicePlugin } from "./voicePlugin"` 被检出） |
| CORE-05-G 两种输入引擎、两种输出引擎跑同一份用例包全绿 | **PASS**（输出侧 2026-09-11 补齐） | 输入：`speechInput.conformance.test.ts` 让 `webSpeechInput` 与 `whisperInput` 跑同一份 `speechInput.conformance.ts`（15 测试）。输出：`speechOutput.conformance.test.ts` 让 `webSpeechOutput` 与 `cloudTtsOutput` 跑同一份 `speechOutput.conformance.ts`（12 测试 = 每实现 6 条）；两个都是生产实现，被替掉的只有 `SpeechSynthesis` / `HttpFetch` + `Audio` 这层外部设备与传输 |

### 输出侧解除 BLOCKED 的补记（2026-09-11）

**先更正一条事实。** 本报告原先写「`git stash list` 为空，stash 在当前仓库不存在」，这是错的。`stash@{0}`（`6d8a487`，`On master: backup-before-overwrite-2026-09-10`）一直在，`cloudTtsOutput` 在它的**未跟踪文件提交** `dee8f4b` 里——`git stash show` 只列已跟踪改动，所以第一次查的时候没看见它。原判断基于错误的检索，不是基于事实。

```text
git log --all -S"cloudTts" --oneline   → dee8f4b untracked files on master: fdb735b …
git ls-tree -r --name-only dee8f4b     → …/voice/cloudTtsOutput.ts、outputEngine.ts、speakable.ts …
```

取回方式与 [端口一致性增量计划](../CONFORMANCE_PLAN.md) 的约定一致：**不 pop 回主线**。stash 里同时还有 Live2D 流水线脚本、AIRI 移植笔记等与本阶段无关的东西，整包落地会把无关改动混进提交。实际做法是只取语音输出这一组，其余留在 stash 里原样不动：

| 取回 | 来源 | 说明 |
| --- | --- | --- |
| `speakable.ts` | `dee8f4b` 原文 | 两个引擎共用的送合成前清洗；原来是 `webSpeechOutput` 里的私有副本 |
| `cloudTtsOutput.ts` | `dee8f4b` + 一处改动 | OpenAI 兼容 `POST /audio/speech`；改动：`synthesize` / `createCloudTtsOutput` / `testCloudTts` 增加可注入的 `send: HttpFetch`（默认仍是 `activeFetch`），好让用例包与替换矩阵不依赖过渡转发 |
| `outputEngine.ts` | `dee8f4b` + 同一处改动 | `auto / cloud-tts / system` 的选择与降级，结构对齐 `inputEngine.ts` |
| `contracts.ts` 的两处 | 手工并入 HEAD | `VoiceEngineKind` 增加 `"cloud-tts"`；`SpeechOutputEngine` 增加可选 `prefetch?`。HEAD 已有的 `turnId` 保留 |
| `speechQueue.ts` 的两处 | 手工并入 HEAD | 基线 `speed`（乘在语气之上）与「念第 n 句时预取第 n+1 句」。HEAD 已有的 `turnId` / `SpeechQueueDrainResult` 保留 |

未取回（留在 stash，与本阶段无关）：`App.tsx`、`useVoiceConversation.ts`、`prompt.ts`、`storage/*`、Live2D 流水线脚本、三份 `aika-crossplatform/docs/` 笔记。stash **未 drop**，仍是 `stash@{0}`。

用例包为容纳第二实现改了两处，两处都是**纠正原用例包里被 webSpeech 行为带偏的地方**，不是放宽门槛：

1. **探针改为可 await**。系统合成的回调同步就到，云端要等一次往返再等 `audio.play()`。用例包写成同步的话，云端那一格只能靠在实现里塞一条同步分支过关——那是让用例包迁就实现。
2. **错误断言从「消息逐字相等」改为「报一次且消息里说得出原因」**。系统合成能拿到的只有 `event.error` 一个词，原样透传就是全部信息；云端知道是哪个地址、对面回了什么状态码，把这些拼进消息是更有用的行为。逐字相等会逼云端删掉诊断信息才能过。

新增的第三条用例（预取不改变播放行为）对两个实现都是实打实的断言：声明了 `prefetch` 的必须预取后照样只念一次，没声明的走 `engine.prefetch?.()` 也必须照常念——见下方突变证据。

还差的一环，如实记录：**没有让用户选云端合成的入口**。`createOutputEngine` 返回的 `note` / `degraded` 目前在 `defaultSpeechEngines` 里被丢掉。今天不会发生「悄悄降级」（没有入口就不会被选中），但设置页接上时这两个值必须一路送到界面。这属于 TTS 模块的 UI SPEC，不在 CORE 范围内。

## 命令与退出码

命令从 `aika-crossplatform/` 运行；未执行全仓测试、产品构建或 Tauri 打包。

```text
npx vitest run src/app/plugins/capabilityPlugins.test.ts src/app/plugins/plugins.test.ts src/app/composition.test.ts src/kernel/architecture.test.ts src/services/voice/speechInput.conformance.test.ts src/services/voice/speechOutput.conformance.test.ts src/services/voice/speechQueue.test.ts src/services/voice/webSpeechInput.test.ts src/services/voice/whisperClient.test.ts src/services/voice/voiceDiagnostics.test.ts src/hooks/useCompanionSession.integration.test.ts src/hooks/useCompanionSession.memoryV2.test.ts src/hooks/useVoiceConversation.integration.test.ts src/presentation/companionPresenter.test.ts src/presentation/voicePresenter.test.ts
```

- 退出码 **0**：**15 文件 / 160 测试通过**（含 CORE-04 回归；CORE-05 新增 3 文件：能力插件 11、输入用例包 15、输出用例包 5）。

输出侧补齐后（2026-09-11）重跑，命令与退出码：

```text
npx vitest run src/services/voice src/app src/presentation src/kernel src/hooks
→ Test Files 21 passed (21) / Tests 245 passed (245)，退出码 0
npx tsc --noEmit -p tsconfig.json
→ 退出码 0
```

输出用例包由 5 测试变为 **12 测试**（同一份用例包 × 2 个真实实现 × 6 条）；`speechQueue.test.ts` 增加预取与基线语速共 9 条；新增 `cloudTtsOutput.test.ts`（16）与 `outputEngine.test.ts`（8）两份实现级单测。

CORE-05-C diff 证据：

```text
git --no-pager diff --stat -- aika-crossplatform/src/App.tsx aika-crossplatform/src/kernel ':!aika-crossplatform/src/kernel/architecture.test.ts'
（无输出 —— App.tsx 与内核本体零改动）
git --no-pager diff --name-only -- aika-crossplatform/src/App.tsx
（无输出）
```

### 突变验证

临时修改生产源码，运行对应用例包后以原始内容恢复；未保留突变。

| 突变 | 命令 | 结果 |
| --- | --- | --- |
| `webSpeechInput` 的 `onFinal` 文本改空 | `npx vitest run src/services/voice/speechInput.conformance.test.ts` | 退出码 1，「最终片段带原文」用例正确失败（1 failed / 14 passed） |
| `webSpeechOutput` 空文本分支也触发 `onStart` | `npx vitest run src/services/voice/speechOutput.conformance.test.ts` | 退出码 1，「空白或纯记号文本不发声」用例正确失败（1 failed / 4 passed） |
| （2026-09-11）`cloudTtsOutput` 空文本不再报 `onEnd` | `npx vitest run src/services/voice/speechOutput.conformance.test.ts` | 「空白或纯记号文本不发声」在 cloudTtsOutput 那一遍正确失败（1 failed / 11 passed） |
| （2026-09-11）`cloudTtsOutput` 的 `onStart` 多报一次 | `npx vitest run src/services/voice/speechOutput.conformance.test.ts src/app/ports.swapMatrix.test.ts` | 3 failed / 17 passed：用例包两条 + 矩阵的两实现一致性断言（`starts: 2` vs `starts: 1`）同时变红 |

恢复后两个用例包均回到全绿，包含在上面的 160 项定向回归中。

## 生产行为变化（需 INT-01 覆盖）

本次是 CORE-05 唯一的生产装配行为变化，单独列出：

- `createAikaKernel` 的 `featurePlugins` 默认值由 `[]` 改为 `capabilityPlugins()`。此前 `main.tsx` 不传插件，能力插件与 Runtime **根本没有被装配**，应用实际一直跑 legacy 路径；现在默认装上 providerSettings / memory / runtime / voice / stickers 与展示插件，`core.orchestrator` 默认 `kernel` 随之真正生效。
- 这与 CORE-03「默认 kernel」的交付声明一致，但属于第一次在真实入口上生效，**桌面/浏览器实际启动必须由 INT-01 验证**（本阶段只有测试宿主证据）。
- 可回退：设置 `core.orchestrator=legacy` 仍会退回旧编排，Presenter 也保留 legacy 分支；CORE-06 再统一删除。

## 共享接口影响与集成登记

- 新增 token：`voice.engines`（`SpeechEnginesToken`）、`stickers.library`（`StickerLibraryToken`）、`llm.memoryAccess`（`MemoryAccessToken`）。定义在各自接口旁，无中央清单。
- `presentationPlugin` 对能力只有 `optional` 依赖：缺失即降级，不激活失败；存储从 `StorageToken` 取，不再依赖过渡转发（兜底路径仍用 `openStorage`）。
- `memoryPlugin` 新增 `MemoryAccessToken` 并在删除时扇出失效通知；消费方（Presenter）不再自造第二个仓储。
- SPEC 图里 `SpeechInputToken` / `SpeechOutputToken` 收敛为 `SpeechEnginesToken` 一个能力包（名称可调）：输入引擎的选择是运行期行为，注册静态引擎无法表达。
- CORE-05-E 的既有语音测试沿用原断言；`whisperInput` 只新增可选注入口，生产默认路径不变。
- （2026-09-11）`SpeechOutputEngine` 增加**可选** `prefetch?`，`VoiceEngineKind` 增加 `"cloud-tts"`；两处都是向后兼容的追加，现有消费方（`speechQueue` 用 `engine.prefetch?.()`）无需改动。`SpeechQueueOptions` 增加可选 `speed`，不设时等于 1，既有行为一个字不变。`defaultSpeechEngines()` 增加两个可选入参（输出配置、`HttpFetch`），默认值 `DEFAULT_VOICE_OUTPUT.output = "system"` 使不传参时装出来的仍是 `webSpeechOutput`。

## 其他

- `npx tsc --noEmit` 新增代码零类型错误。仍有 3 条**前序**错误（`useCompanionSession.integration.test.ts` 的 `MemoryRecord` 断言转换、`provider.conformance.ts` 的 `Array.prototype.at`），非本次引入。（这 3 条已在 CORE-07 阶段修掉；2026-09-11 复跑 `tsc --noEmit` 退出码 0。）
- 真实麦克风/音箱、真实模型、Tauri 装配、Remote 联调：NOT RUN（既有后置安排不变）。**真实云 TTS 仍是 NOT RUN**：`cloudTtsOutput` 的用例包与单测全部走假 `HttpFetch`，没有向任何云服务发过请求，也没有用过任何 API Key；真实音质、真实延迟与真实计费未验证。
- FE-01 未执行；展示层交付归 CORE-04。

## 审阅与后续

- 执行者：A–G PASS（G 输出侧 2026-09-11 补齐，原 BLOCKED 解除）。
- 原任务审阅：待审阅；CORE-01…04 的历史待审阅状态未自动升级。
- 遗留（不属于 CORE 范围，交 TTS 模块 SPEC）：云端合成没有用户入口，`createOutputEngine` 的 `note` / `degraded` 在 `defaultSpeechEngines` 里被丢弃；设置页接上时降级必须当错误显示，并需要一次真实云服务试听来验证音质与计费。
- 下一份：CORE-06。
