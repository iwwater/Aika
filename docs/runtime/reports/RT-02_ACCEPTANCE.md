# RT-02 · 身份绑定与会话隔离 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全部通过，待人工审阅；真实 Tauri 库迁移与真实渠道入口 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/domain/identity.ts` | `AccountKeyV1`（platform/botAccount/tenant/sender 四元组）、`ConversationScopeV1`、`canonicalScopeKey`（存储/去重/排序统一规范键，杜绝跨 tenant 混键）、`canonicalAccountKey`、`LOCAL_CONVERSATION_SCOPE` |
| `aika-crossplatform/src/domain/conversation.ts`、`domain/summary.ts` | `ChatMessage.conversationId?` / `SessionSummary.conversationId?`（可选；无字段=legacy 本地） |
| `aika-crossplatform/src/services/storage/contracts.ts` | `listMessages(limit, scope?)`、`listMessageTimestamps(scope?)`、`latestSummary(scope?)` 可选 scope 参数；`SETTING_KEYS.identityBindings` |
| `aika-crossplatform/src/services/storage/sqliteStorage.ts` | MIGRATIONS 增加 messages/summaries 的 `conversation_id` try-ALTER（12→16）；scope 谓词 `scopeMatch`：local 同时匹配 NULL legacy 行、其它 scope 精确匹配（带转义）；消息/摘要写入带 scope；读取归一 `conversationId ?? "local"` |
| `aika-crossplatform/src/services/storage/localStorageStorage.ts` | 同一 scope 语义的 JS 版过滤（旧数据=legacy 本地） |
| `aika-crossplatform/src/services/identity/binding.ts`（新增） | 绑定服务：本地签发一次性限期码（TTL 5min）→ 外部凭码+账户键认领（码一次性、already-bound 计数、`MAX_CLAIM_ATTEMPTS_PER_CODE=5` 防暴力、无效账户键拒绝）；`principalFor` fail-closed；`unbind` 即失效；绑定 KV 损坏按「无任何绑定」处理；新实例同库恢复 |
| `aika-crossplatform/src/services/runtime/scopedStorage.ts`（新增） | `createScopedRuntimeStorage`：按会话过滤的 RuntimeStorage 视图（list/append/timestamps/summary 全走 scope） |
| `aika-crossplatform/src/services/runtime/companionRuntime.ts` | ① `SubmitRequest.conversation?`（缺省 legacy 本地，旧调用方行为一字不变）；② `createScopeView`：每轮提交时固定 scope 并拿专属存储视图，在途 I/O 闭包不共享可变 scope；③ 单生成槽 + 每会话活动轮：同会话保持「新提交取消旧轮」并立即接管槽位（旧时序不变），跨会话进 `MAX_WAITING_TURNS=8` 有界队列不取消别人的轮、满则显式 `SESSION_QUEUE_FULL`；④ revision 按 conversation 分桶；⑤ `cancel(turnId, scope?)` 校验轮次归属；⑥ dispose 收敛全部会话活动轮 |
| `aika-crossplatform/src/services/context/contextAssembler.ts` | `ContextSourceScope`/`AssembleInput` 增加 conversationId/principalId 透传；runtime 组装时带上轮次 scope |
| `aika-crossplatform/src/services/memory/memorySource.ts` | 个人记忆授权门：principalId 非本地（外部/unknown/空）→ 0 片段；legacy 未声明=本地行为不变 |
| `aika-crossplatform/src/domain/trace.ts`、`services/runtime/companionRuntime.ts` | `TraceEventBase.conversationId?`（可选增量）；runtime 6 个事件源写入 scope；redact 走 `...event` 透传 |
| `aika-crossplatform/src/app/plugins/runtimePlugin.ts` | 接线 `createScopeView: (scope) => createScopedRuntimeStorage(storage, scope)` |
| `docs/modules/CONTRACTS.md` | 登记「2026-09-13，RT-02 会话隔离」追加表 |

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/services/runtime/companionRuntime.scopes.test.ts src/services/identity/binding.test.ts` | 0 | 16 测试全过 |
| `npx vitest run src/services/memory/memorySource.gate.test.ts` | 0 | 1 测试过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 97 文件 1168 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

既有测试同步（未削弱）：`sqliteStorage.test` 迁移计数断言 12→16（新加 2 条 try-ALTER × 2 次开库，注释说明由来）；`runtimeFacade.test` 白名单补 `scopedStorage.ts`（Runtime 类型消费方）。

## 逐 AC 证据（`companionRuntime.scopes.test.ts` 为**真实生产 Runtime + 真实 SQLite（node:sqlite）+ 真实 scoped storage**，仅 Provider 用 fake）

### RT-02-A：绑定码过期/重复/暴力拒绝；解除即失效（`binding.test.ts`）

一次性（同码第二次 invalid-code）、过期（TTL 后 expired）、防暴力（错误码不可探测；同码 already-bound 计数到 5 即作废）、重复绑定拒绝且旧主体不被顶替、`unbind` 后 `principalFor` 立即 null、存储损坏 fail-closed、重启（新实例同库）恢复。外部声明 userId 无效：四元组缺字段 `invalid-account`。

### RT-02-B：群聊/私聊/不同 tenant 历史、回复、敏感记忆零串线

- 历史：conv-A 提交「A的秘密」→ conv-B 轮的 Provider 上下文 history **不含** A 的消息与回复；回到 A 则不含 B 的（「历史零串线」）。
- 摘要：conv-A 的 scoped summary 对 conv-B 轮不可见（summary=null），A 轮可见（「摘要零串线」）。
- 关系信号：`listMessageTimestamps(conv-B)` 为空、conv-A 精确返回（「关系信号按 scope 隔离」）。
- 存储回复隔离：A/B 各自的 listMessages 不含对方内容（「跨会话不取消」断言）。

### RT-02-C：并发输入每 conversation 有序，迟到结果不回错目标

- 跨会话：A 在跑时 B 提交 **不取消 A**，两轮完整完成且落库各归各（单生成槽串行）。
- 同会话：旧「新提交取消旧轮」语义原样保留（cancelled + 新轮 completed）。
- 迟到结果：revision 按 conversation 分桶 + 每轮固定 scope 视图——旧轮回调按 isStale 作废，不可能写入新轮；`useCompanionSession.integration` 既有「旧 chunk 与结算不清除新轮 pending」用例继续通过。
- 有界：1 运行 + 8 等待满后第 11 会话显式 `SESSION_QUEUE_FULL`，已排队 9 轮全部完成。
- 取消归属：带别的 conversation 的 cancel 是 no-op，自己会话的取消有效。

### RT-02-D：旧本地身份迁移可回退；没有明确绑定不能读取个人记忆

- 旧数据（无 conversationId）只归属 legacy local：local scope 读得到、外部 scope 读不到；legacy 归属不因新写入改变。迁移用 try-ALTER（可重复执行），旧行 NULL 语义保留，**回退 = 旧数据原样在 local 会话，无需改写**。
- 个人记忆门：`memorySource.gate.test` —— ext-*/unknown/空 principal 0 片段，legacy/本地主体照常。
- 绑定本身 fail-closed：绑定存储损坏 = 无任何绑定 = 无个人数据授权。

### RT-02-E：真实生产 Runtime + 两主体 scope 存储测试（非 fake router）

全部用例运行真实 `createCompanionRuntime`（生产编排）+ 真实 `createSqliteStorage`（真实 SQLite 引擎建表/迁移/查询）+ 生产 `createScopedRuntimeStorage`；覆盖摘要/关系信号/检索历史/取消/旧记录/并发排队 0 串线。

## 共享接口影响与消费者

- 全部为可选增量（CONTRACTS 已登记）；单主体桌面链路零行为变化（旧行为回归全绿）；`runtimePlugin` 已接线 scope 视图；Presenter/Hook 不传 conversation = legacy 本地。

## 未执行 / 待人工

- 真实 Tauri plugin-sql 环境的 try-ALTER 迁移与并发写未验证（node:sqlite 临时库已验证升级路径；真实库归 INT-01 真实轨 NOT RUN）。
- 真实外部渠道（Telegram 等）尚未存在——按执行计划，外部入口在 RT-03/GW 通过前保持关闭；绑定服务已就绪但无生产签码 UI（FE 绑定页后续）。
- 绑定外部主体的**个人记忆库**（每主体记忆存储）属 RT-04 写回信任边界；本份只保证「未授权不读」。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工，不代表发布可用。
