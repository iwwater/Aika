# 0.75 执行 SPEC：逐界面改造范围

状态：仅规划，所有步骤未实施。更新日期：2026-09-22。

> **Runtime Truth 术语纪律（2026-09-22 起）**：本文档及 0.75 全部报告统一使用 `IMPLEMENTED`（Domain/Core 代码存在，并有单测或验收证据）、`WIRED`（正式 Production Runtime 实际消费该能力）、`EXPOSED`（Management API / Console 可以真实读取或控制该能力）三态描述完成度。禁止以下模糊表述："implemented therefore production-ready"、"accepted therefore runtime-wired"、"API exists therefore real runtime uses it"。当前正式启动装配点为 `windows/code/desktop-pet/app/trial-backend.ts`。

入口：[计划书 / RPD](RPD.md) · [接口映射](CONTRACTS.md) · [源码核对](SOURCE_AUDIT.md)。本索引及下列逐步规格是后续执行依据，不是本轮启动开发的指令。

目录：[执行规则](#1-执行规则) · [顺序](#2-步骤与依赖) · [逐步范围](#3-逐步规格) · [记录模板](#4-每个界面的实施记录模板) · [出口](#5-最终出口)

## 1. 执行规则

**强制流程：先问用户“XX 前端要改成什么样” → 等用户说明 → 随后索取本界面参考图 → 确认要求与复现范围 → 重写本界面 → 主动提交用户审核 → 根据反馈修改并再次审核 → 明确通过后才进入下一界面。** 用户明确要求视觉、布局、交互先留白；不得自行设计后批量实现。一个步骤含多个界面时，每个界面分别执行完整流程。上一个界面的批准不继承给下一个。详细规则以 [RPD 第 4 节](RPD.md#4-逐界面参考门槛) 为准。

仅非可见的接口盘点、契约适配及基础设施可先行。开发某页前还需其真实业务端口可用；其他未完成业务不应阻塞无依赖页面的独立工作，但不能用前端假实现绕过依赖。

逐页状态：`WAIT_REQUIREMENTS → WAIT_REFERENCE → REFERENCE_CONFIRMED → IMPLEMENTING → AUTO_VERIFIED → WAIT_USER_REVIEW → ACCEPTED`。除 N075-02 外，当前所有可见界面均为 WAIT_REQUIREMENTS：首次修改前先询问具体改造要求，收到回答后再进入 WAIT_REFERENCE 索取参考图。**N075-02 已收到改造要求（导航形态选定为顶部分组导航），现处于 WAIT_REFERENCE：其余布局、交互要求与参考图均未收到，不得开始实现。** 界面级证据登记在 `reports/N075-02.md`。N075-00/01 技术部分为 PLANNED。审核未通过回到本页要求/参考确认及修改流程，不能进入下一界面。状态改变必须附实际证据，不因计划写完而更新。

一次只推进一个已获参考的界面。用户提出新的参考时，仅调整该页及明确受影响的共同规范；页面功能完成与参考复现验收分别记录。参考未提供时停在该页设计门槛，允许继续无依赖的接口核对，不能自动切到别页自行设计。

## 2. 步骤与依赖

下表为业务拆分顺序，不规定最终菜单分组。除 N075-00/01 技术部分外，每步均须参考确认；N075-16 对已有界面只验证，不重新设计。

| SPEC | 改造单元 | 依赖 | 当前状态 |
| --- | --- | --- | --- |
| N075-00 | 固定基线、全量入口/功能盘点 | 0.7 实际交付边界 | **AUTO_PASS（基线盘点完成）**（[报告](reports/N075-00.md)） |
| N075-01 | 共享基础设施、运行时收口与后端契约 | 00 | PLANNED（Runtime Convergence 前置，见 N075-01 完成条件）；可见部分 WAIT_REQUIREMENTS |
| N075-02 | 控制台外壳、启动与鉴权 | 01 | **ACCEPTED（用户已确认初稿；真实桌宠已接通；登记顶栏切侧边栏 TODO）**（[记录](reports/N075-02.md)） |
| N075-03 | 桌宠右键减负与管理入口 | 02 | WAIT_REQUIREMENTS |
| N075-04 | API、Provider、模型与绑定配置 | 02；真实 Provider 管理端口 | WAIT_REQUIREMENTS |
| N075-05 | 音频、设备、试麦、唤醒设置 | 03/04；可信设备桥 | WAIT_REQUIREMENTS |
| N075-06 | 换肤及显示设置 | 02/03；皮肤和显示端口 | WAIT_REQUIREMENTS |
| N075-07 | 角色、Character Pack 与实例 | 02/04；0.7 Pack/配对端口 | WAIT_REQUIREMENTS |
| N075-08 | 记忆、纠正、遗忘、导入与队列 | 07；连续性生产接线 | WAIT_REQUIREMENTS |
| N075-09 | 双 Timeline、Soul/Wiki/关系、Context | 07/08；实际来源和预算投影 | WAIT_REQUIREMENTS |
| N075-10 | 知识库与文档管理 | 02/07；知识库端口 | WAIT_REQUIREMENTS |
| N075-11 | 插件包、能力与 Flow 管理 | 02/04；真实宿主管理端口 | WAIT_REQUIREMENTS |
| N075-12 | 总览、健康、日志、诊断和余额 | 02/11；运行状态投影 | WAIT_REQUIREMENTS |
| N075-13 | 项目、任务、工作卡片与记录 | 02；既有 Work 端口 | WAIT_REQUIREMENTS |
| N075-14 | 微信、情绪及表现策略设置 | 02；对应可选能力 | WAIT_REQUIREMENTS |
| N075-15 | 聊天抽屉、输入反馈与桌面提示 | 03/05/07/13 | WAIT_REQUIREMENTS |
| N075-16 | 入口迁移、旧 UI 退役与全量验收 | 所有已确认界面实现并逐页验收 | PLANNED |

顺序允许用户调整；调整不得绕过真实接口依赖。N075-10 的知识库独立部分可在 07 前准备，涉及角色关联的操作仍依赖配对契约。

## 3. 逐步规格

### N075-00：基线与全量清单

- 改造范围：仅盘点；记录工作树提交、未提交变更、启动方式、现有构建及定向测试。枚举 page/section、HTML、右键、快捷键、弹窗、通知、聊天/工作面板和设备控件。
- 产物：旧入口 → 逻辑功能 → 新目标（待参考）→ API/Bridge → SPEC → 验收编号的映射；复核 [FE75-01～06](SOURCE_AUDIT.md)。不能把当前文件列表当完整用户流程。
- 接口：为 [CONTRACTS](CONTRACTS.md) 的接口族补实际 method、DTO、生产装配路径和能力可用条件。
- 验收：每个旧入口均有负责人步骤；0.65 未验项与本次重写影响建立关联，不改成通过。没有代码删除或数据迁移。

### N075-01：共享基础设施、运行时收口与后端契约

2026-09-22 修订（Runtime Convergence / Backend Truth Repair）：N075-01 不再只是前端 API/routing 基建，而是 0.75 的运行时收口步骤。原前端基础工作全部保留，新增以下职责：

- **A. Production Runtime truth**：正式装配点锁定 `app/trial-backend.ts` → `BackendSession` → `NextTurnPort/DialoguePipeline`；`tools/real-backend.mjs` 明确降级为 DEV/SMOKE/EFFECT VALIDATION harness，不承载唯一生产功能。
- **B. Continuity → Dialogue Context 接线**：CharacterPackStore / ContinuityMemoryStore 成为正式 runtime dependency；ContinuityContextComposer 经只读适配进入正式 foreground context。
- **C. Background Memory 正式化**：所有生产 Distillation 经 `MemoryTurnPlan → validation → commitTurn` 正式生命周期；禁止 Production direct SQL 写 `memory_records`。
- **D. Runtime Trace 正式接线**：RuntimeTraceStore 由正式 Pipeline 产生真实 stage 记录；Context Inspector 读取真实 issued/consumed snapshot。
- **E. Provider / Binding 正式运行时适配**：正式路径经 Legacy Adapter 接入现有 ProviderRuntime，不新增第二套 registry。
- **F. Package / Flow live management projection**：Next65Management 读取正在运行的 PackageHost/FlowRuntime，消除 `loaded:false` 常量投影。
- **G. 0.75 前端所需稳定 read model / contracts**：Character/User Wiki、Continuity Timeline、真实 Turn Context 的查询投影。

同时保留原前端基础工作：`management/ui/api.mjs`、路由/页面生命周期、作用域状态、应用服务；`management/server.ts` 静态资源与构建接入；desktop Bridge 的 UI 适配；请求 epoch、cancellation、version conflict、error mapping。

**正式 Turn Authority（文档口径）**：正式文本 Turn 主链为 `NextTurnPort → TurnController → DialoguePipeline → Memory/Context/DialogueProvider`。`FlowRuntime` 已实现，但当前不是取代 DialoguePipeline 的统一生产对话总调度器；`NextTurnPort` 源码仍是 `TurnController + DialoguePipeline` 的薄适配层。文档不得把 FlowRuntime 描述为已接管生产对话。

- 复用边界：唯一配置/数据库/Runtime；管理请求与 desktop transport 分离。共享语义可复用，设备资源不能迁到普通浏览器控制台。禁止为 0.75 新建第二条 Dialogue Pipeline、第二套 Wiki 数据库或第二套 Memory 生命周期。
- 接口：沿用同源鉴权；定义请求 epoch、配对/实例标识、取消、版本冲突、错误映射、能力状态。新 DTO 必须与后端共同验证，不仅写前端类型。
- 参考门槛：本步不先画导航或通用弹窗。若要实现可见组件，按该组件索取参考并确认。
- 验收：无硬编码 companion；保留旧校验语义并扩大作用域隔离；迟到响应/双页编辑冲突/鉴权失效可重现；构建后资源真实可加载；运行时收口各项以下述完成条件为准。

**N075-01 完成条件（Definition of Done）**：满足 [RPD 第 3 节](RPD.md#3-需求与完成标准) 之外，还必须同时满足 [Runtime Maturity Matrix](CONTRACTS.md#6-runtime-maturity-matrix) 与 [N075-01 DoD 清单](#n075-01-definition-of-done)。没有满足 DoD 前，`N075-01 != ACCEPTED`；文档与报告必须用 `IMPLEMENTED / WIRED / EXPOSED` 三态区分完成度，不得把"代码存在"等同于"正式可用"。

#### N075-01 Definition of Done

- [ ] `trial-backend → BackendSession → DialoguePipeline` 是唯一正式文本主链；`tools/real-backend.mjs` 仅作 dev/smoke harness。
- [ ] CharacterPackStore、ContinuityMemoryStore 成为正式 runtime dependency（open 后持久持有并注入下游）。
- [ ] ContinuityContextComposer 数据真实进入 Production Dialogue Context；User Soul / User Wiki / Relationship 至少能影响真实 Dialogue LLM Context；Character Soul / Canon Timeline / Companion Timeline 至少进入正式 ContextSource 管线。
- [ ] 正常对话仍只有一次 Dialogue LLM Call；Raw Transcript 立即写入；普通 Distillation 后台执行不阻塞前台。
- [ ] correction / forget / uncertain 的 privacy guard 不被 batching 破坏；自动 Distillation 不经 Production direct SQL 写 `memory_records`；长期 Memory 写入经 `MemoryTurnPlan → validation → commitTurn`。
- [ ] RuntimeTraceStore 由正式 Pipeline 产生真实记录；Context Inspector 展示真实 issued/consumed Context。
- [ ] ProviderRuntime、PackageHost / FlowRuntime 被复用，不存在第二套 registry/runtime；Next65Management 读取 live runtime。
- [ ] Companion Timeline latest-N 修复；Skin / Knowledge Library 后端无回归；不新增 Wiki 数据库、不新增第二条 DialoguePipeline。
- [ ] 文档统一 `IMPLEMENTED / WIRED / EXPOSED`；0.7 文档不再把 Core Acceptance 写成 Production Wiring。
- [ ] 新增 integration tests 全绿；原有核心测试全绿（`test:next07`、memory lifecycle、knowledge、skin、0.65 package/provider/flow）。

### N075-02：控制台外壳与启动流程

- 待参考界面：控制台框架、导航、首次进入/配置、Token 失效、服务未启动/慢启动/重连、未知页面。
- 改造范围：`app.mjs`、`index.html`、`style.css`、`dom.mjs`、`self-setup-view.mjs` 中外壳/启动职责；业务设置留给后续步骤。
- 接口：snapshot、self-setup、会话启动；旧 `/aika.html` 和 `#page/#section` 建迁移映射。目标路由命名待参考后确定。
- 验收：Token 消费后从地址移除；重连不丢草稿；后退/刷新/深链落到正确功能；空态/不可用不伪装在线。
- **TODO（用户明确登记，当前不实现）**：增加控制台布局切换功能——支持将顶部导航栏切换为左侧侧边栏布局，保留为后续外观与布局定制能力。

### N075-03：桌宠右键与设置入口

- 待参考界面：右键菜单本体、必要的二级入口、控制台打开中/失败反馈。菜单数量、排序、分组和保留哪些快捷操作均留白。
- 改造范围：`pointer-router.ts` 的入口目录、`desktop/main.mjs` 的 function panel、相应 HTML/CSS、管理目标映射及宿主结果处理。
- 接口：open_management/managementResult、open_chat、set_click_through；对未知目标拒绝或明确引导，不跳转脚本文件。
- 验收：右键仍存在且按参考减负；移出的功能在控制台可达；知识库/Timeline/诊断/状态链接正确；穿透恢复、菜单焦点与聊天草稿不回归。不得重写桌宠触摸动效。

### N075-04：API 与模型配置

- 待参考界面：来源列表/新增编辑、API 凭据、模型发现、参数、阶段绑定、连接测试、保存/冲突/回退结果。逐个索取参考，不一次批准所有表单。
- 改造范围：现有 modelsView、aika-view 的重复模型表单、self-setup 的 Provider 部分；合并应用服务，替换已确认页面。
- 接口：settings/discovery 加 ProviderRuntime 管理适配；区分 capability/adapter/source/model/binding。凭据引用归服务端；不把明文配置散落浏览器存储。
- 验收：同 adapter 两个来源可独立配置；真实 bindingId 解析；发现取消、认证失败、保存冲突、待重启和未生效各有正确结果；连接测试不偷偷发起模型调用或消耗配额，是否真实调用须有明确操作语义。

### N075-05：语音与设备设置

- 待参考界面：输入设备/试录回放、STT/TTS 来源与音色、试听、唤醒设置、设备权限/丢失/占用反馈。
- 改造范围：`mic-test-panel.mjs`、语音设置相关 view、wake-view、对应桌面控件。Provider 来源配置复用 04，不复制一套 API 表单。
- 接口：microphone/wake/self-setup voice、可信 mic-test Bridge；原 STT/TTS 播放与轮次权威保持。
- 验收：离页释放资源、试麦与正式采集互斥、取消不迟到重连、音频对象释放。真实麦克风/试听效果另列人工证据；不在本步升级语音引擎。

### N075-06：换肤与显示设置

- 待参考界面：皮肤列表、详情/预览、导入、激活/移除确认、显示模式和尺寸设置。
- 改造范围：skin-view、display-controls 及其控件和反馈；UI 调用适配可修改，Cubism renderer 和模型表现不重写。
- 接口：skins 注册/导入/激活/移除；set_display、resize_model 和 displayConfig；实际使用中的皮肤处理遵循后端限制。
- 验收：导入失败不丢当前皮肤、换肤不改人格/知识库/记忆、尺寸 commit/cancel 和持久化正确；点击/拖拽/穿透恢复回归。

### N075-07：角色与 Character Pack

- 待参考界面：角色库、来源导入/证据、提炼任务、草稿/差异、激活/升级/回退、角色实例切换。
- 改造范围：旧 profile/Prompt 编辑入口与新增 Pack 管理界面；消除仅支持 companion 的前端假设。
- 接口：0.7 CharacterPackStore/CharacterDistiller 的正式管理适配、配对与实例投影；旧 profile/prompt 只能承接其真实语义。
- 验收：证据可追溯；失败草稿不能激活；升级回退不串实例；切换发生点与活跃对话一致。后台提炼取消和前端停止轮询分别确认。

### N075-08：记忆操作与数据维护

- 待参考界面：记忆总览/列表/详情、来源、候选审核、纠正、遗忘影响、策略/维护、历史导入、待处理队列。
- 改造范围：memoryView、memory-dynamics、memory-import、pending-memory 及记录编辑状态；所有子界面逐个确认。
- 接口：records/edit、memory/*、memory-import/*、memory-pending/*、continuity 的 promote/correct/forget；按实际数据层路由，界面不自行串多次写操作模拟原子事务。
- 验收：版本冲突保留草稿；同操作重试遵循后端幂等；遗忘影响来自实际失效结果；切换配对后迟到请求不串线；导入暂停/恢复由真实任务状态驱动。

### N075-09：Timeline、Wiki、Soul、关系与 Context

- 待参考界面：Canon/Companion Timeline、Character Wiki、User Wiki、User Soul、关系覆盖、Context 来源/预算/召回与缓存解释。每个界面各自取参考。
- 改造范围：aika-view 旧 Timeline、context/traces 与新增连续性管理界面；编辑/纠正流程复用 08 的服务语义。
- 接口：旧聊天 Timeline 保留原含义；新双线/Character Wiki/完整 Context 投影按 CONTRACTS 第 3 节补齐。continuity snapshot 使用 POST 和明确 pairing。
- 验收：剧情顺序与现实日期不混；来源/推断/自设可区别；User/Character 数据不串；预算解释对应实际轮次而非前端估算；失效数据不继续显示为有效事实。

### N075-10：知识库

- 待参考界面：库列表、创建/重命名、激活切换、文档导入/列表/详情、删除与失败处理。
- 改造范围：knowledge-view 接入正式可路由页面；修复右键落点。普通文档知识库与 09 的角色/用户 Wiki 保留业务区别。
- 接口：knowledge-routes 现有 API、libraryId 和修订检查；激活结果以真实会话生效规则为准。
- 验收：切库不串文档；异步错误可见；删除/导入失败不伪成功；刷新和右键直达同一库页面。

### N075-11：包与 Flow

- 待参考界面：包列表/详情/导入、启停/更新/卸载影响、能力与依赖、Flow 列表/配置/校验/激活及错误。
- 改造范围：next65-view 与管理入口，补 Next65Management 到真实宿主的管理适配。图形拖拽 Flow 编辑器不默认加入；是否采用图形形式等待用户参考和范围确认。
- 接口：packages/lifecycle、profiles/validate/preview/save 与实际激活/诊断投影；不能把管理类实例等同生产 Runtime。
- 验收：缺包/依赖失败/待重启/运行失败可区别；显示实际 loaded 状态；管理列表不启动未选引擎；禁用/卸载影响经真实宿主验证；外部本地服务停止边界不变。

### N075-12：总览与诊断

- 待参考界面：运行总览、模块健康详情、事件/日志、诊断筛选、余额和凭据配置、错误详情。
- 改造范围：overviewView/eventsView、health-view、balances-view；统一状态来源和深链。
- 接口：snapshot/health/balances 与运行诊断；包状态引用 11，Provider 状态引用 04。刷新/订阅离页停止。
- 验收：离线不显示旧快照为正常；余额未知不写零；秘密字段在服务端及界面均不泄漏；日志详情与当前作用域匹配。

### N075-13：项目与工作任务

- 待参考界面：项目索引、任务转发/详情、工作卡片、历史记录、结果/错误/取消反馈。
- 改造范围：projects-view/tasks-view、desktop work-card/work-records 与相应布局。工作 Runtime、Work 绑定和取消权威保留。
- 接口：现有视图真实调用及 Bridge；本步骤开始前核实完整 method/DTO。0.8 ACP/MCP 新能力仍在 0.8，不提前重写引擎。
- 验收：任务身份不因切页丢失；重复点击不重复执行；取消/完成/迟到事件正确；工作卡片恢复原输入和显示记录不破坏聊天草稿。

### N075-14：连接与附加设置

- 待参考界面：微信连接/状态、当前情绪、表情动作策略配置/预览及清单中新发现的其他设置页。
- 改造范围：wechat-view、emotion-view、presentation-view；唤醒和余额分别归 05/12，避免重复改造。
- 接口：wechat/emotion/presentation；缺包禁用来自能力状态。修改表现参数的 UI 可以重写，表现效果与 renderer 不重写。
- 验收：关闭页面释放轮询/预览；配置冲突有真实反馈；预览不污染生产设置；可选功能不强装。

### N075-15：聊天和桌面周边反馈

- 待参考界面：聊天抽屉、输入区、连续消息、历史与滚动、录音/播放/打断状态、Toast、捕获提示、快捷键帮助及残余弹窗。
- 改造范围：desktop/main 的 UI 职责、chat-log/capture-feedback 对应呈现、HTML/CSS；与 13 工作卡片、05 设备控件衔接。
- 接口：既有输入/播放/工作 transport 与 scope/requestId；保持唯一轮次、取消、播放事件来源。
- 验收：流式消息不重复；滚动/草稿不因菜单或切页丢失；旧会话事件不覆盖新会话；输入焦点、快捷键、播放中断与右键互不干扰；桌宠画面表现回归。

### N075-16：迁移收口与验收

- 改造范围：旧入口重定向/兼容、静态资源表、失效 import、重复 UI 模块退役；只删除已有替代且验收的旧页面。
- 接口：检查启动 token、所有 page/section/Bridge 目标、配置兼容与回退；回退界面不倒退数据库。
- 自动验收：功能映射无遗漏；逐页错误/冲突/作用域/取消测试、受影响回归、check/build、实际安装产物加载。按改动选测试，不用全套计数代替有效证据。
- 人工验收：逐页对照用户参考；桌面操作与设备测试保留真实记录；对 0.65 原 32 项仅更新实际已验部分。
- 出口：所有本版界面 ACCEPTED、无不可达旧功能、无占位假成功、无表现引擎回归。任何 WAIT_REQUIREMENTS/WAIT_REFERENCE/WAIT_USER_REVIEW 均阻止宣布全前端完成。

## 4. 每个界面的实施记录模板

每个步骤实施时，为其中每个界面单独登记，不要提前填入臆测的设计。记录可放 `reports/N075-xx.md`，未实施不创建通过报告。

| 字段 | 当前填写规则 |
| --- | --- |
| 界面 ID、名称、所属步骤 | 从完整功能清单登记；弹窗/子页具有独立 ID |
| 本轮“XX 前端要改成什么样”的询问与用户回答 | 留白，每次修改前核实；已有具体意见不重复询问 |
| 用户参考图与收到时间 | 留白，用户说明要求后索取；无需图片或继续沿用原图须记录用户明确决定 |
| 用户确认的复现范围 | 留白，包含布局、交互、保留/调整项 |
| 不同状态及子界面参考 | 留白；缺少部分继续向用户核实 |
| 涉及文件与旧入口 → 新入口 | 实施前基于固定基线填写 |
| API/Bridge、DTO、权限/版本/取消 | 从契约映射核实后填写 |
| 接口缺口与前置步骤 | 明确负责人；未就绪不虚构成功 |
| 自动验证与真实联调证据 | 实际运行后填写 |
| 截图/运行路径与参考对照 | 实现后填写 |
| 主动提交审核的截图、运行方式与请求 | 实现及验证后填写，不等用户自行发现已完成 |
| 用户逐页审核、返工意见与再次审核 | 用户反馈后填写；明确通过才进入下一界面，不自行记为通过 |

## 5. 最终出口

计划书完成只表示版本范围已拆清楚。进入实施仍需用户发起对应开发，并逐界面提供参考。当前没有任何已确认视觉方案，也没有任何已完成前端重写。
