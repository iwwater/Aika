# Aika 产品需求文档（PRD）

**版本**：v0.4  
**日期**：2026-09-10  
**产品形态**：Windows 桌面端为主，React + TypeScript + Tauri  
**当前阶段**：已有可运行原型，进入 Runtime、Context、Memory 架构重构与语音体验优化阶段

---

# 1. 产品概述

## 1.1 产品定位

Aika 是一个以**实时语音交互、长期陪伴、语言练习与角色一致性**为核心的个人 AI Companion。

Aika 不以“回答问题更聪明”为主要差异，而以以下能力形成产品价值：

- 能持续记住用户
- 有稳定且可演化的人格
- 理解当前时间与关系阶段
- 能结合用户当前行为与环境进行自然互动
- 能以低延迟语音持续对话
- 在不同使用模式下保持同一个角色身份
- 后续通过 Live2D、声音和环境感知形成具象化陪伴体验

核心目标：

> 让用户感受到“这是同一个长期存在的角色在和我生活、交流和成长”，而不是每次重新开始的一次性聊天机器人。

---

# 2. 产品原则

## 2.1 低延迟优先

语音交互的首要指标不是总请求耗时，而是：

**Time To First Audio（TTFA）**

整体链路应尽量做到：

```text
Speech
→ VAD / ASR
→ Context Assembly
→ Single Agent Call
→ Streaming Response
→ Streaming TTS
```

不得为了情绪判断、Query Rewrite、记忆抽取等功能，在实时主链路中连续增加多个 LLM 请求。

---

## 2.2 单 Agent Call

每轮主要对话原则上只进行一次核心 LLM 推理。

该次推理同时负责：

- 理解用户意图
- 结合 Soul
- 结合 Memory
- 决定是否使用知识
- 生成回复
- 输出角色 Mood
- 产生 Memory Candidate
- 产生可选 Action / Tool Decision

示例结构：

```json
{
  "mood": "happy",
  "reply_text": "...",
  "translation": "...",
  "memory_candidates": [],
  "actions": []
}
```

---

## 2.3 Soul、Memory、Knowledge 分离

三者职责必须明确：

### Character Soul

回答：

> “Aika 是谁？”

包括：

- 基础人格
- 性格倾向
- 说话方式
- 世界观
- 角色偏好
- 行为边界

### User Memory / User Soul

回答：

> “用户是谁，以及之前发生过什么？”

包括：

- 用户事实
- 偏好
- 长期目标
- 重要经历
- 关系人物
- 最近事件

### Knowledge / Wiki

回答：

> “Aika 知道什么？”

包括：

- 人物设定
- 世界观
- 背景资料
- 语言学习资料
- 外部知识

三者不得合并成一个无限增长的 System Prompt。

---

# 3. 当前项目状态

当前 Aika 已拥有以下基础能力：

## 3.1 已实现

- React + TypeScript + Tauri 桌面应用
- OpenAI Responses
- OpenAI Compatible
- Anthropic
- Gemini
- 自定义模型接口
- 流式 LLM 回复
- 结构化回复
- Whisper 本地识别接口
- Silero VAD
- Web Speech fallback
- 连续语音
- 回合结束判断
- 用户打断
- 分句 TTS
- 字幕逐句高亮
- Mood 标签
- 本地 SQLite
- 长期 Memory 保存
- Memory 自动抽取
- Rolling Summary
- Relationship Stage
- 主动消息
- Windows 托盘
- DPAPI API Key 保护
- 局域网手机访问
- Sticker 机制

---

## 3.2 部分完成 / 待优化

- Whisper 实机效果
- 语音打断链路
- STT / Turn End 延迟
- Memory Retrieval
- User Soul
- Context 统一管理
- 口语练习模式
- 桌宠窗口
- Live2D
- 自定义声音

---

## 3.3 尚未进入正式实现

- RAG / Wiki
- Vector Retrieval
- Environment Awareness
- Process Monitor
- OCR Highlight
- Screen Event
- Camera Emotion
- Voice Emotion
- Knowledge Graph
- 完整 Tool Runtime

---

# 4. 用户场景

## 4.1 日常陪伴

用户可以直接通过文字或语音与 Aika 聊天。

Aika 应：

- 保持固定人格
- 自然延续过去的话题
- 合理使用长期记忆
- 根据关系阶段调整熟悉程度
- 不机械提问
- 不反复强调“我记得”
- 不制造虚假现实经历

---

## 4.2 口语陪练

用户进入：

```text
Mode = oral_practice
```

Aika 的人物身份不改变，只改变当前行为策略。

要求：

- 默认以目标语言交流
- 用户说不出来时允许中文辅助
- 优先维持对话流畅
- 一次最多主动纠正一个明显错误
- 不自动进入课堂模式
- 用户要求详细解释时才展开
- 用户可要求暂停纠错

---

## 4.3 场景练习

例如：

- 咖啡店
- 面试
- 学校交流
- 日常购物
- 初次见面

Mode：

```text
scenario_practice
```

Aika 保持角色人格，但根据场景临时进入相应身份或交互规则。

---

## 4.4 长期陪伴

例如用户两周前说：

> 下周我要参加面试。

后续 Aika 可以在相关场景中自然回忆：

> 前阵子你不是还在准备那个面试吗。

前提是该记忆：

- 与当前话题相关
- 可信
- 没有失效
- 没有被新信息覆盖

---

# 5. 核心架构

总体架构：

```text
                    UI Layer
              React / Tauri / Live2D
                       │
                       ▼
               Companion Runtime
                       │
       ┌───────────────┼────────────────┐
       │               │                │
 Voice Runtime   Context Assembler   Tool Runtime
       │               │
       │        ┌──────┼───────────┐
       │        │      │           │
      ASR     Soul   Memory      Knowledge
       │               │           │
       │          Retrieval        RAG
       │               │           │
       └───────────────┴───────────┘
                       │
                       ▼
                     Agent
                       │
              Single Structured Call
                       │
      ┌────────────────┼──────────────┐
      │                │              │
    Reply        Memory Candidate    Action
      │
      ▼
 Streaming TTS
      │
      ▼
 Subtitle / Live2D
```

---

# 6. Companion Runtime

目前 React Hook 不应继续承担全部业务。

新增：

```text
CompanionRuntime
```

职责：

- 管理当前 Turn
- 调用 ContextAssembler
- 管理 Agent 请求
- 管理取消
- 管理 Memory 写回
- 管理 Tool Action
- 管理对话状态

React 仅负责：

```text
Runtime
↕
UI State
```

目标是未来：

- Desktop UI
- Mobile Remote
- Live2D Window
- CLI / Debug

都可以复用同一 Runtime。

---

# 7. Voice Runtime

## 7.1 输入链路

目标：

```text
Mic
↓
Audio Buffer
↓
Silero VAD
↓
Speech Segment
↓
Whisper
↓
Transcript Buffer
↓
Turn End
```

Speech Segment 与 Conversation Turn 必须保持两个不同概念。

---

## 7.2 延迟优化

当前必须修复：

### VAD 与 TurnEnd 重复等待问题

不得以：

```text
Whisper 返回时间
```

作为最后一次语音活动时间。

应记录：

```text
speechEndedAt
```

实际静音时间：

```text
Date.now() - speechEndedAt
```

Whisper 推理本身消耗的时间应计入 Turn End 等待时间。

---

## 7.3 Barge-in

用户在 Aika 说话过程中再次开口：

必须：

```text
Stop TTS
↓
Abort previous LLM request
↓
Invalidate previous turn
↓
Start receiving new user turn
```

不是简单停止声音。

每轮必须拥有：

```ts
TurnRuntime {
  turnId
  abortController
  state
}
```

---

## 7.4 Interrupted Reply

Message 增加：

```ts
deliveryStatus:
  | complete
  | interrupted
  | cancelled
```

必要时记录：

```ts
generatedText
spokenText
```

Context 只认为用户真正听到的内容已经发生。

---

# 8. Character Soul

Character Soul 只描述角色本身。

示例：

```ts
CharacterSoul {
  identity
  personality
  preferences
  worldview
  speakingStyle
  boundaries
}
```

不包含：

- 当前关系
- 当前时间
- 当前 Mode
- 用户记忆
- RAG 内容
- Output Schema

---

# 9. Mode Policy

独立增加：

```ts
InteractionMode =
  | companion
  | oral_practice
  | scenario_practice
```

每种 Mode 对应 Policy。

## companion

目标：

自然陪伴。

## oral_practice

目标：

自然语言练习。

## scenario_practice

目标：

完成指定场景模拟。

Character Soul 在三种 Mode 中保持一致。

---

# 10. User Soul

User Soul 是从 Memory 中逐渐沉淀出的稳定用户画像。

包括：

```ts
UserSoul {
  stableFacts
  preferences
  dislikes
  goals
  habits
  importantPeople
  communicationPreferences
}
```

User Soul 不应由单次对话直接覆盖。

需要经过：

```text
Memory
↓
Repeated Evidence
↓
Consolidation
↓
User Soul
```

---

# 11. Memory 系统

## 11.1 Memory 类型

建议：

```ts
MemoryType =
  | fact
  | preference
  | event
  | goal
  | relationship
```

---

## 11.2 Memory Schema

```ts
MemoryRecord {
  id
  type
  content

  importance
  confidence

  createdAt
  lastConfirmedAt
  lastAccessedAt

  sourceMessageIds

  status
  validFrom
  validUntil
}
```

状态：

```text
candidate
confirmed
superseded
```

---

# 12. Memory Retrieval

禁止继续长期采用：

```text
last 12 memories
```

需要：

```text
Current Query
      │
      ▼
Memory Retrieval
      │
 ┌────┼─────┐
 │    │     │
相关度 时间 重要度
 │    │     │
 └────┼─────┘
      ▼
    Top K
```

V1 可使用：

```text
SQLite FTS5
+
BM25
+
Recency
+
Importance
```

后续：

```text
BM25
+
Embedding
↓
RRF
↓
Top K
```

---

# 13. Memory 写入

实时对话原则上不单独追加一个 Memory LLM Call。

Agent 输出中增加：

```json
"memory_candidates": []
```

随后 Runtime 做：

- schema validation
- duplicate check
- confidence threshold
- merge
- persist

较复杂的 Memory Consolidation 可低频执行：

- Session End
- N turns
- Idle
- 定期维护

不得阻塞实时回复。

---

# 14. ContextAssembler

新增核心模块：

```text
ContextAssembler
```

输入：

```text
Current Time
Character Soul
User Soul
Relationship
Recent Conversation
Memory Retrieval
RAG
Environment
Mode
```

输出：

```ts
AgentContext
```

示例：

```ts
AgentContext {
  clock

  characterSoul
  userSoul
  relationship

  mode

  recentConversation
  summary

  memories
  knowledge

  environment
}
```

ContextAssembler 负责控制 Token Budget。

---

# 15. RAG / Wiki

V1 不做 Knowledge Graph。

第一阶段：

```text
Markdown / JSON
↓
Chunk
↓
Metadata
↓
SQLite FTS5
↓
BM25
↓
Top K
```

目录示例：

```text
knowledge/
├─ character/
├─ world/
├─ oral/
└─ scenario/
```

Metadata 至少包括：

```text
document
section
chunkId
type
stage
tags
```

对于剧情知识必须支持：

```text
unlockStage
```

防止关系阶段 3 读取阶段 4 内容。

---

# 16. Relationship

现有：

```text
daysKnown
streak
messageCount
```

保留多因子思想，但后续调整：

```text
daysKnown
activeDays
userTurnCount
meaningfulEvents
```

不应因为 Aika 自己发送更多消息导致关系自动增长。

Relationship 输出：

```text
new
familiar
close
```

第一版继续保持：

> 长时间离线不会自动降低关系阶段。

---

# 17. Agent 输出协议

目标协议：

```ts
AgentResponse {
  mood
  replyText
  translation

  memoryCandidates

  action

  sticker?
  expression?
}
```

字段尽量按实时消费顺序：

```text
mood
reply
translation
memory
action
```

确保 TTS 可以尽早得到正文。

---

# 18. Environment Awareness

不进入当前 MVP 核心链路。

Stage 2 实现。

统一输出 Sensor Event：

```ts
EnvironmentEvent {
  type
  timestamp
  confidence
  payload
}
```

来源包括：

### Foreground Process

```text
当前程序
窗口标题
```

### OCR

检测：

```text
Victory
Defeat
Pentakill
Achievement
```

初期原则：

> OCR + Rule 能解决的问题，不调用 VLM。

### Camera

仅作为弱信号：

```json
{
  "emotion": "smile",
  "confidence": 0.63
}
```

不得将其当成用户真实心理状态。

---

# 19. Live2D

Live2D 为展示层，不参与核心推理。

输入：

```text
mood
expression
motion
speaking
audio amplitude
```

输出：

```text
表情
动作
口型
```

当前继续使用 Tauri WebView / Canvas / WebGL 路线。

暂不迁移 Unity。

---

# 20. TTS

现阶段继续使用现有 TTS 抽象。

要求：

- 支持分句播放
- 支持队列
- 支持中断
- 支持语言识别
- 后续允许 Style / Emotion 参数

未来声线目标：

- 同一角色跨中文、日语、英语保持统一音色
- 支持自定义角色声线
- 支持流式或低 TTFA 推理

---

# 21. 手机端

保持当前设计：

> 手机是 PC Runtime 的 Remote Client，不维护第二份 Memory。

V1：

```text
Mobile
↓
LAN
↓
Desktop Runtime
↓
Agent
```

后续优化：

- Pairing
- Session Token
- Bearer Header
- 避免 Token 长期放 URL

不做复杂双向数据同步。

---

# 22. 非功能需求

## 性能

目标指标：

### Voice

- VAD 不明显切断句中停顿
- 用户说完后尽快提交
- LLM 第一段到达后立即准备播放
- TTS 第一音频尽快开始
- 支持实时打断

核心指标：

```text
Speech End → First Audio
```

---

## 稳定性

单模块失败不得拖垮整个对话：

```text
Memory fail
→ reply still works

RAG fail
→ reply still works

Sticker fail
→ reply still works

Sensor fail
→ reply still works
```

---

## 隐私

默认：

- Conversation 本地保存
- Memory 本地保存
- API Key 加密保存
- Sensor 默认关闭
- Camera 默认关闭
- Screen / OCR 必须用户主动启用

---

# 23. 当前 MVP

## MVP 1：Runtime 稳定化

必须完成：

- Voice 延迟修复
- 真正 Barge-in Cancel
- Turn 生命周期
- Interrupted Message 状态
- Soul / Mode 分离
- ContextAssembler

---

## MVP 2：Memory 2.0

完成：

- 新 Memory Schema
- Memory Retrieval
- Memory 去重
- Memory supersede
- User Soul 基础结构
- Agent 单 Call Memory Candidate

---

## MVP 3：Knowledge

完成：

- Wiki
- Chunk
- SQLite FTS
- BM25 Retrieval
- Context 注入
- Stage Gate

---

## MVP 4：Companion Experience

完成：

- 桌宠窗口
- Live2D
- Expression
- Lip Sync
- TTS 优化
- Sticker 完善

---

# 24. 后续阶段

## Stage 2

- Process Monitor
- Window Context
- OCR Highlight
- Relationship Upgrade
- Memory Consolidation
- Proactive Context

## Stage 3

- Voice Emotion
- Camera Signal
- VLM
- Hybrid RAG
- Vector DB
- Knowledge Graph

## Stage 4

探索：

```text
Voice
↓
Voice Multimodal LLM
↓
Voice
```

逐步替代：

```text
STT → LLM → TTS
```

但不作为当前工程前置条件。

---

# 25. 当前开发优先级

```text
P0
Voice Runtime
↓
P0
Soul / Mode 拆分
↓
P0
ContextAssembler
↓
P1
Memory Retrieval
↓
P1
Single Agent Call
↓
P1
RAG / Wiki
↓
P2
Environment Awareness
↓
P2
Live2D
↓
P3
Multimodal Emotion / Graph
```

---

# 26. MVP 验收标准

## Voice

- 用户句中短暂停顿不会被立即打断
- 用户说完后没有明显重复等待
- 用户说话可以立即打断 Aika
- 新 Turn 不会被上一 Turn busy 状态阻塞
- 被打断回复不会错误进入完整历史
- 第一段回复生成后可以开始朗读

## Memory

- 能记住跨会话重要信息
- 能从旧 Memory 中检索相关内容
- 不只依赖最近 N 条 Memory
- 重复事实不会无限堆积
- 新事实可以覆盖旧事实
- 用户能够删除记忆

## Character

- Character Soul 在不同 Mode 下保持一致
- Companion 与 Oral Practice 行为明显不同
- Mode 切换不会重置人格

## Context

- 时间、关系、Memory、Soul、RAG 有统一输入结构
- Context 有明确 Token Budget
- 单个 Context Source 故障不影响主对话

---

# 27. 产品最终方向

Aika 最终不是：

> 一个带语音的聊天 UI。

而是：

> **一个拥有稳定人格、长期记忆、现实时间感、环境感知和具象化表现能力的低延迟 Companion Runtime。**

核心系统关系：

```text
Soul
决定她是谁

Memory
决定她记得什么

Knowledge
决定她知道什么

Context
决定她现在意识到什么

Agent
决定她现在怎么回应

Voice / Live2D
决定她如何表现出来
```