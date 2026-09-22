# Aika Next 需求 TODO（用户原始需求登记）

状态：部分已排入 0.61，其余 BACKLOG。登记日期：2026-09-20；来源：用户口述。

**最新排期（2026-09-20，以此覆盖下文历史建议归属）**：用户指定 R-TODO-01、02、16、05、06、07、08、09、10、11、12 纳入 0.6 后的 **0.61**，详见 [0.61 RPD](0.61/RPD.md) 与 [10 个修复 SPEC](0.61/SPEC.md)。R-TODO-16 不再属于未排期优化；R-TODO-07 已确认包括本版可用的知识库导入与切换，完整自动 Wiki 维护仍归 0.7。所有修复尚未执行，不改变 0.6 完成标准。

下文保留原始问题和历史分析；其中“15 秒启动超时”“采集端无 chunk”“任意写库使 Context 失效”“100% KV 命中”等说法须以 [当前源码核对](0.61/SOURCE_AUDIT.md) 的修正为准。未点名的 R-TODO-03/04/14、R-TODO-13、R-BUG-15 不自动纳入本轮。
规则：本文件只登记需求与建议归属，**不改动 0.6 已冻结的 SPEC 范围**；哪条并入哪一版由用户确认后，再按 TDD 流程（先失败测试）立 SPEC。约束继承 AGENTS：只获取免费/官方授权资产并校验 hash，不自动调用付费服务，不自动启用外部动作。

## 1. 后端重构：极简配置面

| ID | 需求 | 现状与建议归属 |
| --- | --- | --- |
| R-TODO-01 | 保留现有能力：填写端点 + Key | NEXT-02 已实现存储形态（`management/aika-profile.ts`，credentialRef 不落明文）；NEXT-07 出配置 UI 时挂接 |
| R-TODO-02 | **从端点拉取模型列表并选择**：填好 endpoint+Key 后，拉取可用模型（OpenAI-compatible `GET /v1/models`；Gemini `ListModels`）以下拉选择，不再手填 model 名 | 新能力。建议 NEXT-03 追加「模型列表」adapter 方法（同样过契约测试），NEXT-07 在 Provider 表单加「获取模型列表」按钮与下拉 |
| R-TODO-03 | **【后续优化】一键安装默认本地模型**：例如量化版 STT（whisper.cpp 量化 ggml / sherpa-onnx）、TTS（sherpa-onnx TTS / piper 一类），轻量化本地跑；或给一个**可选择的列表**（模型名、体积、来源、hash）让用户挑选安装 | **【后续优化】**（用户指示：标记为后续优化）。新能力，当前 0.6 只要求“已有可用 ASR/TTS 路径”（N06-R07）。安装器建议 0.7 后续优化待办；实现要点：官方源下载 + SHA256 校验 + 安装到 Next 数据目录（不混入上游目录）；Windows ACL 保护凭据做法沿用 |
| R-TODO-04 | **【后续优化】后端只配 Key 的极简面**：预算台账、微信、任务派发、情绪分析等上游管理面不挂 UI 入口 | **【后续优化】**（用户指示：标记为后续优化）。与 0.6 RPD 收窄一致（“上游已有功能不为收窄而删，但不自动启用”）。NEXT-07 配置页只放：身份 + Provider(Key) + Timeline 查看 + 语音开关；`budgetMode: unlimited` 作为默认预设，绕开记账摩擦 |
| R-TODO-16 | **【后续优化】各功能模块模型全面支持用户自定义配置（解除槽位模型硬编码锁定，【核心卡点·记得改！】）**：对话（dialogue）、记忆维护（memory_turn）、摘要（summary）、视觉感知（perception）、语音转写（asr）、语音合成（tts）、准入判断（admission）等各个功能的模型，均由用户在配置中自由定义（自定义模型名称、端点、协议类型、Key/credentialRef、思考模式等），**彻底改掉原版硬编码的模型白名单和计费边界拦截**！ | **【后续优化】**（用户指示：标记为后续优化，【记得必改点】）。**后端架构分析与整改方案（2026-09-20 核实）**：<br>① **【必改】原版硬编码模型白名单与计费死锁排查**：<br>　• `management/settings.ts:52`：`if (!adapter.models.includes(p.model)) invalid('这个型号尚未登记适配能力和费用边界，不能应用。')` —— 凡是未在上游静态 catalog 预设白名单中的模型，一律直接报错拦截！**必须改掉**；<br>　• `management/settings.ts:59`：`invalid('计费边界由已登记型号提供，不能在页面中自行改写。')` —— 强制用户选择的模型必须完全匹配硬编码的计费单价（`inputMicrosPerToken`）和预扣额度（`reservationMicros`）。**必须改掉**；<br>　• `app/trial-config.ts:125`：`if (operation === 'memory_turn' && m.provider !== 'deepseek') fail('必须使用精确的DeepSeek做记忆维护')` —— 死锁记忆维护只能用 DeepSeek，其他模型一律报错。**必须改掉**；<br>　• `providers/management-catalog.ts`：写死了每个槽位的默认 provider、models、价格表与选择项。**必须解耦，改为开放配置或端点动态拉取**；<br>② **用户核心诉求**：各个功能的模型**完全由用户自由定义**，绝不能由原版定死，更不能被这套强制计费与模型白名单卡死；<br>③ **实施改造方案**：<br>　• 彻底移除 `settings.ts` 中对 `adapter.models` 白名单与定价字段的硬性校验；<br>　• 在默认 `budgetMode: unlimited` 预设下，跳过所有计费预扣（reservationMicros）与 token 单价拦截；<br>　• 扩展 `AikaProviderConfig`（`management/aika-profile.ts`），使每个功能槽位均可独立指定 `provider`、`model`（自由文本或端点下拉）、`endpoint` 与 `credentialRef`；<br>　• 解除 `memory_turn` 仅限 DeepSeek 的限制，支持任意指令遵循 LLM 担当记忆提取。归属建议：**【后续优化·待办】（核心必改项，建议 0.7）** |

## 2. 桌宠交互重构

现状：左键、右键当前触发同一画面（点击打开聊天抽屉）。

| ID | 需求 | 现状与建议归属 |
| --- | --- | --- |
| R-TODO-05 | **左键 = 抚摸互动**（stroke/pat）：Live2D 触摸反馈（头部/身体参数、交互动作），不再弹面板 | 改 Electron 点击分发 + `desktop/interaction-motion.mjs`/cubism 参数反馈；建议 NEXT-07 |
| R-TODO-06 | **右键 = 打开功能面板**（独立于聊天抽屉的画面） | Electron `context-menu` 事件 + 新面板窗口/页面；建议 NEXT-07 |
| R-TODO-07 | 面板内容：**切换角色**（换 Live2D 模型，即“换肤”，见 `desktop/assets/local-model/` + `tools/configure-model.mjs` 流程）、**切换知识库**、各模块入口导航（配置/记忆/Timeline/日志等链接） | 切角色：面板列出已安装模型（local-model 目录扫描）+ 一键切换/重载渲染。知识库：**上游无 Wiki（0.6 明确排除项）**——依赖 0.7 Wiki MVP 先存在，TODO 先登记依赖。<br>**换肤现状彻底核实（2026-09-20，用户在前端桌宠与后端控制台完全找不到换肤位置的原因）**：<br>经过对桌面端和控制台全量源码深度排查，确认**当前工程中完全不存在任何「换肤 / 切换角色」的功能入口或界面**：<br>Ⓐ **桌宠前端（pet-shell / Electron）**：当前左键与右键均绑定打开聊天抽屉，无右键功能面板；渲染器（`desktop/cubism-renderer.mjs`）入口写死为 `assets/local-model/pet.model3.json`，无任何角色切换菜单或动态重载入口；<br>Ⓑ **后端控制台（management/ui）**：全控制台 8 个页面中，只有「表情与动作」页（`presentation-view.mjs`），该页面**仅用于预览当前唯一定死模型**的 36 个表情/待机动作与自动使用开关，无角色列表、无多模型扫描、无换肤下拉框，后端亦无任何模型切换 API 路由；<br>Ⓒ **官方文档定性**：上游 `LIVE2D.md` 明确声明『Cubism 2 及模型包热切换暂不支持（model-package hot switching are currently unsupported）』。当前更换模型的唯一手段是开发者手工将模型文件覆盖拷入 `desktop/assets/local-model/` 目录，执行 CLI 工具 `node tools/configure-model.mjs` 重新计算 SHA256 指纹绑定，随后重新构建打包；<br>Ⓓ **后续实现方案（写进 TODO 待办）**：支持多模型目录组织（`local-model/<modelId>/`）、每模型独立预设/指纹登记，在右键功能面板及控制台增加「角色/皮肤选择器」，后端增加切换接口并通知渲染器动态重载。归属建议：**0.7 待办** |
| R-TODO-08 | **模块状态灯**：STT、TTS、LLM、后端数据库（SQLite）等各模块一个绿/红灯，绿=已连接可用，红=未连接/失败；点灯可见失败原因与修复入口 | 建议 NEXT-07。健康检查来源：LLM=Provider 端点探活（不产生计费调用，用 models 列表请求即可）、STT/TTS=本地服务探活或凭据就绪检查、数据库=SQLite 打开+schema 版本校验。红灯必须给可恢复错误，不静默降级（沿用 RPD 错误可见原则） |

## 3. 推理输入快照模式（KV 稳定与降耗）

| ID | 需求 | 设计要点与建议归属 |
| --- | --- | --- |
| R-TODO-09 | **推理输入快照模式（用户定义的更新逻辑）**：载入时判断 LLM 输入是否需要更新——不需要则复用**冻结快照**（系统设定 + 人物底色/Soul + 记忆上下文/基础画像 + 阶段摘要的整体装配结果）；冻结后**长周期或下次重启才刷新**；更新一律在**后台异步重算，原子替换，前台对话零感知、零阻塞**；目标是**绝对稳定 KV 缓存、大幅降低 Token 消耗与首字延迟** | **上游原版更新逻辑 vs 用户期望更新逻辑的对比与整改（2026-09-20 核实，出入巨大）**：<br>① **上游原版逻辑剖析（无快照，每轮动态召回重算）**：<br>　• 上游 `dialogue-pipeline.ts` 在每一轮对话时，均执行 `SqliteMemoryPort.createContext` -> `this.store.recall.rank(text)`，根据用户当轮输入的 text 重新进行语义打分并排序召回记忆；<br>　• 随后将 systemPrompt + 动态召回的 memories + 动态滑动的近期消息实时组装为一个全新 prompt；<br>　• 依赖 `assertContextCurrent` 做强一致性版本校验，任何数据库写入都会导致上下文失效并重新计算；<br>　• **出入与严重缺陷**：因为每轮都根据当前 text 动态改变 prompt 前缀内容与排列，导致发给大模型的前缀**完全无法稳定命中供应商的 KV Cache / Context Caching**（如 DeepSeek context caching、Gemini 隐式缓存等），产生极高的首字延迟（TTFT）和昂贵的重复 Token 消耗；<br>② **用户的更新逻辑（完全按用户要求重写进 TODO）**：<br>　• **Prompt 前缀冻结（Frozen Prefix Snapshot）**：将「系统设定 + 人物底色（Soul/Persona） + 核心长期记忆/用户画像 + 阶段性摘要」固定为一个前缀快照。只要快照有效，送给 LLM 的前缀字节级严格固定不变，专供 100% 命中供应商 KV Cache，大幅降低延迟与 Token 成本；<br>　• **载入判断**：启动或对话载入时，首先检查是否存在可复用的冻结快照；如果未达到刷新条件，直接复用已保存的快照，不重新扫描检索 SQLite 记忆库；仅将当前活跃轮次的增量对话作为动态后缀拼接；<br>　• **长周期或下次重启才刷新**：快照绝不在日常对话中频繁抖动更新，而是按长周期（较长 TTL、高轮次阈值或关键记忆落库阶段）刷新，或直接配置为『本次运行全程冻结，下次重启才刷新』；<br>　• **后台异步重算，前台零感知**：当触发更新条件时，一律由后台任务异步重新装配新快照，计算完成后执行**原子替换（Atomic Swap）**，前台对话绝不阻塞、绝不等待；<br>　• **主动修改立即失效特例**：仅当用户在控制台/设置中主动修改了人物底色、Soul 或系统设定时，快照才同步立即使失效并立即重新生成。归属建议：**0.7**（Soul/Persona 体系与快照存储设计，衔接 `next/0.7/RPD.md`） |

## 4. 连接握手与启动健壮性（已确认卡点）

| ID | 问题与需求 | 设计要点与建议归属 |
| --- | --- | --- |
| R-TODO-10 | **已确认卡点（用户诊断）**：Electron 拉起 Node 后端（trial-backend）后走管道握手，现为**固定 15 秒超时**——后端冷启动要校验全部运行时文件 hash，机器高负载时 15 秒内握不上手即被 Electron **静默杀掉**，面板只显示「连接失败」（同样后端手动运行必然成功，因无此限制）。**要求改掉纯时间判断**：改为①启动期持续重试/等待一段窗口（失败可见、可手动取消重试），或②订阅/监视者模式——后端就绪事件驱动握手，Electron 订阅就绪状态而非掐表 | 设计要点：①区分「**慢但在进展**」（冷启动 hash 校验——应继续等待并显示启动状态）与「**无进展僵死**」（应终止）——用**进度/心跳监视**替代绝对超时，或至少把启动窗口拉长且可配置；②废除静默击杀：状态机改为 `启动中→已连接→失败(原因可见)→用户可重试`，与 R-TODO-08 状态灯共用；③监视者模式下 Electron 不重复拉起第二个后端（单实例锁语义保持）；④上游测试「startup timeout terminates stalled connections」针对的是僵死场景，语义要保留，不能为绕过慢启动而删掉保护。涉及上游共享文件 `desktop/electron/transport.mjs` + 后端启动流程——按规则记录差异、带契约测试。归属建议：**作为 NEXT-09 人工验收发现项进入缺陷闭环**（现在是验收候选版本），或 0.7——待用户确认 |

## 5. 语音链路增强（用户当前语音不可用，一并登记）

| ID | 需求 | 现状与建议归属 |
| --- | --- | --- |
| R-TODO-11 | **语音输入设备选择 + 试麦克风**：桌宠点击出现的界面（右键面板）中提供**麦克风设备选择器**（枚举/切换输入设备，选择持久化）+ **试麦克风功能**：实时音量电平表、按键录几秒本地回放（不留存）、展示当前麦克风**能力**（设备名、采样率、声道数、是否默认设备、权限状态），帮助用户确认「听得见我」；当前用户遇「语音无法输入」原因不明，先诊断 | 待诊断假设：①后端握手失败（R-TODO-10）导致语音链路根本没建立——上游权限模型里 `start_voice` 之后才授予麦克风权限，连接没通自然无声；②设备默认项选错/无麦克风权限；③按键说话（press-to-talk）交互不直观。实现：渲染层 `mediaDevices.enumerateDevices`+`getUserMedia`，音量反馈可复用上游 capture 驱动的电平事件，偏好持久化（`%APPDATA%/AikaNext/desktop`）；归属 NEXT-07 或 NEXT-09 缺陷闭环 |
| R-TODO-12 | **语音实时逐 chunk 流式输入**：当前为按键说话→整段录完→一次性送 ASR；改为**边录边按 chunk 实时喂 ASR**（边说边实时出字），大幅降低等待感 | **工程现状排查与可行性评估（2026-09-20 核实，架构无阻碍，当前纯批处理）**：<br>① **工程代码现状排查**：<br>　• 采集端（`media/capture.ts`）：目前仅有 `TurnCapture` 类，只支持整段式录音（`start` 开始录音，`finish` 停止录音并将整段音频组装为单块 WAV 资源），无实时 chunk 产生能力；<br>　• ASR 识别端（`providers/qwen-asr.ts`）：`QwenAsrProvider.transcribe()` 仅接收完整 WAV 音频，做一次性 Base64 编码发单次 POST 请求，属于典型的批处理（One-shot）；<br>　• 契约准备：`CONTRACTS.md §5` 已经规划了 `AsrSegment{inputSessionId, segmentId, index, text, audioEndMs, timeSource}` 流式段数据结构，但工程代码中尚未落地；<br>　• 本地工具链现状：本地 `toolchains/whisper-b5130` 为命令行可执行文件（接收完整 `.wav` 文件），原生不支持长连接流式推送，需配合分片轮询或接入流式 ASR 引擎（如 sherpa-onnx streaming / FunASR websocket）；<br>② **工程可行性结论**：**工程架构本身无冲突、无不可逾越的死结**。系统分层（Capture -> ASR Provider -> Pipeline -> Presentation）高度模块化，完全支持平滑演进到流式；<br>③ **工程实施路径（写进 TODO）**：<br>　1. 采集层引入 Web Audio `AudioWorkletNode` 分片采集（每 100~200ms 输出一个 PCM chunk）；<br>　2. ASR 适配器引入流式通信（WebSocket 或 HTTP chunked stream），支持实时派发 `interim` 阶段性文本；<br>　3. 桌面渲染层对接实时气泡更新事件（边说边实时出字），并在松键/VAD 截断时提交最终结果。归属建议：**0.7 待办** |
| R-TODO-13 | **主动互动陪伴模式**：专门设计的「主动互动、主动接收、OCR 识别、LLM 分析」模式——桌宠不只被动应答，而是主动发起互动，结合屏幕 OCR 感知与 LLM 分析生成陪伴行为 | 路线图 **0.8**（OCR/VLM 感知、主动陪伴）已有排期；上游已有地基：`ProactiveInvitation`+`InvitationPolicy`（配额/最小间隔/时区）与 VAD/唤醒基础设施。硬约束：**屏幕采集涉及隐私，必须遵守产品权限与确认语义**（哪些窗口可读、用户逐次或持久授权、红灯可见），不得默认开启；主动打扰要有配额与免打扰。依赖：OCR 能力（0.8）、知识库/Persona（0.7）。本条只登记意图与边界，设计另立 |

## 6. 可观测性：后端控制台的对话轮次 Trace

| ID | 需求 | 设计要点与建议归属 |
| --- | --- | --- |
| R-TODO-14 | **【后续优化·待办】控制台可查看每个对话轮次的 Trace**（记忆对话排查的核心工具）：①**延迟分解**——排队、上下文装配/记忆检索、LLM 首 token、LLM 完成、TTS、播放各段耗时与总延迟；②**完整输入**——用户原文 + 实际送进 LLM 的**全部内容**（system prompt/身份、Soul、对话历史、记忆检索命中、感知结果），即「模型到底看到了什么」；③**输出**——回复全文与 token usage；④**未来工具调用**——调用名、参数、结果、耗时（预留字段） | **【后续优化·待办】**（用户指示：以后优化，待办）。当前不占用近期排期。保留完整设计要点与盘点备查：<br>Ⓐ 后端已具备基础：`integrated-calls.jsonl`（0600）已按次记录账单，`memory_turn_outcomes` 已持久化每轮记忆结果，`/api/balances` 已具备管理端展示模式；<br>Ⓑ 缺口：缺乏按轮聚合视图，完整 wire 输入/输出未落盘，缺少各阶段详细耗时打点；<br>Ⓒ 最薄集成方案：Next 侧通过 TraceAuthorizer 装饰器捕获调用，在 `reply()` 处记录有界环形 JSONL（0600），提供脱敏开关与控制台 `/api/trace/turns` 路由；<br>归属建议：**后续优化·待办（暂不排期）** |

## 7. 工程效能与测试分层治理（模块化测试与集成门禁）

| ID | 需求 | 设计要点与建议归属 |
| --- | --- | --- |
| R-TODO-17 | **测试按模块解耦分组与分层执行规范**：将测试套件拆分为独立模块组（TTS、STT/ASR、LLM/对话、Memory 记忆、Desktop/表现层等）。**开发单个模块时严格分开单跑测试**，避免无关模块干扰；**向用户提交交付/合并集成前，才进行全量回归更新测试** | **工程落地要点（2026-09-20 用户明确纪律）**：<br>① **现状痛点**：当前 `tools/run-tests.mjs` 仅有粗粒度分组（`default` 一把梭运行所有 memory + providers 测试），开发某一个具体模块（如仅改 TTS 或仅改 LLM）时全量跑极慢且容易受其他未配置凭据/未就绪模块干扰；<br>② **模块测试分组拆解**：<br>　• **TTS 模块组**（`npm run test:tts`）：专属运行 `minimax-tts.test.js`、`qwen-audio-tts.test.js`、`registered-voices.test.js`、`voice-enrollment.test.js`、`tts-download.test.js`；<br>　• **STT/ASR 模块组**（`npm run test:stt` / `test:asr`）：专属运行 `qwen-asr.test.js`、`media/capture.test.js` 等音频转写测试；<br>　• **LLM/对话模块组**（`npm run test:llm`）：专属运行 `aika-dialogue.test.js`、`dialogue-thinking.test.js`、`text-protocol.test.js`、`adapters.test.js` 等；<br>　• **Memory 记忆模块组**（`npm run test:memory`）：专属运行 `sqlite-store`、`memory-lifecycle`、`recall`、`dynamics` 等记忆套件；<br>　• **Live2D/表现模块组**（`npm run test:desktop`）：专属运行窗口、渲染与参数映射测试；<br>③ **双层执行工作流纪律**：<br>　• **单模块开发/调试阶段**：严禁每次全量跑，只跑对应模块的专注测试套件（实现快速反馈、高内聚、零噪音）；<br>　• **版本交付集成前阶段**：在正式向用户交付、合并功能或版本验收前，强制执行一次全量回归测试套件（`npm test` / `test:release` / `test:next`），确保全链路完整无回归后再交工。归属建议：**工程工作流治理项，立即生效执行** |

## 8. 归属建议汇总（待用户逐条确认）

- **建议并入 0.6**（在对应 SPEC 内扩展，不新增版本）：R-TODO-01/02（NEXT-03+07）；R-TODO-05/06/08（NEXT-07）；R-TODO-11 的设备选择与语音不可用诊断（NEXT-09 缺陷闭环）；**R-TODO-17 测试分组与分层执行纪律（即刻生效遵守）**。
- **【后续优化·待办】（按用户明确指示标记，当前不排期）**：
  - **R-TODO-03**：本地模型一键安装器（后续优化）；
  - **R-TODO-04**：极简 Key 配置面（后续优化）；
  - **R-TODO-14**：轮次 Trace 控制台（以后优化，待办）；
  - **R-TODO-16**：各功能模块模型全面支持用户自由定义（**【核心卡点·记得改！】彻底改掉硬编码模型白名单与计费边界拦截**：移除 `settings.ts:52/59`、`trial-config.ts:125` 的白名单报错与计费硬约束，放开任意自定义模型；归属后续优化待办）。
- **建议 0.7 待办**：
  - **R-TODO-07**：角色切换与换肤（核实当前代码及控制台完全无入口，作为 0.7 待办建立多模型扫描与切换机制）；
  - **R-TODO-09**：推理输入快照模式（按用户更新逻辑重构：冻结前缀 + 长周期/重启后台原子更新，保 KV Cache 降耗）；
  - **R-TODO-12**：语音实时逐 chunk 流式输入（核实工程架构无阻碍，代码尚无流式，按 AudioWorklet + 流式 ASR 链路实现）。
- **建议 0.8**：R-TODO-13 主动互动陪伴模式（OCR/VLM 感知 + 主动陪伴，隐私权限语义先行）。
- **R-TODO-10 握手重构**：作为 NEXT-09 验收发现项修复（缺陷闭环），或归 0.7——待用户确认。
- 0.6 已冻结的 AC 与验收门槛不因此降低；新增能力一律先写失败测试再实现。

## 9. 关联现状指针

- Provider 配置存储：`management/aika-profile.ts`（NEXT-02，AUTO_PASS）
- 对话适配器与协议选择：`providers/aika-dialogue.ts`（NEXT-03，AUTO_PASS；真实回放 BLOCKED 待凭据）
- 数据目录：`%APPDATA%/AikaNext/<mode>`（NEXT-02 已接线并实测）
- 模型/换肤流程：`windows/docs/LIVE2D.md`；NEXT-00 已实操验证（Natori 示例模型）
- 测试入口与脚本：`tools/run-tests.mjs`，`package.json`
- 本文件由用户 2026-09-20 口述需求整理；未经确认不自动升级为 SPEC。

## 10. 验收发现缺陷（BACKLOG——用户规则：不立刻修的一律登记于此）

| ID | 现象 | 初步分析与修复方向 |
| --- | --- | --- |
| R-BUG-15 | **语音回复已播放，但文字气泡未出现**（2026-09-20 用户验收 09-B 时出现一次；用户推测与两次输入过快有关） | 疑似快速连发时旧轮被新提交取消：旧轮文本事件被丢弃/气泡回撤，但已开始的 TTS 播放未被同步停止，或迟到音频回调绕过停止过滤——06-C 契约（取消后旧音频不恢复、停止后迟到播放回调被过滤）在 fake 播放端口上全绿，真实桌面播放端口接线的该时序未被覆盖。修复方向：supersede/cancel 时音频与文本状态原子切换（要么都留、要么都清）；先在 09-B 场景复现加失败测试再修。归属：NEXT-09 缺陷闭环或 0.7，待用户确认 |

## 11. 连续性与记忆系统增强（2026-09-22 登记）

| ID | 需求 | 设计要点与建议归属 |
| --- | --- | --- |
| R-TODO-18 | **【N075-01 已落地 + 后续优化】记忆提炼生命周期与频率策略**：用户明确指出：当前 MVP 版本的长期事实沉淀频率过快（每轮对话后立即触发异步提炼），正常生产环境应严格压制事实沉淀速度；同时 N075-01 前置修复要求所有生产 Distill 必须经过正式生命周期，**正确的生命周期 > 减少几次 LLM Call**。 | **【N075-01 已落地（Commit cfb6d37, 05bc40e）+ 后续优化】**（2026-09-22 落地）。<br>① **生命周期语义（N075-01 已全面落地）**：<br>　• **Raw Transcript** → 永远立即保存（immediate durable write），任何策略不得延迟；（测试 T4 验证）<br>　• **correction / forget / uncertain** → 立即进入 strict memory handling，**Pending privacy guard 不等待 batching**；（测试 T6 验证）<br>　• **普通事实提炼（ordinary additive memory）** → 经 `DistillationScheduler` 调度，后台异步执行，Foreground Reply 不等待普通 Distillation；（测试 T3 验证）<br>　• **Summary** → 保留现有 minMessages threshold scheduler；<br>　• **所有生产 Distill 必须经 `MemoryTurnPlan → validation → SqliteLifecycleState.commitTurn()`**，彻底禁止 direct SQL 写 `memory_records` / `memory_search`；<br>② **频率策略（架构支持，已预留 batching 接口）**：<br>　• `DistillationScheduler` 已实现 `per_turn` 与 `batched` 模式支持；<br>③ **权威**：`RoleMemoryLifecycleQueue` + `DistillationScheduler` + `DistillationMemoryTurnProvider`；归属：**N075-01 落地完毕，后续扩展留作 0.8** |

