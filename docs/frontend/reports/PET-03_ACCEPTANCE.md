# PET-03 验收报告 · OpenPet HTTP Adapter

> 2026-09-14 · 需求 DPI-03 · [SPEC](../specs/PET-03.md) · 协议依据 [PET-01_PROTOCOL.md](PET-01_PROTOCOL.md)
> 前置：PET-02（契约与 Service）、PET-01 协议基线
>
> **本轮追加了实机复核（见 §7）**：PET-01 在真机上跑通后，协议形状与状态码含义得到实证，
> 并据此**修正了一处判定缺陷**（`400` 不是协议不兼容）。真实 WebView→原生→OpenPet 链路
> 仍不在本 SPEC（PET-07）。

## 1. 改动

新增：

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/services/desktopPet/openPetProtocol.ts` | 固定端点表、请求构造、响应判定、传输端口与失败分类（纯函数） |
| `aika-crossplatform/src/services/desktopPet/openPetAdapter.ts` | 生产 adapter：归一化命令 → 上游请求体；响应 → `PetResult`；连接 → `PetStatus` |
| `aika-crossplatform/src/services/desktopPet/tauriPetHttp.ts` | 原生宿主传输绑定（`invoke` 注入，不 import `@tauri-apps`） |
| `aika-crossplatform/src/services/desktopPet/fixtures/openPetFixtures.ts` | 15 条响应 fixture（成功/错误/畸形/超大形状） |
| `aika-crossplatform/src/services/desktopPet/openPetAdapter.test.ts` | PET-03-A～E 定向测试（21 项） |
| `aika-crossplatform/src-tauri/src/desktop_pet_http.rs` | 原生 HTTP 传输：固定端点、loopback 再校验、禁代理与重定向、1500ms 硬超时、256KiB 上限 + 5 项单测 |

修改（定向增量）：

| 文件 | 改动 |
| --- | --- |
| `aika-crossplatform/src-tauri/Cargo.toml` | 新增 `reqwest = { version = "0.12", default-features = false }`（只走 http，不引 TLS/charset/http2） |
| `aika-crossplatform/src-tauri/src/lib.rs` | `mod desktop_pet_http;` + 注册 `desktop_pet_http_request` 命令 |
| `aika-crossplatform/src/services/desktopPet/fakeDesktopPet.ts` | 追加假 HTTP 端口（测试资产） |

未改：`petWindow.rs`、`remote.rs`、`gateway.rs`、`src/pet/`、任何 renderer 或第三方源码。

## 2. 命令与退出码

```text
npx vitest run src/services/desktopPet src/kernel/architecture.test.ts
→ Test Files 3 passed (3) / Tests 72 passed (72) / exit 0
  （desktopPet 44 项：PET-02 23 + PET-03 21；内核门禁 28 项）

npx tsc --noEmit
→ 无 error TS 输出 / exit 0

cargo test --offline desktop_pet_http          （工作目录 src-tauri）
→ running 5 tests ... test result: ok. 5 passed; 0 failed / exit 0
  仅 1 条既有的 linker_messages 警告，无新增编译警告
```

未跑全仓测试、未做 Tauri 打包（那属 PET-07 与 INT-03）。

## 3. 逐 AC 证据

| AC | 结论 | 证据 |
| --- | --- | --- |
| PET-03-A | **PASS** | 黄金用例逐字段核对：`status` 是 `GET /api/status` 且无 body；`say` body 恰为 `{text, ttlMs:4000}`；**`action` body 只有 `animationId`、没有 `ttlMs`**；`event` body 为 `{type,message,ttlMs}`。`emotion("happy")` 打到的是 **`action` 端点**（不存在 `/api/emotion`）且只用 profile 里已验证的 `anim_happy`；未映射动作 `backflip` 请求数为 0。端点表被断言为封闭四项 |
| PET-03-B | **PASS** | 8 类失败各自分类正确：连接被拒 `failed/offline`、超时 `unknown/timeout`、超大 `unknown/protocol_error`、传输拦截 `failed/unsupported`、404 `failed/unsupported`、500 `failed/http_error`、200+`ok:false` `failed/protocol_error`、200+HTML `unknown/protocol_error`；每例都断言 **POST 发送次数 = 1**（无重试）。另有 TTL 收口用例（4000→4000、60000→10000）与「剩余 <500ms 直接 expired 且零请求」 |
| PET-03-C | **PASS** | 构造期拒绝 `http://10.0.0.5:17321`、`https://…`、带路径的 base；302 重定向判 `incompatible` 且**只有 1 次请求**（未跟随）；原生端口把非法 base 翻成 `blocked` 且不调用 `invoke`（断言 invoke 调用次数=1）。禁代理/禁重定向/端点固定由 `desktop_pet_http.rs` 实现并被 Rust 单测与静态断言双层覆盖（`no_proxy`、`Policy::none`、四路径、`MAX_RESPONSE_BYTES`）。**未为 CORS 修改上游绑定地址，也未启用任何公网代理** |
| PET-03-D | **PASS** | 上游 `activePet.id = "nia"` 而 profile 是 `default` 时，`action`/`emotion` 均 `skipped/unsupported` 且 `action` 端点请求数 0。status 返回 HTML（占端口的其它服务）时判 `incompatible`，随后 `say`/`action`/`event` 请求数全为 0 —— 不对任意服务发控制请求 |
| PET-03-E | **PASS（双轨已分别记录）** | 逻辑轨：`openPetAdapter.test.ts` 跑生产 adapter + 假端口，21 项。原生轨：`cargo test --offline desktop_pet_http` 5 项（loopback 白名单 11 个负例、固定表拼 URL、封闭端点表、响应体积上限）。**真实 WebView→原生→OpenPet 未跑，留 PET-07**；本轮不宣称该链路可用 |

## 4. 关键设计决定（与上游事实绑定）

- **不要求响应含 `ok`**：PET-01 查明 CLI 输出里的 `{"ok":true,…}` 是**官方客户端自己加的包装**；运行时是否回 `ok` 未证实。因此判定为「2xx + 合法 JSON 对象 = 受理」，并在出现显式 `ok:false` 时判失败。
- **2xx 但响应读不懂 → `unknown/protocol_error`**，而不是 `failed`：对面答了话，但无法证明请求被受理；这与「POST 不自动重试」是同一条推理。
- **连接失败与超时严格分开**：`connection` = 确定没送到 → `failed`；`timeout` = 可能已送到 → `unknown`。
- **`action` 不带 TTL**：上游 action 没有该字段（PET-01 已确认），塞进去属于未经验证的字段。
- **本地取消不承诺撤回**：`signal` 只保证我们不再使用结果；原生请求另有 1500ms 硬超时，不会留下悬挂连接。

## 5. 共享契约影响

未新增共享类型（沿用 PET-02 的 `desktopPet.integration.v1`）。新增的是**实现层**与一个 Rust 命令 `desktop_pet_http_request`。

| 组件 | 说明 | 受影响消费者 |
| --- | --- | --- |
| Rust 命令 `desktop_pet_http_request` | 新命令；入参 `base`/`endpoint`/`body`/`timeoutMs`，返回 `{status, body}` 或 `{kind}` | PET-06 宿主装配（`createTauriPetHttpPort`） |
| `Cargo.toml` 新增 `reqwest` | 直接依赖（此前仅经 tauri-plugin-http 间接存在） | 构建体积；不影响既有功能 |

## 6. 遗留项

| 项 | 归属 | 状态 |
| --- | --- | --- |
| 单在途 + 16 待发、事件合并/去重/期限、presenter | PET-04 | 未实现（本层不排队、不重试） |
| 进程端口与所有权 | PET-05 | 未实现 |
| 生产装配与设置页（把 `createTauriPetHttpPort` 接进内核） | PET-06 | 未实现 |
| `/api/status` 真实字段（版本/动作清单）与当前角色 animationId 清单 | PET-01/PET-07 | **BLOCKED**：`ni a` 等角色的动作白名单仍未实机核对，profile 只能先用占位/人工值 |
| 真实 WebView→原生→OpenPet 一次受理 | PET-07 | NOT RUN |
| 上游端口占用、单实例、退出机制 | PET-05/PET-07 | BLOCKED（README 未提） |

## 7. 实机复核追加（2026-09-14，含缺陷修正）

PET-01 在本机装上原版 v0.1.6 后，对 PET-03 的三条判定规则做了实机核对：

| 原规则 | 实机结论 | 处置 |
| --- | --- | --- |
| 成功响应可能含 `ok`，需按其判断 | **成功响应里没有 `ok`**（CLI 的 `{"ok":true,…}` 是官方 CLI 自己包的）；失败体是 `{"error":…,"ok":false}` 配 400/404 | 判定保持「2xx + 合法 JSON 对象 = 受理」，`ok:false` 作为防御性分支保留 |
| `400` → `incompatible` | **错**。实测 400 = 请求体不合法（`animationId is required`、`invalid JSON: …`、`expected u64`、未知 event 变体）。协议是通的 | **已改**：`400 → failed/invalid_input`；`404/405/415/3xx → incompatible`。真实错误体已固化为 fixture，并加回归用例 |
| 未知 `animationId` 会被上游拒绝 | **不会**。`{"animationId":"backflip"}` → **200**，`lastAction` 原样回显；上游 `record_action` 只存字符串，**校验发生在前端白名单**（`isPetActionAnimationId`） | 保留 PET-03-D 的能力守门：「不靠乱发动作猜能力」是唯一可行做法 |

同时把实机快照固化进 fixture（`DEVICE_STATUS_SNAPSHOT`），并新增断言：解析结果**只有**
`{port, petId}`——上游没有 `version`、没有 `actions` 清单，解析器不得凭空造出这两个键。

```text
npx vitest run src/services/desktopPet src/app/hosts src/presentation/desktopPetPresenter.test.ts
→ Test Files 7 passed (7) / Tests 105 passed (105) / exit 0
```

另有两项实机事实进入设计输入（PET-05/PET-07 已同步）：

- 上游**没有单实例机制**，重复启动会产生**第二个可见角色窗口**——因此托管启动必须「先探测再启动」。
- 上游**没有协议退出端点**，退出只能靠宿主终止自有进程句柄。
