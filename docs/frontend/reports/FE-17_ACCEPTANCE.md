# FE-17 · 网关认证、暴露面与安全门禁 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**PARTIAL —— FE-17-pre AUTO_PASS（本地）；FE-17-host/tauri 装配轨 PASS（本地，生产装配 + fake 传输）；真实 Tauri 进程端到端 NOT RUN；dev-relay NOT RUN；public BLOCKED（缺真实 TLS 证据）。整体不写全 PASS。**

## 改动范围（FE-17-host/tauri 宿主装配接线）

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/app/hosts/index.ts` | `baseHost` 恒定装配 `hostLifecyclePlugin`；`tauriHostPlugins` 追加 `outboundTransportPlugin(createTauriOutboundTransport({invoke,listen,gatewayEpoch:lifecycle.epoch(),principalId:LOCAL_PRINCIPAL_ID}))`；`HostOptions.hostLifecycle?` 可注入（测试用假时钟驱动离线/恢复）；`resolveLifecycle` 统一创建 |
| `aika-crossplatform/src/app/hosts/plugins.ts`（新增两个插件） | `outboundTransportPlugin(transport)` provides `OutboundTransportToken`；`hostLifecyclePlugin(lifecycle)` provides `HostLifecycleToken`（带 disposer→`lifecycle.dispose()`）。两者都是「装了才有 token」 |
| `aika-crossplatform/src/services/outbound/tokens.ts`（新增） | `OutboundGatewayToken` 迁到此处 + 新增 `OutboundTransportToken`；让宿主层只依赖 token 与类型 |
| `aika-crossplatform/src/services/outbound/outboundPlugin.ts` | `requires:[RuntimeToken]`+`optional:[HostLifecycleToken,OutboundTransportToken]`；**gatewayEpoch 改由注册表提供**；新增 `createGatewayRuntimePort`（`mode` 经 `normalizeModeConfig` 补全、`done` 收窄）与 `createOutboundPluginGateway`；`commandAuthorizer` 缺省即不接命令（fail-closed） |
| `aika-crossplatform/src/services/outbound/contracts.ts` | `OutboundTransport` 增加可选 `ready?()`/`close?()` |
| `aika-crossplatform/src/services/remote/bridge.ts` | `RemoteHost.start` 增加可选 `options{allowedOrigins,lanEnabled}` 并透传到 Rust；过渡导出 `startRemote` 同步支持；**缺省即最严档** |
| `aika-crossplatform/src/app/plugins/index.ts` | `capabilityPlugins()` 默认装配 `outboundPlugin()` |
| `aika-crossplatform/src/app/composition.ts` | 新增 `startHostRuntime`：await `transport.ready()`（失败只告警、不阻断启动）+ 5s 心跳喂 `markAlive()` + `pagehide` → `markStopping()` |
| `aika-crossplatform/src/app/runtimeFacade.test.ts` | 白名单加入 `services/outbound/outboundPlugin.ts`（facade 的正当消费方：resolve 同一个 Runtime，不 new 第二个编排） |
| `aika-crossplatform/src/app/hosts/outboundHostWiring.test.ts`（新增，9 测试） | 装配层定向：token 缺失语义、帧真经 transport、命令入口 fail-closed、epoch 来源、disposer 退订 |
| `aika-crossplatform/src/app/composition.test.ts` | 宿主装配断言补 `host.outboundTransport`/`host.lifecycle` 的桌面—浏览器差异 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx tsc --noEmit` | 0 | 无错误 |
| `npx vitest run src/services/outbound src/app src/kernel` | 0 | 15 文件 174 测试全过 |
| `npx vitest run src/app/hosts/outboundHostWiring.test.ts` | 0 | 9 测试全过（新增） |
| `cargo check`（src-tauri） | 0 | Finished dev profile in 2.78s |

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

### FE-17-host/tauri —— PASS（本地装配轨，生产装配 + fake 传输）

前置 FE-15（Tauri HTTP 传输 + Rust handler + 手机页）与 Rust 侧 `gateway.rs`/`remote.rs` 已就绪；本步骤完成**宿主装配接线**，即「桌面宿主真的把这个传输装起来了」。

- **能力缺失即 token 不注册**：无 `host.outboundTransport` 的宿主，`OutboundTransportToken` 不存在、`tryResolve` 返回 null；`OutboundGatewayToken` 仍可解析（本地投影与诊断可用）。不是注册一个「发布即丢弃」的假传输。
- **帧真的出去**：经内核装配的网关在 `registerTarget` 后把 `generated` 投影成 reply 帧发到 transport；未映射轮次 0 外发（先证拒、再证发）。
- **命令入口 fail-closed**：无 `commandAuthorizer` 时 transport 上**根本没有监听器**（不是「接了再拒」）；有授权端口时，`principalId !== "local"` 的命令被丢弃、`local` 的才流到网关。
- **gatewayEpoch 来自宿主存活状态（RT-01-D）**：帧的 `cursor.gatewayEpoch` 等于装配的 `lifecycle.epoch()`；剔除 `host.lifecycle` 后退化为 `fallbackEpoch`（两条路径都测）。
- **disposer 生效**：内核释放时 `host.lifecycle` 的 `dispose()` 与 outbound 的 `runtime.subscribe` 退订都被调用。
- **启动动作**：`composition.ts` await `transport.ready()`（Tauri 的 `listen("outbound://command")` 注册）；失败只告警不阻断启动。心跳 5s 喂 `markAlive()`（租约 15s 的 1/3，两次容错），`pagehide` → `markStopping()`。
- **`remote_start` 策略参数透传**：`RemoteHost.start(port, token, {allowedOrigins, lanEnabled})` → invoke（camelCase）→ Rust `allowed_origins`/`lan_enabled`；不传即 Rust 默认最严档（只绑 loopback、空 Origin 白名单）。**注意**：`useRemoteAccess` 尚未传该参数，行为与接线前一致（仍是 loopback 默认）。

**仍 NOT RUN（须真实宿主 / 手工）**：
- 真实 Tauri 进程启动、`remote_start` 真实监听、手机页经真实 HTTP 端到端取帧与发命令。
- `OutboundTransport.ready()` 在真实 `@tauri-apps/api/event` 上的行为（本步骤用 fake listen 覆盖注册与幂等语义，真实性未验）。
- 多 WebView 越权（`outbound_publish` 仅主窗口可调）——属真实宿主攻击面验证。
- `useRemoteAccess` 接入 `exposurePolicy` 决策与 LAN 设置项：**未做**（属 FE-17-pre 端口接入 HTTP 链路的后续 SPEC；Rust 侧当前尚未调用 `authenticateRequest`）。

### FE-17-host/dev-relay —— NOT RUN（前置缺口已定位）

接线前先核实了链路，发现**缺的不只是一个插件装配**：

- `shouldConnectDevRelay()` 与 `createWsOutboundTransport()` 目前**只有测试调用**，生产无人调用——这是缺口之一，本身很小（在 `browserHostPlugins` 里按决策装配即可）。
- 但真正的阻塞是：relay（`scripts/outboundDevRelay.mjs`）**不做认证**，ticket 必须由**宿主侧**调用 `issueTicket` 签发；producer 侧要有一个跑 TS Runtime 的 Node 入口连上 relay。也就是说 dev-relay 的完整链路需要「宿主 producer 进程 + ticket 签发通路」，属于新的一块（接近 headless harness 的 relay 角色部署），不是宿主装配层的顺带改动。
- 按 AGENTS.md「不为局部任务顺手重写架构」，本步骤**不做**，如实记为 NOT RUN。浏览器 dev 现状不变：没有 `OutboundTransportToken`，网关本地投影可用、帧不外发。

### public —— BLOCKED（外部条件）

真实 TLS 入口、后端不可直连证据、反代来源白名单需实际部署验证；按约定无法验证保持 BLOCKED，不因 ack/伪造代理头放行（策略层已实现该拒绝）。

## 逐 AC 对照

- FE-17-A：loopback 默认语义与回落策略已测；`RemoteHost.start` 已支持 `lanEnabled`/`allowedOrigins` 透传且缺省最严（Rust 侧 `bind=LOCALHOST`）已在本步骤接线；「重启保持」「保存失败原配置有效」的持久化载体为存储 KV（凭证与配置同机制，credentials 损坏 fail-closed 已测）；**LAN 开关的设置 UI 与 Origin 白名单的实际取值未接**（`useRemoteAccess` 仍未传参，归后续 SPEC）。
- FE-17-B：兑换/认证负例服务端逻辑已测；**Rust HTTP 路由尚未调用 `authenticateRequest`**，动态 HTTP/CSRF 负例仍待接。
- FE-17-C：策略层已实现「仅 ack 不开放」；真实证据另列，未测不写 PASS。
- FE-17-D：逐设备轮换/撤销互不影响已测；「现存 WS 立即失效」由共用 authenticate 门保证（WS 每消息过门），真实 WS 归 host。桌面宿主已装配出站传输且命令入口 fail-closed 已测。
- FE-17-E：静态白名单已测；动态未授权扫描归 host（Rust 未接认证门，见 FE-17-B）。
- FE-17-F：FE-14 四门已测（FE-14 报告）；跨会话 0 泄露由 RT-02/FE-14 联合覆盖；出站装配（桌面装 transport、浏览器不装）已测；Trace 外发开关 UI 归 host。

## 未执行 / 待人工

- 真实 Tauri 进程端到端（`remote_start` 真监听、手机页真取帧/发命令、`listen` 真实性）、多 WebView 越权：NOT RUN。
- dev-relay 宿主验收 NOT RUN；public BLOCKED（真实 TLS 部署证据）。
- FE-17-pre 的 `exposurePolicy`/`credentials` 端口尚未接入 Rust HTTP 认证链路（Rust 路由未调用 `authenticateRequest`）：NOT RUN，另一 SPEC 范围。
- 状态：PARTIAL 按宿主分列；FE-17-host/tauri 的**装配轨**为本地 PASS，真实端到端仍未验，不写整体 PASS。

## 后续追加（2026-09-13 晚）：命令下行链路收口

装配轨验收后定位到命令下行链路的两处断点（白屏修复后的 e2e 只证明 HTTP 202 受理，未证明命令到达 TS 网关——202 当时是假确认）：

1. **Rust `handle_commands` 受理后无 emit**：Accepted 分支只回 202，命令从未送达 WebView 内的 `tauriTransport` 监听。已补 `app.emit("outbound://command", payload)`（payload 与 `AuthenticatedCommand` 对齐：`raw`/`principal.principalId`/`conversationId`/`connectionId=http:{request_id}`），**emit 失败回 502 不假确认**；随后才回 202。
2. **生产装配未传 `commandAuthorizer`**：`capabilityPlugins()` 的 `outboundPlugin()` 无授权端口，按 fail-closed 缺省命令监听根本没接。已补 `commandAuthorizer: (input) => input.principal.principalId === LOCAL_PRINCIPAL_ID`（Rust 已完成 token 认证与会话准入，这里核验主体为服务端注入的本地主体；伪造主体在 `handleCommand` 之前被拒）。

**测试证据**：

- `src/app/hosts/outboundHostWiring.test.ts` **10/10**：新增「生产装配默认携带本地主体授权：合法命令流到网关、伪造主体被拒」（用 `capabilityPlugins()` 原样，emit `principalId:"local"` → `handleCommand` 调 1 次且主体为 local，`"intruder"` → 0 次）；原「无授权端口监听器没接上」用例改为显式构造 `outboundPlugin({})` 保留 fail-closed 缺省语义（生产装配自带授权后该用例若用默认装配会语义翻转）。
- outbound + hosts 定向回归 **53/53**；`cargo test` **19/19**（emit 路径在 mock app 上不 panic，202 前置 emit 语义被既有 HTTP 回归钉住）；`tsc --noEmit` **0 错误**。
- 产物链：`npx vite build`（dist 22:52:13）→ `cargo build --release --features custom-protocol`（exe 22:54:08，重嵌入核对无误）。

**仍 NOT RUN**：真实进程上的命令下行复测（手机页/CDP 发命令 → 桌面 React 侧真实收到并落 Runtime.submit）——本轮执行环境无法启动保持 GUI 进程（Start-Process 中途失败，与 A6 记录一致），需按 RESOLUTION 报告同法在宿主环境复测一次。
