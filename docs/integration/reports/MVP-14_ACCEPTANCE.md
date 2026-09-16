# MVP-14 验收报告 · Live2D 素材的分发边界

日期：2026-09-16。SPEC：[MVP-14](../specs/MVP-14_LIVE2D_ASSET_BOUNDARY.md)。依据：[MVP-13](MVP-13_ACCEPTANCE.md) §2.1 的 **DEF-1**。前置：MVP-08～11 已 PASS。

## 状态摘要

| AC | 结论 | 说明 |
| --- | --- | --- |
| A 模型不再进包 | **PASS** | exe 内模型文件名 0 命中；`live2dcubismcore` 仍 1 命中（正对照） |
| B 体积量化 | **PASS** | exe −7,883,776 B；MSI −7,938,048 B |
| C 缺资产可见降级 | **PARTIAL** | 降级路径复用 MVP-11 既有契约 + 新增「无基址即失败」分支；**未做删目录的破坏性实测** |
| D 来源与放置登记 | **PASS** | 目录、来源脚本、可覆盖环境变量均已登记；模型仍不入仓库 |
| E dev/E2E 不回归 | **PARTIAL** | 单测 34 / `tsc` 0 / 构建通过；`e2e:tauri` 未重跑 |
| F CSP 未放宽 | **PASS** | `tauri.conf.json` 的 CSP 逐字未改 |

**DEF-1 已消除。** 对外发行不再被「官方示例模型随包分发」阻塞；Cubism Core 自身的分发条件仍须单独核查（本 SPEC 不作法律结论）。

## 1. 改动

| 仓库 | 文件 | 改动 |
| --- | --- | --- |
| pet-shell | `scripts/fetch-live2d-assets.mjs` | Core → `public/live2d/core/`（留包内）；模型 → `<app data>/live2d/models/`（不入包）。可用 `PET_SHELL_LIVE2D_MODELS_DIR` 覆盖输出目录 |
| pet-shell | `src-tauri/src/lib.rs` | 新增 `live2d_models_dir()`、纯函数 `resolve_live2d_asset()`（唯一信任边界）与 `AppState::live2d_asset_path()`；两条单测 |
| pet-shell | `src-tauri/src/http_api.rs` | 新增只读路由 `GET /live2d/models/…` + `model_content_type()`；一条单测 |
| pet-shell | `src/plugins/types.ts` | `RendererMountContext` 增加 `apiBaseUrl` |
| pet-shell | `src/plugins/renderers/live2d/catalog.ts` | `LIVE2D_MODELS_ROUTE`；`live2dManifestUrl(appearance, apiBaseUrl)` 改为绝对地址，基址为空返回空串 |
| pet-shell | `src/plugins/renderers/live2d/catalog.test.ts` | **新增**：锁住「模型走回环、Core 走同源、空基址不退化」 |
| pet-shell | `src/plugins/renderers/live2dRenderer.ts` | `prepare` 记住基址；无基址时**显式失败**让宿主降级 |
| pet-shell | `src/PetWindow.tsx`、`src/plugins/slots.test.ts` | 注入/补上 `apiBaseUrl` |
| pet-shell | `.gitignore` | 说明改为「`public/live2d/` 只放 Core」 |
| Aika | 本报告 + MVP-13 报告 DEF-1 状态 + 0.6 索引 | — |

**CSP 未改动**：模型经回环 HTTP（`connect-src` / `img-src` 本就放行 `http://127.0.0.1:*`），Core 仍走同源脚本（`script-src 'self'`）。这是选「模型走 shell 自己的回环服务」而不是「走 asset 协议」的原因——后者必须放宽 `script-src`/`connect-src`。

## 2. 包内容与体积（AC-A / AC-B）

```text
cd pet-shell
pnpm tauri:build --bundles msi      退出码 0
  Finished 1 bundle at: src-tauri/target/release/bundle/msi/PetShell_0.6.0_x64_en-US.msi
```

| 项 | MVP-14 前 | MVP-14 后 | 变化 |
| --- | --- | --- | --- |
| `petshell.exe` | 20,385,792 B | **12,502,016 B** | −7,883,776 B（−38.7%） |
| `PetShell_0.6.0_x64_en-US.msi` | 13,475,840 B | **5,537,792 B** | −7,938,048 B（−58.9%） |
| MSI SHA-256 | `E5A13000…` | `6E1EAA347F78ACD6A84213ED7C1D8F7C8A324D2D8E7BDD0D6E9836DB4CE54429` | — |
| `dist/live2d/` | 41 文件 | **1 文件**（仅 Core，207,155 B） | 模型不再进产物 |
| 磁盘上的模型 | 41 文件（`public/`） | **40 文件 / 9,245,631 B**（应用数据目录） | 移出仓库与包 |

**产物扫描**（ASCII 全文件扫描）：

| 标记 | 前 | 后 |
| --- | --- | --- |
| `Hiyori.model3.json` / `Hiyori.moc3` / `Mao.moc3` / `Hiyori_m01.motion3.json` / `Hiyori.2048` / `exp_01.exp3.json` | 命中 | **全部 0** |
| `Hiyori` / `Mao` | 36 / 38 | **0 / 0** |
| `live2dcubismcore`（Core，应留在包内） | — | **1（正对照）** |

正对照是关键：同一个扫描方法仍能读到 Core 的路径，说明「0 命中」是真的不在包里，不是扫描失效。

## 3. 回环路由实测（AC-A 的访问面）

| 请求 | 结果 |
| --- | --- |
| `GET /live2d/models/hiyori/Hiyori.model3.json` | 200，1,736 B，`application/json; charset=utf-8` |
| `GET /live2d/models/hiyori/Hiyori.2048/texture_00.png` | 200，1,814,312 B，`image/png` |
| `GET /live2d/models/hiyori/Hiyori.2048/texture_01.png` | 200，2,504,416 B |
| `GET /live2d/models/hiyori/Hiyori.moc3` | 200，443,648 B，`application/octet-stream` |
| `GET /live2d/models/hiyori/Hiyori.physics3.json` | 200，26,160 B |
| `GET /live2d/models/mao/expressions/exp_01.exp3.json` | 200，1,981 B |
| `GET /live2d/models/../settings.toml`（越界） | **404** |
| `GET /live2d/models/hiyori/nope.png`（不存在） | **404** |

路径校验只接受 `[A-Za-z0-9._-]` 组成的段、拒绝空段/`.`/`..`、且至少两段；不做「先规范化再判断」，避免 `..` 在规范化过程中被消掉。这条边界由 `rejects_model_asset_paths_that_escape_the_models_directory` 覆盖（含 `../`、绝对路径、反斜杠、`%2e%2e`、超长输入）。

## 4. 可见表现与首帧（AC-C 相关）

| 项 | 结果 |
| --- | --- |
| 屏幕上可见（干净启动、无干预） | **PASS**：[`MVP-14_freshlaunch_no_intervention.png`](evidence/MVP-14_freshlaunch_no_intervention.png) |
| webview 实际绘制 | **PASS**：[`MVP-14_webview_screenshot.png`](evidence/MVP-14_webview_screenshot.png)（Hiyori 完整、贴图正确） |
| 画布像素回读 | 216×270 画布中 **11,075 / 58,320 = 19.0%** 非透明像素，`glError=0`、上下文未丢 |
| 首帧可见（从 `/api/status` 就绪起算） | **1,036 ms** |
| 模型加载状态 | `slotStatus=ready`、`activeRenderer=live2d`、两张贴图均未销毁、渲染循环运行中、`capabilities.actions` 7 项 |

```text
cd pet-shell
npx vitest run     → Test Files 3 passed (3)；Tests 34 passed (34)；退出码 0
npx tsc --noEmit   → 退出码 0
cargo test --lib   → running 16 tests；test result: ok. 16 passed; 0 failed
```

## 5. 未覆盖与观察

| 项 | 状态 |
| --- | --- |
| 删掉模型目录后的**破坏性**降级实测 | **未做**：会破坏本机可用资产。降级路径本身有两个保证——渲染器在 `prepare` 失败时让宿主回退（MVP-11 既有契约），以及新增的「基址为空即失败」分支；界面提示沿用 `.pet-slot-notice`（MVP-11 既有） |
| `e2e:tauri` 重跑 | 未跑（需 debug 构建 + WebDriver） |
| 首次（冷）加载 | 迁移后**第一次**启动在 +8 s 抓到的画面尚未绘制完成；此后多次启动稳定在 **~1.0 s**。原因未定位（可疑：首次读取 9 MB 文件的系统缓存未热）；记为观察，不是缺陷 |
| 观察（非缺陷） | Pixi 贴图解码 worker 会 `fetch` 一个 `data:` 探测图，被 CSP 的 `connect-src`（不含 `data:`）拦下并在控制台报错；**渲染不受影响**（像素回读非空、画面正确）。本轮**未改 CSP**，如实登记 |
| Cubism Core 的分发条件 | 仍须在对外发行前单独核查（不作法律结论） |

## 6. 共享接口影响

- **新增路由 `GET /live2d/models/…` 不是 Aiki 契约端点**：它服务于 shell 自己的 WebView，消费者是渲染器，不进 `DESKTOP_PET_CONTRACT.md` 的四端点集；Aiki 侧无需感知。四端点行为逐项未变（回归见 §4 的 vitest 与 §3 的 `/api/status` 200）。
- **前端内部接口**：`RendererMountContext` 增加必填 `apiBaseUrl`（同一窗口内注入，库外无消费者）。
- **脚本**：模型输出目录改变，新增 `PET_SHELL_LIVE2D_MODELS_DIR` 覆盖；Core 仍落 `public/live2d/core/`。**新克隆的仓库必须先跑一次取件脚本**，否则 Live2D 只会降级到 sprite（不是构建失败）。
- 已记入 0.6 索引与 [MVP-13 报告](MVP-13_ACCEPTANCE.md) 的 DEF-1 状态。

## 7. 待后续

- 对外发行前的 Cubism Core 分发条件核查（原 MVP-13 AC-E 要求，未因本报告关闭）。
- `e2e:tauri` 在 dev 路径上的复跑（模型外置后 dev 与 release 行为一致，但未实测）。
