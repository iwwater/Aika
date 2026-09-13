# FE-20 验收报告 · 桌宠窗口、气泡、穿透恢复与找回

日期：2026-09-14。状态：**PASS（逻辑轨）**；真实 Tauri 窗口行为（透明/拖拽/穿透/全屏表现/DPI）为 NOT RUN（设备轨单列）。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/petWindow.rs` | 新增：7 命令（show/hide/set_click_through/reset_position/broadcast/request_snapshot/focus_main）；show 幂等、hide=销毁；broadcast 仅 main 可调（运行时 label 校验）+ 64KB 上限；reset 用 `MonitorFromWindow`+`GetMonitorInfoW` 的 `rcWork` 工作区居中、关穿透、超工作区约束尺寸；`pet://presentation`/`pet://snapshot-request` 定向 emit；1 个 Rust 测试 |
| `src-tauri/src/lib.rs` | 注册模块与命令 |
| `src-tauri/capabilities/pet.json` | 新增 pet 窗口 capability：仅 `core:default`（无 http/sql/opener/notification） |
| `src/pet/petPresentation.ts` | 新增：`pet.presentation.v1` 协议校验（2000 字符截断）、`createPetViewModel`（epoch+seq 合并、snapshot 帧跨 epoch 重同步、3000/8000ms 淡出）、`connectPetViewModel`（先订阅再请求快照） |
| `src/pet/relay.ts` | 新增：主窗中继（节流 250ms、快照请求应答、`aggregatePresentation` 白名单投影：mood/speaking/currentSubtitle/lastProactive，runtimeTurnId=null 不伪造） |
| `src/pet/manager.ts` | 新增：generation 竞态裁决（show/show、show/hide；迟到窗口立即销毁）、close 幂等、关闭解绑中继、零 Runtime/TTS 调用 |
| `src/pet/PetApp.tsx`、`pet.css` | 新增：pet 窗口 React 入口（无 KernelProvider）、PetController（拖拽区/左键回主窗/右键菜单）、Bubble、AvatarPlaceholder 占位 |
| `src/main.tsx`、`src/app/hosts/detect.ts` | 按 Tauri 窗口 label 分流 pet 页；`currentWindowLabel()` 收在 detect.ts |
| `src/hooks/usePetWindow.ts`、`src/App.tsx` | 主窗控制：显示/关闭桌宠、找回、关闭穿透；`SETTING_KEYS.petWindowEnabled` 持久化（读取失败按关）；设置区桌宠分组 |
| `docs/modules/CONTRACTS.md` | FE-20 追加登记（pet.presentation.v1，FE-28/29 为消费者） |

## 测试命令与退出码（`aika-crossplatform/` 目录）

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/pet src/services/environment src/presentation/environmentPresenter.test.ts` | **78 passed（0 failed），退出码 0** |
| `cargo test petWindow` | **1 passed（0 failed）** |
| `cargo check` | 通过 |
| `npx tsc --noEmit` | 无错误 |

## 逐 AC 证据

| AC | 证据 | 状态 |
| --- | --- | --- |
| FE-20-A | `manager.test.ts`：fake 端口下 open/close 幂等（重复 open 只 1 次 show、重复 close 只 1 次 hide）；创建参数（transparent/decorations/always_on_top/skip_taskbar/320×420）在 `petWindow.rs` 构造器中逐项出现。**真实透明/无边框/置顶/任务栏属性 NOT RUN（设备轨）** | PASS（逻辑）/ NOT RUN（真机） |
| FE-20-B | `manager.test.ts` aggregate 投影：仅白名单字段、无语音会话不伪造 speaking；`petPresentation.test.ts` 静态扫描：`src/pet/` 无 `services/runtime\|storage\|voice` import；relay→broadcast 命令联通 | PASS |
| FE-20-C | `manager.test.ts`：菜单命令（set_click_through/reset_position/hide）经 fake 端口断言；竞态仅保留期望窗口。真实拖拽/右键/穿透 NOT RUN（设备轨） | PASS（逻辑）/ NOT RUN（真机） |
| FE-20-D | pet 分流按 `currentWindowLabel()`；浏览器宿主 `usePetWindow` 返回 available=false（isTauriHost 判断），设置分组隐藏；主窗既有 168 项测试零回归 | PASS |
| FE-20-F | `petPresentation.test.ts`（假时钟）：旧 seq/旧 epoch/迟到快照零覆盖；快照请求（低 seq）不覆盖新增量；epoch 变化仅 snapshot 帧重同步；2999/3000ms 字幕淡出边界、7999/8000ms 气泡边界；新字幕取消旧淡出；无关帧不重置气泡计时；取消当轮立即结束说话态、旧轮回放零效果 | PASS |
| FE-20-G | `manager.test.ts`：show/hide 竞态仅保留期望窗口（迟到 open 自行销毁）；close 解绑中继（无遗留定时器）；Runtime cancel/TTS stop 零调用（结构断言：manager/relay 无该入口 + fake 记录为零） | PASS |
| FE-20-H | **NOT RUN**：移出可见区/改布局后从主窗找回、100%/150% DPI 需真机；Rust `reset_to_work_area` 已按 `rcWork`+scale_factor 实现并注释 DPI 口径 | NOT RUN |
| FE-20-I | Rust `assert_allowed_caller` 单元测试：pet 调 broadcast 被拒、main 调 request_snapshot 被拒；`capabilities/pet.json` 仅 `core:default`（pet 无 sql/http/opener/notification 权限）。运行时动态负例（真实窗口跨窗调用）NOT RUN | PASS（静态+纯函数）/ NOT RUN（动态） |

## 共享接口影响

- `pet.presentation.v1` 已登记 CONTRACTS.md；FE-28（expression/motion 可选字段）与 FE-29（播放会话 ID / 口型参数可选字段）按「追加字段兼容旧壳」演进。
- `SETTING_KEYS.petWindowEnabled` 新键；`main.tsx` 分流与 `detect.ts` 平台判断维持「平台判断只在 app/hosts/」门禁（architecture.test.ts 全绿）。

## 待联调 / NOT RUN（设备轨）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 真实透明/无边框/置顶/任务栏属性 | NOT RUN | 需真实 Tauri 运行 |
| 拖拽、右键菜单、点击穿透实测 | NOT RUN | 需真机（`data-tauri-drag-region` + `set_ignore_cursor_events`） |
| 独占全屏游戏中的置顶表现 | NOT RUN | 预期差异（全屏独占模式）如实记录，不承诺 |
| 找回（移出屏幕/改布局/DPI 100%/150%） | NOT RUN | reset 逻辑已实现，物理像素口径需真机验证 |
| pet 窗口动态恶意调用 | NOT RUN | 纯函数 label 校验 + capability 收窄已就位；动态验证需真机 |
