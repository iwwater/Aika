# AGT-01 · AgentSessionManager 生命周期 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全过，待人工审阅；真实 ACP adapter NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/domain/agentSession.ts`（新增） | Session/Run 状态机契约：Session（starting/ready/busy/closed/failed）与 Run（queued/running/waiting_approval/waiting_input/cancelling/completed/failed/cancelled/interrupted）严格分离；`TERMINAL_RUN_STATES`/`isTerminalRun`；`AgentRunV1`（startRequestId 幂等键、promptDigest、事件 seq）；`AgentRunEventV1`（脱敏事件：无 prompt 原文） |
| `aika-crossplatform/src/services/agent/agentSessionManager.ts`（新增） | `createAgentSessionManager`：spawn/send/cancel/resolveApproval/provideInput/recover/subscribe；spawn 以 startRequestId 幂等；并发上限默认 1 + 有界队列（queue-full 显式拒）；Run 时间预算（超时 → cancelling → failed）；cancel 幂等（协议取消 → 中止流 → 有界宽限 → 宿主 forceEnd 留实际状态 failed）；waiting_approval/waiting_input 显式转换（审批拒绝 → failed）；recover 把 running/waiting 标 interrupted；事件日志有界（logLimit 下限 10）且 prompt 只留 paramsDigest 摘要 |
| `docs/modules/CONTRACTS.md` | 登记 AGT-01 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/agent` | 0 | 6 测试全过（fake adapter 跑生产 manager） |
| `npx vitest run src`（里程碑回归一次） | 0 | 110 文件 1261 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

- **AGT-01-A**：同 startRequestId 两次 send → 同 runId、runs 中该 id 仅一条（重复 spawn 不生成两任务）；「终态不复活」按 runId 界定——Session 在 Run 完成后仍可 send 开新 Run（「一轮结束 Session 仍 ready」用例）。
- **AGT-01-B**：取消幂等（二次 cancel 返回 ok 与相同实际状态）；waiting_approval（审批拒绝 → failed）/waiting_input（provideInput → running）显式转换；Run 超时 → cancelling → failed 路径存在（runTimeoutMs 驱动）。
- **AGT-01-C**：`recover()` 把 running/waiting 标 interrupted（「崩溃恢复」用例 count=1 且全部 interrupted）——不假装仍运行，恢复待人工确认。
- **AGT-01-D**：fake adapter 驱动**生产** manager（adapter 只实现 spawn/send/cancel/forceEnd 协议面）；事件日志有界（logLimit 封顶）且 prompt 原文不出现在事件 JSON（只有 paramsDigest）。

## 未执行 / 待人工

- 真实 ACP adapter（真实 Agent 进程/协议握手）NOT RUN——AGT-03 的真实轨前置。
- 审批动作与 RT-03 PermissionRuntime 的接线（waiting_approval 目前是状态转换，签发真实权限请求）归 AGT-02。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工，不代表 Agent 链可用。
