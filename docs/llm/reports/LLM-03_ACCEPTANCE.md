# LLM-03 验收报告：Memory 与 User Soul

- 模块 / 小阶段 / SPEC 版本：LLM / LLM-03 / `docs/llm/specs/LLM-03_MEMORY_USER_SOUL.md`
- 基础分支：`master`（本轮未提交、未推送）
- 状态：工程实现、存储接入、运行时接入完成并通过定向自测；AC-D 已用真实模型（qwen-plus）跑通 10 个跨会话样本，10/10 命中、无伪造来源、无候选当确证
- 真实依赖：SQLite FTS5 用 Node 内置 `node:sqlite`（SQLite 3.45.3）真实跑通；真实模型走用户提供的 OpenAI 兼容工作空间端点（凭证放 `.env`，已 gitignore）
- 前置：LLM-01 的真实输出质量审阅仍未结项；本报告不追认 LLM-01-D

## 改动文件

新增生产代码：

- `aika-crossplatform/src/domain/memoryRetrieval.ts`：三语分词、无索引 BM25、`0.7*relevance + 0.2*recency + 0.1*importance`、`factTimeOf`、`isEligible`/`temporalStatusOf`、条数与 token 预算裁剪
- `aika-crossplatform/src/domain/userSoul.ts`：`soulEntryStatus`（user 来源或 ≥2 个不同消息来源才确认）、`confirmedUserSoul`、`applySoulEvidence`、`applySoulCorrection`、`dropSoulSources`、`describeUserSoul`
- `aika-crossplatform/src/services/memory/memoryStore.ts`：`MemorySnapshot`/`MemorySuppression`/`MemoryV2Store` 端口（含可选 `searchIds`）与内存实现
- `aika-crossplatform/src/services/memory/memoryRepository.ts`：`retrieve`/`upsert`/`supersede`/`forget`/`migrateLegacy`/`list`；索引候选优先 + 全量兜底、抑制标记、无改动不写盘
- `aika-crossplatform/src/services/memory/sqliteMemoryStore.ts`：`memories_v2` + `memory_fts`（**trigram**）+ 抑制表；`BEGIN→内容→FTS→抑制标记→迁移版本→COMMIT`，失败 `ROLLBACK`；`ftsQueryOf`/`searchMemoryIds`
- `aika-crossplatform/src/services/memory/localMemoryStore.ts`：localStorage 单次快照替换
- `aika-crossplatform/src/services/memory/writeback.ts`：后台写回队列与重试（默认 3 次）
- `aika-crossplatform/src/services/memory/memorySource.ts`：接到 LLM-02 `ContextSource`
- `aika-crossplatform/src/hooks/hookHarness.ts`：共享的 Hook 测试运行时（从 integration 测试提取）

修改的既有文件：

- `aika-crossplatform/src/domain/memory.ts`：新增 `MemoryRecordV2`、`migrateMemoryRecord`、`createMemoryV2`、`memoryContentHash`、`memoryTypeFromCategory`、`memoryCategoryFromType`、`toLegacyMemoryRecord`；V1 的 `MemoryRecord`/`createMemory`/`memoryLines` 未动
- `aika-crossplatform/src/domain/context.ts`：`ContextSnippet.temporal`；memory 段落新增「（未确认）」「（已过去）」标注
- `aika-crossplatform/src/domain/soul.ts`：**修复了 5 条既有类型错误**（126/139/144/145/147 行）：`normalizeModeConfig` 的 `raw` 显式标注 `Partial<ModeConfig>`；`normalizeChoice` 的 allowed 数组加 `as const`。全仓 `tsc` 由此恢复可用
- `aika-crossplatform/src/services/storage/contracts.ts`：`AikaStorage` 新增可选 `memoryV2`（MemoryV2Store）与可选 `deleteSummaries()`
- `aika-crossplatform/src/services/storage/sqliteStorage.ts`：建 V2 表与 FTS（FTS 失败只降级不阻断启动）、`memoryV2: createSqliteMemoryStore(db, { fts })`、`deleteSummaries`
- `aika-crossplatform/src/services/storage/localStorageStorage.ts`：`memoryV2: createLocalMemoryStore(browserBackend())`、`deleteSummaries`
- `aika-crossplatform/src/hooks/useCompanionSession.ts`：启动时建 V2 仓储并把 V1 记忆迁入（幂等）；`confirmMemory` 写 confirmed + `lastConfirmedAt`；`deleteMemory` 走 `forget`（抑制标记 + 摘要失效）；抽取写回带来源消息 id 写 V2；`buildContext` 改为按本轮 query 检索注入（主动消息回退最近记忆，无 V2 时维持旧路径）
- `aika-crossplatform/src/hooks/useCompanionSession.integration.test.ts`：改用共享 harness；在 `send` 后补 `flushMicrotasks`（检索是异步的，流建立需要微任务推进），断言本身未放宽

新增测试：

- `aika-crossplatform/src/domain/memoryRetrieval.test.ts`
- `aika-crossplatform/src/domain/userSoul.test.ts`
- `aika-crossplatform/src/services/memory/memoryRepository.test.ts`
- `aika-crossplatform/src/services/memory/writeback.test.ts`
- `aika-crossplatform/src/services/memory/sqliteMemoryStore.test.ts`（假执行器：SQL 结构与调用顺序）
- `aika-crossplatform/src/services/memory/sqliteMemoryStore.real.test.ts`（**真实 SQLite**：建表、事务回滚、FTS 命中与兜底）
- `aika-crossplatform/src/services/memory/crossSession.test.ts`（fixture harness：AC-D 装配侧）
- `aika-crossplatform/src/services/memory/crossSession.real.test.ts`（**真实模型执行器**，默认 skip）
- `aika-crossplatform/src/hooks/useCompanionSession.memoryV2.test.ts`（接入侧）

固定样本：`docs/llm/reports/evidence/LLM_03_RETRIEVAL_FIXTURE.json`（35 条三语记忆 + 20 个问题）

## AC 证据

| AC | 生产行为与测试证据 | 结果 |
| --- | --- | --- |
| LLM-03-A | 固定样本 35 条记忆（含 2 条过期、1 条 superseded）覆盖中/日/英；15 个有答案问题全部 Top-5 命中（门槛 ≥13），5 个无答案问题全部返回空集；superseded 与过期非事件记忆不出现在结果中；过期事件返回且 `temporalStatus === "past"` | PASS（`memoryRepository.test.ts`；fixture：`LLM_03_RETRIEVAL_FIXTURE.json`） |
| LLM-03-B | 访问只更新 `lastAccessedAt` 不自动确认；supersede 原子；注入写失败快照保持旧值；`forget` 落抑制标记（快照序列化后不含被删正文），同来源不复活、`userEdit` 可重新记住；删除不存在不产生写入；V1→V2 迁移两次不丢失不重复、不伪造来源；localStorage 写失败旧快照逐字节不变。**真实 SQLite**：事务中途失败整批回滚、二次保存覆盖不累积、FTS 与内容同生共死、`migrationVersion` 写进 settings | PASS（`memoryRepository.test.ts` + `sqliteMemoryStore.real.test.ts`） |
| LLM-03-C | 单候选不进 `confirmedUserSoul`；同 messageId 重放不算第二份证据；两个不同来源晋升 confirmed；`userEdit` 直接确认；用户纠正取代表述且保留原 `message` 来源；`dropSoulSources` 降级/移除画像条目；Hook 的确认/删除操作真实落到 V2 | PASS（`userSoul.test.ts` + `useCompanionSession.memoryV2.test.ts`） |
| LLM-03-D | 装配侧：10 个跨会话样本全部正确注入期望事实（门槛 ≥8）、无孤儿事实、候选标「（未确认）」、过期标「（已过去）」、删除后不泄漏。**真实模型：REAL RUN**——qwen-plus（OpenAI 兼容工作空间端点，凭证来自 `.env`），10 个样本全部走真实生产 `检索 → buildInstructions → streamChat`；10/10 命中注入事实（门槛 ≥8）、0 请求失败、「凭空声称记得且无依据」0 例；对没有依据的问题模型诚实回答「还没听你提过」（honestDenials: 1），没有编造来源。证据：`LLM_03_REAL_CROSS_SESSION.json`（注入内容、注入精度/时态、期望与命中关键词、真实回复全文；不含凭证） | 装配侧 PASS（`crossSession.test.ts`）+ 真实模型 REAL RUN PASS（`crossSession.real.test.ts`，需 `AIKA_REAL_LLM=1` 显式启用，日常测试默认 skip） |

## 测试记录

LLM-03 定向名单（在 `aika-crossplatform/` 下运行）：

```text
npx vitest run src/domain/memoryRetrieval.test.ts src/domain/userSoul.test.ts src/services/memory src/hooks/useCompanionSession.memoryV2.test.ts
```

结果：`7 passed (7)`，`51 passed (51)`，退出码 `0`。

全仓验证（本轮同时修复了 `soul.ts` 类型错误与多处测试文件的 `lib` 兼容问题，属于跨模块修复，因此做了全仓门禁）：

```text
npx vitest run
npx tsc --noEmit
```

结果：`42 passed (42) + 1 skipped (43)`（跳过的是默认关闭的真实模型样本），`425 passed (425) + 1 skipped (426)`，退出码 `0`；`tsc --noEmit` 退出码 `0`。

真实模型样本（AC-D，真实付费请求，需显式启用）：

```text
$env:AIKA_REAL_LLM="1"; npx vitest run src/services/memory/crossSession.real.test.ts
```

最终结果：退出码 `0`，`1 passed (1)`，耗时约 23s。凭证从 `aika-crossplatform/.env`（已 gitignore，配套 `.env.example` 模板）读取。执行器对凭证缺失的行为已验证过：退出码 `1`，断言信息「没有可用的真实 Provider 配置（环境变量或标准安全存储）」。

### AC-D 真实模型运行记录（三轮）

第一轮：命中数达标，但「伪造来源」规则报 1 例（r01）。**复核为规则误报**：查询「他平时喝什么咖啡」里注入的记忆「喝咖啡只喝浅烘焙，不加糖」没有主语，模型把它合理理解成 Aika 自己的偏好并诚实回答「还没听你提过」——没有编造，反而暴露了两个真实问题：①注入内容没有说明主语是用户；②「诚实否认」被当成伪造。

第二轮：把样本查询统一改成第一人称对话口径（两个 fixture/真实样本文件同步），并在 `formatRetrievedSections` 的注入声明里明确「[memory] 是关于对方（用户）的记录」。规则报 1 例（r02）：模型说「塩気のあるお菓子が好きだって、ちゃんと覚えてるよ」——它引用了注入事实，只是依据检查只匹配注入内容前 4 个字符（「甘いもの」），跨句引用全部失配。**仍是误报**，依据检查改为任意 4 字滑窗 + 关键词命中。

第三轮：报 2 例（r03、r08）。r03 是跨语言转述导致滑窗失配的误报（关键词命中即算有依据，已修）。**r08 是真实质量失败**：注入的是未确认候选（已带「（未确认）」标记），模型仍用确定语气复述并添了细节（鸭川、樱花）——正是 AC-D「把未确认当已确认为 0」要抓的行为。对应的生产修复：注入声明中明确「标注（未确认）的行只是候选，要用『好像听你说过』的说法，不要用确定语气复述，更不要替它补充细节」。

最终轮：`10/10` 命中、`claimWithoutEvidence = 0`、`honestDenials = 1`（模型对没有依据的问题说「还没听你提过」）、`0` 请求失败，测试通过。真实回复全文保存在 `LLM_03_REAL_CROSS_SESSION.json`，留给原任务审阅自然度与角色一致性。

需要审阅者注意的质量观察（不构成 AC 失败，但属于真实模型质量范畴）：

- r02：模型在引用正确事实后自行补充了「海苔仙贝、奶酪饼干」两个例子，并明确说「想像するだけで」——是合理联想，但属于「替记忆添细节」的边缘行为。
- r08 修复后候选记忆不再被确定语气复述，但「模型会不会仍然添细节」依赖 prompt 约束，建议在 LLM-01-D 质量审阅中一并评估。

## FTS5 实测结论（重要）

实测环境：Node 24 内置 SQLite 3.45.3，FTS5 可用。

- **`unicode61` 不可用于中日文**：它把连续汉字/假名整段当成一个 token（「喝咖啡只喝浅烘焙」是一个 token），检索「咖啡」「浅烘焙」「電車」全部落空。因此索引分词器最终选了 **`trigram`**。
- **`trigram` 支持 3 字符以上子串命中**：「浅烘焙」「喝咖啡」「起きる」「allerg」「peanut」均命中；**2 字中文词（「咖啡」「通勤」）无法命中**（trigram 需要 3 个字符）。
- 由此检索设计为：SQLite `searchIds` 只做**候选召回加速**；候选为空或候选内无命中时，repository 回退**全量 BM25**（`rankMemories`）。检索结果的正确性由应用层保证，不依赖分词器局限。数据量上到需要真正依赖 FTS 时，需要重新评估召回率。
- 真实 Tauri 环境里 `@tauri-apps/plugin-sql` 若未编译 FTS5，`ensureMemorySchema` 会返回 `{ fts: false }`：记忆表照常建、索引跳过、检索全量兜底，**应用启动不会因此失败**。

## 明确未做与后置项

- **AC-D 真实模型 BLOCKED**：等待凭证。拿到 `AIKA_LLM_API_KEY`（或应用在本机运行一次写入标准存储）后，一条命令即可补跑。
- **Tauri 内 `plugin-sql` 真机验证 NOT RUN**：本轮真实 SQLite 用的是 Node 内置引擎，SQL 与事务语义一致，但驱动（Rust sqlx）与迁移时序要在应用里跑一次才算集成通过（INT-01）。
- **UserSoul 尚未持久化**：`domain/userSoul.ts` 的晋升/纠正规则已实现并有测试，但没有存储位；`forget` 的 Soul 联动（`dropSoulSources`）已实现待接入。落库与接入归 LLM-04/05 或 INT-01。
- **写回抽取未切到 writeback 队列**：Hook 目前直接 `repository.upsert`；`createMemoryWriteback`（重试、失败不丢）已实现并有测试，切换它属于 LLM-04 的「后台写回」范围，本轮不抢跑。
- `soul.ts` 的 5 条既有类型错误已在本轮修复（原属 LLM-01 遗留）。

## 共享契约影响

- `AikaStorage` 新增**可选** `memoryV2` 与可选 `deleteSummaries`：旧实现与测试 fake 不提供时，Hook 走原有 V1 路径（`useCompanionSession.integration.test.ts` 未提供 `memoryV2`，全部通过）。
- `send` 的行为变化：发起 Provider 请求前先按本轮 query 检索记忆（异步），因此 `session.send(...)` 到流建立之间需要一次微任务推进；对真实 UI 无感，对测试补了 `flushMicrotasks`。
- `ContextSnippet.temporal` 为新增可选字段；`formatRetrievedSections` 的 memory 行新增「（未确认）/（已过去）」后缀。
- 无 STT/TTS/前端组件改动。

## 集成待测项

- INT-01：真机启动一次，确认 V1 记忆迁移进 V2、记忆页读写的是同一批数据、删除记忆后摘要被作废。
- INT-01：`createMemoryWriteback` 接管抽取写回；`UserSoul` 落库后把 `dropSoulSources` 接进删除联动。
- 「未确认候选被确定语气复述/添细节」已通过注入声明修复并通过本轮真实样本，但 prompt 约束的长期稳定性建议并入 LLM-01-D 的质量审阅一起看。

执行者自测结论：LLM-03 的检索排序、来源/类型/重要度/有效期/访问时间、candidate/confirmed/superseded、快照事务与失败不变性、删除抑制与不复活、迁移幂等、画像双证据晋升与用户纠正优先、**存储层与运行时接入**、以及 **AC-D 的真实模型 10 样本（qwen-plus，10/10 命中、0 伪造、0 候选当确证）**均已完成定向复测并通过；真实 SQLite（含 FTS5 trigram 行为）已在 Node 内置引擎上真实跑通。真实回复全文待原任务审阅自然度与角色一致性。
