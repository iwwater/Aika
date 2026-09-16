# MVP-07 验收报告 · Fork 基线、可行性与剪枝

日期：2026-09-15。SPEC：[MVP-07](../specs/MVP-07.md)。依据：[RPD v1.2](../../RPD_MVP_0.6.md) MVP-R07、[SPEC 索引](../SPEC_MVP_0.6.md)。

用户决策（2026-09-15）：仓库位置 `f:/AIVoice/pet-shell`（代号沿用 pet-shell）；**自用，不对外分发**；MVP-12 纳入且仅点击交互；本次授权覆盖所有未完成 SPEC。

## 状态摘要

| AC | 结论 | 证据等级 |
| --- | --- | --- |
| A | **PASS** | 源码级 + 本地构建 + 进程启动（device 局部） |
| B | **PASS** | 源码级 + 真实进程四端点/错误体逐字比对 |
| C | **PASS（技术出口，限自用不分发）** | 浏览器引擎实测（Edge/Chromium）；Tauri WebView2 内实测 NOT RUN |
| D | **PASS** | 源码级前后对照 + 构建 + 四端点/sprite 定向回归 |
| E | **PASS** | 见 §5 |

**模块完成 ≠ 0.6 产品完成。** 本报告只覆盖 MVP-07；MVP-08～13 与 KB-01 另行报告。

## 1. 双仓状态登记

| 仓库 | 位置 | 基线 commit | 工作状态 |
| --- | --- | --- | --- |
| Aika | `f:/AIVoice/Aika` | `0efa11c1d9fce36c2f229bb0550cf6a4911bdfea` | 仅新增本报告，未改业务源码 |
| pet-shell | `f:/AIVoice/pet-shell` | `0675f4932a41d66d1b1fdbc6ddd94c46d6bd0ccd`（= 上游 `v0.1.6`） | 本地分支 `baseline/openpet-v0.1.6`（可回退）、`aiki/0.6`（新增 `probe/live2d/`，**未提交**） |

远端已由 `origin` 改名为 `upstream`（`https://github.com/X-T-E-R/OpenPet.git`），不配置推送远端。本阶段**未提交、未推送**。

## 2. AC-A：锁定基线与可复现构建 — PASS

### 2.1 上游基线与资产哈希

```text
refs/tags/v0.1.6        125708b1a4efe5466e7e12ba4aae92cfa38295f4   （附注标签对象）
refs/tags/v0.1.6^{}     0675f4932a41d66d1b1fdbc6ddd94c46d6bd0ccd   （= 文档锁定 commit）
HEAD^{tree}             dfe341b8b69a7bd51c4237ebaff2e8c1195e92e8
tracked files           52
```

`v0.1.6` 是**附注标签**，解引用后才等于 RPD/PET-01 锁定的 commit。直接读标签行会拿到 `125708b1…`，不能当作被锁定 commit，已在本报告固定双值以免后续误引。

发布资产下载后复核，与 [PET-01 §1](../../frontend/reports/PET-01_PROTOCOL.md) 记录值**逐字一致**：

| 资产 | SHA256 | 字节 |
| --- | --- | --- |
| `OpenPet_0.1.6_x64-setup.exe` | `FF6E8169C7BDA992CF8AA0AA7799EBC3234DAABF5D3FD547141D281BA6AC4D80` | 6 406 850 |
| `OpenPet_0.1.6_x64-setup.exe.sig` | `618D758EA82E611484AF7FF5578DDF4762B0F6E96C8F35F7F581BB8E860FC668` | 416 |

下载物保存在仓库外 `f:/AIVoice/pet-shell-baseline-evidence/`，不进入仓库。

### 2.2 工具链与实际构建命令

Windows x64；`node v24.18.0`、`npm 11.16.0`、`pnpm 10.32.1`（Corepack 按 `packageManager` 固定）、`cargo`/`rustc 1.98.1`。

```text
pnpm install --frozen-lockfile          lockfile 未变动，450 包
pnpm build                              tsc --noEmit && vite build
pnpm tauri build --no-bundle            cargo release 编译 + 产出 exe
```

前端产物：`dist/index.html` 0.79 kB、`dist/assets/index-CPZdkSEA.css` 18.69 kB、`dist/assets/index-CXbUUfyo.js` 278.20 kB。

本地产物：`src-tauri/target/release/openpet.exe`，SHA256 `40F384D450AE7594FF3D0446D73C58B38724A6F21FDAE02F3686088792AA8565`，17 986 560 字节。

**为何用 `--no-bundle`**：`tauri.conf.json` 的 `bundle.createUpdaterArtifacts: true` 需要 `TAURI_SIGNING_PRIVATE_KEY`；上游 CI（`release.yml`）从仓库 secret 注入该密钥，本机没有。跳过打包**只影响安装包产出**，不影响 AC-A 的「构建可启动」。本地 exe 与上游发布安装包内 exe **不保证字节一致**（工具链路径与签名不同），不做等价声明。

### 2.3 启动验证（device 局部）

启动前确认无 `openpet` 进程、`17321` 未监听，避免「静默不可用」被误判为通过。

```text
Start-Process openpet.exe   → 进程存活（Id 37392）
GET http://127.0.0.1:17321/api/status  → HTTP 200
```

响应与 PET-01 §2.2 快照同形（`activePet.id=nia`、`apiListening=true`、无 `ok`、无 `version`、无 `actions`）。

### 2.4 环境注意项

本机 `core.autocrlf=true`，克隆后 `src-tauri/Cargo.toml`、`src-tauri/gen/schemas/*.json` 显示为 modified 但 `git diff` 为空（仅行尾归一化）。后续比对「基线是否被污染」时须先排除该项，否则会误判。

## 3. AC-B：四端点契约与功能盘点 — PASS

### 3.1 四端点与错误语义（真实进程，逐字）

复用 2.3 的同一运行实例：

| 请求 | 结果 | 与 PET-01 冻结值 |
| --- | --- | --- |
| `POST /api/action {"animationId":"waving"}` | 200（返回完整快照） | 一致 |
| `POST /api/say {"text":"基线核对 回来啦","ttlMs":4000}` | 200；随后 `/api/status` 的 `bubbleText` 逐字读回该中文（长度 8） | 一致 |
| `POST /api/event {"type":"thinking"}` | 200；`lastAction=waiting`，`recentEvents` 计数 1 且 `animationId=waiting`、`bubbleText="Thinking..."` | 一致（event→动作硬编码映射成立） |
| `POST /api/event {"type":"not-a-real-event"}` | 400 `{"error":"invalid JSON: unknown variant \`not-a-real-event\`, expected one of \`thinking\`, \`tool-running\`, \`reviewing\`, \`success\`, \`failure\`, \`attention\` at line 1 column 26","ok":false}` | 逐字一致 |
| `POST /api/say {"text":"x","ttlMs":"abc"}` | 400 `{"error":"invalid JSON: invalid type: string \"abc\", expected u64 at line 1 column 25","ok":false}` | 逐字一致 |
| `POST /api/action {"animationId":"   "}` | 400 `{"error":"animationId is required","ok":false}` | 逐字一致 |
| 坏 JSON `{oops` | 400 `{"error":"invalid JSON: key must be a string at line 1 column 2","ok":false}` | 逐字一致 |
| `GET /api/nope` | 404 `{"error":"route not found","ok":false}` | 逐字一致 |

通道语义复核：`say` 走 `bubbleText`、`action` 走 `lastAction`、`event` 进 `recentEvents`，三者互不串道；`bubbleText` 到期后由快照清空（TTL 生效），因此**读状态必须紧跟写入**，否则会误判为「未送达」。这也是 PET-01 记录的「`recentEvents` 只记 event」同一条语义。

一次测量口径说明：早期用 PowerShell 控制台读取 `bubbleText` 得到 `????`，改用 UTF-8 字节收发后读回原文，**证伪为控制台解码问题，非上游缺陷**，此处保留以免重犯。

### 3.2 功能盘点（存在 / 不存在 / 保留 / 删除）

源码依据：`src-tauri/src/lib.rs`、`src-tauri/src/http_api.rs`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/capabilities/default.json`、`package.json`、`README.md` 与锁定 commit 的 52 个文件清单。

**上游确实存在（可作为剪枝对象）**

| 功能 | 源码依据 | 0.6 处置 |
| --- | --- | --- |
| 网站导入（Petdex / Codex Pets / 通用页抓取） | `lib.rs` `resolve_pet_source`/`resolve_petdex_source`/`resolve_codex_pets_source`/`resolve_generic_pet_page`；路由 `POST /api/import/website`；命令 `import_pet_from_website` | **D 阶段删除** |
| 更新检查与 updater 插件 | `Cargo.toml` `tauri-plugin-updater`；`lib.rs` `check_github_release_update`、`GITHUB_LATEST_RELEASE_API`、`GITHUB_RELEASES_URL`、命令 `check_for_update`；`tauri.conf.json` `plugins.updater` + `createUpdaterArtifacts`；`capabilities/default.json` `updater:default`；`package.json` `@tauri-apps/plugin-updater` | **D 阶段删除** |
| 远程依赖 | `Cargo.toml` `reqwest`、`rustls-native-certs` | **D 阶段随网站导入删除** |
| 内置 skills 与安装器 | `skills/openpet-cli|openpet-mcp|openpet-asset`；`lib.rs` `BUNDLED_SKILL_IDS`/`install_one_skill`/`skill_target`（写入 `~/.codex`、`~/.claude`、`~/.openclaw` 等 6 个 target）；命令 `list_bundled_skills`、`install_bundled_skills`；`tauri.conf.json` `bundle.resources` | **保留待议**：RPD 剪枝清单未列；Aiki 经 HTTP 直连，不需要给第三方 agent 装 skills。登记为 MVP-08 待决，不擅自删除 |
| 品牌资产 | `public/brand/openpet-logo.png`、`src-tauri/icons/*`、托盘 `tooltip("OpenPet")`、`productName`/`identifier` | 归 **MVP-08 AC-A**，本阶段不删 |
| 外部链接打开 | `lib.rs` `open_external_url`；`SettingsPage.tsx` 项目/捐助链接 | 与品牌同批（MVP-08）处理 |

**上游不存在（不得列为剪枝成果，须作为待新增登记）**

| 能力 | 依据 |
| --- | --- |
| 单实例机制 | `Cargo.toml` 无 single-instance 插件；PET-01 §5 实测第二实例照常启动并显示第二个窗口 |
| 协议退出端点 | `http_api.rs` 路由表只有 4 控制端点 + 2 导入 + 1 资产，无 shutdown |
| `version` / `actions` 字段 | `RuntimeSnapshot` 无该字段；实机 200 响应亦无 |
| Agent / Memory / LLM 推理 | Rust 侧无任何模型调用；`README.md` 明示 OpenPet 由外部 agent 控制 |
| Live2D | 渲染仅为 spritesheet 图集；`src/pet/*` 无 Live2D |
| 反向通道（点击/文件回传宿主） | 无 WS / 无出站回调；点击仅本地播动作 |

**保留（0.6 必留项）**：loopback HTTP 四端点及其成功/错误语义、透明置顶目标窗口（`transparent`/`alwaysOnTop`/`skipTaskbar`/`decorations:false`）、窗口拖动、托盘「打开设置/显示/隐藏/退出」、本地宠物包导入（`POST /api/import/local`）、本地模型选择与表现设置、`GPL-3.0-or-later` 的 `LICENSE` 与版权/来源信息。

## 4. AC-C：Live2D 技术出口 — PASS（限自用不分发）

### 4.1 组合与版本

| 组件 | 版本 / 来源 | 许可 |
| --- | --- | --- |
| Live2D Cubism Core (Web) | 官方 CDN `cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js`；207 155 B；SHA256 `25AE938CB4FE282CE189B357BCC97E603D1E1F7EC78BF04150D401C23CDC792F`；运行时自报 **5.1.0**（`csmGetVersion()`=83951616=0x05010000），`csmGetLatestMocVersion()`=5 | Live2D Proprietary Software License；`Core/RedistributableFiles.txt` 明列 `live2dcubismcore.{js,min.js,d.ts}` **可再分发** |
| 显示库 | `untitled-pixi-live2d-engine` **1.3.5**（MIT），peer `pixi.js ^8.13.1` | MIT |
| 渲染基座 | `pixi.js` **8.20.1** | MIT |
| 现成授权模型 | Live2D 官方示例 **Hiyori**（`Live2D/CubismWebSamples`，`Hiyori.model3.json` Version 3） | Live2D Free Material License |

选型排除：`pixi-live2d-display` 0.4.0（MIT）仅支持 PixiJS ≤ v7；`pixi-live2d5` 无 npm 包。Cubism 2.1 旧运行时自 2019-09-04 起官方已停止分发，故只走 Cubism Modern 入口，**不引入 Cubism 2 路径**。

### 4.2 最小样例实测结果

样例：`probe/live2d/`（`index.html` + `probe.ts` + `verify.mjs`），用项目自带 Vite dev server 托管，Playwright 驱动本机 Edge 加载。

```text
channel             msedge（HeadlessChrome/153，Edg/153）
webgl2              true
renderer            webgl / "WebGL 2.0 (OpenGL ES 3.0 Chromium)"
core.present        true
csmGetVersion       83951616  → 5.1.0
模型加载            185 ms（Hiyori，模型空间 1203×3778）
透明背景            154 970 透明像素 / 21 030 不透明像素（backgroundAlpha: 0）
颜色丰富度          8 598 种不同颜色；包围盒 x∈[154,241] y∈[52,428]
动作帧差            Idle(0) 播放后 7 300 像素变化（相对首帧）
未知 motion group   ok（不抛错）
未知 motion index   ok（不抛错）
未知 expression     ok（不抛错）
hitTest             ["Body"]
```

结论：**技术组合成立**。Cubism Core 5.1.0 + PixiJS v8 + MIT 显示库可在 Chromium 系引擎渲染 Cubism 4 模型，透明背景可用（透明桌宠窗口的前提），动作能真实改变画面，hit area 可用于 MVP-12 点击。

**两条必须带进 MVP-11 的结论**：

1. 未知 motion group / index / expression **不抛错**，引擎静默受理。因此「未知项安全降级、不虚报动作成功」必须由 renderer 自己对照 profile 校验，**不能依赖异常判定**。
2. 像素读回需 `preserveDrawingBuffer: true`；否则 WebGL 帧在合成后被丢弃，采样得到空白帧——这会伪装成「模型没渲染」。MVP-11/13 的所有截图类证据都要先确认该前提。

### 4.3 目标用途与分发条件

- **自用、不对外分发**：无需 SDK 发行许可（Publication License）与付费；SDK 试用/开发阶段本身免费，条件是接受 *Live2D Proprietary Software License* 与 *Live2D Open Software License*。
- **个人/小规模企业在「发布」时才需许可，但 Expandable Applications 除外**：本产品具备**换装**这类显著可扩展性，一旦对外发布，即属需事先审批并签特别协议的类别，个人身份**不自动豁免**。这与 RPD §5 的警告一致。
- 因此：**自用路径技术上无阻塞**；**对外分发路径仍为条件阻塞**，需在改变分发目标时重开此出口。本报告不作法律结论。
- 素材逐项登记在案；未授权素材不入分发物。Cubism Core 属可再分发文件，但仍是 Live2D 专有软件，不是常规开源依赖，`THIRD_PARTY_NOTICES` 类记录需在 MVP-13 补齐。

### 4.4 AC-C 未覆盖部分

在**真实 pet-shell 的 Tauri WebView2 窗口内**加载该组合属 device 验证，本阶段 **NOT RUN**（当前仅 Edge/Chromium 引擎）。注意 `tauri.conf.json` 现有 CSP 的 `script-src 'self'` 与 `connect-src` 白名单需在 MVP-11 一并核对，否则模型与 Core 的加载可能被 CSP 拦下。

## 5. AC-D：剪枝 — PASS

### 5.1 删除范围（均为 §3.2 已证明「上游确实存在」的项）

只删 RPD §2 明确列入的**远程导入**与**更新**两类。品牌资产、托盘文案、`productName`/`identifier` 归 MVP-08，本阶段**未动**；内置 skills 按 §3.2 登记为 MVP-08 待决，**未删**。

| 层 | 删除项 |
| --- | --- |
| 依赖 | `reqwest`、`rustls-native-certs`、`tauri-plugin-updater`（Cargo）；`@tauri-apps/plugin-updater`（npm） |
| 路由 | `POST /api/import/website` |
| 命令 | `check_for_update`、`import_pet_from_website`（含 `generate_handler!` 登记） |
| Rust 逻辑 | 网站抓取全家（`parse_safe_import_url`、`is_blocked_host`、`resolve_pet_source`/petdex/codex-pets/generic、`fetch_json`/`fetch_text`/`fetch_bytes`、JSON-LD 与 meta 解析、`install_resolved_pet`、`website_import_client`、`native_tls_root_certificates`）；更新全家（`normalize_release_version`、`parse_version_parts`、`is_newer_release`、`check_github_release_update`、`GITHUB_*` 常量、`GithubRelease`/`UpdateCheckResult`/`WebsiteImportPayload`/`ResolvedPetSource`/`Petdex*`/`CodexPets*` 结构体）；`PetSettings.auto_update_checks` 字段 |
| 配置 | `tauri.conf.json` 的 `plugins.updater` 与 `createUpdaterArtifacts`（改回 `false`）；`capabilities/default.json` 的 `updater:default` |
| 前端 | `@tauri-apps/plugin-updater` 导入、`relaunch`、更新状态机（6 个 state + 7 个 handler/effect）、`formatBytes`/`formatDownloadProgress`、`GITHUB_RELEASES_URL`、`PET_IMPORT_SOURCE_LINKS`、网站导入表单与两个 UI 区块、en/zh-CN 两套翻译中的更新与网站导入文案 |
| 样式 | 仅随 UI 失效的规则：`.import-card`、`.source-links*`、`.update-strip*`、`.compact-switch*`、`.update-result*`、`.update-progress*`、`.update-notes*` 及对应响应式覆盖 |

保留项未被触碰：四端点及其语义、`POST /api/import/local`、透明置顶窗口、拖动、托盘四项、本地模型选择与表现设置、`LICENSE` 与来源信息、`PROJECT_LINKS`/`open_external_url`（品牌阶段再处理）。

### 5.2 前后对照

| 指标 | 前 | 后 |
| --- | --- | --- |
| `src-tauri/src/lib.rs` | 2959 行 | 2142 行 |
| `src/SettingsPage.tsx` | 2223 行 | 1865 行 |
| `src/styles.css` | 1184 行 | 985 行 |
| Rust 单测 | 13 | 6 |
| 前端产物 JS / CSS | 278.20 kB / 18.69 kB | 265.41 kB / 16.01 kB |
| vite 模块数 | 33 | 31 |
| `openpet.exe` | 17 986 560 B | 12 808 704 B（−5.18 MB，−28.8%） |
| `openpet.exe` SHA256 | `40F384D4…8565` | `7E2FF146764B826BAE85021C15F0C10619AA5811C567DB6D96B7E3BAC1C12E52` |

### 5.3 定向回归（全部对剪枝后的新构建执行）

```text
pnpm build                                  tsc --noEmit 通过；vite build 通过
cargo check                                0 error / 0 warning
cargo test                                  6 passed; 0 failed
pnpm e2e（Playwright/Chromium，sprite UI） 3 passed（设置页 tab、点击与右键、拖动阈值）
```

真实进程四端点回归：

| 用例 | 结果 |
| --- | --- |
| `GET /api/status` | 200 |
| `POST /api/action {"animationId":"waving"}` | 200，`lastAction=waving` |
| `POST /api/say`（中文 + `ttlMs`） | 200，`bubbleText` 逐字读回「剪枝回归 回来啦」 |
| `POST /api/event {"type":"thinking"}` | 200，`lastAction=waiting`、`recentEvents`=1 |
| 未知 event 变体 / `ttlMs` 类型错 / 空 `animationId` | 400，错误体与 PET-01 fixture **逐字一致** |
| `GET /api/nope` | 404 `route not found` |
| `POST /api/import/website`（应已剪除） | 404 `route not found` ✅ |
| `POST /api/import/local`（应保留） | 400 `source path is required` ✅ 路由存在且处理已接线 |

`/api/import/local` 用「空 source 触发的参数错误」而不是真实导入来判定：404 与 400 足以区分「路由被删」与「路由保留」，同时避免向用户 `~/.codex/pets` 写入测试数据。

### 5.4 剪枝未能覆盖的项

- **托盘/菜单的可见项**（打开设置/显示/隐藏/退出）与透明置顶窗口行为属人工目视项，本轮 **NOT RUN**，归 MVP-08 生命周期验收。
- 安装包（MSI/NSIS）本轮未构建，归 MVP-13 AC-E。附带说明：`createUpdaterArtifacts` 改为 `false` 后，构建安装包不再需要 `TAURI_SIGNING_PRIVATE_KEY`，MVP-13 的打包路径因此少一个外部依赖。

## 6. AC-E：可推进范围、阻塞项与实际路径 — PASS

**可立即推进（无前置阻塞）**

1. **MVP-10 最小插件槽**：依赖的 MVP-07 基线与剪枝已通过。
2. **MVP-08 品牌/菜单/生命周期**：除正式命名外无技术前置；`skills` 是否剪除需在同一份决策中一并定。
3. **MVP-11 Live2D**：AC-C 技术出口已过（自用口径），可进入 renderer 实现。
4. **MVP-12 点击交互**：AC-C 已实测 `hitTest` 返回 `["Body"]`，hit area 可用。

**阻塞项**

| 项 | 阻塞性质 | 解除条件 |
| --- | --- | --- |
| pet-shell 内 WebView2 实测 | 证据缺口 | MVP-11 在真实 pet 窗口内复验；顺带核对 CSP |
| 对外分发 | 许可条件 | 分发目标变更时重开 AC-C 出口；换装属 Expandable Applications，个人豁免不适用 |
| 内置 skills 去留 | 产品决策 | MVP-08 决策后处理 |
| 安装/卸载验证 | 环境授权 | 沿用 0.5 的 INT-03 口径，MVP-13 执行 |

**注册为「待新增需求」而非已交付**（上游不存在，不得计入剪枝成果）：单实例机制、协议退出端点、状态快照中的 `version`/`actions` 字段、双向反向通道。前两项由 MVP-08 补齐，第 3 项随 MVP-09 身份/profile 决定，第 4 项即 MVP-12。

## 7. 共享接口影响

- 本阶段**未改动** Aika 侧任何业务源码；`src/services/desktopPet/fixtures/openPetFixtures.ts` 与 PET-01 结论均未变更，无需双仓同轮修订。
- pet-shell 侧新增 `pixi.js`、`untitled-pixi-live2d-engine` 两个 devDependency 供 AC-C 探针使用；是否成为 0.6 正式依赖以 MVP-11 冻结为准。
- 新增 `probe/live2d/`（探针源码入库，模型与 Core 资产已 `gitignore`，不入库）。
- 未新增或修改 `docs/frontend/DESKTOP_PET_CONTRACT.md`。

## 8. 待办与阻塞

| 项 | 状态 |
| --- | --- |
| pet-shell 内 WebView2 实测 Live2D | NOT RUN，归 MVP-11 |
| CSP 与 Live2D 加载的兼容核对 | 待 MVP-11 |
| skills 打包/安装器是否剪除 | 待 MVP-08 决策，登记不擅删 |
| 托盘/窗口人工目视项 | 归 MVP-08 |
| MSI/NSIS 打包 | 归 MVP-13 |
| 对外分发口径下的 Live2D 许可 | 条件阻塞；自用不受影响 |

0.5 产品与发布欠账不因本报告自动清账，口径仍以 [0.5 索引](../SPEC_MVP_0.5.md) 为准。
