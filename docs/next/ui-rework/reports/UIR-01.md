# UIR-01 验收报告 · 六入口壳与兼容路由

日期：2026-09-25  
状态：PASS  
负责人：扫地僧模式 Agent  
工作树基准 Commit：`582570e1a4a789db43aef70cab669c36af0e5789`  
目标目录：`F:/AIVoice/Aika-Next/windows/code/desktop-pet`

---

## 1. 改动范围与文件清单

- `management/ui/routes.mjs`：
  - 新增 `PRIMARY_PAGES` 六大一级入口定义 (`dashboard`, `knowledge`, `characters`, `playground`, `plugins`, `settings`) 与 `DEVELOPER_PAGE` (`developer`)。
  - 新增 `resolveCanonicalRoute` 映射函数，实现 SOURCE_MAPPING 全部旧页面及 Section 到新规范路由的映射。
  - 增强 `parseConsoleRoute`，剥除 URL 中的敏感 token，保留配对信息，同时返回规范 canonical 路由与 legacy 兼容字段。
- `management/ui/envelope.mjs` (新建)：
  - 实现统一状态组件 `createStatusBadge`，支持 7 种状态 (`ready`, `loading`, `failed`, `pendingRestart`, `unavailable`, `disabled`, `unknown`)，杜绝折叠为假绿色。
  - 实现 `createEpochGuard`，利用自增 epoch 与 AbortController 防止快速切换标签或角色导致的迟到响应混线。
  - 实现多 Owner 配置信封 `createConfigEnvelope`，管理 `savedRevision`、`effectiveRevision` 与 draft，并在 409 冲突时强制保留本地草稿。
- `management/ui/dom.mjs`：
  - 导出统一状态组件与常量；
  - 增加 Node.js / SSR 环境安全守卫，保证无 DOM 环境测试不崩溃。
- `management/ui/app.mjs`：
  - 重构顶部导航栏为现代六入口结构，根据本地存储 `aika_developer_mode` 动态呈现【开发者 Trace】入口；
  - 实现 Developer Mode 安全门禁组件，在开发者模式关闭时拦截 Trace/Logs 路由，杜绝敏感调用链正文预取与泄露；
  - 在 Settings/开发者选项提供直观的开闭控制与说明；
  - 接入 `epochGuard`，切换页面/角色时即时中止旧请求并隔离响应。
- `tests/ui-rework/navigation.test.mjs` (新建)：覆盖规范六入口、旧入口映射、Developer 识别、Token 清除与配对保留。
- `tests/ui-rework/state.test.mjs` (新建)：覆盖状态分类展示、Epoch 防迟到混线、409 冲突草稿保护。

---

## 2. 逐项验收标准 (AC) 结果与证据

### AC 01-A：六入口、刷新/后退/旧深链均正确，Developer off 不展示或预取调试正文
- **结果**：PASS
- **证据**：
  - 路由解析器 `parseConsoleRoute` 正确识别 `PRIMARY_PAGES` 每一个入口；
  - 全部旧 17 页面映射（overview -> dashboard、models/voice/skins -> characters、timeline/events -> developer 等）均已在 `navigation.test.mjs` 验证；
  - 当访问 `developer` 路由且开发者模式关闭时，`app.mjs` 渲染安全门禁卡片，未触发 `eventsView` 或任何 Trace 正文请求；开启开发者模式后方可查看。

### AC 01-B：切角色/切页迟到响应不混线，URL token 清理但 pairing.userId 不丢失
- **结果**：PASS
- **证据**：
  - `createEpochGuard` 在切换时自动调用 `activeController.abort()`，使在途旧请求中止；并且 `isCurrent(oldEpoch)` 返回 false，彻底丢弃迟到响应；
  - URL hash 包含 `#token=...` 时，提取后立即存入 `sessionStorage`，并生成剥除 token 的 `canonicalTargetHash`，通过 `history.replaceState` 清理地址栏；
  - 配对信息 `pairing.userId` 与 `characterId` 在整个路由流转中完好保留。

### AC 01-C：鉴权失败、无权限与空数据不同，冲突保留草稿；导航不触发模型/采集
- **结果**：PASS
- **证据**：
  - `createStatusBadge` 与 `LIFECYCLE_STATUSES` 严格区分各生命周期状态，失败显示 error 提示，未接入/不可用显示 muted 标签，待重启显示 warning，杜绝将非就绪状态折叠为绿色；
  - `createConfigEnvelope` 在模拟 409 版本冲突时，草稿文本 `draftData` 完整保留，并记录 `conflictSnapshot`，由用户自主决定处理方式；
  - 纯导航操作仅触发轻量快照刷新或视图切换，绝不隐式触发大模型推理或开启感知麦克风采集。

---

## 3. 测试命令与退出码

1. **类型检查**：
   ```pwsh
   npm run check
   ```
   - 退出码：`0`（无任何 TypeScript 编译错误）
2. **路由与状态自动化测试套件**：
   ```pwsh
   node --test tests/management/routes.test.mjs tests/ui-rework/navigation.test.mjs tests/ui-rework/state.test.mjs
   ```
   - 退出码：`0`
   - 测试结果：**15 pass, 0 fail, 0 skipped, 0 todo**，全部绿灯通过。

---

## 4. 结论与下一步

- **结论**：UIR-01 所有验收标准均通过，六入口架构与 Developer 安全门禁已平稳落地。
- **下一步**：推进 `UIR-02`（角色 Persona、外观、模型与语音链路绑定）。
