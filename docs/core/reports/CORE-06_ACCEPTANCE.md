# CORE-06 验收报告 · 旧路径下线与契约冻结

- SPEC：[CORE-06_DECOMMISSION.md](../specs/CORE-06_DECOMMISSION.md)，AC A–E 共五项。
- 前置：CORE-05 模块自测（执行本阶段时 G 输出侧为 BLOCKED，与本次无关；该项已于 2026-09-11 解除）。
- 状态：**A–E 自测 PASS，模块待审阅；触发 INT-01（跨模块文本链路验证待排期）**。
- 依赖：测试宿主 + 真实 SQLite 存储 + fake Runtime / fake STT / fake TTS；没有启动真实模型、音频设备或产品构建。

## 删除清单（按实际引用关系确认）

| 已删除 | 说明 |
| --- | --- |
| `presentation/companionPresenter.ts` 的 legacy 编排 | `sendViaLegacy` 与 `busy` / `requestSeq` / `activeRequest` 私有计数全部移除；`send()` 只剩唯一 Runtime 路径 |
| `services/runtime/activeRuntime.ts`（整文件） | `installRuntimeServices` / `activeRuntimeServices` / `normalizeOrchestrator` / `DEFAULT_ORCHESTRATOR` 过渡槽 |
| `SETTING_KEYS.orchestrator`（`core.orchestrator`） | 组合根不再读写；旧库残留值按未知设置忽略 |
| `services/storage/index.ts` 的 `openStorage` / `installStorageOpener` / `resetInstalledStorageOpener` | 存储只经 `StorageToken` 注入；装配失败改为注入必定失败的 `loadStorage` |
| `services/notification/notifier.ts` 的 `installNotifier` / `resetInstalledNotifier` / `activeNotifier` | 通知只经 `NotifierToken` 注入；无通知能力的宿主注入 `createNoopNotifier()` |
| `composition.installOrchestrator` / `installFailedStorageOpener` | 分别由注入的 Runtime 与必定失败的 `loadStorage` 取代 |
| Presenter 对 `providerClient` / `activeNotifier` / `secretStore.secure()` 以外的过渡依赖 | Presenter 不再 import `streamChat` / `sendChat` / `isAbortError` |

### 按 SPEC 条件保留（未删除，附原因）

- `secretStore` 单例与 `installSecretStore`：`useRemoteAccess`（手机端访问口令）仍在使用。
- `activeFetch` / `installHttpFetch`：`whisperClient` 的 HTTP 出口在用（Tauri 走 plugin-http）。
- `remote/bridge` 的具名转发：`useRemoteAccess` 与 `App.tsx` 在用。
- `loadProvider` / `saveProvider`：仍是存储模块的公开操作面（Presenter 继续使用）。
- `hooks/hookHarness.ts`：**Hook 适配器测试仍需要**它（`useCompanionSession.integration.test.ts` 直接 import）；SPEC 的删除前提是「Presenter 测试不再需要」，而 Presenter 测试从未依赖它（CORE-06-E 门禁守着）。
- 以上都是 Remote / 语音插件的后续范围，不属于「对话编排」，不在本次顺手改名。

## 逐条 AC

| AC | 状态 | 证据 |
| --- | --- | --- |
| CORE-06-A 单一编排；`providerClient` 调用方只剩 Runtime 适配与 extractor；`core.orchestrator` 与 legacy 分支无残留 | PASS | `kernel/architecture.test.ts`：生产代码扫描 `sendViaLegacy|activeRuntimeServices|normalizeOrchestrator|core.orchestrator` 为零；`providerClient` 只被 `services/runtime/providerAdapter.ts` 与 `services/memory/extractor.ts` import；Presenter 内不再出现 `providerClient|streamChat|sendChat`。`App.tsx` 的「测试连接」改经 `ProviderProbeToken` |
| CORE-06-B 无死代码；被删模块无引用；旧设置项读取被忽略不报错 | PASS | `tsc --noEmit` 无新增错误（仅剩 3 条前序错误，见末节）；`composition.test.ts`「旧库里残留的 core.orchestrator 被当作未知设置忽略，启动不报错」；`architecture.test.ts` 断言常量已从 `SETTING_KEYS` 删除 |
| CORE-06-C 测试不缩水；删除的测试有替代证据 | PASS | 见下「测试数量与替代证据」；定向回归 **22 文件 / 232 测试** 全绿 |
| CORE-06-D 契约已更新并标注消费者与版本 | PASS | `docs/modules/CONTRACTS.md` 新增「内核契约（CORE-01…06 冻结，v1）」七行：注册表与插件契约、`resolve` 三处约束、token 分散所有权、能力缺失即不注册、单一编排路径、`runtimeTurnId` 与旧 `turnId` 并存、展示层依赖注入，并逐行列出受影响消费者 |
| CORE-06-E 完成定义达标 | PASS | 内核/Presenter 测试不依赖 `hookHarness` 或 React 替身（门禁）；`useCompanionSession` 不 import `services/` 且 65 行；示例插件扩展点重跑通过（`capabilityPlugins.test.ts`）；内核零业务词汇与「无中央 token 清单」两套扫描通过（后者为本次补齐） |

## 命令与退出码

命令从 `aika-crossplatform/` 运行；未执行全仓测试、产品构建或 Tauri 打包。

```text
npx vitest run src/app/plugins/capabilityPlugins.test.ts src/app/plugins/plugins.test.ts src/app/composition.test.ts src/kernel/architecture.test.ts src/services/voice/speechInput.conformance.test.ts src/services/voice/speechOutput.conformance.test.ts src/services/voice/speechQueue.test.ts src/services/voice/webSpeechInput.test.ts src/services/voice/whisperClient.test.ts src/services/voice/voiceDiagnostics.test.ts src/hooks/useCompanionSession.integration.test.ts src/hooks/useCompanionSession.memoryV2.test.ts src/hooks/useVoiceConversation.integration.test.ts src/presentation/companionPresenter.test.ts src/presentation/voicePresenter.test.ts src/services/runtime/companionRuntime.test.ts src/services/runtime/providerAdapter.test.ts src/services/runtime/provider.conformance.test.ts src/services/context/contextAssembler.test.ts src/services/memory/memoryRepository.test.ts src/services/storage/storageCompatibility.test.ts src/services/providerClient.test.ts
```

- 退出码 **0**：**22 文件 / 232 测试通过**。

### 突变验证

| 突变 | 命令 | 结果 |
| --- | --- | --- |
| 把 `core.orchestrator` 加回 `SETTING_KEYS` | `npx vitest run src/kernel/architecture.test.ts` | 退出码 1：两条 CORE-06 门禁正确失败（2 failed / 23 passed），恢复后全绿 |
| 门禁自身的合成断言 | 同上 | `LEGACY_MARKERS` 对 `core.orchestrator` / `sendViaLegacy` 命中、对 `services.runtime.submit(request);` 不命中；CORE-02-D 对跨模块 token 桶命中 |

## 测试数量与替代证据（CORE-06-C）

同一份 15 文件集合由 CORE-05 的 **160 测试**变为 **151 测试**（−9），原因是删掉机制后**重复与失效的运行**被移除，并新增了门禁：

| 变化 | 数量 | 替代证据 |
| --- | --- | --- |
| `useCompanionSession.integration.test.ts` 去掉 legacy/kernel 双跑 | −6 | 同一批断言现在只在唯一路径上跑（16 测试），且原先「只在 kernel 跑」的 5 条用例不再被条件包裹，全部常开 |
| `useCompanionSession.memoryV2.test.ts` 去掉 legacy/kernel 双跑 | −5 | 同上（5 测试，断言未改） |
| `composition.test.ts` 删除 `normalizeOrchestrator` 归一化与「按设置装配/不热切换」 | −8 | 机制已删除；替代为「旧库残留 `core.orchestrator` 被忽略且不报错」+ CORE-06 静态门禁 |
| `architecture.test.ts` 新增 CORE-06 门禁（残留扫描、providerClient 调用方、harness 隔离、旧设置项、突变） | +6 | 新增覆盖 |
| `architecture.test.ts` 新增 CORE-02-D 无总表/无跨模块 token 桶门禁 | +3 | 补齐 REFACTOR_PLAN 完成定义第 6 条 |

**没有为通过而删断言**：被删的每一条要么是「同一断言在已删除路径上的重复运行」，要么是「被删除机制自身的测试」。断言文字未放宽。

## 测试数量与覆盖范围（对照 CORE 基线）

- 本模块定向回归（CORE-04/05/06 合并集合）：22 文件 / 232 测试。
- REFACTOR_PLAN 完成定义逐条：
  1. 全仓只有一条对话编排路径，`providerClient` 调用方只剩 Runtime 适配与 extractor —— PASS（门禁）。
  2. `useCompanionSession.ts` 不 import 任何 `services/` 实现 —— PASS（CORE-04 门禁，65 行）。
  3. 新增空能力插件只需新文件 + 一行注册，内核与 `App.tsx` 零改动 —— PASS（CORE-05-C 功能 +「App.tsx 不 import 插件」门禁）。
  4. 内核与 Presenter 的测试不依赖 `hookHarness` —— PASS（门禁）。
  5. `src/kernel/` 无业务词、无 token 实例 —— PASS（既有门禁）。
  6. 全仓无能力总表、无跨模块 token 汇总文件 —— PASS（本次补齐门禁）。

## CORE 模块收尾结论

- CORE-01…06 工程实现完成并各自通过模块自测；**模块验收与集成验收未通过**，等待原任务审阅与 INT-01。
- 两条路径共存的中间态已消除：运行时、展示层、能力插件都通过注册表 + 构造参数连接，`resolve()` 收敛到白名单三处。
- 仍有明确后置项：~~**CORE-05-G 输出侧**缺第二输出实现，保持 BLOCKED~~（2026-09-11 取回 `cloudTtsOutput` 后解除，见 [CORE-05 报告](CORE-05_ACCEPTANCE.md)）；**INT-01** 由本次触发，需在真实宿主验证文本链路；真实模型质量、真人语音、真实云 TTS、Tauri 打包仍为 NOT RUN/DEFERRED。
- 下一份：CORE-07（端口一致性与实现可替换性收口），不属本报告范围。

## 其他

- `npx tsc --noEmit` 新增代码零错误。仍存 3 条**前序**错误（非本次引入）：`hooks/useCompanionSession.integration.test.ts` 的 `MemoryRecord` 断言转换、`services/runtime/provider.conformance.ts` 的 `Array.prototype.at`（lib 目标）。按小阶段规则不把全局 tsc 当门禁。
- 未改任何测试断言以迁就删除；未做 `git add .`、未提交、未推送。
