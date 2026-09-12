# CORE-04 验收报告 · Presenter 层与 Hook 降级

- SPEC：[CORE-04_PRESENTER_ADAPTER.md](../specs/CORE-04_PRESENTER_ADAPTER.md)，AC A–F 共六项。
- 前置：CORE-03 模块自测 PASS，默认 kernel、显式 legacy 可回退。
- 状态：**模块自测 PASS，待审阅；集成未验收**。
- 依赖：Presenter 用 fake Runtime / fake Provider / fake STT / fake TTS / fake 计时器；存储用内存 fake；没有调用真实模型、音频设备或 Tauri 构建。React 渲染在 Hook 适配器测试里用 `hookHarness` 替换，Presenter 自身在无 DOM 的 node 环境运行。

## 交付内容

新增 `src/presentation/`（纯 TypeScript，不 import React）：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `presentation/companionPresenter.ts` | 1096 | `CompanionPresenter`：不可变快照 + 会话命令；kernel/legacy 两套编排（legacy 保留待 CORE-06 删除） |
| `presentation/voicePresenter.ts` | 805 | `VoicePresenter`：STT/TTS 编排、打断、字幕与诊断快照 |
| `presentation/tokens.ts` | 15 | `CompanionPresenterToken` / `VoicePresenterToken`，定义在接口旁边，不做中央清单 |
| `presentation/services.ts` | 21 | `createPresentationServices`：组合根与插件共用同一批实例 |
| `presentation/fallback.ts` | 29 | 装配失败时 `KernelProvider` 兜底解析，显式传值、无模块级全局槽 |

新增装配与 React 绑定：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `app/kernelContext.tsx` | 46 | `KernelProvider` + `useService`：React 侧唯一的取依赖入口 |
| `app/plugins/presentationPlugin.ts` | 30 | 把两个 Presenter 作为注册表服务提供，disposer 接内核释放 |
| `app/composition.ts` | 改 | 构建 Presenter、注册展示插件、失败时把同一批实例交给兜底 |
| `main.tsx` | 改 | 用 `KernelProvider` 包住 `App`，把组合根返回的 Presenter 传入 |

Hook 降级为适配器：

| 文件 | 行数 | 变化 |
| --- | --- | --- |
| `hooks/useCompanionSession.ts` | 65 | 由 928 行降为 65 行；只做 `useService` 取 Presenter、`useSyncExternalStore` 订阅快照、命令转发 |
| `hooks/useVoiceConversation.ts` | 57 | 由 660 行降为 57 行；同上，外加每轮 `configure` 回调 |
| `hooks/usePresenterSnapshot.ts` | 22 | `usePresenterSnapshot`：把不可变快照接到 `useSyncExternalStore` |

`components/VoiceModal.tsx` 仅把 `captions` 形参由 `VoiceCaption[]` 改为 `readonly VoiceCaption[]`，配合不可变快照；无结构或样式改动。

## 逐条 AC

| AC | 状态 | 证据 |
| --- | --- | --- |
| CORE-04-A 无 React 环境用 fake Runtime 走完四种序列，快照正确，旧轮不覆盖新轮 | PASS | `presentation/companionPresenter.test.ts`：fake Runtime 精确控制流式 / 完成 / 失败 / 取消 / 旧轮迟到；断言快照消息序列、`sending`、错误可见与旧轮丢弃 |
| CORE-04-B 快照稳定性：无变化同一引用，增量只产生等量变更 | PASS | 同文件「快照稳定」用例：连续两次 `getSnapshot()` 同引用；一次增量恰好一次通知、一个新对象；重复读取不再变化 |
| CORE-04-C Hook 瘦身可度量：不 import `services/` 实现模块，`useCompanionSession` ≤ 150 行 | PASS | `kernel/architecture.test.ts` CORE-04 门禁：三个 Hook 适配器无 `services/` import；`useCompanionSession.ts` 65 行；含突变断言（real `useRemoteAccess` 仍被检出，证明扫描非空跑） |
| CORE-04-D 订阅生命周期：挂载/卸载/重开与 StrictMode 双次挂载无重复订阅/提交/泄漏计时器；dispose 后迟到事件不更新快照 | PASS | `companionPresenter.test.ts`：`start()` 幂等返回同一 Promise；订阅卸载后不再通知；`dispose()` 后迟到 delta/settle 不改快照。`voicePresenter.test.ts`：`close()`/`dispose()` 后重复 close 不产生通知；`useVoiceConversation.integration.test.ts` 卸载不泄漏计时器 |
| CORE-04-E 语音打断：重新开口触发 Runtime cancel 与 TTS stop，STT 继续接收；片段标 interrupted 不伪装完整 | PASS | `voicePresenter.test.ts`（fake STT/TTS）：开口 → 本轮请求 abort（会话层据此触发 Runtime cancel）且 `TTS stop`；注入计时器推进后 STT 重新 start、新片段继续累积；未调用 `onPlaybackComplete`，不当作完整播放。片段落库为 `interrupted` 的端到端语义由 kernel 集成测试覆盖（见下） |
| CORE-04-F 现有 UI 行为不回归：发送、流式展示、错误后重发、模式设置反馈与迁移前一致 | PASS | `hooks/useCompanionSession.integration.test.ts`（22）与 `hooks/useCompanionSession.memoryV2.test.ts`（10）断言未改，改由「生产 Presenter + 薄 Hook」共同满足；`hooks/useVoiceConversation.integration.test.ts`（3）同理 |

## 命令与退出码

命令从 `aika-crossplatform/` 运行；未执行全仓测试、全局 tsc 之外的构建或 Tauri 打包。

```text
npx vitest run src/hooks/useCompanionSession.integration.test.ts src/hooks/useCompanionSession.memoryV2.test.ts src/hooks/useVoiceConversation.integration.test.ts src/presentation/companionPresenter.test.ts src/presentation/voicePresenter.test.ts src/kernel/architecture.test.ts src/app/plugins/plugins.test.ts src/app/composition.test.ts src/services/runtime/companionRuntime.test.ts src/services/runtime/providerAdapter.test.ts src/services/runtime/provider.conformance.test.ts src/services/memory/memoryStore.conformance.test.ts src/services/context/contextSource.conformance.test.ts src/services/context/contextAssembler.test.ts src/services/memory/writeback.test.ts src/services/memory/memoryRepository.test.ts src/services/storage/storageCompatibility.test.ts src/services/storage/storage.conformance.test.ts src/services/providerClient.test.ts
```

- 退出码 **0**：**19 文件 / 215 测试通过**。
- 其中 CORE-04 新增 2 文件 / 10 测试；`architecture.test.ts` 由 8 增至 14 测试（新增 CORE-04 门禁与突变）。

### 静态门禁与突变

`kernel/architecture.test.ts` 在生产源码上执行：

- Hook 适配器（`useCompanionSession` / `useVoiceConversation` / `usePresenterSnapshot`）不得出现 `services/` import；`useRemoteAccess` 仍 import services，证明扫描有效。
- `presentation/` 下不得出现 React import；`app/kernelContext.tsx` 与组合根加入 `registry.resolve` 白名单。
- `useCompanionSession.ts` 行数 ≤ 150。
- CORE-03 的 Provider 调用门禁扫描范围由「hooks」扩到「hooks + presentation」，并兼容 Presenter 里的 `function sendViaLegacy` 隔离分支；突变注入 `streamChat` / 别名 `chat` / 裸 `sendChat` 均被检出（既有断言保留）。

## 与既有测试的关系（迁移说明）

CORE-04 把编排从 Hook 搬进 Presenter，因此三条 Hook 集成测试的实现细节改为：`vi.mock(app/kernelContext)` 把 `useService` 指向测试里构造的**生产 Presenter**，React 替身补 `useSyncExternalStore`。**断言内容未放宽**：发送、流式、错误后重发、模式保存失败反馈、记忆迁移/确认/删除/检索、主动 tick 配额等原样保留，现在同时覆盖 Presenter 行为与 Hook 适配层。

- 唯一的行为性断言调整：主动消息 tick 由「stub `window.setInterval`」改为「注入 `interval` 端口」。原因是 Presenter 不依赖 `window`（多宿主前提），计时器改由依赖注入；断言仍验证「tick 由 Runtime 落库、遵守配额」。
- 未删除任何既有测试文件。

## 共享接口影响与集成登记

- 新增展示层 token（`presentation.companion` / `presentation.voice`）与 `KernelProvider` / `useService`；Presenter 契约沿用 [前端架构](../../frontend/ARCHITECTURE.md)，仅将文档中的 `setMode(config)` 落为 `setModeConfig(config)`（语义相同，名称可调）。
- SPEC 图里的 `VoicePresenter.startListening/stopListening` 落为 `open/close`（`startListening` 是 `open` 建立引擎并开听，`stopListening` 是 `close`）；`interrupt` / `getSnapshot` / `subscribe` / `dispose` 名称与语义不变。命令按「名称可调、语义与 AC 不可省略」处理。
- `CompanionPresenter` 暴露的快照在原契约字段外补充了 `provider / memories / proactive / voiceBackend / stickers / relationship / summary / ready / storageKind / storageError / keyIsSecure` 等界面既有字段；命令签名沿用现有 Hook（`send(content, source, onPartial?, request?)` 等），消费者无需改调用点。
- 过渡件：Presenter 在 legacy 模式下仍用 `activeRuntimeServices` + `providerClient`；CORE-06 删除。展示插件不声明硬依赖，配合组合根兜底保证「内核启动失败仍能渲染并显示存储故障」。
- 受影响消费者：前端 Hook/组件、Remote 手机入口、后续 CORE-05 能力插件。登记到 [INT-01](../../integration/SPEC.md)；本阶段只证明模块编排与快照契约。
- FE-01 与本 SPEC 交付范围重叠：按 SPEC 约定，**Presenter 与 Hook 适配由 CORE-04 交付**，FE-01 只做视图消费与验收，不重复实现；本次未执行 FE-01。

## 类型与遗留

- `npx tsc --noEmit` 新增代码零类型错误。仍存在 3 条**前序**错误，非本次引入：`hooks/useCompanionSession.integration.test.ts` 的 `MemoryRecord` 断言转换、`services/runtime/provider.conformance.ts` 的 `Array.prototype.at`（lib 目标）。按小阶段规则不把全局 tsc 当门禁，留待对应 SPEC/构建阶段处理。
- 真实 STT/TTS、真实模型质量、Tauri 装配、Remote 联调：NOT RUN（既有后置安排不变）。
- legacy 编排的删除、过渡转发与 `activeRuntimeServices` 的移除：CORE-06。

## 审阅与后续

- 执行者：模块自测 PASS。
- 原任务审阅：待审阅；CORE-01/02/03 的历史待审阅状态未自动升级。
- 下一份：CORE-05 插件契约与能力插件化。
