# NEXT-00 Windows 基线（BASELINE）

状态：AUTO_PASS（2026-09-19）。执行目录 `F:/AIVoice/Aika-Next`，分支 `aika-next`。

## 1. 固定点位（AC 00-A）

| 项 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/phoiex/AAAAGENT.git |
| 获取方式 | 克隆到同级只读参考副本 `F:/AIVoice/AAAAGENT-Upstream`（2026-09-19，main HEAD），再以本地 remote `aaaagent-upstream` fetch 入本仓库（先核实无同名 remote，原仅 `origin`→iwwater/Aika） |
| 固定上游 SHA | `ba79db152c14d4a0d4b3488cfd11be7abbfecc23`（main HEAD，不以移动引用为基线；另含 tag `demo-video-20260917`、分支 `fix/windows-runner-acl`，均未采用） |
| 文档种子 `DOCS_SEED_COMMIT` | `75df0a4520917a5b59c688f1a0a41f3343218a1c`（orphan 初始提交） |
| Legacy commit | `30269c6d7abafbf1a65752af67b9f152757e51cc`（`F:/AIVoice/Aika` HEAD，只读，工作树未触碰） |
| 导入合并提交 | `565cd80` — `git merge --allow-unrelated-histories --no-commit ba79db1`，自动合并无冲突，880 文件 / +85197 行；双父 `75df0a4` + `ba79db1`，`git log --graph` 可追溯上游全部历史 |
| 保留策略 | 根 `AGENTS.md` 与 `docs/next/**`（16 文件）完整保留；上游树落于 `windows/`、`code/`、`docs/`、`tools/`、`assets/`、根 README/CHANGELOG 等；上游无 `AGENTS.md`、无 `docs/next`，无路径冲突，未使用 ours/theirs 批量策略 |
| 许可证 | 上游 `LICENSE`＝AAAAGENT 非商业使用及署名许可 1.0（仓库根，已随合并保留）；`third-party/`（dijkstrajs、openclaw-weixin、pngjs、qrcode、silk-wasm LICENSE）随源码保留；Cubism SDK 与示例模型许可证见 §5 |

## 2. 本机环境与依赖（AC 00-B 输入）

| 项 | 值 |
| --- | --- |
| OS | Windows 11 x64（NT 10.0.26200） |
| Node / npm / pnpm | v24.18.0 / 11.16.0 / 11.22.0（bun 无）；上游 CI 用 Node 24，package engines `>=22.12.0` |
| lockfile | `windows/code/desktop-pet/package-lock.json`（npm） |
| 关键依赖 | electron 44.4.1、typescript 5.9.3、esbuild 0.28.2、better-sqlite3 12.11.1、sherpa-onnx-node 1.13.8、silk-wasm 3.7.1、pinyin-pro 3.29.4、qrcode 1.5.4；`allowScripts` 允许 better-sqlite3/esbuild/electron 安装脚本 |
| Windows 与 macOS 分离 | 仅构建/测试 `windows/` 树；macOS 树 `code/` 仅随源码导入，未安装依赖、未构建、产物零混用 |

## 3. 基线命令与结果（cwd `windows/code/desktop-pet/`，2026-09-19 实跑）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npm ci` | added 90 packages（约 10s） | 0 |
| `npm run check`（tsc --noEmit） | 无输出即通过 | 0 |
| `npm run test:windows`（build + windows 组） | 22 tests / 22 pass / 0 fail（含真实 Windows ACL、路径逃逸、NDJSON UTF-8 切割、trial 启动指纹；launch 测试期间自动下载 Electron 二进制） | 0 |
| `npm run test:release`（build + release 组） | 138 tests / 138 pass / 0 fail（二次复跑并捕获真实退出码确认） | 0 |
| `npm run build:windows` | **首跑 FAIL**：`build:desktop` esbuild 8 errors——缺用户自备 Cubism Framework/本地模型（原始输出存 `reports/evidence/next00-build-fail-original.log`）。按用户指示补齐官方 SDK 与示例模型后复跑：build + build:desktop + build:wake + build:native 全过 | 0（补资产后） |
| `npm run test:windows:ui`（build + build:desktop + `--smoke-test`） | `WINDOWS_SMOKE_OK: Live2D renderer, isolated preload, backend round trip, panel layout.`，自动启动→就绪→文本往返→`app.quit()` 自动退出；无麦克风输入 | 0 |

上游 CI 参照（`windows/.github/workflows/windows.yml`）：`npm ci` → `node node_modules/electron/install.js` → `test:windows` → `test:release`。本基线覆盖该集合并额外完成 build 与 UI 冒烟。

## 4. 冒烟降级证据（AC 00-C）

- 缺模型资产时（仅 example presets）：进程启动，渲染层显式报 `model-error`／`模型文件加载失败：pet.model3.json`，冒烟未就绪并打印明确错误——降级可见、非静默。
- 放入真实模型后：渲染器、隔离 preload、离线后端往返（`Offline preview received`）、面板布局全部通过；Electron userData 为独立 `%APPDATA%/AAAAGENT/smoke-test`，无个人数据。
- 已知怪癖：冒烟断言失败时进程仍 exit 0（上游未覆盖失败路径，见 SOURCE_MAP §4）；故 NEXT-08 验收包以 `WINDOWS_SMOKE_OK` 文本 + 退出码双判据。

## 5. 用户自备渲染资产（gitignored，不入库）

| 资产 | 来源与许可 | 放置 |
| --- | --- | --- |
| Cubism SDK for Web **5-r.5** | 官方直链 `https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip`（经官方页 download.js 核实；20.7MB，2026-09-19 下载），Cubism 专有许可 | `desktop/vendor/cubism/Core`+`Framework`，SDK `LICENSE.md`/`NOTICE.md`/`cubism-info.yml` 一并保留于 vendor/cubism/ |
| Live2D 官方示例模型 **Natori**（runtime 包） | 官方 `https://cubism.live2d.com/sample-data/bin/natori/natori_en.zip`，Live2D 免费素材许可（配合 Cubism SDK 使用） | `desktop/assets/local-model/`，入口改名 `pet.model3.json`；`node tools/configure-model.mjs` 生成指纹绑定目录 `presets.json`（fingerprint `bcd3101b…`，条目全部 disabled，等真实角色适配） |
| 淘汰记录 | Hiyori free 无 `FileReferences.Expressions`（configure-model 硬性要求）；Mao 的 Idle 动作引用模型不存在的参数（`ParamRabbitEliminationEffect`/`Param5`），被上游适配器拒绝——均如实记录未采用 | — |

以上路径均被上游 `.gitignore`（`**/desktop/vendor/`、`**/desktop/assets/local-model/`、`*.moc3`、`*.model3.json` 等）覆盖，`git check-ignore` 已验证；参数映射用仓库默认 `desktop/config/parameter-map.json`（标准 `ParamAngleX/Y/Z`、`ParamMouthForm`，与 Natori 匹配）。

## 6. 数据目录与隔离（供 NEXT-02）

- 桌面端：`main.mjs` `app.setPath('userData', %APPDATA%/AAAAGENT/{desktop|preview|smoke-test})`。
- 后端端：`PET_DATABASE`（SQLite 路径）+ `PET_PROJECT_ROOT`；trial 约定 `<projectRoot>/.local/data/companion.sqlite`，评估/预算产物在 `.local/model-evaluation/`。
- 改 Next 独立命名空间 = 上述三处的集中改动点，实现与验收在 NEXT-02。

## 7. AC 00-E 核查

- 文档种子仍在：`docs/next` 16 文件、`AGENTS.md` 在合并提交中保留（`git ls-tree` 核实）。
- 无 Legacy 工作树变更：全程只读 `F:/AIVoice/Aika`，HEAD 仍为 `30269c6`。
- 无旧用户数据/密钥导入：`git ls-files` 敏感名扫描（`.env|secret|credential|api[-_]key|.local/|.key|.pem`）仅命中上游凭据*代码*与 `*.example` 配置，无任何密钥文件；参考副本与上游克隆均不写入本分支。
- 无 macOS 构建产物混入（§2）。
