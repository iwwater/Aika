# 验收报告：Tauri 桌面端白屏修复 + 手机网关主体标识统一

> **审阅记录（2026-09-13，验收方独立核查）**：结论 **REVIEWED PASS**。
> ① 改动面核查：`git status`/`git diff` 确认 `index.html`、`src/main.tsx` 回到 HEAD（诊断代码零残留）、`diag.rs` 已删除、`lib.rs` 仅主任务原有 6 行（`mod gateway` + 5 个 handler 注册）、`Cargo.toml` 除 feature 修复外无混入；② 修复内容核查：`[features] custom-protocol` 声明与注释完整、`remote.rs` 的 `LOCAL_PRINCIPAL="local"` 两处替换 + `local-desktop` 全仓零残留 + 回归测试 `http_principal_matches_the_one_ts_publishes_under` 钉住同键语义；③ 文档核查：本报告与 ISSUE 修正块齐备，原 CSP/base 假设的证伪诚实；④ 测试证据：验收方**独立复跑 `cargo test` 19 passed / 0 failed（exit 0，含新增回归测试）**。遗留项（真实手机浏览器/Origin 白名单/Tailscale/多 WebView 越权）已如实标注，不算 PASS 水分。

- 日期：2026-09-13
- 任务来源：[ISSUE_tauri_webview_blank.md](ISSUE_tauri_webview_blank.md)（移交问题描述）
- 结论：**PASS**（两项修复均有真实进程运行证据；临时诊断代码已全部回退）

## 一、改动清单

### 1. 白屏根因修复：`aika-crossplatform/src-tauri/Cargo.toml`

**根因**：`[features]` 段整体缺失。Tauri v2 源码（tauri-2.11.5 `src/lib.rs:23`）明确
`custom-protocol` 是 CLI 管理的 feature，开启后 Tauri 才按生产环境处理；`src/lib.rs:309`
的 dev 判定是 `!cfg!(feature = "custom-protocol")`。缺它时 `generate_context!` 编译出的
窗口 URL 是 `build.devUrl`（`http://localhost:1420/`），没有 vite dev server 就整页导航失败——
WebView2 错误页在暗色模式下「先白后黑」，与用户报告一致。

**改动**：补上

```toml
[features]
custom-protocol = ["tauri/custom-protocol"]
```

此后手工构建命令为 `cargo build --release --features custom-protocol`
（`tauri build` 会自动带上）。

**取证过程（修正原报告的推断）**：用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`
启动旧 exe，CDP `/json/list` 显示 page url = `http://localhost:1420/`、title = "localhost"
——加载的是 devUrl 错误页，不是嵌入资源。原报告第四节的 CSP（`csp: null` 语义即「不注入 CSP」）
与 vite `base`（绝对路径经 asset protocol 正常返回，`/vite.svg` 200）两条假设均被证伪，
`vite.config.ts`、`tauri.conf.json` 保持未改。

### 2. 主体标识统一：`aika-crossplatform/src-tauri/src/remote.rs`

**根因**：`handle_events()` / `handle_commands()` 硬编码 `principal = "local-desktop"`，
而 TS 侧（`src/app/hosts/index.ts:113`）以 `LOCAL_PRINCIPAL_ID = "local"`（`src/domain/identity.ts:51`）
发布帧。会话键 `principal:conversation` 错位 → 手机读不到帧、命令恒 401 session-unknown。

**改动**：新增常量 `pub const LOCAL_PRINCIPAL: &str = "local"`，两处硬编码改用之；
方向选「Rust 向 TS 对齐」——`LOCAL_PRINCIPAL_ID` 参与域层
`LOCAL_CONVERSATION_SCOPE` / `canonicalScopeKey` 定义，改动 TS 侧影响面更大。
全仓 grep 确认无任何测试/文档依赖 `"local-desktop"` 字面量。

**新增回归测试**：`remote::tests::http_principal_matches_the_one_ts_publishes_under`
——模拟 TS 发布路径（同主体 upsert_session + buffer_frame），断言
`read_events` 能取到帧、`admit_command` 返回 `Accepted`。

### 3. 临时诊断代码回退（原报告第六节）

- `src-tauri/src/diag.rs`：**已删除**（新建文件）。
- `src-tauri/src/lib.rs`：移除 `mod diag;`、`generate_handler!` 两项、setup 写日志临时块。
- `src/main.tsx`：移除 `diag()`、`window` error/unhandledrejection 监听、boot 各阶段埋点，
  render 还原为直写形式。
- `index.html`：移除内联 probe 脚本。
- `vite.config.ts` / `tauri.conf.json` / `Cargo.toml`（除 feature 修复外）：未动。

## 二、测试命令与退出码

| 命令 | 结果 |
|------|------|
| `cargo test --manifest-path src-tauri/Cargo.toml` | **19 passed; 0 failed**，exit 0（含新增回归测试） |
| `node node_modules/vite/bin/vite.js build` | ✓ built，exit 0 |
| `cargo build --release --features custom-protocol --manifest-path src-tauri/Cargo.toml` | Finished，exit 0 |
| 诊断代码回退后重复上述构建 | 全部 exit 0，`%TEMP%\aika_diag.log` 不再生成 |

按测试边界约定未跑全仓 npm test / 全局 tsc；`main.tsx` 的改动仅为删除诊断代码。

## 三、逐项证据（真实 exe 运行，CDP + HTTP）

| # | 验收项 | 结果 | 证据 |
|---|--------|------|------|
| 1 | exe 加载嵌入资源而非 devUrl | ✅ | CDP `/json/list`：page url = `http://tauri.localhost/`（修复前为 `http://localhost:1420/`） |
| 2 | 前端脚本执行、React 挂载 | ✅ | CDP evaluate：`#root` 子元素为 `<MAIN>`；`body.innerText` 含真实 UI（角色卡、聊天记录「こんにちは。……」等） |
| 3 | 诊断代码已移除且无副作用 | ✅ | 干净构建后 `%TEMP%\aika_diag.log` 未再生成 |
| 4 | 手机侧能读到前端发布的帧 | ✅ | CDP 内 invoke `outbound_publish(principal_id="local")` 后，`GET /api/v1/events?conversation=local` 返回 `n=1`、帧内容逐字节一致（修复前该接口永远 `n=0`） |
| 5 | 手机命令不再 401 | ✅ | `POST /api/v1/commands` 返回 **202** `{"accepted":true,...,"requestId":"req-2"}`（修复前恒 401 session-unknown） |
| 6 | Rust 单测回归 | ✅ | 新增 `http_principal_matches_the_one_ts_publishes_under` 通过 |

## 四、共享接口影响

- `remote_start` / `outbound_publish` 等命令签名未变；`OutboundPublishInput` 字段未变。
- 主体标识从「Rust 侧私有字面量」提升为 `remote::LOCAL_PRINCIPAL` 常量，并在注释中约定
  必须与 TS 侧 `LOCAL_PRINCIPAL_ID` 一致——这是跨 TS/Rust 的人工契约，已有回归测试钉住
  Rust 侧，但两侧字面量的同步仍靠约定（见「待联调项」）。
- 新增 `[features] custom-protocol`：只影响直接 `cargo build` 的行为，`tauri dev` / `tauri build` 不受影响。

## 五、待联调项 / 遗留

- **PASS ≠ 全流程通过**：本报告的 e2e 是在桌面端真实进程 + 局域网 HTTP 语义下验证网关
  读帧/命令准入；真实手机浏览器、Origin 白名单、Tailscale 场景未测（属于远程联调里程碑）。
- 长轮询、epoch 重同步、会话缓存淘汰（`MAX_BUFFER_FRAMES`）等已有 Rust 单测覆盖，未在本轮重复触发。
- 原报告第七节的教训保留：只改前端后必须重新 `vite build`，且
  `cargo build --release` **必须带 `--features custom-protocol`**，否则 exe 嵌的还是旧资源
  或再次回退到 devUrl 行为。
