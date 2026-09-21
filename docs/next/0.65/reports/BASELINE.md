# K65-00 固定交付基线（BASELINE）

状态：AUTO_PASS（2026-09-21）。执行目录 `F:/AIVoice/Aika-Next`，分支 `aika-next`，构建单元 `windows/code/desktop-pet/`。
逐 AC 证据见 [K65-00 报告](K65-00.md)；本文件按 [0.6 BASELINE](../../0.6/BASELINE.md) 的七节结构复用。

创建本文件时 **不修改** 任何生产代码，只新增 `tools/run-tests.mjs` 的 `next65` 分支、`package.json` 的 `test:next65` 脚本与 `tests/next65/`。

## 1. 固定点位（AC 00-A）

| 项 | 值 |
| --- | --- |
| 仓库 | `F:/AIVoice/Aika-Next`，分支 `aika-next` |
| Git HEAD | `d7c61d674374d760e57d18ebe2bf0b42c7e94c4b` |
| 修订性质 | **HEAD + 未提交工作树**。初冻结窗口 `2026-09-21T20:02:59+08:00` 时 `git status --porcelain` 为 **30 modified + 75 untracked = 105 条**；**再固化窗口 `2026-09-21T20:30:43+08:00`**（并行 worker 在初冻结后改动 4 个文件，见 §3 脚注）。这是"可复现快照"，不是发布提交 |
| 未提交保留 | 本步**未 commit / 未 push / 未 stash / 未 reset / 未 checkout**；其他 worker 的在途改动原样保留 |
| 0.61 自动收口证据 | `docs/next/0.61/reports/FIX61-10.md`（10-A/10-B/10-C 实测通过，10-D 为 `DEFERRED_TO_K65_11`）+ `docs/next/RUN_061_065.md` 续跑账本 |
| 前置判定 | 按 [EXECUTION_061_065.md](../../EXECUTION_061_065.md) §1 与根 AGENTS §5，**FIX61-10 自动 AC 通过即可进入 K65-00**，不要求 0.61 ACCEPTED。10-A/B/C 逐条核实为真实交付证据（见 K65-00 报告 §00-A），前置满足 |
| 人工后置项 | 0.61 侧 7 项体验清单（FIX61-10 §9）`DEFERRED_TO_K65_11`，本步**未代签、未标 ACCEPTED** |
| 冻结产物 hash | 见 §3 表；渲染包 `desktop/build/renderer.js` SHA256 `D29DC83E9405AB1B63632B5835A9BF75A5561B7D541E110B4A823AF7D03EAE7B`（722269 B） |
| 依赖锁 | `windows/code/desktop-pet/package-lock.json` SHA256 `E87ED8A1F190B58273039D7E856BE19110D1D847C7C3FA82636E8A09181EF19E`（55040 B），npm 单一 lock，无 workspaces |

**0.61 未修缺陷（本步未编辑）**：`desktop/electron/main.mjs` 的 `open_management` 曾用 `new URL(value.path, url)` 拼接，base 已带 `#token=…`，拼接**替换 hash 导致 token 丢失**。

> **执行期间状态变化（如实记录）**：该修复**在 K65-00 执行中被并行 FIX61-11 worker 落地**（`desktop/electron/main.mjs` 20:28:42、`tools/management-url.mjs` 20:28:38）。新实现新增 `managementTarget(session, route)`：校验同源后把 session fragment 与 route fragment 合并（token 在前），并把 `main.mjs` 的 `value.path` 正则改为 `/^\/(?!\/)[A-Za-z0-9._~\-/?#=&%]*$/` 以拒绝协议相对路由。**K65-00 未编辑这两个文件、未审阅该修复正确性、未重跑 `test:windows:ui`**，因此**不能声称锁定态已解除**；该验证属重冻结流程（`RUN_061_065.md` §6）。§3 表同时列出初值与再固化值。

## 2. 本机环境与依赖（AC 00-B 输入）

| 项 | 值 |
| --- | --- |
| OS | Windows（本机）；平台分支代码含 win32/darwin 两侧 |
| Node / npm | v24.9.0 / 11.16.0；`package.json` engines `>=22.12.0` |
| TS / 构建 | typescript 5.9.3、esbuild 0.28.2、electron 44.4.1 |
| 生产 native 依赖 | `better-sqlite3` 12.11.1、`sherpa-onnx-node` 1.13.8、`silk-wasm` 3.7.1、`pinyin-pro` 3.29.4、`qrcode` 1.5.4 |
| 构建结构 | **无 workspaces、无 project references、单一 tsconfig**（`rootDir: "."`, `outDir: "dist"`）。这是 0.65 拆包的第一道硬墙 |
| Electron 二进制 | 已安装（`tools/build-native.mjs` 仅 `access()` 校验，不产出安装包） |

## 3. 基线命令与结果（cwd `windows/code/desktop-pet/`，2026-09-21 实跑）

| 命令 | 退出码 | 计数 | 说明 |
| --- | --- | --- | --- |
| `npm run check` | 0 | tsc 无错误 | `tsc --noEmit` |
| `npm run build` | 0 | tsc + build-wechat | `npm run test:next65` 的前置 |
| `npm run test:next` | 0 | **80 pass / 0 fail / 0 skipped** | 0.6 契约组 |
| `npm run test:next61` | 0 | **143 pass / 0 fail / 0 skipped** | 0.61 修复组（41.4 s） |
| `npm run test:windows` | 0 | **22 pass / 0 fail / 0 skipped** | Windows 平台组（16.7 s） |
| `node --test dist/tests/media/*.test.js` | 0 | **63 pass / 0 fail** | media 组 |
| `npm run test:next65` | 0 | **21 pass / 0 fail / 0 skipped** | **本步新建**；含真实 CER 门槛，见 §4 |

### 冻结 hash（本次实测）

| 文件（相对 `windows/code/desktop-pet/`） | SHA256 | 字节 |
| --- | --- | --- |
| `app/trial-backend.ts` | `9290601E7209070D6011965FA988B01DC0C59B547B7CFA02469388EA5F770FC0` | 39629 |
| `app/trial-config.ts` | `173BDF93FF1070C9C4F6F00A29554EF7901B0DD35120DAEDA25EE6E94ADA2631` | 13180 |
| `app/backend-session.ts` | `C0E054B712D62754E42B48BF6857585537009E021F9821BF78BF0E53A8CE7F92` | 18422 |
| `core/turn-controller.ts` | `212BBF426D744C6511452862717239A5895692BF5C4A5E00496E5D5C3543DAA5` | 4031 |
| `core/dialogue-pipeline.ts` | `7F05DE667BAD428A30B541AA44A663215E078E79E27A0AA6CCF377CD6FEE8DA9` | 14175 |
| `core/desktop-runtime.ts` | `A62133BC73EA343A71B92525F2FA0FE3E563469FDC19BAD8513041211D7C2A00` | 8798 |
| `providers/slot-registry.ts` | `1015D42D2EBDDBAFD868DA4889080CD0C00FC865374F875E90FD0ED50AA3785A` | 6763 |
| `providers/transport.ts` | `D2C22116897306170F025D6EDD775D873B97DBE6A7427865ED5D46A497736A33` | 9939 |
| `providers/text-protocol.ts` | `C4DEFA67BBD52B35E7AE7548370FF8E2531EBBD0C93619E68CA4F1B822A01704` | 1116 |
| `providers/registered-voices.ts` | `4B6CAB21CC37EB7A8CB65A555CC0AAC3F22773582D16AE7EEFFF907EDA46EF09` | 7862 |
| `providers/sapi-tts.ts` | `1238B80C13FB195565CAC9AC2BCD46C8EF86C25DB7CA70E0A1B7435B2F1EF8F5` | 4510 |
| `providers/management-catalog.ts` | `7B66A1225D699FB25E2F8E298894985DEA14DC53A724CB34724643934D2EB0BF` | 15923 |
| `management/settings.ts` | `2DE8DFC70DEDF137038D0C90D327F5C7936C5D8474C7F4707249227FBCB24A27` | 15006 |
| `management/server.ts` | `EA04505AAE7586BDA16EF8A13CB6195CDD469FD47818E6BC612C8310726F96E7` | 17081 |
| `contracts/management.ts` | `EA364F4C1F8D016EDEB69E308448AF924B731F86C85DB1F45C1846E383ECD5BC` | 8377 |
| `contracts/desktop-bridge.ts` | `05748291E2598142652B5F94CCC551F1629BD49C97B2D9F34B409B2566784C89` | 5628 |
| `desktop/electron/main.mjs` | `862C4B0475161368D90CBC3BE5556EF4E4A0C82236625F4B125F98E2E816373B` | 15362 |
| `desktop/electron/preload.cjs` | `6E916496313477DD999787B629C4FDAC55B376CED6917B05B7DB665CB0EBABD4` | 803 |
| `desktop/main.mjs` | `F56D8CBDE4D8B0D146719A75AECF3AC0B432BC8CF5199B47443F6A86868305CB` | 49146 |
| `desktop/wake-controller.mjs` | `16997E69F4B6329D8996193CDF0FC6BF984B2545BD93DB965A2A6F246BCB11E1` | 6695 |
| `desktop/build-web.mjs` | `98FAF47414972A79F91904D29207370419E803503A4383B2333E2740F3AC261A` | 758 |
| `desktop/build/renderer.js` | `D29DC83E9405AB1B63632B5835A9BF75A5561B7D541E110B4A823AF7D03EAE7B` | 722269 |
| `tools/run-tests.mjs` | `2F4055225C84186D260E6A25649A7F25E373AF244B617EF2AAEBBAA51F6DB52D` | 3030（**本步修改前的 HEAD 值**） |
| `tools/build-native.mjs` | `F1816654B2A72ACB2BE8BAA31479202776A79BF49CFC34488676C54A7926EA80` | 695 |
| `tools/build-wake.mjs` | `D40E0C6CF34B81B4AE2767DD4E05FC0711C038E8E106AB8E1B309581E17BFA44` | 1821 |
| `tools/build-wechat.mjs` | `D328F2E3DBB390B4DF1DA7162F004B738752128521BE5F4C9E477479CF908186` | 1192 |
| `tools/management-url.mjs` | `FCB7604C3EEBD67B6B5D3173C45E5D5D3FB0808B8672C21E5D43B86D60DD949B` | 1399 |
| `package.json` | `C1FB99F6213807E3BB96DEAD60B645395EE1E86A6F65AB7B07F0D9CA948D76E7` | 2711（**本步修改前的 HEAD 值**） |
| `package-lock.json` | `E87ED8A1F190B58273039D7E856BE19110D1D847C7C3FA82636E8A09181EF19E` | 55040 |
| `tsconfig.json` | `2FB53B1B172BB71222C25F19EEE757ADAEACAD05D60986FBBD577BC27A42885F` | 752 |

**再固化（`2026-09-21T20:30:43+08:00`）—— 初冻结后被并行 worker 改动的 4 个文件**（均**非本步所为**；本步零生产代码改动）：

| 文件 | 新 SHA256 | 字节 | 说明 |
| --- | --- | --- | --- |
| `desktop/electron/main.mjs` | `96FD6F254631375A02E906CAF2C61376B9B8F4576D864E109727224487A4E278` | 15629 | FIX61-11 token 修复（20:28:42）；**初值已过期** |
| `tools/management-url.mjs` | `8780358A63649035C257C25AB02B2A077A5593BE63FE327FE5FCC54F46E00D0C` | 2698 | 同上，新增 `managementTarget()`（20:28:38） |
| `app/evaluate-lifecycle.ts` | `425EAA455D1E9E8CE5B36660774A8CE662F49B02E0C5FDBACD66C4D006CC118E` | 13845 | 非本步范围（20:15:21） |
| `app/evaluate-source-budget.ts` | `F89040D2BEF7637FEAE9BE18F3900683417493C9C7E1DDC0D8610F2DEF51B97F` | 7487 | 非本步范围（20:17:00） |

**其余关键文件逐个复算确认 UNCHANGED**：`app/trial-backend.ts`、`providers/transport.ts`、`providers/slot-registry.ts`、`management/settings.ts`、`desktop/build/renderer.js`。改动后 `npm run test:next65` 复跑仍 **21/21 pass，退出码 0**。

## 4. 冒烟降级证据（AC 00-C）

| 场景 | 观测 | 判定 |
| --- | --- | --- |
| 渲染包缺 `node:`/native | 真实产物 `desktop/build/renderer.js` 中 `node:` 0 次、`require(` 0 次 | PASS（产物级，非源码字符串） |
| 渲染包真实 link | 在 VM realm 用 `vm.SourceTextModule.link()` 载入真实产物：**specifiers = []**，即无任何未解析模块说明符 | PASS |
| 动态 import 是否存活 | `desktop/wake-controller.mjs` 无顶层 import，仅经 `import('../media/wake/browser-capture.ts')` 取驱动；产物内部已被 esbuild 改写为 `Promise.resolve().then(() => (init_browser_capture(), browser_capture_exports))`，**产物内不存在 `import(` 调用点** | **已验证，不是"源串断言"** |
| 渲染包求值边界 | VM realm 内求值失败于 `ReferenceError: Live2DCubismCore is not defined`（Electron 注入的全局），**不是模块解析错误** | PASS（降级可见、非静默） |
| worklet 边车 | `recorder-worklet.js`(3536 B)、`wake-recorder-worklet.js`(1346 B) 实际存在于 `desktop/build/`，产物按相对 URL 引用 | PASS |
| 构建工具非安装包 | `tools/build-native.mjs` 在 win32 分支**只** `access()` electron 并打印一行，**不产出任何分发包** | 如实登记（0.65 打包硬墙，见 K65-00 报告 00-C） |

## 5. 用户自备渲染资产与真实模型资源（gitignored，不入库）

| 资产 | 路径 | 现状 |
| --- | --- | --- |
| Cubism SDK vendor | `desktop/vendor/cubism/` | 存在（用户自备） |
| 本地 Live2D 模型 | `desktop/assets/local-model/` | 存在（用户自备） |
| 本地 streaming ASR 包 | `F:/AIVoice/toolchains/sherpa-streaming-asr/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/` | **存在**。int8 encoder/joiner + fp32 decoder + `tokens.txt` |
| ASR 语料 `0.wav` | 上目录 `test_wavs/0.wav` | 179646 B，16 kHz mono，5.612 s，**SHA256 `668BF8DF51A10027B84D5D8816A1CE11AE93545538DC05CFE2AA6811D399C250`**（本步首次 pin，此前无任何登记） |
| 参考转写 | `对我做了介绍那么我想说的是大家如果对我的研究感兴趣` | 取自模型包自带语料 |
| whisper 工具链 | `F:/AIVoice/toolchains/whisper-b5130/` | 存在；`jfk.wav` 352078 B SHA256 `59DFB9A4ACB36FE2A2AFFC14BACBEE2920FF435CB13CC314A08C13F66BA7860E`、`silence.wav` 64044 B SHA256 `20EAEBFFE1816E0FFA6F7F854F5EF4EA80D5349FAAF0CE1FEC1B713E7FDE58FA`（与 0.6 CORPUS_MANIFEST 一致） |
| 本地 TTS | Windows SAPI，音色 `Microsoft Huihui Desktop`（zh-CN） | 存在；0.6 真实回放 138286 B / `durationMs=4320` |

### 00-D 语料与阈值登记（实现前冻结）

| 指标 | 阈值（**先登记后实现**，未事后放宽） | 本步实测 | 依据 |
| --- | --- | --- | --- |
| CER（对冻结参考文本） | ≤ 0.20 | **0.0000**（0/26 字） | FIX61-08 §6 登记值；本步以真实 Levenshtein 实现重算 |
| 必需关键词 | 3/3（`介绍`/`研究`/`感兴趣`） | **3/3** | 同上 |
| 首 partial 延迟 | ≤ 1500 ms | **471–491 ms**（三轮 438/471/491） | 同上 |
| 末 final 延迟（finish 起算） | ≤ 10000 ms（`VOICE_FINISH_TIMEOUT_MS`） | **6–8 ms** | 同上 |
| partial 次数 | ≥ 1 | **11** | 同上 |
| 语料 frozen 校验 | SHA256 必须等于上表 pin 值 | 相等 | 本步新增，防止门槛被重指到更易语料 |

**本步的关键修正**：FIX61-08 §6 的上述阈值**此前只是文档**——度量脚本 `_metrics08.mjs` 已删除，且**没有任何测试断言它们**（存活的真实模型用例 `tests/next61/liveVoicePath.test.ts` 只断言自洽性，**垃圾转写也能通过**）。K65-00 因此新建了 `tests/next65/baselineBehavior.test.ts` 中可执行的 CER 门槛，把文档阈值变成真实门槛。这是"实现前登记"的实际落地，不是新增宽松。

### 关闭时限登记依据（供 01 固定为有上限策略）

| 阶段 | 现有值 | 来源 |
| --- | --- | --- |
| 后端启动就绪窗口 | `timeoutMs` 60000（下限 60000） | `desktop/electron/transport.mjs:18-24` |
| 无进度停滞窗口 | `noProgressMs` 60000 | 同上 |
| 启动总上限 | `maxStartupMs` 600000 | 同上 |
| **关闭（EOF→SIGKILL）上限** | `shutdownTimeoutMs` 默认 10000（下限 10000） | 同上，`transport.mjs:148` |
| streaming ASR 打开 / 单次调用 | 30000 / 15000 | `providers/sherpa-streaming-asr.ts:125,179` |
| ASR finish | `VOICE_FINISH_TIMEOUT_MS` 10000 | `media/voice-input-session.ts:16` |
| ASR 单次话语上限 | `VOICE_MAX_UTTERANCE_MS` 120000 | 同上 `:14` |
| 语音帧拉取重试 / 超时 | 10 / 2000 ms | `app/desktop-device-bridge.ts:12,14` |
| management 会话超时 | `timeoutMs` 300000（context） | `management/settings.ts` 默认 settings |
| 本地唤醒看门狗 | 1000 ms 轮询；connecting 60000 / 其他 15000 ms 无 PCM 判失败 | `app/wake-manager.ts:84` |
| 记忆清理定时器 | 60000 ms | `app/backend.ts:54`、`app/trial-backend.ts:440` |

## 6. 数据目录与隔离（供 K65-03/04）

- 桌面端：`desktop/electron/main.mjs:20-21` `app.setPath('userData', nextUserDataDir(app.getPath('appData'), smoke ? 'smoke-test' : preview ? 'preview' : 'desktop'))`，Next 命名空间，与旧 `AAAAGENT` 不同且非嵌套（`tests/next/nextNamespace.contract.test.ts` 断言）。
- 后端端：`PET_DATABASE`（SQLite 路径）+ `PET_PROJECT_ROOT`；trial 约定 `<projectRoot>/.local/data/companion.sqlite`。
- 凭据：**唯一读取点** `app/trial-backend.ts:199-212 keyReader()`——要求 activation 哈希匹配、文件绝对路径且在项目外（`realpathSync` 校验）、私有 ACL（`isPrivateFileSync`）、内容匹配 `/^sk-[A-Za-z0-9_-]+$/`。
- 管理配置：单一权威为 `ManagedSettings.providers`，落盘 `management-settings.json`（revision/CAS）。
- 真实模型目录通过 `PET_STREAMING_ASR_DIR` 注入（`app/backend-session.ts:24-30`），**当前未设置**，因此语音路径在生产上静默回退到云端 batch ASR。

## 7. AC 核查

| AC | 判定 | 证据 |
| --- | --- | --- |
| 00-A 基线修订、0.61 自动收口证据、后置人工项、遗留可追溯 | **PASS** | §1 固定点位 + §3 hash 表；FIX61-10 §2 逐条核实 10-A/10-B/10-C 为真实证据；遗留项与已知缺陷在 §1/§4 显式登记，无静默删除 |
| 00-B 原测例按清单实际运行，失败与缺环境如实报告 | **PASS** | §3 五个套件退出码与计数；integration 逐文件隔离结果与既有失败清单见 K65-00 报告 §00-B |
| 00-C 依赖矩阵覆盖组合根/renderer/IPC/构建/native/后台 | **PASS** | K65-00 报告 §00-C 全矩阵；渲染与 IPC 为产物级验证（§4） |
| 00-D test:next65 非零生产特征测试；空目录/零用例非零退出；阈值实现前登记 | **PASS** | `npm run test:next65` 退出码 0、**21 用例**；缺目录 exit 2、空集合 exit 2（三种守卫实测）；§4 阈值表先登记后实现 |
| 00-E 多源矩阵覆盖现有提供者，模型/音色按来源归属 | **PASS** | K65-00 报告 §00-E；未具备项与阻塞如实登记 |

## 8. K65-00 补遗（提交隔离核对，2026-09-22 01:02+08:00 追加，未改动上文原始记录）

本节由 K65-00 隔离核对轮追加（基线修订已前移至 `02a6870`/`abd594b`）。核对方式：`git show --stat 02a6870`（逐文件归属）、`git log`（`tools/run-tests.mjs` 与 `tests/next65/` 均在 02a6870 入库、其前历史无 next65 触点）、`git status --porcelain`（当前未提交清单）、`git show HEAD:windows/code/desktop-pet/package.json`（已提交脚本表）。

**结论：K65-00 范围无缺失、无未提交残留。** 七节结构与 §7 的 AC 判定维持不变；已有内容核对后仍以本节为最终权威：

- **已提交入库（02a6870）**：本文件全部七节、`reports/K65-00.md` §1–§8、`evidence/K65-00-raw.txt`、`test:next65` 脚本、`tools/run-tests.mjs` 的 `next65` 分支、`tests/next65/{baselineSurface,baselineBehavior,rendererArtifact}` 三个基线特征测试。
- **未提交项全部属 K65-01 在途产物，非本步残留**（本步不提交、不修改、不删除，K65-01 棒将续用）：`contracts/{plugin,capability,flow-profile,provider-source}.ts`、`plugins/**`（boundary/manifest/paths/package-build/sdk-emit/esm-graph 等 8 文件）、`tools/emit-plugin-sdk.mjs`、`tests/next65/{dependencyBoundary,entryExecution,packageBuild,packageManifest}.test.ts` 与 `tests/next65/fixtures/**`、`package.json` 增量行 `sdk:next65`、`tsconfig.json` 增量 `include: plugins/**` 与 `exclude: tests/next65/fixtures/**`。4 个新测试文件头注均自述 K65-01 的 01-A/01-B/01-C/01-D 归属；`run-tests.mjs` 已提交版无未提交改动。
- **本节追加时的门槛实测**：`npm run check` 退出码 **0**；`npm run test:next65` 退出码 **0**（58 用例 = K65-00 基线 21 + K65-01 在途 37，58/58 pass——K65-01 用例仅验证可共存，不构成本步交付证据，其断言与归属由 K65-01 自行验收）。
- **超出清单外的未提交项**：无（`git status --porcelain` 仅上列内容）。

## 附录：验收基线符号表（00-A/00-C 逐项归属的源码证据）

下表为"已验收已启用行为 → 兼容能力包"逐项归属登记的实际源码证据（相对 `windows/code/desktop-pet/`，提交 `02a6870`/`abd594b` 实测存在）。具体拆分接线按对应步骤 SPEC 实施；本表只保证"不遗漏后静默删除"的登记可核。

| 项 | 证据符号（实际路径） | 现状与归属 |
| --- | --- | --- |
| 近期 Memory/SQLite | `memory/sqlite-store.ts`（`better-sqlite3` 值导入） | 普通包必需（普通包含现有近期历史）；长期 Memory/Timeline 归 04 兼容包 |
| Emotion | `memory/emotion-state.ts` + `providers/emotion-inference.ts` + `management/emotion-routes.ts`（`management/server.ts:1` 导入；`bootstrap.ts` 接线） | 04 兼容能力包 |
| Timeline | `management/aika-timeline.ts` | 04 兼容能力包 |
| 知识库 | `memory/knowledge-library.ts` | 04 兼容能力包 |
| 冻结快照 | `memory/prefix-snapshot.ts` | 04 兼容能力包 |
| 记忆导入 | `memory/import-management.ts` | 04 兼容能力包 |
| Work | `harness/desktop-work.ts` | 04 兼容能力包（后台轮询生命周期归 03 宿主，见 §00-C C-6） |
| Wake | `media/wake/keywords.ts`（`pinyin-pro`）、`media/wake/detector-worker.ts`（`sherpa-onnx-node`）、`desktop/wake-controller.mjs` | 06 兼容能力包（可选） |
| WeChat | `wechat/store.ts`、`wechat/voice.ts`（`silk-wasm`）、`wechat/qr.ts`（`qrcode`） | 兼容能力包（可选）；`tools/build-wechat.mjs` 的 silk.wasm 复制与 `npm run build` 连带（§00-C C-4）须随包拆分解除 |
| 视觉（perception/视觉情绪） | `providers/management-catalog.ts` 的 `qwen-perception` / `qwen-visual-emotion` 条目（云端、需凭据） | 05 多源兼容包；视觉情绪无本地实现，按 00-E BLOCKED 口径登记 |
| TTS 本地 | `providers/sapi-tts.ts`（Windows `System.Speech`，真实实现，0.6 真实回放 138286 B） | 05 接入槽系统（现被 `createTrialTtsProvider()` 拒收，§00-E E-5） |
| TTS/STT 云端 | `providers/transport.ts`（https-only）+ `slot-registry.ts` | 05 多源兼容包；`transport.ts:56` https-only 是本地来源前置阻塞（§00-E E-3） |
| 组合根 | `app/trial-backend.ts`（68 个顶层 static import） | 03 起按 import 图拆产物 |
| 数据目录 | `desktop/electron/main.mjs` `app.setPath('userData', nextUserDataDir(...))`（Next 命名空间） | §6；03/04 沿用 |

**数据模式与恢复路径**（§6 之外明确一句话）：业务数据的唯一持久化权威是 `better-sqlite3`（`memory/sqlite-store.ts` 等 24 个引用文件，§00-C C-5）；0.61/0.65 均未交付任何数据库迁移/备份/恢复工具（源码中无对应符号），0.6 BASELINE 与本基线记录的恢复路径就是"目录整体可删、重装后重建 + 凭据文件（activation 校验、项目外私有 ACL）外部自管 + 配置权威 `management-settings.json`（revision/CAS）可整体删除重建"。`.gitignore` 的审计残渣排除规则不覆盖任何用户数据目录。该现状如实登记为 0.65 的迁移输入，不视为缺陷修复项。

**K65-01 议题登记（本步不实现，仅登记）**：`SlotBinding` 强制 `credentialRef`（`providers/slot-registry.ts:54`）+ TTS 强制 `characterMicros > 0`（`slot-registry.ts:87`）与 K65-02A「无 Key 本地来源、费用 unknown」存在直接冲突。K65-00 已盘点完整七段校验链与 `transport.ts:56` https-only 阻塞（§00-E E-3/E-4），`OPEN_COST_POLICY` 的裁决点（费用豁免、unknown 计费口径如何表达）与解除顺序由 K65-01 在其 SPEC/契约冻结时决策；02A 只消费冻结结果（D2）。

相关文档：[K65-00 报告](K65-00.md) · [执行索引](../SPEC.md) · [公共契约](../CONTRACTS.md) · [测试规则](../TESTING.md) · [源码核对](../SOURCE_AUDIT.md) · [多源 Provider](../PROVIDERS.md) · [0.61 收口报告](../../0.61/reports/FIX61-10.md) · [续跑账本](../../RUN_061_065.md)。
