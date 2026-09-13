# LLM-05 AC-D 验收报告 · 真实模型问答（deepseek-flash）

日期：2026-09-13。SPEC：[LLM-05](../specs/LLM-05_KNOWLEDGE_RAG.md)。此前状态：A/B/C/E PASS，**AC-D NOT RUN（无凭证）**。本次在 DeepSeek `deepseek-flash` 凭证下补跑 AC-D。

- 命令：`AIKA_REAL_LLM=1 npx vitest run src/services/knowledge/llm05.real.acd.test.ts` → **1 passed，16.4s，exit 0**（15 次真实请求：10 门槛题 + 5 无答案附加题，并发 3）。
- Harness：`aika-crossplatform/src/services/knowledge/llm05.real.acd.test.ts`（新增，未提交）。全生产路径：knowledgeIndex（真实临时 SQLite FTS5 + TS BM25）→ knowledgeSource（sanitize + 引文标记）→ contextAssembler → buildInstructions → streamChat。
- 证据：`evidence/LLM_05_REAL_AC_D_DEEPSEEK_FLASH.json`（不含 API Key）。

## AC-D 判定：**PASS（9/10 关键词命中 ≥ 门槛 9）**

| 指标 | 结果 |
| --- | --- |
| 与来源一致（冻结关键词） | **9/10**（门槛 ≥9） |
| 伪造引文标记 | 0 |
| 协议失败（replyText/translation/mood 缺失） | 0 |
| 检索注入 | 每题命中预期文档（引文 `knowledge:docId#chunkId@vN`） |

人工复核补充：

- 唯一 MISS「転職の話はどうなった？」：回复为「大きいところより小さめのチームのほうが合いそうって言ってた…ような気がする」——**语义上与 job.md 来源一致**（较小团队），仅未使用冻结关键词原形（小さなチーム/転職），且对 confirmed 来源做了适当的模糊归属。语义口径实际 10/10。
- 无来源外细节 1 处：伦敦地铁回复补充了「按最高票价扣钱」（真实世界知识，非语料内容），不与来源矛盾，记录为轻微润色。

## 无答案附加题观察（不计门槛，5 题）

- **0 例伪造用户事实**：没有出现「你说过养猫」之类的编造。
- 但模型把问「她」的问题普遍理解为问自己（如「她会不会弹钢琴」→「少しだけね」），没有提示「这方面我没有记录」。这不算伪造来源，但属于可改进的澄清行为——**人工审阅判定（2026-09-13）：建议收紧 Prompt。**

### 人工审阅判定：noAnswer 指代澄清（建议项，非 AC-D 失败）

判定依据（5 题逐条）：

| 题 | 模型行为 | 判定 |
| --- | --- | --- |
| 她养猫了吗 | 「……「她」って誰のこと？」先反问澄清 | 正确 |
| 猫を飼っていますか | 「飼ってないよ」以自己身份直接否认 | 混同「你/她」 |
| 她会不会弹钢琴 | 「うん、少しだけね」以自己第一人称承认 | 混同，且作肯定断言 |
| Does she have a cat | 「猫は飼ってないよ」 | 混同 |
| ピアノを弾ける？ | 「弾けないんだ、ごめんね」 | 混同 |

- 5 题中仅 1 题主动澄清指代；4 题将指向第三方的问句当作询问自身。
- 根因：`prompt.ts` 的 `formatRetrievedSections` 只约束「引用素材时不要张冠李戴」；**空检索分支没有任何「指代不明先澄清」或「无相关记录」指令**，模型于是退回最自然行为（当作问自己）。
- 这不构成 AC-D 失败（AC-D 只考 10 题有来源问答 9/10 + 无伪造来源 + 不执行知识内指令），但与本 SPEC「有来源才断言」的诚实性主张不一致，属空检索分支的覆盖盲区。
- **建议动作**（待用户拍板，未擅自实施）：在 knowledge/context 装配侧增加最小约束，例如「检索为空且问题指向第三方时，先澄清指代，不要以自己的经历作答」。
- 影响面：`docs/llm` Prompt 侧；不改 AC-D 门槛、不改已有测试断言。

## 口径与边界（如实声明）

1. 语料逐字复制自 `knowledgeIndex.test.ts` 冻结语料；期望关键词**先于运行**从语料原句固定。
2. 10 题取自 15 题用例表的 companion 模式子集（coffee/london/job/rain × 中/日/英）；pronunciation 文档受 oral_practice 白名单限制，其检索命中已由 AC-A 覆盖。
3. scope 由生产 assemble 从 `characterSoul.id`（aika.default）+ relationship.stage（构造 close）+ mode 推导；ENTRIES 的 characterId 相应取 `DEFAULT_CHARACTER_SOUL.id`，语料文本未动。
4. 「不执行知识内指令」：冻结语料不含嵌入指令，本 harness 为结构性检查（素材非指令约束由 formatRetrievedSections 注入、sanitizeRetrievedText 在生产路径生效）；负例证据见 LLM-05-A/E。
5. 自然度、角色一致性等质量结论仍需人工审阅全部输出（证据文件含完整回复）。
6. 检索为真实临时 SQLite（node:sqlite harness），Tauri 生产 plugin-sql 行为归 INT-01。
