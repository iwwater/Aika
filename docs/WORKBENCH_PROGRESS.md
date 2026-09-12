# 调试工作台 · 进度与未完成项

日期：2026-09-12
对应规划：[开发者模式与调试工作台](PLAN_DEV_DEBUG_WORKBENCH.md)
状态：**F1～F7 已交付**（M0～M3 完成，M4 的记忆管理页也已交付），F8/F9 未开始且各有前置未定。本文件记录已交付什么、还剩什么，供下次接手。

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

里程碑口径：**M0、M1、M2、M3 均已交付，M4 只差 F8/F9**。测试基线：`npx vitest run src` → 74 文件通过 / 1 跳过，945 通过 / 1 跳过（那 1 个跳过的是既有的真实模型样本，按环境变量关）；`npx tsc --noEmit` 退出码 0。

顺带回答了规划文档 §7 的三个待确认项（都写进了原文档）：

- 问题 1（Rewind 对摘要）→ 不回滚 + 标注 gap，**这是取舍不是结论**，可被「摘要可重建」推翻。
- 问题 2（生产构建 Trace 默认开关）→ 开发开、生产关，读不到构建标记按关。
- 问题 4（撤回是否连带撤记忆）→ 只撤未确认的候选，`confirmed` 保留。

§7 问题 3（F8 SQL 控制台是否只读）**仍未回答**，因为 F8 还没做。

---

## 2. 还没开始

| 规划项 | 内容 | 已知前置 |
| --- | --- | --- |
| F8 | 存储浏览页（分表浏览、schema 查看、只读 SQL 控制台） | `AikaStorage.sqlExecutor` 已在 LLM-07 露出，够用；**但 §7 问题 3「是否只读」需要先定** |
| F9 | Ops 成本页（按日/模型/用途的 token 与估算成本、最慢轮次、错误率） | **前置已解除**（[LLM-10](llm/specs/LLM-10_PROVIDER_USAGE.md)）：四种协议的 usage 现在都解析，`turn_end.tokens.reportedTotal` 写的是平台上报值，取消与失败的轮次也带。**但那些数字来自 fixture，真实平台 NOT RUN**——成本页动工前最好先拿真实 Key 跑一轮看看数字对不对。单价换算仍未做（价目表不该埋进 provider 层） |
| M4 后置 | 评测（headless harness）入口与历史结果 | 规划文档自己标的 F9+ |

规划文档 §3 末尾的 backlog 也都没做：用户消息编辑后重发、对话导出、Provider 配额提醒、错误气泡文案统一、设置项搜索、标题栏快速换模型。

---

## 3. 全局未验证项（重要）

这些跨所有已交付 SPEC，**不是某一份的遗漏**：

1. **界面渲染：浏览器开发模式已冒烟，桌面真机仍 NOT RUN**。2026-09-12 用 `npm run dev` + 无头浏览器实际打开过应用，工作台五个页签全部渲染成功、零 console 报错，记忆页的列表/确认/编辑三个交互在真实 localStorage 上跑通，装配拓扑用的是真实 `composition.ts` 的 13 插件 / 21 依赖 / 缺失 0。详见 [界面冒烟报告](frontend/reports/UI_SMOKE_BROWSER.md)。
   **这一次查出了一个单测永远看不见的缺陷并已修**：`.workspace { display: grid }` 压过浏览器默认的 `[hidden] { display: none }`，工作台打开时聊天页根本没隐藏（页面能一直往下滚）。
   仍然没验的：桌面 Tauri + SQLite、F1 的六项消息交互。
2. **真实对话一轮仍未跑**（没有 API Key）。Trace 页、能力调用视图、一轮数据流三处目前都只验到空态；一轮真实对话能一次点亮这三处，是下一次验证最划算的一件事。
3. **`plugin-sql` 上的 SQL 没执行过**。CORE-08 的 `DELETE ... IN (…)`、LLM-06 的 trace 建表与清理，证据都来自 node:sqlite 真实引擎跑生产 SQL，不等于 Tauri 环境验证。留 INT-01。
4. **`import.meta.env.DEV` 在生产构建下的实际取值**没验过（Trace 默认开关依赖它）：冒烟跑的是 dev server，恰恰是 `DEV === true` 的那一侧。
5. **真实模型质量**：LLM-09 让「双语退化率」第一次可测了（`reply` 事件的 `translationDuplicatesReply` 比例），FE-10 让它在单轮里一眼可见，但还没跑过真机样本。

---

## 4. 顺带发现、没动的仓库问题

- **LLM-04 编号被两件事占用**：`docs/llm/SPEC.md` 里 LLM-04 是「单次 Agent / 后台写回（未开始）」，但 `docs/llm/reports/LLM-04_ACCEPTANCE.md` 是「设置页模型列表拉取与下拉选择」的验收报告。两者不是同一件事。没擅自改编号，因为改哪个都会动别人的历史记录。
- **`aika-crossplatform/vite.err`**：一个空文件，2026-09-11 随 LLM-04 那批提交进来的，看着像误提交的日志。没删。
