# GW-04 · Device Gateway 配对与能力会话 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全过，待人工审阅；真实设备端到端 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/gateway/deviceRegistry.ts`（新增） | 设备记录/列表/能力协商/租约重连：`registerDevice`（capability=服务端授权∩设备声明，逐项可见降级）、`heartbeat`/租约读时计算在线（默认 30s）、`list`（脱敏+online）、`authorize`（chat/notification 走能力交集；**trace/approval 不在设备能力枚举——独立授权口默认拒绝**）、`reconnect`（epoch 变化→`epoch-changed`；cursor 低于缓存最旧→`cursor-too-old`；心跳重置续租）。设备身份是 deviceId，不是设备名/IP；配对码/会话/撤销复用 FE-17-pre 凭证仓库，不造第二套 |
| `docs/modules/CONTRACTS.md` | 登记 GW-04 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/gateway` | 0 | 4 文件 27 测试全过（含 GW-04 五用例） |
| `npx vitest run src`（里程碑回归一次） | 0 | 109 文件 1255 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

- **GW-04-A**：配对码短期单用/逐设备撤销由 FE-17-pre 凭证仓库承载（同批回归全绿）；设备记录按 deviceId 独立，逐设备操作不影响其他设备（「逐设备隔离」用例）。
- **GW-04-B**：租约（心跳内 online/超时 offline/心跳续租）；重连 epoch 变化 → `epoch-changed`、cursor 低于缓存最旧 → `cursor-too-old`、窗口内 → 正常续播；宿主 epoch 经 `gatewayEpoch()` 注入比对。
- **GW-04-C**：能力协商交集（声明 4 项×服务端 3 项=3 项，`voice_input` 缺失可见）；**未经授权无法订阅 Trace/发审批**——`authorize("…","trace"/"approval")` 恒 `not-authorized`（独立授权口，不属于设备能力枚举）。
- **GW-04-D**：离线设备 `authorize(chat)` → `offline`（离线不执行、不生成第二份回复的设备侧门）；Android/Web 作为终端（声明能力制）；PC 离线显示不可用的 UI 呈现归 FE 手机页/工作台（真实轨）。

## 未执行 / 待人工

- 真实设备端到端（Android/Web 终端连真实 Tauri 宿主）NOT RUN——依赖 FE-15 Rust handler 与 INT-01 真实环境。
- LAN 自动 Discovery 明确未交付（按 SPEC 默认手填地址）。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工，不代表设备链可用。
