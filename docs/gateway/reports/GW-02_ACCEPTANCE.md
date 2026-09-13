# GW-02 · Telegram 文本私聊适配 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（fixture 轨自动 AC 全过，待人工审阅；真实双向消息 NOT RUN，不由 fixture 宣称渠道已上线）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/gateway/telegramAdapter.ts`（新增） | `parseTelegramUpdate`（官方 update fixture → Gateway 入站消息；私聊/群聊区分；/命令 → command payload；photo/document → null 交 GW-03）；`splitTelegramText`（4096 **码点**切分，代理对不劈开，切片 id `<messageId>#<n>` 稳定）；`redactTelegramUrl`（token 在 URL 路径——整段替换 `<token>`，不套用只删 query 的通用规则）；`sendMessageUrl`/`getUpdatesUrl`；`sendTelegramSlice`（429 → retry_after 交调用方；abort/断网 → unknown 不是 failed）；`createTelegramPoller`（getUpdates 长轮询；**offset 只在 onMessage（Gateway 持久接收）resolve 后推进**；429 按 retry_after；409 webhook 冲突如实停止**不自动 deleteWebhook**；不认识的 update 也推进 offset 防卡死；abort 退出无泄漏） |
| `docs/modules/CONTRACTS.md` | 登记 GW-02 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/gateway`（含 telegramAdapter.test 4 用例） | 0 | 全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 104 文件 1226 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

### GW-02-A：官方结构 fixture 覆盖重复 update、错误/429、超长文本及 Unicode 边界

- 官方 fixture（update_id/message/chat/from/date/text）解析逐字段断言；无 message 的 update → null（由 offset 消化）。
- 429：`sendTelegramSlice` 返回 retry-after（测试于 GW-01 flushOutbox 的 retry-after 用例中联动覆盖）；poller 429 分支按 retry_after 等待。
- 超长文本：5002 码点 → 2 片，码点级切分拼回无损、emoji 代理对不劈开、切片 id 稳定（`pm-9#0/#1`）。

### GW-02-B：启动/停止无泄漏；未知用户零 Runtime 调用

- poller 循环以 `AbortSignal` 驱动：abort 后立即退出（run 返回），无悬挂轮询。
- 未知用户：GW-01 的绑定解析（`sender-not-bound`）在提交 Runtime 前拦截，Runtime 零调用（GW-01 测试断言 submitCalls 为空）；首期群聊默认拒绝由「未绑定即拒」+ 群会话独立 scope 双保险。

### GW-02-C：回复只发送原绑定会话，token 不入 URL 日志/Trace

- 回信目的地绑定原请求（GW-01 outbox 断言 destination.chatId 恒等于原 chat）。
- token：URL 构造与脱敏单测（`redactTelegramUrl` 输出无 token）；API 审计回调只带 method/status/retryAfter 字段——结构上没有 URL/token 的位置；错误信息不拼接 URL。

### GW-02-D：真实双向消息独立 NOT RUN

真实 Telegram 账户、真实 getUpdates/sendMessage、真实断线与 429 行为**均未执行**；需要用户明确授权（外部发信）才进入真实轨。本报告不宣称渠道已上线。

## 未执行 / 待人工

- 真实 Bot API 双向消息、真实 webhook 冲突场景、平台速率实测——NOT RUN（需授权）。
- 设置入口（可信主窗配置/启停、默认关）归 FE 侧后续；账户配置经 SecretStore 保存（token 不进 settings 明文）。
- 状态：AUTO_PASS（fixture 轨）= 可自动 AC 通过；完整验收待人工，不代表渠道可用。
