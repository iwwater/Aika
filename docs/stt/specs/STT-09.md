# STT-09 · 生产前端本地引擎语言纠偏下沉

状态：**SPEC 冻结（需求与方案就绪，等待合作者主工程重构落地后执行）**。
需求来源：STT-03 真人麦克风验收（2026-09-22）发现的真实缺口。

## 背景与依据

STT-03 量化验收（`docs/stt/reports/STT-03_ACCEPTANCE_2026-09-22.md`）在**生产前端本地引擎**
（`whisperInput.ts` → `whisperClient.ts`，STT-08 后生产默认）上实测 20 句中日英混说，得出：

- 日语 **0/5** 完全匹配，典型失败是 **auto 语言检测误判**：
  - 「アイカちゃん、おはよう。今日も元気だよ。」→ **"Agachang Ohio? Ima mau kinky dayo."**（误判英语，罗马字音译）
  - 「今日の天気は really nice だね。」（混说）→ **"Kjóa tínki var vel næsta ne"**（误判冰岛语）
- 与 STT-05 结论一致：whisper 天然对 en/zh token 更自信，真日语的 auto 概率反而更低、易被小语种/英语路劫持。

**关键对比**：demo 网关 `gateway_stt.stt()`（`E:\Work\Chat_model\GPT-SoVITS\tools\tts_probe\gateway_stt.py`）
**已有**语言纠偏，且实测能翻案；而生产前端 `whisperClient.transcribe()` 只送 `language=auto` 直接返回
`data.text`，**丢弃了 `language_probabilities`**，没有任何纠偏。两条链路能力不对等。

## 目标

把 demo 网关已验证的语言纠偏逻辑，以等价形式下沉到生产前端本地引擎，使「说日语被误判成英语/小语种」
不再污染对话。**不重写识别策略，只补齐缺失的纠偏层。**

## 现有纠偏逻辑（gateway_stt.stt()，下沉参照物）

```text
1. auto 首跑（带 initial_prompt 人名/高频词偏置）
2. 若 auto 判出用户不会说的小语种（korean/冰岛语/爱尔兰语…）或文本含韩文字母
   → 无条件强制 ja 重跑（带 prompt）；空则再试 zh
3. 若 top 概率 < 0.60（摇摆）→ 按转写文本字符集裁决：
     含假名 → 日语；含汉字(无假名) → 中文；纯拉丁 → 疑似英语音译，强制 ja 重跑
4. 若 top=ja 但整句无假名 → 疑似中文被硬转，强制 zh 重跑
5. 中文短句被音译成通顺日语假名句 → 音频层无法可靠区分，交 LLM 上下文 + 前端 ✎ 兜底（不在此 SPEC）
```

## 技术障碍（下沉前必须解决）

1. **`whisperClient.transcribe()` 返回类型收缩**：当前 `Promise<string>`，只取 `data.text`，
   **丢弃 `language_probabilities`**。纠偏需要 top 语言码与置信度，必须扩展返回类型
   （如 `{ text, language, probability }` 或等价）。
2. **`whisperClient` 需要支持二次调用**：纠偏在「摇摆/误判」时要带 `language=ja/zh` + prompt 重跑一次，
   即 `transcribe` 需要接受可选 `language` 与 `prompt` 参数（或新增一个 `transcribeForced`）。
3. **`whisperInput.transcribe()` 的编排**：当前拿到 `text` 后直接 `events.onFinal`；需在
   「文本到达 → 判断是否纠偏 → 可能重跑」之间插入纠偏决策，且不破坏现有的
   generation/abort 语义（旧网络结果不能污染新一轮）。
4. **initial_prompt 归属**：`STT_INITIAL_PROMPT` 现只在 gateway_stt；前端无此概念，需下沉一份
   或定义为共享常量（注意：不要 copy 出第二份不一致的词表）。

## 范围

| 项 | 内容 |
| --- | --- |
| 允许改（重构落地后） | `aika-crossplatform/src/services/voice/whisperClient.ts`、`whisperInput.ts`；**若需改 `contracts.ts` 的 `WhisperClient.transcribe` 签名，须单列接口影响与受影响消费者** |
| 禁止改 | `src/domain/**`（纯领域层）；`contracts.ts` 的 `SpeechInputEngine` 契约（`whisperInput` 对外仍是同一 `SpeechInputEngine`）；demo 网关 `gateway_stt.py`（保持现状，作为对照/回退参照） |
| 依赖 | 合作者主工程重构落地（**前置**，voice 内部「一行不动」约束解除后才能改） |

## 非目标

- 不做模型选择 UI（沿用 STT-08，服务端 `-m` 决定）。
- 不重写 demo 网关的纠偏（它已经对，这里是「下沉」不是「重写」）。
- 不追求中文短句→日语假名句的音频层区分（第 5 条，已知音频层不可靠，交上层）。
- 不做 CER 全量复测（STT-07 已做 n=6；本 SPEC 只补「纠偏」这一层）。

## AC

| AC | 验收 |
| --- | --- |
| STT-09-A | `whisperClient.transcribe` 返回语言信息（top 语言码 + 概率），`whisperInput` 据此做纠偏决策；对「auto 判成非白名单小语种/韩文」强制 ja 重跑，对「摇摆(<0.6)+纯拉丁」强制 ja 重跑，对「ja 无假名」强制 zh 重跑 |
| STT-09-B | 复现 STT-03 的两个失败样本（「アイカちゃん、おはよう…」「今日の天気は really nice…」），纠偏后文本恢复到可懂日语（「アイカちゃん、おはよう。今日も元気だよ」等），**不再出现 "Agachang…"/冰岛语音译** |
| STT-09-C | 不破坏契约：`whisperInput` 对外仍是同一 `SpeechInputEngine`；`onFinal` 时序、generation/abort 语义、段重排序不变；现有 voice 测试全绿 |
| STT-09-D | 不引入第二份不一致词表：initial_prompt 单一定义（共享常量或单一来源），`gateway_stt` 与前端可复用同一份 |
| STT-09-E | 延迟可控：纠偏仅对「疑似误判」样本触发额外一次重跑（~200ms），正常样本不额外开销；文档说明「说日语可能多 ~200ms」的取舍 |

## 判定规则

- **不得**声称「修好了日语识别」——纠偏只是把「auto 误判」翻案，解码级残错（如 STT-03 的
  「聞けとれなかった」）不在本 SPEC 范围，需另议（与 STT-07 的 CER 方向同源）。
- 纠偏决策依赖 `language_probabilities` 与字符集，**不引入**跨语言 logprob 仲裁
  （STT-05 已证该路被英语系统性劫持，勿重蹈）。
- 双跑（auto + 强制 ja）带来 ~200ms 额外延迟，仅在「疑似误判」时触发，不普遍开启。

## 为什么现在只立 SPEC 不执行

`AGENTS.md` 明确：合作者重构主工程期间，**voice 内部一行不动**。本 SPEC 需要改
`whisperClient.ts`/`whisperInput.ts` 且可能触及 `contracts.ts` 的 `transcribe` 签名，
属于被冻结区域。故按 TTS-07 同款纪律：**先冻结需求与方案，待重构落地后解冻执行。**

## 证据与追溯

- 缺口证据：`docs/stt/reports/STT-03_ACCEPTANCE_2026-09-22.md`（日语 0/5、两例 auto 误判原文）。
- 纠偏参照实现：`E:\Work\Chat_model\GPT-SoVITS\tools\tts_probe\gateway_stt.py` 的 `stt()`（已实测翻案）。
- 前置结论：`docs/stt/reports/STT-05_ACCEPTANCE.md`（语言判定取证）、`STT-07`（模型规模标定）。
