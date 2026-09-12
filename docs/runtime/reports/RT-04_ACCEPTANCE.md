# RT-04 · 来源与记忆写回信任边界 — 验收报告

日期：2026-09-13。执行者：goal worker（自动）。状态：**AUTO_PASS（自动 AC 全部通过，待人工审阅；真实外部渠道写回 NOT RUN）**。

## 改动范围

| 文件 | 内容 |
| --- | --- |
| `aika-crossplatform/src/domain/memory.ts` | `MemorySourceKind` 信任分级扩展：`"messages" \| "external-bound" \| "untrusted-material" \| "legacy" \| "userEdit"`（TEXT 列零迁移）；`MEMORY_SOURCE_KINDS`/`isMemorySourceKind`；`mayElevateToConfirmed(byModel)`（模型候选永不自行提升 confirmed）；`mayFeedUserSoul(sourceKind, status)`（User Soul 只收明确归属+经人确认：messages/legacy/userEdit 且 confirmed；external-bound/untrusted-material 即便人工确认也不归入本地画像）；`sourceKindForOrigin(origin, {bound, isGroupConversation, isAgentOutput, isQuotedMaterial})`（desktop→messages；绑定外部 DM→external-bound；群聊/Agent/引文/unknown/proactive→untrusted-material；未绑定外部→untrusted-material） |
| `aika-crossplatform/src/services/memory/sqliteMemoryStore.ts` | sourceKind 读取白名单改用 `isMemorySourceKind`（TEXT 列，零迁移；旧数据三值原样兼容） |
| `aika-crossplatform/src/domain/memoryAdmin.ts` | 新分级的管理页标签（「绑定外部主体（未核归属）」「不可信资料（群聊/引文/Agent）」） |
| `aika-crossplatform/src/services/memory/writeback.ts` | `MemoryMaintenanceOptions.authorizeWriteback?`：worker 在 `repository.upsert` **之前**逐批重查授权（RT-02-C「提交前检查」）；不 ok → 整批丢弃、不写入、不重试，`result.denied` 计数 + `writeback-denied:<reason>` 可见；未提供钩子 = legacy 单主体链路行为不变 |
| `docs/modules/CONTRACTS.md` | 登记「2026-09-13，RT-04 来源信任边界」追加表 |

既有行为零破坏：`mayFeedUserSoul`/`sourceKindForOrigin` 为新增纯函数（生产尚无自动 User Soul 更新可 gate）；writeback 不传 `authorizeWriteback` 时逐字节旧行为（既有 writeback 13 用例原样通过）。

## 测试命令与退出码

| 命令（cwd: aika-crossplatform） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run src/domain/memoryProvenance.test.ts src/services/memory/writeback.revocation.test.ts` | 0 | 11 测试全过 |
| `npx vitest run src`（里程碑回归一次） | 0 | 101 文件 1204 测试通过、1 skip（既有） |
| `npx tsc --noEmit -p tsconfig.json` | 0 | 无错误 |

## 逐 AC 证据

### RT-04-A：群消息/Agent 结果不能冒充用户自述或 confirmed

- `sourceKindForOrigin`：群聊/Agent 输出/引文材料（即使 origin=desktop）→ `untrusted-material`；proactive/environment → `untrusted-material`；已绑定外部 DM → `external-bound`（只认证发件人，不证明本人事实）。
- `mayElevateToConfirmed(true)` = false：模型抽取的候选任何情况下不能自行变成 confirmed；提升只经人（既有管理页确认/userEdit 路径）。
- 不可信资料与外部绑定内容即使被人工确认，`mayFeedUserSoul` 仍为 false——不归入本地用户画像（归属无法核实的保守默认）。

### RT-04-B：跨身份检索与写回 0 泄露；unknown 来源不自动提升

- 检索：RT-02 的 memorySource principal 授权门（外部/unknown/空 principal 0 片段）在本份回归中继续全绿（`memorySource.gate.test` 于全量内）。
- 写回：`sourceKindForOrigin("unknown")` → `untrusted-material`——unknown 来源只进候选队列待人工过目，没有任何自动提升路径。
- 会话 scope 双检查：检索前（memorySource 门）+ 提交前（writeback `authorizeWriteback` 重查），见下。

### RT-04-C：解绑/撤权后旧队列提交前重新检查

- `writeback.revocation.test`：入队时授权在、提交时已解绑 → 批次在 `repository.upsert` **之前**被拒（`upsert` 零调用）、`denied=1`、`writeback-denied:binding-revoked` 可见、批次丢弃不重试；撤权批次被拒不影响同队列其它批次的正常提交；授权正常时写入照旧。
- 该钩子由组合根接到绑定服务（`binding.principalFor` + RT-03 撤权）——生产当前唯一写回方是本地链路，外部渠道接入（GW）时必须提供此钩子。

### RT-04-D：旧候选兼容且不改既有 confirmed 用户记忆

- 旧记录 `sourceKind ∈ {messages, legacy, userEdit}` 读取兼容（`isMemorySourceKind` 白名单含旧三值，未知值退回 messages 的旧行为不变）；新两值走 TEXT 列零迁移。
- 本份未改写任何既有 confirmed 记录：所有新分级只作用于**新建候选**的分类；既有 confirmed 的读取、抑制规则、删除联动全部原样（memoryRepository/memoryAdmin 既有用例于全量回归内全绿）。

## 共享接口影响与消费者

- `MemorySourceKind` 联合扩展为**加成员**：穷举 `MEMORY_SOURCE_LABELS`（memoryAdmin）已补标签；`sqliteMemoryStore` 读取白名单已扩。消费者：memoryRepository（upsert 去重逻辑读 sourceKind，行为未变）、memoryAdmin UI、writeback。
- `MaintenanceFlushResult.denied?` 可选增量；`MemoryMaintenanceOptions.authorizeWriteback?` 可选钩子——GW/AGT 接入时必配。

## 未执行 / 待人工

- 真实外部渠道的写回路径（GW-01 产生信封 → 绑定 → 候选）尚未存在——分级函数与重查钩子就绪，真实链路归 GW NOT RUN。
- 已绑定外部主体的**每主体独立记忆库**（而非本地库的来源分级）未实现——当前保守默认：外部候选不进本地画像、检索按 RT-02 隔离；每主体库归后续需求。
- 状态：AUTO_PASS = 所有可自动 AC 通过；完整验收待人工，不代表发布可用。
