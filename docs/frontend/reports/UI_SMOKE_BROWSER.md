# 界面冒烟（浏览器开发模式）— 2026-09-12

范围：`npm run dev` + 无头浏览器（Playwright）实际打开应用，点过工作台六个页签与记忆页的三个交互（存储页于同日 FE-12 交付后补跑）。
**这不是 INT-01，也不是桌面真机验收**：没有 Tauri、没有 SQLite、没有 API Key，因此没有跑过任何一轮真实对话。

## 为什么做这一次

FE-04～FE-11 一共八份 SPEC 交付了界面改动，而仓库没有 DOM 测试环境（devDependencies 无 testing-library），所以每一份的渲染依据都是同一句推理：「组件只转发 domain 判定与 Presenter 命令」。这句话能保证判定正确，**不能保证页面打得开**——React 一次都没有真的渲染过这些组件。

结果：页签全部渲染成功、零 console 报错，但查出一个单测永远看不见的真实缺陷（见下）。

## 环境与命令

```
npm run dev            → vite v7.3.6，http://localhost:1420/
存储：localStorage 降级实现（浏览器没有 SQLite）
Provider：未配置 Key，未发起任何模型请求
```

## 查到的缺陷（已修）

**工作台打开时聊天页没有真的隐藏。**

`App.tsx` 写的是 `<section className="workspace" hidden={showDevTools}>`，意图正确（FE-09 的「工作台与聊天页不耦合」）；但 `App.css` 里 `.workspace { display: grid }` 的优先级高于浏览器默认样式表的 `[hidden] { display: none }`，于是 `hidden` 属性形同虚设——工作台下面还挂着整页聊天，页面可以一直往下滚。

实测：修复前 `document.scrollHeight = 1782`，视口 897；修复后两者都是 897，`getComputedStyle(.workspace).display === "none"`。关掉工作台后恢复 `grid` 且三列布局不变（`576px 1066px 278px`）。

修复：`App.css` 增加 `.workspace[hidden] { display: none; }` 一行。

这类缺陷的特征值得记一笔：**它不在任何一份 SPEC 的判定逻辑里，只存在于「属性与样式表的优先级」这一层**，单测与类型检查都碰不到，只有真的渲染一次才会露出来。

## 逐项结果

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 应用启动（浏览器降级存储） | PASS | 标题栏、立绘、欢迎消息、右栏三块全部渲染；console 0 error |
| 设置页「开发者模式」开关 → 标题栏出现入口 | PASS | 开启后 `button[title="调试工作台"]` 出现（FE-09-E 的持久化在真实 localStorage 上跑通） |
| Trace 页（FE-09） | PASS | 「还没有事件」空态 + 原始 JSONL「（空）」；未配置 Key，没有轮次是预期结果 |
| 能力页（FE-10 F5） | PASS（空态） | 「先选一轮」提示与轮次选择器渲染正常；**逐能力结果没验到**，需要真实轮次 |
| 数据流页 · 装配拓扑（FE-10 F6①） | **PASS（真实装配）** | 13 个插件 / 21 条依赖 / 内核 ready / 缺失 0；分层正确（host.* 在上，presentation.core 在底），必选实线、可选虚线，每条边带 `消费者 → 提供者：token` 的 title。见 [截图](evidence/UI_SMOKE_GRAPH.png) |
| 数据流页 · 一轮数据流（FE-10 F6②） | NOT RUN | 同上，需要真实轮次 |
| 记忆页（FE-11） | **PASS（含三个交互）** | 见下 |
| 开关页（FE-09） | PASS | 两个 Trace 开关渲染正常 |
| 存储页（FE-12，2026-09-12 补跑） | PASS（降级态） | 浏览器没有 `sqlExecutor`，页面正确显示「这台机器上没有 SQL 能力……这不是库空了」；顺带查出两处 JSX 里写了 Markdown（反引号与 `**` 会原样显示），已改成 `<code>` / `<strong>` |

### 记忆页的三个交互（真实 localStorage 存储 + 生产仓储）

灌了 5 条构造记忆（含 1 条 `legacy` 无来源、1 条 `superseded`、1 条已过期、1 条带 `supersedesId`）后：

1. **列表与标注**（FE-11-A/G）：统计显示「共 5 条 · 待过目 2 · 当前列出 4」——被取代的那条默认不列但计入总数；待过目两条置顶；来源分别显示「来自对话 · 2 条来源消息」「来源不明（迁移自旧版）」；置信度缺失显示「置信度未知」而不是 0%；过期那条标「已过期」；取代关系显示「取代了『喜欢拿铁』」。见 [截图](evidence/UI_SMOKE_MEMORY.png)。
2. **确认**（FE-11-C/F）：点勾之后库里 `status: confirmed`、`lastConfirmedAt` 写入、`createdAt` 未变；统计变成「待过目 1」、提示「已确认 1 条」；**右栏那份列表同步变成已确认**——`notifyChanged` 的接线在真实应用里成立，不只是单测里成立。
3. **编辑**（FE-11-E/F）：改正文后保存，库里 `content` 更新、`sourceKind` 变 `userEdit`、`status` 变 `confirmed`、`createdAt` 未变；右栏文字同步更新。

## 仍然 NOT RUN

- **桌面真机（Tauri + SQLite）**：本次全程在浏览器降级实现上跑，`plugin-sql` 的 SQL 一行都没执行。留 INT-01。
- **真实对话一轮**：没有 API Key，所以 Trace 事件、能力调用视图、一轮数据流、双语退化统计都还是空的。这是下一次验证最该补的一件事——一轮真实对话能一次点亮 Trace 页、能力页、数据流图三处。
- **F1 的六项消息交互**（重试/撤回/重新生成/朗读/Rewind/双语去重）：都需要真实消息，本次没验。
- **`import.meta.env.DEV` 在生产构建下的取值**：本次是 dev server，恰恰是 `DEV === true` 的那一侧，没有验证生产侧。
