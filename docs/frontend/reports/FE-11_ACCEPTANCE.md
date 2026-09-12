# FE-11 长期记忆管理页 — 验收报告

日期：2026-09-12
范围：规划文档 F7。不含 F8 存储浏览、F9 成本页。

## 需求

把右栏那份 12 条上限、经 `toLegacyMemoryRecord()` 降级过的列表，升级为按 V2 原貌管理的整页。SPEC 与边界见 [FE-11](../specs/FE-11.md)。

降级掉的恰恰是管理一条记忆时要看的东西：`type` 被压成 5 个旧 category、`candidate/superseded` 被压成 `pending`、来源与置信度整个丢掉。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/memoryAdmin.ts` | 新增。筛选/搜索/排序、行视图（类型、状态、来源、置信度、有效期、取代了谁）、编辑与确认的落库形状、批量结果文案。 |
| `src/domain/memoryAdmin.test.ts` | 新增 20 条。 |
| `src/presentation/memoryPresenter.ts` | 新增。取数、勾选、编辑态、单条与批量操作、改完通知别人。 |
| `src/presentation/memoryPresenter.test.ts` | 新增 13 条，跑在**生产仓储 + 内存 store** 上，不手搓假仓储。 |
| `src/services/memory/tokens.ts` | `MemoryAccess` 增加 `onChanged` / `notifyChanged`（契约追加，见下）。 |
| `src/app/plugins/memoryPlugin.ts` | 两组订阅者分开扇出：删除发 invalidate + changed，`notifyChanged()` 只发 changed。 |
| `src/presentation/companionPresenter.ts` | 订阅 `onChanged` 后重读右栏列表；自身确认记忆与抽取出新候选后 `notifyChanged()`。删除不喊——`forget` 已经经 `onInvalidate` 扇出。 |
| `src/presentation/tokens.ts`、`src/app/plugins/presentationPlugin.ts` | 新增 `MemoryPresenterToken`，**总是**注册（没装记忆能力时由页面说清楚这件事）。 |
| `src/hooks/useMemoryAdmin.ts`、`src/pages/MemoryPage.tsx` | 新增适配器与页面；`DevToolsPage` 加「记忆」页签。 |
| `src/App.css` | 新增记忆页样式一段。 |
| `src/app/plugins/capabilityPlugins.test.ts`、`src/presentation/companionPresenter.test.ts` | 各加验证扇出与右栏同步的用例（+3）。 |

`MemoryRepository`、`rankMemories`、存储层一行未改。

## 测试证据

```
npx vitest run src/domain/memoryAdmin.test.ts src/presentation/memoryPresenter.test.ts
→ 退出码 0：memoryAdmin 20、memoryPresenter 13
npx vitest run src/app/plugins/capabilityPlugins.test.ts src/presentation/companionPresenter.test.ts
→ 退出码 0：13 + 22
npx vitest run src → Test Files 74 passed | 1 skipped (75)，Tests 930 passed | 1 skipped (931)
npx tsc --noEmit   → 退出码 0
```

基线对照：FE-11 之前是 72 passed | 1 skipped / 894 passed | 1 skipped。新增 36 条＝20 + 13 + 2（插件扇出）+ 1（右栏同步），既有用例一条没改判定，只有一处测试 fake 补齐了新成员。

突变验证（逐条改生产代码 → 跑定向测试 → 还原）：

| 突变 | 结果 |
| --- | --- |
| 筛选不再排除 `superseded` | 1 failed ——「被取代的默认不列」 |
| 排序去掉「待过目置顶」 | 1 failed ——「待过目的置顶，其余按更新时间倒序」 |
| 编辑后不标 `userEdit` | 1 failed ——「改了正文就标 userEdit 并确认」 |
| 空正文也放行 | 2 failed ——「空正文拒绝」+ Presenter 的「空正文不写盘」 |
| 迁移来的记录伪造成「来自对话」 | 1 failed ——「不伪造来源」 |
| `batchSummary` 忽略失败条数 | 1 failed ——「部分失败要说出来，不谎报全成功」 |
| 勾选不跟随筛选收缩 | 1 failed ——「筛选变了，勾选自动摘掉看不见的那些」 |
| 批量把失败吞掉当成功 | 1 failed ——「批量删除部分失败：如实报告」 |
| 改完不 `notifyChanged` | 2 failed ——「确认一条…并通知别的界面」等 |
| `notifyChanged` 连 invalidate 一起发（确认也让摘要作废） | 1 failed ——「notifyChanged 只喊 changed 一组」 |
| 右栏不订阅 `onChanged` | 1 failed ——「管理页改完记忆后，右栏这份列表跟着变」 |

十一处全部命中并已还原；还原后全量 930 通过。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| FE-11-A V2 原貌；`superseded` 默认不列但可切换并标明取代了谁 | PASS | 「按 V2 原貌给出，不走 V1 降级」（type `preference`、status `candidate` 原值）、「被取代的默认不列，可切换显示并标明取代了谁」、Presenter「装载后按 V2 原貌列出」（`total` 含被取代的，列表不含） |
| FE-11-B 筛选/搜索是纯函数；两种空状态分开 | PASS | 「按类型与状态筛」「搜索归一大小写与空白」「时间相同也稳定排序」；`emptyKind` 三态 + Presenter「筛没了与一条都没有是两种空状态」 |
| FE-11-C 审核流：置顶、确认写 `confirmed` 与 `lastConfirmedAt`、不动 `createdAt` | PASS | 「待过目的置顶」「confirmMemoryRecord 只改状态与确认时间」；Presenter「确认一条」断言 `createdAt` 未变、`pendingCount` 归零 |
| FE-11-D 批量逐条执行，部分失败如实报告，成功的不回滚 | PASS | 「批量删除部分失败：如实报告成功与失败，成功的不回滚」（注 `删除了 2 条，1 条失败：写入失败`，库里只剩失败那条，且它仍勾着可重试）；`batchSummary` 三种措辞 |
| FE-11-E 编辑：改正文即 `userEdit` + `confirmed`；空正文拒绝；`createdAt` 不变 | PASS | 「改了正文就标 userEdit 并确认」「只改类型不算改正文」「正文只差空白也不算改」「空正文拒绝」；Presenter「空正文不写盘」断言 `saveCount` 未增、编辑态保留 |
| FE-11-F 改完通知；删除仍先 invalidate 后 changed | PASS | 插件「删除同时通知两组订阅者：先摘要作废，再『记忆变了』」（顺序断言）、「notifyChanged 只喊 changed 一组」；Companion「管理页改完记忆后，右栏这份列表跟着变」；Presenter「别人改了记忆会自动重读」 |
| FE-11-G 来源标注不伪造 | PASS | 「不伪造来源：迁移来的就说来源不明」「对话来源带条数；来源没留下时直说」「用户手写的标成『你写的』」；置信度未知显示为未知而不是 0% |

## 共享接口影响

- `MemoryAccess` 增加 `onChanged` / `notifyChanged`（必选成员）。语义分工与调用顺序已写进 [共享契约](../../modules/CONTRACTS.md)：`onInvalidate` = 摘要作废（只在 `forget`），`onChanged` = 记忆内容变了（确认/编辑/删除）。
- 新增 `MemoryPresenterToken`（`presentation.memory`），与工作台 Presenter 同样**总是**注册。
- `MemoryRepository`、存储契约、检索算法未改，无新增设置键。

## 待联调项与未覆盖范围

- **部分已验（2026-09-12）**：浏览器开发模式下灌了 5 条构造记忆，列表分组与来源标注、单条确认、编辑三项跑通，且右栏那份列表跟着变（`notifyChanged` 的接线在真实应用里成立）。见 [界面冒烟报告](UI_SMOKE_BROWSER.md)。批量操作与部分失败路径仍只有单测证据；桌面真机（SQLite）NOT RUN。
- 已知边界（刻意不做）：
  - **批量不是事务**。仓储只有逐条 `forget`/`upsert`，所以删一半失败的结果就是删了一半——报告如实说出成功与失败条数，不回滚，失败项保留勾选可重试。要原子性得改仓储端口，不在本 SPEC。
  - 批量删除逐条触发 `onInvalidate`，摘要会被重复作废（幂等，但会多几次 `deleteSummaries`）。
  - 不支持手动新增记忆：凭空加一条会绕开抽取与来源溯源，那条记忆将没有任何来源可标。
  - 不做导入导出、不做按时间范围批量清理、不做撤销（删除会落抑制标记，正文不留，本来就撤不回来）。
  - 页面一次性列出全部记忆，没有分页；库里记忆多到卡顿时再说。
- 不在本 SPEC：F8 存储浏览页（仍卡在规划文档 §7 问题 3「SQL 控制台是否只读」）、F9 成本页（仍卡在 `providerClient` 不解析 usage）。
