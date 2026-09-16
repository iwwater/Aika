import type { ChatMessage } from "../../domain/conversation";
import type { MemoryRecord, MemoryStatus } from "../../domain/memory";
import type { SessionSummary } from "../../domain/summary";
import type { MemoryV2Store } from "../memory/memoryStore";
import type { SqlExecutor } from "../memory/sqliteMemoryStore";

/**
 * 持久化边界。
 *
 * 桌面版走 SQLite（`sqliteStorage`），浏览器里跑 `npm run dev` 时退回 localStorage
 * （`localStorage` 实现），两者行为一致，界面不需要知道自己在哪个上面跑。
 *
 * API Key 不在这里：它走 secretStore，落在 DPAPI 加密的 secrets.json，不与业务数据同表。
 */
export interface AikaStorage {
  readonly kind: "sqlite" | "local";

  /**
   * LLM-03 记忆 V2 端口。
   *
   * 可选：老实现与测试 fake 不提供它，调用方必须能退回 V1 的
   * `listMemories/addMemories/...`。桌面端与浏览器端都会提供。
   */
  readonly memoryV2?: MemoryV2Store;

  /**
   * 底层 SQL 执行器。**可选**：只有 SQLite 实现有，localStorage 实现没有。
   *
   * 为什么要把它露出来：Trace 落盘（LLM-07）与后续的存储浏览页需要在同一个库里
   * 建自己的表，而它们不属于 `AikaStorage` 的业务语义——把 trace 的读写塞进这个
   * 接口才是真的越界。露出执行器让它们各自管自己的表，而不是让这个接口无限长大。
   *
   * 拿到它的代码负责自己的表：不许改别人的表，也不许绕过上面的方法改消息与记忆。
   */
  readonly sqlExecutor?: SqlExecutor;

  /**
   * 最近 limit 条消息，按时间正序。
   *
   * `scope`（RT-02）给定时只返回该 conversation 的消息（旧数据归属 local）；
   * 不给定时保持旧行为返回全部——那是单主体桌面的历史口径，不是泄漏通道，
   * 但调用方应当总是传 scope。
   */
  listMessages(limit: number, scope?: { conversationId: string }): Promise<ChatMessage[]>;
  appendMessage(message: ChatMessage): Promise<void>;
  /** 全部消息的时间戳，用于多因子关系状态；给 scope 时只统计该会话。 */
  listMessageTimestamps(scope?: { conversationId: string }): Promise<number[]>;
  countMessagesSince(since: number): Promise<number>;
  countProactiveSince(since: number): Promise<number>;
  /**
   * 按 id 删除消息。未知 id 静默忽略，重复调用幂等。
   *
   * 与 `clearMessages()` 的区别不只是范围：这里**不**连带作废摘要。删掉最近一条
   * 失败消息不该触发整段摘要重压缩，摘要覆盖的是更早的消息。也不连带删记忆——
   * 撤回要不要撤掉该轮的记忆候选是调用方的产品决策，端口不替它决定。
   */
  deleteMessages(ids: readonly string[]): Promise<void>;
  clearMessages(): Promise<void>;

  listMemories(): Promise<MemoryRecord[]>;
  addMemories(records: readonly MemoryRecord[]): Promise<void>;
  setMemoryStatus(id: string, status: MemoryStatus): Promise<void>;
  deleteMemory(id: string): Promise<void>;

  /** 给 scope 时只取该会话的最新摘要；不给时保持旧行为（RT-02）。 */
  latestSummary(scope?: { conversationId: string }): Promise<SessionSummary | null>;
  saveSummary(summary: SessionSummary): Promise<void>;
  /**
   * 让已有摘要整体失效（LLM-03 删除记忆时用）。
   *
   * 摘要没有可用的消息溯源，删掉某条记忆后无法只摘掉其中一句，
   * 因此保守地整段作废，下一轮再压缩一次。老实现可以不提供。
   */
  deleteSummaries?(): Promise<void>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}

export const SETTING_KEYS = {
  provider: "provider",
  proactive: "proactive",
  /**
   * 点击桌宠时的回应开关（MVP-15 B）。**默认开**：用户点了它就该有反应。
   *
   * 与「主动消息」分开：那个管的是她**主动**开口（每日上限、最小间隔、勿扰），
   * 这一个管的是**你点了她之后**的一声回应。两者叠加判定，但可以各自关。
   */
  petClickReaction: "pet.clickReaction",
  proactiveLastSentAt: "proactive.lastSentAt",
  proactiveLastReason: "proactive.lastReason",
  memoryExtraction: "memory.extraction",
  voiceBackend: "voice.backend",
  /** 语音输出链路（TTS-04）。API Key 不在这里：走 SecretStore 的 tts.cloud.apiKey。 */
  voiceOutput: "voice.output",
  whisperEndpoint: "voice.whisperEndpoint",
  mode: "llm.mode",
  /** Trace 开关（LLM-07）。默认值按构建取，持久化后以库里的为准。 */
  traceEnabled: "trace.enabled",
  traceIncludeText: "trace.includeText",
  /** 开发者模式（FE-09）。关着时标题栏没有工作台入口。 */
  devMode: "devtools.enabled",
  /** 版本化价目（FE-26 成本页）。价格由使用者显式输入，不内置实时价。 */
  usagePrices: "usage.pricing",
  /** 外部账户绑定关系（RT-02）。损坏按「没有任何绑定」处理（fail-closed）。 */
  identityBindings: "identity.bindings.v1",
  /** 权限请求记录（RT-03）。重启后 pending 保持 pending，绝不自动批准。 */
  permissionRequests: "permission.requests.v1",
  /** 渠道网关 inbox/outbox 状态（GW-01）。损坏按空网关处理。 */
  gatewayState: "gateway.state.v1",
  /** 前台应用感知开关（FE-19）。默认 false：默认关 = Rust 根本没装 hook。 */
  environmentForegroundEnabled: "environment.foregroundEnabled",
  /** 「将环境摘要用于对话」授权（FE-19）。与采集开关分离，默认 false。 */
  environmentContextEnabled: "environment.contextEnabled",
  /**
   * **墓碑键**：旧自研桌宠窗口的开关（FE-20）。窗口在 MVP-03 已删除，生产代码
   * 没有任何读取方。保留常量是为了让「旧开关键不等于外部桌宠授权」这条断言可写
   * （外部桌宠用 `desktopPet`，另一个键），而不是为了继续读它——库里残留的旧值
   * 永不生效。
   */
  petWindowEnabled: "pet.windowEnabled",
  /** 屏幕感知开关（FE-21）。默认 false：默认关 = Rust 根本没有采集线程。 */
  environmentScreenEnabled: "environment.screenEnabled",
  /**
   * 桌宠陪伴会话模式（FE-31）：`off` / `active` / `quiet`，默认 off。
   * 「已经授权过」单独记在 companionConsent——模式值本身不是同意凭据。
   */
  companionMode: "pet.companionMode",
  /**
   * 陪伴范围与外发边界的一次性确认（FE-31）。默认 false；
   * 范围或 Provider 外发边界变化时由调用方清掉，强制重新确认。
   */
  companionConsent: "pet.companionConsent",
  /** 环境主动搭话开关（FE-22）。与全局 proactive、摘要授权分层。 */
  environmentProactiveEnabled: "environment.proactiveEnabled",
  /**
   * 长期记忆读写总开关（MVP-06）。默认 true（与既有行为一致）。
   * 关闭时**读**（记忆源检索）与**写**（抽取/写回）都停；Recent 会话不受影响。
   * 与 `memoryExtraction` 的分工：那个只管「抽取 + 写回」这一半。
   */
  memoryEnabled: "memory.enabled",
  /**
   * 知识库（Wiki）检索开关（MVP-06）。默认 true。
   * 关闭时知识源零检索调用；Wiki 条目仍在库里、仍可查看编辑，只是不进 prompt。
   */
  knowledgeEnabled: "knowledge.enabled",
  /**
   * 外部桌宠（OpenPet）集成配置（PET-06）。JSON，结构见 `desktopPet.integration.v1`
   * 的 `PetConfig`。默认 `enabled=false`：**旧 `pet.enabled` 不会被自动转换成
   * 托管启动授权**——升级后是否需要 Aiki 去启动别人的程序，必须由用户明确说一次。
   */
  desktopPet: "pet.desktopIntegration.v1",
  /**
   * 外部桌宠的兼容 profile（PET-06）。JSON，结构 `PetProfileV1`。
   *
   * 与配置分开存：profile 是「上游某个版本某个角色的已验证映射」，换角色/换版本
   * 时它整体失效，而配置（地址、启动方式）仍然有效。
   */
  desktopPetProfile: "pet.desktopProfile.v1",
  /**
   * 「屏幕文字用于对话」授权（FE-32）。默认 false，且**独立于**摘要授权：
   * 它放行的是可见文字摘录本身，范围只限 FE-32 的按需读屏上下文源。
   */
  environmentScreenTextEnabled: "environment.screenTextEnabled",
  /**
   * CORE-03 迁移期用过 `core.orchestrator = legacy | kernel`。CORE-06 删除旧编排后
   * 这个 key 不再被读写；旧库里残留的值会被当作普通未知设置忽略，不报错、不迁移。
   */
} as const;
