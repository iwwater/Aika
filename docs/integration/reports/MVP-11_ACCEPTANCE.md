# MVP-11 验收报告 · Live2D 与首版换装

日期：2026-09-16。SPEC：[MVP-11](../specs/MVP-11.md)。依据：[RPD v1.2](../../RPD_MVP_0.6.md) MVP-R11、[SPEC 索引](../SPEC_MVP_0.6.md)。前置：[MVP-07](MVP-07_ACCEPTANCE.md)（Live2D 技术条件通过）、[MVP-10](MVP-10_ACCEPTANCE.md)（插件槽 PASS）。

## 状态摘要

| AC | 结论 | 证据等级 |
| --- | --- | --- |
| A | **PASS**（依赖/来源/映射）／**NOT RUN**（真机 Windows 目视） | 源码 + 真实资产 device 采样 |
| B | **PASS** | 单元测试 + E2E |
| C | **PASS** | 单元测试 + E2E（两套真实模型换装） |
| D | **PASS** | 单元测试 + E2E |
| E | **PASS** | 单元测试 |
| F | **PASS**（fixture 与 browser device）／**NOT RUN**（Windows Tauri device） | 单元测试 + browser E2E |

本轮冻结的换装方式是**整模型切换**：一套外观 = 一个 Cubism 模型。未采用同模型部件换装，因此没有部件/参数契约需要登记。渲染出口切换（sprite↔Live2D）与换装是两件事，报告中分别标注，不互相冒充。

## 1. 交付范围

| 文件 | 作用 |
| --- | --- |
| `src/plugins/renderers/live2d/catalog.ts` | 外观目录、依赖版本来源、动作映射声明 |
| `src/plugins/renderers/live2d/manifest.ts` | model3.json 解析 + 「这个动作能不能播」的判定 |
| `src/plugins/renderers/live2d/coreLoader.ts` | Cubism Core 脚本加载（幂等、失败可重试、允许多次尝试） |
| `src/plugins/renderers/live2dRenderer.ts` | `PetRendererPlugin` 的 Live2D 实现 |
| `src/plugins/renderers/bubbleView.ts` | sprite / Live2D 共用气泡视图（抽出来避免两份实现漂移） |
| `scripts/fetch-live2d-assets.mjs` | 资产获取（递归解析 model3.json 依赖） |

改动：`src/plugins/types.ts`（`AppearanceOption`、`MenuContext.appearances`、`PetRendererPlugin.diagnostics?()`）、`src/plugins/rendererHost.ts`（`getDiagnostics()`）、`src/plugins/menus/defaultMenu.ts`（换装条目）、`src/pet/settings.ts`、`src/pet/animation.ts`、`src/plugins/renderers/spriteRenderer.ts`、`src/PetWindow.tsx`、`src/SettingsPage.tsx`、`src/styles.css`、`src-tauri/src/lib.rs`、`e2e/openpet-browser.spec.ts`、`.gitignore`。

## 2. AC-A：依赖、模型来源与映射 — PASS（真机目视 NOT RUN）

固定版本（`package.json`，均锁定到具体版本而非范围）：

| 依赖 | 版本 |
| --- | --- |
| `pixi.js` | `8.20.1` |
| `untitled-pixi-live2d-engine` | `1.3.5` |
| Cubism Core | `live2dcubismcore.min.js`（运行时实测 `Live2D Cubism SDK Core Version 5.1.0`） |

模型来源与分发条件：`Hiyori`、`Mao` 取自 Live2D 官方示例仓库 `Live2D/CubismWebSamples`，Core 取自 `cubism.live2d.com` 官方 SDK 分发地址。两者都是**授权素材，不入仓库、不进分发包**：`scripts/fetch-live2d-assets.mjs` 显式下载到 `public/live2d/`，该路径已加入 `.gitignore`（`git check-ignore public/live2d/…` 命中）。此边界沿用 MVP-07 AC-C 的个人使用构建前提。

动作映射（`catalog.ts` 声明，语义由人工选定）：

| 运行期动作 | Hiyori（Idle 9 段 / TapBody 1 段 / 无表情） | Mao（Idle 2 段 / TapBody 6 段 / exp_01–08） |
| --- | --- | --- |
| `idle`（姿态） | Idle #0 | Idle #0 |
| `waiting` | Idle #1 | Idle #1 |
| `jumping` | Idle #2 | TapBody #1 |
| `running` | Idle #3 | TapBody #2 |
| `review` | Idle #4 | TapBody #3 |
| `failed` | Idle #5 | expression `exp_02` |
| `waving` | TapBody #0 | TapBody #0 |

**如实声明边界**：本表只保证「所声明的 group/index/表情在对应 manifest 里确实存在」。存在性由 `resolveLive2dAction` 用 manifest 判定（单测覆盖）；「每段 motion 的表演是否贴合语义」是人工挑选，不是被验证过的结论。Mao 的 `failed` 故意走表情路径，用来证明表情与 motion 受同一套校验、也同样会确定降级。

真机目视状态：**NOT RUN**。本轮没有可用的驱动链路——`cargo tauri-driver` 未安装，`src-tauri/target/` 无热构建，跑一次真实窗口需要先装驱动并做全量 Rust 构建。可复现命令见第 8 节。已完成的 device 级证据是浏览器模式（Chromium）+ **真实模型资产**下的渲染采样：`node probe/live2d/debug-pet-live2d.mjs` 直接 `readPixels` 默认帧缓冲，输出两套外观的 alpha 分布，并用 `glCorner/glCenter` 断言「画布背景透明、角色居中绘制」。

## 3. AC-B：唯一出口、确定降级、不假装播放 — PASS

- 四端点经 `PetWindow` 转发给当前活跃 renderer，Rust 侧四端点在本次改动中**一行未动**（`src-tauri/src/http_api.rs` 不在本次改动范围）。未新增任何 LLM 调用。
- 「能不能播」在调用前判定，不从引擎的返回值推断。`resolveLive2dAction` 用 manifest 判定 group 是否存在、index 是否在范围内、表情名是否在清单里；判定失败时不向引擎发任何调用，计 `refused`，`action()` 返回 `false`。
- 判定成功也会二次确认：`model.motion()` / `model.expression()` 返回 `false` 时计 `playbackFailures`，不当成已播放。
- 姿态与动作分离：Live2D 只有「待机」一种姿态，`pose('idle')` 返回 true（模型自带 Idle 会持续播放，重复下发只会每 120 ms 打断一次动画），方向类姿态明确返回 `false`——不假装 Live2D 会走路。
- `PET_POSE_ANIMATION_IDS` 提取到 `src/pet/animation.ts` 共享，sprite 与 Live2D 对「姿态」的理解不再各写一份。

## 4. AC-C：两套外观换装、先验证后提交 — PASS

- 菜单换装条目的**存在与否来自 renderer 的能力声明**（`capabilities().costumes`），菜单不 import 任何具体模型；条目列表由宿主从槽位取 `AppearanceOption` 传入。sprite 出口下不出现换装条目（单测断言仅 4 项）。
- 切换顺序是「加载新外观 → 校验 → 提交」，不是「先改配置再祈祷」：`fetch manifest` 与 `Live2DModel.from()` 都在提交之前完成，失败则保留旧外观并计 `failedSwitches`，不污染 `settings`。
- 加载中有状态：`data-loading-appearance` 属性 + `loadingAppearance` 诊断字段，不承诺零耗时。
- 未知外观 id 走同一条降级路径（`getLive2dAppearance` 返回 null → 记账、保留旧外观）；配置里的未知 id 在初始挂载时回退到目录第一项，坏配置不会让桌宠起不来。

## 5. AC-D：单一输出、释放与 generation — PASS

- 任一时刻只有一个 renderer 实例在输出，且只有一个 canvas：换装是 `root.replaceChildren(newCanvas)` 的原子替换。
- 每次都**整体重建舞台**（Pixi Application + canvas），而不是在旧舞台里换模型。这不是偏好，是实测结论：这个引擎的模型贴图与渲染器共享，逐个 `destroy` 旧模型/旧贴图会把后续渲染一起弄坏——新模型位置尺寸都对、却一帧都画不出来，且新模型的贴图会被报成已销毁（见第 7 节第 6 条）。整体重建同时满足「释放旧贴图/模型/渲染循环」与「换装后仍然渲染」。
- 旧舞台在提交后释放，且 `sharedTicker: false` 让每个舞台持有自己的 ticker，销毁旧舞台不会连带销毁新舞台正在用的 ticker。
- generation：每次挂载自增，在途加载返回时若已过期，新舞台连同模型一起销毁、计 `discardedLoads`，不覆盖当前选择。
- `deactivate()` 停 ticker 并隐藏根节点；`dispose()` 销毁整个舞台（模型、贴图、渲染循环与 GL 上下文一起回收）并移除 DOM、解绑 hit target，幂等。

## 6. AC-E：可恢复策略与配置不被污染 — PASS

| 场景 | 行为 |
| --- | --- |
| Core 脚本加载失败 | 允许多次尝试（不缓存 rejected promise），失败不残留 `script` 标签；prepare 抛错 → 宿主降级 |
| 模型/贴图 404 或解析失败 | 新舞台连同模型一起销毁，保留旧外观，计 `failedSwitches` |
| manifest 是坏 JSON / 缺字段 | `parseLive2dManifest` 返回 null（不抛错），动作全部不可播但模型仍能加载 |
| 未知换装项 | 同上，保留旧外观 |
| 旧 generation 加载成功 | 丢弃（`discardedLoads`），不覆盖当前选择 |
| 旧舞台释放抛错 | 单独计 `stageReleaseFailures` + `lastReleaseError`，**不**把一次成功的换装记成失败 |
| 能力/profile | 由 renderer 的 `capabilities()` 实时报出，随最终成功选择更新 |

## 7. 测试发现的真实缺陷（已修）

本节是本 SPEC 最有价值的部分。以下七条都不是「测试写错」，而是缺陷——多数只有把真实模型跑起来、把像素读出来才会暴露。

1. **缩放反馈回路。** `refit` 用 `model.width` 算缩放，而 `Container.width` 已经把当前 scale 算进去了——上一轮的缩放喂进下一轮，模型被逐步放大到铺满整块画布。症状是整帧不透明（`glCorner` 采样到奶油色）。修复：量测前先 `scale.set(1)` 归一，再用可绘制范围算贴合（内部画布含留白，按它缩放会明显偏小）。
2. **换装注册竞态。** 切换判据用的是「我上次设过什么」的本地 ref。设置是异步到的（先渲染 fallback，再拿运行期快照），快照先到时这个 ref 会把切换锁死：设置里写着 live2d，活跃的却一直是 sprite。修复：以**宿主真实的活跃 renderer** 为准，并加「同一目标只尝试一次」的重试防护。
3. **`hidden` 语义失效。** `.pet-sprite { display: block }` 这类类选择器压过了 UA 的 `[hidden] { display: none }`，于是 MVP-10 承诺的「prepare 阶段不得产生可见输出」和「deactivate 让出输出」其实一直没生效——准备完但未激活的渲染器仍留在画面上。修复：显式补 `.pet-sprite[hidden], .pet-live2d[hidden] { display: none }`。这条由 E2E 的「`toBeVisible` 通过了但 canvas 还不存在」暴露。
4. **换装菜单项不重建。** 菜单依赖 `slotStatus`，而成功换装是 ready→ready，状态不变 → 菜单不重建 → 换装入口一直缺失。修复：单独跟踪活跃 renderer id 作为依赖。
5. **上下文菜单末尾条目点不到。** 定位用一个写死的 `CONTEXT_MENU_HEIGHT` 估算，条目变多（本次新增外观项）后末尾落到视口外：元素存在、可见，但不可点。修复：改为按**实测**尺寸收敛定位，并给菜单加上限高与滚动。
6. **换装后一帧都画不出来（引擎共享贴图）。** 逐个 `model.destroy()` 或只 `texture.destroy()` 都会破坏后续渲染；实测每次换装后新模型 `textures[*].destroyed` 为 `true`。修复：改为整体重建舞台（见 AC-D）。这一条把「释放旧纹理」与「换装后仍要渲染」的冲突摆到了台面上——只满足前者的实现是坏的。
7. **旧舞台销毁抛 `reading 'next'`。** 舞台销毁会改动 ticker 的监听链表，而换装发生在渲染回调链上；同拍内改链表会抛错，并且这个错误会把一次**成功**的换装记成失败。修复：释放延后一拍执行，并把它移出提交判定范围，单独记账。

另外一处不是缺陷但值得登记：E2E 读像素**必须**用 `readPixels` 而不是 `drawImage` 到 2D 画布。在带 CSS filter 的合成上下文里后者会回来不透明结果（整帧 alpha=255），把「模型画好了、背景也透明」误判成「整块不透明」。

## 8. 测试命令与结果

```text
pnpm exec tsc --noEmit                          0 error
pnpm exec vitest run                            2 files / 28 passed / 0 failed
cargo test --manifest-path src-tauri/Cargo.toml 13 passed / 0 failed
pnpm e2e（Playwright/Chromium）                  4 passed（含新增 live2d 用例）
node probe/live2d/debug-pet-live2d.mjs          两套外观 alpha 采样：背景透明、角色居中绘制
```

新增单测 9 条（`src/plugins/renderers/live2d/manifest.test.ts`）：manifest 解析（含坏输入返回 null）、未知 group、index 越界/负数/非整数、表情名不存在、缺 manifest、两套外观的声明映射在其 manifest 上**全部可播**、目录不声明运行期动作/姿态之外的 id。最后两条是防漂移的闸门：目录写错一个 index，测试立刻失败。

新增 E2E 用例在真实资产下断言：`.pet-live2d` 可见且 canvas 有真实像素（`readPixels` 采样，含透明背景占多数的断言）、`capabilities().costumes === true`、可播清单恰为 7 项（来自 manifest）、菜单出现且恰为 6 项、切到 Mao 后 `diagnostics.appearance === 'mao'`、`switched ≥ 1` 且 `failedSwitches === 0`、Mao 的表情清单为 8 项、换装后像素指纹与 Hiyori 不同、`.pet-live2d` 与 `.pet-sprite` 各只在场一个。

真机（Windows Tauri 窗口）验证**未执行**，命令如下，需要先补驱动与构建：

```powershell
cargo install tauri-driver --locked   # 当前环境未安装
pnpm e2e:tauri                        # e2e-tauri/specs/pet-window.e2e.mjs
```

## 9. 共享接口影响

- 四端点及其请求/响应/错误语义**未改动**；`docs/frontend/DESKTOP_PET_CONTRACT.md` 未修改，无需双仓同轮修订。Aiki 下发换装命令不在本次范围，未偷偷扩展端点语义。
- `PetSettings` 新增两个字段（`renderer`、`live2dAppearance`），Rust 侧 `serde(default)`，旧 `settings.toml` 缺字段时取默认值（sprite / hiyori），不会读失败。`renderer` 是**封闭枚举**，未知取值在反序列化阶段就被拒，不会静默退化成 sprite。
- 外观 id 在 Rust 侧只做安全字符串归一化；「这个外观是否存在」由 renderer 依据自己的目录判定——同一份清单不在两端各写一遍，避免漂移。
- PetShell 内新增前端契约（`AppearanceOption`、`PetRendererPlugin.diagnostics?()`、`RendererHost.getDiagnostics()`）只服务于内部槽位与验收，不对外暴露、不进入 HTTP 载荷。
- 素材许可边界未变：`public/live2d/` 被 gitignore，`probe/live2d/assets/` 同理。

## 10. 未覆盖与后续

| 项 | 状态 |
| --- | --- |
| 真机 Windows 窗口下的模型目视与动作/换装确认 | **NOT RUN**（缺 `tauri-driver` 与热构建，见第 8 节） |
| 每段 motion / 表情的表演是否贴合语义 | 人工挑选，未验证；本报告只声明存在性已校验 |
| Aiki 下发换装命令 | 不在默认范围 |
| 口型、物理参数细调 | 不在本次范围 |
| 性能（帧率、CPU、首帧耗时） | 归 MVP-13；本次只保证「加载中有状态，不承诺零耗时」 |
| Mao 的 `fitScale: 1.8` | **人眼校准**的取景参数，不是测量值；换模型需重新校准 |

模块自测通过不等于审阅批准，也不等于 0.6 产品完成。
