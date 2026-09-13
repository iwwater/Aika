# FE-18 验收报告 · 环境契约、生命周期、撤销与摘要 TTL

日期：2026-09-14。状态：**PASS（模块内）**——依据 FE-18 正文与 2026-09-14 修订（FE-18-A～J），生产实现 + fake source + 假时钟。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `aika-crossplatform/src/domain/environment.ts` | 新增：`ENVIRONMENT_SCHEMA_VERSION`、`EnvironmentEvent`（五 kind 信封）、`EnvironmentEventInput`（允许 title/text 的原始输入）、`normalizeEnvironmentEvent`（规范化与剥离的唯一放行点）、`eventRuleId`、字段上限与未来时间容忍常量 |
| `aika-crossplatform/src/services/environment/contracts.ts` | 新增：`EnvironmentSource`（id/kind/start→幂等 stop）、`EnvironmentMonitor`、`EnvironmentSnapshot`、状态机 `off/starting/running/stopping/denied/error`、`EnvironmentSourceError`/`EnvironmentMonitorError`、`ProactivePolicy(Input/Decision)`、三个 token（`environment.sources` / `environment.monitor` / `environment.proactivePolicy`） |
| `aika-crossplatform/src/services/environment/monitor.ts` | 新增：生产 `createEnvironmentMonitor`——schema 防御、去重（默认 2000ms）、频控（默认 60/分钟滚动窗口）、recent（TTL 60000ms、上限 20、按源隔离）、前台快照、生命周期（generation 撤销、逐源串行 start/stop、stopAll 先撤销后等待、dispose 幂等）、诊断计数 |
| `aika-crossplatform/src/services/environment/summary.ts` | 新增：`buildEnvironmentSummary` 模型出口 DTO（process/kind/词表 ID/置信度/年龄/前台时长，无原文） |
| `aika-crossplatform/src/services/environment/fakeEnvironment.ts` | 新增：手动时钟、可编程 fake source（预排队 resolve/reject、旧 generation 回放、停止行为）、`createIgnoreAllPolicy`、consumer 测试用 fake monitor |
| `aika-crossplatform/src/services/environment/environment.conformance.ts(+.test.ts)` | 新增：共享用例包（A/B/C/D/G/H/I/J 共 30 例），生产 monitor 跑全套 |
| `aika-crossplatform/src/services/environment/environmentPolicy.test.ts`、`summary.test.ts` | 新增：policy 纯度与 normalize 边界、摘要 DTO 测试 |
| `aika-crossplatform/src/app/plugins/environmentPlugin.ts(+.test.ts)` | 新增：`environmentPlugin`（FE-18-F 装配语义），未接线到默认装配（FE-19/22 接线） |
| `docs/modules/CONTRACTS.md` | 「v1 之后的追加（2026-09-14，FE-18）」登记 |

## 测试命令与退出码

在 `aika-crossplatform/` 目录执行：

| 命令 | 结果 |
| --- | --- |
| `npx vitest run src/services/environment src/app/plugins/environmentPlugin.test.ts` | **43 passed（0 failed），退出码 0** |
| `npx vitest run src/kernel`（含 architecture.test.ts 门禁） | **77 passed（0 failed），退出码 0** |
| `npx tsc --noEmit` | **无错误，退出码 0** |

## 逐 AC 证据

| AC | 证据 | 状态 |
| --- | --- | --- |
| FE-18-A | conformance「schema 防御」4 例：缺版本/版本不符/未知 kind（3 拒，`schemaRejected=3`）、NaN/Infinity/越界 confidence 与 idleSeconds（5 拒）、sourceId/eventId/epoch 空或伪造（3 拒）、宿主 epoch 不匹配（`staleEpochRejected=1`）、注入墙钟时未来时间拒绝（`futureTimestampRejected=1`）；均零广播不抛错 | PASS |
| FE-18-B | conformance「汇聚语义」3 例：双源按序广播 `["a1","b1","a2"]`、退订后零送达；单 listener 抛错隔离（另一 listener 照常收到 `e1/e2`，`listenerErrors=2`）；onStateChange listener 抛错隔离 | PASS |
| FE-18-C | conformance「去重与频控」3 例：同 payload 2000ms 内只广播一次（`dedupeDropped=1`）窗口过后再通过；不同 payload 与跨源不去重；`maxPerMinute=3` 时第 4/5 条静默丢弃（`rateLimitedDropped=2`），滚动窗口滑过后恢复 | PASS |
| FE-18-D | conformance「快照」4 例：foreground 更新为 `{process, since}`、其他 kind 不改快照；A→B→A 去重省略广播但快照落最新 A（since=20）；标题在规范化入口剥离（快照/广播事件 JSON 均无 "secret.txt"，payload 无 title 属性）；source 关闭快照失效 | PASS |
| FE-18-E | `environmentPolicy.test.ts`：默认策略五 kind 全 ignore 且 reason 含 kind；同输入同输出（三次求值相等）；`userBusy=null` 不触发。conformance 对生产 monitor 全绿（43/43），只有 source 用 fake | PASS |
| FE-18-F | `environmentPlugin.test.ts`：无 sources 时 `environment.monitor` tryResolve 为 null、`environment.proactivePolicy` 恒注册（真实内核 `kernel.start()` 报告 ok）；有 sources 时两者注册且 monitor 可启停广播；kernel/architecture.test.ts 77 例全绿（含 resolve 白名单、token 分散、平台判断门禁） | PASS |
| FE-18-G | conformance「生命周期」8 例：ready 前 abort → 迟到 stop 执行（stopCount=1）、终态 off、旧回调零广播（`staleGenerationDropped>0`）；denied/普通失败分列且可重试；3 次开关 start/stop 计数一致；running 重复 enable、off 重复 disable 幂等；stop 抛错落 error（不伪称 off）清缓存可重试；一源 stop 失败 stopAll 仍停其余；旧 generation 回放零广播、新 generation 正常；stopAll 先撤销清空再等待、dispose 幂等并拒绝再启用；未知 sourceId 抛 `unknown_source` | PASS |
| FE-18-H | conformance「recent 与 TTL」3 例：第 21 条挤出最旧（`evt-1`…`evt-20`）；60000ms 边界过期（59999 在、60000 无），事件 `timestamp: 0`（墙钟回拨极端值）不延长 TTL；关单源只清它的 recent，stopAll 清空全部 | PASS |
| FE-18-I | conformance「敌意输入」：标题、1.6 万字符 OCR text、NaN confidence、旧 epoch、异常 listener 同时注入——广播/recent JSON 无 SECRET-TITLE/SECRET-OCR-TEXT，`schemaRejected=1`、`staleEpochRejected=1`、`listenerErrors=2`，后续事件照常入 recent。`summary.test.ts`：DTO JSON 无 SECRET，仅 process/kind/ruleId/置信度/年龄 | PASS |
| FE-18-J | conformance「状态轨迹」2 例：`starting→running→stopping→off`（onStateChange 实录）；denied 可见且 `JSON.stringify(status)` 不含拒绝正文（错误只含代码） | PASS |

## 共享接口影响

- 见 `docs/modules/CONTRACTS.md` 2026-09-14 FE-18 追加节；无既有接口变更。
- 消费者：FE-19（foreground source / environmentPresenter / contextSource）、FE-21（screen source）、FE-22（ruleProactivePolicy + presenter 接线）。
- 本 SPEC 交付的 policy/monitor 暂无生产调用方（同 `prefetch?` 先例，先冻结契约）；未装配进默认 `capabilityPlugins()`，既有聊天链路零影响。

## 待联调 / 未覆盖

- FE-18-K 类真实传感器生命周期（enable 失败清理、真实 Win32 hook 迟到事件）归 FE-19/21 真机轨，本 SPEC 无真实 source。
- `environmentPlugin` 尚未进默认装配：sources 由 FE-19 宿主探测后传入，消费接线归 FE-19/22。
- 真实模型上下文（contextSource 注入 AgentContext.environment）归 FE-19-D。
