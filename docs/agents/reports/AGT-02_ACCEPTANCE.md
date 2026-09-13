# AGT-02 · ACP 客户端与受限进程宿主 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全过，待人工审阅；真实 ACP 进程/真实只读验证 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/agent/acpProtocol.ts`（新增） | 协议原语：`parseAcpStream`（newline JSON 分帧、分包重组、错 JSON → malformed、超大 → oversized）；`validateProcessConfig`（可执行白名单+空白名拒（shell 拼接信号）、参数数组、cwd 经 `checkPathBoundary` 规范化、环境白名单最小化）；`ADVERTISED_CAPABILITIES`（只宣告 prompt——fs/terminal 未实现不宣告）；`buildPermissionResponse`（原 JSON-RPC id + 有效 optionId，伪造 optionId 拒绝生成）、`denyOptionId`（协议拒绝选项，不编造 approve） |
| `aika-crossplatform/src/services/agent/acpClient.ts`（新增） | `createAcpClientAdapter` 实现 AGT-01 `AgentAdapter`：initialize（pending 先注册再写，版本不符 → `protocol-version-mismatch` 终态）→ session/new → session/prompt（stopReason 结束 Run 不销毁 Session）→ session/cancel（signal 中止时写入并 kill）；session/request_permission → `need_approval` 事件；session/update 不进状态机；错 JSON/超大/进程退出/stdin 失败全部 failed 终态不悬空；失败事件以 yield 交付（不发哑火） |
| `docs/modules/CONTRACTS.md` | 登记 AGT-02 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/agent` | 0 | 2 文件 16 测试全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 111 文件 1271 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

- **AGT-02-A**：分包重组（跨 chunk 拼回完整帧）、错 JSON → `stdout-malformed`、超大 → `stdout-oversized`、未知版本 → `protocol-version-mismatch`、进程退出 → `process-exited:<code>`——每条都有 failed 终态，for-await 不悬空。
- **AGT-02-B**：`buildPermissionResponse` 用原 id + 有效 optionId；伪造 optionId → null；拒绝走协议 `reject` 选项（`denyOptionId`）；拒绝与取消真实映射到协议方法（session/cancel）。
- **AGT-02-C**：`ADVERTISED_CAPABILITIES` 只含 prompt（fs/terminal 不宣告）；进程配置校验拒绝 shell 拼接（含空白的可执行名）与非数组参数、cwd 越界、环境非白名单。
- **AGT-02-D**：ACP 是通信协议不是沙箱——本适配器不宣称限制 adapter 自有工具；写/执行模式的真实验证 BLOCKED（需真实 Agent 进程）。

## 未执行 / 待人工

- 真实 ACP 进程（真实 Agent 可执行文件、Windows Job Object 子进程归属、超时清理实测）NOT RUN——需要宿主工程与真实 adapter。
- 「真实只读也需验证写能力已禁用」归真实轨 BLOCKED。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工。
