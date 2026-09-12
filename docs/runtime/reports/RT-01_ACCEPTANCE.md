# RT-01 · v0.5 契约与单 Runtime 宿主边界 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全部通过，待人工审阅；真实宿主关窗/重启回归归 INT-01 真实轨）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/domain/sourceEnvelope.ts`（新增） | `SourceEnvelope`（version 1：principalId/accountRef/conversationId/threadId?/origin/messageId/receivedAt/trust）、`SourceOrigin` 八值、`SourceTrust` 三级（authenticated 带不导出 brand——只有认证端口能构造；`localTrust()`/`unverifiedTrust()` 是仅有的两个工厂）、`desktopEnvelope()` 桌面兼容适配（principalId/accountRef=local）、`unknownEnvelopeForLegacy()`（历史消息 origin=unknown、归属空串、unverified）、`messageDedupeKey()`（幂等键）、`legacySourceOrigin()`（旧 TurnSource 只加映射不改语义） |
| `aika-crossplatform/src/domain/identity.ts`（新增） | identity/conversation/thread/runtimeTurn/agentSession/deviceSession 六个 version 化类型、`IDENTITY_CONTRACT_SCHEMA_VERSION=1`、`LOCAL_PRINCIPAL_ID`/`LOCAL_CONVERSATION_ID`、`HostCapabilityMatrixV1`（协议版本 + 宿主 epoch + 能力矩阵）、`buildCapabilityMatrix()`（由插件清单投影，domain 不依赖 kernel） |
| `aika-crossplatform/src/services/runtime/hostLifecycle.ts`（新增） | `createHostLifecycle()`：可注入心跳/租约（leaseMs、recoveringMs、clock/timers/epoch/idFactory），三态 online/offline/recovering 状态机 + 订阅；`markStopping()` 立即 offline；epoch 默认启动生成、存活期恒定 |
| `aika-crossplatform/src/app/runtimeFacade.test.ts`（新增） | RT-01-B 架构门禁：生产源码使用 `RuntimeToken` / import `companionRuntime` 的白名单（composition、runtimePlugin、presentationPlugin、runtime/tokens、providerAdapter、provider.conformance），去注释后匹配 |
| `docs/modules/CONTRACTS.md` | 登记「2026-09-13，RT-01 身份/来源/宿主契约」追加表 |

既有生产源码零改动：CompanionRuntime / submit / cancel / 存储契约 / TurnSource 一字未动（RT-01 是契约冻结 + 兼容适配，接线归 RT-02）。

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/domain/sourceEnvelope.test.ts src/domain/identity.test.ts src/services/runtime/hostLifecycle.test.ts src/app/runtimeFacade.test.ts` | 0 | 4 文件 20 测试全过 |
| `npx vitest run src`（里程碑回归一次，含 companionRuntime 既有提交/取消/存储契约用例） | 0 | 94 文件 1151 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

### RT-01-A：旧桌面提交/取消/存储契约无回归

本次未改任何生产源码；`companionRuntime.test.ts`（submit/settle/cancel/storage 竞争/单活动轮）、`useCompanionSession` 集成用例、`provider.conformance.ts` 全部原样通过（全量 1151 内）。`legacySourceOrigin` 映射测试证明 text/voice/proactive 语义原样保留。

### RT-01-B：外部入口只能调用同一 Runtime facade

- 现状核实：生产源码 import `companionRuntime` 本体的只有 tokens/providerAdapter/provider.conformance/runtimePlugin（类型与装配）；`RuntimeToken` 只由 runtimePlugin provide、presentationPlugin/presentation 层经 DI 消费。Hook（UI）不直接 import Runtime facade——它拿 Presenter。
- 门禁：`runtimeFacade.test.ts` 两个用例当场红于任何绕过 facade 的新生产 import（未来 ACP/远程入口贡献者要么走 facade、要么进白名单过审阅）。ACP 入口本身尚不存在（AGT Wave 6），不存在第二编排可被断言。

### RT-01-C：旧消息来源 unknown、不伪造账户归属；新字段显式兼容映射

- `unknownEnvelopeForLegacy`：origin=unknown、trust=unverified、principalId/accountRef 为空串（「历史消息投影为 unknown」用例）。
- `desktopEnvelope`：本地主体显式为 `local`，trust=local（本地可信 ≠ 已认证）；「桌面提交包成信封」逐字段断言。
- `messageDedupeKey`：同入口同 messageId 同键、跨入口不碰撞（幂等键用例）。
- 信封全部字段带 `version: 1`；identity 六类型同（identity.test 逐类型断言包含关系）。

### RT-01-D：关闭/重启宿主可观测 offline/recovering，不宣称云端接管

- `hostLifecycle.test.ts` 8 用例：租约过期→offline（订阅者收到通知）；持续心跳不误报；离线后 markAlive→recovering→确认窗口后 online；recovering 中再失约→offline；markStopping 立即 offline；重启=新实例新 epoch；dispose 后无定时器无状态变化。
- 状态机只描述本进程存活，无任何「云端接管」语义字段；真实关窗/重启回归列 INT-01 真实轨。

## 共享接口影响与消费者

- 全部为新增类型/函数/测试，无既有消费者受影响（全量回归通过）；CONTRACTS.md 已登记消费者矩阵（RT-02/03、AGT-01、GW-04、GW-05）。
- 门禁测试引入两条白名单规则，未来外部入口贡献者需显式过审阅。

## 未执行 / 待人工

- 真实宿主（Tauri 桌面）关窗/重启下 HostLifecycle 的表现未验证——需要真实宿主环境，列 INT-01 真实轨 NOT RUN。
- 信封尚未接入生产 submit 链路（RT-01 只冻结形状与适配器；RT-02 负责真实会话隔离时接线）。在 RT-02 通过之前，外部入口保持关闭——这不是本份的缺陷而是执行计划的安排。
- 能力矩阵的宿主级装配（从真实 kernel describe() 喂数）未接线，归 GW/宿主集成时使用；`buildCapabilityMatrix` 已用假插件清单验证投影逻辑。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工，不代表发布可用。
