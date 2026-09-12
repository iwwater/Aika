# LLM-12 · Provider用量记录与成本数据端口 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全部通过，待人工审阅；真实计费 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/domain/usageLedger.ts`（新增） | `UsageRecordV1`（schemaVersion 1）、`UsagePurpose`（foreground/maintenance/summary/proactive/unknown）、`UsageAttemptStatus`（含 `unfinished`）、`UsageCoverage`、`resolveUsageCoverage`、`UsageLedgerQuery`/`UsageLedgerPage`、`USAGE_LEGACY_SCOPE`、`DEFAULT_USAGE_RETENTION_DAYS=30`、`USAGE_QUERY_DEFAULT_LIMIT=200`、`compareUsageRecords`、`RequestUsageSample` |
| `aika-crossplatform/src/services/usage/contracts.ts`（新增） | `UsageLedgerStore`（幂等 upsert + cursor 分页查询）、`UsageRequestOptions`（结构切片，usage 服务不 import providerClient）、`UsageObserveInput<T>`（泛型保形返回）、`UsageLedgerRecorder`、`UsageRecorderDiagnostics` |
| `aika-crossplatform/src/services/usage/memoryUsageLedger.ts`（新增） | 浏览器临时台账：Map + 幂等 upsert、保留期清理（节流）、容量上限逐出、legacy scope 过滤、keyset cursor 分页、`truncated` 标志 |
| `aika-crossplatform/src/services/usage/sqliteUsageLedger.ts`（新增） | SQLite 落盘台账：`usage_records` 表（可索引维度成列 + 整段 JSON payload）、`INSERT OR REPLACE` 幂等、保留期节流清理、`$N` 占位符、坏行跳过、同语义分页；支持跨实例恢复 |
| `aika-crossplatform/src/services/usage/usageRecorder.ts`（新增） | 采集侧：`observe()` 包装 options，按物理尝试登记 started（含 startedAt、providerId/protocol/model、purpose、turnId、scope）、终态按 attemptId 幂等补齐；写失败旁路化计数、待写队列有界（`USAGE_WRITE_QUEUE_LIMIT=64`，满则丢最旧并计数）；采集开关（与 Trace enabled 同源）关着不新写记录，已登记尝试照常写完不留半条 |
| `aika-crossplatform/src/services/usage/tokens.ts`（新增） | `UsageLedgerToken`（可选能力） |
| `aika-crossplatform/src/services/usage/usageLedger.conformance.ts`（新增） | 端口一致性用例包：幂等 upsert、固定顺序、scope 隔离/legacy 分组、purpose/provider/时间过滤、cursor 翻页不丢不重、保留期截断、重启恢复（可选 reopen） |
| `aika-crossplatform/src/services/providerClient.ts` | 新增 `onRequestUsage` 样本通道：`requestText` 单尝试 started/completed/failed/cancelled 各带本次用量；`streamChat` 每次物理尝试（4xx 去 stream_options 重试、受控 fallback、断流）独立 attemptUsage 取证，fallback 屏蔽内层 sendChat 的重复样本；`requestPurpose` 词汇表扩到 summary/proactive，**未声明默认从 foreground 改为 unknown**（原缺省是在猜，属契约修正）；`RequestMetric.purpose` 同步扩展 |
| `aika-crossplatform/src/services/runtime/providerAdapter.ts` | `usageRecorder` 可选入参；按 `input.source` 声明用途（proactive 轮记 proactive，其余 foreground），`observe()` 包装 options 后传给 `streamChat` |
| `aika-crossplatform/src/services/memory/extractor.ts` | `createModelMemoryExtractor(getProvider, usageRecorder?)`：抽取记 `maintenance`、摘要记 `summary`；未装台账时照旧透传 `requestPurpose` + 计量回调 |
| `aika-crossplatform/src/app/plugins/usagePlugin.ts`（新增） | `llm.usage` 插件：SQLite 执行器可用即落盘台账，否则内存临时台账（同一套语义）；`isEnabled` 读 TraceSettings.enabled（未装 tracePlugin = 不采集）；`capabilityPlugins` 已装配 |
| `aika-crossplatform/src/app/plugins/{runtimePlugin,presentationPlugin,index}.ts` | runtimePlugin/presentationPlugin optional 声明 `UsageLedgerToken` 并下传；companionPresenter 新增 `usageRecorder` 依赖注入 extractor |
| `docs/modules/CONTRACTS.md` | 登记「2026-09-13，LLM-12 用量台账」追加表与语义边界 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/domain/usageLedger.test.ts src/services/usage src/services/memory/extractor.test.ts src/services/runtime/providerAdapter.test.ts src/services/providerClient.test.ts` | 0 | 7 文件 98 测试全过 |
| `npx vitest run src/app src/presentation src/services/runtime src/services/memory src/services/knowledge src/services/context` | 0 | 25 文件 273 测试全过（受影响回归） |
| `npx vitest run src`（里程碑回归一次） | 0 | 88 文件 1104 测试通过、1 skip（既有 skip，非本次引入） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

过程中发现并修复的门禁违规：`usage/contracts.ts` 最初 import `providerClient`，违反 architecture.test 的「providerClient 调用方只剩 Runtime 适配器与记忆抽取」门禁——已重构为 domain 承载 `RequestUsageSample` + `UsageRequestOptions` 结构切片 + 泛型 observe，门禁用例恢复通过（`src/kernel/architecture.test.ts` 在全量回归内）。

## 逐 AC 证据

### LLM-12-A：四协议解析 fixture、attempt 与逻辑请求不重复汇总、四用途真实接线、未采集显式 unknown

- 四协议生产解析 fixture：`providerClient.test.ts`「LLM-10 用量上报」既有四协议非流式/流式解析用例（LLM-10-A/B）继续通过；本次新增样本层断言（同文件「物理请求用量样本（LLM-12）」）。
- attempt vs 逻辑请求：`「流式 4xx 去掉 stream_options 重试：两次尝试各自取证，不拿合并值冒充单次」`断言样本序列 `1:started, 1:failed, 2:started, 2:completed`、logicalRequestId 唯一、attempt 1 无用量、attempt 2 完整用量；`「退回非流式：fallback 是独立 attempt，内层 sendChat 的样本被屏蔽不重复」`断言 5xx 退回后恰好四条样本。
- 四用途真实接线：adapter `「前台轮次：observe 收到 foreground…」`/`「主动发起的轮次记 proactive」`（providerAdapter.test.ts）；extractor `「抽取记 maintenance，摘要记 summary——由实际调用方赋值」` 且 `「装了用量台账时，observe 收到真实配置与用途，包装后的 options 顺着请求走」`（extractor.test.ts）。recorder 侧 `usageRecorder.test.ts`「摘要用途与未知用途由调用方显式赋值」。
- 未采集显式 unknown：`「未声明用途的请求，计量 purpose 记 unknown，不猜成 foreground（LLM-12-A）」`；recorder 侧 unknown 记录 purpose 落库为 `unknown`。

### LLM-12-B：取消/失败/重试/末包缺失/仅 total/显式 0

`usageRecorder.test.ts` 六个独立用例：取消/失败→`coverage: unknown` 且 token 为 null（不冒充 0）；断流前部分用量→`partial`；仅 total→保留 total、分项 null、`partial`；显式 0→`reported` 且值为 0；末包缺失→终态照记 `unknown`。样本来源（providerClient 侧断流带出部分用量）由 providerClient.test.ts「断流前已收到的部分用量随终态带出」覆盖。`domain/usageLedger.test.ts` 覆盖 `resolveUsageCoverage` 边界。没有任何用估算或比例拆分补位的代码路径。

### LLM-12-C：持久 upsert 幂等、重启恢复、cursor 翻页、失败 store 不改请求

- 幂等：一致性用例包「按 id 幂等 upsert：终态覆盖开始登记」两个实现都过。
- 重启恢复：sqlite harness `reopen()` 用例（内存实现不承诺持久性，如实不提供 reopen）。
- 翻页：25 条 limit 10 → 3 页不丢不重、`nextCursor` 尽头为 null、`truncated` 如实；固定顺序（新→旧、同刻按 id 破平）单独用例。
- 失败 store 旁路化：`usageRecorder.test.ts`「写失败旁路化」——upsert 全部 reject 时 observe/emit 不抛、`writeFailures=2`、请求侧无感知；「待写队列有界」——容量 2 时 10 笔写入丢 7 计数可见、存活 2+1（挂起 1）。
- 「不改变原请求次数与对话终态」：recorder.observe 无任何 await、不抛（同步注册路径）；全量回归 1104 通过证明 Runtime/Presenter 行为未变。

### LLM-12-D：Trace 关 0 新记录、canary 不落库、scope 隔离/legacy 分组/截断可见

- Trace 关：`「采集关闭：0 条新记录，诊断也是 0」`；开关翻转语义（开始关→整条沉默；开始开→写完不留半条）共三个用例。
- canary：配置 `apiKey: "sk-CANARY-SECRET-123"` 与 baseUrl 主机名在 `JSON.stringify(records)` 中均不出现；记录字段本身没有正文/URL/key 位置（结构保证，不是过滤）。
- scope：recorder 用例（有 scope 带字段/无 scope 无字段）+ 一致性用例包「scope 隔离：无 scope 的归 legacy 分组，不混进任何主体」（legacy/char-1/char-2 互不可见、全量查询可见）。
- 截断覆盖率：查询页 `truncated` + `nextCursor` 一致性用例覆盖；生产装配当前不写 scope（单主体），如实落 legacy 分组。

## 共享接口影响与消费者

- `CONTRACTS.md` 已登记（见上表）。`RequestMetric.purpose` 词汇扩展与缺省修正影响 LLM-04 的计量消费方：仓库内 `writeback.test.ts` 及既有 providerClient 测试均显式传 purpose，未受缺省修正影响（全量回归通过）。
- 新增 optional token 不破坏既有插件装配（`plugins.test`、`capabilityPlugins.test`、`ports.swapMatrix.test`、`composition.test` 全过）。

## 未执行 / 待人工

- **真实计费 NOT RUN**：无任何真实 Provider 凭据，未对官方账单做任何比对；台账数字只证明采集与账目语义，不冒充官方用量。
- 真实 Tauri plugin-sql 环境下的 `usage_records` 行为未验证（INT-01 同款遗留，与既有 sqliteTraceSink 同边界）。
- FE-26 成本页（消费本端口）尚未实现；UI 呈现与人工验收归 FE-26。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工审阅，不代表发布可用。
