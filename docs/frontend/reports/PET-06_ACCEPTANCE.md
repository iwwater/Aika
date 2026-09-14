# PET-06 验收报告 · Aiki 装配、设置与旧路径迁移

> 2026-09-14 · 需求 DPI-06 · [SPEC](../specs/PET-06.md) · [RPD 迁移表](../RPD_DESKTOP_PET_INTEGRATION.md) · [共享契约](../../modules/CONTRACTS.md)
> 前置：PET-03/04/05。真实桌面能力仍属 PET-07；本报告只证**接线**。

## 1. 改动

新增：

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/app/hosts/desktopPet.ts` | 宿主插件 `host.desktopPet`：装配 adapter + ProcessManager + Service，把探测结论回喂进程管理器，注册 `DesktopPetServiceToken` |
| `aika-crossplatform/src/services/desktopPet/settings.ts` | 配置与 profile 的持久化；坏值回落默认且**不写回**；`isEnabled()` 供旧窗口让位判断 |
| `aika-crossplatform/src/services/desktopPet/tauriPetProcess.ts` | 原生进程端口绑定（`invoke` 注入，不 import `@tauri-apps`） |
| `aika-crossplatform/src/hooks/useDesktopPet.ts` | 设置页状态与命令：启用/关闭、保存配置、保存 profile、测试连接、发送演示 |
| `aika-crossplatform/src/app/hosts/desktopPetHostWiring.test.ts` | PET-06-A～G 定向测试（14 项） |

修改（定向增量）：

| 文件 | 改动 |
| --- | --- |
| `src/presentation/tokens.ts` | 新增 `DesktopPetPresenterToken`（`presentation.desktopPet`，恒注册） |
| `src/app/plugins/presentationPlugin.ts` | `optional` 加 `DesktopPetServiceToken`/`ClockToken`；提供 `DesktopPetPresenterToken`；Runtime 惰性取 |
| `src/app/hosts/index.ts` | 桌面宿主装上 `desktopPetPlugin`（原生 HTTP + 进程端口） |
| `src/services/storage/contracts.ts` | 新增 `SETTING_KEYS.desktopPet` / `.desktopPetProfile` |
| `src/services/desktopPet/contracts.ts` | `DesktopPetService.profileSnapshot()`（追加）；`DesktopPetServiceDeps.onProfileChange?`（追加） |
| `src/services/desktopPet/openPetAdapter.ts` | `endpoint` 接受 getter（改端口不重建对象）；构造期仍校验一次 |
| `src/presentation/desktopPetPresenter.ts` | profile 默认从 Service 取（活配置），不再依赖装配期抄一份 |
| `src/hooks/usePetWindow.ts` | 集成启用时自研桌宠窗口让位；`openPet()` 被挡时给出明确原因 |
| `src/App.tsx`、`src/App.css` | 桌宠设置区新增「外部桌宠（OpenPet）」分组与 profile 编辑框 |
| `docs/modules/CONTRACTS.md` | 追加 PET-06 一节 |

未做：`src/pet/` 与 `petWindow.rs` **未删除**（SPEC 明确：旧源码彻底移除另列清理，不混入本 SPEC）。
`docs/frontend/specs/FE-20.md` 等旧规格由 RPD/索引标注替代关系，本轮未再改动。

## 2. 命令与退出码

```text
npx vitest run src/app src/presentation src/kernel src/services/desktopPet src/services/storage
→ Test Files 35 passed (35) / Tests 430 passed (430) / exit 0
  （其中 PET-06 定向 14 项、PET-02 23、PET-03 21、PET-04 17、PET-05 18、两条门禁 30）

npx tsc --noEmit
→ 无 error TS 输出 / exit 0
```

未跑全仓测试、未做 Tauri 打包（PET-07/INT-03）。

## 3. 逐 AC 证据

| AC | 结论 | 证据 |
| --- | --- | --- |
| PET-06-A | **PASS** | 空库 → 默认 `enabled=false`、无 profile；旧 `pet.windowEnabled=true` **不会**变成托管启动授权；损坏 JSON 与非法 endpoint 都回落默认值，且断言存储里的原值**没被改写**；`schemaVersion:2` 的坏 profile 等价于没有 profile。关闭状态下装配成功但 `http.calls===[]`、`process.spawns===[]`；启用后 `status()` 返回 `ready` 且探测次数 ≥1；关闭后再调 `status()` 仍是 `disabled` 且**请求数不变** |
| PET-06-B | **PASS** | 生产装配 + 假外部端口：注入主窗 Runtime → 发 `state:generating`/`generated`/`settled`，HTTP 端口实际收到 `status`、`event`（thinking）、`action`（情绪走 action 端点）、`say`（body 为 `{text:"在的哦", ttlMs∈[3000,4000]}`）；`bufferDiagnostics().sent===3`；`registry.tryResolve(RuntimeToken)` 就是我们注入的那一个（无第二 Runtime）。浏览器宿主不装该插件时 `tryResolve(DesktopPetServiceToken)===null` |
| PET-06-C | **PASS** | `usePetWindow` 的启动恢复段内，让位判断（`if (desktopPetEnabled) return;`）**位于** `await manager.open()` 之前（源码断言）；`openPet()` 在 `legacyBlocked` 时直接返回并给出原因；`applyLegacyBlock` 会在切到外部桌宠时收起自研窗口。关窗不调 Runtime cancel / TTS stop（沿用 FE-20-G 的既有实现，未改） |
| PET-06-D | **PASS** | 桌宠端口不可达时：Presenter 快照 `connection==="offline"`、`stale===true`（界面据此显示明确原因）；同一轮事件经桥接后**一条命令也没发出**（`say` 计数 0），且没有异常冒泡、没有改变业务侧状态。Provider/Runtime/存储均未受影响（装配层无异常、内核 `report.ok` 为真） |
| PET-06-E | **PASS** | 10 次 `enable/disable` 后再启用：`status` 探测总数只 +1（单飞探测 + 单条循环，无重复订阅/定时器）；`kernel.dispose()` 后 attach 模式 `spawns===[]`、`stopCalls===[]`（没有所有权遗留） |
| PET-06-F | **PASS（如实登记差距）** | 设置页明确写出**「当前桌宠不支持点击回传」**，并说明陪伴会话/看屏幕聊聊/暂停结束仍在主窗；`useDesktopPet` 导出 `petInputSupported: false`；主窗原有「陪伴」设置块与入口未被删除。**未把双向桌宠标为已完成** |
| PET-06-G | **PASS** | `docs/modules/CONTRACTS.md` 已登记 PET-06 一节（含 `DesktopPetPresenterToken`、`desktopPet` 键、行为增量与受影响消费者）；新键与旧 `pet.windowEnabled` 互不相同（旧库照常可读）；内核装配与新装配路径测试全绿 |

## 4. 关键设计决定

- **装配顺序就是产品语义**：先读配置再决定装什么。`enabled=false` 时不 enable、不请求、不 spawn——"关着不打扰"由结构保证，不靠各处 if。
- **状态快照是唯一同步点**：Service 每次通知同时更新 adapter 的 endpoint 与进程管理器的 `observe(connection)`；不引入第二条监控循环。
- **profile 是活配置**：桥接与 adapter 都通过 getter 读，换角色/换端口不需要重建对象；否则会出现"Service 按新 profile 放行、adapter 按旧映射发送"的错位。
- **表现出口互斥**：集成启用 → 自研窗口让位。两个都开会让同一句话被两个窗口各说一遍。
- **坏值不写回**：沿用 `settingsStore` 的既定语义；配置文件损坏时界面显示默认值，用户改一次即覆盖。

## 5. 共享契约影响

见 `docs/modules/CONTRACTS.md` 的「PET-06 生产装配与设置」一节。要点：

- 全部为**可选追加或新注册**，无既有字段破坏；`DesktopPetService.profileSnapshot()` 与 `DesktopPetServiceDeps.onProfileChange?` 是接口/依赖新增，已同步登记。
- 受影响消费者：`app/hosts/index.ts`（装插件）、`presentationPlugin`（提供 Presenter）、`useDesktopPet`/`usePetWindow`/`App.tsx`（设置区）、PET-07（真实链路）。

## 6. 遗留项与待联调

| 项 | 归属 | 状态 |
| --- | --- | --- |
| 真实桌面链路（原生 HTTP/进程、可见表现、性能） | PET-07 | **NOT RUN** |
| 设置页「启动方式/退出时处理/自动重启」在真实进程上的行为 | PET-07 | 逻辑已实现并测过（PET-05），实机未验 |
| 旧源码（`src/pet/`、`petWindow.rs`）的彻底移除 | 后续清理 SPEC | 未做（按 SPEC 要求不混入） |
| Live2D / 点击回传 / 口型 | PET-08 / 后续 | DEFERRED |
| OpenPet 真实版本字段与角色动作清单（决定 profile 内容） | PET-01/PET-07 | **BLOCKED** |
