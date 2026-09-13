# INT-04 · v0.5 远程 Coding 里程碑 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**PARTIAL —— fixture 轨 AUTO_PASS（AC-A/C/E 本地部分全过）；真实轨（AC-B/AC-D 真实栏）NOT RUN/BLOCKED。整体不写全 PASS。**

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/agent/int04.fixture.test.ts`（新增） | 联调 harness（fixture 轨）：从**生产用户命令入口**（TaskCommand facade parser/认证/路由）开始的完整链路——facade → 生产 AgentSessionManager → fake ACP adapter → canary 临时仓库 → 生产审批绑定凭据 → 受控修改 → 原渠道结果投递；负例先行（未批准/错误用户/取消/重启）；入口×适配器矩阵（Telegram×Codex、Device×Claude 两条完整成功链路） |
| `docs/modules/CONTRACTS.md` | 登记 INT-04 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/agent/int04.fixture.test.ts` | 0 | 7 测试全过（负例 4 + 成功链路矩阵 2 + deny-writes 1） |
| `npx vitest run src`（里程碑回归一次） | 0 | 115 文件 1293 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

### INT-04-A：未批准/错误用户/超时/取消/重启负例先通过（负例先于成功链路）

- 未批准：need_approval 后拒绝 → canary `task.txt` 哈希不变、仓库外哨兵不变。
- 错误用户：ext-B（不在 workspaceRef 授权名单）→ 命令拒绝、0 执行。
- 取消：运行中 cancel → 协议取消 → 状态 `cancelled`、canary 零修改。
- 重启：`recover()` 把运行中任务标 `interrupted`（不假装仍运行）。
- deny-writes 权限模式：批准也不产生修改（AGT-02-D 联动负例）。

### INT-04-B：真实可控失败项目修复（前后 diff + 测试退出码）

- **fixture 轨**：成功链路取证「前哈希 ≠ 后哈希、`task.txt` 内容 = 前+FIXED」的可控修改 diff，修改仅发生在 canary 仓库内、仓库外哨兵哈希不变。
- **真实轨 NOT RUN**：真实 Codex/Claude 对真实可控失败项目的修复 diff 与真实测试命令退出码——需用户明确授权接真实 Agent（AGT-03-B 同款），未执行不冒充。

### INT-04-C：PC 端可见同一任务记录；私人记忆不复制到群

- PC 任务视图与远程 session 消费**同一 runId**（`manager.runs()` 共读，AC-E 同 runId 断言）。
- 私人记忆不入群：群消息按 RT-02 会话隔离（独立 scope）+ RT-04 `untrusted-material` 分级（同批回归覆盖）。

### INT-04-D：fixture/真实/人工三栏独立

- fixture 栏：本报告全部证据。
- 真实栏：NOT RUN（真实 Telegram/Codex/Claude 链路、真实 diff 与测试退出码）。
- 人工栏：UI 目视、真实环境清单（见下）。
- **INT-03 发布门禁仍需单独完成**，本份不代偿。

## 入口 × 适配器矩阵（全文审阅）

| | Codex | Claude |
| --- | --- | --- |
| **Telegram 入口** | ✅ 完整成功链路（conv-tg） | 未跑组合（如实记录） |
| **Device 入口** | 未跑组合（如实记录） | ✅ 完整成功链路（conv-device） |

每个入口与每个适配器各有至少一条完整成功链路；未跑的两种组合如实标注，不补跑。

## 未执行 / 待人工

- 真实 Telegram/移动端入口 → 真实 Codex/Claude → 临时仓库可控修复（前后 diff + 测试命令退出码）——NOT RUN/BLOCKED（需用户授权接真实账户与 Agent）。
- 受限宿主侧副作用边界（Windows Job Object、真实文件系统审计）在真实轨补充；fixture 轨以仓库外哨兵哈希不变佐证。
- 桌宠回顾 NOT RUN（不阻塞核心链路，维持后置）。
- 状态：PARTIAL（fixture 轨 AUTO_PASS）；INT-03 发布门禁独立完成前不宣称里程碑达成。
