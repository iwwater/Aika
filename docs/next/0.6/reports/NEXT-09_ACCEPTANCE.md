# NEXT-09 验收报告 · 版本末尾人工验收

- 执行：用户人工验收（2026-09-20），goal worker 记录。SPEC：[NEXT-09](../specs/NEXT-09.md)。需求：N06-R10。
- 状态：**RELEASE_ACCEPTED**（2026-09-20，用户确认）。
- 验收方式说明（如实记录）：用户在实测确认「文字对话、LLM 回复、TTS 输出」可用、并经历 D-1/D-2/D-3 修复与两次重启后，明确表示 09-B/D/E「不用测了，肯定能通过」并免除 09-F 逐项检查——本报告按用户原话记录该免测声明；B/D/E/F 无逐项操作证据，属**用户明示豁免**而非 worker 代填。
- 验收环境：用户本机 Windows 11；运行方式 `npm start`（已配置桌面，activation active）；候选基线 `4068d0b` + 验收期修复 `abf0f6e`/`83a95c0`/`affd790`（D-1/D-2/D-3）；LLM＝DeepSeek `deepseek-flash`（用户在配置页保存的凭据）；TTS＝生产配置百炼 qwen3-tts（语音输出用户已确认）；ASR＝配置为百炼 qwen3-asr（麦克风输入未测，见 09-C）；本地 whisper 服务（127.0.0.1:8080）运行中，供 06-E 证据链与后续本地识别使用；管理控制台 `http://127.0.0.1:<port>/aika-view.mjs#token=…`（端口随实例，见 management-session.json）。

## 1. 逐项状态

| 项 | 状态 | 记录 |
| --- | --- | --- |
| 09-A 启动/修改配置/重启 | PASS（用户确认） | 验收期实际经历多次启动/重启（D-1/D-2/D-3 修复后均由 worker 重启、用户继续使用），配置与聊天记录跨重启保留 |
| 09-B 连续对话/取消/重发 | PASS（用户免测声明） | 用户实测了连续对话（多轮、追问计数）；「不用测了，肯定能通过」；过程中发现 R-BUG-15（语音已播、文字气泡未出现一次），用户指示登记后修，不阻塞 |
| 09-C 真实语音输入/输出 | 部分 | 语音**输出**：用户确认正常（"输出TTS没问题"）；麦克风**输入**：**DEFERRED**（用户明确声明：无法判断是设备问题还是接错设备，暂不测试；后置为设备侧事项，不计入本版软件缺陷；后续按 R-TODO-11 做设备选择/诊断） |
| 09-D 记忆/纠正/遗忘/Timeline | PASS（用户免测声明） | 用户实测了记忆问答（代号码计数场景，回复正确引用上文）；「不用测了，肯定能通过」 |
| 09-E 可恢复错误与恢复 | PASS（用户免测声明） | 验收期实际经历 D-2（LLM 调用被拒）→ 修复 → 恢复使用的完整错误-恢复闭环，与 09-E 场景同构；用户确认「LLM没问题」 |
| 09-F 总体体验 | PASS（用户确认） | 用户整体结论「肯定能通过」；R-BUG-15 与语音输入 DEFERRED 为已知项，不阻塞 |

## 2. 缺陷记录（验收期发现）

### D-1 electron 后端握手超时导致「对话服务连接失败」（已修复）

- 现象：`npm start` 后桌宠渲染正常，但后端进程被静默杀掉，面板显示「对话服务连接失败」，重试亦然；`management-session.json` 不生成。
- 根因：`desktop/electron/transport.mjs` 的 BackendConnection `timeoutMs` 默认 15000ms——后端冷启动需完成全部运行时文件 hash 校验（`verifyTrialRuntime`）等初始化，机器负载高时 15 秒内无法完成握手，传输层按超时杀掉后端，无任何 stderr 输出。同一后端手动运行（无 15s 限制）每次正常，证实为握手窗口过窄，非后端缺陷。
- 修复：`timeoutMs` 15000→60000（一行默认值），commit `abf0f6e`；本机 `config.json.runtimeFiles` 指纹与 `activation.configSha256` 已同步重算。修复后后端正常拉起、管理会话写出。
- 定级：一般缺陷（阻塞验收进程，修复后恢复）。

### D-2 首次配置完成后预算账本缺失，所有 LLM 调用被拒（已修复）

- 现象：消息可正常进入后端（用户消息已入列），但无任何回复；工作整理卡片报「这次请求暂时没能整理」；管理接口 `/api/snapshot` 返回 500。
- 根因：`app/trial-authorizer.ts` 安全设计「原始账本缺失不得静默创建空账户」（每次调用前 `readFile(budgetFile)`，缺失即抛 `Original shared trial ledger is unavailable`），而首次配置（self-setup finish）流程未创建 `budget.json`——配置 `limitMicros: null`（unlimited 记账模式）时尤缺此文件。所有 LLM 调用在预算预留一步即失败；账本同文件亦是 snapshot 的 accounting 来源，故 500。
- 修复：按 `EvaluationBudget` 的初始状态结构补建 `windows/.local/model-evaluation/budget.json`（batchId/currency/limitMicros/budgetMode:'unlimited'/blocked:false/entries:[]，与本机 config 完全一致）。修复后实测：DeepSeek 真实调用 200 并返回正常回复；`/api/snapshot` 恢复 200。**无需重启即生效**（authorizer 每次调用现读账本）。
- 遗留：self-setup finish 应负责或校验账本存在——上游流程缺口，已登记为上游集成缺陷（本版以本机补建解除，不影响候选代码）。
- 定级：一般缺陷（阻塞验收进程，修复后恢复）。

### D-3 控制台按钮打不开（已修复，两处根因）

- 现象：点面板「控制台」提示「暂时无法打开控制台，请确认桌宠服务已启动后重试」；`managementUrl` 的 catch 吞错，经逐步复刻定位。
- 根因一（探活窗口过窄）：`tools/management-url.mjs` 打开前对 `/api/snapshot` 校验超时 4000ms，实测本机 snapshot 耗时 3.4–4.1s，贴线随机失败。修复：4000→15000（commit `83a95c0`）。
- 根因二（Windows ACL，主因）：`management/bootstrap.ts` 写 `management-session.json` 仅设 POSIX `mode:0o600`（Windows 无效），未做 `restrictPrivatePathSync`；而 console-open 路径要求 `isPrivateFileSync` 通过（Windows ACL 检查）→ **会话文件永远判为非私有，控制台在 Windows 上从未可打开**。修复：写后调用 `restrictPrivatePathSync(file)`（一行+import），重启后实测 `isPrivateFileSync=true`。
- 经验：D-1/D-3 均为「时间/权限窗口定得过紧且失败被吞」；错误可见性改进已在 R-TODO-08/10/14 登记由后续版本处理。
- 定级：一般缺陷（阻塞控制台验收，修复后恢复）。

### D-4 本机基线问题（非本版软件缺陷，承接 NEXT-07/08 登记）

管理套件 `settings.test.js`（4过2败）、`management/integration.test.js`（0过2败，symlink EPERM/EBUSY）、`memory-dynamics-http.test.js`（挂起）——stash 对照实验证明与本轮改动无关，需管理员环境复核，不阻塞验收。

## 3. 验收结论与遗留

- **RELEASE_ACCEPTED**（2026-09-20，用户确认；含对 09-B/D/E/F 的明示免测声明，见验收方式说明）。
- 遗留（不阻塞发布）：R-BUG-15（语音/文字不同步，登记 `docs/next/TODO.md`）；麦克风输入 DEFERRED（设备侧，R-TODO-11 后续）；D-2 遗留的 self-setup 账本缺口（上游流程缺陷，已登记）；D-3 相关的可观测性改进（R-TODO-08/10/14）。
- 标签 `aika-next-v0.6.0` 创建/推送、对外分发按后续授权执行。
