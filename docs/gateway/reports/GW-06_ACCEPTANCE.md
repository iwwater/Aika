# GW-06 · QQ 适配 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（fixture 轨自动 AC 全过，待人工审阅；平台能力缺口如实 BLOCKED）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/gateway/qqAdapter.ts`（新增） | 官方能力快照与差异 `QQ_CAPABILITY_GAPS`（C2C 私聊需开放平台申请+审核、文件/语音受限白名单、个人 QQ 私聊不在官方能力范围——**不使用逆向协议补齐，不擅自替代账号形态**）；`QQ_SUPPORTED_SCOPES` 精确命名确定支持的文本 scope（`group@-text`、`c2c-text`）；`parseQqMessage`（官方 webhook payload op/t/d 判别：GROUP_AT_MESSAGE_CREATE / C2C_AT_MESSAGE_CREATE → GW-01 入站消息；生命周期 op/未开通 scope/空文本明确拒绝）；`qqRateLimitVerdict`（429 → retry_after 显式） |
| `aika-crossplatform/src/services/gateway/qqAdapter.test.ts`（新增） | scope 解析、能力拒绝矩阵、限流负例 |
| `docs/modules/CONTRACTS.md` | 登记 GW-06 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/gateway/qqAdapter.test.ts` | 0 | 3 测试全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 119 文件 1312 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

- **GW-06-A**：不支持能力明确拒绝——scope 未开通 → `scope-not-supported:c2c-text`；生命周期 op → `unsupported-op:13`；空文本 → `empty-text`；文件/语音不在白名单。
- **GW-06-B**：解析产物是 GW-01 `GatewayInboundMessageV1`，绑定隔离沿用（sender 走 GW-01 绑定解析，复用同批回归）。
- **GW-06-C**：平台限流负例（429 → `retryAfterMs` 显式）；重复/撤权负例由 GW-01 inbox 去重与 FE-17 凭证撤销承载（同批回归）。
- **GW-06-D**：官方能力不足的差异如实列在 `QQ_CAPABILITY_GAPS`（C2C 审核、文件语音受限、个人 QQ 私聊不在官方范围）——**整项保留条件阻塞，不伪称达到原场景**。

## 未执行 / 待人工

- QQ 开放平台账号申请/审核、真实机器人凭证、真实群@/C2C 消息收发——NOT RUN/BLOCKED（需用户申请与授权，本地不代执行）。
- 状态：AUTO_PASS（fixture 轨）= 可自动 AC 通过；真实能力缺口 BLOCKED 已列差异。
