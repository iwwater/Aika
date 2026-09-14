# MVP-03 验收 · 删除 Legacy Pet

2026-09-14。基线 `58dd1be`。接手时工作区已有前一位执行者的未提交改动，按要求**保留、未回滚**；本报告只记录我核到的事实与我自己做的修复。

## 结论

| AC | 状态 | 一句话 |
| --- | --- | --- |
| A | **PASS** | 旧桌宠在源码、Tauri 注册与窗口配置三处都已退出生产代码，且有自动化断言守住 |
| B | **部分 PASS** | 「OpenPet 关闭时主窗正常、不恢复旧桌宠」有真实宿主证据；**「真人逐一点验陪伴入口」NOT RUN** |
| C | **PASS** | 抓屏授权与自身遮挡检查保留并已脱离旧 pet；`cargo test` 41/41 |
| D | **PASS** | TS 受影响范围 403/403、`tsc` 0 错误、前端构建通过；旧配置不被当成外部桌宠授权 |

接手时的问题（7 项）**全部核实并处理完毕**，其中 3 项是真缺陷、2 项是交接清单里未提到的连带损坏（`main.tsx` 的未闭合注释使全应用无法挂载；`mvp06MemoryWiki.test.ts` 缺 `now` 字段使全量构建的 `tsc -b` 失败，见 §3）。修复后本轮没有 FAIL 项。

## 1. 接手核查：交接清单 7 项逐条对账

| # | 交接描述 | 核查结果 | 处理 |
| --- | --- | --- | --- |
| 1 | `main.tsx` 尾部残留未闭合注释，`void boot()` 可能被吞 | **确认，且是最严重的一处**：注释块缺 `*/`，`void boot();` 落在注释里，`tsc` 报 `TS1010: '*/' expected`。修复前整个应用不会挂载、内核不会装配 | 删除脱落注释，恢复 `void boot();` |
| 2 | `companionIntent.test.ts` 排序断言按旧字段顺序 | **确认**：期望值自身不是字典序（`sessionEpoch` 排在 `requestId` 前），而 `Object.keys().sort()` 的结果是 `requestId < schemaVersion < sessionEpoch` | 改成字典序，并加注释说明「期望值必须自己就是排序结果」 |
| 3 | 夹具仍有旧 `pet` 字段，四项失败 | **确认**：夹具传 `pet: {open,close,focusMain}`，契约已是可选 `view?`。除 4 项行为失败外，按类型规则这里还必然是一处多余属性错误——已实测：把夹具改回 `pet:` 时 `tsc` 报 `TS2353: Object literal may only specify known properties, and 'pet' does not exist in type 'CompanionSessionDeps'` | 夹具改 `view:`；`petCalls`→`viewCalls`、`petIntent()`→`intent()`；重放用例的局部变量改名 `replayed`（原名 `intent` 会遮蔽辅助函数，改后触发 TDZ） |
| 4 | `useCompanionControls.ts` 未完成类型检查与生产接线验证 | **类型检查通过**（`main.tsx` 修好后 `tsc` 0 错误）；接线逐项与旧 `usePetWindow.ts` 对照：sensors/settings/submitUser/submitProactive/clock 一致，`monitor.onStateChange` → 屏幕源 off/error/denied 时 `markStoppedExternally()`，订阅与 dispose 都成对清理 | 无需改行为；补了「不传 view」的理由与**自动路径缺口**的说明（见 §4） |
| 5 | `scripts/migrate-mvp03.mjs` 是一次性迁移脚本，检查后移除 | 逐行核对其改动清单（`main.tsx`/`App.tsx`/`useDesktopPet.ts`/`lib.rs`/`screen.rs`/`tauri.conf.json`/`desktopPetHostWiring.test.ts` + 删除清单）确认效果已落地 | **已删除**。注：第 1 项的损坏正是它的启发式截断造成的（第 19–26 行先按注释定位截断、再补 `void boot()`） |
| 6 | 旧 `src/pet/`、`usePetWindow.ts`、`petWindow.rs`、pet capability 已删；意图协议与抓屏校验已迁移 | **确认**，引用、Tauri 注册、窗口配置全部核实（见 §2 AC-A/C） | 只做文档与命名收尾 |
| 7 | 最近定向测试 44 项 39 通过 5 失败 | 复现为 **51 项 5 失败**（与交接的 44/39 口径不同，应以复现为准） | 修复后 **51/51** |

## 2. 逐 AC 证据

### AC-A 生产源码无旧桌宠 —— PASS

- **源码（production）**：全仓检索 `PetApp` / `petWindow` / `pet_window` / `usePetWindow` / `PetWindowManager` / `pet.presentation` / `pet/pet` 在 `src` 与 `src-tauri/src` 内**零命中**（仅剩墓碑键、说明性注释与测试里的断言字符串，见下）。`main.tsx` 不再按窗口 label 分流，也没有 `?view=pet` 分支。
- **配置（production + fixture）**：`tauri.conf.json` 只声明 `main` 一个窗口；自动化断言在 `src/app/hosts/desktopPetHostWiring.test.ts:262`（`main.tsx` 不含 `PetApp`、窗口列表等于 `["main"]`）。
- **原生（production）**：`mod petWindow` 与 `#[allow(non_snake_case)]` 删除，`pet_window_show/hide/set_click_through/reset_position/broadcast/request_snapshot/focus_main/pet_intent_submit` 八个命令从 `invoke_handler` 移除；`capabilities/pet.json` 删除。
- **有意保留的两处遗留**（都不是「旧实现复活」）：
  - `SETTING_KEYS.petWindowEnabled`（`pet.windowEnabled`）：**墓碑键**，生产代码无任何读取方；保留是为了让「旧开关键 ≠ 外部桌宠授权」这条断言可写（`SETTING_KEYS.desktopPet` 是另一个键，`desktopPetHostWiring.test.ts` 断言两者不相等）。已把注释改成墓碑说明。
  - `submitUser` 的 trigger 取值 `"pet_talk" | "pet_screen_talk"`：这是契约里的稳定值（会随轮次一起落库），本轮**不改语义**，仅作为命名遗留登记（§5）。
- **旧 relay 与窗口自动恢复（production）**：`pet/relay.ts`、`pet/intentBridge.ts`、`pet/manager.ts`、`pet/petPresentation.ts` 全部删除；启动时按 `petWindowEnabled` 自动开窗的恢复逻辑随 `usePetWindow.ts` 一起消失。

### AC-B 关闭 OpenPet 后主窗正常、不恢复旧桌宠；陪伴入口仍可用 —— 部分 PASS

**真实宿主（device）**：本机 **OpenPet 未运行**（进程表为空）时启动 Aiki debug 宿主（`cargo build --offline --features custom-protocol`，exit 0）：

- 进程存活、主窗句柄存在（`pid=43036 handle=21500740 title=愛花 Aika`）。
- `PrintWindow`（`PW_RENDERFULLCONTENT`，不受其它窗口遮挡影响）抓窗口自身像素：主窗完整渲染——左侧角色卡、会话区（历史记录「你好啊」与回复都在）、右侧 Provider/相处状态/长期记忆/快速开始。证据图 `evidence/MVP-03_main_window.png`。
- **只有这一个窗口**：`tauri.conf.json` 已无 `pet` 窗口，原生侧也无创建路径；没有旧桌宠被恢复。
- **内核装配已执行（device，间接但决定性）**：在 `127.0.0.1:17321` 起一个只记录请求的替身监听器，宿主在 10 秒周期上打来 `GET /api/status`（22:30:45 起来，22:30:55、22:31:05 各一次）。这条探测只可能来自「内核装配完成 → 桌宠插件 activate → 集成按配置启用」这条链——**正是修复前被吞掉的那条路径**。未启用时零请求、且只打这一个端点，也一并复核。

**陪伴/暂停/结束入口（production 代码 + fixture）**：`App.tsx` 里 `controls.session` 分组含「主动陪伴 / 安静陪伴 / 暂停读屏 / 看屏幕聊聊 / 结束陪伴」五个入口，并在分组内显示读屏状态与配额；控制器 22 项行为断言全部通过（一次确认、active/quiet、暂停保留可选视图、结束关闭视图、screen_talk 在 quiet/暂停下仍可用、旧 epoch 丢弃、requestId 去重、迟到结果作废）。

**NOT RUN（human）**：在真实窗口里用真人点击逐一点验这五个入口。本轮尝试用窗口消息（`WM_LBUTTONDOWN/UP`，不移动用户鼠标、不抢焦点）触发设置面板，坐标修正后仍不生效——WebView2 的输入层不接受非前台合成点击；**没有改用真实鼠标去点**（用户正在本机工作，不干扰其会话）。因此这一项如实记 NOT RUN，而不是拿代码阅读冒充点击证据。

### AC-C 抓屏权限/自身遮挡检查保留且不依赖旧 pet；原生测试通过 —— PASS

- `cargo test --offline` → **41 passed / 0 failed**（`screen.rs`、`window_access.rs`、`desktop_pet_*`、`gateway`、`remote`、`foreground`、`secret_store` 全绿）。
- 关键两条：`screen::tests::self_window_and_overlap_are_refused_before_capture`（自身遮挡仍然拒绝）与 `window_access::tests::only_main_can_capture`（迁移后只允许 `main` 抓屏，`pet` 与未知 label 都被拒——旧窗口删了也没放宽权限）。
- `screen.rs` 两处调用者校验改指 `crate::window_access`，`self_hwnds` 从 `[main, pet]` 收窄为 `[main]`；`pet` 标签不再出现在任何抓屏判定里。
- 新模块 `window_access.rs` 只含「标签白名单校验」这一件事，没有把旧 pet 窗口的任何状态带过来。

### AC-D 受影响测试与构建通过；旧配置被忽略；文档替代关系更新 —— PASS

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/presentation src/app src/kernel src/services/desktopPet src/services/environment src/hooks` | **53 files / 560 tests passed, exit 0**（含 `mvp04ObservationTurn` / `mvp05IsolationMatrix` / `mvp06MemoryWiki` 三份后续 SPEC 的用例——它们随本阶段一起全绿，但不据此提前宣告 MVP-04~06） |
| `npx tsc --noEmit` | **exit 0**（0 错误；修复前为 `TS1010` 一处，另有夹具多余属性一处） |
| `npm run build`（tsc -b + vite） | **exit 0**，`✓ built in 5.29s`。**注意**：全量 `tsc -b` 会把测试文件也编进来，暴露了一处 `tsc --noEmit`（不含测试的配置）看不见的错误——`src/app/mvp06MemoryWiki.test.ts` 构造的 `ContextSourceInput` 缺必填的 `now` 字段（前一位执行者遗留），已补 `now: 5_000` |
| `cargo test --offline --lib` | **exit 0**，41 passed（另对 `window_access` 单独定向：1/1） |
| `cargo build --offline --features custom-protocol` | **exit 0**（实机核对用宿主） |

- **旧配置被忽略、不误转授权**：`pet.windowEnabled` 无生产读取方；`SETTING_KEYS.desktopPet` 与它不同键且有断言；配置读取失败时桌宠插件走 `catch` 显式禁用并记短日志（MVP-02 已落，本轮复核）。
- **文档替代关系更新**：`FE-20` 追加「实现已删除」段（列出被删文件/命令/窗口配置与两处迁移落点，并写明不要按它恢复）；`FE-31` 追加「迁移后只剩主窗一层校验、`petEpoch`→`sessionEpoch`、点击读屏仍无宿主」段。共享契约 `docs/modules/CONTRACTS.md` **无需改动**——本轮没有跨模块公共接口变化。

## 3. 改动清单（本轮我做的）

| 文件 | 改动 |
| --- | --- |
| `src/main.tsx` | 删除未闭合的旧「窗口分流」注释，恢复 `void boot();`（阻塞级） |
| `src/presentation/companionSessionController.test.ts` | 夹具 `pet:`→`view:`；`petCalls`→`viewCalls`；`petIntent()`→`intent()`；重放用例局部变量改名；4 处测试名/注释措辞对齐「可选视图」 |
| `src/presentation/companionIntent.test.ts` | 排序期望值改为字典序 + 说明注释；用例名去掉「pet 塞进来」的旧说法 |
| `src/presentation/companionIntent.ts` | 头部注释重写：删掉「Rust 校验窗口 label + 主窗再校验＝两层」的过时断言，说明现在只在主窗内部使用、只剩一层 |
| `src/presentation/companionSessionController.ts` | 6 处注释对齐（可选视图端口新增说明；`pet` 发起的请求 → 本会话；`handleIntent` 不再声称经 Rust 窗口校验） |
| `src/presentation/tokens.ts` | `CompanionSessionController` 类型出口的注释去掉 `PetWindowManager` 依赖说法 |
| `src/hooks/useCompanionControls.ts` | 头部说明改为「不传 view 的理由 + 自动路径缺口」（不改行为） |
| `src/services/storage/contracts.ts` | `petWindowEnabled` 注释改为**墓碑键**说明 |
| `src-tauri/src/lib.rs` | `mod window_access` 归位到字母序末尾（`cargo fmt` 风格） |
| `src-tauri/src/screen.rs` | `self_hwnds` 上方注释「（pet / 主窗）」→「（主窗）」 |
| `scripts/migrate-mvp03.mjs` | **删除**（一次性 codemod，效果已核实；复核 `scripts/` 目录已无该文件） |
| `src/app/mvp06MemoryWiki.test.ts` | 测试构造的 `ContextSourceInput` 补必填 `now` 字段（交接清单未提到的第 8 项：只有全量构建的 `tsc -b` 才会检查测试文件，此前 `npm run build` 实际是坏的） |
| `docs/frontend/specs/FE-20.md`、`FE-31.md` | 追加 MVP-03 收口说明 |
| `docs/frontend/reports/evidence/MVP-03_main_window.png` | 主窗渲染证据图 |

未回滚、未改写任何前一位执行者的业务实现；`git status` 里其余未提交改动保持原样。

## 4. 已知缺口与移交

1. **自动路径没有生产触发源**（不是本轮引入）：`CompanionSessionController.onScreenChanged` 在基线与现在都只有测试调用，因此「画面变化 → 本地 OCR → 候选 → 统一主动频控 → 发送」这条链在真实宿主里跑不起来，界面上「主动陪伴」开关的描述目前是超前描述。基线同样如此，故**不算 MVP-03 的回归**；补触发源属 **MVP-04**「OCR 观察与陪伴闭环」范围，已在 `useCompanionControls.ts` 就地写明。
2. **真人点击逐项验证陪伴入口**：NOT RUN（见 AC-B）。
3. `submitUser` 的 trigger 命名遗留（§2 AC-A）。
4. **本轮未重新验 MVP-01/02 的原始口径**：`src/kernel`、`src/app/hosts`、`src/services/desktopPet` 的用例已随 403 项全绿一起跑过，但 MVP-01 报告里的「82 项」等口径我没有复现，也不据此宣告它们通过；留给最终里程碑的全量回归。
5. **PET-07 的宿主侧闭环仍以既有报告为准**，不因本轮改动升级结论；本轮只新增「内核装配成功 + 主窗渲染」这条与本 AC 相关的证据。

## 5. 下一步

按依赖推进 **MVP-04**（OCR 观察与陪伴闭环，含上面第 1 项触发源）。MVP-03 的报告只代表本阶段结论：模块与原生侧已收口，真实窗口的交互需真人复核。
