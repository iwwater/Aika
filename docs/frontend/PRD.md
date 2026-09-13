# 前端交互与展示 · 模块 PRD

产品依据：[总 PRD](../PRD_V0.4.md)。本文件是模块边界，执行任务见 [SPEC 索引](SPEC.md)。

## 目标

通过模块接口展示角色、消息、模式设置和状态，支持独立 mock 开发。

## 范围

- 负责：React 页面/组件、字幕、交互、设置反馈与轻量 Runtime 桥接。
- 不负责：Provider 协议解析、Memory 检索算法、音频模型逻辑。
- 依赖通过 [共享契约](../modules/CONTRACTS.md) 注入；另一模块未上线时以 fake/mock 实现，不耦合其真实服务。

## 开发方式

把本模块任务按独立 SPEC 执行；每份只列必要输入输出、边界、AC 与定向测试，不重复总 PRD。当前小阶段只测试本模块；必须联调或大任务完成后才进行全流程调试。验收报告与证据存放本目录 reports/。

模块完成与全产品完成分别标记。真实模型/音频/设备样本不能由 fixture 冒充；旧后置能力继续保持 DEFERRED。具体执行要求见 [测试规则](../modules/TESTING.md)。

## 远程输出协议（暂名 AikaLink）· 草案 v0.1

状态：**已全文审阅，尚未实现**。用户已确认（2026-09-13）：立项推进；安全边界放开，公网访问是明确目标而非后置。SPEC 在各自下发时写入 [SPEC 索引](SPEC.md)，本节先记里程碑拆分。

### 背景与定位

- 现状：产品对外只有手机远程 HTTP 服务（`aika-crossplatform/src-tauri/src/remote.rs`，token 鉴权、仅局域网、路由仅供自家手机页），没有任何标准协议端点。
- 本能力给 webview 里的 TS 内核加**唯一一条对外输出端口**，让自研手机页之外的浏览器页面/宿主也能消费对话流并下发受控指令；Rust 侧维持薄壳，业务编排不动。
- 载荷不另起协议：出站回复使用ReplyEnvelopeV1的白名单RemoteReplyV1投影；Trace按主体授权和统一脱敏函数投影，不原样外发内部候选。
- 归属前端模块，SPEC 从 FE-14 起编；产品级条目经确认后并入总 PRD。

### 目标

| # | 目标 | 约束 |
| --- | --- | --- |
| 1 | 新增 `OutboundChannel` 端口：RuntimeEvent / Trace 映射为带 schemaVersion 的对外消息 | 出口收敛一处；schema 先冻结已有字段再扩展 |
| 2 | 协议双向：出站事件（回复、状态、可选 trace）+ 入站受控指令 | 入站指令只能走 `CompanionRuntime.submit`，遵守「单一编排路径」契约 |
| 3 | 每宿主一份 transport adapter（Tauri 扩展 remote.rs 先例；浏览器 dev 宿主 Node ws） | transport 可替换，协议与 schema 不随宿主变 |
| 4 | 安全按公网暴露设计，分阶段启用 | 见下节 |

### 安全边界（用户决定：边界放开，公网为目标）

- 分层启用、逐层显式开关：loopback（默认）→ 局域网（强制 token）→ 公网（强制 TLS + token）。
- 公网层 TLS 允许由反向代理终结（WSS/HTTPS）；token 存储复用 `secret_store`（DPAPI）先例。
- 最小暴露面：网关只暴露显式订阅的频道；存储浏览页 / 只读 SQL 控制台（FE-12）与任何 apiKey 面**永不进网关**；trace 频道默认关，需显式订阅 + 设置开关。
- 公网的网络层（端口转发 / 反代 / 中继）不构成模块 SPEC 的授权，届时须用户单独明确（AGENTS.md 授权规则）。

### 非目标

- 不做 CDP / Puppeteer 式的第三方浏览器自动化驱动；「控制」= 消费者收事件流 + 下发受控指令。
- 不暴露开发者工具面（存储浏览、只读 SQL、诊断）。
- 不改 `CompanionRuntime` 事件语义，只做外发映射；现有手机远程路由保留到消费者迁移完成再评估下线。
- 不引入新云服务或新凭证。

### 里程碑（SPEC 拆分，一次只执行一份）

四份 SPEC 已全文审阅，落在 [SPEC 索引](SPEC.md)：[FE-14](specs/FE-14.md) 协议内核（fake transport + conformance）→ [FE-17-pre](specs/FE-17.md) 认证前置 → [FE-15](specs/FE-15.md) Tauri宿主/手机迁移与 [FE-16](specs/FE-16.md) dev WS独立实现 → FE-17-host逐宿主门禁。FE-15 与 FE-16 无相互依赖。

### 共享契约影响

- 新增 token：`OutboundChannel`，定义在它描述的接口旁边（token 分散所有权），登记进 [共享契约](../modules/CONTRACTS.md)「v1 之后的追加」表格。
- 架构门禁不变：平台判断只在 `app/hosts/`；`resolve()` 白名单三处不变。
- 受影响消费者：暂无（新增端口）；手机页在 FE-15 迁移。

### 未决项（已随 SPEC 草案定案，执行时以 SPEC 为准）

- WS 还是 HTTP 轮询：Tauri 宿主 FE-15 轮询起步（tiny_http 不支持 WebSocket upgrade）；浏览器宿主 FE-16 用 `ws` 中继；Tauri 是否 WS 化推迟到真实延迟瓶颈出现再评估。
- trace门控：本地采集开+外发开+主体权限+显式订阅四门；正文外发另需授权。
- 配对形态：FE-17短期单次码兑换逐设备会话，撤销即时生效；旧?t=仅历史机制，不用于新认证。

---

## 环境感知与主动陪伴 · 草案 v0.1

> 最新用户要求已补入[专项PRD v0.2](PRD_ENVIRONMENT_AND_LIVE2D.md)：开启陪伴后自动OCR互动，active/quiet两模式，pet点击读屏与普通输入。新增FE-31/32、FE-30追加J～N为完整首版必需；此前仅固定英文词表和“点击回主窗”的限制不再代表完整产品范围。

> 2026-09-14 已形成[专项 PRD](PRD_ENVIRONMENT_AND_LIVE2D.md)及[九份 SPEC 拆分](SPEC.md)：FE-18～22修订、FE-27～30新增。新增要求仍待审阅，未启动实现。下方为早期方向；本轮规格的标题不采集、独立摘要授权、TTL、真实采集成本及Live2D分工，以专项PRD和各SPEC的2026-09-14修订为准。

状态：**已全文审阅，仍后置**。依据（2026-09-13）：用户提供的外部建议稿，对齐总 PRD §18 Environment Awareness、§24 Stage 2/3 与 MVP 4。本节只立方向与里程碑，**不自动启动实现**；SPEC 在各自下发时写入 [SPEC 索引](SPEC.md)，产品级条目经确认后并入总 PRD。

### 背景与定位

- 现状：Environment Awareness / Process Monitor / OCR Highlight / Screen Event 均属总 PRD「尚未进入正式实现」；桌宠窗口 / Live2D 属 MVP 4「部分完成 / 待优化」。
- 目标一句话：让 Aika "知道你正在干什么"——低成本传感器 → `EnvironmentEvent` → ProactivePolicy 裁决 → 需要时由 CompanionRuntime 主动发起一轮对话 → 桌宠窗口呈现。核心是**事件驱动 + 成本阶梯**，拒绝"持续全屏 OCR + LLM"循环。
- 归属前端模块：Rust 原生传感器走 `src-tauri` 薄壳扩展（同 remote.rs / AikaLink 先例），TS 侧策略与编排接 CompanionRuntime；桌宠窗口 / Live2D 本就是前端展示范围。

### 感知成本阶梯（核心原则）

```text
Foreground Process → Window Title → UI Automation → Screen Event(diff) → 局部截图+OCR → (Stage 3) VLM
```

- 低层能回答的问题不调用高层；OCR + Rule 能解决的不调用 VLM（总 PRD §18 既有原则）。
- Screen Event 先于 OCR：低清帧 diff / perceptual hash 判定画面显著变化，才对固定 ROI 局部截图并 OCR；画面没变什么都不做。
- OCR 两阶段：V1 轻量本地 OCR + 关键词/规则匹配（Victory / Defeat / Error 等固定词表）；V2 视需要换 RapidOCR / PaddleOCR ONNX（中文、小字、多区域），选型由对应 SPEC 定。
- UI Automation（建议新增层级，总 PRD 未列）：前台窗口控件文本可读则不 OCR；读不到 / 超时即降级，不阻塞、不重试轰炸。

### 事件与主动策略

- `EnvironmentEvent` 沿用总 PRD §18 四字段（type / timestamp / confidence / payload）；草案具体化为联合类型：`foreground_changed` / `screen_keyword` / `game_event` / `notification` / `idle_changed` 等，字段在 SPEC 冻结。
- 传感器**不直接触发对话**：Event Aggregator 汇聚去重 → `ProactivePolicy`（输入：事件、持续时长、lastTalk 间隔、userBusy、频控/勿扰）裁决 Ignore / 易失缓冲remember / Trigger。
- Trigger 的**唯一出口**是 `CompanionRuntime.submit(text, source="proactive", mode)`，遵守「单一编排路径」契约；绝无绕过 Runtime 直接播放文案的路径。
- 内核 eventBus 仍不含业务事件：EnvironmentEvent 经传感器端口订阅（Presenter / Policy 消费），不改 eventBus 封闭联合。

### 桌宠窗口（展示，前端既有范围）

- 独立 Tauri 窗口：transparent / frameless / always_on_top / click-through 可切换；与主窗口同进程但JS context/注册表不共享，经受控IPC消费主窗快照；只有主窗持有CompanionRuntime。
- Live2D 输入保持总 PRD §19（mood / expression / motion / speaking），不参与核心推理；主动消息气泡由桌宠 Presenter 渲染。
- PetController（拖拽 / 点击 / 待机动画 / 说话状态）属前端组件层；Live2D 资产工作流沿用 [Live2D 工作流](further/COMFYUI_LIVE2D_WORKFLOW.md)。

### Windows 原生传感器（Rust 薄壳）

| 传感器 | API（拟定） | 备注 |
| --- | --- | --- |
| Foreground Process | `GetForegroundWindow` / `GetWindowTextW` / `GetWindowThreadProcessId`；`EVENT_SYSTEM_FOREGROUND` 事件式，需专用线程消息循环；失败明确不可用 | 最先做；只取进程名 + 窗口标题 |
| UIA Reader | Windows UI Automation | 仅前台窗口、单次超时上限、失败即降级 |
| Screen Capture | Windows.Graphics.Capture | 只做 `captureRegion`（固定 ROI），不做桌面 hook |
| Notification | 用户态通知读取（后期） | 方案由 SPEC 定 |

### 平台边界

- **Windows**：完整环境感知主战场。
- **Android**：不做后台持续截屏感知。弱传感器（UsageStats / NotificationListener / Accessibility）够用即不截图；MediaProjection 仅在用户显式开启「屏幕感知模式」时使用（Android 14+ 授权收紧）。Android 原型属独立线（见 archive），不进本模块 SPEC。
- **iOS**：不做跨 App 环境感知，只保持 Companion Remote。

### 非目标

- 不做持续全屏 OCR / 持续后台录屏上传；不做 VLM 画面理解（Stage 3）。
- Camera Emotion / Voice Emotion 维持 Stage 3 与既有 DEFERRED，不在本 PRD 启动。
- 不把 UIA / OCR / 事件结果当作用户真实心理状态，只作为弱信号（总 PRD §18 Camera 原则同理）。
- Relationship Upgrade / Memory Consolidation 属 LLM 模块 Stage 2 条目，本 PRD 只把关系阶段等作为策略输入的对接点，不定义其算法。

### 隐私与默认

- 所有传感器默认关闭，逐项显式开关；Screen / OCR 必须用户主动启用（总 PRD §隐私）。
- 截图原图不落盘；OCR默认仅易失缓冲，不因policy或LLM候选变成User Soul，须遵循RT-04来源与用户确认边界。
- 主动对话有全局开关 + 频控上限 + 勿扰时段，全部用户可见可配。

### 里程碑（SPEC 拆分建议，一次只下发一份）

| SPEC | 交付 |
| --- | --- |
| FE-18 | 契约先行：`EnvironmentEvent` schema、`EnvironmentMonitor` / `ProactivePolicy` 端口与 fake 实现、EventAggregator；conformance 全覆盖，无任何真实传感器 |
| FE-19 | Windows 前台进程 / 窗口标题传感器（Rust invoke + 事件）+ 设置页逐项开关；前台切换进入 Context |
| FE-20 | 桌宠窗口：透明置顶窗、PetController、主动消息气泡展示链路（fake验逻辑，真实窗口另验） |
| FE-21 | Screen Event：低清帧 diff + 固定 ROI 局部截图 + V1 轻量 OCR 关键词规则 → keyword / game_event |
| FE-22 | ProactivePolicy 打磨：频控 / 勿扰 / lastTalk / userBusy 接入与可配置；UIA Reader 视 FE-21 后真实效果决定是否立项 |

### 共享契约影响

- 新增 token：`EnvironmentMonitor` / `ProactivePolicy`，定义在接口旁（token 分散所有权），登记进 [共享契约](../modules/CONTRACTS.md)「v1 之后的追加」表格。
- 传感器宿主能力遵循「能力缺失即 token 不注册」：非 Windows 宿主不注册原生传感器 token，消费方 `optional` + `tryResolve` 降级，不阻断启动。
- `CompanionRuntime.submit`已含source="proactive"，不重复新增；v0.5可信来源是独立信封。
- 架构门禁不变：平台判断只在 `app/hosts/`；Rust 新增 invoke 命令 / 事件沿用 remote.rs + bridge.ts 模式并进 capabilities 声明。

### 未决项（对应 SPEC 下发时定）

- OCR V1 引擎选型（Tesseract.js / onnxruntime-web 方案）与关键词表管理方式。
- UIA 在 Rust 侧的可行 crate 与性能上限；是否立项由 FE-21 后的真实效果决定。
- Tauri v2 多窗口透明 / 点击穿透的具体配置与失焦行为。
- 桌宠窗口与主窗口的 Presenter 复用形态（主窗聚合快照与pet最小权限IPC）。
- EnvironmentEvent 的置信度口径与 EventAggregator 去重窗口参数。

## 2026-09-13 审阅后的执行边界

Live Inspector使用FE-23～25（数据LLM-11），F9为FE-26。AikaLink FE-14～17按各SPEC当前正文执行：白名单回复、可信主体路由、安全门禁前置，TLS ack不能代替TLS。v0.5优先级见[上位PRD](../PRD_V0.5.md)。FE-18～22仍后置，本次拆文档不解除真实环境/桌宠后置。
