# LLM-12 真实用量采集 + LLM-10 推理模型真实轨 验收报告（deepseek-flash）

日期：2026-09-13。范围：LLM-12 用量台账的真实采集跑批（原 NOT RUN「真实计费比对」的本地侧）+ LLM-10 真实平台 usage 验证从 deepseek-chat 延伸到推理模型 deepseek-flash。

- 命令：`AIKA_REAL_LLM=1 npx vitest run src/services/usage/llm12.real.deepseek.test.ts` → **1 passed，20.0s，exit 0**。
- Harness：`aika-crossplatform/src/services/usage/llm12.real.deepseek.test.ts`（新增，未提交）。采集链全生产代码：providerClient 样本通道 → `createUsageLedgerRecorder` → `memoryUsageLedger` → `summarizeUsage`（FE-26 成本页同一入口）。
- 证据：`evidence/LLM_12_REAL_USAGE_DEEPSEEK_FLASH.json`（9 条真实记录，不含 API Key）。

## 轮次矩阵与结果（全部真实请求）

| 轮次 | 场景 | 结果 |
| --- | --- | --- |
| T1~T4 | foreground 问答（中/日/英） | 4 条 completed，coverage=**reported**，promptTokens≈1000、completionTokens 269~741、totalTokens>0 |
| T5 | maintenance purpose | completed + reported，purpose 按调用方声明落账为 `maintenance`（采集不猜） |
| T6 | 首包后取消 | cancelled，coverage=**unknown**、totalTokens=null——**不伪造数字** |
| T7 | 坏模型名 | 完整降级阶梯真实触发：流式 → 去 stream_options 流式 → 非流式回退，**3 次物理尝试**均 failed、coverage=unknown；3 个独立 attemptId 同属 1 个 logicalRequestId |

recorder 诊断：registered=9、writeFailures=0、dropped=0。

## 关键发现（LLM-10 真实轨延伸）

1. **推理模型计费口径**：completionTokens **包含 reasoning tokens**——T1 可见回复仅 69 字符，completionTokens=741，推理部分约占 670 token。此前 REAL_TURN_VERIFICATION（deepseek-chat，2026-09-12）发现的「estimatedPrompt 远低于真实 prompt」结论在 flash 上同样成立，且新增「可见文本只是 completion 的一小部分」这一成本页解读要点。
2. **取消轮拿不到 usage 在 flash 上复现**：DeepSeek 只在末包给 usage，取消已烧掉的 token 在台账如实显示 unknown（与 deepseek-chat 行为一致）。
3. **降级阶梯真实证据**：请求体级 4xx 后「去 stream_options 重试、再退非流式」每一步都是独立物理尝试且各自落账——LLM-10-C 的重试路径首次拿到真实平台证据。DeepSeek 本身接受 stream_options，因此「中转站 400 掉 stream_options」的触发场景仍归 fixture 轨（如实保留）。

## FE-26 消费验证

`summarizeUsage`（成本页同一纯函数）对 9 条真实记录输出：statusCounts completed=5 / failed=3 / cancelled=1；coverage reported=5 / unknown=4；tokens 总量 7426（prompt 5012 / completion 2414）；**9 条 unpriced**——deepseek-flash 价目未录入前金额如实显示未知，不做估算补位（FE-26 设计语义在真实数据上成立）。

## 边界与待人工项

- 真实计费**金额对账**仍待用户：登录 DeepSeek 控制台核对账单，把 flash 价目填进 FE-26 价目表后再看成本页金额（B7 项）。
- 其余 3 协议（anthropic/gemini/openai-responses）真实样本仍 NOT RUN——无凭证，BLOCKED 待授权。
- SQLite 台账落盘路径归 INT-01（本批用 memory store）；Tauri 生产 plugin-sql 归宿主轨。

## 预算声明

用户设定真实 API 预算上限 **3 CNY**。本次Goal全程（LLM-01 30 场景、AC-D 两轮 15×2、LLM-12 两轮 9×2、冒烟 2 次，合计约 90 次请求、~0.22M token）按 DeepSeek 定价量级估算 **≤1 CNY**，未超限；精确消耗以控制台账单为准。本报告之后不再发起新的付费批。
