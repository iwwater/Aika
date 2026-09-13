# RT-06 · 跨渠道主动投递策略 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全过，待人工审阅；真实渠道发送 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/runtime/deliveryPolicy.ts`（新增） | 投递策略纯函数：`evaluate`（群组永不接私人提醒 → drop；未授权目标 → drop；同一完成事件多次到达由 `registerOutboxItem` 只投一项；冷却 defer；quietHours defer/异常过长丢弃）；`markDelivered`（冷却 key = 主体+事件类型+目标，持久化在调用方 state——重启不清零）；`isQuietHour`/`quietHoursEnd`（IANA tz 本地小时，跨午夜窗口；无时区数据按不静默但冷却/授权仍生效）；**审批请求不按 urgency 绕过 quietHours**（important 与 normal 同策略，审批走 RT-03 不走投递）；`PersistentDeliveryState` 由调用方持久化（重启不清零频控） |
| `docs/modules/CONTRACTS.md` | 登记 RT-06 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/runtime/deliveryPolicy.test.ts` | 0 | 5 测试全过（fake clock） |
| `npx vitest run src`（里程碑回归一次） | 0 | 117 文件 1306 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

- **RT-06-A**：静默（23:00 UTC 在 22→7 窗口 → defer 至结束、important 不绕过）；冷却（窗口内 defer、窗口后 deliver）；解绑/未授权（`unauthorized-target` drop）；失败重试由 GW-01 outbox 承载（不在本层重复造重试）；持久 state 重启不清零。
- **RT-06-B**：`registerOutboxItem` 同 eventKey 第二次 → false（同一完成事件多次到达只一项 outbox）。
- **RT-06-C**：未授权目标 drop（不自动扩大收件人）；群私提醒 drop；无可用渠道时 defer/drop 状态可见（策略返回明确 action/reason）。
- **RT-06-D**：策略只产决策不产费用/送达承诺；真实发送另需授权（GW 适配器真实轨）。

## 未执行 / 待人工

- 真实渠道发送（Telegram sendMessage 等）NOT RUN——GW-02 真实轨；本策略只产决策。
- 桌面/宿主组合根把策略接进 GW-01 outbox 的实际接线归宿主装配（端口形状已对齐）。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工。
