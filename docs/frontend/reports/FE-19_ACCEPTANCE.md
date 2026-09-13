# FE-19 验收报告 · 前台应用传感器、摘要授权、停止全部与可信 busy

日期：2026-09-14。状态：**PASS（模块内 / 编排层）**；真实 Win32 切换、锁屏与 DPI 清单为 NOT RUN（真机轨，见文末）。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/foreground.rs` | 新增（`cfg(windows)`）：`EVENT_SYSTEM_FOREGROUND` 专用线程 hook（消息循环、退出时线程内 `UnhookWinEvent`）、`GetWindowThreadProcessId`+`QueryFullProcessImageNameW` 只取镜像文件名（**无 `GetWindowTextW`**，按 2026-09-14 修订）、`emit_to("main")` 定向事件、`environment_foreground_supported/_enable/_current/_busy_query` 四命令、busy 纯函数 `classify_busy` + `image_file_name`、3 个 Rust 单元测试 |
| `src-tauri/src/lib.rs` | 注册模块、`ForegroundState` 与 4 个命令 |
| `src-tauri/Cargo.toml` | windows crate 追加 features：`Win32_UI_WindowsAndMessaging`、`Win32_System_Threading`、`Win32_Graphics_Gdi`、`Win32_System_StationsAndDesktops`、`Win32_UI_Accessibility` |
| `src/services/environment/foregroundSource.ts` | 新增：`EnvironmentBridge` 注入；listen→enable→current 兜底时序；enableEpoch+seq 去重（迟到的 current 不覆盖更新事件）；enable 失败映射 `EnvironmentSourceError("denied"/"unavailable")` |
| `src/services/environment/busySource.ts` | 新增：`BusyObservation`（value/observedMonotonicMs/hostEpoch/reasonCode）、观测有效期 2000ms（≤2000 有效）、失败=unknown、不按进程名推定 |
| `src/services/environment/contextSource.ts` | 新增：`ContextSource` 实现（id=`environment`）；授权 fail-closed；load=每请求装配边界的出口校验接入点；snippet 仅应用名+时长+词表 ID 计数 |
| `src/presentation/environmentPresenter.ts` | 新增：每源开关/状态订阅/stopAll；开启先持久化再启动、关闭先撤销再持久化（写失败仍撤销且错误可见）；启动读取失败按关闭处理；快照稳定引用 |
| `src/presentation/tokens.ts` | `EnvironmentPresenterToken`（恒注册） |
| `src/app/plugins/presentationPlugin.ts` | 提供 environmentPresenter（monitor 缺失→available=false） |
| `src/app/hosts/plugins.ts` | `tauriHostPlugins` 注册 foreground source + environmentPlugin（hostEpoch=宿主 lifecycle epoch）；浏览器宿主不注册 |
| `src/services/storage/contracts.ts` | `SETTING_KEYS.environmentForegroundEnabled` / `environmentContextEnabled`（默认 false） |
| `src/App.tsx`、`src/hooks/useEnvironment.ts` | 设置区「环境感知」分组：采集开关（含六态文案）、独立摘要授权开关（说明可能随 Provider 请求发送）、「停止全部感知」按钮、错误显示；无能力宿主隐藏分组 |
| `docs/modules/CONTRACTS.md` | FE-19 追加登记 |

## 测试命令与退出码（`aika-crossplatform/` 目录）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/services/environment src/presentation/environmentPresenter.test.ts` | **63 passed（0 failed），退出码 0** |
| `npx vitest run src/services/storage src/kernel`（新增设置键回归 + 架构门禁） | 通过（0 failed），退出码 0 |
| `npx tsc --noEmit` | **无错误** |
| `cargo check`（src-tauri） | 通过（无 warning/error） |
| `cargo test foreground` | **3 passed（0 failed）** |

## 逐 AC 证据

| AC | 证据 | 状态 |
| --- | --- | --- |
| FE-19-A | `foregroundSource.test.ts`：fake bridge 下 listen→enable→current 命令顺序断言；current 为 `estimated`、hook 事件为 `measured` 且 schemaVersion 正确；同 seq 重放与迟到 current 兜底被去重（`["stale.exe","a.exe","c.exe"]`）；stop 调用 disable；接入生产 monitor 后广播事件无 title、停止后迟到事件零广播 | PASS |
| FE-19-B | `environmentPresenter.test.ts`：默认关（start 无启动调用、零事件）；持久化开启→启动自动启用；开启后 snapshot 立即可用；关闭后 disable 被调用且状态 off | PASS |
| FE-19-C | 浏览器/测试宿主不装 environmentPlugin（hosts 层无分支代码，装配即证据）；enable 命令失败映射 `unavailable`，monitor 状态可见为 error，启动无未捕获错误；`environmentPresenter` 恒注册（available=false 时 UI 隐藏分组） | PASS |
| FE-19-D | `contextSource.test.ts`：授权开→snippet 含应用名+时长（`Code.exe`/`30 秒`）；screen_keyword 按词表 ID（`VICTORY`）计数；生产 `contextAssembler` 消费 `ContextSource` 接口（结构兼容注入），未动 Assembler | PASS |
| FE-19-E | snippet JSON 断言不含 `SECRET-TITLE`、不含 `title` 字段——source 层根本不产生标题（Rust 无 GetWindowTextW，payload 类型无该字段） | PASS |
| FE-19-H | 授权关→零模型摘要；TTL 过期/停源后 load 为空；授权读取抛错 fail-closed；「关闭先撤销再持久化、写失败仍撤销」（presenter + contextSource 用例）；前台摘要不因停留超 60 秒失效（advance 120s 后仍在，停源立即消失） | PASS |
| FE-19-I | `stopAll`：fake source stopCount=1、recent/快照清空、摘要授权关闭、持久化写 false；stopping 状态经订阅可观测；持久化失败不回滚内存撤销；在途候选不外发（contextSource load 边界） | PASS |
| FE-19-J | `busySource.test.ts`：普通窗口 false、全屏/锁定 true、最小化/无前台/锁定未知 null、adapter 抛错 query_failed；2000ms 边界（≤2000 有效、2001 stale）；Rust `classify_busy` 同表驱动（cargo test 3/3，含 `busy_query_does_not_panic` 冒烟） | PASS |
| FE-19-G | Rust 侧无 `GetWindowTextW`（代码路径可验证）；TS payload 类型无 title 字段；事件流 JSON 无标题断言；`environment_foreground_supported` 探测命令存在 | PASS |

## 共享接口影响

见 `docs/modules/CONTRACTS.md` 2026-09-14 FE-19 节。关键点：
- 出口校验接入点 = `contextSource.load`（每次请求装配时执行），未重写 ContextAssembler、未新增发送路径；撤销期间装配出的旧摘要不可能进入请求。
- busy 观测有效期 2000ms（≤2000 有效），与 FE-22 的边界用例对齐。
- 装配触碰了 `presentationPlugin`（新 presenter）与 `tauriHostPlugins`（新 source/plugin），均为追加；`kernel/architecture.test.ts` 全绿。

## 待联调 / NOT RUN（真机轨）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| FE-19-F 真机清单（VSCode↔浏览器↔游戏切换 <1s、进程名正确） | **NOT RUN** | 需真实 Tauri 运行 + 用户开启前台感知开关；fixture 不证明 Win32 hook |
| 开关连续 20 次资源无泄漏（真机） | **NOT RUN** | 同上；Rust 侧以 `WM_QUIT`+线程内 Unhook 设计保证，未真机计量 |
| 锁屏 / 150% DPI 下 busy 观测 | **NOT RUN** | `classify_busy` 已表驱动验证；物理像素/显示器矩形口径已注释，需真机确认 |
| capabilities 声明 | 按项目先例 | 自定义命令未列入 capabilities（同 `remote_*` 先例，主窗可直接调用）；FE-20 pet 窗口将引入窗口级权限校验 |
