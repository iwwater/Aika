# FE-10 能力调用视图与数据流图 — 验收报告

日期：2026-09-12
范围：F5（一轮内的能力调用）+ F6（装配拓扑图 + 一轮的数据流）。不含 F7/F8/F9。

## 需求

FE-09 让 Trace 事件看得见，这一份让它们**读得懂**：一轮之内各项能力分别做了什么，以及这一轮在装配里走过哪条路。SPEC 与边界见 [FE-10](../specs/FE-10.md)。

接手说明：`src/domain/capabilityView.ts` 是上一次中途停下时留下的半成品（零测试、无调用方）。本次先补测试再继续，并在补测试的过程中改掉了它的一处实际缺陷（见下）。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/capabilityView.ts` | 修正丢弃原因标签：原来的键（`budget` / `empty` / `unavailable`）**不在 `ContextDropReason` 里**，而真实存在的 `cancelled` / `trimmed` 反而没有标签，于是界面上会直接显示英文枚举名。改成 `Record<ContextDropReason, string>`——union 加了新原因而这里没跟上，`tsc` 会当场报错。运行期仍留兜底：事件是从库里读回来的，旧版本写进去的原因可能已不在当前 union 里。 |
| `src/domain/capabilityView.test.ts` | 新增 13 条。核心是「未发生 vs 空结果」这条分界与退化标记。 |
| `src/domain/pluginGraph.ts` | 新增。F6 两张图的全部判定：`buildPluginGraph`（拓扑 + 缺失清单 + 分层）、`layoutGraph`（纯几何，页面只管画）、`turnFlow`（按实际事件点亮阶段）。 |
| `src/domain/pluginGraph.test.ts` | 新增 22 条。 |
| `src/app/kernelContext.tsx` | 新增 `useKernelDescribe()`。露出去的是 `describe` 本身而不是内核实例——工作台要画拓扑，但不该顺手拿到 `registry`，那等于在展示层开第四个 resolve 入口。 |
| `src/hooks/useKernelSnapshot.ts` | 新增。挂载时读一次 + 手动重读；装配在 `start()` 之后不再变，为一张调试图挂订阅不值得。 |
| `src/components/TurnPicker.tsx` | 新增。选哪一轮由 Presenter 的 `selectedTurnId` 决定，所以三个页签之间是同一轮。 |
| `src/pages/CapabilitiesPage.tsx`、`src/pages/GraphPage.tsx` | 新增两个页面，均只转发 domain 结果。 |
| `src/pages/DevToolsPage.tsx` | 加「能力」「数据流」两个页签。 |
| `src/App.css` | 新增两页样式一段。 |

未新增任何端口，未改 Trace 协议与内核契约。

## 测试证据

```
npx vitest run src/domain/capabilityView.test.ts src/domain/pluginGraph.test.ts
→ 退出码 0：capabilityView 13、pluginGraph 22
npx vitest run src/kernel/architecture.test.ts src/domain/capabilityView.test.ts \
              src/domain/pluginGraph.test.ts src/presentation/devToolsPresenter.test.ts
→ 退出码 0：4 文件 71 通过（含边界门禁）
npx vitest run src → Test Files 72 passed | 1 skipped (73)，Tests 894 passed | 1 skipped (895)
npx tsc --noEmit   → 退出码 0
```

基线对照：FE-10 之前是 71 passed | 1 skipped / 859 passed | 1 skipped，新增正好是本次两份测试的 35 条，既有测试一条没动。

突变验证（逐条改生产代码 → 跑定向测试 → 还原）：

| 突变 | 结果 |
| --- | --- |
| `absent()` 的 outcome 改成 `empty`（抹掉「未发生 vs 空结果」） | 1 failed ——「未发生与空结果分得开」 |
| `reply` 判定忽略 `translationDuplicatesReply` | 1 failed ——「正文与翻译同句这一轮被显式标成退化」 |
| 丢弃原因不翻译，直接吐枚举名 | 2 failed ——「事件齐全时每项取自对应事件」「丢弃原因翻成中文」 |
| 提供者只认 `services`，丢掉未激活插件的 `provides` 声明 | 1 failed ——「失败插件声明的服务：边还在，但标为未登记」 |
| 缺失依赖不再区分必选/可选 | 2 failed ——「必选与可选分开标」「多个消费者合并」 |
| 节点列表过滤掉非 `activated` 的插件 | 2 failed ——「未激活的插件照样在图里并带状态」等 |
| 未走到的阶段 `offsetMs` 写 0 而不是 null | 1 failed ——「按实际事件点亮阶段」 |
| `stoppedAfter` 恒为 null（失败轮看不出停在哪） | 3 failed ——「失败轮能看出停在哪一步」等 |

八处全部命中，全部已还原；还原后 `npx vitest run src/domain/capabilityView.test.ts src/domain/pluginGraph.test.ts` 退出码 0。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| FE-10-A 各项取自对应事件；事件没发生时标「未发生」而不是 0 | PASS | 「事件齐全时每项取自对应事件」；「未发生与空结果分得开」——`memory_extract` 缺失 → `absent`「这一轮没有发生」，`candidates: 0` → `empty`「跑了，但一条候选都没有」；检索 0 个来源同理 |
| FE-10-B `translationDuplicatesReply` 为 true 时显式标出 | PASS | 「正文与翻译同句这一轮被显式标成退化」（`outcome: degraded`，文案「正文与翻译是同一句（语义退化）」）；数据流图上同样可见 |
| FE-10-C 边由 requires/optional 与 providedBy 对上生成；缺失分必选/可选 | PASS | 「边由消费者的 requires 与 services 的 providedBy 对上生成」「optional 也画边，但与 required 分开标」「没人提供的依赖进缺失清单」「同一个缺失 token 被多个插件等待时合并」 |
| FE-10-D 拓扑含未激活插件并带状态 | PASS | 「未激活的插件照样在图里并带状态」（五种状态齐全）；「失败插件声明的服务：边还在，但标为未登记」——把「声明有、服务没登记」与「压根没人提供」分开 |
| FE-10-E 按实际事件点亮阶段；失败轮看得出停在哪 | PASS | 「按实际事件点亮阶段，缺事件的标未走到」「失败轮能看出停在哪一步」（停在「发出请求」之后，`turn_end` 标 failed 带 errorCode）「取消的轮次同样指出停在哪」「完成的轮次没有停在哪这一说」 |
| FE-10-F 页面只转发；`describe()` 只读，不新增 resolve 调用点 | PASS | 内核边界门禁「registry.resolve 只允许出现在白名单文件里」通过（白名单未变）；`useKernelSnapshot` 只调 `describe()`；节点坐标与边端点由 `layoutGraph` 算好，页面不做判断 |

## 共享接口影响

- `src/app/kernelContext.tsx` 新增导出 `useKernelDescribe()`，只读 `describe()`，不暴露内核实例与 `registry`。既有 `useService` 未改。
- 无新增 token、无端口变更、无存储键变更，故 [共享契约](../../modules/CONTRACTS.md) 无需追加。
- 消费 CORE-09 的 `PluginRecord.requires/optional/provides`：这是它交付后的第一个真实消费者，字段语义（登记时记录、只给 key 字符串）按原样使用。

## 待联调项与未覆盖范围

- NOT RUN：**真机目视**。无 DOM 测试环境，三个新组件（`CapabilitiesPage` / `GraphPage` / `TurnPicker`）的审阅依据是「只转发 domain 结果与 Presenter 命令」。SVG 的实际观感、层数多时是否需要横向滚动，都还没在真实应用里看过。
- ~~NOT RUN：真实装配下的拓扑~~ → **已验（2026-09-12）**：浏览器开发模式下真实 `composition.ts` 装出 13 个插件 / 21 条依赖 / 缺失 0，分层与必选-可选样式都正确，见 [界面冒烟报告](UI_SMOKE_BROWSER.md) 与其中的截图。一轮数据流与能力调用视图仍只验到空态（没有 API Key，没有真实轮次）。
- 已知边界（未做）：
  - 拓扑图**不可编辑、不可展开单个节点**；服务级别的明细（哪个 token 被实例化过）没画，只在节点上显示「提供 N」。
  - 数据流图是**固定八阶段的线性清单**，不是自由布局的图。Runtime 的编排目前就是这一条线，先按事实画。
  - 两个页面都依赖选中轮次；没选时给提示，不自动选最近一轮——自动选会让「刷新后看的是哪一轮」变得不确定。
  - 一轮内同类事件只取第一条（协议上每类每轮一条）。
- 不在本 SPEC：F7 记忆管理页、F8 存储浏览、F9 成本页（F9 仍被 `providerClient` 不解析 usage 卡住）。
