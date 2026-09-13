# FE-15 · Tauri HTTP传输与手机页迁移 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**PARTIAL —— FE-15-A AUTO_PASS（TS 传输适配 + conformance）；B/C/D/E 需真实 Rust 宿主与手机环境：NOT RUN/BLOCKED。整体不写全 PASS。**

## 改动范围（本步骤本地部分）

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/outbound/tauriTransport.ts`（新增） | `createTauriOutboundTransport`：Tauri invoke/listen 桥接成 FE-14 `OutboundTransport`——出站帧经 `outbound_publish` invoke 由 Rust 中转；入站命令经 `outbound://command` 事件（Rust 认证后带外注入 principal），监听者异常隔离；不做认证也不信任 body 身份 |
| `aika-crossplatform/src/services/outbound/tauriTransport.test.ts`（新增） | fake invoke/listen 下复跑 FE-14 transport 一致性用例包（6 用例：定向投递/未映射零外发/cursor 单调/重放去重+ping/校验矩阵/退订） |
| `docs/modules/CONTRACTS.md` | 登记 FE-15 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/outbound/tauriTransport.test.ts` | 0 | 6 用例全过（FE-14 conformance 复用） |
| `npx vitest run src`（里程碑回归一次） | 0 | 108 文件 1250 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 分列

- **FE-15-A —— PASS（本地）**：fake invoke/listen 下 FE-14 conformance 六用例全过；退订后即使 Tauri 事件继续到达也不产生业务帧（退订用例断言）。
- **FE-15-B —— NOT RUN**：Rust 实际 handler（缺/错/撤销会话、错误 Origin、超大 body、旧路由旁路、合法 cursor 增量）需 src-tauri gateway.rs 实现与真实宿主；本步骤未改 Rust。
- **FE-15-C —— NOT RUN**：500 帧/字节限额、过期 cursor、epoch 重启 gap、会话隔离、长轮询不阻塞 POST/stop——Rust handler 行为。
- **FE-15-D —— NOT RUN**：手机页（src-tauri/mobile/index.html）生产适配与新协议对齐需真实页面与目视。
- **FE-15-E —— NOT RUN**：平台选择在宿主装配、非主窗口不能发布帧、Runtime 离线 503——Rust 宿主行为。

## 未执行 / 待人工

- 真实 Tauri 启动、plugin-sql、局域网手机列 INT-01 真实轨：NOT RUN/BLOCKED（缺环境；不自动发布、不开放公网）。
- Rust 侧 `gateway.rs`/`remote.rs` 的 events/commands 路由、凭证接线（FE-17-pre 端口已就绪）与旧路由迁移——需宿主工程能力与真实验证，留待具备宿主构建验证条件时执行。
- 状态：PARTIAL 按宿主分列；FE-15-A 的通过不宣称整份完成。
