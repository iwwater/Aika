# PET-01 协议基线 · OpenPet v0.1.6（实机核对）

> 2026-09-14 · 需求 DPI-01 · [SPEC](../specs/PET-01.md) · [验收报告](PET-01_ACCEPTANCE.md)
>
> **证据等级：device。** 本文结论来自本机安装并运行的原版 OpenPet v0.1.6 的**真实请求/响应**，
> 并以锁定 commit 的上游源码交叉验证。原始请求/响应摘录见各节「实测」块；截图见
> `reports/evidence/PET-01_pet_bubble.png`。
>
> 环境：Windows / 用户目录安装（无需管理员），运行文件 `C:\Users\ZYF\AppData\Local\OpenPet\openpet.exe`，
> 监听 `127.0.0.1:17321`。依据：[Release v0.1.6](https://github.com/X-T-E-R/OpenPet/releases/tag/v0.1.6)、
> [README](https://github.com/X-T-E-R/OpenPet/blob/master/README.md)、
> 锁定 commit `0675f4932a41d66d1b1fdbc6ddd94c46d6bd0ccd` 的 `src-tauri/src/http_api.rs` 与 `src-tauri/src/lib.rs`。

## 1. 版本与来源定位

| 项 | 值 |
| --- | --- |
| 仓库 / 锁定版本 | `X-T-E-R/OpenPet` / tag `v0.1.6`（Latest） |
| commit | `0675f4932a41d66d1b1fdbc6ddd94c46d6bd0ccd` |
| 发布者 / 发布时间 | `github-actions` / `2026-05-06T13:24:47Z` |
| 资产数量 | 19（Windows / macOS arm64+x64 / Linux） |
| Windows 资产 | `OpenPet_0.1.6_x64-setup.exe`（NSIS，6 406 850 B）、`OpenPet_0.1.6_x64_en-US.msi`（8 368 128 B） |
| 安装器 SHA256 | `FF6E8169C7BDA992CF8AA0AA7799EBC3234DAABF5D3FD547141D281BA6AC4D80` |
| 安装器签名 | **Authenticode: NotSigned**；带 Tauri updater 的 minisign `.sig`（`OpenPet_0.1.6_x64-setup.exe.sig`，416 B，SHA256 `618D758EA82E611484AF7FF5578DDF4762B0F6E96C8F35F7F581BB8E860FC668`） |
| 安装方式 | NSIS 静默安装（`/S`），**按用户安装**，退出码 0，无需管理员 |
| 安装位置 | `C:\Users\ZYF\AppData\Local\OpenPet`（卸载项 `HKCU\...\Uninstall\OpenPet`，版本 0.1.6） |
| **实际运行程序** | `C:\Users\ZYF\AppData\Local\OpenPet\openpet.exe`（**不是** `…-setup.exe`） |
| 同目录的干扰文件 | `uninstall.exe` —— 必须被「安装器/卸载器」规则挡住，不能配成启动路径 |
| 许可证 | GPL-3.0-or-later（上游 `LICENSE`） |

> 「未做 Authenticode 签名」是有用的事实：Windows SmartScreen 可能对首次运行告警；这不影响功能，
> 但决定了 Aiki 不应对该二进制做任何「签名可信」假设，也不应静默安装它。

## 2. 端点与协议（实机核对）

上游 README 列出 7 个端点，0.5 只用前四个控制端点（`/api/import/*` 与资产端点不接入）。

### 2.1 四端点请求形状

| 方法 | 路径 | 请求体 | 实测 |
| --- | --- | --- | --- |
| GET | `/api/status` | 无 | 200 |
| POST | `/api/action` | `{ "animationId": "<非空字符串>" }` | 200 |
| POST | `/api/say` | `{ "text": "<正文>" }`，可选 `ttlMs`（**u64**） | 200 |
| POST | `/api/event` | `{ "type": "<枚举>" }`，可选 `message`、`ttlMs` | 200 |

```text
# 实测（去敏摘录）
GET  /api/status                              → 200（1982 B 快照）
POST /api/say    {"text":"回来啦，我在的哦。","ttlMs":4000}   → 200
POST /api/action {"animationId":"waving"}                     → 200
POST /api/event  {"type":"thinking","message":"让我想一下……","ttlMs":4000} → 200
POST /api/say    {"text":"没有 ttl 的短句"}                    → 200（不传 ttlMs 也受理）
```

**`/api/event` 的 `type` 枚举逐字一致**（由上游 serde 枚举生成，实机错误信息里直接列出）：

```text
thinking | tool-running | reviewing | success | failure | attention
```

与 Aiki 的 `PetEvent` 完全对应，因此 profile 的 `events` 缺省做同名直传是正确的。

### 2.2 成功响应：**没有 `ok` 字段**

`/api/status` 的真实响应（去敏、裁剪）：

```json
{
  "activePet": {
    "id": "nia", "displayName": "Nia", "imported": false,
    "spritesheetPath": "spritesheet.webp", "spritesheetUrl": "/pets/nia/spritesheet.webp"
  },
  "apiBaseUrl": "http://127.0.0.1:17321",
  "apiError": null,
  "apiListening": true,
  "apiRestartRequired": false,
  "bubbleText": null,
  "configuredListenAddress": "127.0.0.1",
  "configuredPort": 17321,
  "lastAction": null,
  "listenAddress": "127.0.0.1",
  "petCatalog": [ { "id": "nia", "…": "…" } ],
  "petStorage": { "preset": "codex-custom", "activeDir": "…", "appDataDir": "…" },
  "petVisible": true,
  "port": 17321,
  "recentEvents": [],
  "settings": { "activePetId": "nia", "clickAction": "waving", "clickActionPool": ["waving","jumping","waiting","running","review"], "eventBubbleTtlMs": 4000, "…": "…" },
  "startedAtMs": 1789384498470
}
```

结论（与 stube 阶段的三条假设一致，现全部得到印证）：

1. **成功响应里没有 `ok`**。CLI 输出中的 `{"ok":true,…}` 是官方 CLI **自己加的包装**，不是运行时字段。
   → Aiki 的判定规则确定为「2xx + 合法 JSON 对象 = 受理」，并要求端点路径来自固定表。
2. **没有 `version` 字段**。`runtimeVersion` 在 0.5 永远为空，因此**不做版本比对**——profile 的
   `release` 仅作为人工核对时的记录，不会与上游自动对齐。
3. **没有 `actions` 清单**（也没有 capabilities 端点）。动作白名单只能来自人工核对的 profile。
4. 额外的健康字段很有用：`apiListening`（是否真的在监听）、`apiError`、`apiRestartRequired`、
   `bubbleText`（气泡正文，可用于核实 say 是否被受理）、`lastAction`、`recentEvents[]`。

`POST` 成功的响应体同样是**完整快照**（不是 `{ok:true}`）。实测 `bubbleText`、`lastAction`、
`recentEvents` 都能在随后返回的快照里看到，可作为「受理已生效」的旁证。

### 2.3 错误响应：`{"error":…,"ok":false}` + 400/404

实测四例，**逐字**（去敏；这些字符串已作为 fixture 固化）：

| 请求 | 状态 | 响应体 |
| --- | --- | --- |
| `{"animationId":"   "}` | 400 | `{"error":"animationId is required","ok":false}` |
| `{oops` | 400 | `{"error":"invalid JSON: key must be a string at line 1 column 2","ok":false}` |
| `{"text":"x","ttlMs":"abc"}` | 400 | `{"error":"invalid JSON: invalid type: string \"abc\", expected u64 at line 1 column 25","ok":false}` |
| `{"type":"not-a-real-event"}` | 400 | `{"error":"invalid JSON: unknown variant \`not-a-real-event\`, expected one of \`thinking\`, \`tool-running\`, \`reviewing\`, \`success\`, \`failure\`, \`attention\` at line 1 column 26","ok":false}` |
| `GET /api/nope` | 404 | `{"error":"route not found","ok":false}` |

**由此得到一处必须修正的判定（PET-03 已改）**：`400` 表示「**请求体不合法**」，协议本身是通的；
把它当成「协议不兼容」会让一次空动作把整条链路标成不可用并停止发送。修正后的规则：

| 状态 | 判定 |
| --- | --- |
| 2xx + 合法 JSON 对象 | `accepted`（受理，≠ 已播放） |
| 2xx + 非 JSON / 空 / 数组 | `protocol_error` → POST 记 `unknown` |
| 400 | `failed` / `invalid_input`（我们发错了，不是对面变了） |
| 404 / 405 / 415 | `incompatible`（路由/方法/媒体类型对不上） |
| 3xx | `incompatible`（我们已禁用重定向，收到即说明对面不是它） |
| 其他 4xx / 5xx | `failed` / `http_error` |

### 2.4 `ttlMs` 语义

- 类型是 **u64**（实测字符串被拒：`expected u64`）；可选，不传则用运行时默认寿命（未公开）。
- 仅 `/api/say` 与 `/api/event` 支持；`/api/action` 与 `/api/status` 没有该字段。
- `/api/say` 在**服务端把正文截到 512 字符**（实测发送 700 字后 `bubbleText.length === 512`）。
  Aiki 侧先按 500 code point 截断，因此在正常情况下不会触及上游的 512 上限。

### 2.5 CORS 与绑定（实测 + 源码）

- 上游响应带 `Access-Control-Allow-Origin: *`，并处理 `OPTIONS`（204）。也就是说**浏览器直连在技术上可行**。
- Aiki **仍然不用它**：契约要求走原生宿主传输，不把 WebView 的 CORS 成功当成架构前提，也不因此放开任意 URL。
- 默认绑定 `127.0.0.1:17321`；地址与端口在设置里改，**保存后需重启 OpenPet 生效**（快照里的
  `apiRestartRequired` 就是这个意思）。上游允许把监听地址改成 `0.0.0.0`，Aiki 只接受 loopback。

## 3. 事件 → 动作是上游硬编码的

锁定 commit 的 `lib.rs` 里，`CompanionEventType::animation_id()` 是固定映射；实机发出
`{"type":"thinking"}` 后快照的 `lastAction` 变成 `waiting`，与源码一致：

| event type | 上游播放的动作 |
| --- | --- |
| `thinking` | `waiting` |
| `tool-running` | `running` |
| `reviewing` | `review` |
| `success` | `jumping` |
| `failure` | `failed` |
| `attention` | `waving` |

**这对 Aiki 的含义**：`event` 不只是「状态提示」，它**顺带会让角色做动作**。所以
「同一轮先发 `event(thinking)` 再发 `action/emotion`」等于让角色连做两个动作——这是上游行为，
不在我们的控制范围内（契约里「动画接收后的持续时间由第三方 Runtime 决定」讲的就是这件事）。

## 4. 能力、角色与动作

- `/api/status` 只报当前角色（`activePet.id = "nia"`）与目录（`petCatalog`），**不报动作清单**。
- `settings.clickActionPool` 是**用户配置**（默认 `waving/jumping/waiting/running/review`），不是能力声明；
  它可以被用户改，因此**不能**当作 profile 的动作白名单来源。
- **上游不校验 `animationId`**：实测 `{"animationId":"backflip"}` 返回 **200**，并把 `backflip` 原样写进
  `lastAction`；源码中 `record_action(animation_id: String)` 也只是存字符串。
  → 「不靠乱发动作猜能力」不是保守，而是**唯一可行的做法**。

### 4.1 气泡 / 动作 / thinking 的可见性（device）

| 项 | 证据 |
| --- | --- |
| 角色可见 | 截图 `reports/evidence/PET-01_pet_bubble.png`：Nia 角色正常显示在桌面上 |
| 中文气泡无乱码 | 同图：`{"text":"爱花验收：气泡可见性 回来啦"}` 渲染为正确中文 |
| 动作可见 | 像素差（桌宠精灵区域 6225 个采样点、通道差阈值 40）：静息帧间差 **946–1289**，`jumping` 帧差 **2592–2797**，显著高于静息区间 |
| 未知动作**无可见效果** | `backflip` 帧差 **1182–1581**，落在静息区间内；而上游仍返回 200 并记录 `lastAction` |
| thinking 可见 | `reports/PET-01_PROTOCOL.md` 第 3 节映射 + 截图中的 `让我想一下……` 气泡；`recentEvents` 计数 1 |

> 像素差的说明：桌宠本身有常驻待机动画（呼吸/眨眼），所以「静息帧间差」不是 0。判据是
> **动作帧差显著高于静息区间**，而不是「差异非零」。采样方式、阈值与原始数值都记在验收报告里，
> 便于复现。

## 5. 进程行为（实机）

| 场景 | 观察结果 |
| --- | --- |
| 启动 | `Start-Process openpet.exe` → 进程存活、窗口出现、`127.0.0.1:17321` 在监听 |
| **关闭主窗口**（WM_CLOSE） | `CloseMainWindow()` 返回 True，但**进程不退出**、端口继续监听 → 它驻留托盘，「关窗 ≠ 退出」 |
| **强制结束** | 进程消失，端口**立即释放**（由 OS 关闭套接字） |
| **重复启动第二个实例** | **没有单实例机制**：第二个进程照常存活并显示自己的窗口；第一个仍持有 17321，第二个的 API 静默不可用 |
| **端口被别的服务占用** | 「先起 python http.server 占住 17321，再启动 OpenPet」→ OpenPet **照常启动、不抢占端口、不崩溃**，但 API 静默不可用（源码路径：`mark_api_error(...)` 后线程返回，应用继续运行） |
| 协议退出端点 | **不存在**。上游没有 shutdown 接口，因此 Aiki 只能对自有进程句柄做宿主终止 |
| 正常退出 vs 崩溃的可观察差异 | 正常退出需要走托盘菜单（本轮未触发）；崩溃（强制结束）表现为进程消失 + 端口释放，无任何清理动作 |

**这些结论直接改写了两条设计假设**（PET-05/PET-07 报告已同步）：

1. 上游**没有单实例转交**，所以 PET-05 的「单实例转交」分支对 v0.1.6 **不可达**——它是防御性代码，
   不能当成「已验证」。
2. Aiki 的托管启动必须**先探测再启动**：因为上游重复启动会产生**第二个可见的角色窗口**，
   这是用户能直接看到的错误。

## 6. 仍未核对 / 未验证的项

| 项 | 状态 |
| --- | --- |
| 当前角色 `nia` 的完整 `animationId` 清单 | **未取得**（上游不提供；需人工比对精灵图集或逐个试播并肉眼确认，属 profile 制作工作） |
| `ttlMs` 不传时的默认寿命数值 | 未取得（上游未公开；`bubbleText` 的消退时间可测量） |
| `bubbleText` / `lastAction` 在事件过期后的清理时机 | 部分观察（`bubble_expires_at_ms` 到期后置空），精确时序未测 |
| Aiki 桌面宿主 → 原生传输 → OpenPet 的真实闭环 | 属 PET-07，见其报告 |
| 上游窗口在 DPI 缩放/多显示器下的定位 | 未测（属上游窗口行为，Aiki 不接管） |

## 7. 结论

- 四端点的方法、路径、请求字段、事件枚举、成功/失败响应形状**已全部实机冻结**，
  错误体原文已固化为 `src/services/desktopPet/fixtures/openPetFixtures.ts` 的 fixture。
- 三条原本是「设计假设」的结论已被证实并写进实现：成功无 `ok`、无版本与动作清单、
  `animationId` 不做校验。
- 一处假设被**证伪并修正**：`400` 不是「协议不兼容」，见 §2.3。
- 两条上游行为写入迁移说明：**没有单实例**、**关窗不退出**，且**没有协议退出端点**。
- 许可证 GPL-3.0-or-later；本次仍是**用户本机安装、不捆绑、不再分发**，不触发再分发义务。
