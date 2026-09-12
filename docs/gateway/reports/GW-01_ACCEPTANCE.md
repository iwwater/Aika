# GW-01 · Channel Gateway 与可靠收发 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全部通过，待人工审阅；真实渠道适配器 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/domain/gateway.ts`（新增） | 版本化判别联合 `GatewayPayload`（text/voice/image/file/command）+ `GatewayInboundMessageV1`（messageId/平台账户/tenant/sender/chatId/threadId/isGroup/时间/附件引用）；`inboxKeyOf`（持久唯一键=平台账户+会话+messageId）；inbox 状态 received/accepted/running/completed/failed/unknown；`validatePayload`（附件大小上限 20MB、media type 白名单、未知类型拒绝）；`OutboundMessageV1`（目的地固定绑定、白名单投影文本、queued/sent/failed/unknown、attempts）；`MAX_OUTBOUND_ATTEMPTS=3`、`MAX_OUTBOX_PENDING=200`、`OUTBOX_TTL_MS` |
| `aika-crossplatform/src/services/gateway/channelGateway.ts`（新增） | `createChannelGateway`：ingest（校验→去重→先持久 received→每会话串行链处理）、`recover`（received 重处理=无副作用安全；running→unknown 绝不自动重跑；outbox TTL 淘汰）、`enqueueReply`（目的地固定绑定原请求）、`flushOutbox`（retry-after 遵守、重试上限、unknown 终态除非平台声明幂等键）、`inbox`/`outbox` 查询；`GatewayRuntimePort`/`GatewayTransport`/`GatewayBindingPort` 端口（Gateway 不 import 任何 LLM/Memory/Runtime 实现） |
| `aika-crossplatform/src/services/storage/contracts.ts` | `SETTING_KEYS.gatewayState` |
| `docs/modules/CONTRACTS.md` | 登记「2026-09-13，GW-01 渠道网关」追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/gateway` | 0 | 8 测试全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 102 文件 1212 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

### GW-01-A：重复入站只触发一次 Runtime；重启恢复不重复执行副作用

- 同 key 二次 ingest → `duplicate`，Runtime submit 仅一次（「重复入站只触发一次 Runtime」）。
- 持久唯一键跨实例生效：新实例同库再 ingest 同 messageId → duplicate。
- 提交 Runtime 后崩溃（running 未结算）→ `recover()` 标 unknown（`interrupted-before-settlement`），换上「被调用即爆炸」哨兵 Runtime 验证**绝不自动重跑**；received（未提交）→ 安全重走处理链。

### GW-01-B：附件大小/类型校验、未知类型拒绝；未授权群消息不入个人上下文

- 21MB voice → rejected；`application/x-msdownload` → rejected；audio/ogg → accepted。
- 第一版不做图像/转写理解：voice 受理后提交给编排的文本是「[voice 附件…，第一版不做理解]」的显式表示，不假装已理解。
- 未绑定发件人（含群消息）：绑定解析失败 → `sender-not-bound`，Runtime **零提交**——个人上下文入口在 Gateway 就关闭；群会话 conversationId 以 `gw:<platform>:<tenant>:<chatId>` 为界，永不映射到本地个人会话（RT-02 scope 语义）。

### GW-01-C：同会话有序、跨会话不串回复；重试耗尽有失败记录

- 同会话两条消息按到达顺序提交（每会话 ingest 串行链）。
- 回信目的地绑定原请求：outbox 每条带 `inReplyToKey` + 原 destination（platform/botAccount/tenant/chatId），LLM 正文无改收件人的通道。
- 重试：3 次 failed → state=failed、attempts=3、lastError 为最后一次传输错误；retry-after（nextAttemptAt）未到不重投。

### GW-01-D：适配器不能调用 LLM/Memory；不确定送达标 unknown

- 架构断言（测试内）：`channelGateway.ts` 生产源码不 import providerClient/memoryRepository/companionRuntime/knowledgeIndex——适配器与 Gateway 只见 `GatewayRuntimePort`/`GatewayTransport`/`GatewayBindingPort` 三个窄端口。
- `unknown` 不确认 → 不支持幂等键的平台标 unknown 终态（attempts=1 不再重试）；声明 `supportsIdempotentDelivery` 才允许重试——不承诺 exactly-once 写进状态机。

## 共享接口影响与消费者

- 全部新增模块；`SETTING_KEYS.gatewayState` 新键。消费者矩阵：GW-02（Telegram 适配器将实现 `GatewayTransport`/绑定为 `GatewayBindingPort`）、GW-03（文件转写端口）、RT-03（任意新目标的审批）。

## 未执行 / 待人工

- 真实 Telegram/飞书/QQ 适配器与平台 offset 语义 NOT RUN（GW-02，需用户明确授权才会接真实账户）。
- outbox 的真实断线重放（真实 transport 的 unknown 行为）未验证——本地三窗口（落盘前/提交后/发送后确认前）以持久化状态机覆盖，真实网络归 GW-02 真实轨。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工，不代表发布可用。
