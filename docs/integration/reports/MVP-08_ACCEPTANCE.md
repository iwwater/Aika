# MVP-08 验收报告 · 品牌、菜单与生命周期

日期：2026-09-15。SPEC：[MVP-08](../specs/MVP-08.md)。依据：[RPD v1.2](../../RPD_MVP_0.6.md) MVP-R08、[SPEC 索引](../SPEC_MVP_0.6.md)。前置：[MVP-10](MVP-10_ACCEPTANCE.md)。

用户决策：仓库 `f:/AIVoice/pet-shell`；**自用，不对外分发**。显示名与标识按授权使用临时值 **PetShell** / `dev.aiki.petshell`，可随时再改。

## 状态摘要

| AC | 结论 | 证据等级 |
| --- | --- | --- |
| A | **PASS** | 源码 + 图标产物；安装器实测归 MVP-13 |
| B | **PASS** | 源码 + 浏览器 E2E |
| C | **PASS** | 真实进程 |
| D | **PASS（协议退出路径）**；托盘显式退出为人工项 | device |
| E | **PASS** | 真实进程（4 条鉴权分支） |
| F | **PASS** | 真实进程 + 四端点回归 |

## 1. AC-A：品牌替换 — PASS

| 位置 | 前 | 后 |
| --- | --- | --- |
| 产品名 | `OpenPet` | `PetShell`（`Cargo.toml` name `petshell`、`tauri.conf.json` productName、`package.json` name） |
| 版本 | `0.1.6`（沿用上游） | `0.6.0`（本 fork 自己的版本） |
| 应用标识 | `dev.xter.openpet` | `dev.aiki.petshell` |
| 窗口标题 | `OpenPet` / `OpenPet Settings` | `PetShell` / `PetShell Settings` |
| 图标 | 上游 `icons/*` | 由新品牌源图 `brand-src/petshell-icon.png` 经 `pnpm tauri icon` 生成全套（含 `icon.ico`、`icon.png`、各尺寸 PNG、android/ios） |
| 前端品牌资产 | `public/brand/openpet-logo.png` | `public/brand/petshell-icon.png`（旧图已删） |
| 托盘 | id `openpet`、tooltip `OpenPet` | id `petshell`、tooltip `PetShell` |
| 关于页 | 上游项目链接 + 捐助链接 | PetShell 产品说明 + **上游来源与 GPL 声明** + 上游项目链接 |
| 文案 | 散布 `OpenPet` 的提示、占位符、hero、README | 全部替换；`README.zh-CN.md`（上游中文说明）已删除 |

**保留的法律声明**（不视为「漏删品牌」）：`LICENSE`（GPL-3.0-or-later）、上游版权、About 页的来源说明与 GPL 声明、README 的 Licensing 段落。`/api/status` 的 `product.upstream` 字段固定返回 `OpenPet v0.1.6 (GPL-3.0-or-later)` 作为**署名**，与 `product.name = PetShell` 并列，不冒充上游。

安装器元数据（产品名、标识、图标）由 `productName`/`identifier`/`icons` 派生，已随之替换；**实际打包与安装产物核验归 MVP-13 AC-E**，本阶段不声称安装器已验证。

附带影响：`identifier` 变更使应用数据目录从 `dev.xter.openpet` 迁到 `dev.aiki.petshell`，旧配置与宠物目录不会自动继承。自用场景可接受，此处如实登记而非静默迁移。

## 2. AC-B：菜单与入口 — PASS

- **托盘菜单**（Rust）：打开设置 / 显示宠物 / 隐藏宠物 / 退出，四项保留，文案随语言。
- **右键菜单**（MVP-10 menu 槽）：打开设置 / 挥手 / 暂停或自由移动 / 隐藏宠物，经 `DefaultMenuPlugin` 生成。
- **设置页**：`General`（语言、尺寸、减少动态、关于/来源）、`Import`（本地宠物包存储位置）、`Pet`（模型选择、点击行为、移动、待机）、`Bubble`（气泡样式与预览）、`API / Host`（HTTP 端点、**运行时状态**、事件调试）。
- **明确退出**：托盘 `Quit`，以及协议退出端点（见 AC-E）。

**无死入口**：随着远程导入、自更新、内置 skill 安装器的删除，其 UI、翻译键、状态与处理函数已一并移除；`API / Agent` 页收敛为 `API / Host`，只保留 HTTP API 一节，并新增运行时状态区（产品、实例角色、协议退出可用性、来源）。后端 `list_bundled_skills` / `install_bundled_skills` 与 `skills/` 目录（含 CLI、MCP、asset 三套）整体删除，`tauri.conf.json` 的 `bundle.resources` 引用同步移除。

「本地模型选择」「已支持的表现设置」「状态」分别由 `Pet` 页选择器、`Pet`/`Bubble` 页、`API / Host` 状态区 + 托盘承载。

### 2.1 内置 skills 的处置（此前登记为待决）

**决定删除**，理由：PetShell 是只服务单一宿主的 sidecar，宿主经回环 HTTP 直连；把 skill 目录写入 `~/.codex`、`~/.claude`、`~/.openclaw` 等 6 个用户级 agent 目录，既不是本产品职责，也构成对用户环境的额外写入。RPD 剪枝清单未列此项，故在此单列决策依据。

## 3. AC-C：单实例作用域 — PASS

- **作用域**：每个 Windows 用户会话一个实例，由 `tauri-plugin-single-instance` 的命名互斥量实现，键含应用标识 `dev.aiki.petshell`；不跨会话共享，也不跨安装身份共享。
- **第二实例行为**：插件在 `setup` 阶段即让第二个进程退出，**早于**本进程创建任何窗口或启动 HTTP。为保证不出现重复**可见**窗口，宠物窗口在 `tauri.conf.json` 中改为 `visible: false`，由拥有者在确定自己持锁后再显示。
- **第二实例不生成重复 HTTP**：实测第二次启动后进程数仍为 1，端口由原实例继续服务。
- **不凭端口推断所有权**：单实例判定只用互斥量；`/api/status` 的 `capabilities.instanceOwner` 表示「本进程是否持有实例锁」，与端口无关。

实测（`petshell.exe`，SHA256 `33D6B6AF372A894A4934E53625F571D7A036A9952DF2A1F1D8F3BB8B6C8E692D`，12 072 448 B）：

```text
进程数（第二实例启动前）  1
进程数（第二实例启动后）  1
第二实例启动后 /api/status  200
```

### 3.1 端口被占用：发现与边界

实测用另一个 `TcpListener` 占住 `17321` 后再启动 PetShell：进程**存活、不崩溃**，但**不绑定端口**，因此既没有 API 也没有协议退出通道；`/api/status` 无响应。

这是**有意为之**：上游同为「记录 `apiError` 后继续运行」，本 fork 不做「端口被占 → 认定另一个 PetShell 拥有它」的推断，也不静默改用其他端口。

**由此产生一条必须交给 MVP-09 的约束**：端口被占时该进程只能由宿主的进程句柄终止（协议退出不可用），所以协议退出是**托管能力的增量，不是宿主终止路径的替代**。宿主必须在派生前后探测 `/api/status`，并按 `DESKTOP_PET_CONTRACT` 的既有策略决定是否回收自己派生的进程。

## 4. AC-D / AC-E：退出语义与鉴权 — PASS

- **关窗 ≠ 退出**：关闭设置窗口由 `hide_settings_window_on_close` 拦截并隐藏；宠物窗口无边框，隐藏/显示由托盘与右键菜单控制。用户**显式退出**走托盘 `Quit`（`app.exit(0)`）或协议退出。
- **显式退出释放资源**：实测协议退出后进程数归 0、`17321` 不再处于 Listen 状态，即 HTTP 监听、托盘与窗口随进程一并释放。
- **重复退出有确定结果**：第二次请求返回 503 `shutdown already in progress`，不会二次退出或挂起。

### 4.1 协议退出契约（供 MVP-09 消费）

| 项 | 值 |
| --- | --- |
| 端点 | `POST /api/shutdown` |
| 契约版本 | `1`（`capabilities.shutdown.version`） |
| 鉴权 | `Authorization: Bearer <token>`，方案名必需 |
| 凭据来源 | 启动时的环境变量 `PET_SHELL_EXIT_TOKEN`（≥16 字符） |
| 失败语义 | `401` 缺失/错误凭据；`403` 本实例未配置令牌；`503` 已在退出中 |
| 成功语义 | `200` `{"ok":true,"shuttingDown":true,"endpoint":"/api/shutdown"}`，随后约 250 ms 退出 |

**权限边界**：只有派生 PetShell 的进程知道该令牌；attach 客户端即便能从 `127.0.0.1` 访问 API 也拿不到它。「本机地址」不是认证。令牌用长度无关的常量时间比较，不写入日志、不回显、不出现在错误体里。未配置令牌时端点对**所有人**返回 403。

实测四条分支：

```text
未配置令牌实例：无请求头 → 403 {"error":"PET_SHELL_EXIT_TOKEN was not provided at launch","ok":false}
未配置令牌实例：带 Bearer  → 403（同上）
已配置令牌实例：无请求头   → 401 {"error":"exit token required","ok":false}
已配置令牌实例：错误令牌   → 401 {"error":"exit token rejected","ok":false}
已配置令牌实例：裸令牌无方案 → 401 {"error":"exit token required","ok":false}
已配置令牌实例：正确令牌   → 200 {"ok":true,"shuttingDown":true,...}
重复请求                  → 503 {"error":"shutdown already in progress","ok":false}
退出后进程数 0，端口 Listen 数 0
```

Rust 单测另覆盖：常量时间比较、短令牌/无令牌一律关闭退出路径、重复请求返回 `AlreadyInProgress`、`/api/shutdown` 状态码映射。

## 5. AC-F：回归 — PASS

```text
pnpm exec tsc --noEmit        0 error
cargo test                    12 passed / 0 failed
pnpm exec vitest run          19 passed / 0 failed
pnpm e2e                      3 passed
```

真实进程四端点（对品牌与生命周期改动后的新构建）：

| 用例 | 结果 |
| --- | --- |
| `GET /api/status` | 200；`product.name=PetShell`、`version=0.6.0`、`upstream` 署名为 OpenPet |
| `POST /api/action {"animationId":"waiting"}` | 200，`lastAction=waiting` |
| `POST /api/say`（中文） | 200，`bubbleText` 逐字读回「PetShell 回归 你好」 |
| `POST /api/event {"type":"reviewing"}` | 200，`lastAction=review`、`recentEvents`=1 |
| 未知 event 变体 | 400，错误体与 PET-01 fixture 逐字一致 |
| `POST /api/import/website` | 404（剪枝保持） |
| `POST /api/import/local` | 400 `source path is required`（路由保留） |

复验项：第二次启动、用户退出（协议路径）、占端口、错误退出请求 —— 均见 §3、§3.1、§4。

## 6. 未覆盖

| 项 | 说明 |
| --- | --- |
| 托盘 `Quit` 的人工点击验证 | 需人工目视，本轮 **NOT RUN**；协议退出路径已覆盖同一 `app.exit(0)` 出口 |
| 托盘/窗口标题/图标的人工目视 | 需人工确认外观，本轮 **NOT RUN** |
| 安装器打包与安装核验 | 归 MVP-13 AC-E |
| 宿主侧消费新端点与新字段 | 归 MVP-09；Aiki 目前未读取 `product`/`capabilities`，也未使用 `/api/shutdown` |
| 旧配置迁移 | `identifier` 变更后旧 app data 不继承，本轮不做迁移 |

## 7. 共享接口影响

- `/api/status` **新增**两个字段：`product`（name/version/upstream）与 `capabilities`（singleInstance / instanceOwner / shutdown）。既有字段与四端点语义**未改动**，属可加性变更；PET-01 已确立「Aiki 不做版本比对」，因此 `version` 新增不会触发旧逻辑。
- **新增端点** `POST /api/shutdown`（版本 1）。Aiki 侧尚未消费，`docs/frontend/DESKTOP_PET_CONTRACT.md` 未修改 —— 按规则，该契约变更与 Aiki 识别增量应在 **MVP-09** 双仓同轮落地。
- pet-shell 侧新增依赖 `tauri-plugin-single-instance 2.4.4`（Apache-2.0 OR MIT）。
- 移除：内置 skills（代码、打包资源、UI、翻译键）、上游 logo、上游中文 README。上游 `LICENSE` 与版权保留。

## 8. 待办与阻塞

| 项 | 状态 |
| --- | --- |
| MVP-09 消费 `product`/`capabilities`/`/api/shutdown` 并同步契约文档 | 下一份 |
| 端口被占时宿主的回收策略 | 归 MVP-09（见 §3.1） |
| 托盘与图标人工目视 | 归 MVP-13 |
| 安装器打包 | 归 MVP-13 |
| 正式产品名/图标定稿 | 临时值，用户可随时改；改名需同步 `identifier` 与图标 |

0.6 冻结点仍未证明：**Live2D 未接入**，sprite↔Live2D 单一出口可切换属 MVP-11。
