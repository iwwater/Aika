# 记忆与上下文 / Memory and context

[项目首页](../README.md) · [English](#english)

## 先分清三种信息

| 层次 | 保存什么 | 怎样进入聊天 |
| --- | --- | --- |
| 最近对话 | 按角色、会话和轮次保存的用户与助手原文 | 在预算内优先取连续的完整轮次，保持上一句与下一句衔接 |
| 陪伴长期记忆 | 有来源的事实、偏好、事件和有效的情绪相关记录 | 通过相关性、活跃度、重要性和情绪强度排序，选少量补入 |
| 项目与工作记录 | 项目名称、短摘要、详情引用；独立的任务正文与回执 | 工作路由时按需读取，不把全部项目全文放入陪伴记忆 |

原始对话不等于已经整理成功的长期记忆。页面上看到一条原文，不意味着模型已经把它提炼成事实，也不意味着下一轮一定选中了它。

## 一轮对话的数据流

1. 文字输入或 ASR 原文先成为这一轮的用户消息。有效的多模态观察绑定到相同的角色、会话、轮次与 generation。
2. 必要的请求识别和本地隐私状态检查完成后，长期记忆整理进入后台队列。前台不用等待完整的长期整理过程。
3. 前台依据当前有效版本组装上下文：角色 Prompt、当前输入与观察是基础；最近几轮先占预算，然后是摘要，最后是相关长期记忆。
4. 对话模型生成回复，回复连同其使用的上下文身份保存。旧轮次的异步结果不能冒充当前轮次。
5. 后台提出结构化变更，校验来源、版本、角色和操作边界后提交；失败会保留状态供排查。

**“后台”不代表前台没有任何耗时。** 输入识别、上下文读取和模型推理仍可能需要时间；这里分离的是长期记忆整理的完整等待链路。

## 最近对话不会与旧记忆争同一个优先级

`memory/context.ts` 按时间从最新的完整用户轮次向前选取，再恢复时间顺序。若某一轮放不进预算，会停止向更老的轮次取内容，不会跳过最近的大段对话去拼接几条不相邻的旧话，也不单独取一个没有用户起点的助手回复。

摘要和长期记忆只能使用剩余预算。当前输入本身也参与预算计算；预算不足时会省略历史，因此“优先最近”不是无限上下文的承诺。

普通后台处理失败不应隐藏后续历史。涉及忘记或纠正的待处理请求有独立保护：旧个人信息可能暂时被排除，避免尚未完成的遗忘操作被下一轮重新引用。这个保护与普通模型整理失败不同。

## 长期记忆的召回公式

以下是当前代码默认值，网页中的策略修改可调整规定范围内的部分参数。

| 符号 | 含义 |
| --- | --- |
| `C` | 当前问题与记忆的相关性，范围 0–1 |
| `A` | 活跃度，范围 0–1 |
| `I` | 重要性，取 0、0.5 或 1 |
| `E` | 有效情绪强度的动态值，范围 0–1 |
| `t` | 距锚点经过的天数 |

```text
活跃度半衰期 H = 30 × (1 + 2 × I) 天
普通事件活跃度 A(t) = A₀ × 2^(-t / H)
稳定档案类活跃度 A(t) = 1
情绪强度 E(t) = E₀ × 2^(-t / 7)
召回优先级 P = C × (0.55 + 0.25A + 0.15I + 0.05E)
有效强化 A' = A + 0.2 × (1 - A)
```

只有有效、具备合格来源和动态状态的候选才参与。默认相关性必须大于 0，`P ≥ 0.35`，最终至多补入 6 条，并受剩余输入预算限制。重要性改变半衰期；较强的情绪观察会轻微影响排序，但不会让无关记录越过 `C = 0`。

`C` 当前来自明确的关键词与短语规则。中文按规则分词并匹配，英文进行规范化匹配；少量已实现的关系规则提供补充。没有把供应商 embedding 或通用向量数据库冒充成已完成的能力。

自然淡化只改变活跃度和召回机会，**不自动删除长期记忆**。用户明确重提或确认、且来源与去重校验通过，才可能触发强化；仅浏览、搜索或试算不会把记忆越看越重要。

## 情绪记录怎样使用

视频入口最多处理这一轮采集的三帧，做七类判断：中性、开心、悲伤、愤怒、恐惧、厌恶、惊讶。语音转写与图像判断分离；只有 ASR 返回合法的音频情绪标注时才带入音频情绪。模型没有提供标注时，不从转写文本伪造一个“声音情绪已识别”的结论。

情绪观察可能有误，缺失与无效也有独立状态。评分实现可能用零作数值回退，但管理页不能因此把它写成“用户情绪中性”或“情绪强度确定为零”。被选入长期记忆的情绪相关内容仍须有来源引用。

## 网页里可以管理什么

| 页面能力 | 意义 |
| --- | --- |
| 原文、摘要、长期记忆及来源查看 | 确认保存的内容、来源与处理状态 |
| 纠正与遗忘 | 对指定记录及相关来源执行受版本约束的变更 |
| 实际召回记录 | 查看哪些记忆参与候选、被选中或因预算等原因省略；记录组装不等于模型一定正确利用 |
| 策略试算与保存 | 对比新旧参数；正式保存向后生效，回退参数不复活已遗忘内容 |
| 处理失败查看 | 区分原文保存成功、后台整理失败、隐私处理未完成等情况 |
| 角色 Prompt 与上下文设置 | 调整角色提示词和容量范围；角色之间保持数据边界 |

编辑不是直接篡改一段字符串。来源、摘要、缓存与旧版本可能有关联，系统会检查这些关联，防止删除过的内容从摘要或缓存重新出现。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| [`core/dialogue-pipeline.ts`](../code/desktop-pet/core/dialogue-pipeline.ts) | 前台对话与后台任务衔接 |
| [`core/memory-lifecycle-queue.ts`](../code/desktop-pet/core/memory-lifecycle-queue.ts) | 后台生命周期与角色范围 |
| [`memory/context.ts`](../code/desktop-pet/memory/context.ts) | 最近轮次优先、摘要和记忆的预算装配 |
| [`memory/dynamics.ts`](../code/desktop-pet/memory/dynamics.ts) | 衰减、强化和优先级公式 |
| [`memory/dynamics-cues.ts`](../code/desktop-pet/memory/dynamics-cues.ts) | 相关性规则 |
| [`memory/sqlite-recall.ts`](../code/desktop-pet/memory/sqlite-recall.ts) | 候选筛选与实际召回记录 |
| [`projects/sqlite-project-index.ts`](../code/desktop-pet/projects/sqlite-project-index.ts) | 独立项目索引 |
| [`harness/receipts.ts`](../code/desktop-pet/harness/receipts.ts) | 工作卡、确认状态和转发回执 |

<a id="english"></a>

## English

### Three distinct stores

**Recent conversation** holds verbatim user and assistant turns, scoped to a character and session. **Companion memory** holds sourced facts, preferences, events and valid emotional observations. **Work context** holds project names, abstracts and references, with separate task bodies and receipts. Engineering histories are not loaded wholesale into companion chat.

A saved transcript is not automatically a successfully extracted long-term memory. Nor does a stored record guarantee selection on the next turn.

### Foreground and background

The application saves the current input, performs necessary request/privacy checks, and queues long-term maintenance in the background. The foreground assembles a valid context and requests a reply without waiting for the full maintenance job. Background proposals are committed only after checking role, source, version and operation boundaries.

Context assembly reserves the base prompt and current input, then selects a **contiguous suffix of complete recent turns**, followed by summaries and relevant memories. It does not skip a large recent turn to pick isolated older messages. Budget exhaustion can still omit history.

Ordinary maintenance failure should not hide newer turns. Pending forgetting/correction requests are different: a privacy boundary may temporarily exclude older personal information so it is not reintroduced before the operation completes. Background processing does not eliminate all foreground latency: request classification, reads and inference still take time.

### Default recall mathematics

```text
H = 30 × (1 + 2I) days
A(t) = A₀ × 2^(-t/H)       for ordinary events
A(t) = 1                   for stable-profile records
E(t) = E₀ × 2^(-t/7)
P = C × (0.55 + 0.25A + 0.15I + 0.05E)
A' = A + 0.2 × (1 - A)     for eligible reinforcement
```

`C` is query relevance, `A` activation, `I` importance, and `E` emotional intensity. Values are bounded to 0–1; importance takes 0, 0.5 or 1. Eligible active records need `C > 0` and `P ≥ 0.35`. At most six memories are included, subject to the remaining input budget. Importance extends activation half-life; emotion adjusts ranking modestly and cannot make an unrelated record relevant.

Relevance currently uses inspectable lexical/phrase rules and a small number of implemented relation rules, not a general embedding search system. Decay changes recall priority without automatically deleting long-term memory. Eligible user reiteration or confirmation can reinforce a record; viewing, searching and previews do not.

### Emotional context

Optional video processing classifies up to three captured frames into seven categories: neutral, happy, sad, angry, fear, disgust and surprise. ASR is separate and authoritative for transcription. Audio emotion is included only for a valid returned annotation; a transcript alone is not proof of acoustic emotion recognition.

Observations may be uncertain, missing or invalid. A numerical fallback of zero must not be described as an observed neutral state. Long-term emotional records retain source references.

### User control and evidence

Web management exposes raw records, summaries, long-term memories, source links, corrections, forgetting, processing failures, recall traces and bounded policy tuning. Changes are versioned and account for dependent sources/caches. Policy rollback does not restore forgotten content. A trace proves what the application assembled, not that a language model understood or used it correctly.

The source map in the table above links directly to the implementation. Models, retrieval quality, emotional predictions and actual device behavior remain distinct validation concerns.
