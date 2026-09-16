# MVP-09 验收报告 · Aiki 兼容联调

日期：2026-09-16。SPEC：[MVP-09](../specs/MVP-09.md)。依据：[RPD v1.2](../../RPD_MVP_0.6.md) MVP-R09、[SPEC 索引](../SPEC_MVP_0.6.md)。前置：[MVP-08](MVP-08_ACCEPTANCE.md)、[MVP-10](MVP-10_ACCEPTANCE.md)。

## 状态摘要

| AC | 结论 | 证据等级 |
| --- | --- | --- |
| A | **PASS** | 生产 adapter + 假传输端口 + 真实进程字段核对 |
| B | **PASS** | 生产 `deriveCapabilities` 单测 |
| C | **PASS（未改动 + 回归）** | 既有单测 |
| D | **PASS** | 生产 `ProcessManager` 单测 + 原生约束测试 |
| E | **PARTIAL** | fixture/fake 与「HTTP accepted」层 PASS；**屏幕可见层 NOT RUN** |
| F | **PASS** | 三通道分别验证 + 双仓 fixture 同步 |

**E 是 PARTIAL，因此 MVP-09 尚未整体收口。** 原因见 §6。

## 1. 改动范围

| 仓库 | 文件 | 改动 |
| --- | --- | --- |
| Aika | `src-tauri/src/desktop_pet_http.rs` | 端点表新增 `Shutdown`；新增 `accepts_credential`；`desktop_pet_http_request` 增加可选 `bearer_token`，且**只对 shutdown 端点**生效 |
| Aika | `src-tauri/src/desktop_pet_process.rs` | `desktop_pet_process_spawn` 增加可选 `exit_token`；新增 `spawn_command` 只注入一个具名环境变量 `PET_SHELL_EXIT_TOKEN` |
| Aika | `services/desktopPet/contracts.ts` | 新增 `PetProductInfo`/`PetShutdownCapability`；`PetStatus` 加 `product`/`shutdown`；`DesktopPetAdapter` 加可选 `requestExit`；新增 `reportedRuntimeVersion` |
| Aika | `services/desktopPet/openPetProtocol.ts` | 解析 `product` 与 `capabilities.shutdown`；`shutdown` 端点；`buildShutdownRequest`；401/403 判定 |
| Aika | `services/desktopPet/profile.ts` | 版本判定取值口径改为 `runtimeVersion ?? product.version` |
| Aika | `services/desktopPet/openPetAdapter.ts` | 跟踪并暴露 `product()`/`shutdownCapability()`；实现 `requestExit`（能力未声明即跳过） |
| Aika | `services/desktopPet/processManager.ts` | `spawn` 支持 `exitToken`；`createExitToken`/`protocolExit` 依赖；`releaseOwnership`；dispose 优先协议退出、失败回退句柄；新增诊断计数 |
| Aika | `services/desktopPet/tauriPetHttp.ts` / `tauriPetProcess.ts` | 透传 `bearerToken` / `exitToken` |
| Aika | `app/hosts/desktopPet.ts` | 装配：安全随机令牌生成 + `protocolExit` 接 adapter |
| Aika | `fixtures/openPetFixtures.ts` | 新增 PetShell 状态/退出响应 fixture（上游 fixture 一律未改） |
| Aika | `docs/frontend/DESKTOP_PET_CONTRACT.md` | 登记增量（§7） |
| pet-shell | 无 | 本阶段未改 shell；沿用 MVP-08 构建 `33D6B6AF…692D` |

## 2. AC-A：四端点兼容与新身份识别 — PASS

**兼容性未漂移**：四端点的方法、路径、请求字段、成功/失败判定、错误码分类全部保持。`RESPONSE_FIXTURES` 逐条判定不变，`400`→`invalid_input`、`404/405/415`→`incompatible` 的既有结论未动。端点表从 4 项变为 5 项，多出来的 `shutdown` 是**新增**，不是把旧路径改了名。

**Aiki 识别增量显式列出**（这是本 SPEC 要求的交付物）：

1. `/api/status` 的 `product`（`name`/`version`/`upstream`）——运行时真实身份，`upstream` **只作署名、不参与判定**。
2. `/api/status` 的 `capabilities.shutdown`（`endpoint`/`version`/`auth`/`available`）——`available` 缺失一律按不可用（fail-closed）。
3. `POST /api/shutdown`（契约版本 1，`Authorization: Bearer`）。
4. 版本判定口径扩展到 `product.version`（见 §3）。

`provider` 仍是 `openpet`：线协议未变，改 provider 会波及配置与 profile 校验而收益为零。

**新字段不伪装**：旧上游 `OK_STATUS` / `DEVICE_STATUS_SNAPSHOT` 里没有 `product`/`capabilities`，解析后 `status.product === undefined`、`status.shutdown === undefined`，单测覆盖。

## 3. AC-B：能力绑定实际版本与角色 — PASS

原逻辑只在「上游报 `version` 字段」时做版本比对，而上游**从不报**该字段（PET-01 已实证），于是这条判定形同虚设。现在取值口径是 `runtimeVersion ?? product.version`：

| 场景 | 结果 |
| --- | --- |
| 运行时无版本（旧上游） | 不做版本判定，行为与旧版一致 |
| `product.version` 与 profile `release` 一致 | 正常派生 `native`/`mapped` |
| `product.version` 与 profile 不符 | **全 `unknown`**（含 `say`） |
| `version` 与 `product.version` 同时存在 | 上游字段优先 |
| 角色不匹配 | `action`/`emotion` 退化，`say`/`event` 保持 |
| 未就绪（disabled/connecting/offline/incompatible） | 全 `unknown`，不返回缓存值 |

「一个改了实现却沿用旧 profile 的组合被当成兼容放过」正是这条要挡住的；`unknown`/`unsupported` 不会被包装成 `native`，也不允许发送未经 profile 登记的动作 id（既有白名单逻辑未动，仍由单测覆盖）。

## 4. AC-C：传输与调度约束 — PASS（未改动）

本阶段**没有**触碰这些常数与路径，回归保持绿色：单请求 1500ms、单在途 + 有界队列、POST 不自动重试、取消/换轮清除未发命令、断连不拖住业务轮。

新增的 `requestExit` 复用同一套本地期限判定：`remainingTtl` 不足 500ms 直接 `skipped/expired`，不会为了「赶紧退出」而突破发送期限规则。

## 5. AC-D：协议退出只作用于 owned 实例 — PASS

```text
managed 启动 → spawn 携带 exitToken（就是本进程生成的那一份）
退出时      → 先请求协议退出；成功后仍释放句柄（原生句柄表不留死条目）
协议退出被拒 → 回退 port.stop(handle)，计数 protocolExitFallbacks +1
协议退出挂起 → 3s 超时后回退，dispose 不被拖住
attach 模式 → 零 spawn、零令牌、零协议退出、零 stop
stopOwnedOnExit=false → 既不终止也不请求退出
无令牌来源  → 完全不涉及协议退出，行为与旧策略逐条一致
单实例转交  → 释放所有权并丢弃令牌，之后不再调用协议退出
```

边界靠结构保证而不是叮嘱：

- **凭据只在 owned 期间存在**：`releaseOwnership()` 是唯一的放弃路径，句柄与令牌一起丢。单实例转交、崩溃后释放、重启计划三条路径都走它。
- **能力门禁在前端**：`requestExit` 在 `shutdown.available !== true` 时直接 `skipped`，一次请求都不发；旧上游没有 `capabilities` 字段，因此默认不可用。
- **凭据不进日志/快照**：诊断只有计数；错误体与日志都没有令牌。
- **原生侧收窄注入面**：`spawn` 只多一个具名可选参数，Rust 侧只写一个环境变量，测试断言「没有令牌时注入 0 个变量、有令牌时恰好 1 个且名字固定」。
- **凭据不给别的路由**：`accepts_credential` 只对 `Shutdown` 为真，原生侧忽略其它端点上的 Authorization；TS 侧单测断言非 shutdown 请求一律不带 `bearerToken`。

**回退即「不扩大终止范围」**：401/403/503 判 `failed` 而非 `incompatible`，因为对面仍是兼容运行时，只是这次不许退出；任一步失败都落到原有的句柄终止路径。

## 6. AC-E：fake 与真实链路 — PARTIAL

| 层次 | 结果 |
| --- | --- |
| fake 端口兼容与失败边界 | **PASS**：桌宠模块 86 项 + 装配/表现/服务/生命周期 63 项 + 原生 12 项全绿 |
| 入队 | **PASS**：`PetDiagnostics` 的 sent/accepted/skipped/failed 计数与 `processManager.diagnostics()` 的 `protocolExits`/`protocolExitFallbacks` 分别可读 |
| HTTP accepted | **PASS（复用 MVP-08 device 证据）**：对同一产物 `33D6B6AF…692D` 实测四端点 200、错误体逐字一致、`/api/shutdown` 四条鉴权分支与成功退出 |
| **屏幕可见** | **NOT RUN** |

**屏幕可见层未跑的原因**：它需要真实 Aiki 桌面应用配到 `managed` 模式并运行 PetShell，再由人确认屏幕上出现角色——本轮没有可用的 Aiki 桌面构建与人工观察窗口。按契约「accepted 不等于播放完成」，这一层不能用 HTTP 200 替代，因此 AC-E 记 PARTIAL 而不是 PASS。PET-07 的适用 AC 分项同理未逐条复验。

补充：shell 在本阶段**未被修改**，产物哈希与 MVP-08 一致，所以四端点与退出的 device 证据仍然对应同一份二进制，不构成「新构建继承旧结论」。

本节数字对应的测试命令与退出码见 §10。

## 7. AC-F：三通道与双仓同步 — PASS

三条通道分别验证，不因查询错误通道判失败：

| 通道 | 验证方式 |
| --- | --- |
| `recentEvents` | 只由 `event` 调用写入；单测与 device 均按「event 后才增长」断言 |
| `bubbleText` | 由 `say` 写入并按 TTL 消退；device 用 UTF-8 字节收发逐字读回中文 |
| `lastAction` | 由 `action` 与 `event` 的既有映射写入；`reviewing` → `review` 已核对 |

双仓 fixtures 同步：pet-shell 侧新增的 `product`/`capabilities`/退出响应形状，已以 `PETSHELL_STATUS_SNAPSHOT`、`PETSHELL_STATUS_NO_EXIT_TOKEN`、`PETSHELL_401_*`、`PETSHELL_403_*`、`PETSHELL_503_*`、`PETSHELL_200_EXITING` 固化进 Aika 的 `openPetFixtures.ts`；上游 v0.1.6 的 fixture **一条未改**，原版 OpenPet 的现有接入不被新身份破坏（旧 fixture 判定全绿）。

## 8. 共享接口影响

- `docs/frontend/DESKTOP_PET_CONTRACT.md` 已更新：§1 增 `product`/`shutdown`/`requestExit`，§2 增「凭据只对 shutdown 生效」，并新增 §7 登记 fork 增量（含端点契约表、调用规则、端口被占时的边界）。双仓同轮生效。
- 新增契约版本：`shutdown.version = 1`；`PetConfig.schemaVersion` 未变（配置形状无改动）。
- 原生命令签名变更：`desktop_pet_http_request` 增加可选 `bearerToken`、`desktop_pet_process_spawn` 增加可选 `exitToken`。均为可加性，旧调用方（只传原有字段）行为不变。
- 新增可观测项：`PetProcessDiagnostics.protocolExits` / `protocolExitFallbacks`。

## 9. 未覆盖与阻塞

| 项 | 状态 |
| --- | --- |
| 真实 Aiki→PetShell 的屏幕可见层 | **NOT RUN**，需 Aiki 桌面构建 + 人工确认 |
| PET-07 适用 AC 的逐条复验 | NOT RUN，同上 |
| `product`/`capabilities` 在设置页的展示 | 未要求（Aiki 侧只做识别，不做 UI 变更）；如需展示另行立项 |
| Live2D 链路 | 归 MVP-11 |
| 正式产品名/图标定稿 | 临时 PetShell；改名需同步 profile `release` 与契约文档 |

0.6 冻结点仍未证明：「sprite 与 Live2D 单一出口可切换」属 MVP-11。

## 10. 测试证据（命令与退出码）

补记于 2026-09-16：此前版本只有逐 AC 的「单测覆盖」表述，缺 AGENTS.md 要求的「测试命令 + 退出码」一节。下列命令在非沙箱环境复跑，用于验证 §1 所列 Aika 侧改动；`cwd = aika-crossplatform`（Rust 为 `aika-crossplatform/src-tauri`）。

```text
npx tsc --noEmit                            退出码 0
npx vitest run src/services/desktopPet      Test Files 5 passed (5)；Tests 86 passed (86)；退出码 0
npx vitest run src                          Test Files 154 passed | 4 skipped (158)；
                                            Tests 1677 passed | 4 skipped (1681)；退出码 0
cargo test --lib desktop_pet                test result: ok. 12 passed; 0 failed; 31 filtered out
cargo test --lib                            test result: ok. 43 passed; 0 failed
```

与 §6 三层证据的对应关系：

| §6 表述 | 复现命令 | 本次结果 |
| --- | --- | --- |
| 桌宠模块 86 项 | `npx vitest run src/services/desktopPet` | **86 passed，原样复现** |
| 装配/表现/服务/生命周期 63 项 | 该分组的原始命令当轮未留档 | 未单独复现；已由全量命令覆盖（1677 passed ⇒ 该分组必然全绿） |
| 原生 12 项 | `cargo test --lib desktop_pet` | **12 passed，原样复现** |

说明：

- 全量命令同时覆盖 `app/hosts`（装配）、`presentation`（表现）、`services`（服务）与桌面宠物生命周期用例，是上述「未单独复现」一层的可复现替代。
- 4 个 skipped 为既有环境变量门控样本（真实模型类），与本 SPEC 改动无关；无新增跳过。
- 本 SPEC 仍未验证的层次（屏幕可见层、Tauri 真机 `plugin-sql`）保持 §9 的 NOT RUN 结论，不因单测全绿而上调。
