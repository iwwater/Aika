# 0.79 现场缺陷优先批次 SPEC

日期：2026-09-23。状态：**DRAFT，尚未执行**。对应 [优先级计划](TOFIX_PRIORITY_PLAN_20260923.md)。本 SPEC 是 0.79 未关闭现场问题的增量规格；[N079-01～09](SPEC.md) 的既有门槛继续有效。

## S0 · 基线与数据边界

- **责任范围**：Windows 正式入口、Trace、Electron 窗口命中、renderer 本地问候和记忆详情的直接消费者。先检查目标文件 Git diff、正式运行进程修订与管理台实际数据源，区分 `windows/` 正式实例和隔离 harness。
- **基线记录**：进程/源码/打包资源版本、`GET /api/traces` 的摘要字段计数、Trace 表待清理行数、桌面窗口布局与 DPI、问候开关/最近显示时间。仅输出计数、状态与合成哨兵；不输出真实 History、Memory、Trace 正文或凭据。
- **禁止升级状态**：代码存在、合成测试通过、正式进程加载、人工体验是不同证据。N079-08 的 User Wiki/Soul 与 N079-09 的兼容/Flow 门槛未通过时，0.79 仍为 `IN_PROGRESS`。

## S1 · Trace 默认安全与存量收口（ACCEPT-11）

**现有路径**：`core/trace-store.ts` 的 `record/list/get` 脱敏、`management/server.ts` 的默认 API、`management/ui/views.mjs` 的按需 History 正文、`tools/sanitize-trace-storage.mjs` 的 dry-run/apply/verify/restore。不得新增第二份正文存储或把 `debugOptIn` 作为默认值。

| AC | 验收条件 |
| --- | --- |
| S1-A | 旧明文 Trace 的默认 `list/get/API/UI` 中，user/reply 与阶段详情均只呈现安全摘要；鉴权后按稳定 History 关联按需显示，隐藏/刷新清掉内存正文；无关联、已遗忘或已清理不给正文。 |
| S1-B | 清理工具先在隔离 SQLite 副本上验证 dry-run 计数、备份校验、apply、重复 apply 幂等、verify、restore 与重启读取；异常时不留下半清理库。 |
| S1-C | 正式实例加载当前构建后，按字段格式与聚合计数复核默认视图；正式库清理若执行，先留下实际影响计数、备份位置、停写/进程协调和恢复演练记录，执行后再次 verify/quick_check。未执行则明确 `STORAGE_PENDING`。 |

**变更规则**：若 S1-A 已由现有代码与正式实例验证通过，不重复修改实现；若真实库要写入，按可审阅清理单独执行并记录，不把默认 UI 脱敏当作存量已清除。

## S2 · 穿透时保留 UI 交互（UI-MAN-01）

**根因**：当前唯一 `BrowserWindow` 的 `setIgnoreMouseEvents(true, { forward: true })` 影响整个窗口；现有右键钩子负责恢复，无法让抽屉/设置里的左键控件可点。渲染层的 `clickThrough` 布尔值只是显示状态，不能改变操作系统命中区域。

**实现契约**：保留用户选择的 `clickThroughPreference`；另计算当前指针所处的 `interactiveRegion`（聊天抽屉、功能面板、设置/麦克风控件及其可点击子元素）与实际 `ignoreMouseEvents`。在交互区域内暂时接收鼠标事件，离开后恢复角色主体穿透。区域几何由真实 DOM 可见性、窗口布局与 DPI 转换产生，并随抽屉动画、resize、显示器缩放和隐藏状态更新；不能只靠 CSS `pointer-events`。先用真实 Electron 证实 `forward: true` 下的移动/区域切换；若此机制在 Windows 丢首击，则改为独立可交互面板窗口或等价原生命中方案，不以会丢首击的定时轮询交付。

| AC | 验收条件 |
| --- | --- |
| S2-A | 穿透开启时，角色主体左键能点击后方窗口；聊天抽屉的发送、输入、X 关闭，功能/设置控件首击有效，指针移出 UI 后主体继续穿透。 |
| S2-B | 右键恢复入口与 `Ctrl+Shift+M` 始终可用；恢复不重复触发右键/左键，不改变草稿、在途轮次或窗口位置。 |
| S2-C | UI 区域打开/关闭、窗口移动/缩放、不同 DPI、失焦/重获焦点及进程退出时状态一致；不能让不可见的旧区域长期拦截后方窗口。 |
| S2-D | 用真实 Electron BrowserWindow 和实际鼠标命中链路验证首击及后方窗口行为；单纯 DOM click、stub `setIgnoreMouseEvents` 或 renderer 单测不能算 S2-A 通过。 |

**主要改动候选**：`desktop/electron/main.mjs`、`desktop/main.mjs`，必要时增加一个小型几何/命中纯函数模块与定向 Electron 测试。保留现有右键钩子和可信 IPC 校验；IPC 只接收当前可信主 frame 的有界几何状态，不接受任意网页指令。

## S3 · 本地问候即时预览（ACCEPT-02）

**现有路径**：`desktop/local-greeting.ts` 的正常调度与 `desktop/main.mjs` 的开关、气泡仲裁和持久偏好。新增“显式从关到开”的一次预览动作；不通过改 `lastInteractionAt`、冷却时间或全局时钟来骗过正常 `tick()`。当前 `localGreetingBusy()` 将功能面板打开视为忙碌，因此用户点击开关后应先收起功能面板，再在下一帧重查忙碌状态并显示预览；期间若已关闭或开始回复，则取消预览。

| AC | 验收条件 |
| --- | --- |
| S3-A | 用户在功能面板把开关从关切到开，当前没有回复/录音/错误/Work 占用气泡时，立即出现一条当前本地时段固定模板；无需等待 30 秒轮询或 45 分钟空闲。 |
| S3-B | 开关保持开时重复点击、应用重启恢复已开启、后台配置回显均不自动预览；关闭立即取消尚未显示的预览。忙碌时跳过，不排队覆盖较高优先级气泡。 |
| S3-C | 预览不调用 LLM/TTS/设备，不写 History/Memory/Trace，不改变正常自动问候的日内 key、6 小时冷却和持久 `lastShownAt`；原 45 分钟自动策略继续通过固定时钟测试。 |
| S3-D | renderer 页面实测开关与气泡，固定时钟测试覆盖晨/昼/晚/夜、忙碌、关闭、重启与时钟回拨。 |

**主要改动候选**：在 `LocalGreetingScheduler` 增加不持久的 `preview` 决策或由 `desktop/main.mjs` 调用其纯模板函数；复用现有 `showBubble(..., 'greeting', 8000)` 和 `localGreetingBusy()`，不创建第二个邀请调度器。

## S4 · 遗忘正式路径复核（FIX-02 / N079-03）

先用当前构建核对 `management/ui/views.mjs` 的按钮与确认框、`app.mjs` 到 `/api/memory/forget` 的调用、`StrictManagementForget` 后端生命周期。用合成且有来源的记忆测试取消、版本冲突、模型不可用、成功后的列表刷新及重启不可召回；不点击真实用户记忆。仅当当前正式实例仍缺入口或有可复现的 503 双错误/错误离线状态时，补最小失败测试和修复。已有 N079-03 Electron PASS 不能代替当前运行实例版本核对。

## 验证和交付

实施每一项先 RED（新行为/缺陷）再 GREEN，运行直接模块测试与 `npm run check`、`npm run build:desktop`；S2 做 Windows Electron 真输入，S3 做固定时钟与 renderer 页面，S1 做隔离 SQLite/API/正式实例无正文计数，S4 做正式管理页面与合成库。改到核心契约时扩大直接消费者回归；本批交付前运行 `npm run test:next079` 与 `npm run test:windows:ui`。测试按源码变化选择，不用假 Provider/假窗口证明生产接线。报告分别记录命令、退出码、用例数、构建修订、正式实例是否加载、未运行项与回滚入口。
