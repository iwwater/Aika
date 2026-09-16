# MVP-14 · Live2D 素材的分发边界（DRAFT）

状态：**草案，未派发**。依据：[MVP-13 报告](../reports/MVP-13_ACCEPTANCE.md) §2.1 的 **DEF-1**。范围：shell 源码（**2026-09-17 起位于 Aika 仓库 `pet-shell` 分支**，原 `f:/AIVoice/pet-shell`）的构建打包与资产加载路径；不重写 renderer、不改 Live2D 渲染逻辑。

## 1. 问题（已取证的现状）

| 事实 | 值 |
| --- | --- |
| `public/live2d/` 文件数与体积 | **41 文件 / 9,452,786 B** |
| 构建后 `dist/live2d/` | 逐字节同源（vite 的 `public/` 语义就是原样复制） |
| `petshell.exe` 内可读出的 `/live2d/…` 路径 | **41 条**，与磁盘一一对应 |
| 嵌入内容 | `live2dcubismcore.min.js`、`Hiyori.moc3` + 贴图/motion、`Mao.moc3` + 贴图/motion/expression |
| 体积占比 | 模型 9.0 MB / exe 20.4 MB ≈ **44%**；MSI 13,475,840 B |

`DAILY_2026-09-16.md` 曾记「模型…**不进分发包**」。该声明对 git 成立（`public/live2d/` 已 gitignore），**对打包不成立**——所以这不是「文档说错了」，而是「打包路径没有对应的约束」。

影响：AC-E 要求的「按目标用途登记包内容与模型授权」无法给出「不含第三方模型」的结论；一旦对外分发，即构成分发 Live2D 官方示例模型。**当前阻塞对外发行**（自用不受影响）。

## 2. 目标与非目标

**目标**：让 release 产物**不再包含 Live2D 官方示例模型**，同时保证 Live2D 功能仍可用（资产由使用者按登记来源放置），并且缺失资产时**可见降级而不是静默失败**。

**非目标**：
- 不重写 renderer、不改换装语义（MVP-11 的行为保持不变）；
- 不做「模型商店 / 下载器」——若需要，单独立项；
- **不对 Cubism SDK 的分发条件作法律结论**。本 SPEC 只处理「示例模型不进包」；Cubism Core 若继续随包，其分发条件仍须在对外发行前单独核查（MVP-13 AC-E 的原有要求）。

## 3. 约束

1. **CSP 不放宽是默认立场**。当前 `script-src 'self' 'unsafe-inline'`；Cubism Core 现在正是靠同源脚本路径加载。任何放宽都要在本 SPEC 里单独列明理由。
2. **离线可用**：自用场景不引入「必须联网才能用 Live2D」。
3. **dev/E2E 便利不破坏**：MVP-11 的 `e2e:tauri` 真机用例仍能跑 Live2D。
4. **来源可追溯**：资产由 `scripts/fetch-live2d-assets.mjs` 获取，不入 git（维持现有 `.gitignore`）。

## 4. 选项

| 选项 | 做法 | 代价 |
| --- | --- | --- |
| **A（推荐）只把「示例模型」移出 bundle** | 模型改从本地资产目录加载；`live2dcubismcore.min.js` 保留在包内（它是 SDK 运行时，与示例模型是两套条款） | 需要一次资产放置步骤；前端加载路径要能读本地目录 |
| B 模型与 Core 都移出 | 同上，且 Core 也外置 | script-src 必须放宽（`asset:` 或 loopback），或改用其它注入方式；回归面更大 |
| C 维持现状 + 修正声明 | 不动代码：把「不入分发包」改成「release 包内含示例模型」，并把对外发行标为 BLOCKED | 零改动，但**发行阻塞不解**，且包体 44% 仍是第三方素材 |

B 的问题在于它为了一个「许可分类不同」的对象去动 CSP；C 不解决问题。**推荐 A**：它精确命中 DEF-1（示例模型），不碰 CSP，也不改变 renderer 的契约。

## 5. 推荐方案 A 的落地要点（待细化）

- **资产位置**：本地目录（候选：`%APPDATA%\dev.aiki.petshell\live2d\` 或现有 pet storage 目录），由 fetch 脚本或使用者放置；路径与哈希登记进交付说明。
- **加载路径**：前端需要能读到该目录 → 优先沿用 Tauri 既有能力；**若必须改 CSP 则回到选项 B 重新评估**（A 的验收含「CSP 未放宽」）。
- **缺失时的行为**：renderer `prepare()` 失败 → 按既有契约降级到 sprite，并在界面**明确提示缺少 Live2D 资产**（沿用 `slotMessage` / `.pet-slot-notice` 的既有通道），四端点输出不受影响。
- **构建期约束**：release 构建不得把 `public/live2d/models/**` 收进 `dist/`；dev 便利可以保留（需在 SPEC 里写清 dev 与 release 的差别，避免又一次「声明与产物不一致」）。

## 6. AC 草案

| AC | 验收与证据 |
| --- | --- |
| A | release 产物的二进制内嵌路径扫描**不再出现** `/live2d/models/…`；内置资源清单逐条列出，并与「哪些资产来自第三方」一一对应 |
| B | 前后体积量化：exe / MSI 的字节数与降幅，且降幅与移除的资产体积可对上 |
| C | 缺资产时：renderer 准备失败 → 降级到 sprite + **界面可见提示**（截图）；四端点仍全部 200 |
| D | 资产放置路径、来源、哈希登记在交付说明；模型仍不入 git |
| E | dev/E2E 不回归：`e2e:tauri` 的 Live2D 用例仍通过（或明确记录 dev 路径的变化） |
| F | **CSP 未放宽**（与当前 `tauri.conf.json` 逐字比对）；若放宽，本 SPEC 记为 FAIL 并回到选项 B 重议 |

## 7. 开放问题（派发前需定）

1. 资产目录放哪里（app-data / pet storage / 自定义）。
2. 是否需要应用内「安装模型包」入口，还是只靠 fetch 脚本（自用场景后者够用）。
3. dev 构建是否继续把模型留在 `dist/`（我倾向留，但必须在文档里写清 dev ≠ release）。
