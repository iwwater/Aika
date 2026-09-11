# 下一阶段开发规划 · 开发者模式与调试工作台（v0.5 提案）

日期：2026-09-11
状态：提案（待评审拆 SPEC）
参考：[waku-agent](https://github.com/ShenSeanChen/waku-agent)（ShenSeanChen，MIT）的 Dashboard / Trace / Memory / Ops 设计
关联：[总 PRD](PRD_V0.4.md)、[frontend 模块](frontend/PRD.md)、[llm 模块](llm/PRD.md)、[共享契约](modules/CONTRACTS.md)

---

> **执行进度（2026-09-12）**：F1～F4 与 F6 的前置已交付，F5/F6 进行中，F7/F8/F9 未开始。逐项状态、接手建议与全局未验证项见 [调试工作台 · 进度与未完成项](WORKBENCH_PROGRESS.md)。

## 0. 触发问题（本期必须先修）

### 0.1 双语对照失效（图一反馈）

**现象**：气泡里正文和中文小字是同一句中文，重复显示两遍；且正文本应是日语。

**根因**（已在代码中定位）：

1. `openai-compatible` 协议不支持 `json_schema` 结构化输出，双语靠提示词约定 + `parseCompanionReply` 容错解析。模型（qwen-plus）这一轮直接把 `replyText` 和 `translation` 返回了同一句中文——协议上合法（两个字段都是非空 string），前端照单全收。
2. 渲染处（`App.tsx` 消息气泡）无条件渲染 `message.chineseTranslation`，没有"翻译与正文相同则不显示"的兜底。

**修复方向**（小改，随下个 SPEC 顺手带出）：

- 前端 display guard：`chineseTranslation` 与正文相同时不渲染次级字幕。判定放 domain 层，配单测。
- 长效手段归 F3：协议层回包进 Trace 后，这类"协议合法但语义退化"的回复才能被看见、被统计。

> **2026-09-12 更正（已由 [FE-04](frontend/specs/FE-04.md) 实施，验收见 [报告](frontend/reports/FE-04_ACCEPTANCE.md)）**
>
> 1. 上文根因 2 说的"无条件渲染"不准确：`App.tsx` 改前是 `showTranslation && message.chineseTranslation`，受用户开关控制，缺的只是同句判定这一层。
> 2. **原列出的"提示词强化"一条已删除，不要执行**：`prompt.ts:71` 本来就写着「整句本来就是中文时，两个字段写成一样即可」，模型返回两句相同中文是遵守提示词；`CODE_SWITCH_RULE` 又刻意规定日/中/英无主次、不设默认语言。要求"replyText 必须是日语"会推翻角色设定。
> 3. 原括注的"或正文本身已是中文"也已删除：`detectLanguage` 把纯汉字日语（「大丈夫」「了解」）判成 zh，按语言去字幕会误杀真正需要翻译的句子。实际实现只比较"是不是同一句"（`domain/conversation.ts` 的 `displayTranslation`），函数名 `presentationMessage()` 未采用。

---

## 1. 参考对象：waku-agent 值得借鉴什么

waku 是本地优先个人 Agent（Python，四支柱：Harness / Loop / Memory / Eval）。与本仓库（Tauri + React + SQLite）形态相近，它的调试可见性设计直接可借鉴：

| waku 做法 | 对本仓库的启示 |
| --- | --- |
| Trace 默认常开：每轮追加 JSONL 到 `.waku/traces/`，事件序列 `turn_start → gate → llm → tool → llm → turn_end` | 我们已有 `TurnTrace`（runtime `onTrace`，目前只进日志/报告），需要升级为**结构化、可持久化的事件流**（F3） |
| Dashboard 八个 Tab：Overview / Gateway / Loop / Graph / Memory / Tools / Data(SQLite 浏览器) / Ops | 直接映射成本期 F4–F9 的页面清单 |
| Graph 页由引擎 `describe()` 实时画拓扑，"图不会与代码漂移" | 我们的 plugin 注册表本来就有 `requires/provides` 元信息，**架构图可以从装配数据生成**而不是手画（F6） |
| 成本账本 `.waku/usage.jsonl`，按日/按供应商分解 | token/成本记账从 Trace 派生（F9） |
| 检索门控（廉价模型决定是否查记忆） | 后置；本期先让检索决策**可见**，门控优化再立项 |
| Phoenix/OTEL 深度可视化 | 明确**不引入**，本地 JSONL + 自渲染足够，避免依赖 |

**不照搬的部分**：waku 前端是纯静态无构建；我们是 React + Vite，走组件化路由。waku 的多通道 Gateway（Telegram 等）不在本期范围。

---

## 2. 目标与非目标

**目标**

1. 修复双语对照退化，补齐消息级交互（发音 / 撤回 / 重试 / Rewind）。
2. 建成开发者模式工作台：Trace、能力调用链、数据流图、长期记忆管理、存储浏览、成本统计。
3. Trace 采集为后续一切调试/评测功能的数据底座，先立协议再立页面。

**非目标（本期不做）**

- 不引入 OTEL/Phoenix/Langfuse 等外部可视化后端。
- 不做检索门控优化、多会话并行、云端同步。
- 不改 Provider 协议本身（`ReplyEnvelopeV1` 不动，Trace 是旁路）。
- Live2D / 声学调优继续按既有后置规则，不自动启动。

---

## 3. 功能规划

### F1 消息交互补全（frontend 模块，用户可感，最先交付）

**状态：六项全部交付**（FE-04～FE-08 + CORE-08），逐项落点见下表右列。真机目视与真实声音一律 NOT RUN，留 INT-01/03。

| 项 | 说明 | 备注 |
| --- | --- | --- |
| 双语对照修复 | 见 §0.1 | hotfix 级 |
| 点击发音 | 点气泡/句子调 TTS 朗读；复用现有 `outputEngine`/cloudTtsOutput，走字幕高亮同一套 speakingRange | **已交付**（[FE-07](frontend/specs/FE-07.md)）。语音会话开着时不接朗读（只有一套嗓子）；同一条再点＝停止 |
| 撤回 | 删除单条消息并从后续上下文剔除；assistant 消息撤回同时撤销其记忆候选 | **已交付**（[FE-06](frontend/specs/FE-06.md)）。实际按整轮删除（只删一行会留下半轮）；记忆联动只撤未确认的候选，confirmed 保留，理由见 [验收报告](frontend/reports/FE-06_ACCEPTANCE.md) |
| 重新生成 | 对最后一轮 user 消息重发，替换上一条 assistant 回复 | **已交付**（FE-06）。不限于最后一轮，任一成功气泡都可；与重试同一条「先删再投」路径 |
| Rewind | 选任意历史消息"回到这里"：截断其后的消息与派生数据（摘要不回滚，标注 gap） | **已交付**（[FE-08](frontend/specs/FE-08.md)）。不需要按时间截断端口：锚点在已加载窗口里，它之后的消息必然也在，按 id 删即可 |
| 重试失败轮 | error 气泡上直接重试按钮 | **已交付**（CORE-08 + FE-05）。原判断「小改」是错的：失败气泡由 presenter `persist()` 落库，storage 契约当时只有 `deleteMemory`，需先新增删除消息端口（含 conformance + sqlite/localStorage 两处实现）；撤回/重新生成/Rewind 现在都可以复用这个端口 |

### F2 开发者模式入口（frontend + app 装配）

- 设置弹窗加"开发者模式"开关（持久化），开启后标题栏出现 DevTools 入口。
- 单页应用引入轻量页签切换（不引路由库，沿用现有 state 切换），工作台是独立 Tab 页，不与聊天页耦合。

### F3 Trace 采集协议（llm 模块，数据底座，先立协议）

- 把现有 `TurnTrace` 升级为版本化事件流 `TraceEventV1`：
  `turn_start → context_assemble(检索来源、instructions 摘要) → provider_request(url/protocol/model, 请求体脱敏) → provider_stream_meta(首 token 延迟、chunk 计数) → memory_extract → tts → turn_end(status/tokens/error)`。
- Sink 端口 `TraceSink`：默认 SQLite 落盘（滚动保留 N 天）+ 内存环形缓冲供工作台实时读；apiKey、正文按开关脱敏。
- 开关：默认开发构建常开、生产默认关，设置里可改。
- mock 优先：harness 可注入 fake sink，本模块测试不依赖真实模型。

### F4 Trace 查看页（frontend，读 F3）

- 轮次时间线：每轮各阶段耗时瀑布、token/成本、错误标记，点开看单轮完整事件与最终 instructions。
- 内联 JSONL 原始视图（对齐 waku Ops Tab）。

### F5 能力调用视图（frontend + llm）

- 展示一轮内的"能力调用"：表情包检索、上下文检索来源（retrieved sections）、记忆抽取结果、sticker action。
- 当前仓库 Tool Call 面很窄（`actions` 仅 sticker），页面按"现有能力如实展示"实现，为后续真实 tool call 预留同一事件类型。

### F6 数据流图（frontend，读装配元信息）

- 两张图：① plugin 依赖拓扑（从注册表 `requires/provides` 生成，图不与代码漂移）；② 一轮 turn 的数据流（输入 → 上下文 → Provider → 解析 → 记忆/TTS/字幕）。
- 渲染用内联 SVG/简单布局，不引重依赖。

### F7 长期记忆管理页（frontend + memory）

- 把右栏记忆列表升级为整页：分类筛选、搜索、编辑、批量确认/删除、pending 审核流、跨会话记忆（LLM-03）来源标注。
- 存储/检索算法不动，只做管理界面与既有接口对齐。

### F8 存储浏览页（frontend + storage，可后置）

- 对齐 waku Data Tab：分表浏览、schema 查看、只读 SQL 控制台（Tauri plugin-sql 已具备能力）。

### F9 Ops 成本页（frontend，读 F3 派生账本）

- 按日/按模型/按用途（对话、记忆抽取、摘要、主动消息）的 token 与估算成本；最慢轮次、错误率。
- 评测（headless harness）入口与历史结果查看后置到 F9+。

### 其他盘点出的缺失项（进 backlog，不承诺本期）

- 用户消息编辑后重发；对话导出（Markdown/JSON）；Provider 用量配额提醒；错误气泡国际化文案统一；设置项搜索；模型下拉快速切换（标题栏直接换模型，复用 LLM-04 的 listModels）。

---

## 4. 接口与架构草案

```
新增端口（kernel token，沿用 ProviderProbe/ProviderModels 模式）：
  TraceSinkToken   — llm.traceSink   （append(event) / query(filter) / tail()）
  DevToolsToken    — app.devtools    （开合状态、当前选中 turn，避免工作台直连注册表）

事件 schema：TraceEventV1（schemaVersion 字段，先冻结字段再扩展）
消费链：runtime/memory/tts → TraceSink → 工作台页面（tail + 查询）
原则：Trace 是旁路，任何 sink 故障不得影响对话主链路（fail-open）。
```

模块归属：F3 归 llm；F1/F2/F4–F9 页面归 frontend；F7 涉及 memory 只经共享契约。跨模块接口变化按 `docs/modules/CONTRACTS.md` 记录版本。

---

## 5. 里程碑与 SPEC 拆分建议

| 里程碑 | 内容 | 出口 AC（示例） |
| --- | --- | --- |
| M0 | §0.1 双语修复 + 重试按钮 | 复现用例：replyText==translation 时不显示次级字幕；单测覆盖。**已交付**：双语修复 [FE-04](frontend/specs/FE-04.md)；重试按钮拆成 [CORE-08](core/specs/CORE-08_MESSAGE_DELETION.md)（`deleteMessages` 端口）+ [FE-05](frontend/specs/FE-05.md)（先删再投），因为它不是小改 |
| M1 | F1 其余交互（发音/撤回/重生成/Rewind） | **全部交付**：撤回/重新生成 [FE-06](frontend/specs/FE-06.md)、点击朗读 [FE-07](frontend/specs/FE-07.md)、Rewind [FE-08](frontend/specs/FE-08.md)。四项都有 fake Runtime 下的逐项 AC 与突变验证；真机目视一律 NOT RUN。原先「需要按时间截断端口」的推测不成立，原因见 FE-08 |
| M2 | F3 Trace 协议 + fake sink 全链单测；F2 开发者入口 | 事件 schema 版本化；脱敏用例；sink 故障不影响主链路。**已交付**：[LLM-06](llm/specs/LLM-06_TRACE_PROTOCOL.md) 协议与两个 sink、[LLM-07](llm/specs/LLM-07_TRACE_WIRING.md) Runtime 接入与开关、[LLM-08](llm/specs/LLM-08_TRACE_SOURCES.md) 余下三个事件源、[FE-09](frontend/specs/FE-09.md) 开发者入口与 Trace 页（F4 一并交付） |
| M3 | F4/F5/F6 工作台页面（读 M2 数据） | 用 harness 回放数据驱动页面，不依赖真实模型 |
| M4 | F7 记忆管理页；F8/F9 视需要后置 | 管理操作有契约测试；统计口径有单测 |

执行按仓库既有规则：一次一个 SPEC，验收报告落 `docs/<module>/reports/`，mock 不冒充真实模型质量。

---

## 6. 风险与边界

- **隐私**：Trace 落盘含对话内容，默认脱敏开关 + 明示；apiKey 永不入 Trace。
- **性能**：SQLite 写入旁路化、环形缓冲限量，避免常开 Trace 拖慢首 token。
- **范围蔓延**：waku 的 Graph 工作流/多通道 Gateway/MCP 不进本期；数据图只做"读装配元信息"，不做图执行引擎。
- **单页改造**：工作台页签化要控制 App.tsx 体积，页面组件一律拆到 `components/` 或新 `pages/`，不再往 App.tsx 堆。

---

## 7. 待确认问题（评审时定）

1. ~~Rewind 对滚动摘要的处理~~ **已按建议执行（FE-08）**：摘要不回滚，只在它覆盖到被删范围时在末尾追加一行 gap 标注。这是取舍不是结论——要求「摘要可重建」仍可推翻它，改动落在 LLM 侧（重新压缩剩余消息），FE 侧把追加换成一次重建调用即可。
2. ~~生产构建 Trace 默认开还是关？~~ **已按建议执行（LLM-07）**：开发构建默认开、生产默认关，读不到构建标记时按关处理（默认不留痕比默认留痕安全）；持久化后以库里的值为准，开关在工作台里（FE-09）。
3. F8 SQLite 控制台是否只读？（建议只读，写操作只走应用内接口）
4. ~~撤回是否需要同步清除已入库的记忆候选？~~ **已回答（FE-06）**：采纳但收窄——来源有交集且仍为 `candidate` 的走 `forget()`，`confirmed` 一律保留（用户明确留下的不能因一次撤回悄悄消失）。收窄理由：抽取输入是最近 4 条消息，一条记忆的来源常跨两轮，「来源有交集」是宽判据。V1 记忆路径无来源字段，不假装联动。
