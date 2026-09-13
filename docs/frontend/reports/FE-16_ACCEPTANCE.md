# FE-16 · 浏览器 dev 传输与 Node WS 中继 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**PARTIAL —— FE-16-A/B/C/D/E AUTO_PASS（本地真实 loopback）；宿主装配与 Tauri 侧手机页目视/真机项 NOT RUN。整体不写全 PASS。**

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/scripts/outboundDevRelay.mjs`（新增，生产 relay） | Node WS 中继：**只绑 loopback**（非 127.0.0.1/localhost/::1 直接抛 `non-loopback-bind`）；producer/consumer 角色由独立 ticket 区分认证；命令下行带**服务端注入** principal（不信任 body 身份）；出站帧按 `conversationId` 路由给订阅 consumer；Origin 白名单在 upgrade 阶段 fail-closed；消息 ≤256KB、每连接 60 msg/s 令牌桶、单连接缓冲 >500 帧判慢消费者并断开；撤权即时断开该主体全部现存连接并使其 ticket 失效；`close()` 释放 socket/订阅/timer |
| `aika-crossplatform/scripts/outboundDevRelay.d.mts`（新增） | relay 的 TS 类型声明。脚本本体纯 JS、不进前端构建产物；此声明只服务 src 内测试与宿主装配的类型检查（`tsc` TS7016 的解法） |
| `aika-crossplatform/src/services/outbound/wsTransport.ts`（新增，生产浏览器传输） | `createWsOutboundTransport`：把 relay WS 会话桥成 FE-14 `OutboundTransport`（出站帧 `{kind:"publish"}` 上行、入站命令 `{kind:"command"}` 下行）；`shouldConnectDevRelay` 决策函数（生产构建拒绝、仅 URL 参数拒绝、开发构建+显式配置才允许，且用配置地址而非 URL 参数）；不做认证、不信任 body 身份（与 `tauriTransport` 同一边界） |
| `aika-crossplatform/src/services/outbound/wsTransport.test.ts`（新增） | 19 个用例，5 组：FE-16-A 真实 loopback 跑 FE-14 契约包、FE-16-B 凭证/Origin/伪造 publish/会话隔离/撤权、FE-16-C 重连不重发未知 submit + cursor 单调、FE-16-D 未订阅 0 帧 + 撤权 4403、FE-16-E 生产构建/仅 URL 参数零连接 |
| `aika-crossplatform/package.json`（+lock） | devDependencies 增加 `ws@^8.21.3`、`@types/ws`（按 SPEC「项目 devDependency 按核实版本增加 ws」） |

## 测试命令与退出码

| 命令（cwd: `aika-crossplatform`） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/outbound/wsTransport.test.ts` | 0 | **19/19 通过**，1.81s |
| `npx vitest run src/services/outbound` | 0 | 5 文件 **43/43 通过**（含 FE-14/15/17-pre 既有用例） |
| `npx vitest run`（全量回归） | 0 | 120 文件通过 / 4 skip，**1335 passed \| 4 skipped (1339)**，14.11s |
| `npx tsc --noEmit` | 0 | 无错误（`TSC_LEN=0`） |

## 逐 AC 分列

### FE-16-A —— PASS（真实 loopback，非 fake socket）

SPEC 要求「生产 wsTransport 与生产 relay 在真实 loopback 跑 FE-14 契约包，不以 fake socket 替代」。

- 证据：`runOutboundTransportConformance` 直接以 `createWsOutboundTransport`（生产）+ `createOutboundDevRelay`（生产脚本）装配。`ws` 服务端**真的** `listen(127.0.0.1, port=0)`，客户端**真的**走 WS 握手；另有独立 consumer socket 经 relay WS 真实收到 `{kind:"frame"}` 帧。
- 契约包 6 用例（定向投递/未映射零外发/cursor 单调/重放去重+ping/校验矩阵/退订）全过。
- **harness 装配说明（诚实标注）**：契约包只 `await` 一次 `flush()`（0ms），装不下真实 socket 往返。故 A 组把**命令**按 `tauriTransport` harness 同构方式直接交给 `gateway.handleCommand`，**帧仍真实经 relay WS 发布**。命令走真实 socket 的链路由 FE-16-B/C/D 的独立用例覆盖——即「契约包验的是 gateway×transport 契约面，socket 真实性由 B/C/D 验」。
- 稳定性：单独跑三次、全量跑两次均 exit=0，无 flake（重构前 0ms flush 陷阱已消除）。

### FE-16-B —— PASS（真实 socket）

| 用例 | 观测 | 结论 |
| --- | --- | --- |
| 无 ticket 连接被拒 | 关闭码 **4401** | 通过 |
| 错误 Origin 在 upgrade 被拒 | 403，客户端非 1000 关闭 | 通过 |
| ticket 单次使用：重复兑换被拒 | 首次 `closed=false`，复用关闭码 **4401** | 通过 |
| consumer 伪造 publish | 回 `{kind:"rejected",reason:"consumer-cannot-publish"}`，`stats().framesPublished === 0` | 通过 |
| 会话隔离：订阅他人 conversation | 回 `conversation-not-permitted` | 通过（consumer 只能订阅 ticket 绑定的 conversation） |
| 撤权使 ticket 失效并断开现存连接 | `revokePrincipal` 返回 1，`connectionCount() === 0` | 通过 |

限额与慢连接清理：relay 侧实现为纯函数 `takeRateToken`（60/s 令牌桶）、`isSlowConsumer`（>500 帧）与 256KB 消息上限，超出走 `closeSlow`（关闭码 4429）。**本步骤未构造超限连接的真实用例**——纯函数已就位，真实超限行为标注为**未测**（见「未执行」）。

### FE-16-C —— PASS（真实 socket）

- **不重发状态未知的 submit**：consumer 发一条 `{kind:"command",type:"submit"}` → producer 收到 1 条；consumer 断线并以新 ticket 重连 → 等待后 producer **仍只收到 1 条**（relay 不缓存、不自动重投）。符合「断线只恢复事件游标，不重复执行不确定的命令」。
- **有序 + cursor 单调**：producer 连发 seq=1..5 帧 → consumer 收到 `[1,2,3,4,5]`，顺序与单调性成立。
- 过期 cursor / epoch gap 的**精确 gap 标注**由 FE-14 gateway 负责（`outboundGateway` 用例已覆盖），relay 只做按订阅路由、不做游标改写——REVIEWED 复用，不在 relay 层重复造。

### FE-16-D —— PASS（真实 socket）

- **未订阅/未授权 0 帧**：producer 绑 `conv-A` 发 trace 帧，consumer 绑 `conv-B` → consumer 收到 **0 帧**。跨 conversation 的帧不投递。
- **撤权立即断连**：consumer 连接中途 `revokePrincipal` → 收到关闭码 **4403**；该 ticket 复用再连 → **4401**（已随撤权失效）。
- Trace 四门（本地采集/远程外发/主体授权/显式订阅）的**端到端组合**属 FE-14 gateway 层（已在 FE-14 报告覆盖）；本层验证的是「relay 按 conversation 隔离 + 撤权断连」的服务端保证。

### FE-16-E —— PASS（本地，纯决策函数）

| 输入 | 期望 | 实测 |
| --- | --- | --- |
| 生产构建 + 有配置 + 有 URL 参数 | 拒绝 | `allowed=false`, `reason="production-build"` |
| 开发构建 + 无配置 + 有 URL 参数 | 拒绝 | `allowed=false`, `reason="url-param-only"` |
| 开发构建 + 有配置 + 有 URL 参数 | 允许，用配置地址 | `allowed=true`, `relayUrl="ws://127.0.0.1:8787"`（忽略 URL 参数的 9999） |

- **ws 服务端不进前端产物**：relay 位于 `scripts/`（Node 侧，纯 JS + `.d.mts` 声明），`src/` 内**只有测试** import 它；生产 `wsTransport.ts` 不 import relay，只经 `createSocket` 注入的 WS 工厂工作。可在 `src` 内对 `outboundDevRelay` 做静态引用扫描确认（当前引用仅 test 文件）。
- **结束后无监听残留**：relay `close()` 释放 socket/订阅/ticket/socket 监听；测试 `afterEach`/`dispose` 均 `await handle.close()`；全量回归后无端口占用告警（exit=0）。

## 未执行 / 待人工

- **超限与慢消费者的真实连接用例**：`takeRateToken` / `isSlowConsumer` / 256KB 上限已实现且为纯函数，但**未**构造真实的超速/超大/积压连接做端到端观测。当前只有代码路径存在，行为未实测。→ **NOT RUN（可自动补，建议后续加 3 条负例）**。
- **`app/hosts/plugins.ts` 宿主装配**：SPEC 范围含 `hosts/plugins.ts`，但**当前浏览器/桌面宿主插件集合未装配 dev-relay 传输**（`src/app/` 内无 wsTransport 或 devRelay 引用）。即「浏览器页面如何拿到 relayUrl + ticket 并装进 outboundPlugin」这一段**未接线**。→ **NOT RUN（属宿主接线，非本地逻辑）**。
- **Tauri / 手机页目视**：FE-16 的 dev-relay 是浏览器 dev 通道；Tauri 宿主与真实手机页的配对/重连/目视归 FE-15 宿主轨与人眼，本步骤不含。→ **NOT RUN（待宿主轨 + 真机）**。
- **公网部署**：不在本份范围（SPEC 明示）。
- **状态口径**：FE-16-A/B/C/D/E 为 **AUTO_PASS**；整体因宿主装配缺失标 **PARTIAL**，不写全 PASS。

## 共享接口影响

FE-16 无新增共享契约类型——`WsTransportOptions` / `WsLike` / `shouldConnectDevRelay` 均在本模块内导出，未改动 `services/outbound/contracts.ts` 的 FE-14 契约。relay 是 Node 侧脚本，不进前端产物。**`docs/modules/CONTRACTS.md` 无需新增追加表**（如需登记宿主接线，待接线落地时再补）。

## 复现命令

```powershell
Set-Location F:\AIVoice\Aika\aika-crossplatform
npx vitest run src/services/outbound/wsTransport.test.ts   # 19/19
npx vitest run src/services/outbound                       # 43/43
npx vitest run                                             # 1335 passed | 4 skipped
npx tsc --noEmit                                           # exit 0
```
