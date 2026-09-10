# CORE SPEC 执行索引

需求见 [模块 PRD](PRD.md)，方案与拆分依据见 [重构计划书](REFACTOR_PLAN.md)，接口见 [内核架构](ARCHITECTURE.md)，端口可替换性增量见 [端口一致性增量计划](CONFORMANCE_PLAN.md)。每次只下发一份；相关测试在本模块完成，不依赖真实 STT/TTS 服务或设备。

| SPEC | 交付 | 前置 | 状态 |
| --- | --- | --- | --- |
| [CORE-01](specs/CORE-01_KERNEL_REGISTRY.md) | Kernel / 只读注册表 / 作用域注册器 / 含 failed 的生命周期 / 零业务词汇门禁 | 无 | 已自测 4 文件 / 52 测试通过，静态门禁经突变验证；生产未接入（本阶段预期如此）；待审阅 |
| [CORE-02](specs/CORE-02_HOST_COMPOSITION.md) | 宿主插件与组合根，去掉全局嗅探 | CORE-01 | 已自测 7 条 AC 全 PASS；平台嗅探 6 处→1 处；storage/secrets 各 2 个实现跑同一份用例包；真实 Tauri 装配 DEFERRED 至 INT-01；待审阅 |
| [CORE-03](specs/CORE-03_RUNTIME_SERVICE.md) | Runtime 服务化，对话编排单一化 | CORE-02 | **执行中**：装配与双路径切换已完成，A/D 两条 AC PASS，B/C/E/F/G 中 4 条 NOT RUN；默认编排仍为 legacy，未通过 |
| [CORE-04](specs/CORE-04_PRESENTER_ADAPTER.md) | Presenter 层，Hook 降级为 Adapter | CORE-03 | 未开始 |
| [CORE-05](specs/CORE-05_PLUGIN_CAPABILITY.md) | 插件契约、既有能力插件化、扩展点验证 | CORE-04 | 未开始 |
| [CORE-06](specs/CORE-06_DECOMMISSION.md) | 旧路径下线、开关移除、共享契约更新 | CORE-05 | 未开始 |
| [CORE-07](specs/CORE-07_PORT_SWAPPABILITY.md) | 端口一致性与实现可替换性收口 | CORE-06 | 未开始 |

CORE-02 已有 [验收报告](reports/CORE-02_ACCEPTANCE.md)：组合根与宿主插件落在 `src/app/`（不在 `src/kernel/`，否则撞 CORE-01-C）。CORE-01 已有 [验收报告](reports/CORE-01_ACCEPTANCE.md)：只新增 `src/kernel/`，现有文件零改动，内核 token 实例数为 0。CORE-03 有 [执行中报告](reports/CORE-03_ACCEPTANCE.md)，其中「明天从这里继续」列出剩余五项。CORE-03 是本模块的风险集中点：它把 `useCompanionSession.send()` 里的编排换成已验收的 `CompanionRuntime`。在它通过之前，其余 SPEC 不得声称「编排已统一」。CORE-06 未执行则本模块不算完成——两条路径长期共存是最坏的中间态。CORE-07 回答的是另一个问题：CORE-05 证明「加能力不改内核」，CORE-07 证明「换实现不改消费侧」；后者才说明这些端口的抽象是对的。
