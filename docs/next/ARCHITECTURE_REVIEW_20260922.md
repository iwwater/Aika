# 后续版本工程架构核对

日期：2026-09-22。范围：Windows 生产入口、0.65 包组合、0.7 连续性模块及后续可复用代码。方法：静态调用链检索、实现与测试对照、0.7 定向回归；不是全仓安全审计或版本人工验收。工作树含其他任务的未提交实现，本报告不修改源码及既有验收结论。

目录：[结论](#1-结论) · [问题](#2-直接影响后续开发的问题) · [复用](#3-可以复用的架构) · [门槛](#4-后续接入门槛) · [验证](#5-验证记录)

## 1. 结论

分层方向可保留：轮次/取消、Provider、多源配置、数据存储、表现适配分别有明确入口；连续性存储使用同一个 SQLite，已有配对隔离、版本检查和派生提交检查。**当前不能据此判定整体架构已经正确接通**。模块实现、受控模型脚本、正式桌面对话是三种不同证据。

0.7 索引和报告记录了 N07-00～05 的受控自动闭环；下列调用链缺口意味着这些结论不能自动升级为“用户正常聊天已具备完整连续性”。0.65 早先评审中的纯元数据包问题已有变化：普通包现有 execute，更新暂存和备份序列化也已修改，不能机械复用旧结论。

## 2. 直接影响后续开发的问题

所有源码链接以当前文件为准，不依赖易漂移行号。

| ID / 优先级 | 源码证据与触发条件 | 实际影响 | 所属修复边界与验收 |
| --- | --- | --- | --- |
| AR-01 / P1 | [trial-backend](../../windows/code/desktop-pet/app/trial-backend.ts) 打开 CharacterPackStore/ContinuityMemoryStore 并传给管理台；创建 ObservedTrialMemory 时仅传 knowledge；[Composer](../../windows/code/desktop-pet/memory/continuity-context.ts) 的生产使用检索未发现 app/core 调用 | 通过管理 API 保存的 Soul/关系不等于普通桌面对话会读到；真实脚本自行 compose 后直接调用 transport，绕过桌面组合根 | 0.7 正式 ContextSource 接线：实际 BackendSession→Memory→DialogueProvider 请求必须含活动配对数据；关闭能力后保持基础对话；切换/遗忘后重验 |
| AR-02 / P1 | [appendCompanionEvent](../../windows/code/desktop-pet/memory/character-pack-store.ts)、[commitDerived](../../windows/code/desktop-pet/memory/continuity-memory-store.ts) 有实现；app/core 未发现调用；[真实脚本](../../windows/code/desktop-pet/tools/acceptance-next07-05.mjs) 手工 record 和 append | 正常聊天到 Companion Timeline、User Wiki/Soul 的后台沉淀链尚无这条生产接线证据；存储 API 测试不能证明自动记忆形成 | 0.7 在既有消息提交和 Memory 维护处接投影，幂等、重启恢复、取消/撤销后提交测试；不新增竞争队列 |
| AR-03 / P1 | [package-composition](../../windows/code/desktop-pet/kernel/package-composition.ts) 以 provider.adapterId === request.bindingId 选 Provider；未调用 [ProviderRuntime](../../windows/code/desktop-pet/plugins/provider-runtime.ts) | 合法 Binding ID 与 adapter ID 不同时无法调用；endpoint/model/key 由任意 input 提供，组合入口未落实 SourceInstance/ModelProfile 的唯一解析权威 | 0.65 接入契约修复：从真实 Binding 得到 ResolvedBinding，内部解析凭据和实例租约；同 adapter 两个 source、限流、切源和取消用例 |
| AR-04 / P1 | [trial-backend](../../windows/code/desktop-pet/app/trial-backend.ts) 静态导入连续性实现并无条件打开其表；[包构建](../../windows/code/desktop-pet/tools/build-next65.mjs) 未提供 0.7 独立连续性包 | “连续性是可选包”目前是目标；未安装时不携带其代码、不迁移其表尚不能由此入口保证 | 0.7 包交付/0.65 宿主适配：清洁安装缺连续性包仍运行，启用后生产接线可用，停用后来源失效 |
| AR-05 / P2 | [Composer](../../windows/code/desktop-pet/memory/continuity-context.ts) 使用码点数/4估计片段 token，按规范化全文去重；未包含系统/工具/当前输入/输出预留；[来源枚举](../../windows/code/desktop-pet/contracts/continuity-context.ts) 无独立 Character Wiki | 这是片段预算，不是模型完整输入硬上限；同事实不同措辞仍会重复；双 Wiki 全面召回尚需核对 | 0.7 Context 收口：复用实际 Provider 的完整请求计数，稳定事实 ID 去重，补 Character Wiki 路径；覆盖中英文、长当前输入、重复事实 |

对 AR-02 的否定结论限于本次检索的正式 app/core 接入路径；未来新增入口须附实际调用证据。AR-05 不宣称所有请求都会溢出，而是现有片段估算不能证明 RPD 的总预算约束。

## 3. 可以复用的架构

| 能力 | 实际文件 | 可复用边界 / 不能推导的结论 |
| --- | --- | --- |
| 唯一轮次与取消 | [turn-port](../../windows/code/desktop-pet/core/turn-port.ts)、[dialogue-pipeline](../../windows/code/desktop-pet/core/dialogue-pipeline.ts) | NextTurnPort 复用 TurnController；新输入不能另起竞争控制器；目前事件聚合不等于 token 级流式展示 |
| 连续性数据 | [character-pack-store](../../windows/code/desktop-pet/memory/character-pack-store.ts)、[continuity-memory-store](../../windows/code/desktop-pet/memory/continuity-memory-store.ts) | 同库、版本/配对/撤销边界可保留；同库本身不证明所有写入口有来源校验 |
| 感知 | [split-perception](../../windows/code/desktop-pet/providers/split-perception.ts)、[capture](../../windows/code/desktop-pet/media/capture.ts) | 已有音频和视觉拆分及取消；不是完整屏幕 OCR、授权窗口采集和主动陪伴产品 |
| 邀请策略 | [invitations](../../windows/code/desktop-pet/companion/invitations.ts) | 已有配额、间隔、时区和来源失效；需要适配用户×实例隔离，不能直接把屏幕观察写入长期记忆 |
| Work | [desktop-work](../../windows/code/desktop-pet/harness/desktop-work.ts)、[forwarding](../../windows/code/desktop-pet/harness/forwarding.ts) | 已有草稿/确认/回执；应扩 adapter，不能再造任务权威 |
| MCP | [harness-relay-mcp](../../windows/code/desktop-pet/tools/harness-relay-mcp.mjs) | 已确认任务的窄 relay；不等于任意 MCP 客户端/服务器生态已接入；协议版本实施时另核对 |
| 语音与桌宠 | [live-voice-turn](../../windows/code/desktop-pet/core/live-voice-turn.ts)、[wake-manager](../../windows/code/desktop-pet/app/wake-manager.ts)、[pointer-router](../../windows/code/desktop-pet/desktop/pointer-router.ts) | 可扩展已有采集、取消、唤醒及手势；物理设备和表现验收仍待做 |
| 分发 | [release-next65](../../windows/code/desktop-pet/tools/release-next65.mjs)、[release-doctor](../../windows/code/desktop-pet/tools/release-doctor.mjs) | 有清单/检查起点；清单与 hash 不等于完整安装器、签名、数据恢复及供应链信任 |

## 4. 后续接入门槛

- 0.7：AR-01/02/04 是产品连续性闭环的直接门槛；AR-03 是通过独立包接入的直接门槛；AR-05 在预算与召回验收中闭环。
- 0.8：感知 adapter 可独立开发；正式按包/Flow 接入前完成 AR-03。依赖用户画像/共同经历的主动陪伴须完成 AR-01/02/04，并覆盖来源撤销。
- 0.9：可独立验证语音/表现 adapter；必须复用唯一轮次和同一取消信号，完成直接相关设备验收后才能交付体验结论。
- 1.0：汇总自动与人工阻塞项，不把旧报告 PASS 当新修订证据；0.65 的 32 项仍有可追溯处置。

需求可继续撰写，独立模块可按直接依赖推进；这些门槛不要求把所有不相关人工项目先清零。

## 5. 验证记录

本轮运行 `npm run test:next07`（包含 TypeScript 构建），50/50 PASS，退出码 0。用生产 `executePackageCapability` 加仅提供已解析 Provider 列表的 host stub 做 AR-03 定向复现：bindingId=`dialogue.main` 返回“no executable adapter”，改传 adapterId=`normal.llm` 才能执行；该复现只证明组合入口身份混用，不冒充宿主集成测试。未调用真实模型、设备或外部工具；未运行全仓测试。新增版本 PRD 采用文件链接、需求编号、验收映射检查，不用文档检查代替产品测试。

文档检查：四版 RPD、路线图、文档入口和本报告的 165 个本地链接/锚点有效；0.8/0.9/1.0 分别有 9/9/8 个唯一需求 ID，均在需求表映射验收项；0.7 保留 N07-R01～10 和 07-A～K。定向 `git diff --check` 通过。新增文档只有需求/验证设计，不新建产品实现或改动已有 SPEC 通过状态。
