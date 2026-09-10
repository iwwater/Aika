# CORE-03 验收报告 · Runtime 服务化与编排单一化

- SPEC：[CORE-03_RUNTIME_SERVICE.md](../specs/CORE-03_RUNTIME_SERVICE.md)，AC A–I 共九项。
- 前序实现：`47dad2a` Runtime 装配、`aa2200a` 双路径切换；本次在当前工作区续做。
- 状态：**模块自测 PASS，待审阅；集成未验收**。
- 依赖：Hook 使用生产 Runtime、Provider adapter 与 ContextAssembler；网络、React 渲染、时钟和语音回执用 fixture。存储契约使用生产实现，SQLite 由 `node:sqlite` 真引擎执行。没有调用真实模型或音频设备。

## 本次补齐

1. kernel 分支不再读写 `busyRef/requestSeqRef/activeRequestRef`；新 submit 由 Runtime 取消旧轮。Hook 只按 Runtime turnId 过滤事件及异步存储快照，旧轮结算不能覆盖新轮 pending 或 sending。
2. 主动消息走同一个 Runtime，`source: proactive`；配额、冷却、理由选择仍在原 domain。主动提示不伪装成用户历史。Runtime 结算后同步消息时间戳，避免冷却使用旧状态。
3. Provider 的失败、真实上下文预算失败和 `persisted: false` 均可展示；错误消息本身写库失败时仍保留在内存界面，不静默停在 pending。未改变 Runtime 已验收的状态机及 persisted 标志语义。
4. V2 记忆候选接入已有 MemoryWriteback 队列，复用重试与 repository 去重。抽取/摘要异步执行；关闭维护立即更新当前开关，阻止在途抽取与摘要的迟到写入。未完整交付的语音不启动维护。
5. Provider adapter 支持输入取消、预先取消及迭代器提前 return 的网络取消；终止后不再积累迟到片段。
6. 新增 Provider、MemoryV2Store、ContextSource 三份共用用例包，并增加 hooks Provider 调用 AST 门禁与突变测试。

## 逐条 AC

| AC | 状态 | 证据 |
| --- | --- | --- |
| A 双路径等价 | PASS | `useCompanionSession.integration.test.ts`、`useCompanionSession.memoryV2.test.ts` 保留 legacy/kernel 参数化，共用既有断言；本次新增缺口测试仅跑 kernel |
| B turn 生命周期 | PASS | Hook 新测试验证流式气泡、新 submit 取消旧轮、迟到内容不落新轮、旧结算不清新轮 sending/pending；既有文本测试验证不依赖播放落库；`companionRuntime.test.ts` 通过 |
| C 交付语义 | PASS | Hook complete/interrupted 既有测试 + failed/timeout 新测试；真实 Runtime 配注入 timers 手动触发超时。failed/timeout 只保留 interrupted/unknown，迟到 complete 不改写；重复回执只启动一次维护 |
| D 数据兼容 | PASS | `storageCompatibility.test.ts` 与 `storage.conformance.test.ts`；两个生产存储实现验证 runtimeTurnId 与原 number turnId 并存，旧字段缺失不回填假值 |
| E 后台维护 | PASS | Hook 悬挂 extract/summarize 时正文先返回；关闭开关后候选/摘要不落库；V2 Hook 测试先注入写入失败、下一轮经 Writeback 重试，重复候选只保留一条；复用 `writeback.test.ts`、`memoryRepository.test.ts` |
| F 错误可见 | PASS | Hook 双路径 Provider 错误与重发；kernel 持续写库失败仍展示 STORAGE_FAILED 并释放 sending，存储恢复后可重发；40,000 字真实输入触发预算错误、Provider 零调用，短句可恢复 |
| G 唯一编排 | PASS | `kernel/architecture.test.ts` AST 扫描所有生产 hooks：Provider 调用仅限 sendViaLegacy 或主动消息的 services 条件 false 分支；kernel 函数无旧计数。测试覆盖别名直连和移走开关的突变 |
| H Provider 可替换 | PASS | 四种协议均经真实 providerClient + adapter 跑 `provider.conformance.ts`：累计增量顺序、唯一终包、统一错误码、在途/预先取消、提前 return；只替换 fetch fixture |
| I 记忆与来源可替换 | PASS | sqlite/local 记忆存储跑 `memoryStore.conformance.ts`：快照往返、幂等、删除与抑制、迁移版本、失败不改旧数据及恢复；searchIds 缺失显式声明并检查。memorySource+真实 repository 与确定性 stub 跑 `contextSource.conformance.ts`，均经真实 assembler 验证抛错/超时降级和迟到结果丢弃 |

## 命令与退出码

命令均从 `aika-crossplatform/` 运行；没有执行全仓测试、全局 tsc、产品构建或 Tauri 打包。

```text
npx vitest run src/hooks/useCompanionSession.integration.test.ts src/hooks/useCompanionSession.memoryV2.test.ts src/services/runtime/companionRuntime.test.ts src/services/runtime/providerAdapter.test.ts src/services/runtime/provider.conformance.test.ts src/services/memory/memoryStore.conformance.test.ts src/services/context/contextSource.conformance.test.ts src/services/context/contextAssembler.test.ts src/services/memory/writeback.test.ts src/services/memory/memoryRepository.test.ts src/services/storage/storageCompatibility.test.ts src/services/storage/storage.conformance.test.ts src/kernel/architecture.test.ts src/app/plugins/plugins.test.ts src/app/composition.test.ts src/services/providerClient.test.ts
```

- 退出码 **0**：**16 文件 / 189 测试通过**（默认值翻转之前，全部 A–I 证据齐备）。
- 默认值翻转后执行 `npx vitest run src/app/composition.test.ts src/hooks/useCompanionSession.integration.test.ts src/hooks/useCompanionSession.memoryV2.test.ts src/app/plugins/plugins.test.ts src/kernel/architecture.test.ts`，退出码 **0**：**5 文件 / 69 测试通过**。新增八项设置归一化、默认装配、显式 legacy 回退及启动后不热切换检查。

### 突变验证

临时修改生产源码，每次运行下列定向命令后以保存的原始字节恢复；未保留突变。

| 突变 | 命令 | 退出码 / 结果 |
| --- | --- | --- |
| Provider 错误码改为 BROKEN_PROVIDER | `npx vitest run src/services/runtime/provider.conformance.test.ts` | 1，正确检出 |
| localMemoryStore 的 save 不调用 backend.set | `npx vitest run src/services/memory/memoryStore.conformance.test.ts` | 1，正确检出 |
| memorySource 把真实命中裁为空数组 | `npx vitest run src/services/context/contextSource.conformance.test.ts` | 1，正确检出 |

恢复后上述三份用例均包含在 189 项通过的定向回归中。AST 门禁另外包含直连/别名/开关突变，属于正常测试的一部分。

## 默认值与兼容

A–I 自测 PASS 已记录。本次已将 `DEFAULT_ORCHESTRATOR` 从 legacy 改为 kernel；明确设置 legacy 仍必须回退，未配置/未知值采用默认值。组合根只在启动读取设置，运行中不热切换。回退测试结果见上方。

- `ChatMessage.runtimeTurnId?: string`、`SubmitRequest.voiceTurnId?: number`、sqlite `runtime_turn_id` 列和设置键均为前序 CORE-03 已有兼容增量，本次保留。
- 本次新增 `RuntimeGenerateInput.source?: TurnSource`，Runtime 传递来源、adapter 区分主动触发提示；可选字段保持既有 Provider 输入调用兼容。
- 受影响消费者：前端桥接、Remote 手机入口、LLM-04 后台维护、RuntimeProvider 实现。登记到 INT-01；本阶段只证明模块编排和端口契约。
- 端口用例证明行为契约，**不证明性能、并发度或宿主持久性等价**。ContextSource 只有一个真实来源加一个 stub，证据弱于两种真实存储实现。

## 迁移断言说明

本次未放宽既有断言。前序 CORE-03 的三处调整保留：完整语音 `completion` 从 undefined 改验非 interrupted；reply 返回值用 toMatchObject 容纳可选 envelope 字段；文本 Provider options 从完全缺失改验 voice turnId 缺失，以允许 AbortSignal。对应契约仍在两条路径共同执行，交付终态另有精确 completion/playbackStatus 断言。

## 审阅与后续

- 执行者：模块自测 PASS。
- 原任务审阅：待审阅；CORE-01/02 的历史待审阅状态未自动升级。
- 真实模型质量、真实 STT/TTS、Tauri 装配、Remote 联调：NOT RUN（既有后置安排不变）。
- 下一份：CORE-04 Presenter Adapter。本次只收口 CORE-03，legacy 删除仍归 CORE-06。
