# Aika Next 0.8 契约与 Schema 规范（08-00 基线冻结）

- **版本**：1.0.0 (08-00 Baseline Frozen)
- **基线日期**：2026-09-23
- **前序依赖**：0.79 P0/P1 缺陷闭环、Chromium 测试环境缓存隔离全绿、Runtime Pin 同步 (1312/1312)
- **文档范围**：冻结 0.8 生产入口与五大核心领域 Schema（Event、Observation、Grant、Invitation、Work），明确 Scope 作用域、来源修订、数据目的地、保留时间（TTL）、撤销与迁移规则，并固定消费者清单与最小包组合。

---

## 一、 通用原则与权威约束

1. **唯一轮次与对话权威（Single Dialogue Turn Authority）**：
   - 生产环境唯一轮次权威为 `core/turn-port.ts` 与 `core/dialogue-pipeline.ts`，由 `desktop/electron/main.mjs` 和 `trial-backend.ts` 接入；
   - 气泡、展开聊天抽屉、控制台会话查看均作为同一 `TurnScope` 的只读/投影消费者，**严禁创建第二套独立对话管线或直接连通大模型的私有轮次**；
   - 展开/收起聊天框、换显示模式（全屏/半身/极简）属于纯呈现切换，**绝不新建会话、不重复提交输入、不重复触发 TTS 朗读**。

2. **数据目的地与权限隔离（Data Destination & Confinement）**：
   - 所有感知采集（屏幕/区域）默认关闭，必须经由用户显式 Grant 授权；
   - 明确区分 `local`（本地模型/本地剪裁）与 `cloud`（远程云端 API），任何向云端发送屏幕或文本的动作必须在 Grant 中白名单声明；
   - 严禁静默提权：单次观察授权绝不自动提升为持久观察，文本问候绝不自动打开麦克风，Work 确认卡绝不自动执行产生副作用的外部命令。

3. **短期观察与长期沉淀解耦（Observation vs Long-term Memory）**：
   - `Observation` 默认仅在当前轮次 Context 有效，轮次结束或超时后在内存中安全释放，不得跨重启保留原文；
   - 观察结果若需进入 `User Wiki` 或 `Soul` 事实库，必须经由正式维护流程（用户确认或显式沉淀契约），且完整记录来源链；
   - 根事实撤销或遗忘时，派生闭包、上下文租约、检索缓存与界面投影必须同步失效。

---

## 二、 五大核心领域 Schema 规范

### 1. 采集授权契约：`CaptureGrant`

```typescript
export type GrantScopeType = 'window' | 'region' | 'screen';
export type ProcessingDestination = 'local' | 'cloud';
export type GrantStatus = 'active' | 'revoked' | 'expired';

export interface CaptureGrant {
  /** 授权唯一标识，由主进程生成 */
  readonly grantId: string;
  /** 授权代次/修订号，目标或范围变更时自增 */
  readonly revision: number;
  /** 关联的主机/会话作用域 */
  readonly sessionId: string;
  /** 授权范围类型：指定窗口、指定矩形区域、全屏（需高危显式确认） */
  readonly scopeType: GrantScopeType;
  /** 目标标识符（例如 Windows 窗口句柄或匹配标识） */
  readonly targetId: string;
  /** 物理/DPI 像素边界矩形 { x, y, width, height } */
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** 授权用途描述（向用户明确展示） */
  readonly purpose: string;
  /** 允许的最终处理目的地：纯本地离线 或 允许云端模型 */
  readonly destination: ProcessingDestination;
  /** 授权有效时长类型：单次使用 ('single') 或 会话生存期 ('session') */
  readonly duration: 'single' | 'session';
  /** 授权生效时间 (ISO-8601 UTC) */
  readonly grantedAt: string;
  /** 绝对过期时间 (ISO-8601 UTC) */
  readonly expiresAt: string;
  /** 当前状态 */
  readonly status: GrantStatus;
}
```

- **Scope 作用域**：绑定 `sessionId` 与确切的 `targetId`（窗口或矩形区域），多显示器与 DPI 缩放由宿主完成换算；
- **来源修订**：目标窗口移动、尺寸变更或目的地从 `local` 切换至 `cloud` 时，必须提升 `revision` 并重新向用户核验；
- **数据目的地**：`local` 仅允许本地 OCR / 离线轻量模型；`cloud` 允许授权发送给指定的云端 VLM 供应商；
- **保留时间 (TTL)**：单次任务使用完即标记 `expired`；会话级授权最长不超过当前进程生命周期，锁屏、用户切换窗口或关闭目标应用时自动置为 `revoked`；
- **撤销与迁移**：用户在控制台或桌面悬浮条点击“停止观察”立即将状态置为 `revoked`，任何在途网络请求和本地解析直接通过 AbortSignal 中止，不产生后续 Observation。

---

### 2. 观察结果契约：`Observation`

```typescript
export interface OcrTextBlock {
  readonly text: string;
  readonly confidence: number;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface OcrResult {
  readonly status: 'ok' | 'partial' | 'failed';
  readonly blocks: readonly OcrTextBlock[];
  readonly readingOrderText: string;
  readonly language?: string;
  readonly engine: string;
}

export interface VlmObservationResult {
  readonly status: 'ok' | 'partial' | 'uncertain' | 'failed';
  readonly summary: string;
  readonly visualElements: readonly string[];
  readonly uncertaintyNote?: string;
  readonly rawExcluded: true;
}

export interface Observation {
  readonly observationId: string;
  readonly pairing: { readonly characterId: string; readonly characterInstanceId: string };
  /** 必须关联具体的生效授权及修订号 */
  readonly grantId: string;
  readonly grantRevision: number;
  /** 原始画面 SHA-256 摘要（严禁在 Observation 中持久化原始图像 Base64/Buffer） */
  readonly frameHash: string;
  /** 捕获时间点 (ISO-8601 UTC) */
  readonly capturedAt: string;
  /** OCR 结构化解析结果 */
  readonly ocr?: OcrResult;
  /** VLM 视觉理解结果 */
  readonly vlm?: VlmObservationResult;
  /** 观察生命周期状态 */
  readonly state: 'active' | 'consumed' | 'invalidated' | 'expired';
  /** 内存生命周期 TTL (毫秒，默认 120,000 即 2 分钟) */
  readonly ttlMs: number;
}
```

- **Scope 作用域**：属于配对角色实例上下文的动态输入，仅作为 `DialoguePipeline` 提示词的**动态后缀（Dynamic Suffix）**拼接，**严禁修改 0.61/0.7 冻结前缀快照（Frozen Prefix Snapshot）**，保障供应商 KV 缓存命中率；
- **来源修订**：带 `grantRevision`；若对应的 Grant 已被撤销，该 Observation 状态立即翻转为 `invalidated`；
- **数据目的地**：纯内存驻留；控制台 Trace 与事件仅记录 `frameHash`、文本摘要、耗时与状态，原始图片在推理或提取完成后立即从内存及临时盘中释放（Drop/Unlink）；
- **保留时间 (TTL)**：默认 2 分钟；超过 TTL 未被消费自动移出 Context，绝不跨重启恢复；
- **撤销与迁移**：用户触发“遗忘”或 Grant 撤销时，内存中现存的所有关联 Observation 立即清空，不落入 SQLite 历史表。

---

### 3. 多来源事件外皮契约：`CompanionEventEnvelope`

```typescript
export type EventDomain = 'canon' | 'companion' | 'work';

export interface CompanionEventEnvelope<T = unknown> {
  /** 全局事件唯一编号 (UUIDv4) */
  readonly eventId: string;
  /** 契约版本号，固定为 1 */
  readonly schemaVersion: 1;
  /** 事件所属业务域：Canon (原作事实) | Companion (用户交互事实) | Work (工程任务) */
  readonly domain: EventDomain;
  /** 事件类型 (例如 companion.turn.finished, perception.observation.produced, proactive.invitation.dismissed) */
  readonly type: string;
  /** 关联角色配对作用域 */
  readonly pairing: { readonly characterId: string; readonly characterInstanceId: string };
  /** 轮次标识（若发生于对话中） */
  readonly turnId?: string;
  /** 来源引用（指向原始记录、观察或任务的 ID 与版本） */
  readonly sourceRef: { readonly id: string; readonly version: number; readonly revision?: number };
  /** 发生时间戳 (ISO-8601 UTC) */
  readonly occurredAt: string;
  /** 宿主接收时间戳 (ISO-8601 UTC) */
  readonly receivedAt: string;
  /** 业务载荷（纯数据，不含可执行代码或明文敏感密钥） */
  readonly payload: T;
  /** 事件元数据与脱敏摘要 */
  readonly summary: string;
}
```

- **Scope 作用域**：在现有 `HostEventChannel`（`contracts/plugin.ts`）的 `EventScope` 基础上明确 `pairing` 与 `domain`；
- **来源修订**：事件消费投影视同幂等投递，依赖 `eventId` 去重，以 `occurredAt` 排序，以 `sourceRef.version` 核验来源有效性；
- **数据目的地**：
  - `Canon` 域：只读作品设定；
  - `Companion` 域：伴侣互动时间线（`CompanionTimelineStore`）；
  - `Work` 域：工作记录卡（`DesktopWork` / 任务看板），**严禁将工程任务/执行器日志注入伴侣记忆或对话历史**；
- **保留时间 (TTL)**：运行时事件环形缓冲区保留最近 200 条用于控制台诊断；持久化事件依所属领域落地（如 Companion 随会话历史保留，Observation 事件仅保留元数据）；
- **撤销与迁移**：来源事实被撤销/遗忘时，向事件总线广播 `companion.fact.revoked` 事件，所有投影视图（Timeline、Context、UI）立即过滤并剔除该事件及其衍生展示。

---

### 4. 主动陪伴邀请契约：`InvitationCandidate`

```typescript
export type InvitationActionKind = 'text' | 'voice_start' | 'clarify';
export type InvitationStatus = 'pending' | 'accepted' | 'ignored' | 'dismissed' | 'expired';

export interface InvitationCandidate {
  readonly id: string;
  readonly pairing: { readonly characterId: string; readonly characterInstanceId: string };
  /** 触发原因码 (例如 morning_greeting, screen_context_activity, idle_checkin) */
  readonly reasonCode: string;
  /** 来源引用（例如关联的有效 ObservationId 或 ContinuityFactId） */
  readonly sourceRef: { readonly kind: 'observation' | 'continuity_fact' | 'schedule'; readonly id: string; readonly version: number };
  /** 建议展示的轻量提示文案 */
  readonly text: string;
  /** 用户点击后的动作语义：纯文本交流 ('text')、打开语音 ('voice_start')、任务确认 ('clarify') */
  readonly actionKind: InvitationActionKind;
  /** 冷却域分类（用于独立频次配额） */
  readonly quotaDomain: 'greeting' | 'proactive_topic' | 'work_followup';
  /** 生成时间 (ISO-8601 UTC) */
  readonly createdAt: string;
  /** 有效截止时间 (ISO-8601 UTC) */
  readonly validUntil: string;
  /** 当前状态 */
  readonly status: InvitationStatus;
}
```

- **Scope 作用域**：候选与主动策略严格绑定用户×角色配对；展示时复用现有 `companion/invitations.ts` 投递记录，同一本地安装内的每日配额与冷却由所有角色共享；
- **来源修订**：如果候选条目引用的 Observation 或连续性事实被撤销，该候选立即变为 `expired`；
- **数据目的地**：已接入的 Continuity 候选、策略和状态保存在 SQLite `proactive_invitation_candidates` / `proactive_invitation_policy`；展示投递记入既有 SQLite `invitation_deliveries`；事件只存通用邀请摘要与来源 ID/version，不复制事实正文；Observation 与 Schedule producer 尚未接入；
- **保留时间 (TTL)**：提示气泡展示 8 秒自动淡出（置为 `ignored`），候选有效期最长 15 分钟；
- **动作与权限隔离**：
  - 呈现形式为桌面轻量气泡，**绝不自动打开麦克风录音**；
  - 只有在 `actionKind === 'voice_start'` 且用户**明确主动点击气泡**时，才向渲染进程派发开麦指令；
  - `actionKind === 'text'` 点击走已有普通文本 `TurnScope`；不会启动麦克风或屏幕采集；
  - 用户忽略或关闭气泡触发 3 小时以上（或配置值）冷却期，不得连续轰炸用户。

当前正式生产接线仅将明确晋升且仍有效、证据合格的 Continuity fact/milestone 转为短期通用文本邀请；普通对话 candidate 不会自动晋升为事实。`trial-backend` 默认关闭主动策略，开启时以 revision checkpoint 避免历史回填；候选有效期 15 分钟，当前 renderer 气泡显示 8 秒后启动 180 毫秒淡出并提交忽略，尊重系统减少动态效果设置。以上软件自动化不替代 Electron 实际窗口验收。

---

### 5. 外部工作协作契约：`WorkRequest` 与 `WorkReceipt`

```typescript
export type WorkProtocol = 'acp' | 'mcp' | 'internal_harness';
export type WorkExecutionStatus = 'prepared' | 'dispatched' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'cancelled';

export interface WorkRequest {
  /** 幂等操作标识符，由调用方指定，重试不得变更 */
  readonly operationId: string;
  /** 单调递增的审阅版本；派发/取消必须提交与确认卡一致的版本 */
  readonly revision: number;
  /** 协议适配器类型 */
  readonly protocol: WorkProtocol;
  /** 准备请求时审阅的本地执行器 profile revision；profile 变化后旧卡不能切换到新命令 */
  readonly executorRevision?: number;
  /** 目标服务/执行器标识（如 codex-agent, filesystem-mcp） */
  readonly executorId: string;
  /** 目标项目或工作区上下文 */
  readonly target: { readonly projectId?: string; readonly directory?: string; readonly title: string };
  /** 经过用户明确确认的输入与指令摘要 */
  readonly instruction: string;
  /** MCP 将已发现工具和确切参数绑定到本次确认 revision */
  readonly toolCall?: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> };
  /** 权限范围白名单（如 read_only, workspace_write, dangerous_exec） */
  readonly permissionGrant: readonly string[];
  /** 发起时间戳 (ISO-8601 UTC) */
  readonly requestedAt: string;
}

export interface WorkReceipt {
  readonly operationId: string;
  /** 远端协议关联 ID（如 ACP Task ID 或 MCP Call ID） */
  readonly remoteTaskId?: string;
  /** 当前执行状态 */
  readonly status: WorkExecutionStatus;
  /** 状态更新时间戳 */
  readonly updatedAt: string;
  /** 结果引用或简报（纯文本，不得包含长篇日志代码倾倒进对话） */
  readonly summary?: string;
  /** 错误描述（若失败） */
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
}
```

- **Scope 作用域**：属于工程协作面板与独立的 `DesktopWork` 系统，在控制台的“项目与任务”视图呈现；
- **来源修订**：当用户修改任务指令或目标工程时，`revision` 单调递增；旧版确认必须失败关闭，不能派发新内容。`operationId` 保持稳定以维持幂等与审计关联；
- **数据目的地**：既有 `DesktopWork/ForwardReceipts` 与 ACP/MCP journal 分开保存；ACP/MCP profile 和 `work-protocol.sqlite` 位于产品数据目录 `.local/data/` 并要求私有文件权限。执行结果以 Work Card/Timeline 供用户查看，**绝不作为用户第一人称真实经历写入伴侣连续性记忆**；
- **保留时间 (TTL)**：ACP/MCP 已确认任务回执跨进程持久化，缺少终态的已派发任务恢复为 `uncertain` 且不可自动重派。显式遗忘会清除请求参数/回执正文并撤销同源 Timeline 内容；保留最小 tombstone 阻止副作用重放；
- **撤销与超时保障**：网络超时或远端无应答时，必须置为 `uncertain`（“回执未知”），**严禁在未确认结果前盲目重发带副作用的操作**。

ACP/MCP profile 通过认证的 Work 管理 API 编辑，profile revision 变更会使旧草稿失效；密钥只写私有 profile 文件，API 仅显示环境变量名称。MCP read-only 与 required grant 来自本地可信策略，远端 annotation 不能授予权限。当前 ACP server 的额外 permission request 默认拒绝，不存在隐式授权。

---

## 三、 当前生产消费者清单与兼容性策略

| 契约 / Schema | 现有代码位置 | 0.8 生产消费者 | 兼容性与演进策略 |
| :--- | :--- | :--- | :--- |
| `TurnScope` / 轮次 | `contracts/index.ts`<br>`core/turn-port.ts` | `desktop/main.mjs`<br>`core/dialogue-pipeline.ts`<br>`app/trial-backend.ts` | **完全锁定**：4 字段结构（characterId, sessionId, turnId, generation），禁止创建第 2 轮次权威。 |
| `HostEventChannel` | `contracts/plugin.ts` | `management/server.ts`<br>`core/desktop-runtime.ts` | **无破坏扩展**：复用 publish/subscribe 接口，payload 封装为 `CompanionEventEnvelope`。 |
| `Observation` | `contracts/perception.ts` (新增) | `core/dialogue-pipeline.ts`<br>`app/trial-backend.ts`<br>`desktop/main.mjs` | **动态后缀消费**：仅在 Prompt 动态组装末尾拼接，不改变前缀冻结快照。 |
| `CaptureGrant` | `contracts/perception.ts` (新增) | `desktop/electron/main.mjs`<br>`desktop/electron/preload.cjs` | **主进程边界**：在 Electron 主进程中校验 Windows 句柄与坐标，渲染层仅接收脱敏后的结果。 |
| `InvitationCandidate` | `companion/invitations.ts` | `companion/invitations.ts`<br>`desktop/local-greeting.ts`<br>`desktop/main.mjs` | **平滑迁移**：扩展现有 `InvitationStore` 支持短期来源，保持每日本地限额与冷却机制。 |
| `DesktopWork` | `contracts/desktop-work.ts`<br>`harness/desktop-work.ts` | `harness/desktop-work.ts`<br>`desktop/main.mjs` | **双路适配**：现有原生转发继续有效，新增 ACP / MCP 适配器作为外部扩展路径。 |

---

## 四、 最小包组合与无感知运行验证

0.8 遵循严格的包隔离机制（`RPD-06` 内核 + 插件包架构）：
1. **纯净核心（Core Only）**：
   - 不安装任何 OCR/VLM 感知包、主动策略包或外部 Work 工具包；
   - 系统仍可完整运行 Live2D 桌面伴侣、文本对话、语音交互与基础控制台；
   - 依赖缺失的功能在前端呈现明确的“未配置”或“未安装”灰色占位状态，不抛出非受控异常。
2. **感知扩展包组合（Core + Perception）**：
   - 独立加载 OCR / VLM 适配器，支持按需对指定窗口发起截屏提问，不强制捆绑主动策略。
3. **伴侣完整包组合（Core + Perception + Proactive + Work）**：
   - 联动场景：经授权观察屏幕 -> 适时触发桌面轻量气泡邀请 -> 用户同意后转入对话/协作。

---

## 五、 阶段结论

经本契约冻结，0.8 版本的输入边界、状态模型、安全隔离与生命周期已完成规范化固定。
后续 08-01 ~ 08-06 实施 SPEC 必须严格遵守上述 Schema 与原则，任何破坏性改动均需在此文档递增修订版本。
