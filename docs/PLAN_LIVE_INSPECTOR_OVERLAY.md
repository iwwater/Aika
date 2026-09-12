# 下一阶段开发规划 · 会话实时检查悬浮窗（Live Inspector Overlay）

日期：2026-09-13
状态：已审阅拆分为LLM-11、FE-23～25；尚未实现。各SPEC为执行依据。
参考：DeepSeek Harness 会话「轨迹」视图（用户提供截图：泳道时间线 + 事件检查器）
关联：[调试工作台规划](PLAN_DEV_DEBUG_WORKBENCH.md)（F1～F8 已交付）、[进度与未完成项](WORKBENCH_PROGRESS.md)、[frontend PRD](frontend/PRD.md)、[llm PRD](llm/PRD.md)、[共享契约](modules/CONTRACTS.md)

---

## 0. 触发问题

用户反馈（2026-09-13，原话拆解）：

1. 现在的开发者模式「没意义」：工作台是独占整屏的页签——打开时聊天区整个被 `hidden` 掉（`App.tsx` 的 `hidden={showDevTools}`），想看一眼「这轮注了什么记忆」必须中断对话、切屏过去、看完再切回来。
2. 真正想要的是三样东西，在对话进行时于一旁的**悬浮窗**里直接可见：
   - 这一轮**注入了哪些记忆**（内容本身，不只是来源名）；
   - **上下文是怎么摆放的**（分块、顺序、预算、谁被裁掉）；
   - **数据流**走到了哪一步（现有「数据流」页那张八阶段图的实时版）。
3. 定位是**新增工程能力**，不是重做：现有工作台保留（「原本的做的不是很直观，但是可以保留」），悬浮窗是它的常驻轻量前台。
4. 交互形态参考 DeepSeek 轨迹视图：泳道时间线、点击事件弹出检查器（概述/参数/结果/计时）、顶部统计条、Session 日志导出。

## 1. 现状盘点：能复用什么，缺什么

**已有、全部可复用：**

| 资产 | 位置 | 与本计划的关系 |
| --- | --- | --- |
| `TraceEventV1` 八类事件协议 | `domain/trace.ts`（LLM-06） | 时间线与检查器的数据源，不动 |
| `TraceRecorder` 单漏斗：seq 编号 + 唯一脱敏点 | `services/trace/traceRecorder.ts` | 实时推送的天然挂点（见 F11） |
| SQLite + 内存环形双 sink，fail-open | `services/trace/sqliteTraceSink.ts` 等 | 历史查询继续走它，不改 |
| 八阶段一轮数据流 `turnFlow()` | `domain/pluginGraph.ts`（FE-10 交付） | 悬浮窗里的实时数据流直接复用 |
| 事件一句话摘要 `summarizeStep`、JSONL 序列化 `toJsonl` | `pages/TracePage.tsx`、`domain/traceView.ts` | 检查器概述与日志导出的底子 |
| `devMode` / `traceEnabled` / `traceIncludeText` 开关 | `devToolsPresenter.ts`（LLM-07 语义） | 悬浮窗沿用同一套，不开第二条采集管线 |

**缺口（本期要补的四件事）：**

1. **看不到内容**：`context_assemble` 只带 `retrievedSources`（来源名数组）和 `droppedSources`（裁剪原因）；`provider_request` 只带 80 字 `instructionsDigest`。注入了哪几条记忆、每条内容是什么、摆在哪个位置、谁被预算裁掉——事件里没有。
2. **看不到实时**：`DevToolsPresenter` 是「打开时读 + 手动刷新」，没有订阅。该文件头注释写着「真要实时，等 sink 有了订阅能力再说」——就是现在。
3. **看不到在一旁**：没有浮层形态，工作台与聊天互斥。
4. **没有时间线与检查器**：Trace 页是轮次卡片 + 平铺事件列表，没有按时长的泳道瀑布，也没有单事件详情。

关键事实：**数据早就算出来了**。`ContextAssemblyResult.context` 里就有最终保留的 `memories/knowledge/environment` 全量 snippet（id / category / content / precision / temporal），`companionRuntime.emitTrace()` 拿到它却只记了来源名（`companionRuntime.ts:470-494`）。所以本期是一次「把已经算出来的东西记下来、送出去、画出来」的任务，**不改检索/预算策略；允许在装配裁剪点添加诊断，最终结果不能还原已裁内容**。

## 2. 参考拆解：DeepSeek 轨迹视图借什么

| DeepSeek 做法 | 本仓库对应 | 取舍 |
| --- | --- | --- |
| 顶部统计条：轮数·步数、LLM/工具耗时、首 token 平均、tok/s、缓存命中 | 轮数/事件数从事件流可算；耗时在 `turn_end`、首 token 在 `provider_stream_meta` | 做精简版。tok/s 与缓存命中无数据来源（provider 未透出 cached tokens），**不做**——不摆没有依据的数字 |
| 三条泳道（输入/模型/工具）+ 时长条 + 轮次标记 | 我们的阶段天然是八个：用户 → 装配 → 请求 → 流式 → 回复 → 抽取 → 播报 → 收尾 | 合并成 3～4 条泳道；没有独立时长的事件画标记点，不杜撰条宽 |
| 事件行内联「参数 → 结果摘要」 | `summarizeStep` 已是同一思路 | 沿用并加宽信息量 |
| 点击事件 → 右侧检查器：概述/参数/结果/Schema/计时，层级/状态 | 概述 = 增强版摘要；参数 = 全字段表 + pretty JSON；计时 = 时刻/轮内偏移/耗时；层级 = turnId + seq | **Schema 页不做**：没有外部 Tool Runtime，事件没有 schema 可看（等真实 tool call 落地再议） |
| Session 日志下载 | `toJsonl` 已有 | 直接加下载按钮（.jsonl） |
| 工具/子工具两级嵌套、会话列表、PTC 模式 | 单会话应用、无外部工具 | 不做 |

## 3. 目标与非目标

**目标**

1. 对话进行中、聊天不被遮挡、不切屏：悬浮窗实时显示本轮注入的记忆清单（含内容与元信息）、上下文分块摆放与预算裁剪、数据流阶段点亮、事件时间线与单事件检查器。
2. 数据底座补齐：新增内容级 `context_snapshot` 事件与 `TraceRecorder` 实时订阅；脱敏管线保持只有一条，悬浮窗看到的数据与落盘完全同源。
3. 原工作台五个页签原样保留，与悬浮窗共享同一开关与数据源。

**非目标（本期不做）**

- 独立 OS 窗口 / Tauri 多窗口 / 投第二块屏幕（后置，见 §8-1）。
- 外部可视化后端（OTEL/Phoenix/Langfuse 维持不引入）。
- 检索算法、预算策略、Provider 协议（`ReplyEnvelopeV1`）的任何改动；F9 成本页照常独立推进，互不等待。
- 工具调用可视化（无外部 Tool Runtime，`actions` 仅 sticker）。

## 4. 功能规划

### F10 上下文装配快照事件（llm 模块，数据先行）

- 新事件 `context_snapshot`，紧跟 `context_assemble` 发出，一次一条，承载「这一轮上下文最终长什么样」：
  - 预算四元数：`inputLimit / outputReserve / safetyReserve / available`（available = 前三者算出的可用额）；
  - 必需块及各自 token 估算：characterSoul、mode、relationship、clock、userSoul、query；
  - 历史：保留条数、被裁条数、`recentTurnLimit`；
  - 摘要：保留/被裁；
  - 三个 section 的 snippet **全量清单**：`id / category / content / precision / temporal / source / token 估算 / kept|trimmed`。被预算裁掉的那部分也在这里列出并标 `trimmed`——「想注入但没挤进去」和「根本没检索到」是两个相反的排查方向（对齐 FE-10 的既有原则）。
- 可选增强（如实现成本超预期则砍掉，不阻塞验收）：`provider_request` 增加可选 `instructionsBlocks: { name, chars }[]`——`providerAdapter.ts` 调 `buildInstructions` 处九个块各有边界，顺手可数。它是「最终请求里怎么摆」的直接测点。
- 脱敏：`content` 类字段沿用现有 `traceIncludeText` 开关——关时 `content: null`、其余元信息照带（**结构永远可见，正文看用户选择**）；整条事件照旧过 `redactTraceEvent` 单点。
- 兼容：只新增 kind，不改 v1 既有事件字段；`TraceRecorder` 的 `DistributiveOmit` 模式天然接纳新成员。跨模块接口变化记入 [CONTRACTS.md](modules/CONTRACTS.md)。

**AC 示例**：fake 源装配后事件含全部保留 snippet 与 trimmed 清单；`includeText=false` 时 content 为 null 而 category/precision/temporal 照带；recorder 关闭时零事件零成本（沿用现有行为）；sink 抛错不影响主链路（现有 fail-open 用例扩展到新事件）。

### F11 悬浮窗外壳与实时推送（frontend + services/trace）

- **外壳**：绝对定位浮层，挂 `app-shell` 顶层（z-index 高于 `::after` 扫描线层），默认停靠右侧、可拖动、可折叠成小胶囊、宽度可调。标题栏新增独立入口图标（devMode 开启才出现，与工作台的 Bug 图标并列，二者可同时开）。
- **红线**：绝不给 `.workspace` 挂 `hidden`——FE-09 时代 `.workspace[hidden] { display:none }` 与 grid 的那场事故（[界面冒烟报告](frontend/reports/UI_SMOKE_BROWSER.md)）就是这条路出的。
- **实时推送**：`TraceRecorder` 增加订阅口（`subscribe(listener)` 或 `onEvent` 回调，SPEC 定），在 `sink.append` 同一次调用里 fanout **脱敏后**的事件；监听器抛错一律吞掉（与 sink 同一 fail-open 纪律）。悬浮窗 Presenter 打开时先订阅并缓冲增量，再query历史，按epoch/turnId/seq去重合并，内存只留最近 N 轮。
- **开关语义**：悬浮窗跟随现有 `traceEnabled`——关着时显示空态 + 一键开启引导，**不另起「只内存不落盘」的第二条采集管线**（隐私口径只有一条，见 §8-2）。

**AC 示例**：悬浮窗打开时聊天区仍可正常收发与滚动；广播监听器抛错不影响对话与落盘；关窗后退订（不再有增量进入 Presenter）；trace 关闭时为引导空态而非空白。

### F12 时间线与事件检查器（frontend）

- **泳道时间线**：每轮一行，阶段条按真实时长比例绘制（有配对测点才画实际耗时；相邻at差只能标事件间隔），无时长的事件画标记点；轮次之间加分隔标记（对齐参考图的「第 N 轮」）。默认**跟随最新一轮**自动滚动，可点锁 historical 轮。
- **事件检查器**：点击事件行，浮层内展开详情——概述（增强版 `summarizeStep`）/ 参数（全字段表 + pretty JSON）/ 计时（绝对时刻、轮内偏移、可算出的耗时）。不做 Schema 页（§2）。
- **统计条**：精简版——本轮耗时、首 token、chunk 数、事件数、估算/上报 token。
- **Session 日志导出**：当前选中轮或全部事件的 `.jsonl` 下载（复用 `toJsonl`）。

**AC 示例**：fixture 事件流驱动下瀑布宽度与时长成比例、无时长事件为标记点；检查器各字段与事件一一对应、缺失字段显示「—」而不是 0；导出内容与页面 JSONL 视图逐字节一致。

### F13 上下文摆放视图与实时数据流（frontend）

- **上下文摆放**：按 `context_snapshot` 渲染布局树——必需块（soul/mode/关系/时钟/画像/本轮问题）→ 历史（保留 N 条、裁 M 条）→ 摘要 → 记忆/知识/环境三个 section，每块带 token 估算与预算余量条，被裁项显式标 `trimmed` 及原因。
- **记忆注入清单**：每条记忆一行——类别、置信（confirmed/unknown）、时间性（current/past）、来源、token 占用、内容（`includeText` 开着时）；`content: null` 时只展示元信息并注明「正文未记录」。**这是用户第一诉求的直接落点。**
- **实时数据流**：复用 `turnFlow()` 八阶段，紧凑横条实时点亮；失败轮指出停在哪一步（对齐 FE-10 行为，缩成浮层尺寸）。
- 本 SPEC 纯渲染：数据全部来自 F10/F12，不新增任何采集。

**AC 示例**：同一条 `context_snapshot` 事件渲染出的布局树与 `ContextAssemblyResult` 逐字段一致（纯函数可测）；预算条在超限与裁剪场景显示正确；八阶段图与工作台数据流页对同一事件序列结论一致。

## 5. 接口与架构草案

```
domain/trace.ts               + kind "context_snapshot"（F10，llm 模块）
services/runtime/companionRuntime.ts   emitTrace 旁多记一条快照（F10）
services/trace/traceRecorder.ts        + 实时订阅口（F11，广播脱敏后事件）
presentation/inspectorPresenter.ts     新 Presenter：订阅增量 + query 补历史，
                                       快照 { turns, followLatest, selectedTurnId, layout, flow }
domain/contextLayout.ts                纯函数：context_snapshot → 布局树（F13 可测面）
pages/InspectorOverlay.tsx             浮层外壳 + 时间线 + 检查器 + 三视图（F11–F13）
composition.ts                装配：recorder 订阅 → presenter；新 token 放各自接口旁
```

- 原则不变：Trace 是旁路，任何新环节（订阅、渲染）故障不得影响对话主链路。
- `resolve()` 纪律不变：presenter 经 `useService` 取，UI 只订阅快照、派发命令。
- 悬浮窗与工作台各自独立 Presenter、共享 sink 与设置服务，互不引用对方状态。

## 6. 里程碑与 SPEC 拆分

| 里程碑 | 内容 | SPEC | 出口 AC（示例） |
| --- | --- | --- | --- |
| M0 | F10 快照事件 | `LLM-11`（llm/specs/） | 新事件内容/脱敏/关停零成本/fail-open 四组用例全过；现有 trace 测试不回归 |
| M1 | F11 外壳 + 实时推送 | `FE-23`（frontend/specs/） | fake sink + fake 订阅下：聊天不被遮挡、增量实时到达、退订干净、监听器抛错被吞 |
| M2 | F12 时间线 + 检查器 + 导出 | `FE-24` | fixture 事件驱动全部渲染纯函数化验证；导出与视图一致 |
| M3 | F13 摆放视图 + 记忆清单 + 实时数据流 | `FE-25` | 布局树与装配结果逐字段一致；记忆清单含 trimmed 项 |

执行顺序 M0 → M1 → M2 → M3，一次一个 SPEC；验收报告落 `docs/<module>/reports/`。页面行为全部用 fake sink / fixture 事件驱动（沿用工作台既有做法，无 DOM 测试环境，Presenter负责状态测试，DOM/浏览器负责交互证据）；真实链路目视留 INT-01 或下一次「真实一轮验证」顺带补，**mock 不冒充真实模型对话质量**。

## 7. 风险与边界

- **隐私**：`context_snapshot` 是首个携带记忆正文的事件。闸门沿用 `traceIncludeText`（默认关→content 为 null），整条事件仍过唯一脱敏点；订阅广播的是脱敏后事件，**悬浮窗永远看不到比落盘更敏感的数据**；类型无key字段不能保证正文无秘密；脱敏canary用例与正文闸门必须验证。
- **性能**：订阅是同步 fanout，监听器异常必须吞掉；悬浮窗关闭即退订；Presenter 内存只留最近 N 轮（默认 50），历史查 sink；渲染按事件条数设上限，超出折叠。
- **布局**：浮层不得挤压 `workspace` grid 列宽（绝对定位脱离文档流），不得复用 `hidden` 属性切换显隐；窄窗（<720px 媒体查询区）自动收成胶囊。
- **范围蔓延**：不做检索门控优化、多窗口、OTEL、工具调用树；检查器不做 Schema 页。保留五页签功能；新增事件穷举与共同隐私投影的必要适配允许修改。

## 8. 待确认问题（评审时定）

1. **悬浮窗形态**：推荐**应用内浮层**（可拖拽/折叠/停靠右缘）。理由：浏览器开发模式同样可用、不引入 Tauri 多窗口 IPC、不需要常驻置顶权限；参考图的价值在信息结构不在窗体。若日后要投到第二块屏幕，再立项 Tauri 多窗口（届时本计划的 Presenter/数据层原样复用）。
2. **Trace 关闭时悬浮窗是否可用**：推荐**不可用 + 引导开启**。理由：保持「采集管线只有一条」，避免「落盘关着却还在采正文」的隐私矛盾；备选方案是增加 live-only（只内存不落盘）模式，代价是脱敏与开关语义要拆开讲清楚。
3. **记忆正文的开关**：跟随 `traceIncludeText` 还是独立开关？推荐**跟随**——「正文进不进本地记录」语义不变，不新增第二个让人理解成本翻倍的开关。
4. **`instructionsBlocks` 可选增强做不做**：推荐做（一处顺手埋点，换来「最终请求分块占比」这张最直观的图）；若评审认为 M0 膨胀，砍掉不阻塞，后补不破坏兼容。

## 2026-09-13 评审裁决

应用内浮层、同一Trace开关、正文跟随traceIncludeText采用原推荐；instructionsBlocks仅可选。详细AC见[LLM-11](llm/specs/LLM-11_CONTEXT_SNAPSHOT.md)、[FE-23](frontend/specs/FE-23.md)、[FE-24](frontend/specs/FE-24.md)、[FE-25](frontend/specs/FE-25.md)，与本提案描述冲突时以这些已修订SPEC为准。裁剪前诊断不得从最终context反推；事件间隔不冒充阶段实耗；历史查询与订阅需要原子合并。此处决策仅本地工程范围，不构成人工验收。
