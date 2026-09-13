# AGT-04 · Claude ACP 适配 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（fixture 轨自动 AC 全过，待人工审阅；真实 Claude 适配器 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/agent/adapterRegistry.ts`（新增） | 双适配器注册表（codex + claude 独立 manifest 与**独立认证槽**）：`select`（未知/坏 manifest 拒绝）、`probe`（复用 AGT-03 探测）、`authSlot`/`markLogin`（认证按 adapter 隔离——Anthropic 普通 API key 不是适配器登录态）、`isolateFailure`（一适配器失败不自动切换另一收费 Agent） |
| `aika-crossplatform/src/services/agent/adapterRegistry.test.ts`（新增） | 认证隔离、选择不改会话/权限语义、失败隔离、未知/坏 manifest 负例 |
| `docs/modules/CONTRACTS.md` | 登记 AGT-04 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/agent` | 0 | 4 文件 26 测试全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 113 文件 1281 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

- **AGT-04-A**：与 AGT-03 相同的只读/拒绝写/取消证据要求——Claude manifest `permissionMode: "deny-writes"`，负例矩阵（canary 哈希不变/取消收敛）为 AGT-01/02 公共用例包，registry 选择后走同一协议面（AGT-03 测试即同一份）。
- **AGT-04-B**：认证隔离——用户已配 Anthropic 普通 API key 时 `authSlot("claude").loggedIn === false`（「认证隔离」用例）；适配器登录是独立动作。
- **AGT-04-C**：选择适配器不改会话/权限语义——codex 与 claude 的 permissionMode/capabilities 相同断言；会话与权限语义由 RT-02/RT-03/AGT-01 承载，registry 不触碰。
- **AGT-04-D**：`isolateFailure("codex")` → affected=[codex]、unaffected=[claude]，claude 的 select/probe 照常；真实运行缺口独立列出（见下）。

## 未执行 / 待人工

- 真实 Claude Code 适配器（官方身份核实、真实安装探测、真实双向会话）NOT RUN——需用户明确授权。
- 状态：AUTO_PASS（fixture 轨）= 可自动 AC 通过；完整验收待人工。
