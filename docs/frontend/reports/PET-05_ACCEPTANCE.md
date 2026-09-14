# PET-05 验收报告 · Sidecar 生命周期与进程所有权

> 2026-09-14 · 需求 DPI-05 · [SPEC](../specs/PET-05.md) · 契约 [§6](../DESKTOP_PET_CONTRACT.md)
> 前置：PET-02（契约与 Service）、PET-01 的启动/退出证据 —— 后者仍为 **BLOCKED**（无本机 OpenPet），
> 因此"上游真实启动/退出机制"未核实的部分在本报告中如实标出，不当作已确认。

## 1. 改动

新增：

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/desktopPet/processManager.ts` | 进程状态机与所有权：attach / managed / starting / ready / incompatible / offline，并发启动合并、就绪探测、崩溃判定与重启预算、停止超时 |
| `aika-crossplatform/src/services/desktopPet/processManager.test.ts` | PET-05-A～G 定向测试（18 项） |
| `aika-crossplatform/src-tauri/src/desktop_pet_process.rs` | 原生进程端口：按句柄持有 `Child`、`CREATE_NO_WINDOW`、按句柄停止（`spawn_blocking` 避免冻界面）+ 5 项单测（含受控测试进程） |

修改（定向增量）：

| 文件 | 改动 |
| --- | --- |
| `aika-crossplatform/src/services/desktopPet/contracts.ts` | `DesktopPetProcessPort` 增加**可选** `cancelPending?()`（disable 时取消未完成的启动/重启计划；不终止已运行进程） |
| `aika-crossplatform/src/services/desktopPet/desktopPetService.ts` | `disable()` 调用 `deps.process?.cancelPending?.()` |
| `aika-crossplatform/src-tauri/src/lib.rs` | `mod desktop_pet_process;`、`manage(DesktopPetProcessState::default())`、注册 5 个命令 |
| `aika-crossplatform/src/services/desktopPet/fakeDesktopPet.ts` | 追加假操作系统进程端口（spawn/isAlive/exitInfo/stop、崩溃/正常退出/原因不明/停不掉） |

未改：`petWindow.rs`、`remote.rs`、`gateway.rs`、任何 renderer。

## 2. 命令与退出码

```text
npx vitest run src/services/desktopPet src/presentation/desktopPetPresenter.test.ts \
    src/kernel/architecture.test.ts src/app/runtimeFacade.test.ts
→ Test Files 6 passed (6) / Tests 109 passed (109) / exit 0
  （PET-02 23 + PET-03 21 + PET-04 17 + PET-05 18 + 两条门禁 30）

npx tsc --noEmit
→ 无 error TS 输出 / exit 0

cargo test --offline desktop_pet        （工作目录 src-tauri）
→ running 10 tests ... test result: ok. 10 passed; 0 failed / exit 0
  （http 5 + process 5；含受控测试进程的 spawn/stop/所有权用例）
```

## 3. 逐 AC 证据

| AC | 结论 | 证据 |
| --- | --- | --- |
| PET-05-A | **PASS** | attach 模式在 `ready`/`offline`/`incompatible` 三种探测结论下 `spawns()===[]`；即使 `stopOwnedOnExit=true`，退出时 `stopCalls===[]`（没有句柄就没有可停的东西）。外部已有实例只被探测，从未被接管 |
| PET-05-B | **PASS** | 20 个并发 `ensureReady()` 只产生 1 次 spawn；含空格与中文的 `C:\Program Files\OpenPet 桌宠\OpenPet.exe` 原样传入（不做任何拼串）；`…-setup.exe`/`unins000.exe` → `installer_rejected`、`.bat`/`.ps1` → `script_rejected`、相对路径/非 exe → `invalid_path`，全部零 spawn |
| PET-05-C | **PASS** | 就绪探测超时（15s 内一直 offline）→ `start_timeout` 抛出且只 spawn 一次（不无限启动）；预探测 `incompatible` → `incompatible` 且零 spawn、零 stop（不抢端口、不终止占用者）；进程存活但 API 离线 → `observe("offline")` 后相位降级且 spawn 次数不变（不重复 spawn） |
| PET-05-D | **PASS** | 单实例转交（本次 spawn 的进程退出但端点已就绪）→ 所有权释放、相位 `ready`、退出时零 stop；宿主不提供 `exitInfo` 时 `crash()` 也永不重启（fail-safe）；句柄表只存在于内存，模块内没有按进程名/裸 PID 停止的接口 |
| PET-05-E | **PASS** | 显式开启自动重启 + 确定崩溃（退出码 1）：连续 2 次各成功重启一次（spawn 总数 1→2→3），第 3 次崩溃命中预算 → 只记 `budgetExceeded=1`、不再拉起；正常退出（码 0）、原因不明（码 null）、未开启 autoRestart 三种情形均零重启 |
| PET-05-F | **PASS** | 启动途中 `cancelPending()` → 报 `cancelled` 且 `timers.active()===0`（无残留定时器）；`stop` 永不返回时退出在 3s 超时内结束、记 `stopFailures=1`、定时器清零（不拖住 Aiki 退出）；`stopOwnedOnExit=false` → 零 stop 且进程仍存活（默认保留桌宠）；`=true` → 只对本次 spawn 的 PID 发一次 stop |
| PET-05-G | **PASS（双轨）** | 逻辑轨：本报告 §2 的 18 项用假进程端口测生产状态机。原生轨：`cargo test` 的 `ownership_is_scoped_to_the_spawned_handle` 用受控测试进程（`cmd /C "ping -n 6 127.0.0.1"`）验证 spawn→存活→stop→句柄释放，并断言对不属于自己的 PID 调 stop 返回 `unknown_process`；静态断言覆盖 `CREATE_NO_WINDOW`、命令注册，并断言模块内不存在 `taskkill`/按名停止。**OpenPet 实测留 PET-07** |

## 4. 关键设计决定

- **所有权只来自本次 spawn 返回的句柄**，句柄只存在内存：PID 复用、Aiki 重启后的旧记录、用户自开实例都不会命中。接口层面没有"按名字 kill"。
- **停不掉就不停**：`stopOwnedOnExit=false`（默认）保留自有进程并释放所有权，下次只 attach。
- **崩溃必须被证明**：只有 `exitInfo` 明确 `exited && code !== 0` 才谈重启；拿不到退出原因就永不重启。把用户主动关掉的程序拉起来是最糟的行为。
- **`observe(connection)` 而不是轮询**：管理器不自己起定时器，装配层在每次健康探测后喂结论，避免出现第二条探测循环。
- **不弹控制台但角色窗口照常**：`CREATE_NO_WINDOW` 只抑制控制台窗口，上游 GUI 窗口不受影响。
- **不自动恢复持久化 PID 所有权**：本 SPEC 完全不落盘 PID。

## 5. 共享契约影响

| 变更 | 位置 | 兼容方式 | 受影响消费者 |
| --- | --- | --- | --- |
| `DesktopPetProcessPort.cancelPending?()` | `services/desktopPet/contracts.ts` | **可选**新增方法。不实现的端口行为不变（disable 只是不取消待定启动） | `desktopPetService`（已接线）、PET-06 装配 |
| `desktop_pet_process_spawn/_alive/_exit_status/_stop/_validate` | `src-tauri/src/lib.rs` | 新命令，无既有命令语义变化 | PET-06 宿主装配（`createTauriPetProcessPort`，PET-06 实现） |

## 6. 遗留项

| 项 | 归属 | 状态 |
| --- | --- | --- |
| 生产装配（把原生命令接成 `PetProcessPort`）与设置页 | PET-06 | 未实现 |
| OpenPet 真实启动、退出机制、单实例行为、端口占用行为 | PET-01/PET-07 | **BLOCKED**（README 未提；无本机运行环境） |
| 优先级/亲和性/Job Object 等更强隔离 | 后续 | 未做；0.5 不承诺 |
| 移动端/非 Windows 无窗口标志 | 后续 | 平台判断留在宿主层，本模块不分支 |
