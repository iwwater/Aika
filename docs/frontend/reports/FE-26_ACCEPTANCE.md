# FE-26 · F9 Ops 成本页 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全部通过，待人工审阅 UI 与真实数据；真实费用 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/domain/usageStats.ts`（新增） | 统计纯函数：`summarizeUsage`（按 attemptId 幂等去重、状态计数、错误率、coverage 分布、用途覆盖与未采集清单、时区日界线按日分桶、provider/model 分桶、null 感知 token 合计）、`priceForRecord`/`recordCost`（版本化价目按 providerId+model+生效日匹配，输入/输出分别计价，金额 9 位小数舍入）、`localDayKey`/`isValidTimeZone`、`validatePriceEntry`（非法/负值拒绝）、`PriceEntryV1`/`PricingConfigV1` |
| `aika-crossplatform/src/presentation/opsPresenter.ts`（新增） | OpsPresenter：cursor 翻页累积 + `coverageNote`（已载页数/是否只覆盖已载入部分/保留期截断/采集关闭如实标注）、价目从设置 KV 装载（损坏按空价目处理并明说）、`savePrice` 校验失败拒绝、保存/删除失败回滚内存态、`setTimeZone`、`available=false`（未装台账）路径 |
| `aika-crossplatform/src/pages/OpsPage.tsx`（新增） | 成本页：总览（状态/错误率/上报完整度/最慢尝试/token/估算费用+「非官方账单」标注/用途覆盖含未采集清单）、按日表、按 Provider/模型表、价目表单（每百万单价、币种、生效日）、载入更多按钮 |
| `aika-crossplatform/src/hooks/useOps.ts`（新增） | Presenter ↔ React 绑定（同工作台其它 Hook 形状） |
| `aika-crossplatform/src/pages/DevToolsPage.tsx` | 工作台新增「成本」页签（F9 入口） |
| `aika-crossplatform/src/presentation/{tokens.ts,opsPresenter}` | `OpsPresenterToken`（总是注册：没装台账时页面显示「没有采集」） |
| `aika-crossplatform/src/app/plugins/{presentationPlugin,usagePlugin}.ts` | presentationPlugin 提供 OpsPresenter（store/采集开关 optional 注入）；usagePlugin 增提供只读 `UsageLedgerStoreToken` |
| `aika-crossplatform/src/services/storage/contracts.ts` | `SETTING_KEYS.usagePrices = "usage.pricing"`（版本化价目持久化键） |
| `aika-crossplatform/src/App.css` | ops-* 页面样式 |
| `aika-crossplatform/src/domain/usageStats.ts` | `UsageStatsSummary.slowestAttempt`：最慢物理尝试，只统计 `endedAt > startedAt` 的完整计时记录 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/domain/usageStats.test.ts src/presentation/opsPresenter.test.ts` | 0 | 2 文件 29 测试全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 90 文件 1133 测试通过、1 skip（既有 skip） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

过程中修复的装配缺陷：presentationPlugin 解析 `UsageLedgerStoreToken` 未在 `optional` 声明，触发内核 `DEPENDENCY_NOT_DECLARED` 拒绝启动（composition.test 捕获）——已声明，门禁机制按设计工作。

## 逐 AC 证据

### FE-26-A：重复事件幂等；分页覆盖范围明确，时区日界线确定

- 幂等：`usageStats.test.ts`「重复事件幂等：同 attemptId 只算一次」——同 id × 3 → records=1、duplicatesAbsorbed=2、token 只算一份。
- 分页覆盖：`opsPresenter.test.ts`「cursor 翻页累积，覆盖范围说明写清…」——pageSize 2 / 3 条 → hasMore、coverageNote 含「只覆盖已载入部分」；载完不再出现；「refresh 重置到第一页，截断标志不带历史包袱」。
- 时区日界线：「同一时刻在 UTC 与 Asia/Shanghai 落在不同日」（2026-01-01T20:00Z → UTC 01-01 / +08 01-02）；「非法时区按 UTC 处理，不抛错」；presenter `setTimeZone` 改变分组。

### FE-26-B：缺 usage/价格/用途显示未知与覆盖率，不用 estimatedPrompt 兜底

- 缺价目/缺分项 → `costByCurrency` 为空时页面显示「未知（无价目或缺分项）」并给出 `unpricedRecords` 条数（`「费用按币种分开合计…无价目/缺分项计入 unpriced」`、presenter「start 载入第一页」a2 计入 unpriced）。
- 缺用途 → `missingPurposes` 显式列出（「未采集的用途显式列出，不当 0」），页面标注「（未采集不按 0 计）」。
- 覆盖率 → `coverageCounts`（reported/partial/unknown）如实进页面「上报完整度」行。
- estimatedPrompt：统计函数输入只有 `UsageRecordV1`（LLM-12 台账），代码路径里不存在 estimatedPrompt 字段；token 合计全 null 时显示「未知」。

### FE-26-C：输入输出/缓存计价不重复；币种分开，不自动汇率换算

- SPEC 算例：input=1000/output=500、单价 2/8 → **0.006 USD**（`「recordCost 与 SPEC 算例」`）。
- 输入/输出各乘各的单价恰好一次；只有 total 的记录不计价不拆分（「只有 total 的记录不拆分、不计价」）。
- 币种分开：prov-a USD 6 / prov-b CNY 10，互不相加（「费用按币种分开合计，不自动换算」）。
- 缓存：台账未采集缓存分项，无字段可重复计价；页面价目区固定说明「缓存分项当前未采集，费用不含缓存折扣」。

### FE-26-D：错误率分母和取消定义明示；最慢轮只用完整计时

- 错误率：`failed/(completed+failed)`，cancelled/unfinished 单独计数（「错误率分母与取消定义」断言 2/3 与各状态计数）；分母为 0 → null（不是 0），页面写明公式。
- 最慢尝试：`slowestAttempt` 只统计 `endedAt > startedAt` 的记录——补登记（startedAt==endedAt，开始时间未知）与无终态记录不参与（「最慢尝试只用完整计时」断言 fallback/running 被排除、slow=890ms 胜出）；无完整计时时是 null。

## 共享接口影响与消费者

- 新增 `OpsPresenterToken`（presentation 层）、`UsageLedgerStoreToken`（只读）、`SETTING_KEYS.usagePrices`——均为增量，已登记于本次与 LLM-12 报告；`CONTRACTS.md` 的 LLM-12 段已含 store/recorder 消费者关系（FE-26 经 OpsPresenter）。
- DevToolsPage 新页签为纯增量；kernel 装配门禁（optional 声明）按预期拦截过一次漏声明并已修复。

## 未执行 / 待人工

- **真实费用 NOT RUN**：无真实 Provider 凭据与官方账单可比对；页内金额一律标注「估算费用／非官方账单」。
- UI 目视验收（页签布局、表单交互、空态文案）留人工——仓库无 DOM 测试环境，页面组件只有类型级验证。
- 真实 Tauri plugin-sql 下 `usage_records` 查询与设置 KV 持久化行为归 INT-01 同款真实环境验证（未在本 SPEC 范围内扩大）。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工，不代表发布可用。
