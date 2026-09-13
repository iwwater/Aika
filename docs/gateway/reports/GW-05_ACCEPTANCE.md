# GW-05 · Feishu/Lark 适配 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（fixture 轨自动 AC 全过，待人工审阅；真实 Feishu 账户 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/gateway/feishuAdapter.ts`（新增） | 官方能力快照注释（开放域名、tenant_key/open_id 身份、文本 DM、token 刷新、限流、默认不开公网 webhook）；`verifyFeishuSignature`/`verifyFeishuEvent`（SHA-256 验签、event_id 重放防御、create_time 秒/毫秒归一 + 5 分钟重放窗口、tenant_key 白名单隔离）；`parseFeishuMessage`（im.message.receive_v1 → GW-01 入站消息；**最小交付仅已绑定私聊文本**——群聊/未绑定/非文本/空文本明确拒绝）；`createFeishuTokenManager`（tenant_access_token 刷新+缓存，失败只暴露状态码，token/secret 不进错误） |
| `aika-crossplatform/src/services/gateway/feishuAdapter.test.ts`（新增） | 官方 fixture 解析、四类安全负例、群聊/未绑定/非文本拒绝、token 刷新失败脱敏 |
| `docs/modules/CONTRACTS.md` | 登记 GW-05 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/gateway/feishuAdapter.test.ts` | 0 | 3 测试全过（含多断言矩阵） |
| `npx vitest run src`（里程碑回归一次） | 0 | 119 文件 1312 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

- **GW-05-A**：解析产物是 GW-01 `GatewayInboundMessageV1`（schemaVersion 1，platform feishu），进 GW-01 的去重/路由/认证链（契约复用，结构断言）。
- **GW-05-B**：跨 tenant（`unknown-tenant`）、伪造签名（`bad-signature`）、重放（同 event_id → `replayed`）、过期时间戳（`stale`）全部拒绝。
- **GW-05-C**：token 刷新失败 `lastRefreshError = token-refresh-failed:502` 可见且不含 secret/token（脱敏断言）；成功刷新后缓存复用。
- **GW-05-D**：真实 Feishu 账户/真实 webhook 验签部署 NOT RUN——独立列于真实轨，不冒充。

## 未执行 / 待人工

- 真实 Feishu 应用凭证、真实事件订阅（长连接或 webhook + 平台验签实测）——NOT RUN（需授权）。
- 群聊/语音/文件能力未支持：明确拒绝（`group-not-supported`/`unsupported-message-type:*`），不静默吞。
- 状态：AUTO_PASS（fixture 轨）= 可自动 AC 通过；完整验收待人工。
