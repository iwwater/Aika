# 集成验收 SPEC（不属于模块小阶段）

仅在必须验证跨模块协作，或明确定义的大任务/里程碑完成后执行。单个 SPEC 完成不自动触发全流程测试。小阶段不被这里的全仓/硬件检查阻塞；“模块通过、集成未测”必须明确区分。

| 阶段 | 前置 | 验收 |
| --- | --- | --- |
| INT-01 文本与接口 | LLM 对应小阶段、FE 对应小阶段完成；共享契约变更也触发针对性部分 | 生产 UI→Runtime→Provider/Storage；三模式、流式展示、取消/迟到、持久化、手机 Remote 共用 PC Runtime。可先用协议 fixture 测连接，不伪称真实 Provider 质量通过 |
| INT-02 语音联动（DEFERRED） | STT/TTS 模块通过，用户恢复真人语音验收 | Mic→STT→LLM→TTS；20 轮固定台词，10 次真实开口打断，耳机/外放各 10 次无自回声误打断；测 SpeechEnd→FirstAudio 及首词截断，目标参照旧真人验收清单 |
| INT-03 发布门禁 | 本轮所需 INT-01/02 范围明确 | 执行全量 npm test、npm run build；涉及桌面交付时 cargo test 与 tauri build，安装启动/重开回归；后置语音不可写成通过 |

集成报告记录受影响模块版本、接口版本、设备/服务、实际命令及退出码。不要求等到 LLM 所有未来小阶段都开发完才做一次必要集成，也不每完成小阶段就自动全量测试。

旧 [真人验收清单](../archive/stages/HUMAN_ACCEPTANCE.md) 保留作为后置指标来源。新增模块范围不自动解除用户已确定的 DEFERRED 项。

## CORE-03 消费者兼容登记（INT-01 待执行）

CORE-03 已完成模块自测，默认编排切为 kernel，仍保留显式 legacy 回退。模块证据见 [CORE-03 验收报告](../core/reports/CORE-03_ACCEPTANCE.md)。

| 兼容增量 | 受影响消费者 | INT-01 检查 |
| --- | --- | --- |
| `ChatMessage.runtimeTurnId?: string`，原 `turnId?: number` 不变 | 前端桥接、Remote 手机入口、消息存储 | 旧数据缺省字段、双 id 透传及取消归属 |
| `SubmitRequest.voiceTurnId?: number` 与语音交付回执 | 前端/TTS 桥接、Remote | 生成与交付分离，失败/超时保留 interrupted/unknown |
| `RuntimeGenerateInput.source?: TurnSource` | RuntimeProvider adapter 与替代 Provider | 旧调用可缺省；主动消息只落 assistant 历史 |
| kernel 后台 MemoryWriteback 与动态关闭维护 | LLM-04 后台维护、前端记忆开关 | 避免重复维护；关闭后在途候选/摘要不继续写入 |
| 默认 kernel、显式 legacy、设置仅启动读取 | 桌面/浏览器组合根与 Remote | 实际宿主启动、回退及界面消费兼容 |

以上集成检查均为 NOT RUN；本次没有启动真实模型、音频设备或 Tauri 产品构建。

## CORE-04 消费者兼容登记（INT-01 待执行）

CORE-04 把会话/语音编排从 `hooks/` 搬进 `src/presentation/`，Hook 降为订阅与派发适配器；模块证据见 [CORE-04 验收报告](../core/reports/CORE-04_ACCEPTANCE.md)。

| 兼容增量 | 受影响消费者 | INT-01 检查 |
| --- | --- | --- |
| 新增 `presentation.companion` / `presentation.voice` token、`KernelProvider` / `useService` | `main.tsx`、Hook 适配器、后续能力插件 | 实际宿主启动后 Presenter 从注册表解析；装配失败时 `KernelProvider` 兜底仍能渲染并显示存储故障 |
| `CompanionPresenter` 快照在契约字段外补充既有界面字段；`setMode(config)` 落为 `setModeConfig` | 前端 Hook/组件、Remote 手机入口 | 界面消费字段与命令不回退；Remote 发送路径仍共用 PC Runtime |
| `VoicePresenter` 用注入的计时器/引擎端口，不依赖 `window` | 语音页组件、桌面 WebView | 真实 WebView 计时器与 TTS 队列仍工作，打断链路未退化 |
| legacy 编排仍由 `activeRuntimeServices` + `providerClient` 承载 | 组合根、前端 | 显式 legacy 回退与默认 kernel 行为一致；leak 到 CORE-06 删除 |

以上集成检查均为 NOT RUN；本阶段没有启动真实模型、音频设备或 Tauri 产品构建。

## CORE-05 消费者兼容登记（INT-01 待执行）

CORE-05 完成能力插件化与扩展点验证；模块证据见 [CORE-05 验收报告](../core/reports/CORE-05_ACCEPTANCE.md)。其中 CORE-05-G 的输出侧原为 BLOCKED，2026-09-11 取回第二输出实现 `cloudTtsOutput` 后解除；该实现全部证据走假 `HttpFetch`，**真实云 TTS 仍是 NOT RUN**。

| 兼容增量 | 受影响消费者 | INT-01 检查 |
| --- | --- | --- |
| `createAikaKernel` 默认装配 `capabilityPlugins()`（此前默认空） | `main.tsx`、桌面/浏览器实际入口 | 真实宿主启动即走 kernel 编排；`core.orchestrator=legacy` 仍可回退；首屏、发送、错误重发与记忆迁移无回归 |
| 新增 `voice.engines` / `stickers.library` / `llm.memoryAccess` token | 前端 Hook、Presenter、后续能力插件 | 能力缺失时对应 token 不注册、界面隐藏入口、不弹错误 |
| `presentationPlugin` 改为 `optional` 能力依赖并从注册表取存储 | 组合根、展示层 | 装配失败时兜底 Presenter 仍能显示存储故障 |
| `memoryPlugin` 增加删除联动扇出 | 前端记忆列表、摘要显示 | 删除记忆后摘要整段失效且界面同步清空 |
| `whisperInput` 新增可选 `ports` 注入口 | 本地语音链路 | 生产默认路径不变，真实麦克风行为无回归 |
| 语音输入用例包两实现全绿；输出用例包仅单实现 | STT / TTS 桥接 | 第二输出实现恢复后补跑 `speechOutput.conformance.test.ts` |

以上集成检查均为 NOT RUN；本阶段没有启动真实模型、音频设备、云 TTS 或 Tauri 产品构建。

## CORE-06 触发 INT-01（待执行）

CORE-06 删除生产编排路径并冻结共享契约，按 SPEC 属于 INT-01 的触发条件。模块证据见 [CORE-06 验收报告](../core/reports/CORE-06_ACCEPTANCE.md)。

| 兼容增量 | 受影响消费者 | INT-01 检查 |
| --- | --- | --- |
| legacy 编排分支、`core.orchestrator` 开关、`activeRuntimeServices` 过渡槽全部删除 | 组合根、前端 Hook/Presenter | 真实宿主启动即走唯一 Runtime 路径；旧库里残留的 `core.orchestrator` 值不报错；界面发送、流式、取消、错误重发无回归 |
| `openStorage` / `activeNotifier` 过渡转发删除；运行时与通知改为构造参数注入 | 展示层、宿主插件 | 装配失败时界面经兜底 Presenter 显示存储故障，不退回浏览器实现、不白屏 |
| `providerClient` 调用方收敛为 Runtime 适配器 + 记忆抽取；`testProvider` 改为 `ProviderProbeToken` | 设置页、LLM 适配层 | 设置页「测试连接」仍工作；无第二处 Provider 出口 |
| `docs/modules/CONTRACTS.md` 新增内核契约（v1） | 全部模块 | 逐条核对注册表/插件、`resolve` 位置、token 分散所有权、能力缺失降级、`runtimeTurnId` 并存规则 |
| 云端合成没有用户入口，`note` / `degraded` 被丢弃；真实云 TTS 未试听 | TTS 桥接 | 设置页接上后做一次真实试听，验证音质、延迟与计费，并确认降级当错误显示 |

以上集成检查均为 NOT RUN；本次没有启动真实模型、音频设备、云 TTS 或 Tauri 产品构建，也未执行全量回归与打包（按 INT-03 另行安排）。
