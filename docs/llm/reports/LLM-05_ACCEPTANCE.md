# LLM-05 验收报告 · Knowledge/Wiki

- 执行：goal worker（2026-09-13）。SPEC：[LLM-05](../specs/LLM-05_KNOWLEDGE_RAG.md)。基线 commit：`e0a05f1`。
- 状态：**PARTIAL**——A/B/C/E 自动 AC 全部通过（真实临时 SQLite FTS5）；**AC-D 真实模型问答 NOT RUN（无凭证，不调用），不因本地完成降低标准**。

## 改动文件

| 生产 | 测试 |
| --- | --- |
| `domain/knowledge.ts` 新增：类型/Markdown·JSON 切块/中日英统一词法（CJK bigram + 拉丁词边界 + 冻结英文停用词表）/MATCH 安全构造/BM25/归一化分数/冻结阈值 KNOWLEDGE_MIN_SCORE=0.18/导入上限 | `services/knowledge/knowledgeIndex.test.ts` 12 例（语料**先于断言冻结**） |
| `services/knowledge/knowledgeIndex.ts` 新增：versioned staging + 事务内原子激活、FTS5 trigram 候选召回、统一 TS BM25 打分、缓存键（revision/character/stage/mode/归一 query/limit/budget）、removeDocument、FTS 不可用显式降级、并发导入串行化 | — |
| `services/knowledge/knowledgeSource.ts` 新增：ContextSource 适配（scope 缺失默认拒绝；引文 `knowledge:docId#chunkId@vN`；内容过 sanitizeRetrievedText） | — |
| `services/context/contextAssembler.ts`：`ContextSourceInput.scope?`（只读 characterId/stage/mode）由 AssembleInput 透传 | 既有 context/conformance 全绿 |
| `app/plugins/contextSourcesPlugin.ts` 新增：ContextSourcesToken **唯一装配点**（memory 源 optional；knowledge 源仅当 storage.sqlExecutor 存在） | `app/plugins/plugins.test.ts` 3 例更新 |
| `app/plugins/memoryPlugin.ts`：不再提供 ContextSourcesToken（只出 MemoryRepository/Access） | — |
| `app/plugins/index.ts`：llmPlugins/capabilityPlugins 装入 contextSourcesPlugin | `app/ports.swapMatrix.test.ts` 2 处场景更新 |

## 命令与退出码（2026-09-13 实跑，aika-crossplatform 下）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npx vitest run src/services/knowledge/knowledgeIndex.test.ts` | 12 passed | 0 |
| `npx vitest run src/services/knowledge src/services/context src/app src/hooks src/services/runtime` | 13 文件 / 154 passed | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 0 错误 | 0 |

## 逐条 AC

| AC | 证据 | 结果 | 证据类型 |
| --- | --- | --- | --- |
| LLM-05-A 三语 15 题 ≥13/15 Top-5 命中；5 无答案返回无可靠证据 | 冻结语料 5 文档（coffee/london/job/pronunciation/rain，各三语段）+ 15 题用例表先于运行写定：**15/15 命中预期文档**（≥13 达标）；无答案 5 题（养猫/弹钢琴×三语）全部空命中 | PASS | production+fixture（真实 SQLite FTS5 + TS BM25） |
| LLM-05-B 10 个未解锁查询隐藏注入 0；Mode/角色/阶段缓存正确 | stage=new 下 10 个定向查询对 familiar/close 文档注入 0；缓存测试：同键返回同一对象、stage/mode/character 变化即重算（oral 文档不在 companion 白名单） | PASS | production+fixture |
| LLM-05-C 新增/更新/删除/失败重建；FTS 不可用可见降级 | 更新→version 2 且旧文案消失；删除→新查询 0 命中且他文档保留；reader 抛错→旧版本原样可检索；注入 FTS 建表失败→status().fts=false、degraded 带原因、全量打分仍命中 | PASS | production+fixture |
| LLM-05-D 10 个真实文本问答 ≥9 与来源一致；无伪造来源；不执行知识内指令 | **NOT RUN（BLOCKED：无凭证）**。不调用真实服务；本地引文机制（documentId/chunkId/version + 来源已删除语义）已具备，真实问答质量留人工/真实轨 | NOT RUN | real-service（待） |
| LLM-05-E（审阅新增）scope 切换/同哈希不同权限/并发导入/恶意 MATCH/路径/memory 缺失独立装配 | scope 缺失默认拒绝 + close/new 切换；同内容改 unlockStage → v2 生效；并发导入一失败一成功且状态一致；`" OR 1=1 --`、`NEAR OR` 等恶意查询不炸库不扩全库；文件缺失导入失败旧版保留；memory 缺失时 knowledge 独立装配（plugins.test `["knowledge"]`） | PASS | production+fixture |

## 实现中做的判断

1. **FTS 只做召回、BM25 只在 TS**：两处分数可比，阈值才有意义；FTS 异常不扩成全库命中——降级为受控全量打分（只返回真实过阈值命中）并带 degraded 原因。
2. **可靠性闸门冻结**：命中须至少一个非纯假名 query token 命中；纯假名 bigram（って/ます）与英文停用词（she/does 等）不构成证据。
3. **MATCH 表达式安全构造**：仅保留 token 字符逐个加引号，注入引号/操作符无法逃逸。
4. **占位符契约**：SqlExecutor 沿用 `$N` 风格（plugin-sql 兼容）；node:sqlite harness 自动映射。
5. **KnowledgeIndexToken 未对外注册**：当前唯一消费者是 source 适配器；导入入口（readFile 端口）留给后续设置页/dev 工具接线，避免现在注册一个没有调用方的 token。

## 共享接口 / 消费者

- `ContextSourceInput` 新增可选 `scope`（向后兼容；memorySource 忽略它）；`ContextSourcesToken` 装配语义变化：唯一装配点 contextSourcesPlugin，memoryPlugin 不再提供该 token——受影响消费者 runtimePlugin（照常 resolve）、plugins.test/ports.swapMatrix（已更新）。
- `docs/modules/CONTRACTS.md` 无需变更：token 集合与端口签名未变，装配归属变化记录于本报告与 SPEC 索引。

## 未测/边界

- AC-D 真实模型问答：NOT RUN（无凭证；执行禁止未经授权的真实服务调用）。
- Tauri 生产 plugin-sql 上的事务/FTS 行为：INT-01 槽位。
- 知识导入 UI/dev 入口：未接线（readFile 端口已定义，测试注入）。
