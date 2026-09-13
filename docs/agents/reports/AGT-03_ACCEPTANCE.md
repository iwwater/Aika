# AGT-03 · Codex ACP 适配 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（fixture 轨自动 AC 全过，待人工审阅；真实 Codex 进程/账户 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/agent/adapterManifest.ts`（新增） | `AgentAdapterManifestV1`（版本化 manifest：固定版本号、可执行路径、启动参数、支持宿主、认证方式、权限模式 deny-writes/ask/allow、capabilities、unsupported 明细）；`validateAdapterManifest`（version `latest`/`*` 拒绝——不运行时自动 npx/全局安装；未知权限模式/认证方式/schema 拒绝）；`probeStartup`（注入版本命令 runner：exitCode 0 取版本、null → not-installed、非 0 → probe-failed——**不自动安装**）；`createCanaryRepo`（临时仓库 + canary 文件哈希 + dispose，只读/拒绝写负例取证） |
| `aika-crossplatform/src/services/agent/adapterManifest.test.ts`（新增） | manifest 校验矩阵、启动探测三态、deny-writes fake adapter 下 canary 文件哈希不变 + 进程收敛、unsupported 能力明确列出 |
| `docs/modules/CONTRACTS.md` | 登记 AGT-03 追加表 |

## 测试命令与退出码

| 命令（cwd: aio-crossplatform 替换为 aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/agent/adapterManifest.test.ts` | 0 | 6 测试全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 112 文件 1277 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

- **AGT-03-A**：与 AGT-01 契约一致——fake adapter 实现 `AgentAdapter` 协议面驱动**生产** `createAgentSessionManager`（canary 用例真实走 spawn/send 生命周期）；`unsupported` 字段明确列出 fs/write、terminal 为不支持及原因，不静默缺失。
- **AGT-03-B**：没有账户/预算时仅真实调用 BLOCKED——manifest `authMethod: "oauth"` 表明认证要求；fake 实现与全部协议测试不依赖真实账户（本报告即证据）。
- **AGT-03-C**：deny-writes 权限模式下 fake adapter 拒绝写 → canary 临时仓库文件 SHA-256 哈希不变（负例取证）；fake adapter 完成即进程收敛。**文件哈希不变只是该负例证据，不证明全系统沙箱**（报告与代码注释均明示）；真实进程收敛（Windows Job Object）归真实轨。
- **AGT-03-D**：manifest 记录实际版本（固定 1.2.3 示例 + 启动探测取回实际版本输出与退出码）；权限负例（deny-writes 写拒绝）已取证；**文字计划不算审批有效**——审批有效性由 RT-03 的 request_permission 协议响应承载（AGT-02 已测）。

## 未执行 / 待人工

- 真实 Codex CLI 安装探测、真实账户/预算消费、真实写模式验证（AGT-03-C 的写模式侧）——NOT RUN/BLOCKED，需用户明确授权后接真实账户。
- 状态：AUTO_PASS（fixture 轨）= 可自动 AC 通过；完整验收待人工。
