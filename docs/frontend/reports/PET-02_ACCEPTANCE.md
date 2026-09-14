# PET-02 验收报告 · 接入契约、Service 与能力模型

> 2026-09-14 · 需求 DPI-02 · 依据 [契约](../DESKTOP_PET_CONTRACT.md)、[SPEC](../specs/PET-02.md)
> 前置：PET-01 资料结论（协议字段取自 [官方 CLI 实现](https://raw.githubusercontent.com/X-T-E-X/OpenPet/master/skills/openpet-cli/scripts/openpet_cli.py)，**尚未本机实机核对**，见 PET-01 报告）。
> 本 SPEC 只做归一化接口、Service 生命周期、状态订阅、profile 校验与结果归一化；HTTP 传输在 PET-03，事件映射与该轮发送器在 PET-04，进程控制在 PET-05。

## 1. 改动

新增（全部为新增文件，未改任何既有源文件）：

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/desktopPet/contracts.ts` | `desktopPet.integration.v1` 全部类型、token、端点/文本/配置归一化纯函数、契约常量 |
| `aika-crossplatform/src/services/desktopPet/profile.ts` | `PetProfileV1` 校验、语义→animationId 映射、能力推导 `deriveCapabilities` |
| `aika-crossplatform/src/services/desktopPet/desktopPetService.ts` | `createDesktopPetService`：生命周期、generation、能力守门、结果归一化、单飞探测与退避、快照订阅、诊断计数 |
| `aika-crossplatform/src/services/desktopPet/fakeDesktopPet.ts` | 测试资产：假时钟/定时器/adapter/进程端口（只替代外部依赖） |
| `aika-crossplatform/src/services/desktopPet/desktopPetService.test.ts` | PET-02-A～F 定向测试 |

修改（定向增量，未动既有语义）：

| 文件 | 改动 |
| --- | --- |
| `docs/modules/CONTRACTS.md` | 追加一节登记 `desktopPet.integration.v1`（可选新增、无字段破坏） |

未改：`petWindow.rs`、`src/pet/`、`hooks/usePetWindow.ts`、任何 Runtime/Provider/存储模块。

## 2. 测试命令与结果

```text
npx vitest run src/services/desktopPet src/kernel/architecture.test.ts --reporter=verbose
→ Test Files 2 passed (2) / Tests 51 passed (51) / exit 0
  （其中 desktopPet 23 项、内核边界门禁 28 项）

npx tsc --noEmit
→ 无 error TS 输出 / exit 0
```

只跑本目录与受影响的内核边界门禁，未跑全仓测试、未做 Tauri 构建。

## 3. 逐 AC 证据

| AC | 结论 | 证据 |
| --- | --- | --- |
| PET-02-A | **PASS** | 《五个归一化方法的稳定结果》：5 个方法经 fake adapter 返回稳定 `PetResult`；adapter 收到的是语义名（`wave`/`happy`）而非供应商 id；`commandId`/`expiresAt` 由 Service 分配（断言 `expiresAt === now + 4000`）；结果对象只有 `outcome`，接口层面无法把 `accepted` 写成 `played`。上游拒绝时原样上交 `{outcome:"failed",code:"http_error"}` 并计入诊断 |
| PET-02-B | **PASS** | `localhost→127.0.0.1`、`[::1]` 合法；LAN/公网/https/凭证/路径/query/fragment/无端口 11 例全部 `null`；`normalizePetConfig` 对非法地址显式抛错（不静默回退）；空文本 → `skipped/invalid_input`；`🙂×600` 截断为 500 code point 且不劈开代理对（`removed=101`），超长计入 `truncatedTexts` |
| PET-02-C | **PASS** | 断线 → 快照 `stale=true`、能力全部 `unknown`、`actions=[]`、发送被拒为 `offline`；`runtimeVersion` 与 profile `release` 不符 → 全 `unknown`；`petId` 不符 → `say=native` 但 `action/emotion=unknown`；无 profile → 全部 `unknown`；OpenPet 的 `interactionEvents/audio/lipSync` 恒 `unsupported`；运行期角色切换递增 generation 并清空 actions |
| PET-02-D | **PASS** | 20 轮 `enable/disable` 后 `timers.active()===0`、启用期间恒为 1 个定时器且间隔 10s；重复 `enable`/`disable`/`dispose` 幂等（`adapter.dispose` 只调用 1 次）；旧 generation 的挂起探测 resolve 后快照停在 `disabled`；退订后零通知；离线退避实测 `[2000,4000,8000,16000,30000]` |
| PET-02-E | **PASS** | adapter 抛错时 `say` 返回 `unknown/protocol_error`，同时 `fakeRuntime.submit` 正常返回 turnId（无阻塞、无冒泡）；探测异常转 `offline` 并计入 `probeFailures`；静态扫描确认本目录生产文件不含 `providerClient`/`companionRuntime`/`RuntimeToken` —— 不存在第二套对话编排入口 |
| PET-02-F | **PASS** | `docs/modules/CONTRACTS.md` 已登记 `desktopPet.integration.v1` 与 `DesktopPetServiceToken`（测试断言）；无服务时消费方走 `hidden` 分支、有服务时 `visible`；`capabilityIsUsable` 对 `native`/`unsupported` 分别 true/false |

## 4. 语义边界（写清以免被误读）

- `accepted` 只证明请求被受理，**不表示动画已播放**；播放终止由上游 Runtime 决定。
- 能力 = 锁定 profile ∩ 已验证角色映射 ∩ 当前连接状态；`unknown ≠ 没有`，但一律不允许发送。
- 关闭状态零网络：`status()` 在 `enabled=false` 时只读快照，不发请求。
- 非法 endpoint 显式抛错；`PET_CONFIG_DEFAULTS.enabled=false`，旧 `pet.enabled` 不转换为托管启动授权（该迁移属 PET-06）。

## 5. 共享契约影响

- 新增可选能力，**不改任何既有类型/字段**；不装桌宠时 `DesktopPetServiceToken` 不注册，消费方 `tryResolve` 得 null 后隐藏入口。
- 受影响消费者（尚未接线，PET-06 落地）：桌面宿主装配、展示桥接（PET-04 presenter）、设置页。
- 已在 `docs/modules/CONTRACTS.md` 记录版本/兼容方式/受影响方。

## 6. 遗留项与待联调

| 项 | 归属 | 状态 |
| --- | --- | --- |
| HTTP 传输、四端点、超时/体积/代理禁用 | PET-03 | 未实现 |
| 单在途 + 16 待发的有界发送器、事件合并/去重 | PET-04 | 未实现（当前 Service 直连 adapter，`skipped/overloaded`、`stale_turn` 代码已就位但未产出） |
| 进程端口真实实现与所有权 | PET-05 | 未实现（Service 只调用注入的 `DesktopPetProcessPort`） |
| 生产装配、设置页、旧桌宠入口迁移 | PET-06 | 未实现 |
| OpenPet 真实版本字段/角色/动作核对（决定 profile 内容） | PET-01 / PET-07 | **BLOCKED**（无本机运行环境） |
| 真实 Windows Aiki→OpenPet 闭环 | PET-07 | NOT RUN |
