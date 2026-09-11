# CORE SPEC 执行索引

需求见 [模块 PRD](PRD.md)，方案与拆分依据见 [重构计划书](REFACTOR_PLAN.md)，接口见 [内核架构](ARCHITECTURE.md)，端口可替换性增量见 [端口一致性增量计划](CONFORMANCE_PLAN.md)。每次只下发一份；相关测试在本模块完成，不依赖真实 STT/TTS 服务或设备。

| SPEC | 交付 | 前置 | 状态 |
| --- | --- | --- | --- |
| [CORE-01](specs/CORE-01_KERNEL_REGISTRY.md) | Kernel / 只读注册表 / 作用域注册器 / 含 failed 的生命周期 / 零业务词汇门禁 | 无 | 已自测 4 文件 / 52 测试通过，静态门禁经突变验证；生产未接入（本阶段预期如此）；待审阅 |
| [CORE-02](specs/CORE-02_HOST_COMPOSITION.md) | 宿主插件与组合根，去掉全局嗅探 | CORE-01 | 已自测 7 条 AC 全 PASS；平台嗅探 6 处→1 处；storage/secrets 各 2 个实现跑同一份用例包；真实 Tauri 装配 DEFERRED 至 INT-01；待审阅 |
| [CORE-03](specs/CORE-03_RUNTIME_SERVICE.md) | Runtime 服务化，对话编排单一化 | CORE-02 | A–I 九条 AC 自测 PASS；定向 16 文件 / 189 测试通过；默认 kernel，翻转后 5 文件 / 69 测试通过，显式 legacy 可回退；待审阅 |
| [CORE-04](specs/CORE-04_PRESENTER_ADAPTER.md) | Presenter 层，Hook 降级为 Adapter | CORE-03 | A–F 六条 AC 自测 PASS；`useCompanionSession` 由 928 行降到 65 行且零 `services/` 实现依赖；两个 Presenter 在无 React 的 node 环境跑通；待审阅 |
| [CORE-05](specs/CORE-05_PLUGIN_CAPABILITY.md) | 插件契约、既有能力插件化、扩展点验证 | CORE-04 | A–G 自测 PASS；voice/stickers 能力插件 + 示例插件；输入与输出用例包各两个真实实现全绿；待审阅 |
| [CORE-06](specs/CORE-06_DECOMMISSION.md) | 旧路径下线、开关移除、共享契约更新 | CORE-05 | A–E 自测 PASS；legacy 编排与 `core.orchestrator` 已删；`CONTRACTS.md` 冻结内核契约；触发 INT-01；待审阅 |
| [CORE-07](specs/CORE-07_PORT_SWAPPABILITY.md) | 端口一致性与实现可替换性收口 | CORE-06 | A–F 自测：替换矩阵（7 端口全部有可比对象）、逐端口突变验证、切换零改动证据均 PASS；`ContextSource` 仍只有 1 真实实现＋1 替身，证据弱；待审阅 |
| [CORE-08](specs/CORE-08_MESSAGE_DELETION.md) | `AikaStorage` 消息删除端口（重试/撤回/Rewind 的前置） | CORE-07 | 已自测 A–E 全 PASS；两实现跑同一份用例包 36 测试通过，两次突变各命中对应用例；真实 plugin-sql 执行留 INT-01；待审阅 |

2026-09-11 的输出侧补齐另有一份[变更记录](reports/CORE-05G_OUTPUT_CHANGE_RECORD.md)，只列改了哪些文件、为什么，不重复 AC 证据。

CORE-02 已有 [验收报告](reports/CORE-02_ACCEPTANCE.md)：组合根与宿主插件落在 `src/app/`（不在 `src/kernel/`，否则撞 CORE-01-C）。CORE-01 已有 [验收报告](reports/CORE-01_ACCEPTANCE.md)：只新增 `src/kernel/`，现有文件零改动，内核 token 实例数为 0。CORE-03 已有 [验收报告](reports/CORE-03_ACCEPTANCE.md)：编排迁移、后台维护、错误处理、三类端口一致性用例已自测通过，默认切至 kernel。CORE-04 已有 [验收报告](reports/CORE-04_ACCEPTANCE.md)：编排搬进 `src/presentation/` 的两个 Presenter，Hook 降为订阅/派发适配器（`useCompanionSession.ts` 65 行、零 `services/` 实现依赖），Presenter 在无 React 的 node 环境跑通流式/完成/失败/取消与语音打断；默认 kernel、显式 legacy 仍可回退。CORE-05 已有 [验收报告](reports/CORE-05_ACCEPTANCE.md)：voice / stickers 能力插件 + 示例扩展点；能力缺失降级与插件隔离门禁；语音输入用例包由 webSpeech 与本地 Whisper 两个真实实现全绿；输出用例包由 `webSpeechOutput` 与 `cloudTtsOutput` 两个真实实现全绿（第二实现 2026-09-11 从 `stash@{0}` 的未跟踪提交取回，原 BLOCKED 解除）。CORE-06 已有 [验收报告](reports/CORE-06_ACCEPTANCE.md)：legacy 编排、`core.orchestrator` 开关与相关过渡转发已删除，Runtime 由展示插件注入；providerClient 调用方收敛到 Runtime 适配器与记忆抽取；[共享契约](../modules/CONTRACTS.md) 冻结内核契约；**触发 INT-01**。CORE-07 已有 [验收报告](reports/CORE-07_ACCEPTANCE.md)：七个端口的替换矩阵（消费侧场景逐字相同、实现选择只经组合根）与逐端口突变验证全绿，`git diff` 证据证明切实现只动宿主插件选择文件；输出侧 `SpeechOutputEngine` 已于 2026-09-11 补齐第二实现并换上两实现一致性断言（随 CORE-05-G 解除 BLOCKED）；`ContextSource` 仅一真实实现、证据弱，仍如实标注。CORE-03 是本模块的风险集中点：它把 `useCompanionSession.send()` 里的编排换成已验收的 `CompanionRuntime`。在它通过之前，其余 SPEC 不得声称「编排已统一」。CORE-06 未执行则本模块不算完成——两条路径长期共存是最坏的中间态。CORE-07 回答的是另一个问题：CORE-05 证明「加能力不改内核」，CORE-07 证明「换实现不改消费侧」；后者才说明这些端口的抽象是对的。
