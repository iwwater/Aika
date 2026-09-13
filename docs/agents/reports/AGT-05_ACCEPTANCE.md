# AGT-05 · 远程审批、进度与结果投递 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全过，待人工审阅；端到端真实链路归 INT-04）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/agent/taskCommand.ts`（新增） | `createTaskCommandFacade`：**TaskCommand 用户发起入口**——/agent 结构化命令解析（agent.spawn/send/cancel/permission.respond，schemaVersion 1）；workspaceRef 走服务端白名单别名（body 不接受任意本地路径），按别名授权主体二次核验；spawn 按 主体+会话+startRequestId 重放去重（0 重复执行）进入**生产** manager；审批卡 `issueApprovalBinding`（单次绑定凭据 TTL 10min，绑定 runId+approvalRequestId+conversation+principal——其他用户/伪造/过期/重放 0 执行，消费即作废）；`notifyProgress` 节流（5s）；`notifyCompletion` 按 runId+终态去重、投递失败旁路化不改真实终态、结果仅附加文本（不可信资料不触发新执行）；`runs()` 供任务面板与远程 session 读同 runId（无第二任务状态） |
| `aika-crossplatform/src/services/agent/taskCommand.test.ts`（新增） | AC-E 端到端（生产 parser → facade → 生产 manager + fake adapter 真实 spawn）与全部负例 |
| `docs/modules/CONTRACTS.md` | 登记 AGT-05 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/agent/taskCommand.test.ts` | 0 | 5 测试全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 114 文件 1286 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

- **AGT-05-A**：其他用户（绑定凭据 principal 不匹配 → 拒）、群（绑定 conversation 不匹配 → 拒）、伪造/过期按钮 → 0 执行；重放（同 startRequestId 第二次 spawn → `duplicate`，manager 仅 1 条 Run）。
- **AGT-05-B**：批准前任务停在 waiting_approval（need_approval 事件 → 状态机）；取消与批准竞态由「绑定单次消费 + manager 状态机终态互斥」保证唯一赢家（AGT-01 cancel 幂等用例同批回归）。
- **AGT-05-C**：进度节流（PROGRESS_THROTTLE_MS=5s，节流窗口内第二笔不投递）；完成通知按 runId+终态去重（两笔只投一笔）；投递失败旁路化——manager 无 failed 状态污染。
- **AGT-05-D**：结果回原 conversation（deliveries 按 conversationId 归位）；结构化结果不含 key/私人其他会话内容——deliver 文本只含 runId/状态/调用方提供的汇总；端到端真实链路归 INT-04。
- **AC-E（全文审阅）**：生产命令 parser → TaskCommand → 生产 manager（fake adapter）**真正 spawn 一次**：manager.runs() 恰一条、进度投递回原会话；未知 workspace（`C:\Users\victim` 作为 workspaceRef 被拒）/未授权/重放 0 执行；PC 任务面板与远程 session 读同一 `runs()`（同 runId）。

## 未执行 / 待人工

- 端到端真实链路（真实渠道按钮 → 真实 Agent 执行 → 结果回投）归 INT-04；真实 Agent 执行证据按 AGT-03 真实轨。
- 桌面任务面板 UI（选择已配置 agent/预登记 workspace 别名/历史查看）的目视验收留人工——facade 的 `runs()`/`handle()` 已是面板与远程共用的唯一状态源。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工。
