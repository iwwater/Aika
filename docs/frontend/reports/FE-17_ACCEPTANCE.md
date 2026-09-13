# FE-17 · 网关认证、暴露面与安全门禁 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**PARTIAL —— FE-17-pre AUTO_PASS（本地）；tauri/dev-relay NOT RUN；public BLOCKED（缺真实 TLS 证据）。整体不写全 PASS。**

## 改动范围（FE-17-pre 步骤）

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/outbound/credentials.ts`（新增） | 凭证 repository：配对码（本地主窗为特定主体签发、TTL 5min、原子单次兑换、明文码/token 只在响应出现一次、存储只留 FNV 双哈希、损坏按「无凭证」fail-closed）；设备会话（device+principal 归属、30 天服务端失效日、逐设备 rotate/revoke、撤销立即影响唯一 authenticate 门——HTTP/WS/缓存共用）；`listSessions` 脱敏（无凭证字段） |
| `aika-crossplatform/src/services/outbound/exposurePolicy.ts`（新增） | 纯策略：三层 loopback(default)/lan/public；**所有层私有数据都需认证**；LAN 需显式启用且如实披露「明文非端到端加密」；**publicTlsAck 只记录意图——无真实 TLS 证据 public 恒 `blocked-no-tls-evidence`**；路由白名单（`/`、`/pairing/redeem` 公开；events/commands 需认证；SQL/存储/秘密/opener/settings 永不进网关）；请求级认证门（Origin 白名单 fail-closed、Bearer、cookie+CSRF 双提交） |
| `docs/modules/CONTRACTS.md` | 登记 FE-17-pre 追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/outbound` | 0 | 3 文件 18 测试全过（含 FE-14 的 11 个） |
| `npx vitest run src`（里程碑回归一次） | 0 | 107 文件 1244 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 分列（按步骤与宿主）

### FE-17-pre —— AUTO_PASS（本地，全 fake）

- 配对生命周期：兑换成功一次性（重复 → `already-consumed`）、过期 → `expired`、错误码不可探测（单码独立）、pending 计数准确。
- 凭证安全：落盘 JSON 无明文码/token（只有 hash）；撤销立即 `revoked`；逐设备轮换互不影响、旧凭证即时失效、新凭证生效——HTTP/现存 WS/缓存共用的同一个 authenticate 门（FE-17-D 的服务端部分）。
- 暴露面：loopback 默认且回落语义明确；LAN 显式启用+明文披露；public 即使有 ack 也 `blocked-no-tls-evidence`（FE-17-C 的策略部分）。
- 路由：SQL/秘密/opener/settings 永不入网关；events/commands 需认证；首页/兑换公开（FE-17-E 静态部分）。
- 认证负例：坏 Origin、缺凭证、坏 Bearer、cookie 缺 CSRF、CSRF 不匹配、禁路由带好凭证——全部拒绝（FE-17-B 动态负例的服务端逻辑）。

### FE-17-host/tauri —— NOT RUN

依赖 FE-15（Tauri HTTP 传输 + Rust handler + 手机页）落地后逐宿主验收；Rust 侧 gateway.rs/remote.rs 未在本步骤改动。

### FE-17-host/dev-relay —— NOT RUN

依赖 FE-16（Node dev-relay）落地后验收。

### public —— BLOCKED（外部条件）

真实 TLS 入口、后端不可直连证据、反代来源白名单需实际部署验证；按约定无法验证保持 BLOCKED，不因 ack/伪造代理头放行（策略层已实现该拒绝）。

## 逐 AC 对照

- FE-17-A：loopback 默认语义与回落策略已测；「重启保持」「保存失败原配置有效」的持久化载体为存储 KV（凭证与配置同机制，credentials 损坏 fail-closed 已测）；设置 UI 与主窗窗源校验归 host 步骤。
- FE-17-B：兑换/认证负例服务端逻辑已测；动态 HTTP/CSRF 负例需真实路由（host 步骤）。
- FE-17-C：策略层已实现「仅 ack 不开放」；真实证据另列，未测不写 PASS。
- FE-17-D：逐设备轮换/撤销互不影响已测；「现存 WS 立即失效」由共用 authenticate 门保证（WS 每消息过门），真实 WS 归 host。
- FE-17-E：静态白名单已测；动态未授权扫描归 host。
- FE-17-F：FE-14 四门已测（FE-14 报告）；跨会话 0 泄露由 RT-02/FE-14 联合覆盖；Trace 外发开关 UI 归 host。

## 未执行 / 待人工

- tauri/dev-relay 宿主验收 NOT RUN；public BLOCKED（真实 TLS 部署证据）。
- 状态：PARTIAL 按宿主分列；不把 pre 的通过写成整体 PASS。
