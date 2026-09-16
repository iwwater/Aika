# MVP-13 验收报告 · 真机与发行验收

日期：2026-09-16。SPEC：[MVP-13](../specs/MVP-13.md)。依据：[RPD v1.2](../../RPD_MVP_0.6.md) MVP-R13、[SPEC 索引](../SPEC_MVP_0.6.md)。前置：[MVP-08](MVP-08_ACCEPTANCE.md)、[MVP-10](MVP-10_ACCEPTANCE.md)、[MVP-09](MVP-09_ACCEPTANCE.md)、[MVP-11](MVP-11_ACCEPTANCE.md)。

## 状态摘要

| AC | 结论 | 说明 |
| --- | --- | --- |
| A 基线/双表现复验 | **PARTIAL** | 基线、四端点身份、sprite 与 **Live2D 在 release 产物上的真实可见表现**（§6.1，像素证据）已取；**PET-07 适用 AC 未逐项复验** |
| B 生命周期与切换 | **PARTIAL** | 单实例、owned 显式退出、越权拒绝、重开已验；**拖动已人工复验通过**（DEF-2 已修复）；`attach`、断连恢复、经右键菜单的 sprite↔Live2D 切换未验 |
| C 性能 | **PARTIAL** | HTTP 受理 P95、气泡可见、冷启动、10 分钟待机、30 次交互的 CPU/RAM 均已取；**FPS 无证据**、反复切换未分段采样 |
| D 出站与日志 | **PASS** | 无 HTTP 客户端、CSP 限制出站、无日志文件、令牌零命中；本地路径暴露已登记 |
| E MSI 构建与包内容 | **PARTIAL** | MSI 构建/启动/重开 PASS；包内容登记发现的 **DEF-1 已由 [MVP-14](MVP-14_ACCEPTANCE.md) 修复**（官方示例模型移出分发包，exe −7.9 MB / MSI −7.9 MB） |
| F 安装/卸载 | **NOT RUN** | 需明确授权的环境，本轮未做 |
| G 三线裁决 | 见 §9 | 模块完成 / 0.6 产品 DoD / 发行就绪 分别裁决 |

**本报告不宣告 0.6 完成。** AC-E 的包内容缺陷（DEF-1）与 AC-F 未执行，按 SPEC「未解决的组合许可条件阻塞相关对外发行」处理。

## 0. 基线与环境（AC-A）

| 项 | 值 |
| --- | --- |
| Aika commit | `cc5586965c15da6c568f312d3f822028f6c58f71`（master） |
| pet-shell commit | 验收基线 `6ac67cccb5e4366f64f76958d2aa6dc1c8eda308` → 修复 DEF-2 后 `a3d1d267f8f29b1efe8201af53d510b98ed302da`（分支 `aiki/0.6`） |
| 工具链 | cargo 1.98.1 / rustc 1.98.1 / node v24.18.0 / pnpm 11.22.0 |
| 系统 | Microsoft Windows 11 专业版 10.0.26200 |
| WebView2 | 153.0.4234.32 |
| 显示器 | DISPLAY1 2560x1440 @ (0,0) 主屏；DISPLAY2 1080x1920 @ (2560,-273) 竖屏 |
| 系统 DPI | 96（100%） |
| 角色/外观 | `activePet=nia`（内置 sprite）+ 1 个导入宠物 `phoebe-jiubi`；`live2dAppearance=hiyori` |

宠物窗口落在副屏：`L=3372, T=-31, 340x296`，可见。

## 1. AC-E：MSI 构建与启动/重开 — PASS（包内容见 §2）

```text
cd pet-shell
pnpm tauri:build --bundles msi      退出码 0
  vite build                        built in 2.57s
  cargo release compile             Finished in 46.06s
  Built application at: src-tauri/target/release/petshell.exe
  Finished 1 bundle at: src-tauri/target/release/bundle/msi/PetShell_0.6.0_x64_en-US.msi
```

| 产物 | 大小 | SHA-256 | 用途 |
| --- | --- | --- | --- |
| `PetShell_0.6.0_x64_en-US.msi`（首建，17:08） | 13,475,840 B | `E5A130006E19E0568A2DC45FD7F5696B62B359BAC47876BE5F06B60975D0C12B` | §1–§5 各项证据的来源构建 |
| `PetShell_0.6.0_x64_en-US.msi`（修复 DEF-2 后重建，17:27） | 13,475,840 B | `D3B5394BC46ED5095D78CF1EB50ED08821E1C5E7966A29EA3A179D482B071513` | §2.2 的修复验证与人工复验所用构建 |
| `PetShell_0.6.0_x64_en-US.msi`（修复 DEF-3 后重建，17:49） | 13,475,840 B | `D9E1CB671AA7DE10F428A9C11DD7670674159721017D4E6E5ACFB9D6C59960C6` | §2.3 的真机复验所用构建（含 DEF-2 修复） |
| `petshell.exe`（MSI 载荷） | 20,385,792 B | — | 三次构建同尺寸；包内容见 §2.1 |

三次构建都执行了同一条命令且都退出码 0；**并列记录而不是覆盖**，是因为 §1–§5 的证据来自首建，而两个缺陷的修复验证分别来自后两次重建，三者的产物不是同一份。

WiX 工具链 `WixTools314` 已在本地缓存，构建全程离线。NSIS 未尝试：INT-03 已记其工具链 `timeout: global`，本 SPEC 的 AC 只要求 MSI。

**启动/重开验证**：

| 动作 | 结果 |
| --- | --- |
| 首次启动到 `/api/status` 200 | **896 ms**（pid 39252） |
| 协议退出后重开 | **729 ms**（pid 36192） |
| 重开后状态持久化 | `activePet=nia`、`renderer=sprite`、`live2d=hiyori`、`petVisible=true`、`catalog=2`（含导入宠物）、`petStoragePreset=codex-custom` 全部保留 |
| 重开后产品身份 | `product.name=PetShell`、`version=0.6.0`、`upstream=OpenPet v0.1.6 (GPL-3.0-or-later)` |
| 重开后能力声明 | `capabilities.singleInstance=true`、`instanceOwner=true`、`shutdown={available:true, endpoint:/api/shutdown, auth:bearer-token, version:1}` |

`/api/status` 的 `product`/`capabilities`/`shutdown` 三个字段在**真实 MSI 产物**上如实返回，MVP-09 的识别增量在此闭环。

## 2. 缺陷

本轮真机验收抓到三个缺陷：**DEF-1** 包内容与许可前提不符（未修复，阻塞对外发行）；**DEF-2** Live2D 模式下整窗鼠标穿透（已修复并人工复验）；**DEF-3** 导入宠物在目录名 ≠ 清单 id 时贴图 URL 取不到（未修复）。

### 2.1 DEF-1：Live2D 素材进入了可执行文件与安装包

**性质**：包内容与许可前提不符。**不阻塞自用**，但**阻塞对外发行**（SPEC AC-E 明写）。

**→ 2026-09-16 已修复**：[MVP-14 · Live2D 素材的分发边界](MVP-14_ACCEPTANCE.md) 把官方示例模型移出分发包（exe −7,883,776 B、MSI −7,938,048 B，exe 内模型文件名 0 命中）。本节以下保留取证原样，不改写。

### 证据

`public/` 是 vite 的静态目录，构建时被无条件复制进 `dist/`，而 `frontendDist` 指向 `dist/`，于是 41 个 Live2D 资源被内嵌进 `petshell.exe`：

| 检查 | 结果 |
| --- | --- |
| `public/live2d/`（磁盘） | 41 文件 / 9,452,786 B |
| `dist/live2d/`（构建后） | 41 文件 / 9,452,786 B —— **逐字节同源，未被排除** |
| `petshell.exe` 中唯一 `/live2d/…` 路径字符串 | **41** 条，与磁盘文件一一对应 |
| 二进制标记命中 | `Hiyori`×36、`Mao`×38、`moc3`×2、`Cubism`×2、`model3`×4、`live2d`×47 |
| 体积占比 | 模型 9.0 MB / exe 20.4 MB ≈ **44%** |

嵌入路径含 `live2dcubismcore.min.js`、`Hiyori.moc3`、`Mao.moc3`、两套贴图（`texture_00.png` / `texture_01.png`）、18 个 motion、8 个 expression。

### 冲突点

`DAILY_2026-09-16.md` 记「模型（Hiyori / Mao）取自 Live2D 官方示例仓库，**不入仓库、不进分发包**（`public/live2d/` 已 gitignore）」。**gitignore 只挡住 git，挡不住打包**：vite 的 `public/` 语义就是「原样复制到产物根」。当前 MSI 实际携带官方示例模型与 Cubism Core。

### 影响与去向

1. **许可**：自用场景尚可；一旦对外分发，即构成分发 Live2D 官方示例模型 + Cubism Core，触发 Cubism SDK 的用途条件与模型使用条款。AC-E 要求的「按目标用途登记模型授权」因此无法给出「不含第三方模型」的结论。
2. **包体积**：分发包 44% 是示例模型。
3. **去向**：已由 [MVP-14 · Live2D 素材的分发边界](../specs/MVP-14_LIVE2D_ASSET_BOUNDARY.md) 处置并验收（[报告](MVP-14_ACCEPTANCE.md)）：官方示例模型移出 bundle、Cubism Core 留包内、**CSP 未放宽**。Cubism Core 自身的分发条件仍须在对外发行前单独核查（本报告不作法律结论）。

### 2.2 DEF-2：Live2D 模式下拖动与点击全部失效（整窗鼠标穿透）

**性质**：真机交互缺陷，只有真人操作会暴露。**已修复并经人工真机复验通过**（见本节末「复验结论」）。

#### 症状（用户 2026-09-16 真机报告）

| renderer | 拖动 | 点击 / 右键菜单 |
| --- | --- | --- |
| `sprite` | **正常** | 正常 |
| `live2d` | **拖不动** | 同样未生效（窗口收不到鼠标事件） |

宠物本身渲染正常、气泡也正常——只有输入进不来。

#### 根因

`RendererHost` 提交渲染器切换的顺序是「新实例 prepare/activate → **再**释放旧实例」（契约要求如此，避免切出空白帧）。而两个渲染器的 `dispose()` 都会调用 `onHitTargetChange(null)`：

```text
FALLBACK_SNAPSHOT.settings.renderer === 'sprite'        // 启动永远先挂 sprite
真快照到达 → switchTo('live2d')：
  1. live2d.prepare()  → onHitTargetChange(live2dElement)   ← 新实例注册命中元素
  2. live2d.activate()
  3. sprite.dispose()  → onHitTargetChange(null)            ← 旧实例把上一步覆盖掉
```

窗口的命中元素因此变成 `null`；`PetWindow` 的光标命中测试（每 80 ms 一次）用 `pointInElementRect(null, …)` 恒得 false，于是持续 `setIgnoreCursorEvents(true)` —— **窗口永久鼠标穿透**，拖动、点击、右键菜单一起失效。

`sprite` 不触发这条路径：持久化的 renderer 与 fallback 相同 → `switchTo` 早返回 → 不发生切换、不 dispose → 命中元素完好。这解释了「sprite 能拖、Live2D 拖不动」的全部现象。

#### 修复（pet-shell `src/plugins/rendererHost.ts`）

命中元素改为**按实例记录**，并且只发布**当前活跃实例**的那一个：

- `hitTargets: Map<plugin, element | null>` —— 每个实例的注册只写自己那条；
- `publishHitTarget()` —— 永远取 `active` 实例的条目，非活跃实例的 `null` 不再能影响窗口；
- prepare 失败 / activate 失败时回到上一实例的元素；只有 `stop()` 才把交互区域收回为「无」。

三条路径（成功提交、prepare 失败、activate 失败）都不再让「仍在输出的那个实例」失去交互区域。

#### 证据

```text
cd pet-shell
npx vitest run src/plugins/slots.test.ts   → Test Files 1 passed；Tests 20 passed；退出码 0
npx vitest run                             → Test Files 2 passed；Tests 29 passed；退出码 0
npx tsc --noEmit                           → 退出码 0
```

新增回归用例 `keeps the incoming renderer's hit target when the superseded renderer is disposed`：启动挂 sprite → 切到 live2d → 断言最后发布的命中元素是 live2d 的、且全过程从未发布 `null`。

突变验证：把发布逻辑改成「最后写入者胜」（即原缺陷语义）→ **该用例失败**（1 failed / 19 passed）；已还原，`grep MUTANT` 无命中。

#### 为什么此前没被发现

- **单测**：`RendererHost` 既有用例只用脚本化 fake，没有任何一条断言「命中元素归谁」；
- **真机 E2E（MVP-11）**：WebDriver 点击经 CDP 注入，**绕过 OS 级 `WS_EX_TRANSPARENT` 命中测试**——窗口穿透时点击照样"成功"；
- **浏览器预览**：`tauriAvailable` 为 false，`setIgnoreCursorEvents` 这条路径根本不执行。

属于「只有真人真机操作才能暴露」的一类，正是 MVP-13 AC-A/AC-B 存在的理由。

#### 复验方式（人工，约 1 分钟）

1. 外观切到 Live2D（设置页或右键菜单）；
2. 拖宠物：应能拖动，且光标进入宠物区域时不再穿透；
3. 右键：应弹出菜单（含换装项）。

#### 取证边界（如实记）

本轮尝试用 `WindowFromPoint` + `WS_EX_TRANSPARENT` 位做机器判定，但在 `sprite`（用户确认可拖）实例上同样读到穿透状态，说明该探针对本窗口不可靠，**未采信**。因此修复的机器证据只有「单测 + 突变验证」，真机结论以人工复验为准。

#### 复验结论（人工真机，2026-09-16）

重建产物（`D3B5394B…`）、外观切到 Live2D 后由用户操作：**拖动恢复正常**。修复前那一次构建（`E5A13000…`）上同一操作无效——同一台机器、同一外观、同一操作，差异只来自这次提交。

右键菜单与点击动作走的是同一条输入路径（取决于窗口能否收到鼠标事件），本节据此判定由同一次修复覆盖；若后续发现菜单单独失效，另开缺陷、不并入本条。

修复提交：pet-shell `a3d1d267f8f29b1efe8201af53d510b98ed302da`（分支 `aiki/0.6`，仅本地）。

### 2.3 DEF-3：导入宠物的贴图 URL 取不到（目录名 ≠ 清单 id 时）

**性质**：功能缺陷。触发条件是**合法布局**，不是畸形数据。**已修复并经真机复验**（见本节末）。

#### 证据

本机 `~/.codex/pets/` 下目录名是 `phoebe`，其 `pet.json` 声明的 `id` 是 `phoebe-jiubi`：

```json
{ "id": "phoebe-jiubi", "displayName": "菲比啾比", "spritesheetPath": "spritesheet.webp" }
```

`/api/status` 把它列进 `petCatalog` 并广告如下 URL，但两条 URL 形态都取不到：

```text
"id":"phoebe-jiubi", "imported":true,
"spritesheetUrl":"http://127.0.0.1:17321/api/pets/phoebe-jiubi/spritesheet"

GET /api/pets/phoebe-jiubi/spritesheet   → 404
GET /api/pets/phoebe/spritesheet         → 404
```

#### 根因（`src-tauri/src/lib.rs`）

扫描与查询对「身份」的口径不一致：

- **扫描**（`:977-1002`）按**子目录**枚举，`id` 取自目录内的 `pet.json`，只用**目录**去校验 `spritesheet.webp` 是否存在；**目录路径本身没有被保留**（`PetManifest` 没有位置字段）。
- **查询**（`:1020-1029`）反过来把清单里的 `id` 当**目录名**拼路径：

```rust
let path = imported_dir.join(&pet.id).join(&pet.spritesheet_path);
```

于是目录名 ≠ 清单 `id` 时：目录被扫描接受、进入目录列表，但路径永远拼不出来。

#### 触发面与影响

- 触发条件是 **Codex 目录约定**——目录名任意、身份写在清单里。`petStoragePreset = "codex-custom"`（`activeDir = ~/.codex/pets`）存在的意义就是支持这种形态，所以不是畸形数据。
- 影响：快照广告了自己取不到的 URL；消费者（Aiki）按 `spritesheetUrl` 加载该宠物会失败。该宠物在界面上能否切换、失败后如何降级，本轮**未实测**。
- **零测试覆盖**：`imported_pet_spritesheet_path` 在 `lib.rs` 中只有定义这一处，没有任何测试引用，也没有「目录名 ≠ id」的用例——这是它没被既有测试挡住的原因。

#### 修复方向（不预设结论，留给对应 SPEC）

1. 扫描时把解析出的绝对贴图路径随目录一起记住（目录内部映射 `id → path`，或加一个不参与序列化的位置字段），查询只查这份映射；
2. 或反过来要求并校验「目录名 == 清单 id」。

前者兼容现有数据；后者会让现有 Codex 目录直接不可用。取舍需在 SPEC 里定，本轮不擅自改。

#### 修复（pet-shell `34acf78`）

`PetManifest` 增加一个**不参与 JSON** 的字段 `local_spritesheet`（`#[serde(skip)]`）：

- **扫描**时把实际贴图路径随目录一起记下来（`pet_dir.join("spritesheet.webp")`）；
- **查询**只读这份路径，不再用清单 `id` 拼目录；
- 内置宠物为 `None`（走内嵌资源）；导入写入路径也为 `None`，落盘后紧接着重新扫描，路径由扫描写回；
- 保留原有的 `is_file()` 复查——文件被删除仍按 404 处理，原语义不放松。

新增回归用例 `serves_spritesheets_for_imported_pets_whose_directory_name_differs_from_the_id`（目录 `phoebe`、清单 id `phoebe-jiubi`）。

```text
cd pet-shell/src-tauri
cargo test --lib    → running 14 tests；test result: ok. 14 passed; 0 failed; 0 ignored
```

#### 真机复验（2026-09-16，重建产物 `D9E1CB67…`）

```text
GET /api/pets/phoebe-jiubi/spritesheet  → 200，1,793,324 B（与磁盘 spritesheet.webp 字节数一致）
GET /api/pets/nia/spritesheet           → 404（内置宠物走内嵌资源，原语义保持）
GET /api/pets/phoebe/spritesheet        → 404（目录名不是身份，原语义保持）
```

即：**曾经 404 的那条 URL 现在真的返回了贴图**，且不是「放宽成谁都给」——两种非身份形态仍按原样 404。

## 3. AC-B：生命周期与越权关闭

| 用例 | 命令/方法 | 结果 |
| --- | --- | --- |
| 单实例 | 再次启动 `petshell.exe` | 第二个进程**退出码 0 自行退出**（pid 45764），进程数仍为 1，**监听者仍只有原实例**（netstat 证实 `127.0.0.1:17321 LISTENING 39252`） |
| 越权关闭（错误令牌） | `POST /api/shutdown` + `Bearer wrong-token-…` | **401** `{"error":"exit token rejected","ok":false}`，且进程**仍然存活** |
| owned 显式退出 | `POST /api/shutdown` + 正确 `Bearer` | **200** `{"endpoint":"/api/shutdown","ok":true,"shuttingDown":true}` → 进程 **447 ms 后退出**，`netstat` 监听数 **0**（端口释放） |
| 重开 | 再次启动 | 见 §1，PASS |
| `attach` 模式 | — | **NOT RUN**（需 Aiki 侧 ProcessManager 参与） |
| 断连恢复 | — | **NOT RUN**（需真实 Aiki 联动） |
| 经右键菜单的 sprite↔Live2D 切换 | — | 见 §4.4（本轮改用设置项切换，不是菜单路径） |

`netstat` 与 `Get-NetTCPConnection` 结论不一致时以 `netstat` 为准：本机 `Get-NetTCPConnection -State Listen` 在同一时刻返回空表（连 37 条 `127.0.0.1` 监听都读不到），属工具误报，见 §8。

## 4. AC-C：性能

### 4.1 HTTP 受理 — PASS（目标 P95 ≤ 300 ms）

| 端点 | n | min | median | P95 | max |
| --- | --- | --- | --- | --- | --- |
| `GET /api/status` | 30 | 8 ms | 10 ms | **11 ms** | 53 ms |
| `POST /api/say`（ASCII） | 30 | 9 ms | 11 ms | **13 ms** | 13 ms |
| `POST /api/say`（中文） | 30 | 8 ms | 9 ms | **9 ms** | 401 ms ※ |
| `POST /api/say`（curl 交叉对照） | 3 | 0.98 ms | 1.05 ms | — | 1.18 ms |

※ **401 ms 的孤立尖峰经三组对照判定为测量装置开销，不是 PetShell 行为**：

1. 同一 PowerShell 进程内隔 25 秒再发：**10 ms**（不是空闲效应）；
2. `curl` 三次全新进程首调：**1.05 / 1.18 / 0.98 ms**（服务端真实受理时延约 1 ms）；
3. PowerShell 新进程首个 `Invoke-WebRequest`：**393–419 ms**，紧随其后的调用 9–13 ms。

结论：**服务端真实受理时延约 1 ms**；PowerShell 首调开销会污染单样本，批量的 P95 不受影响。

### 4.2 气泡可见 — PASS（目标 P95 ≤ 1000 ms）

- **状态侧**：`POST /api/say` → `/api/status.bubbleText` 匹配上探针文本 **96 ms**（轮询粒度 20 ms；`say` 响应体本身已带新 `bubbleText`）。
- **像素侧**（本轮新取）：对宠物窗口区域做「无气泡 / 有气泡」两帧差分 —— 22,946 采样点中 3,286 变化（14.32%），且「有气泡」帧中气泡清晰可读。
- 中文逐字回读正确：`中文气泡 · MVP-13 可见表现取证`。

| 证据 | 文件 |
| --- | --- |
| 无气泡参考帧 | [`MVP-13_pet_nobubble.png`](evidence/MVP-13_pet_nobubble.png) |
| 有气泡帧（ASCII 探针） | [`MVP-13_pet_withbubble.png`](evidence/MVP-13_pet_withbubble.png) |
| 中文气泡帧 | [`MVP-13_pet_bubble_zh.png`](evidence/MVP-13_pet_bubble_zh.png) |

### 4.3 冷启动、待机与交互采样

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 冷启动（首建产物，sprite） | **896 ms** 到 `/api/status` 200 | §1 |
| 冷启动（重开） | **729 ms** | §1 |
| 冷启动（修复产物，Live2D） | **748 ms** | §6.1 |
| **10 分钟待机**（Live2D，61 点 / 611 s） | CPU **avg 1.97%**、P95 3%、max 3.3%（单核）；RAM **37 → 38 MB** 稳定；线程 27–30、句柄 367–383 | [`MVP-13_standby_samples_live2d.csv`](evidence/MVP-13_standby_samples_live2d.csv) |
| **30 次交互**（say / action / event 各 10） | **30/30 返回 200，0 失败**，673 ms 内完成；期间 CPU **16.25% 单核**；RAM 38 MB 前后无增长 | 下表命令 |
| 待机（sprite 另一次运行） | 11 点 / 110 s 后因切 renderer 人工中断；CPU 约 2% 单核、RAM 32 MB 稳定 | [`MVP-13_standby_samples_sprite.csv`](evidence/MVP-13_standby_samples_sprite.csv) |

采样命令（cwd = `pet-shell` 之外的普通 shell；10 s 一点，除首行外每点记录 经过秒/常驻MB/累计CPU秒/线程/句柄）：

```text
# 待机：后台每 10 s 采一次 Get-Process petshell，共 61 点（611 s），落 CSV
# 交互：连发 30 次 POST（/api/say /api/action /api/event 各 10 次），前后各取
#       TotalProcessorTime 与 WorkingSet64；CPU% = ΔCPU / Δ墙钟
# 结论行：interactions=30 ok, non200=0, elapsed_ms=673
#        cpu_delta_s=0.109  avg_cpu_pct_of_one_core=16.25
#        ram_before=38MB ram_after=38MB
```

交互侧 CPU 明显高于待机侧（16.25% vs 1.97%）属预期：30 次请求在 0.67 s 内打完，包含动作与事件触发的重绘。**两侧都无内存增长**。

### 4.4 未取到的性能证据

- **FPS**：未见渲染器暴露帧率指标；本轮未搭 E2E 采样（MVP-11 的 `e2e:tauri` 驱动的是 `target/debug` 产物，与 MSI 载荷不是同一构建，且单实例会与在跑实例冲突）。
- **反复切换 renderer 期间的性能**：本轮只在启动时切换过一次（并因此抓到 DEF-2），未做多次切换下的分段采样。
- **经菜单的切换**：见 §3，未跑。

## 5. AC-D：默认开关、出站面与诊断日志 — PASS

**默认开关**（`PetSettings::default()`，`src-tauri/src/lib.rs:379`）：

| 开关 | 默认值 |
| --- | --- |
| `autonomousWalking` / `reducedMotion` | `false` / `false` |
| `hoverPause` | `true` |
| `renderer` / `live2dAppearance` | `sprite` / `"hiyori"` |
| `eventReactions` / `eventBubbles` / `eventBubbleTtlMs` | `true` / `true` / `4000` |
| `idleSelfPlay` / `idleThresholdMs` / `idleActionFrequencyMs` | `true` / `45000` / `30000` |
| `clickActionMode` / `clickActionPool` | `random` / waving,jumping,waiting,running,review |
| `petStoragePreset` | `codex-custom` |

**出站面**：

- `src-tauri/Cargo.toml` 依赖只有 serde / serde_json / tauri / dialog / process / single-instance / toml / url —— **没有任何 HTTP 客户端**（无 reqwest/hyper），Rust 侧不具备对外发请求的能力。
- CSP `connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* http://localhost:* ws://127.0.0.1:15373` —— WebView 侧也被限制在本机回环，外网不可达。
- `/api/status` 快照逐字段核对：只有宠物目录、外观/行为设置、能力声明、产品身份、空 `recentEvents`。**无凭据、无 OCR、无记忆内容**。
- **登记一项（非缺陷）**：`petStorage` 字段会带出本机绝对路径（如 `C:\Users\<用户>\.codex\pets`）。仅回环可读、消费者是 Aiki，可接受；若要暴露到回环以外需另行评估。

**诊断日志**：

- 应用目录只有 `%APPDATA%\dev.aiki.petshell\data\settings.toml`（625 B，内容为宠物设置，无凭据、无自定义路径）；`%LOCALAPPDATA%` 下只有 WebView2 运行时缓存。
- **不产生任何应用日志文件**（无 `*.log`/`*.txt`）。
- **令牌泄漏扫描**：对应用目录全量文本扫描 `PET_SHELL_EXIT_TOKEN` 的实际取值，**0 命中**。

## 6. AC-A：双表现复验 — PARTIAL

| 项 | 结果 |
| --- | --- |
| sprite 真实可见表现 | **PASS**：副屏 `340x296` 窗口可见，角色正常渲染并播放待机动画；截图见 §4.2 三张证据 |
| 四端点 | **PASS（本轮在 release 产物上逐项复测，见 §6.2）**：成功 / 未知 / 错误 / TTL 四类语义均与 PET-01 冻结口径一致 |
| **Live2D 真实可见表现** | **见 §6.1** |
| PET-07 适用 AC 逐项 | **NOT RUN**（未逐条重排） |

### 6.1 Live2D 在 release 产物上的可见表现 — PASS（像素证据）

本轮在 **release 产物**（MSI 同一份 exe）上把外观切到 Live2D 实测：

| 项 | 结果 |
| --- | --- |
| 启动到可服务 | **748 ms** |
| `/api/status` 回读 | `renderer=live2d`、`live2dAppearance=hiyori`、`petVisible=true` |
| 驻留内存 | 32 MB（sprite）→ **37 MB**（Live2D），与加载 Pixi + 模型 + 贴图一致 |
| 屏幕可见 | Hiyori 模型正常绘制；同帧中文气泡正确（含自动换行） |
| 像素证据 | [`MVP-13_live2d_hiyori.png`](evidence/MVP-13_live2d_hiyori.png) |

**同一构建上同时暴露的失败项**：该实例拖动/点击全部失效，见 §2.2 DEF-2。可见表现与可交互性是两条独立验收项，本条只判前者。

整模型换装与经右键菜单的切换仍以 [MVP-11](MVP-11_ACCEPTANCE.md) 的真机 WebDriver 证据为准（同一 pet-shell commit `6ac67cc`）；本轮未重复驱动菜单路径。

### 6.2 四端点在 release 产物上的逐项复测

容器就绪、`renderer=live2d` 的同一实例上执行（2026-09-16）：

| 用例 | 结果 | 与 PET-01 冻结口径 |
| --- | --- | --- |
| `GET /api/status` | 200，字段见 §1 | 一致 |
| `POST /api/say {"text":"ttl probe","ttlMs":1500}` | 200；t=0、t=1s 仍有 `bubbleText`，**t=2.5s 已置空** | TTL 生效，一致 |
| `POST /api/action {"animationId":"waving"}` | 200 | 一致 |
| `POST /api/event {"type":"reviewing"}` | 200，`recentEvents` 增长、动作映射为 `review` | 一致 |
| `POST /api/event {"type":"bogus"}` | **400**，`unknown variant \`bogus\`, expected one of \`thinking\`, \`tool-running\`, \`reviewing\`, \`success\`, \`failure\`, \`attention\`` | **错误体与 fixture 逐字一致** |
| `POST /api/action {"animationId":"not-a-real-action"}` | **200**，该字符串被原样写进 `lastAction` | 一致（见下） |
| `GET /api/nope` | 404 `{"error":"route not found","ok":false}` | 逐字一致 |
| `GET /api/say`（方法错误） | 404 | 一致（PET-01 口径：404/405/415 归 incompatible） |
| `POST /api/import/website` | 404 `{"error":"route not found","ok":false}` | 剪枝保持，一致 |
| `GET /api/pets/<内置宠物>/spritesheet` | 404 | 一致（内置宠物走内嵌资源 `/pets/<id>/spritesheet.webp`，不经 API） |
| `GET /api/pets/<导入宠物>/spritesheet` | 首建产物上 **404** → **同一口径下定位为 §2.3 DEF-3；修复后复测 200（字节数与磁盘一致）** | 修复前不一致，修复后一致 |

关于「未知 `animationId` 返回 200」：这是 **PET-01 已冻结的上游语义**，[PET-01 §4](../../frontend/reports/PET-01_PROTOCOL.md) 原文即「上游不校验 `animationId`，实测 `{"animationId":"backflip"}` 返回 200 并把 `backflip` 原样写进 `lastAction`」。因此**不判为漂移**；「不靠乱发动作猜能力」也就仍然是 Aiki 侧白名单的责任，不是 shell 的义务。

## 7. AC-F：安装 / 卸载 — NOT RUN

需明确授权的环境，且不得操作用户日用系统；本轮未执行。与 INT-03 只复用同一产物与环境的适用证据，不重复跑无变化的全门禁。

## 8. 取证方法学注记（给下一次验收）

1. **JSON 请求体不能带 BOM**。用 PowerShell `Out-File -Encoding utf8` 写的临时文件在 5.1 下带 `EF BB BF`，服务端**正确判 400**；本轮一度因此拍出「无气泡」的截图。写探针请用 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`。
2. **PowerShell `Invoke-WebRequest` 在全新进程里的首个请求有 ~400 ms 开销**，会假装成服务端毛刺。需要真值时用 `curl.exe`，或在同进程内先预热一次。
3. **`Get-NetTCPConnection -State Listen` 在本机返回空表**（含 37 条实际存在的回环监听），端口/进程归属请用 `netstat -ano`。
4. **`public/` 目录的打包语义**：gitignore ≠ 不进分发包。任何「素材不入包」的声明都必须以**产物检查**（路径字符串扫描或解包）为准。
5. **`WindowFromPoint` + `WS_EX_TRANSPARENT` 不能用来判定这个窗口是否可交互**：在 `sprite`（人工确认可拖）实例上同样读到 `WS_EX_TRANSPARENT=1`、且 `WindowFromPoint` 一律返回背后的窗口。该探针本轮**未采信**——窗口可交互性以人工操作为准。

## 9. AC-G：三线裁决

| 线 | 裁决 |
| --- | --- |
| **模块完成** | MVP-07/08/10/11 已 PASS；MVP-09 PARTIAL（屏幕可见层）；**MVP-13 本份 PARTIAL**（AC-A/B/C 部分、E 部分、F 未跑）。三个缺陷 **DEF-1 / DEF-2 / DEF-3 已全部处置**：DEF-2、DEF-3 在本份内修复复验，DEF-1 由 [MVP-14](MVP-14_ACCEPTANCE.md) 修复并验收 |
| **0.6 产品 DoD** | **未达成**。缺：经菜单的 sprite↔Live2D 切换、`attach`、断连恢复、安装/卸载、FPS 侧证据；且 DEF-1 未处置。（本轮已补齐 Live2D 在 release 产物的可见证据，并修复了 DEF-2 交互缺陷） |
| **发行就绪** | **未达成，但不再被 DEF-1 阻塞**（模型已移出分发包）。剩余：AC-F 安装/卸载未验、Cubism Core 自身分发条件未核查、`attach`/断连恢复未验 |

**仍需人工/授权环境**（不因本报告自动关闭）：安装/卸载回归（AC-F）、PET-07 逐条复验、`attach` 与断连恢复、经菜单的 sprite↔Live2D 切换、FPS/交互侧性能采样。

## 10. 未覆盖与阻塞

| 项 | 状态 |
| --- | --- |
| DEF-1 Live2D 素材进包 | **已修复并验收**（[MVP-14](MVP-14_ACCEPTANCE.md)）：官方示例模型移出分发包，Core 留包内，CSP 未放宽 |
| DEF-2 整窗鼠标穿透 | **已修复并人工复验通过**（`a3d1d26` + 重建产物）；右键菜单/点击走同一输入路径，未单独复验 |
| DEF-3 导入宠物贴图 URL 取不到 | **已修复并真机复验**（`34acf78` + 重建产物 `D9E1CB67…`）：广告的 URL 返回 200 且字节数与磁盘一致；两种非身份形态仍 404 |
| AC-F 安装/卸载 | NOT RUN，需授权环境 |
| Live2D release 可见表现 | **已取**，见 §6.1（像素证据） |
| `attach` / 断连恢复 | NOT RUN，需 Aiki 侧联动 |
| FPS / 交互侧性能 | NOT RUN |
| 0.5 欠账（Voice 闭环、FE-33、宿主偶发退出） | 保持原状态，不随本份通过自动关闭 |
