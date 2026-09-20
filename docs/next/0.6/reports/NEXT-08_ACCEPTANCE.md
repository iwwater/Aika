# NEXT-08 验收报告 · 版本自动收口与候选构建

- 执行：goal worker（2026-09-20）。SPEC：[NEXT-08](../specs/NEXT-08.md)。需求：N06-R09。
- 状态：**AUTO_PASS**。候选 commit：包含本报告的收口提交（`git log --oneline -1` 核对；功能基线为「真实回放与 SAPI 适配」提交，两者都在 `cae4d20` 之后）。真实回放、全量回归、静态检查、Windows 构建与自动冒烟当日实跑通过。
- 用户授权（2026-09-20「都批准」）：whisper 工具链重新下载、Windows SAPI 免费真实 TTS、复用旧库 DeepSeek 凭据。

## 1. 08-A 静态检查与全量回归（cwd `windows/code/desktop-pet/`，退出码均为实跑结果）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run check`（tsc --noEmit strict） | 0 | 0 错误 |
| `npm run test:next`（第 1/2 遍） | 0 / 0 | 78/78；剥离耗时后两遍逐行一致（DETERMINISTIC_OK） |
| `node tools/run-tests.mjs default`（上游 memory+providers） | 0 | 563/563 |
| `node tools/run-tests.mjs release` | 0 | 138/138 |
| `node tools/run-tests.mjs windows` | 0 | 22/22 |
| `node --test --test-concurrency=1 dist/tests/management/{server,balance-http,project-routes,wechat-http}.test.js` | 0 | 6/6（覆盖 server.ts 的 Aika 接线） |
| `PET_NEXT_REAL=1 npm run test:next:real` | 0 | 5/5（见 §3） |

skip/空测试核查：next 组无 skip（空集守卫存在）；real 组 5/5 无 skip；上游各组 0 skip。管理套件三个既有基线问题见 §5，按登记排除，不作为本轮回归。

## 2. 08-B/08-C 全链集成（生产组件 + 标注替身）

`tests/next/fullChain.integration.test.ts`（3 用例）：

- **08-B 多轮**：NextTurnPort + DialoguePipeline + SqliteLifecycleMemoryPort（真实临时 SQLite）+ AikaTimelineRecorder——turn-B 请求上下文 recent 实含 turn-A 用户消息与助手回复；Timeline 恰 4 事件（2 userMessage + 2 assistantTerminal completed）。
- **08-B 取消**：gate 中取消 → terminal cancelled 恰一次 → 迟到回复不派发、不落库 → Timeline assistantTerminal=cancelled → 新轮正常完成。
- **08-C 语音输入腿**：乱序/重复/空段 → 合并提交恰一次（「你好，世界」）→ completed → Timeline 恰 1 条 userMessage + 1 条 assistantTerminal。
- 标注替身：dialogue=脚本化（按提交文本 gate）、tts/playback=text 模式拒绝、perception=拒绝、memory plan=noPlan。真实外部依赖在 §3；输出腿（分句→TTS→播放→Timeline）见 NEXT-06 报告 06-G，装配见 07-F。
- 跨会话轮次隔离由 `turnController.contract.test.ts` / `memory.contract.test.ts` 既有 GREEN 用例覆盖（resetSession、共享 recent 流语义），不重复建测。

## 3. 08-D 真实服务回放（全部 PASS，原始结果脱敏留档）

| 项 | 证据 |
| --- | --- |
| 真实 LLM | DeepSeek `deepseek-flash`（`/models` 实测有效；key 仅存 gitignored `.next-real.local.json`）。单轮：非空回复、终态唯一、settle=success、Timeline 两条事件。多轮：turn-B 真实回复含 turn-A 代号「北斗七号」，且请求 recent 实含 turn-A 消息（`tests/next/real/realLlm.test.ts`） |
| 真实 ASR | whisper.cpp b5130 官方包+模型 SHA256 与登记一致；jfk.wav（`59dfb9a4…`）冻结转写逐字命中；静音（参考 hash `20eaebff…`）→ `[BLANK_AUDIO]` → 清洗为空 → 0 提交 0 事件（`tests/next/real/realAsr.test.ts`；工具链 `F:/AIVoice/toolchains/whisper-b5130`，不常驻，重启命令见 §6） |
| 真实 TTS | Windows SAPI（免费本地）：固定中文文本 + `Microsoft Huihui Desktop` → 138,286 字节可解码 16kHz PCM WAV，`durationMs=4320`（`tests/next/real/realTts.test.ts`；生产适配 `providers/sapi-tts.ts`） |

详见 [NEXT-06 报告 §6](NEXT-06_ACCEPTANCE.md)。fixture 只在标注替身处使用，未替代任何真实判定。

## 4. 08-E Windows 候选构建与自动宿主验证

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run build:windows`（build + desktop + wake + native） | 0 | 「Windows Electron host is ready」 |
| `npm run test:windows:ui`（自动冒烟） | 0 + `WINDOWS_SMOKE_OK` 文本双判据 | Live2D 渲染、隔离 preload、后端文本往返、面板布局全过（GPU 进程的 Chromium 日志为已知无害噪音） |

N01-E2E-TEXT（渲染就绪→文本提交→回复可见→干净退出）由冒烟关闭。构建产物为工作树内 `dist/` + `desktop/` 构建输出（gitignored）；候选=候选 commit + 本机构建，无对外分发（发布标签/分发按后续授权）。

## 5. 08-F 数据隔离与回归（引用既有 GREEN 证据）

- 目录隔离：`nextNamespace.contract.test.ts`——`AikaNext` 与 `AAAAGENT` 根互不嵌套；哨兵文件逐字节不变；Electron 入口经 `nextUserDataDir` 解析 userData。
- 密钥不泄漏：`aikaProfile.contract.test.ts`——provider 配置拒绝 `apiKey/api_key/key/credentialFile` 字段，state 仅 credentialRef/credentialConfigured。
- Timeline 删除/迟到不复活：`aikaTimeline.test.ts` 05-E（redact 幂等、墓碑、重放不复活）+ 本报告 §2 取消用例（迟到回复不落库）。

## 6. 08-G 逐需求覆盖表（R01～R09）

| 需求 | 证据 |
| --- | --- |
| N06-R01 基线与数据目录 | [BASELINE.md](../BASELINE.md)、[SOURCE_MAP.md](../SOURCE_MAP.md)、`nextNamespace.contract.test.ts` |
| N06-R02 语料与契约 | [CORPUS_MANIFEST.md](../CORPUS_MANIFEST.md)、[CONTRACT_MAP.md](../CONTRACT_MAP.md)、`tools/run-tests.mjs` 分组 |
| N06-R03 身份与配置 | [NEXT-02 报告](NEXT-02_ACCEPTANCE.md)、`aikaProfile.contract.test.ts` |
| N06-R04 Provider 适配 | [NEXT-03 报告](NEXT-03_ACCEPTANCE.md)、`aikaDialogue.contract.test.ts`、§3 真实 LLM |
| N06-R05 文字主链与 Memory | [NEXT-04 报告](NEXT-04_ACCEPTANCE.md)、`textMainChain.test.ts`、`memory.contract.test.ts` |
| N06-R06 Timeline | [NEXT-05 报告](NEXT-05_ACCEPTANCE.md)、`aikaTimeline.test.ts` |
| N06-R07 语音链路 | [NEXT-06 报告（含 §6）](NEXT-06_ACCEPTANCE.md)、`speechBridge.test.ts`、§3 真实 ASR/TTS |
| N06-R08 最小 UI | [NEXT-07 报告](NEXT-07_ACCEPTANCE.md)、`aikaConsole.test.ts`、`/aika-view.mjs` |
| N06-R09 本步 | 本报告 §1～§5 |

启动方法与环境依赖：

- 开发/验收运行：`npm run dev`（构建并启动桌宠 + 管理服务；Aika 页 `http://127.0.0.1:<端口>/aika-view.mjs`，端口以启动输出为准）；配置后可用 `npm start`。
- 真实语音（09-C）：先起 whisper-server：`F:/AIVoice/toolchains/whisper-b5130/Release/whisper-server.exe -m F:/AIVoice/toolchains/whisper-b5130/models/ggml-base.bin --host 127.0.0.1 --port 8080 -l auto -t 6 -ng`（仅 loopback）；TTS 为系统 SAPI，无需服务。
- 真实 LLM：`https://api.deepseek.com/chat/completions` + `deepseek-flash`；凭据在本机 gitignored `.next-real.local.json`（不入库）。
- 环境：Windows 11 x64，Node v24（engines ≥22.12），依赖见 [BASELINE.md §2](../BASELINE.md)。

已知限制（写入 NEXT-09 清单的输入）：

1. 管理套件三个文件为本机既有基线问题（stash 对照实验见 NEXT-07 报告 §4）：`settings.test.js` 4 过 2 败（438!==384；evaluation-budget 预留冲突）、`management/integration.test.js` 0 过 2 败（symlink EPERM 需管理员/开发者模式；EBUSY 文件锁）、`memory-dynamics-http.test.js` 挂起（本次 120s 超时截杀复现）。与本轮改动无关，修复需管理员环境或上游原环境复核，不阻塞本版。
2. whisper-server 不常驻，重启机器后需按上行命令重启。
3. 管理控制台导航未加入 Aika 页入口（页面直达 `/aika-view.mjs`），UX 细节留 NEXT-09。
4. 真实语音的麦克风现场输入、扬声器停止与听感属 NEXT-09；本报告不声称声学体验通过。
