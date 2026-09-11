# FE-09 开发者模式入口与 Trace 查看页 — 验收报告

日期：2026-09-12
范围：F2（开发者模式开关与工作台入口）+ F4（Trace 轮次时间线与 JSONL 视图）。不含 F5–F9。

## 需求

数据在 LLM-06～08 已经产出，这一份让人看得见。SPEC 与边界见 [FE-09](../specs/FE-09.md)。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/traceView.ts` | 新增。事件流 → 轮次摘要（`groupTurns`）/ 单轮步骤（`turnSteps`）/ JSONL（`toJsonl`）/ 中文标签。贯穿一条规矩：**缺失是 null 不是 0**——「没有首 token」和「首 token 零毫秒」在排查卡顿时是相反的结论。 |
| `src/presentation/devToolsPresenter.ts` | 新增。读 sink、手动刷新、选中轮次、三个开关的读写与持久化；启动时把库里的开关灌回 `TraceSettings`（LLM-07 只交付了服务与键）。 |
| `src/presentation/tokens.ts` | 新增 `DevToolsPresenterToken`。它**总是**注册，即使没装 Trace——页面要能说「未启用」，而不是连入口都消失让人以为功能不存在。 |
| `src/app/plugins/presentationPlugin.ts` | 注册工作台 Presenter，`TraceSinkToken` / `TraceSettingsToken` 走 `optional` + `tryResolve`。 |
| `src/hooks/useDevTools.ts` | 新增适配器，与另两个 Hook 同形状（取 Presenter、订阅、派发），不 import `services/`。 |
| `src/pages/DevToolsPage.tsx`、`src/pages/TracePage.tsx` | 新增。工作台外壳（页签用 state 切，不引路由库）+ Trace 页。页面组件放 `src/pages/`，没往 `App.tsx` 堆（规划文档 §6 的约束）。 |
| `src/App.tsx` | 设置页加「开发者模式」开关；标题栏在开发者模式下多一个入口；工作台打开时 `workspace` 整块 `hidden`，与聊天页不耦合。 |
| `src/App.css` | 新增工作台与 Trace 页样式一段。 |
| `src/services/storage/contracts.ts` | `SETTING_KEYS` 新增 `devMode`。 |
| `src/domain/traceView.test.ts`、`src/presentation/devToolsPresenter.test.ts` | 新增 12 + 8 条。 |

## 测试证据

```
npx vitest run src/domain/traceView.test.ts src/presentation/devToolsPresenter.test.ts
→ 退出码 0：traceView 12、devToolsPresenter 8
npx vitest run src   → Test Files 70 passed | 1 skipped (71)，Tests 849 passed | 1 skipped (850)
npx tsc --noEmit     → 退出码 0
```

突变验证：

| 突变 | 结果 |
| --- | --- |
| 缺 `provider_stream_meta` 时 `firstTokenMs` 写 0 而不是 null | 1 failed ——「缺事件时对应字段是 null，不是 0」 |
| `groupTurns` 过滤掉没有 `turn_end` 的轮次 | 2 failed ——「没结束的轮次照样出现在列表里」等 |
| `available` 恒为 true（假装装了 Trace） | 1 failed ——「没装 Trace 能力时给出『未启用』」（**第一版没命中，见下**） |
| 开关不落库 | 1 failed ——「三个开关都落库」 |

四处均已还原，`grep -rn MUTANT src/` 无命中。

### 一处自查：第三个突变第一次没命中，原因是代码冗余而不是测试弱

`available` 原先有两处赋值：初始 `Boolean(deps.sink)` 和 `refresh()` 里的 `available = false`。把初始值改成 `true` 之后 `refresh()` 又把它纠正回来，所以突变无效。这说明那两处里有一处是多余的——**不是**测试没覆盖。已把它收成 `getSnapshot` 里的单一派生（`Boolean(deps.sink)`，没有第二处能改它），突变随即命中。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| FE-09-A 摘要各字段取自对应事件；缺失为 null | PASS | 「一轮的摘要取自各自的事件」+「缺事件时对应字段是 null，不是 0」 |
| FE-09-B 未结束的轮次仍在列表里并标出 | PASS | 「没结束的轮次照样出现在列表里，标为未结束」，`statusLabel(null)` → 「未结束」 |
| FE-09-C 最近优先；详情按 seq 升序带偏移 | PASS | 「最近的轮次在前」；`turnSteps` 偏移 `[0,10,20,400,900]` |
| FE-09-D 能力缺失给「未启用」；刷新重新读 sink | PASS | 「没装 Trace 能力时给出『未启用』而不是空列表」；「刷新会重新读 sink」（刷新前后对比，证明是手动取数不是订阅） |
| FE-09-E 三个开关持久化并启动灌回 | PASS | 「启动时把库里的开关灌回服务，库里没写过才用默认值」+「三个开关都落库，并立刻反映在服务与快照上」 |
| FE-09-F JSONL 每行可 parse | PASS | 「一行一个事件，每行都能 JSON.parse 回来」；空列表给空字符串而不是一行空白 |

## 共享接口影响

- 新增 `DevToolsPresenterToken`（`presentation.devtools`）；`SETTING_KEYS.devMode` 一个新键。
- 未改 Trace 协议、sink 端口、存储契约的既有成员。
- `presentationPlugin` 的 `optional` 多了两个 trace token；缺失时工作台照常注册并显示「未启用」。

## 待联调项与未覆盖范围

- NOT RUN：真机目视。无 DOM 测试环境，页面渲染以「组件只转发 domain 结果与 Presenter 命令」为可审阅依据。`TracePage` / `DevToolsPage` 里唯一的自有逻辑是 `format()`（null → 破折号）与 `summarizeStep()`（每类事件挑哪几个字段显示），两者都无分支状态。
- 已知边界（未做）：
  - **不实时**。sink 没有订阅接口，页面是「打开时读 + 手动刷新」。为一个调试页给 sink 加推送不值得。
  - 关掉 Trace 开关只影响**新**轮次；已经记下的事件不会被清掉，页面也不会变空。
  - 事件读取上限 2000 条，超出的看不到（内存 sink 本身还会丢最旧的）。页面没有分页。
  - `reportedTokens` 一列永远是破折号，直到 provider 侧上报 usage（F9 的前置）。
- 不在本 SPEC：F5 能力调用视图、F6 数据流图、F7 记忆管理页、F8 存储浏览、F9 成本页。
