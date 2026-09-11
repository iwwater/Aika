# LLM-06 Trace 采集协议与 Sink 端口 — 验收报告

日期：2026-09-12
范围：事件协议、`TraceSink` 端口、两个真实实现、脱敏纯函数、端口一致性用例包。**本 SPEC 不发任何事件、不接 Runtime、不加界面与设置项**（接入是下一份）。

## 需求

[规划文档](../../PLAN_DEV_DEBUG_WORKBENCH.md) F3。既有 `TurnTrace` 只有 5 个字段、经 `onTrace` 发一次就没了——没有版本、没有时序、不落盘、查不了。SPEC 与取舍见 [LLM-06](../specs/LLM-06_TRACE_PROTOCOL.md)。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/domain/trace.ts` | 新增。`TRACE_SCHEMA_VERSION`、七种 `TraceEventV1`（turn_start / context_assemble / provider_request / provider_stream_meta / memory_extract / tts / turn_end）、`TraceQuery`、`TraceRedactionPolicy`；纯函数 `redactEndpoint` / `digestText` / `redactTraceEvent` / `sortTraceEvents`。 |
| `src/services/trace/contracts.ts` | 新增 `TraceSink` 端口：`append`（**永不抛、不返回 Promise**）、`tail`、`query`、`flush`（只给测试与查询前对齐）。 |
| `src/services/trace/memoryTraceSink.ts` | 新增。环形缓冲，满了丢**最旧**的并计数（`dropped()`）——工作台得知道自己看的不是全部。 |
| `src/services/trace/sqliteTraceSink.ts` | 新增。建表 + 索引；`append` 入队后台串行落盘；载荷整段存 JSON（只把 turn_id/kind/at 三个查询维度拆成列，避免每加一种事件就迁移一次）；保留期清理在写入时顺带做并节流，不另起定时器。 |
| `src/services/trace/trace.conformance.ts` / `.test.ts` | 新增端口一致性用例包（7 条）与两个 harness。 |
| `src/domain/trace.test.ts`、`src/services/trace/*.test.ts` | 新增 13 + 3 + 1 条。 |
| `docs/llm/SPEC.md`、`docs/llm/specs/LLM-06_TRACE_PROTOCOL.md` | SPEC 与索引一行。 |

## 四个刻意的协议决定

1. **apiKey 靠类型根除，不靠运行时过滤**：没有任何事件带 key 字段。这比「写个过滤器把 key 摘掉」可靠——过滤器要求我们提前知道每家把 key 放哪儿。
2. **endpoint 的 query string 整段砍掉**：Gemini 把 key 放在 `?key=…` 里（LLM-04 的 `listModels` 就是这么发的）。不维护「哪家用哪个参数名」的清单，整段不要。URL 里的用户名密码一并去掉。
3. **不伪造 token 用量**：`turn_end.tokens` 拆成 `estimatedPrompt` 与 `reportedTotal`，后者目前一律 `null`，因为 provider 侧还没上报 usage。写 0 会让成本页把「不知道」画成「不花钱」。
4. **正文缺失与空内容分得开**：脱敏关掉正文时字段是 `null` 而不是 `""`。

## 测试证据

命令（cwd = `aika-crossplatform`）：

```
npx vitest run src/services/trace src/domain/trace.test.ts
```

退出码 0。Test Files 4 passed (4)，Tests 31 passed (31)：

- `trace.conformance.test.ts` 14 = 7 条 × 2 个实现（同一份用例包）；
- `domain/trace.test.ts` 13；`sqliteTraceSink.test.ts` 3；`memoryTraceSink.test.ts` 1。

`npx tsc --noEmit` 退出码 0。SQLite 侧走 `nodeSqlite.harness` 的真实 node:sqlite 引擎跑生产 SQL（建表、`INSERT OR REPLACE`、索引、清理语句一字未改）。

### 一处调试记录

用例包最初用 100 / 200 这样的小时间戳，落盘实现一上来就丢掉第一条事件。原因不是 bug 而是保留策略生效了：拿真实时钟一比，`at=100`（1970 年）就是过期数据，第一次写入顺带的清理直接把它扫掉。修法是把用例包的时间戳挂在一个真实纪元基准 `TRACE_BASE_AT` 上，落盘 harness 把注入时钟钉到同一点——而不是把清理关掉来让用例过。

### 突变验证（LLM-06-E，五处）

| 突变 | 结果 |
| --- | --- |
| 环形缓冲改成丢最新（`pop` 代替 `shift`） | 1 failed ——「满了丢最旧的」 |
| 落盘 `append` 改成同步 await 写入 | 2 failed ——「append 不返回 Promise，也不等落盘」「清理有节流」 |
| 把写入链的 `catch` 摘掉（失败后链条废掉） | 1 failed ——「fail-open：底层写坏了 append 也不抛，且后续写入不被废掉」 |
| `redactEndpoint` 不清空 query | 4 failed —— 三条脱敏用例 + 「序列化后搜不到密钥值」 |
| `redactTraceEvent` 忽略 `includeText` 开关 | 2 failed ——「默认不带正文」「instructions 摘要同样受开关控制」 |

五处均已还原，`grep -rn MUTANT src/` 无命中，复跑 31 passed。

## AC 核对

| AC | 结果 | 证据 |
| --- | --- | --- |
| LLM-06-A 两实现跑同一份用例包全绿；时序、tail 方向与 limit | PASS | 14 = 7×2；「时序按 turnId + seq 还原，不靠写入顺序」故意乱序写入后验证顺序；「tail 是倒序、尊重 limit」 |
| LLM-06-B fail-open | PASS | 落盘 harness 用 `DROP TABLE` 制造真实写入失败（不是 stub 抛错）：`append` 不抛、`flush` 正常 resolve |
| LLM-06-C 脱敏三条 | PASS | `domain/trace.test.ts` 的 redaction describe，含「序列化后搜不到密钥值」与「搜不到 apiKey 字段名」 |
| LLM-06-D 保留策略（可注入时钟） | PASS | 「超过保留期的清掉，期内的一条不动」：8 天前那条被清、1 天前那条留下；时钟推进 7 天后它也被下一次写入带走 |
| LLM-06-E 用例包不可稀释 | PASS | 上表五处突变各命中对应用例 |

## 共享接口影响

- 新增类型与端口，**零改动既有代码**：没有改 `CompanionRuntime`、`TurnTrace`、存储契约，也没有注册任何 kernel token（本 SPEC 无生产消费者，token 与装配留给接入那一份 SPEC，届时按「v1 之后的追加」记进 [共享契约](../../modules/CONTRACTS.md)）。
- `TraceSink` 的任何新实现都要跑 `trace.conformance.ts`。

## 待后续（本 SPEC 不做）

- 接入：Runtime / Presenter 发出完整事件序列、开关设置项、kernel token 与组合根装配——下一份 SPEC。
- `reportedTotal` 要有真实值，得等 provider 侧把 usage 透出来（`providerClient` 目前不解析 usage 字段）。
- NOT RUN：真实 Tauri 环境下 `plugin-sql` 执行本文的建表与清理语句，留 INT-01。
