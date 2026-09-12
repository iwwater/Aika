# FE-12 存储浏览页（只读 SQL 控制台）— 验收报告

日期：2026-09-12
范围：规划文档 F8，并回答 §7 问题 3。不含 F9 成本页。

## 需求与决定

§7 问题 3「SQLite 控制台是否只读」——**只读**，理由写在 [FE-12](../specs/FE-12.md)：手写的 UPDATE 不触发任何联动（记忆的抑制标记、摘要作废、supersede 关系），库里会留下一份代码认不出来的状态；`DELETE FROM memories` 只让那一行消失，抑制标记没落下，下一轮抽取又把它记回来，用户会认为「删不掉」。调试价值几乎全在读。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/sqlConsole.ts` | 新增。只读门禁（`stripSqlLiterals` + `classifyStatement`）、结果整表、schema 行转换、单元格格式化、行数上限。 |
| `src/domain/sqlConsole.test.ts` | 新增 22 条。 |
| `src/presentation/storagePresenter.ts` | 新增。表清单（含行数）、schema、表预览、控制台执行；门禁在**执行之前**。 |
| `src/presentation/storagePresenter.test.ts` | 新增 10 条，跑在 **node:sqlite 真实引擎 + 生产 `createSqliteStorage` 建的表**上。 |
| `src/presentation/tokens.ts`、`src/app/plugins/presentationPlugin.ts` | 新增 `StoragePresenterToken`，总是注册；执行器取自 `storage.sqlExecutor`（可选成员）。 |
| `src/hooks/useStorageBrowser.ts`、`src/pages/StoragePage.tsx` | 新增适配器与页面；`DevToolsPage` 加「存储」页签。 |
| `src/App.css` | 新增存储页样式一段。 |

未新增任何端口，存储契约一字未改。

## 门禁怎么判（这是本 SPEC 的核心）

**先剥字符串字面量与注释，再判**。两头都要防：

- 漏判：`SELECT 1; DROP TABLE memories` —— 只看开头以为是 SELECT；
- 误杀：`SELECT * FROM messages WHERE content LIKE '%delete%'` —— 只看关键字就拦正常查询。

剥完之后：单语句、首关键字属于 SELECT/WITH/EXPLAIN/PRAGMA、PRAGMA 走只读白名单且不带等号、语句体内不得出现写关键字（按词边界，所以 `deleted_at` 不误杀）。

必须说清楚的限制：**这是文本判定，不是数据库级只读连接**。`plugin-sql` 只给一个执行器，没有只读连接可用。页面上也如实写了这一句，不让人以为有数据库级保证。

## 测试证据

```
npx vitest run src/domain/sqlConsole.test.ts            → 退出码 0：22 通过
npx vitest run src/presentation/storagePresenter.test.ts → 退出码 0：10 通过
npx vitest run src → Test Files 76 passed | 1 skipped (77)，Tests 977 passed | 1 skipped (978)
npx tsc --noEmit   → 退出码 0
```

基线对照：FE-12 之前是 945 passed | 1 skipped，新增正好 32 条。

Presenter 测试**不是**对着假执行器断言 SQL 文本：它用 `openMemorySqlite()` 开真库、用生产的 `createSqliteStorage` 建表、写两行消息，然后让每一条被拦下的写语句**真的有机会执行**，再断言 `SELECT COUNT(*) FROM messages` 仍是 2。门禁自己判自己的卷子没有意义。

突变验证（逐条改生产代码 → 跑定向测试 → 还原）：

| 突变 | 结果 |
| --- | --- |
| 不剥字符串就判 | 2 文件 failed ——「字符串字面量里的写关键字不误杀」等 |
| 不拦多语句 | 2 文件 failed ——「SELECT 1; DELETE」溜进去，`countMessages` 掉到 1 |
| 不扫写关键字 | 2 文件 failed ——「CTE 后面接写也拦得住」等 |
| 关键字不按词边界（`includes`） | 1 failed ——「列名里含关键字不误杀」（`deleted_at` 被误杀） |
| 可写 PRAGMA 放行（去掉等号判定） | 1 failed ——「白名单里的 PRAGMA 带等号也拒绝」（**第一次没命中，见下**） |
| 超上限不标 `truncated` | 2 文件 failed ——「超过上限就标 truncated」「表预览 truncated」 |
| Presenter 拿到判定却不拦 | 1 failed ——「写语句被拦在执行之前：库里一行没少」（真库真被删了，这正是这条用例要证的） |

七处最终全部命中并已还原；还原后全量 977 通过。

### 一处自查：等号判定的突变第一次没命中

去掉 `PRAGMA` 的等号判定后测试仍全绿——因为当时唯一的可写 PRAGMA 用例是 `PRAGMA journal_mode=WAL`，而 `journal_mode` **本来就不在白名单里**，白名单先把它拒了，等号判定根本没被执行到。

这说明覆盖有缺口，**不是**这段代码多余：白名单目前全是只读项，等号判定是冲着「以后往白名单里加了一个可设置的 PRAGMA」去的——没有它，那一天会安静地开一个写入口。已补 `PRAGMA table_info = memories` 的用例把这条路钉死，突变随即命中。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| FE-12-A 表/视图清单来自 `sqlite_master`，带行数；可看前 N 行 | PASS | 「列出表与视图，带行数」（`messages` 行数 2，建表 SQL 来自真实存储）；「控制台跑 SELECT 拿到结果」 |
| FE-12-B schema 来自 `pragma_table_info` + 建表 SQL | PASS | 「选中一张表：列信息来自 pragma」（`id` 是主键、含 `created_at` 列、`createSql` 有内容） |
| FE-12-C 写语句/多语句/注释藏写/CTE 接写/可写 PRAGMA/ATTACH 全拒，理由具体；字面量不误杀 | PASS | 门禁 12 条用例 + Presenter「写语句被拦在执行之前：库里一行没少」（七种写语句逐条跑过真库，`COUNT(*)` 始终是 2）；「拒绝理由具体到是哪个词/几条语句」；「字符串里带写关键字的正常查询照跑」 |
| FE-12-D 结果有上限且如实标注 | PASS | 「超过上限就标 truncated」；表预览 `previewLimit: 1` 时 `rows` 1 条、`truncated: true` |
| FE-12-E 没有 `sqlExecutor` 时说明白 | PASS | 「没有 sqlExecutor 时 available 为 false」；浏览器实跑显示「这台机器上没有 SQL 能力 …… 这不是库空了」 |
| FE-12-F 页面只转发 | PASS | `StoragePage` 无判定逻辑（连「能不能跑」都交给 Presenter），门禁在 domain |

## 真机（浏览器）冒烟

按 [界面冒烟](UI_SMOKE_BROWSER.md) 的做法又跑了一次：工作台六个页签渲染正常，「存储」页在浏览器降级下正确显示「这台机器上没有 SQL 能力」。

顺带查出并修掉**两处只有渲染才看得见的文案缺陷**：页面里写的 `` `sqlExecutor` `` 与 `**不是数据库级只读连接**` 会原样显示成反引号和星号（JSX 不认 Markdown）。已改成 `<code>` 与 `<strong>`。

## 共享接口影响

- 新增 `StoragePresenterToken`（`presentation.storage`），与其它工作台 Presenter 一样**总是**注册。
- 消费既有的 `AikaStorage.sqlExecutor`（LLM-07 露出的可选成员），**没有新增端口**，存储契约无变化，故 [共享契约](../../modules/CONTRACTS.md) 无需追加。

## 待联调项与未覆盖范围

- **NOT RUN：Tauri 真机**。证据来自 node:sqlite 真实引擎；`@tauri-apps/plugin-sql` 上 `pragma_table_info($1)` 的参数绑定、`sqlite_master` 查询是否一致，要等 INT-01。这次已经因为引擎差异踩到一次：`notnull` 是 SQLite 的运算符，不加引号就是语法错误——假执行器永远发现不了这种事。
- **门禁是文本判定，不是只读连接**。写这条不是免责声明：它意味着「新的 SQLite 语法出现写入口」这件事，本层会漏。真要硬保证得由 `plugin-sql` 提供只读连接，那是另一件事（需要 Rust 侧改动）。
- 不做：写入、编辑单元格、导出 CSV、分页跳转（只给前 N 行与总行数）、跨表 join 的可视化。
- FTS5 的影子表（`*_data` / `*_idx` 等）会出现在表清单里，没有归组折叠——真机上看看多不多再说。
