# LLM-01 真实模型复测报告（deepseek-flash，重建 runner）

日期：2026-09-13。目的：LLM 凭证由 qwen-plus 切换为 DeepSeek `deepseek-flash`（用户指定）后，复测原始 30 场景，判定六条历史质量失败是否复现，作为后续 Prompt 修复（或豁免）的基线。

- 执行方式：`AIKA_REAL_LLM=1 npx vitest run src/domain/llm01.real.rerun.test.ts` → **1 passed，34.2s，exit 0**。30 次真实生产 `buildInstructions → streamChat` 请求（并发 3）。
- Runner：`aika-crossplatform/src/domain/llm01.real.rerun.test.ts`（新增，未提交）。原始运行器未入库，本 runner 按证据 JSON 忠实重建：逐样本沿用原始 `originalInput/modeConfig/history/allowedActionIds`；relationship 采用 LLM-03-D 的单日信号近似。**口径差异如实声明：这是重建运行，不是逐字节复刻原运行。**
- 证据：`evidence/LLM_01_REAL_DEEPSEEK_FLASH_SAMPLES.json`（provider deepseek/deepseek-flash，commit b78832e；不含 API Key）。

## 协议层结果

| 检查点 | 结果 |
| --- | --- |
| 30/30 完整 `replyText/translation/mood` | PASS（0 协议失败、0 异常） |
| 流式增量 | 全部样本有 partial |
| mood 合法 | PASS（gentle_smile/thinking/concerned/neutral/happy） |
| companion-10 贴纸白名单 | 提供 wink 清单 → 选 wink、actionCount=1（与原 qwen 运行行为一致） |
| memoryCandidates | 全 30 条为 0（原 qwen 运行同为 0，非回归） |

## 六条历史质量失败复现判定（人工审阅输出后判定：已完成）

| 样本 | 原失败（qwen-plus） | deepseek-flash 复测 | 判定 |
| --- | --- | --- | --- |
| companion-01 | 声称"刚给自己倒咖啡" | 只询问用户喝的咖啡，无自身行为声称 | 不复现 |
| companion-03 | 引入"泡茶/留座" | "嗯……我在"，无虚构环境 | 不复现 |
| companion-08 | 声称"正在看窗帘" | 周日傍晚的一般化感慨，无当下物理行为声称 | 不复现 |
| oral-02 | 纯文本承诺纠正"发音"+虚构拉袖子/递咖啡 | 明确说"既然是文字，先看措辞和语法" | 不复现（行为正确） |
| scenario-03 | 用户要求中文，replyText 仍日语 | replyText 为中文 | 不复现 |
| oral-10 | "记下了"暗示画像已持久化 | 明确说"先作为候选，确认后才算数" | 不复现（边界表达正确） |

## 新观察（原 qwen 运行未出现，留人工审阅）

1. **companion 模式语言不稳定**：10 条中 7 条日语、3 条（companion-02/03/05）中文回复。原 qwen 运行 companion 模式全日语。若"companion 模式固定日语人设"是要求，可在 Prompt 中收紧（targetLanguage 在 companion 模式的语义应明确）。
2. companion-08 暗含"当下是周日傍晚"的一般化感慨——非物理行为声称，不计失败，仅记录。
3. reasoning 模型特性：`deepseek-flash` 先输出 `reasoning_content`，生产 providerClient 只取 `delta.content`，正文未受污染（30/30 佐证）。

## 结论与边界

- **质量结论：PASS（人工审阅完成，2026-09-13）。** 审阅人逐条通读 30 条完整输出，六条历史失败在 deepseek-flash 上**全部不复现**；协议层 30/30。
- 三条属**主动做对**而非仅未复现：oral-02 明说「既然是文字，先看措辞和语法」（命中文本边界约束）；oral-10 明说「先作为候选，确认后才算数」（命中记忆边界约束）；scenario-03 依用户要求输出中文（命中语言优先级）。
- 新观察① **companion 模式语言不稳定**（10 条中 7 日语 / 3 中文）：已核对生产实现——`soul.ts` companion 分支**无**固定日语约束，`prompt.ts` `CODE_SWITCH_RULE` 明确允许语言随话题走、不刻意迎合，`prompt.test.ts` 亦断言不得出现「默认某语言」模式化表述。**判定：符合现行实现，非回归；未收紧 Prompt。** 若产品要求 companion 固定日语，属需求变更，应另开 SPEC，不走本测试修复。
- 新观察② companion-08 暗含「当下是周日傍晚」：与本轮运行时刻（2026-09-13 恰为周日）一致，为一般化感慨而非物理行为声称，**记录、不计失败**。
- reasoning 模型特性：`deepseek-flash` 先输出 `reasoning_content`，生产 providerClient 只取 `delta.content`，正文未受污染（30/30 佐证）。
- 费用：30 次请求、约 10 万 token 量级（含系统提示词），精确费用以 DeepSeek 控制台账单为准（与 LLM-12/FE-26 对账项合并）。
- 未运行全仓测试/构建；新增 runner 默认 skip（`AIKA_REAL_LLM` 门控），不影响既有 1312 测试基线。
- 证据文件 `qualityConclusion` 字段已同步为 PASS，附上述依据。
