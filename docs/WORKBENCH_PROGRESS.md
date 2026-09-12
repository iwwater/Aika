# 调试工作台 · 进度与未完成项

日期：2026-09-12
对应规划：[开发者模式与调试工作台](PLAN_DEV_DEBUG_WORKBENCH.md)
状态：**F1～F8 已交付**（M0～M3 完成，M4 只剩 F9）。本文件记录已交付什么、还剩什么，供下次接手。

---

## 1. 已交付（都已自测并推送，全部「待审阅」）

按执行顺序，每一份都有 SPEC + 验收报告 + 突变验证。

| SPEC | 交付 | 对应规划项 |
| --- | --- | --- |
| [FE-04](frontend/specs/FE-04.md) | 双语对照字幕去重 | §0.1 |
| [CORE-08](core/specs/CORE-08_MESSAGE_DELETION.md) | `AikaStorage.deleteMessages` 端口（两实现 + 用例包） | F1 前置 |
| [FE-05](frontend/specs/FE-05.md) | 失败轮重试（先删再投） | F1 |
| [FE-06](frontend/specs/FE-06.md) | 撤回与重新生成（含记忆联动） | F1 |
| [FE-07](frontend/specs/FE-07.md) | 点击朗读（逐句高亮） | F1 |
| [FE-08](frontend/specs/FE-08.md) | Rewind（回到这里 + 摘要 gap） | F1 |
| [LLM-06](llm/specs/LLM-06_TRACE_PROTOCOL.md) | Trace 协议 + `TraceSink` 两实现 | F3 |
| [LLM-07](llm/specs/LLM-07_TRACE_WIRING.md) | Trace 接入 Runtime + 开关服务 | F3 |
| [LLM-08](llm/specs/LLM-08_TRACE_SOURCES.md) | 余下三个事件源（provider/memory/tts） | F3 |
| [FE-09](frontend/specs/FE-09.md) | 开发者模式入口 + Trace 查看页 | F2 / F4 |
| [CORE-09](core/specs/CORE-09_TOPOLOGY_READABLE.md) | 装配拓扑可读（`PluginRecord` 带出声明） | F6 前置 |
| [LLM-09](llm/specs/LLM-09_REPLY_EVENT.md) | `reply` 事件，语义退化可统计 | §0.1 长效手段 / F5 前置 |
| [FE-10](frontend/specs/FE-10.md) | 能力调用视图 + 装配拓扑图 + 一轮数据流 | F5 / F6 |
| [FE-11](frontend/specs/FE-11.md) | 长期记忆管理页（含 `MemoryAccess` 变更通知） | F7 |
| [LLM-10](llm/specs/LLM-10_PROVIDER_USAGE.md) | Provider usage 上报（四协议、流式与非流式） | F9 前置 |
| [FE-12](frontend/specs/FE-12.md) | 存储浏览页与只读 SQL 控制台 | F8 |

里程碑口径：**M0、M1、M2、M3 均已交付，M4 只差 F9**。测试基线：`npx vitest run src` → 76 文件通过 / 1 跳过，977 通过 / 1 跳过（那 1 个跳过的是既有的真实模型样本，按环境变量关）；`npx tsc --noEmit` 退出码 0。

顺带回答了规划文档 §7 的三个待确认项（都写进了原文档）：

- 问题 1（Rewind 对摘要）→ 不回滚 + 标注 gap，**这是取舍不是结论**，可被「摘要可重建」推翻。
- 问题 2（生产构建 Trace 默认开关）→ 开发开、生产关，读不到构建标记按关。
- 问题 4（撤回是否连带撤记忆）→ 只撤未确认的候选，`confirmed` 保留。

§7 问题 3（F8 SQL 控制台是否只读）**已回答：只读**，理由与代价见 [FE-12](frontend/specs/FE-12.md)。规划文档 §7 四个待确认项至此全部有答案。

---

## 2. 还没开始

| 规划项 | 内容 | 已知前置 |
| --- | --- | --- |
| F9 | Ops 成本页（按日/模型/用途的 token 与估算成本、最慢轮次、错误率） | **前置已解除**（[LLM-10](llm/specs/LLM-10_PROVIDER_USAGE.md)）：四种协议的 usage 现在都解析，`turn_end.tokens.reportedTotal` 写的是平台上报值，取消与失败的轮次也带。**真实平台已验**（2026-09-12，DeepSeek，`reportedTotal` 1069 / 1076 / 1090），但动工前先读 [真实一轮验证报告](frontend/reports/REAL_TURN_VERIFICATION.md) 的两条：`estimatedPrompt` 不含系统指令、比真实 prompt 低约 2.5 倍，不能当没有 usage 时的兜底；取消的轮次在只在末包报 usage 的平台上一定拿不到数字。另外三种协议仍只有 fixture 证据。单价换算仍未做（价目表不该埋进 provider 层） |
| M4 后置 | 评测（headless harness）入口与历史结果 | 规划文档自己标的 F9+ |

规划文档 §3 末尾的 backlog 也都没做：用户消息编辑后重发、对话导出、Provider 配额提醒、错误气泡文案统一、设置项搜索、标题栏快速换模型。

---

## 3. 全局未验证项（重要）

这些跨所有已交付 SPEC，**不是某一份的遗漏**：

1. **界面渲染：浏览器开发模式已冒烟，桌面真机仍 NOT RUN**。2026-09-12 用 `npm run dev` + 无头浏览器实际打开过应用，工作台五个页签全部渲染成功、零 console 报错，记忆页的列表/确认/编辑三个交互在真实 localStorage 上跑通，装配拓扑用的是真实 `composition.ts` 的 13 插件 / 21 依赖 / 缺失 0。详见 [界面冒烟报告](frontend/reports/UI_SMOKE_BROWSER.md)。
   **这一次查出了一个单测永远看不见的缺陷并已修**：`.workspace { display: grid }` 压过浏览器默认的 `[hidden] { display: none }`，工作台打开时聊天页根本没隐藏（页面能一直往下滚）。
   仍然没验的：桌面 Tauri + SQLite、F1 的六项消息交互。
2. **真实对话一轮已跑通**（2026-09-12，DeepSeek 真实 Key，headless harness 与浏览器各两轮）。Trace 页、能力调用视图、一轮数据流三处都已用真实数据点亮，浏览器全程 0 console error；**LLM-10 的 `reportedTotal` 第一次来自真实平台**（1069 / 1076 / 1090，原报告标的 NOT RUN 可销）。详见 [真实一轮验证报告](frontend/reports/REAL_TURN_VERIFICATION.md)。
   **这一次查出四件只有真实数据才看得见的事**：① 工作台打开时不取数，必须手点刷新，而空态文案会让人以为是 Trace 没记到；② 「首 token」量的是首个**可见正文字符**，比平台首字节晚约 460ms（平台 TTFB 实测 216–338ms，与 prompt 大小无关）；③ `estimatedPrompt` 不含 1831 字系统指令，比真实 prompt 低约 2.5 倍，F9 成本页不能拿它当兜底；④ 取消的轮次在 DeepSeek 上一定拿不到 usage（只在末包报），已烧掉的 token 只能估——而能估的那个数正是 ③。
   仍然没验的：Tauri 真机（INT-01）、另外三种协议的 usage、语音链路（报告 §5 记了一条没能复现的观察）。
3. **`plugin-sql` 上的 SQL 没执行过**。CORE-08 的 `DELETE ... IN (…)`、LLM-06 的 trace 建表与清理，证据都来自 node:sqlite 真实引擎跑生产 SQL，不等于 Tauri 环境验证。留 INT-01。
4. **`import.meta.env.DEV` 在生产构建下的实际取值**没验过（Trace 默认开关依赖它）：冒烟跑的是 dev server，恰恰是 `DEV === true` 的那一侧。
5. **真实模型质量**：LLM-09 让「双语退化率」第一次可测了（`reply` 事件的 `translationDuplicatesReply` 比例），FE-10 让它在单轮里一眼可见。已有的真机样本是 **3 轮、全部未退化**（DeepSeek / openai-compatible，见 [真实一轮验证报告](frontend/reports/REAL_TURN_VERIFICATION.md)）——只能说「这三轮没退化」，样本量不够算比率，也没覆盖另外三种协议。

---

## 4. 顺带发现、没动的仓库问题

- **LLM-04 编号被两件事占用**：`docs/llm/SPEC.md` 里 LLM-04 是「单次 Agent / 后台写回（未开始）」，但 `docs/llm/reports/LLM-04_ACCEPTANCE.md` 是「设置页模型列表拉取与下拉选择」的验收报告。两者不是同一件事。没擅自改编号，因为改哪个都会动别人的历史记录。
- **`aika-crossplatform/vite.err`**：一个空文件，2026-09-11 随 LLM-04 那批提交进来的，看着像误提交的日志。没删。

## 2026-09-13 审阅更新

Live Inspector已拆LLM-11及FE-23～25；F9已拆FE-26，均尚未实现。LLM-04编号冲突已用历史报告迁移+原路径说明处理，后台维护仍未交付。全局未验证项保持原状态；执行入口改为[安全执行计划](GOAL_EXECUTION_PLAN.md)。

全文审阅补充：F9仍待实现；生产Trace仅有总token，已新增LLM-12补齐用量记录，FE-26等待它后接真实数据。当前全部待执行SPEC的设计审阅清单见[审阅记录](REVIEW_V0.5_AND_BACKLOG.md)，不替代实现审阅。
