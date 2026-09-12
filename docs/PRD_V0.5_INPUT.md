# Aika PRD v0.5 更新计划

**目标版本**：v0.5
**核心定位升级**：

> Aika 从“具有长期记忆和环境感知的 AI Companion”升级为“长期常驻、跨设备、跨通信渠道、可调度外部 Agent 的 Personal Agent Runtime”。

Aika 仍然保持“同一个长期存在的角色”这一产品核心，但其能力边界扩展为：

```text
陪伴
+
语音
+
桌宠
+
环境感知
+
远程设备
+
消息渠道
+
Tool / Skill
+
Coding Agent Orchestration
```

---

# 1. 产品定位调整

## 1.1 原定位

```text
AI Companion
→ Chat
→ Voice
→ Memory
→ Soul
→ Live2D
→ Environment Awareness
```

## 1.2 v0.5 定位

```text
                         Aika
                          │
                 Personal Agent Runtime
                          │
     ┌────────────┬───────┼────────┬─────────────┐
     │            │       │        │             │
 Companion    Channels  Devices  Tools      Agent Runtime
     │            │       │        │             │
 Live2D       Telegram Android    MCP          ACP
 Voice         Feishu   Web      Skill       Codex
 Memory         QQ      Remote   Local      Claude Code
 Soul                                           Gemini CLI
 Screen                                         ...
```

核心原则：

> **Aika 不是 Telegram Bot、桌宠、手机 App 或 Coding Agent。**

这些全部只是 Aika Runtime 的不同入口、身体和执行器。

---

# 2. 新总体架构

```text
┌─────────────────────────────────────────────────────────┐
│                     Presentation Layer                  │
│                                                         │
│ Desktop Pet │ Desktop UI │ Android │ Telegram │ Feishu │ QQ
└───────────────┬─────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────┐
│                      Gateway Layer                      │
│                                                         │
│ Channel Gateway              Device Gateway             │
│ ├ TelegramAdapter            ├ Device Pairing           │
│ ├ FeishuAdapter              ├ WebSocket                │
│ ├ QQAdapter                  ├ Remote Session            │
│ └ WebChatAdapter             └ Push / Relay             │
│                                                         │
│               Session / Identity Router                 │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                     Aika Runtime                        │
│                                                         │
│ Conversation Runtime                                   │
│ Context Assembler                                      │
│ Soul / User Soul                                       │
│ Memory Runtime                                         │
│ Knowledge Runtime                                      │
│ Proactive Policy                                       │
│ Scheduler                                              │
│ Environment Runtime                                    │
│ Permission Runtime                                     │
└──────────────┬───────────────────┬──────────────────────┘
               │                   │
               ▼                   ▼
┌──────────────────────┐    ┌─────────────────────────────┐
│     Tool Runtime     │    │       Agent Runtime         │
│                      │    │                             │
│ Local Tools          │    │ AgentSessionManager         │
│ MCP                  │    │                             │
│ Skill                │    │ ├ Native Agent             │
│ Screen/OCR           │    │ ├ ACP                      │
│ Browser              │    │ │  ├ Codex                 │
│ System               │    │ │  ├ Claude Code           │
└──────────────────────┘    │ │  ├ Gemini CLI            │
                            │ │  └ Other ACP Agents       │
                            │ └ SubAgent                  │
                            └─────────────────────────────┘
```

---

# 3. 新增模块 A：Channel Gateway

目标：

> 用户不需要打开 Aika 客户端，也能从自己正在使用的通信软件找到同一个 Aika。

第一阶段支持：

```text
Telegram
Feishu / Lark
QQ
```

以后可扩展：

```text
Discord
Slack
微信
LINE
Email
WebHook
```

## 3.1 统一 Channel Adapter

定义：

```ts
interface ChannelAdapter {
  id: string

  connect(): Promise<void>
  disconnect(): Promise<void>

  sendMessage(
    target: ChannelTarget,
    message: OutboundMessage
  ): Promise<void>

  onMessage(
    handler: (message: InboundMessage) => void
  ): void
}
```

统一消息：

```ts
interface InboundMessage {
  channel: string

  accountId: string
  conversationId: string
  threadId?: string

  senderId: string

  type:
    | "text"
    | "voice"
    | "image"
    | "file"
    | "command"

  content: unknown

  timestamp: number
}
```

禁止：

```text
Telegram → 一套 Agent
Feishu   → 一套 Agent
QQ       → 一套 Agent
```

必须：

```text
Telegram ─┐
Feishu   ─┼→ Channel Gateway → Aika Runtime
QQ       ─┘
```

---

# 4. Session / Identity Router

这是 Channel Gateway 的核心，而不是 Bot API 本身。

必须解决：

```text
桌面上的“我”
Telegram 的“我”
手机上的“我”
QQ 的“我”
```

实际上是：

```text
同一个 User Identity
```

设计：

```ts
UserIdentity {
  userId

  linkedAccounts: {
    telegram?: string
    feishu?: string
    qq?: string
    mobileDevices?: string[]
  }
}
```

消息进来：

```text
Channel Message
      ↓
Identity Resolution
      ↓
Session Resolution
      ↓
ConversationRuntime
```

必须区分：

```text
Identity
≠
Conversation
≠
Thread
≠
Agent Session
```

例如：

```text
User = Mengfei

Conversation A
→ Telegram 日常聊天

Conversation B
→ Desktop Voice

Conversation C
→ Coding Task

但共享：
→ Soul
→ User Memory
→ Relationship
```

---

# 5. 新增模块 B：Device Gateway

目的：

> 手机不是部署另一套 Aika，而是成为同一个 Aika 的远程终端。

结构：

```text
Android
   │
   │ Pairing
   ▼
Device Gateway
   │
   ▼
Aika Runtime
```

第一阶段：

```text
LAN WebSocket
```

后期：

```text
Internet
↓
Aika Relay
↓
PC Runtime
```

Device Gateway 提供：

```ts
interface DeviceSession {
  deviceId: string
  deviceType: "desktop" | "android" | "web"

  capabilities: DeviceCapability[]

  connectedAt: number
  lastSeenAt: number
}
```

Capability 示例：

```text
chat
voice_input
voice_output
notification
camera
screen
location
sensor
```

不是所有设备拥有所有能力。

---

# 6. Remote Mobile

Android 第一阶段定位：

```text
Aika Remote Client
```

而不是：

```text
Aika Runtime Clone
```

提供：

```text
Chat
Voice
Notification
Push
Remote Control
部分 Mobile Sensor
```

### PC 在线

```text
Android
↓
Device Gateway
↓
PC Aika Runtime
```

### PC 不在线

未来：

```text
Android
↓
Aika Cloud
↓
Cloud Runtime / Relay
```

v0.5 暂不要求完整 Cloud Runtime。

---

# 7. 新增模块 C：Agent Runtime

这是本次最大的架构升级。

原有：

```text
Aika
→ Tool
```

升级：

```text
Aika
→ Tool

Aika
→ SubAgent

Aika
→ External Agent
```

需要引入：

```text
AgentSessionManager
```

统一表示：

```ts
interface AgentSession {
  id: string

  runtime:
    | "native"
    | "acp"

  agentId: string

  status:
    | "starting"
    | "running"
    | "waiting_approval"
    | "completed"
    | "failed"
    | "cancelled"

  workspace?: string

  createdAt: number
}
```

---

# 8. ACP Runtime

第一阶段目标支持：

```text
Codex
Claude Code
```

后续：

```text
Gemini CLI
OpenCode
Cursor
Copilot
其他 ACP-compatible Agent
```

架构：

```text
Aika
 │
 ▼
AgentSessionManager
 │
 ▼
ACP Client
 │
 ├── codex-acp
 │
 ├── claude ACP adapter
 │
 └── other ACP agent
 │
 ▼
Coding Agent
```

Aika 不直接理解每一个 Coding Agent 的内部协议。

统一调用：

```ts
spawnAgent({
  agent: "codex",
  workspace: "...",
  prompt: "..."
})
```

之后：

```ts
session.send(...)
session.cancel()
session.approve(...)
session.reject(...)
session.getStatus()
session.getEvents()
```

---

# 9. Coding Agent 使用场景

例如用户在手机 Telegram 中说：

```text
帮我看看 Aika 仓库现在为什么 build 失败。
```

流程：

```text
Telegram
↓
Channel Gateway
↓
Aika
↓
Intent / Tool Decision
↓
AgentSessionManager
↓
spawn Codex
↓
Codex 检查仓库
↓
产生 Plan
↓
需要执行修改
↓
Permission Runtime
↓
Aika 手机询问：

“Codex 想修改以下 3 个文件，是否允许？”

↓
用户批准
↓
继续执行
↓
测试
↓
Result
↓
Telegram
```

因此真正产品体验会变成：

> 人不在电脑旁，也可以让 Aika 去管理电脑上的 Coding Agent。

---

# 10. Agent 和 Tool 必须分开

不要把：

```text
Codex
Claude Code
```

实现成普通 Tool。

普通 Tool：

```text
call
→ result
```

Coding Agent：

```text
spawn
↓
running
↓
events
↓
permission
↓
clarification
↓
multiple turns
↓
completed
```

因此必须有：

```text
ToolRuntime
```

和：

```text
AgentRuntime
```

两套生命周期。

---

# 11. Permission Runtime

加入远程控制和 Coding Agent 后，这是 P0。

定义：

```ts
PermissionRequest {
  id

  source:
    | "aika"
    | "tool"
    | "agent"

  action

  risk:
    | "safe"
    | "write"
    | "execute"
    | "external"
    | "dangerous"

  summary

  expiresAt
}
```

例如：

```text
read repository
→ 可自动允许

修改文件
→ 根据策略允许

git push
→ 请求批准

删除目录
→ 请求批准

发送外部消息
→ 请求批准

支付 / Account 操作
→ 默认禁止
```

审批可以从：

```text
Desktop
Android
Telegram
Feishu
```

完成。

---

# 12. Channel Capability / Permission

不同 Channel 权限不能相同。

例如：

```text
Desktop
→ Full

Personal Telegram DM
→ High

Feishu DM
→ Medium

Telegram Group
→ Low

QQ Group
→ Low
```

加入：

```ts
ChannelPolicy {
  channel
  scope

  allowedTools
  allowedAgents

  allowSensitiveMemory
  allowSystemActions
}
```

避免：

```text
QQ群里有人：
“帮我删掉项目目录”

→ Aika 真执行
```

---

# 13. Context 来源标记

Context 增加 Source：

```ts
ContextSource =
  | "desktop"
  | "mobile"
  | "telegram"
  | "feishu"
  | "qq"
  | "environment"
  | "agent"
```

Memory Candidate 必须记录来源：

```ts
MemoryCandidate {
  content
  source
  confidence
  conversationId
}
```

避免群聊、Coding Agent 输出或第三方消息污染 User Soul。

---

# 14. Proactive Runtime 升级

原本：

```text
Environment Event
↓
ProactivePolicy
↓
Desktop Pet
```

升级：

```text
                    ProactivePolicy
                          │
          ┌───────────────┼──────────────┐
          ▼               ▼              ▼
      Desktop Pet       Mobile       Messaging
                        Push          Channel
```

例如：

```text
训练结束
→ 手机 Push

Codex 完成任务
→ Telegram

游戏五杀
→ 桌宠立即说话

用户长时间未回复
→ 不一定跨平台追着用户发消息
```

增加：

```ts
DeliveryPolicy {
  eventType
  urgency
  preferredChannels
  quietHours
  cooldown
}
```

---

# 15. Scheduler

需要正式加入 Runtime：

```text
Scheduler
├── Reminder
├── Cron Task
├── Delayed Task
├── Agent Job
└── Proactive Check
```

例如：

```text
“今晚提醒我提交申请”
```

或者：

```text
“Codex 跑完测试以后告诉我”
```

后者不是 Cron，而是：

```text
Condition / Event Trigger
```

---

# 16. Plugin / Skill 方向

Aika 后续能力统一成：

```text
Channel
Tool
Agent
Sensor
Skill
```

其中：

```text
Channel
→ 我从哪里和 Aika 交流

Sensor
→ Aika 能感知什么

Tool
→ Aika 能立即操作什么

Agent
→ Aika 能委托谁长期执行

Skill
→ Aika 知道某类任务应该怎么完成
```

不要混成一个 Plugin 类型。

Plugin 可以作为安装和生命周期容器：

```ts
Plugin {
  channels?: ChannelAdapter[]
  tools?: Tool[]
  sensors?: Sensor[]
  agents?: AgentAdapter[]
  skills?: Skill[]
}
```

---

# 17. 推荐目录

```text
src/
├── runtime/
│   ├── companion/
│   ├── context/
│   ├── memory/
│   ├── proactive/
│   ├── scheduler/
│   └── permission/
│
├── gateway/
│   ├── channel/
│   │   ├── telegram/
│   │   ├── feishu/
│   │   └── qq/
│   │
│   ├── device/
│   ├── identity/
│   └── session/
│
├── agents/
│   ├── session/
│   ├── acp/
│   ├── codex/
│   └── claude/
│
├── tools/
├── skills/
├── sensors/
│
└── presentation/
    ├── desktop/
    ├── pet/
    └── mobile/
```

实际目录应服从当前仓库已有结构，本节代表模块边界，不要求为了匹配目录图进行大规模重构。

---

# 18. 开发阶段

## Phase 0 — Runtime Contract

**优先级：P0**

先冻结以下接口：

```text
Message
Conversation
Identity
Session
Channel
Device
AgentSession
PermissionRequest
EnvironmentEvent
```

AC：

* Desktop 原有聊天行为不变
* UI 不直接依赖 Channel
* Channel 不直接调用 LLM
* ACP 不直接访问 React 状态
* AgentSession 生命周期可独立测试

---

## Phase 1 — Channel Gateway MVP

第一渠道：

```text
Telegram
```

原因：

```text
实现简单
远程体验明显
非常适合验证 Gateway 架构
```

实现：

```text
Telegram Adapter
Identity Mapping
Session Router
Text Message
Voice Message
File
Outbound Message
```

暂不：

```text
Feishu
QQ
Group advanced policy
```

验收：

```text
Telegram 给 Aika 发消息
↓
进入同一个 CompanionRuntime
↓
共享 Soul / Memory
↓
Telegram 收到回复
```

---

## Phase 2 — Device Gateway

实现：

```text
Device Pairing
LAN Discovery
WebSocket
Authentication
Remote Session
```

复用现有局域网手机访问能力，不另造一套 Agent。

验收：

```text
手机配对 PC
↓
语音/文字发送
↓
同一个 Runtime
↓
PC / 手机状态一致
```

---

## Phase 3 — ACP MVP

第一阶段：

```text
Codex
Claude Code
```

实现：

```text
ACP Client
AgentSessionManager

spawn
send
event
cancel
approve
complete
```

必须支持：

```text
workspace
session id
streaming events
permission
error
timeout
cancel
```

验收：

```text
Aika：
“让 Codex 看一下这个项目。”

↓
ACP Spawn

↓
Codex 返回结果

↓
Aika 汇总给用户
```

---

## Phase 4 — Remote Coding

打通：

```text
Telegram / Mobile
↓
Aika
↓
ACP
↓
Codex / Claude Code
```

增加：

```text
Remote Approval
Agent Progress
Task Completion Notification
```

这是第一个真正体现 v0.5 产品价值的 Milestone。

---

## Phase 5 — Feishu + QQ

在 Telegram Gateway 稳定以后再加入：

```text
FeishuAdapter
QQAdapter
```

禁止复制业务逻辑。

只允许新增：

```text
Platform Transport
Platform Capability Mapping
Platform Auth
```

所有：

```text
Memory
LLM
Agent
Permission
Session
```

继续走统一 Runtime。

---

## Phase 6 — Environment Awareness

接回原 v0.4：

```text
Foreground Process
Window Context
UI Automation
Screen Change
OCR
```

统一产生：

```text
EnvironmentEvent
```

接入：

```text
ProactivePolicy
```

---

## Phase 7 — Desktop Pet

完善：

```text
Transparent Window
Always On Top
Click Through
Live2D
Bubble
Mood
Motion
Lip Sync
```

桌宠继续只是：

```text
Presentation Adapter
```

不持有 Runtime。

---

## Phase 8 — Scheduler + Cross-channel Proactive

实现：

```text
Reminder
Agent Completion
Environment Trigger
Scheduled Message
Mobile Push
Channel Delivery
```

Aika 开始具备真正的：

```text
Always-on Agent
```

体验。

---

## Phase 9 — Cloud Relay

前面的能力稳定后再考虑：

```text
Aika Relay
```

只负责：

```text
Device Relay
Push
NAT Traversal
Account
Encrypted Sync
```

不要第一阶段就把：

```text
Memory
Soul
OCR Screenshot
完整 Runtime
```

搬到云端。

保持：

```text
Local First
```

---

# 19. 开发优先级

最终顺序：

```text
P0
Runtime Contract
        ↓
P1
Telegram Gateway
        ↓
P2
Device Gateway
        ↓
P3
ACP + Codex
        ↓
P4
Claude Code + Remote Approval
        ↓
P5
Remote Coding 完整链路
        ↓
P6
Feishu / QQ
        ↓
P7
Environment Awareness
        ↓
P8
Desktop Pet / Live2D
        ↓
P9
Scheduler / Proactive Delivery
        ↓
P10
Cloud Relay
```

---

# 20. v0.5 最重要的验收场景

最终必须至少实现下面这条完整链路：

```text
用户离开电脑
        ↓
手机打开 Telegram
        ↓
“帮我让 Codex 看一下 Aika
为什么测试失败。”
        ↓
Channel Gateway
        ↓
Identity / Session Router
        ↓
Aika Runtime
        ↓
AgentSessionManager
        ↓
ACP
        ↓
Codex
        ↓
分析仓库
        ↓
请求修改权限
        ↓
Telegram 出现批准请求
        ↓
用户批准
        ↓
Codex 修改 + 测试
        ↓
Agent Completed
        ↓
Aika 总结
        ↓
Telegram：
“修好了，原因是……
测试结果是……”
        ↓

晚上回到 PC

桌宠 Aika：

“下午那个问题已经处理好了。”
```

如果这条链路成立：

> Desktop Pet、Mobile、Telegram、Memory、Permission、ACP、Coding Agent 就真正成为了同一个系统。

---

# 21. v0.5 明确不做

本版本不要同时追求：

```text
几十种 IM
完整云端 SaaS
iOS 全能力
完全自主电脑控制
无限 Multi-Agent
复杂 Agent Swarm
自己的 Coding Agent
完整 Browser Agent
所有 MCP Server
全自动无审批写操作
```

先证明：

```text
一个 Runtime
+
多个入口
+
一个远程设备
+
一个消息渠道
+
两个外部 Coding Agent
```

能够稳定工作。

---

# 22. 最终产品架构定义

Aika 最终应被定义为：

```text
Aika
=
Identity
+
Soul
+
Memory
+
Context
+
Companion Runtime
+
Channel Gateway
+
Device Gateway
+
Environment Sensors
+
Tool Runtime
+
Agent Runtime
+
Permission Runtime
+
Proactive Runtime
```

桌宠只是：

```text
Aika 的桌面身体
```

手机只是：

```text
Aika 的移动身体
```

Telegram / QQ / Feishu 是：

```text
Aika 与用户联系的通信入口
```

Codex / Claude Code 是：

```text
Aika 可以委托工作的外部执行 Agent
```

而真正唯一长期存在的是：

```text
                Aika Runtime
                     │
          Identity / Soul / Memory
                     │
       ┌─────────────┼──────────────┐
       │             │              │
     身体           渠道           能力
 Desktop/Mobile   IM Gateway   Tool/ACP Agent
```

这应作为 v0.5 后所有架构决策的最高约束。
