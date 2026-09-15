# FE-33 真机验收 · 缺陷记录（现场登记）

> **2026-09-15 范围失效说明（先读这条）**：MVP-03 已**删除旧自研桌宠实现**（`src/pet/`、`hooks/usePetWindow.ts`、`src-tauri/src/petWindow.rs`、`pet_window*` 命令、`pet` 窗口配置全部移除）。因此本文件里 **BUG-01（点「显示桌宠」不生效）所针对的实现已不存在**，其修复与复验不再有意义；FE-33-F 中依赖「显示桌宠 / 拖动 / 双击 / 穿透」的条目同样失效，需按新形态（外部 OpenPet，归 [PET-07](PET-07_ACCEPTANCE.md) 与 [MVP-04](MVP-04_ACCEPTANCE.md)）重新划范围后重跑。
> BUG-02（可观测性）、BUG-03（聊天区滚动）不受影响，仍需真机复验。

| 项 | 值 |
| --- | --- |
| 被测版本 | `b29a6d0`（`master`，工作区干净） |
| 被测构建 | 前端 dist 2026-09-14 16:34 + `aika-crossplatform.exe` 26.7 MB @16:39（`cargo build --release --features custom-protocol`） |
| 发现时间 | 2026-09-14 16:48 |
| 报告人 | 用户（真机操作）/ 记录人：本会话 |
| 关联 | [FE-33 SPEC](../specs/FE-33.md) · [FE-33 验收报告](FE-33_ACCEPTANCE.md) · [执行手册](FE-33_真机执行手册.md) |
| 记录状态 | 3 项已完成生产代码定向修复与逻辑验证；**仍需新构建真机复验** |

---

## 一、结论先行

1. 现场反馈三个现象：**桌宠显示不生效**、**环境感知是否起作用不可判断**、**聊天区不能向下滚动**。
2. 已用一次实测**排除**了「生产装配在内核里启动失败」这个共因假设（详见第二节）——环境链路的 token 在真实宿主插件集下**全部注册成功**。
3. 三个现象目前都**缺少可判定的真机证据**（截图/控制台/窗口状态），因此**一律按「已登记、未定性」处理，不计 PASS 也不计 FAIL**。严禁凭现象措辞直接判缺陷成立。
4. 已顺带补上一处**测试覆盖盲区**（真实 Tauri 宿主从未被装配过一次），新增用例已通过。

---

## 二、已排除的假设（省得返工）

**假设**：环境感知分组消失 / 陪伴分组消失，是因为真实 Tauri 宿主装配时内核启动失败（`report.ok=false`），导致 `useOptionalService` 一律返回 null。

**实测（决定性）**：新增 `src/app/hosts/hostAssembly.test.ts`，用真实 `tauriHostPlugins()` + 真实 `capabilityPlugins()` + 展示层装配：

```
REPORT_OK=true
FAILED=[]
environment.monitor: has=true resolved=yes
screen.contextSource: has=true resolved=yes
capture.scheduler:   has=true resolved=yes
environment.busy:    has=true resolved=yes
context.sources:     has=true resolved=yes
presentation.environment: has=true resolved=yes
presentation.companion:   has=true resolved=yes
PLUGINS=host.time, host.secrets, host.settings, host.notifier, host.fetch, host.lifecycle,
        app.environment, host.environment, host.remote, host.outboundTransport, host.storage,
        llm.providerSettings, llm.memory, llm.contextSources, llm.trace, llm.usage,
        llm.runtime, outbound.core, voice.engines, stickers.library, presentation.core
        —— 21 个全部 activated
```

**结论**：插件图与依赖声明没有问题，设置页的「环境感知」分组**本应出现**且两个 source 可用；「陪伴」分组的构造前提也满足。因此现象 #1/#2 **不能**归因于装配失败。

> 局限（如实记）：该用例把 `host.storage` 换成了内存 SQLite（Node 打不开 plugin-sql），因此**不覆盖** plugin-sql 的真实行为——若真机上存储打开失败，`contextSourcesPlugin`（`requires StorageToken`）会连带失败，那将是另一条链路，需单独取证。见 BUG-02 的待补项。

---

## 三、缺陷清单

| 编号 | 现象 | 定位层级（初判） | 严重 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- |
| BUG-01 | 点「显示桌宠」后看不到桌宠 | 前端渲染 / 桌面窗口 | 严重 | 高 | 已修复，待真机复验 |
| BUG-02 | 环境感知是否生效无法判断 | 可观测性 | 一般 | 中 | 已修复，待真机复验 |
| BUG-03 | 聊天区不能向下滚动 | 前端布局 / 渲染 | 严重 | 高 | 已修复，待真机复验 |

---

### BUG-01 · 点击「显示桌宠」不生效

- **操作路径**：设置 → 桌宠分组 → 点「显示桌宠」。
- **预期**：出现一个 320×420 的置顶无边框小窗口（`always_on_top`、`skip_taskbar`、`transparent`、`decorations(false)`），窗口内显示占位立绘，设置页开关变为「已显示」。
- **实际**：（用户描述）不奏效。**具体表现未知**——是「无任何窗口出现」/「有窗口但空白」/「设置页出现红字错误」三者之一，需现场确认。
- **定位层级**：前端渲染或桌面窗口创建。
- **疑似根因（按可能性排序，均为待验证假设）**：
  1. **窗口建出来但内容不可见**：`src/components/AvatarPlaceholder.tsx` 的 SVG 只有 `viewBox`，无 `width`/`height` 属性，尺寸完全依赖 `App.css` 的 `.avatar-art { width: 100%; height: auto; }`。主窗有固定宽度容器（`.avatar-portrait { width: min(18vw,235px) }`）所以正常；而 pet 窗口里 `.pet-hit` 是 `display: inline-block`（收缩宽度，`src/pet/pet.css:22`），百分比宽度落在收缩容器上属于循环求解——若解析为 0，窗口就是**全透明空壳**，用户看到「什么都没发生」。
  2. **窗口创建失败但错误未暴露**：`pet_window_show`（`src-tauri/src/petWindow.rs:43`）失败会返 Err，经 `usePetWindow.run()` 落到 `pet.error`，设置页应显示红字。若现场没有红字，此因可能性低。
  3. **窗口被创建在工作区之外**：`petWindow.rs` 未在创建时定位，仅 `pet_window_reset_position` 才居中；建窗落点由系统决定，可能落在不可见区域或被其他窗口压住（`always_on_top` 应能压住，故可能性低）。
- **待补证据**：① 点按钮后设置页是否出现红字错误；② 任务管理器/Alt+Tab 是否出现第二个 Aika 窗口或新增 `msedgewebview2` 进程；③ 设置页开关是否变成「已显示」；④ 截图。
- **备注**：`PET_WINDOW_LABEL="pet"`（`petWindow.rs:18`）与 JS 分流（`main.tsx:47`）一致，`capabilities/pet.json` 已为 `pet` 窗口授权 `core:default` —— 这两项已排除。

---

### BUG-02 · 环境感知是否生效不可判断

- **操作路径**：设置 → 环境感知分组 → 开「前台应用感知」/「屏幕感知」。
- **预期**（FE-33-A/B 门槛）：分组出现；两个 source 初始「已关闭」；开启后显示「运行中」；切换应用后能看到正确进程名；屏幕感知能读到摘录。
- **实际**：（用户描述）不知道有没有起作用。**歧义点**：是①**整个分组没出现**，还是②**分组在、开关能开、但没有任何可观察的效果**？这两种是不同缺陷。
- **定位层级**：若①→前端渲染（分组可见性）；若②→产品可观测性缺陷（UI 不反馈采集结果）。
- **疑似根因**：
  - ① 可能性已被第二节实测**大幅降低**（token 全部注册，`available` 应为 true）。剩余可能是真机上存储打开失败导致连带失败（见第二节局限），或用户没找到入口。
  - ② **高度可能**：设置为「运行中」后，界面**没有任何采集证据**——没有「最近读到的应用名」、没有采集次数、没有「上次读屏时间」，只有 `environment.snapshot.error` 才显示文字。用户**无法自证它在工作**。FE-33 的 D/E 项本来就要靠人工比对请求内容才能确认，属于本质难以观测。
- **待补证据**：① 环境感知分组**是否出现**（截图设置页该区域）；② 两个 source 的标签文字与状态（`前台应用 · 已关闭/运行中/权限被拒/错误`）；③ 开关有没有出现红字错误；④ 若分组存在，能否用内建**调试工作台 → 一轮数据流 / Trace** 看到环境内容进入请求（这是最接近 FE-33-E 的自证手段）。
- **影响**：直接阻塞 FE-33-E 的判定——验收者无法确认「环境内容是否随请求发出」。

---

### BUG-03 · 聊天区不能向下滚动

- **预期**：消息超过可视高度时，聊天区可向下滚动到最新一条。
- **实际**：（用户描述）不能下拉。**歧义点**：是①**消息区滚不动**（内容溢出但无法滚动），还是②**能滚但不会自动跳到最新**（新消息在下方看不到）？
- **定位层级**：前端布局 / 渲染。
- **已做的静态核查（未发现布局错误）**：
  - `.messages { min-height: 0; flex: 1; overflow: auto; }`（`App.css:75`）——约束与溢出正确；
  - 父链 `.chat-panel`（`App.css:67`，flex column）落在 `.workspace`（`App.css:37`，`display:grid` + 定高 `calc(100% - 58px)`）的网格行内，行被拉伸 → 高度确定；
  - 无第二份样式表覆盖（已全库检索 `.messages` / `.chat-panel` / `.workspace` / `.app-shell` / `.settings-modal`，各只有一处定义）；
  - `.workspace[hidden] { display: none; }`（`App.css:41`）修复仍在位。
- **发现的相关事实**：**主聊天区没有任何「滚动到底部」逻辑**——全仓只有 `VoiceModal.tsx:40` 一处 `scrollIntoView`。即新消息到达时**不会自动滚到最新**。若用户指的是②，这就是根因（且属长期存在、非本次回归）。
- **可能的①类根因（待验证）**：若用户指的不是消息区而是**设置对话框**，则要看 `.settings-modal { max-height: 92vh; overflow: auto; }`（`App.css:189`）在真实窗口下的表现；新增的「环境感知」「陪伴」两组长文案使其内容显著变长，若窗口高度受限更易暴露。
- **待补证据**：① 明确指出是**哪一块**（聊天消息区 / 设置对话框 / 其他），最好截图；② 窗口是否被缩小过、当前窗口尺寸；③ 滚动条是否可见（样式是细条低对比度：`scrollbar-width: thin` + `rgba(55,230,255,.25)`）；④ 用鼠标滚轮与拖动滚动条是否都不动。
- **影响**：属核心交互，严重度高。

---

## 四、顺带发现的覆盖盲区（RISK-01）

| 项 | 内容 |
| --- | --- |
| 问题 | `src/app/composition.test.ts` 对 `tauriHostPlugins()` **只校验插件 id 列表**（`composition.test.ts:95-112`），全部断言 `report.ok===true` 的用例用的都是 `testHostPlugins`。真实生产宿主插件集**从未被装配过一次**。 |
| 影响 | 「插件漏声明 optional / 依赖 token 拼错」这类缺陷在模块测试里全绿，却能让真机整片功能消失（FE-26 的 `DEPENDENCY_NOT_DECLARED` 拒启动即同类）。 |
| 处置 | 已新增 `src/app/hosts/hostAssembly.test.ts`（1 用例，**已通过**）：真实 `tauriHostPlugins()`（仅替换 `host.storage` 为内存 SQLite）+ 真实 `capabilityPlugins()` + 展示层，断言启动成功且环境链路 7 个关键 token 均注册。 |
| 遗留 | 不覆盖 plugin-sql 真实存储行为（归 INT-01）。 |

---

## 五、下一步取证方法（按性价比排序）

1. **截图三处**：设置页「环境感知」区域、设置页「桌宠/陪伴」区域、聊天区现状。—— 一张图就能定性 BUG-02 的①/②与 BUG-03 的歧义。
2. **确认是否有红字错误**：`pet.error`、`environment.snapshot.error` 都以红色（`#e5484d`）渲染在设置页内。有没有红字，直接区分「静默失败」与「显式失败」。
3. **改用带 DevTools 的调试构建**（release 版无控制台，看不到 `console.error`）：`cargo build --features custom-protocol`（debug profile，devtools 默认开启）。可读 `[aika] kernel failed to start`、WebView 报错、网络失败。**需用户授权后再建。**
4. **用内建调试工作台自证环境链路**：开启开发者模式 → 工作台 → 「一轮数据流 / Trace 页」，对照 FE-33-E 检查环境内容与摘录是否进入请求。

---

## 六、修复记录（2026-09-14）

| 编号 | 修复 | 逻辑证据 | 仍需真机确认 |
| --- | --- | --- | --- |
| BUG-01 | SVG 增加固有 `width/height`，pet 收缩容器改为明确宽度；创建或再次显示窗口时都移动到当前工作区中央，且 show/focus 失败不再静默吞掉 | Rust 桌宠权限定向测试 1/1；TypeScript 类型检查通过 | 点击后角色可见、窗口在屏内、设置显示「已显示」 |
| BUG-02 | 每个环境 source 增加隐私安全的活动证据：前台源展示最近进程名；屏幕源展示监听提示及最近一分钟受控信号计数；不展示标题、截图或 OCR 原文 | Presenter 新增隐私负例；相关前端测试 53/53 | 切换 VSCode/浏览器后进程名在 1 秒内更新；屏幕信号计数可变化 |
| BUG-03 | Grid/Flex 父项补 `min-height:0` 与 `overflow:hidden`，保证 `.messages` 成为实际滚动容器；新增“位于底部时随新消息自动滚底，用户上滚后不抢滚动”逻辑 | TypeScript 类型检查与架构/前端定向测试通过 | 长对话滚轮、拖动滚动条和新消息自动滚底均正常 |

验证命令：

```text
npx tsc --noEmit
npm test -- --run src/kernel/architecture.test.ts src/presentation/environmentPresenter.test.ts src/pet/manager.test.ts src/pet/petPresentation.test.ts
cargo test petWindow::tests --lib
```

结果：TypeScript exit 0；Vitest 4 files / 53 tests PASS；Cargo 1 PASS。未用这些逻辑测试替代真机结论。

---

## 七、记录边界（诚实性声明）

- 本记录**只**登记现象与代码层定位线索，**没有**真机截图、控制台输出或报文证据；三个现象的**定性一律待补证**。
- 第二节的结论来自本机 Node 环境的真实装配，**不能**替代真机（plugin-sql / WebView2）验证。
- 已按上节修改生产代码并补测试；尚未生成新 release 构建，也未完成修复后的真机复验。

---

## 八、独立复验（复核人：本会话，2026-09-14 17:1x）

**复验原则**：不采信执行者结论，重跑命令 + 复核 diff 与生产行为；只对**逻辑层**下结论，真机结论一律待补。

### 8.1 命令复现（全部由复核人重跑）

| 项 | 命令 | 复核结果 | 与执行者声明 |
| --- | --- | --- | --- |
| 类型检查 | `npx tsc --noEmit` | **exit 0** | 一致 |
| 定向测试（执行者的 4 文件） | `npm test -- --run src/kernel/architecture.test.ts src/presentation/environmentPresenter.test.ts src/pet/manager.test.ts src/pet/petPresentation.test.ts` | **4 files / 53 tests PASS，exit 0** | 一致 |
| 更宽范围（复核人加跑） | `npx vitest run src/presentation src/services/environment src/app src/pet src/domain` | **75 files passed / 1 skipped；835 passed / 1 skipped / 0 failed，exit 0** | 补充证据 |
| Rust 全量单元（复核人加跑） | `cargo test --lib` | **31 passed / 0 failed，exit 0** | 比「1/1」更宽，无 Rust 回归 |
| 空白检查 | `git diff --check` | **exit 0（无输出）** | 一致 |
| 改动范围 | `git status` / `git diff --stat` | 8 个已跟踪文件 +111/−36；**`gateway.rs` 为误报**（blob hash 两侧同为 `184279d4…`，内容未变，仅 mtime 被构建触碰） | 见下 |

> **`gateway.rs` 澄清**：`git status` 显示 ` M` 但 `git diff` 输出为空、`git status --porcelain=v2` 两侧 blob hash 相同 → **不是改动**，不进任何提交范围。

### 8.2 生产代码复核结论（逐缺陷）

| 缺陷 | 复核判定 | 依据 |
| --- | --- | --- |
| BUG-01 | **修复方向正确，逻辑成立** | ① `AvatarPlaceholder.tsx` 补 `width="200" height="260"` → SVG 获得固有尺寸，消除「百分比落在收缩容器上循环求解」的根因；② `pet.css` 把 `.pet-hit` 改为 `display:block` + `width:min(200px, calc(100vw - 24px))`，不再依赖收缩宽度；③ `pet_window_show` 建窗后与新显示都调 `reset_to_work_area` 并在 Windows 用 `MonitorFromWindow(MONITOR_DEFAULTTONEAREST)` + `GetMonitorInfoW` 取工作区居中 → 消除「屏外/透明窗口」。`set_focus`/`show` 失败不再被 `let _ =` 吞掉 |
| BUG-02 | **修复方向正确，隐私边界成立** | `EnvironmentSourceView` 新增可选 `activity`；Presenter 只取 `monitor.snapshot.foreground.process`（**仅进程名**）与 `monitor.recent()` 的**条数**。已核对 `snapshot.foreground` 字面量为 `{process, since}`（`monitor.ts:218/353`），无 title 字段；`recent()` 条目只有 ruleId/置信度/时间戳。**未泄露标题、截图或 OCR 原文** |
| BUG-03 | **修复方向正确，依赖成立** | ① `.chat-panel` 补 `min-height:0` + `overflow:hidden` → `.messages` 成为真实滚动容器；② 自动滚底用 `keepMessagesAtBottomRef` 守卫（距底 ≤48px 才算「在底部」）。**关键复核**：`[messages]` 依赖安全——`getSnapshot()` 返回缓存冻结对象（`companionPresenter.ts:1249`），`messages` 数组引用只在 commit 时变化，因此输入框打字等无关渲染**不会**触发抢滚动 |

### 8.3 复核人补充的准确性核查

| 项 | 结论 |
| --- | --- |
| 屏幕源文案「最近 1 分钟」是否准确 | **准确**：`DEFAULT_RECENT_TTL_MS = 60_000`（`monitor.ts:40`），生产装配未覆盖该值 |
| 前台源文案「最近检测到：X」是否可能为空 | 有守卫：`monitor.snapshot.foreground` 为 null 时不显示，退回「传感器已启动，等待应用切换」 |

### 8.4 复核发现的 3 个观察项（**非缺陷，指明真机关注点**）

| 编号 | 内容 | 为什么关注 |
| --- | --- | --- |
| W-01 | `pet_window_show` 现在把 **`set_focus` 失败**当作整个调用失败返回（`petWindow.rs:51-53`、`71-73`）。Windows 上 `SetForegroundWindow` 在前台非本进程时可能失败。 | 可能出现「**桌宠已可见，设置页却报红字**」的自相矛盾。真机复验时若见到红字，请同时确认桌宠是否真的出现了——据此刻意区分「显示失败」与「仅聚焦失败」 |
| W-02 | 每次 `pet_window_show` 都强制回工作区中央（`petWindow.rs:50`）。 | **行为变化**：用户把桌宠拖到别处后，隐藏再显示会被拉回中间。请确认真机上是符合预期（推荐）还是干扰 |
| W-03 | `reset_to_work_area` 中 `if logical_w != max_logical_w \|\| logical_h != max_logical_h` 条件恒真（窗口小于工作区时），每次都调用一次 `set_size(当前尺寸)`。属**既有代码**（非本次引入），行为无害，但经 DPI 往返可能有 1px 抖动。 | 真机若发现窗口尺寸/位置有 1px 级抖动，根因在此，不必另找 |

### 8.5 复核边界

- 上述结论**全部是逻辑层/代码层**证据：没有真机截图、没有桌面观测、没有 WebView 控制台输出。
- 仍未证明：桌宠在真机**真的可见且可交互**；环境 `activity` 在真机**真的会更新**；长对话**滚动与自动滚底真的正常**。
- 新增 release 构建由复核人重建（见 `FE-33_速查卡.md` 复验节），真机复验未开始。

### 8.6 现象观测所依据的构建版本（证据链）

复核时发现现场实例确实存在，据此可确定第一轮现象的观测基线：

| 项 | 值 |
| --- | --- |
| 进程 | `aika_crossplatform.exe`（pid 22896），父进程 `explorer.exe` → 由用户双击启动 |
| 路径 | `src-tauri/target/release/deps/aika_crossplatform.exe` |
| 创建时间 | **2026-09-14 16:44:58** |
| 文件时间戳 | **16:39:24** = 修复**之前**那次构建 |
| 结论 | 第一轮 BUG-01/02/03 的现象是在**修复前的构建**上观测到的，与「先报问题、后修复」的时序一致；**修复本身尚无任何真机证据** |

> 该实例持续持有镜像文件，导致 `cargo build --release` 两次 `LNK1104` 失败（无法替换被占用的 `deps\aika_crossplatform.exe`）。已按用户选择结束该实例，构建随即成功。**真机复验前必须先退出正在运行的 Aika**——这条已写入速查卡「开工三步」。
