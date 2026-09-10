# CORE-05 验收报告 · 插件契约与能力注册

- SPEC：[CORE-05_PLUGIN_CAPABILITY.md](../specs/CORE-05_PLUGIN_CAPABILITY.md)，AC A–G 共七项。
- 前置：CORE-04 模块自测 PASS。
- 状态：**A–F PASS；G 输入侧 PASS、输出侧 BLOCKED；模块整体待审阅**。集成未验收。
- 依赖：能力装配用测试宿主 + 真实 SQLite 存储；语音输入用例包用假 `SpeechRecognition` 与假采集/VAD/转写传输层；输出用例包用假 `speechSynthesis`。没有启动真实模型、音频设备或云服务。

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
| CORE-05-G 两种输入引擎、两种输出引擎跑同一份用例包全绿 | **输入 PASS / 输出 BLOCKED** | 输入：`speechInput.conformance.test.ts` 让 `webSpeechInput` 与 `whisperInput` 跑同一份 `speechInput.conformance.ts`（15 测试）。输出：`speechOutput.conformance.ts` 已建立并在唯一真实实现 `webSpeechOutput` 上全绿（5 测试）；SPEC 指定的第二实现 `cloudTtsOutput` 来自 `stash@{0}`，**该 stash 在当前仓库不存在**，无法取回 |

### 阻塞项说明（CORE-05-G 输出侧）

- SPEC 明确写道：「CORE-05-G 的第二个输出实现来自 `stash@{0}` 的 `cloudTtsOutput`：先经 `git stash branch feat/tts-output` 独立整理，再作为被测实现进来」。
- 实测：`git stash list` 为空；仓库内不存在 `cloudTtsOutput`，`services/voice/` 下没有任何第二输出引擎实现。
- 处理：**不写一个 stub 冒充「第二个实现」**——那正是端口一致性计划禁止的「为凑第二个实现而写实现」。用例包与单实现证据保留，第二实现留 BLOCKED，待该分支/改动恢复后补跑。
- 因此 CORE-05-G 不能整体判 PASS；输出的可替换性证据弱于输入侧。

## 命令与退出码

命令从 `aika-crossplatform/` 运行；未执行全仓测试、产品构建或 Tauri 打包。

```text
npx vitest run src/app/plugins/capabilityPlugins.test.ts src/app/plugins/plugins.test.ts src/app/composition.test.ts src/kernel/architecture.test.ts src/services/voice/speechInput.conformance.test.ts src/services/voice/speechOutput.conformance.test.ts src/services/voice/speechQueue.test.ts src/services/voice/webSpeechInput.test.ts src/services/voice/whisperClient.test.ts src/services/voice/voiceDiagnostics.test.ts src/hooks/useCompanionSession.integration.test.ts src/hooks/useCompanionSession.memoryV2.test.ts src/hooks/useVoiceConversation.integration.test.ts src/presentation/companionPresenter.test.ts src/presentation/voicePresenter.test.ts
```

- 退出码 **0**：**15 文件 / 160 测试通过**（含 CORE-04 回归；CORE-05 新增 3 文件：能力插件 11、输入用例包 15、输出用例包 5）。

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

## 其他

- `npx tsc --noEmit` 新增代码零类型错误。仍有 3 条**前序**错误（`useCompanionSession.integration.test.ts` 的 `MemoryRecord` 断言转换、`provider.conformance.ts` 的 `Array.prototype.at`），非本次引入。
- 真实麦克风/音箱、云 TTS、真实模型、Tauri 装配、Remote 联调：NOT RUN（既有后置安排不变）。
- FE-01 未执行；展示层交付归 CORE-04。

## 审阅与后续

- 执行者：A–F PASS，G 输入 PASS / 输出 BLOCKED。
- 原任务审阅：待审阅；CORE-01…04 的历史待审阅状态未自动升级。
- 恢复 `cloudTtsOutput`（或按端口一致性计划重建第二输出实现）后，只需运行 `speechOutput.conformance.test.ts` 即可补齐 G 输出侧。
- 下一份：CORE-06。
