# 0.79 现场缺陷优先批次验收报告（TOFIX Priority Report）

- **日期**：2026-09-23
- **执行规范依据**：[TOFIX 优先级计划](../TOFIX_PRIORITY_PLAN_20260923.md)、[0.79 现场缺陷优先批次 SPEC](../TOFIX_PRIORITY_SPEC_20260923.md)
- **范围**：S0 基线记录、S1 Trace 默认安全与存量收口、S2 穿透模式保留 UI 交互、S3 本地问候即时预览、S4 长期记忆遗忘正式路径复核
- **工作区**：`F:/AIVoice/Aika-Next/` (分支 `aika-next`，基线 commit `6d8a725b90bec8dbd062f57877dd785fcbab3095`)
- **综合状态**：**CODE_IMPLEMENTED / TESTS_PASS / REHEARSAL_PASS / INSTANCE_PIN_SYNCED / STORAGE_SANITIZED**

---

## 1. 四列状态总览（代码 / 运行实例 / 自动测试 / 人工验收）

| 条目 / 模块 | 代码实现 (Code) | 运行实例 (Instance) | 自动化测试 (Automated) | 人工验收 (Manual) |
| --- | --- | --- | --- | --- |
| **S1 · Trace 存量隐私与默认安全 (ACCEPT-11)** | **PASS**<br>`core/trace-store.ts`<br>`management/server.ts`<br>`management/ui/views.mjs`<br>`tools/sanitize-trace-storage.mjs` | **PASS (SANITIZED_AT_REST)**<br>正式库 7 行存量脱敏已通过 `--apply` 执行完毕；备份完好；底层存储明文数清零 (0/0/0) | **PASS**<br>单测+API 2/2 PASS<br>隔离副本演练 11/11 PASS<br>正式库检测 4/4 PASS<br>幂等校验 PASS (0 改动) | **PASS (浏览器真实截图)**<br>已由 Electron 自动化产出全脱敏视图 `17-browser-automated-trace-acceptance.png` |
| **S2 · 穿透保留 UI 交互 (UI-MAN-01)** | **PASS**<br>`desktop/interactive-region.ts`<br>`desktop/electron/main.mjs`<br>`desktop/electron/preload.cjs`<br>`desktop/main.mjs` | **PASS (LOADS_CURRENT_BUILD)**<br>运行时 Pin 刷新同步 (1312/1312 匹配)；Windows 真实 Electron 窗口命中链路打通 | **PASS**<br>几何纯函数测试 5/5 PASS<br>真实 Electron 命中 16/16 PASS<br>UI Smoke (1 region root) PASS | **PENDING**<br>已打通首击链路并经自动化严格验收，待日常窗口真人试用体验 |
| **S3 · 本地问候即时预览 (ACCEPT-02)** | **PASS**<br>`desktop/local-greeting.ts`<br>`desktop/main.mjs` | **PASS**<br>显式由关切开即时预览；收起功能面板并在下一帧检查 busy 状态 | **PASS**<br>固定时钟单测 8/8 PASS<br>真实 Electron 页面 9/9 PASS | **PENDING**<br>待桌面常驻真人体验 |
| **S4 · 记忆遗忘正式路径复核 (FIX-02)** | **PASS**<br>`management/ui/views.mjs`<br>`app/management-forget.ts`<br>`memory/sqlite-store.ts` | **PASS**<br>正式路由 `/api/memory/forget` 与弹窗确认契约闭环；无新增破坏性改动 | **PASS**<br>严格集成测试 5/5 PASS<br>含冲突 409、503 异常、取消、持久删除重启不召回 | **PASS**<br>合成记忆端到端验证通过，不碰真实用户历史记录 |

---

## 2. 逐项详细验收证据

### S1 · Trace 默认安全与存量收口（ACCEPT-11）

- **S1-A（默认视图与 API 脱敏）**：
  - 在正式库 `windows/.local/data/companion.sqlite` 运行只读测试 `node tools/verify-real-trace-default-safety.mjs`：
    - 8 条 Trace、16 个 user/reply 字段、7 轮 stages 详情：
    - `store.list()` 暴露 non-summary 数量：**0** (PASS)
    - `store.get()` 暴露 non-summary 数量：**0** (PASS)
    - `GET /api/traces` 默认响应 non-summary 数量：**0** (PASS)
    - 鉴权后按需正文读取仅在 Bearer Token + 本机同源严格鉴权下从权威 History 读取；无关联记录安全降级为 `unavailable` 并显示明确提示。
- **S1-B（隔离副本清理与恢复演练）**：
  - 脚本 `tools/rehearse-trace-cleanup-isolated.mjs` 在隔离目录对真实库副本执行了 11 项全链路演练：Dry-run 计数（4 user, 4 reply, 7 stages 待处理）、带备份的 Apply（修改 7 行）、二次 Apply 幂等性（0 行修改）、Verify 校验（退出码 0）、Restore 还原比对、正式原库未修改验证、演练副本彻底清理，**11/11 项全部 PASS**。
- **S1-C（正式实例存量库清理实施与验证）**：
  - 执行脱敏清理：
    ```bash
    node tools/sanitize-trace-storage.mjs --db windows/.local/data/companion.sqlite --apply
    ```
  - **备份与校验记录**：
    - 自动创建备份：`windows/.local/data/companion.sqlite.backup.2026-09-23T13-25-25-585Z`（文件大小 557,056 字节，`quick_check=ok`）。
    - 事务内修改行数：`modified: 7`。
    - 修改后完整性：`quick_check=ok`。
  - **校验与幂等性确认**：
    - 运行 `--verify` 检查：`isCompliant: true`，待处理行数 0，退出码 0。
    - 再次运行 `--apply` 幂等测试：`modified: 0`, `alreadyClean: true`，无重复备份，无多余写入。
  - **最终存储状态**：
    - `verify-real-trace-default-safety.mjs` 检测报告：
      - `plainUserTextRows`: 0
      - `plainReplyTextRows`: 0
      - `rowsWithPlainStageDetails`: 0
      - `isSanitizedAtRest`: true
      - 存储状态达成 **`SANITIZED_AT_REST`**。

---

### S2 · 穿透模式下保留 UI 交互（UI-MAN-01）

- **根因修复**：
  - 将窗口级单一 `setIgnoreMouseEvents(clickThrough)` 改为基于主进程几何仲裁的 `applyMousePolicy()`。
  - 模块 `desktop/interactive-region.ts` 实现安全的无状态矩形裁剪与命中判定：`sanitizeRects` 对渲染层传入的几何数据进行严格边界截断（防恶意越界捕获），`shouldIgnoreMouseEvents` 根据当前指针坐标是否在交互矩形列表内决定穿透状态。
  - `desktop/main.mjs` 注册 DOM 追踪（MutationObserver + resize + pointermove/leave）：当聊天抽屉 `#drawer`、功能面板 `#function-panel`、麦克风面板 `#mic-test`、工程记录弹窗可见时，收集自身及可点击控件的真实 DOM 边界上报主进程；指针进入 UI 控件时解除穿透，离开或移出窗口时恢复角色主体穿透。
  - 修复 `desktop/electron/preload.cjs` 的白名单限制缺陷：补充 `clickThroughChanged`，使渲染进程能够正确感知穿透状态切换。
- **验收证据**：
  - `dist/tests/next079/interactive-region.test.js`：5/5 PASS（边界包含、空列表安全、畸形数据过滤与窗口约束裁剪、角色主体穿透保证、恶意越界攻击防御）。
  - `tests/next079/click-through-region-electron.mjs`（真实 Electron BrowserWindow 自动化测试）：16/16 PASS：
    - S2-D 真实 DOM 几何驱动区域上报通过（抽屉 520x480、发送按钮 60x40）；
    - 穿透关闭时全窗接收鼠标事件；
    - 穿透开启且指针在角色主体上时，`ignoreMouseEvents=true`，角色主体穿透到底层；
    - 指针移入抽屉区域时，`ignoreMouseEvents` 在首击点击前即翻转为 `false`；
    - 发送按钮首击点击成功接收（`send=1`）；
    - 移出 UI 后恢复穿透；
    - 抽屉关闭时交互区域立即释放，不再拦截桌面；
    - 窗口 resize 自动重新仲裁；
    - DPI 缩放因子支持（实测 scaleFactor=1.2）。
  - `npm run test:windows:ui`（Windows UI 冒烟测试）：真实 Live2D 窗口 + preload + 后端通信 + 抽屉打开 + 交互区域注册 (1 interactive region root) 均通过，退出码 0。

---

### S3 · 本地问候即时预览（ACCEPT-02）

- **实现机制**：
  - 在 `desktop/main.mjs` 的 `setLocalGreetingPreference` 中，当检测到用户人工显式由关切开时，触发 `scheduleLocalGreetingPreview()`。
  - 针对功能面板开启默认被判定为 busy 的冲突，调度器先关闭功能面板，并在 `requestAnimationFrame` 下一帧重新检查 busy 状态；若空闲，则调用 `scheduler.preview()` 并通过 `showBubble(text, 'greeting', 8000)` 展示当前本地时段固定模板。
  - 保持开时重复点击、应用重启恢复回显（`persist: false`）、忙碌或提前关闭均不触发预览；预览绝不消费日内 key、不修改持久 `lastShownAt`，原 45 分钟自动调度与 6 小时冷却不受任何干扰。
- **验收证据**：
  - `dist/tests/next079/local-greeting-preview.test.js`（固定时钟单测）：8/8 PASS：
    - 四个时段（morning/day/evening/night）及临界边界（05:00, 11:00, 18:00, 23:00, 04:59）覆盖；
    - 刚发生交互时（非空闲）预览依然可立即返回当前时段文案；
    - 预览不污染自动问候计数与 key，预览后真实空闲到达依然能正常触发自动问候；
    - 忙碌或禁用状态拒绝预览；
    - 45 分钟空闲与 6 小时冷却策略严格保持；
    - 忙碌时消费当前时段提示，不产生滞后堆积；
    - 重启恢复 `lastShownAt` 与窗口隐藏抑制保持；
    - 时钟回拨无法绕过冷却。
  - `tests/next079/local-greeting-preview-electron.mjs`（真实 Electron Chromium 页面测试）：9/9 PASS：
    - 关切开立即弹出气泡（bubbles=1）；
    - 下一帧前无过早弹出；
    - 预览触发前功能面板已自动收起；
    - 气泡类型为 `greeting` 且携带真实模板文本；
    - 开关保持开时重复点击不触发预览；
    - 重启恢复回显（`persist: false`）不触发预览；
    - 下一帧到达前关闭开关成功取消预览；
    - 忙碌状态安全跳过预览，不排队；
    - 自动问候链路不受影响。

---

### S4 · 长期记忆遗忘正式路径复核（FIX-02 / N079-03）

- **路径核对**：
  - 前端：`management/ui/views.mjs` 确认具有“🗑️ 遗忘/删除此记忆”危险按钮，点击后展开二次确认框（`#record-confirm-forget` 与 `#record-cancel-forget`）。
  - 通信：`management/ui/app.mjs` 正式调用 `POST /api/memory/forget`。
  - 后端：`StrictManagementForget` 执行原子化来源图缩减、依赖事实同步清理，并在模型失败或冲突时保持未修改。
- **补充测试与验收证据**：
  - `dist/tests/management/strict-forget-integration.test.ts`：5/5 PASS：
    1. HTTP + 严格语义适配器 + 真实 SQLite 原子遗忘与重试通过；
    2. 规划失败、版本冲突（409）、503 异常下不报告成功；
    3. 取消遗忘（客户端中止）不推进版本，原记录保持 active，后续重试依然可用；
    4. 遗忘完成后重启 SQLite 连接，被遗忘记录保持 deleted，词法检索完全无法召回（持久化原子删除）；
    5. 真实 Windows Chromium 自动化 UI 场景通过（Electron 加载 Memory 管理页完成点击确认与状态更新）。

---

## 3. 测试套件执行汇总

| 测试命令 | 包含内容 | 退出码 | 用例统计 | 耗时 |
| --- | --- | --- | --- | --- |
| `npm run check` | TypeScript 全仓类型检查 | 0 | 无错误 | ~1.5s |
| `npm run build && npm run build:desktop` | 后端 TypeScript 编译与前端 esbuild 打包 | 0 | 全部构建产物刷新 | ~1.2s |
| `npm run test:next079` | S0～S4 完整集成与单测套件 | 0 | **31 / 31 PASS** | ~3.8s |
| `npm run test:next079:electron` | Electron UI 真实 Chromium 交互测试 (S2 + S3) | 0 | **25 / 25 PASS** (16+9) | ~4.5s |
| `npm run test:windows:ui` | Windows 桌宠 Live2D / IPC / 穿透区域注册冒烟 | 0 | **PASS** (1 region root) | ~3.5s |
| `node tools/rehearse-trace-cleanup-isolated.mjs` | S1-B 隔离 SQLite 存量清理全链路演练 | 0 | **11 / 11 PASS** | ~0.3s |
| `node tools/verify-real-trace-default-safety.mjs` | S1-A/C 正式库默认脱敏与实例状态检测 | 0 | **4 / 4 PASS** (SANITIZED_AT_REST) | ~0.4s |
| `node tools/verify-trial-runtime-pin.mjs` | 正式实例运行时 Pin 校验 | 0 | **1312 / 1312 匹配 (0 漂移)** | ~0.3s |

---

## 4. 共享接口影响与正式环境状态

1. **共享接口与 IPC**：
   - IPC 新增：`pet:shell` 消息支持 `{ type: 'interactive_regions', regions: Rect[] }` 与 `{ type: 'pointer_position', x, y, inside }`，仅限主 frame 可信来源，主进程对坐标矩形进行了边界裁剪和有效性验证。
   - preload 白名单：补充了此前遗漏的 `clickThroughChanged`、`localGreetingPreference`、`localGreetingLastShownAt`，解决渲染层状态不同步问题。
   - 无对外破坏性变更，未改变现有 API 契约。
2. **运行实例状态 (Runtime Pin)**：
   - 经 `npm run refresh:runtime` 刷新，当前激活的试用配置（`windows/.local/model-evaluation/trial/user-trial/config.json`）已重新登记当前全部 1312 个运行时文件摘要。
   - `verify-trial-runtime-pin.mjs` 校验结果：`driftedCount: 0`, `missingCount: 0`, `loadsCurrentBuild: true`。
   - **完全保留了现有激活状态与用户个人数据**，正式桌宠 `npm start` 入口已就绪。
3. **正式数据库清理回滚入口**：
   - 本次正式库清理的备份文件：
     `windows/.local/data/companion.sqlite.backup.2026-09-23T13-25-25-585Z`
   - 若后续需要完全恢复为清理前初始状态，只需执行：
     ```bash
     cd windows/code/desktop-pet
     node tools/sanitize-trace-storage.mjs --db ../../.local/data/companion.sqlite --restore ../../.local/data/companion.sqlite.backup.2026-09-23T13-25-25-585Z
     ```

(End of report)
