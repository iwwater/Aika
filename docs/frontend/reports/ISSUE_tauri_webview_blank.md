# 问题描述：Tauri 桌面端 WebView 白屏/黑屏（前端脚本未执行）

> **【已解决 2026-09-13】实际根因与本文第四、八节的推断不同**，修复与证据见
> [ISSUE_tauri_webview_blank_RESOLUTION.md](ISSUE_tauri_webview_blank_RESOLUTION.md)。要点：
>
> - 真根因：`src-tauri/Cargo.toml` 缺 `[features] custom-protocol = ["tauri/custom-protocol"]`。
>   直接 `cargo build` 不带该 feature 时，Tauri 按 dev 环境处理，窗口加载的是
>   `build.devUrl`（`http://localhost:1420/`）而非嵌入的 `frontendDist`。没有 vite dev server
>   在跑，WebView 显示的是 WebView2 的导航失败错误页（暗色下先白后黑）。
>   （CDP 取证：`/json/list` 显示 page url = `http://localhost:1420/`、title = "localhost"。）
> - 修复：补上 feature，用 `cargo build --release --features custom-protocol` 构建。
> - **第四节两条推断均被证伪**：① `csp: null` 在 Tauri v2 语义就是「不注入 CSP」，不是根因；
>   ② vite `base` 不需要设 `"./"`——`tauri.localhost` 下绝对路径 `/assets/...` 经 asset
>   protocol 正常返回（`/vite.svg` 200，bundle 正常执行），保持未改。
> - 本文第三节「#3 HTML 已加载（标题来自 HTML）」同样不成立：标题其实来自
>   `tauri.conf.json` 的 `windows[].title`，当时并不能证明 HTML 加载。
> - principal 不一致（第五节）已一并修复：Rust 侧统一为 `LOCAL_PRINCIPAL = "local"`。
> - 第六节临时诊断代码已全部回退/删除；第七节的「touch lib.rs 强制重编译」提醒仍然有效，
>   但正确构建命令必须带 `--features custom-protocol`。

> 移交说明：本文件由一次「真实 Tauri 进程端到端验证」任务产出。目标应用能启动、窗口能创建，但
> WebView 内**前端脚本完全没有执行**，界面白屏后变黑（仅 `index.html` 的 `background:#05070e` 生效）。
> 下面的事实都有日志/命令证据，不是推测；推测部分已明确标注。

## 一、环境与产物

- 仓库：`F:\AIVoice\Aika`，前端应用根：`F:\AIVoice\Aika\aika-crossplatform`
- 运行方式：`cargo build --release` 后直接运行
  `F:\AIVoice\Aika\aika-crossplatform\src-tauri\target\release\aika-crossplatform.exe`
- 使用到的版本：vite 7.3.6；tauri 2.11.5；node 22.22.2
- `src-tauri/tauri.conf.json` 关键项：
  - `build.frontendDist = "../dist"`
  - `build.devUrl = "http://localhost:1420"`
  - `app.security.csp = null`
- `aika-crossplatform/vite.config.ts`：**没有设置 `base`**（既不是 `"./"` 也不是 `"/"`，用 vite 默认值 `"/"`）
- 构建产物 `aika-crossplatform/dist/index.html` 里脚本引用为**绝对路径**：
  ```html
  <script type="module" crossorigin src="/assets/index-9iXNQGiI.js"></script>
  <link rel="stylesheet" crossorigin href="/assets/index-BegTEbAH.css">
  ```

## 二、现象

1. 双击 / 启动 exe 后，窗口出现且标题正确（`愛花 Aika`），但内容区**先白后黑**，没有任何 UI。
2. 没有报错弹窗，进程持续存活。

## 三、已确证的事实（证据）

| # | 检查项 | 结论 | 证据 |
|---|--------|------|------|
| 1 | Rust 侧启动 | ✅ 正常 | 临时埋点在 `setup()` 写入 `%TEMP%\aika_diag.log`：`=== rust setup ok === temp=Ok("C:\\Users\\ZYF\\AppData\\Local\\Temp") cwd=Ok("F:\\AIVoice\\Aika")` |
| 2 | 进程与窗口 | ✅ 正常 | `alive=True hwnd=1639466 title='愛花 Aika'`（26 线程 / 59 模块） |
| 3 | **HTML 已加载** | ✅ | 窗口标题来自 `index.html` 的 `<title>愛花 Aika</title>`；`<body style="background:#05070e">` 生效（用户报告的"变黑"） |
| 4 | **内联脚本未执行** | ❌ | 在 `index.html` 的 `<body>` 里加入**不依赖任何外部 bundle** 的内联 `<script>`，其第一步即 `document.title = "PROBE1-ran"` 并调用 `invoke("diag_write", ...)`。结果：`aika_diag.log` 中**只有第 1 项的 Rust 那一行**，内联脚本一行都没写入；窗口标题也**没有**变成 `PROBE1-ran` |
| 5 | 外部 bundle 未执行 | ❌（推断自 #4） | `src/main.tsx` 里 `boot()` 首行即 `diag("=== boot start ===")`，日志中同样完全没有该行 |

**#3 + #4 的组合是本问题的核心矛盾**：HTML 解析成功、CSS（内联 style）生效，但**同一个 `<body>` 里的 `<script>` 没有跑**，
且 `<script type="module" src="/assets/...">` 也没跑。这**不是单纯的资源 404**，因为 404 只会影响第一个外部脚本，
不会影响不依赖任何网络请求的内联脚本。

## 四、推断的根因（按可能性排序，需逐项验证）

### 1. CSP 阻止脚本执行（最可疑）
`tauri.conf.json` 中 `app.security.csp = null`。需要核实 Tauri v2 对 `csp: null` 的**确切语义**：
若它被解释为「使用 Tauri 的默认严格策略」而非「关闭 CSP」，则内联脚本与 `type="module"` 脚本都可能被阻断，
正好解释 #4。

**验证方式**：F12 不可用时，可在 WebView2 里用 `--remote-debugging-port` 抓 Console 的 CSP 报错；
或先把 `csp` 显式设为 `""`（或一条允许 `'self'` 与内联的策略）再试。

### 2. `vite.config.ts` 缺少 `base: "./"`
Tauri 官方模板在 `frontendDist` 指向本地目录时，通常会设 `base: "./"`，让产物用**相对路径**引用资源。
当前产物是 `/assets/xxx.js`（绝对路径）。在 `tauri://localhost`（或 `http://tauri.localhost`）协议下，
绝对路径是否被正确映射到 `dist` 根，取决于 Tauri 版本的协议处理器行为。
**这一项单独无法解释 #4**（内联脚本不走资源加载），但**会独立导致 bundle 加载失败**，是必须一并修的点。

**验证方式**：加 `base: "./"` 重新 `vite build` + `cargo build --release`，看产物是否变为 `./assets/xxx.js`，再运行。

### 3. WebView2 Runtime 异常
基本可排除（HTML 能解析、CSS 生效说明 WebView 正常工作）。

## 五、另一个独立的真实缺陷（与白屏无关，但端到端必然失败）

**主体标识不一致 → 手机永远读不到帧、命令永远 401。**

- `src-tauri/src/remote.rs` 中 `handle_events()` 与 `handle_commands()` **硬编码**主体：
  ```rust
  let principal = "local-desktop".to_string();
  ```
- 而 TS 侧 `src/app/hosts/index.ts` 装配出站传输时传的是 `principalId: LOCAL_PRINCIPAL_ID`，
  其值为 `"local"`（见 `src/domain/identity.ts` 的 `LOCAL_PRINCIPAL_ID = "local"`）。
- 会话键由 `gateway::session_key()` 生成为 `format!("{principal_id}:{conversation_id}")`。
- 于是：TS 通过 `outbound_publish` 把帧写进 `local:local`，而手机页 `GET /api/v1/events` 读的是
  `local-desktop:local` → **读不到任何帧**；`POST /api/v1/commands` 会因为 `has_session()` 为 false
  返回 `401 {"error":"session-unknown"}`。

**建议修法（二选一，需与设计确认哪一侧是权威）**：
- 让 Rust 侧主体常量与 TS 侧一致（统一为 `"local"`），
- 或让 TS 侧改用 `"local-desktop"`；但注意 `LOCAL_PRINCIPAL_ID` 在 `domain/identity` 里是
  `LOCAL_CONVERSATION_SCOPE` / `canonicalScopeKey` 相关定义的组成部分，改动前需核对影响面。

## 六、仓库中遗留的临时诊断代码（请处置）

为取得上述证据，验证过程中加入了以下**临时**改动。若不需要保留，请回退：

| 文件 | 改动 | 说明 |
|------|------|------|
| `aika-crossplatform/src-tauri/src/diag.rs` | **新建文件**，含 `diag_write(line)` / `diag_reset()` 两个命令，把字符串 append 到 `%TEMP%\aika_diag.log` | 纯诊断，验证后删除 |
| `aika-crossplatform/src-tauri/src/lib.rs` | ① `mod diag;` ② `generate_handler!` 里追加 `diag::diag_write` / `diag::diag_reset` ③ `setup()` 开头新增一段写 `aika_diag.log` 的临时块 | 验证后回退 |
| `aika-crossplatform/src/main.tsx` | 新增 `diag()` 辅助函数、`window` 的 `error` / `unhandledrejection` 监听、`boot()` 各阶段埋点 | 验证后回退 |
| `aika-crossplatform/index.html` | 新增内联 probe 脚本（检测 `__TAURI_INTERNALS__`、`location`、`/vite.svg` 可获取性） | 验证后回退 |

**未改动**（保持原样，便于定位）：`vite.config.ts`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。

## 七、复现与取证步骤（供接手者直接使用）

```powershell
# 1) 构建（注意：改完前端必须让 Rust 重编译，否则资源不会被重新嵌入）
Set-Location F:\AIVoice\Aika\aika-crossplatform
& <node> .\node_modules\vite\bin\vite.js build
(Get-Item .\src-tauri\src\lib.rs).LastWriteTime = Get-Date   # 强制重编译
& <cargo> build --release --manifest-path .\src-tauri\Cargo.toml

# 2) 运行并读诊断
Remove-Item $env:TEMP\aika_diag.log -Force -ErrorAction SilentlyContinue
Start-Process F:\AIVoice\Aika\aika-crossplatform\src-tauri\target\release\aika-crossplatform.exe
Start-Sleep 16
Get-Content $env:TEMP\aika_diag.log      # 若只有 "rust setup ok" → 证实前端脚本未执行

# 3) 抓 WebView2 控制台（可选，用于看 CSP 报错）
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
Start-Process <exe>
# 然后访问 http://localhost:9333/json/list 取 target，连 ws 读 Console
```

**一个易踩的坑**：`cargo build --release` 在只改了前端（`dist`）时**不会**重新编译主 crate，
导致 exe 里嵌的还是旧资源。必须 touch `lib.rs`（或 `build.rs`）强制重编译，
否则会误判「改了没效果」。验证方式是比对 `exe` 与 `dist/index.html` 的 `LastWriteTime`。

## 八、结论

- 阻塞点**不在 Rust 侧**（启动、窗口、命令注册均正常），而在 **WebView 内前端脚本的执行被阻断**。
- 首要怀疑 **`app.security.csp = null` 的语义**，其次是 **vite `base` 未设为 `"./"`**。
- 另有独立缺陷 **Rust/TS 主体标识不一致**，会让手机端到端功能必然失败，需一并处理。
