import { DEFAULT_CHARACTER } from "../domain/character";
import { toCompanionReply, type CompanionReply } from "../domain/companion";
import {
  buildCompanionContext, companionMessage, formatClockTime, messageTurn, regeneratableTurn, retryableTurn,
  rewindPlan, toCompanionTurns, userMessage, WELCOME_MESSAGE_ID,
  type ChatMessage, type MessageSource, type MessageTurn,
} from "../domain/conversation";
import {
  createMemoryV2, memoryLines, memoryTypeFromCategory, toLegacyMemoryRecord,
  type MemoryRecord, type MemoryRecordV2,
} from "../domain/memory";
import { MEMORY_TYPE_LABELS } from "../domain/memoryRetrieval";
import { buildProactiveInput } from "../domain/prompt";
import { PROVIDER_PRESETS, type ProviderConfig } from "../domain/providers";
import { computeRelationship, deriveRelationshipSignals, type RelationshipState } from "../domain/relationship";
import {
  DEFAULT_MODE_CONFIG, exitScenarioMode, normalizeModeConfig, type ModeConfig,
} from "../domain/soul";
import {
  canSend, chooseProactiveReason, DEFAULT_PROACTIVE_SETTINGS,
  type ProactiveReasonKind, type ProactiveSettings,
} from "../domain/proactive";
import type { Sticker } from "../domain/stickers";
import { RAW_TURN_WINDOW, SUMMARY_INPUT_LIMIT, shouldSummarize } from "../domain/summary";
import type { PartialReply } from "../domain/streamingReply";
import type { VoiceTurnRequest } from "../domain/voiceRuntime";
import { createModelMemoryExtractor, formatTranscript, type MemoryExtractor } from "../services/memory/extractor";
import { createMemoryRepository, type MemoryRepository } from "../services/memory/memoryRepository";
import type { MemoryAccess } from "../services/memory/tokens";
import { NO_TRACE, type TraceRecorder } from "../services/trace/traceRecorder";
import { createMemoryMaintenance, type MemoryMaintenance } from "../services/memory/writeback";
import { createStorageMaintenanceJournal } from "../services/memory/maintenanceJournal";
import type { VoiceOutputSettingsPort } from "../services/voice/outputSettings";
import type { VoiceOutputConfig } from "../services/voice/outputEngine";
import type { Notifier } from "../services/notification/notifier";
import type { RuntimeServices } from "../services/runtime/tokens";
import { loadStickers } from "../services/stickers/library";
import {
  loadProvider, saveProvider, secretStore, SETTING_KEYS, type AikaStorage,
} from "../services/storage";
import { createSerializedMessagePersister } from "../services/storage/messagePersistence";
import { DEFAULT_VOICE_BACKEND, type VoiceBackendConfig } from "../services/voice/inputEngine";

/**
 * CompanionPresenter：与 React 无关的会话展示层。
 *
 * 它把「界面该看到什么」和「用户操作该怎么落地」收在一处，React 只订阅快照。
 * 对话本身的 turn 生命周期、取消、落库由 CompanionRuntime 负责；这里负责：
 *
 * 1. 持有不可变视图快照，状态没变时 `getSnapshot()` 必须返回同一个对象，
 *    否则 `useSyncExternalStore` 会无限重渲染。
 * 2. 把 Runtime 事件映射成界面消息，并在结算后用存储里的权威结果对齐。
 * 3. 记忆维护、主动消息、模式与设置写入等界面相关编排。
 *
 * CORE-06 之后全仓只有一条编排路径：Runtime 由展示插件从注册表取出后经构造参数注入，
 * 这里的 `send()` 不再有 legacy 分支，也不再认识 `activeRuntimeServices` 之类的全局槽。
 *
 * 注意：本文件**不得 import React**，这是「Presenter 能在无 DOM 的 node 环境跑完
 * 一轮」这条多宿主判据的前提，由 architecture.test.ts 守着。
 */

const MESSAGE_WINDOW = 200;
/** 回退后追加到摘要末尾的一行。她据此知道这段历史不完整。 */
const REWIND_GAP_NOTE = "（用户把对话回退到了更早的位置，这段摘要里可能包含已经不存在的内容。）";
const PROACTIVE_TICK_MS = 60_000;

export interface CompanionViewModel {
  ready: boolean;
  /** Runtime 当前活动轮次；没有在途轮次时为 null。 */
  activeTurnId: string | null;
  busy: boolean;
  messages: readonly ChatMessage[];
  mode: ModeConfig;
  /** 对外统一的错误视图字段；当前等价于 storageError。 */
  error: string | null;
  storageError: string;
  storageKind: AikaStorage["kind"];
  keyIsSecure: boolean;
  connected: boolean;
  sending: boolean;
  provider: ProviderConfig;
  memories: readonly MemoryRecord[];
  memoryExtractionEnabled: boolean;
  proactive: ProactiveSettings;
  voiceBackend: VoiceBackendConfig;
  /** 语音输出持久化配置（不含 Key——Key 不进快照/Trace，只报 hasApiKey）。
   * 输出链路实际状态在 voice 会话视图（outputStatus），degraded 要当错误显示。 */
  voiceOutput: { output: string; baseUrl: string; model: string; voice: string; speed: number; hasApiKey: boolean } | null;
  stickers: readonly Sticker[];
  relationship: RelationshipState;
  summary: string | null;
}

/**
 * 前端架构里定义的 CompanionPresenter 契约（名称可调，语义不变）。
 *
 * 与文档上的差异只有一处：契约写的是 `setMode(config)`，这里叫 `setModeConfig`，
 * 因为界面还保留一个按 ModeId 切换的便利方法。两者落地的是同一个命令。
 */
export interface CompanionPresenter {
  /** 幂等：StrictMode 双次挂载只会触发一次装载。 */
  start(): Promise<void>;
  getSnapshot(): CompanionViewModel;
  subscribe(listener: () => void): () => void;
  send(
    content: string,
    source?: MessageSource,
    onPartial?: (partial: PartialReply) => void,
    request?: VoiceTurnRequest,
  ): Promise<CompanionReply | null>;
  /** 取消当前轮次。 */
  cancel(): void;
  /**
   * 重跑失败的那一轮。
   *
   * 不是「再发一次」：失败轮在库里已经留下用户消息与失败气泡两行，
   * 直接重投会留下两条相同的用户消息。这里先整轮删掉，再用同一句原话提交。
   */
  retry(messageId: string): Promise<CompanionReply | null>;
  /** 对已经成功的那一轮换一个回复。机制与 retry 相同，入口不同。 */
  regenerate(messageId: string): Promise<CompanionReply | null>;
  /**
   * 撤回这一轮。
   *
   * 连带遗忘由它喂出来的**未确认**候选记忆；用户确认过的一律保留。
   */
  withdraw(messageId: string): Promise<void>;
  /**
   * 回到这一条：截断它之后的全部消息与派生数据。
   *
   * 摘要不回滚，只在它覆盖到被删范围时标一个 gap——理由见实现处注释。
   */
  rewind(messageId: string): Promise<void>;
  setProvider(next: ProviderConfig): Promise<void>;
  setProactive(next: ProactiveSettings): Promise<void>;
  setMemoryExtractionEnabled(enabled: boolean): Promise<void>;
  setVoiceBackend(next: VoiceBackendConfig): Promise<void>;
  /** 保存并应用语音输出配置（TTS-04）；持久化失败时抛错且不切内存。 */
  setVoiceOutput(next: VoiceOutputConfig): Promise<void>;
  /** 显式删除已保存的云端 Key。 */
  removeVoiceApiKey(): Promise<void>;
  setModeConfig(next: ModeConfig): Promise<void>;
  exitScenario(): Promise<void>;
  confirmMemory(id: string): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  dispose(): void;
}

export interface IntervalPort {
  set(handler: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface CompanionPresenterDeps {
  /** 惰性打开存储。装配失败时这里抛出的错误会显示成 storageError。 */
  loadStorage: () => Promise<AikaStorage>;
  /** 通知端口。宿主没装通知能力时注入 no-op 实现；`notify` 永远不抛。 */
  notifier: Notifier;
  /** 编排服务 + 本轮 Provider 配置；由展示插件从注册表注入。 */
  runtime: RuntimeServices | null;
  /** 记忆能力包；缺失时（noMemoryPlugin 或无 V2 存储）退回 V1 记忆路径。 */
  memoryAccess?: MemoryAccess | null;
  /** Trace 记录器；不传等于不记。 */
  trace?: TraceRecorder;
  loadStickers?: () => Promise<readonly Sticker[]>;
  extractor?: MemoryExtractor;
  interval?: IntervalPort;
  providerFallback?: ProviderConfig;
  randomUUID?: () => string;
  /** 后台维护的触发阈值（每 N 个成功轮一批）。生产默认 8；测试可注入更小值。 */
  maintenanceTurnThreshold?: number;
  /** 语音输出设置端口（TTS-04）；缺省时输出设置只读不可写。 */
  voiceOutputSettings?: VoiceOutputSettingsPort;
  /** 把新输出配置推给 VoicePresenter（重建引擎与队列）。 */
  applyVoiceOutput?: (config: VoiceOutputConfig) => void;
}

function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function welcomeMessage(now: number): ChatMessage {
  return {
    id: WELCOME_MESSAGE_ID,
    role: "assistant",
    content: DEFAULT_CHARACTER.greeting,
    japaneseText: DEFAULT_CHARACTER.greeting,
    chineseTranslation: DEFAULT_CHARACTER.greetingTranslation,
    source: "text",
    createdAt: now,
    time: formatClockTime(now),
  };
}

function replacePendingMessage(
  current: readonly ChatMessage[],
  pendingId: string,
  replacement: ChatMessage | null,
): ChatMessage[] {
  const index = current.findIndex((message) => message.id === pendingId);
  if (index < 0) return replacement ? [...current, replacement] : [...current];
  if (!replacement) return current.filter((message) => message.id !== pendingId);
  return current.map((message) => (message.id === pendingId ? replacement : message));
}

function appendVisibleError(current: string, next: string): string {
  if (!current) return next;
  if (current.split("\n").includes(next)) return current;
  return `${current}\n${next}`;
}

function removeVisibleError(current: string, target: string): string {
  return current.split("\n").filter((line) => line !== target).join("\n");
}

/** V2 记录 → 界面列表：隐藏被取代的，其余转成 V1 视图。 */
function visibleMemories(records: readonly MemoryRecordV2[]): MemoryRecord[] {
  return records.filter((record) => record.status !== "superseded").map(toLegacyMemoryRecord);
}

const DEFAULT_INTERVAL: IntervalPort = {
  set: (handler, ms) => setInterval(handler, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createCompanionPresenter(deps: CompanionPresenterDeps): CompanionPresenter {
  const { loadStorage, notifier } = deps;
  /** 编排服务 + Provider 配置；宿主装配不完整时为 null（兜底 Presenter 就是这种）。 */
  const runtimeServices = deps.runtime;
  const loadStickerLibrary = deps.loadStickers ?? loadStickers;
  const interval = deps.interval ?? DEFAULT_INTERVAL;
  const providerFallback = deps.providerFallback ?? PROVIDER_PRESETS[1];
  const uuid = deps.randomUUID ?? (() => crypto.randomUUID());

  let disposed = false;
  let startPromise: Promise<void> | null = null;

  let storage: AikaStorage | null = null;
  let memoryRepository: MemoryRepository | null = null;
  let unsubscribeInvalidation: (() => void) | null = null;
  let unsubscribeMemoryChanged: (() => void) | null = null;
  /** 记忆能力包；管理页改完记忆时靠它通知，这里也靠它通知管理页。 */
  let memoryAccess: MemoryAccess | null = null;
  let maintenance: MemoryMaintenance | null = null;
  let voiceOutputSettings: VoiceOutputSettingsPort | null = deps.voiceOutputSettings ?? null;
  let voiceOutput: VoiceOutputConfig | null = null;
  let voiceOutputErrors = new Set<string>();
  let persist: (message: ChatMessage) => Promise<void> = async () => undefined;
  const trace = deps.trace ?? NO_TRACE;
  const persistedMessageIds = new Set<string>();

  let ready = false;
  let storageError = "";
  let storageKind: AikaStorage["kind"] = "local";
  let keyIsSecure = false;
  let provider: ProviderConfig = providerFallback;
  let messages: ChatMessage[] = [];
  let memories: MemoryRecord[] = [];
  let timestamps: number[] = [];
  let summary: string | null = null;
  let summaryCoversUntil = 0;
  let proactive: ProactiveSettings = DEFAULT_PROACTIVE_SETTINGS;
  let memoryExtractionEnabled = true;
  let voiceBackend: VoiceBackendConfig = DEFAULT_VOICE_BACKEND;
  let modeConfig: ModeConfig = DEFAULT_MODE_CONFIG;
  let stickers: Sticker[] = [];
  let sending = false;
  let kernelTurnId: string | null = null;
  let maintenanceEnabled = true;
  let modeSaveErrors = new Set<string>();
  let proactiveTimer: unknown = null;

  let cached: CompanionViewModel | null = null;
  let dirty = true;
  let listeners = new Set<() => void>();

  const extractor = deps.extractor ?? createModelMemoryExtractor(() => provider);

  function connected(): boolean {
    return Boolean(provider.apiKey && provider.baseUrl && provider.model);
  }

  function commit(): void {
    if (disposed) return;
    dirty = true;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 一个订阅者抛错不能影响其它订阅者，更不能拖垮这一轮。
      }
    }
  }

  function setMessages(next: ChatMessage[]): void {
    messages = next;
    commit();
  }

  function patchMessages(update: (current: readonly ChatMessage[]) => ChatMessage[]): void {
    setMessages(update(messages));
  }

  function setSending(next: boolean): void {
    if (sending === next) return;
    sending = next;
    commit();
  }

  function setStorageError(next: string): void {
    if (storageError === next) return;
    storageError = next;
    commit();
  }

  function syncProactiveTimer(): void {
    if (disposed) return;
    if (proactive.enabled && proactiveTimer === null) {
      proactiveTimer = interval.set(() => void runProactiveTick(), PROACTIVE_TICK_MS);
    } else if (!proactive.enabled && proactiveTimer !== null) {
      interval.clear(proactiveTimer);
      proactiveTimer = null;
    }
  }

  async function load(): Promise<void> {
    const opened = await loadStorage();
    if (disposed) return;
    storage = opened;
    persist = createSerializedMessagePersister(
      () => storage,
      persistedMessageIds,
      (createdAt) => {
        timestamps = [...timestamps, createdAt];
        commit();
      },
    );

    const [
      savedProvider, savedMessages, savedMemories, savedTimestamps, savedSummary,
      rawProactive, rawExtraction, rawBackend, rawEndpoint, rawMode,
    ] = await Promise.all([
      loadProvider(opened, providerFallback),
      opened.listMessages(MESSAGE_WINDOW),
      opened.listMemories(),
      opened.listMessageTimestamps(),
      opened.latestSummary(),
      opened.getSetting(SETTING_KEYS.proactive),
      opened.getSetting(SETTING_KEYS.memoryExtraction),
      opened.getSetting(SETTING_KEYS.voiceBackend),
      opened.getSetting(SETTING_KEYS.whisperEndpoint),
      opened.getSetting(SETTING_KEYS.mode),
    ]);
    if (disposed) return;

    // 语音输出配置（TTS-04）：读回持久化状态并推给 VoicePresenter，
    // 否则重启后会被默认 system 覆盖。load 失败按默认值继续，不算启动故障。
    if (voiceOutputSettings) {
      try {
        voiceOutput = await voiceOutputSettings.load();
        deps.applyVoiceOutput?.(voiceOutput);
      } catch {
        voiceOutput = null;
      }
      if (disposed) return;
    }

    // 清单读不出来就当没有表情包，不该拦住这次启动。
    stickers = [...await loadStickerLibrary()];
    if (disposed) return;

    storageKind = opened.kind;
    keyIsSecure = await secretStore.secure();
    provider = savedProvider;
    messages = savedMessages.length ? [...savedMessages] : [welcomeMessage(Date.now())];

    // LLM-03：先建 V2 仓储并迁入旧记忆，再决定界面列表。
    // 迁移幂等，重复启动不会重复；旧摘要无法溯源，删除记忆时整段作废。
    const access = deps.memoryAccess ?? null;
    if (access) {
      // 记忆插件已经建好仓储并负责删除联动；界面订阅它，不另造第二个仓储。
      memoryRepository = access.repository;
      memoryAccess = access;
      unsubscribeInvalidation = access.onInvalidate(() => {
        if (disposed) return;
        summary = null;
        summaryCoversUntil = 0;
        commit();
      });
      // 管理页（FE-11）改完记忆后这一份列表要跟着变：同一份数据两处显示各说各话，
      // 比不做管理页更糟。onInvalidate 只在删除时发，所以订阅的是范围更大的 onChanged。
      unsubscribeMemoryChanged = access.onChanged(() => {
        if (disposed) return;
        void refreshMemories();
      });
      if (savedMemories.length) await memoryRepository.migrateLegacy(savedMemories);
      memories = visibleMemories(await memoryRepository.list());
    } else if (opened.memoryV2) {
      const repository = createMemoryRepository({
        store: opened.memoryV2,
        onInvalidate: async () => {
          await opened.deleteSummaries?.();
          if (disposed) return;
          summary = null;
          summaryCoversUntil = 0;
          commit();
        },
      });
      memoryRepository = repository;
      // 唯一后台 worker：候选批次经它落库；journal 用存储 KV 单记录原子替换。
      maintenance = createMemoryMaintenance({
        repository,
        journal: createStorageMaintenanceJournal(storage),
        ...(deps.maintenanceTurnThreshold !== undefined
          ? { turnThreshold: deps.maintenanceTurnThreshold }
          : {}),
      });
      void maintenance.restore();
      if (savedMemories.length) await repository.migrateLegacy(savedMemories);
      memories = visibleMemories(await repository.list());
    } else {
      memories = [...savedMemories];
    }
    timestamps = [...savedTimestamps];
    summary = savedSummary?.content ?? null;
    summaryCoversUntil = savedSummary?.coversUntil ?? 0;
    if (rawProactive) proactive = { ...DEFAULT_PROACTIVE_SETTINGS, ...JSON.parse(rawProactive) };
    if (rawExtraction) {
      maintenanceEnabled = rawExtraction === "true";
      memoryExtractionEnabled = maintenanceEnabled;
    }
    voiceBackend = {
      backend: (rawBackend as VoiceBackendConfig["backend"]) || DEFAULT_VOICE_BACKEND.backend,
      whisperEndpoint: rawEndpoint || DEFAULT_VOICE_BACKEND.whisperEndpoint,
    };
    if (rawMode) {
      try {
        modeConfig = normalizeModeConfig(JSON.parse(rawMode));
      } catch {
        modeConfig = DEFAULT_MODE_CONFIG;
      }
    }
    ready = true;
    commit();
    syncProactiveTimer();
  }

  function start(): Promise<void> {
    startPromise ??= (async () => {
      try {
        await load();
      } catch (error) {
        if (disposed) return;
        // 打不开存储是必须看得见的故障：静默卡在加载态等于把记忆悄悄丢了。
        storageError = error instanceof Error ? error.message : String(error);
        ready = true;
        commit();
      }
    })();
    return startPromise;
  }

  /**
   * 把界面对齐到存储里的实际结果。
   *
   * kernel 编排下消息由 Runtime 写库，它用的是自己的 id 和时间戳；界面为了即时
   * 反馈先画了一对乐观消息。不对齐的话界面和库里就是两套 id，重开会看到重复的
   * 一轮。落库是权威，界面跟着它走。
   */
  async function resyncMessages(runtimeTurnId: string): Promise<ChatMessage[]> {
    if (!storage) return messages;
    const [rows, savedTimestamps] = await Promise.all([
      storage.listMessages(MESSAGE_WINDOW), storage.listMessageTimestamps(),
    ]);
    if (disposed || kernelTurnId !== runtimeTurnId) return [];
    timestamps = [...savedTimestamps];
    if (!rows.length) {
      const empty = [welcomeMessage(Date.now())];
      setMessages(empty);
      return empty;
    }
    // 开场白从来不落库。直接拿库里的结果覆盖，会让用户发出第一句话的瞬间
    // 问候语凭空消失——重开时它本来就不在，但会话中途消失是另一回事。
    const current = messages;
    const keepWelcome = current[0]?.id === WELCOME_MESSAGE_ID;
    const next = keepWelcome ? [current[0], ...rows] : [...rows];
    setMessages(next);
    return next;
  }

  /** 抽取候选记忆并压缩更早的对话。失败只记录，不打断聊天。 */
  async function runBackgroundMemoryWork(
    allMessages: readonly ChatMessage[],
    /** 这一批记忆是哪一轮喂出来的。Trace 按它归组；主动维护没有轮次时为 null。 */
    runtimeTurnId: string | null = null,
  ): Promise<void> {
    if (!storage || !maintenanceEnabled) return;

    try {
      const recent = allMessages.slice(-4);
      const turns = toCompanionTurns(recent);
      const extracted = await extractor.extract(turns, memories, {
        turnId: runtimeTurnId ?? undefined,
      });
      if (runtimeTurnId) {
        trace.record(runtimeTurnId, { kind: "memory_extract", candidates: extracted.length, failed: false });
      }
      if (!maintenanceEnabled) return;
      if (extracted.length) {
        const repository = memoryRepository;
        if (repository) {
          // 带上来源消息 id：这既是「两份独立证据」的判据，也是删除联动的依据。
          const sourceMessageIds = recent.map((message) => message.id).filter(Boolean);
          const now = Date.now();
          const candidates = extracted.flatMap((record) => {
            const candidate = createMemoryV2({
              content: record.content,
              type: memoryTypeFromCategory(record.category),
              sourceMessageIds,
              sourceKind: "messages",
              status: "candidate",
              now,
            });
            return candidate ? [candidate] : [];
          });
          if (runtimeServices && maintenance) {
            // 批次进队列即返回：落库由唯一 worker 在阈值/显式触发时执行，不挡正文。
            maintenance.enqueue({ turnId: runtimeTurnId ?? "", sourceMessageIds, candidates: extracted });
          } else {
            await repository.upsert(candidates);
          }
          memories = visibleMemories(await repository.list());
          commit();
          // 这一轮抽出来的候选要出现在管理页的待过目里，不必等用户手动刷新。
          memoryAccess?.notifyChanged();
        } else {
          await storage.addMemories(extracted);
          memories = [...memories, ...extracted];
          commit();
        }
      }
    } catch {
      // 抽取失败不影响这一轮对话，下一轮会再试——但必须能被统计到，
      // 不记的话「记忆怎么一条都没有」就永远查不出是抽取一直在失败。
      if (runtimeTurnId) {
        trace.record(runtimeTurnId, { kind: "memory_extract", candidates: 0, failed: true });
      }
    }

    // 成功轮在这里推进后台维护阈值：候选已入队，触发时批次已经在队列里（LLM-04-A）。
    if (runtimeTurnId) maintenance?.noteTurn(runtimeTurnId);

    try {
      if (!maintenanceEnabled) return;
      const olderThanWindow = allMessages.slice(0, Math.max(0, allMessages.length - RAW_TURN_WINDOW));
      const uncovered = olderThanWindow.filter((message) => message.createdAt > summaryCoversUntil);
      if (!shouldSummarize(uncovered.length)) return;

      const transcript = formatTranscript(toCompanionTurns(uncovered.slice(-SUMMARY_INPUT_LIMIT)));
      const content = await extractor.summarize(summary, transcript, {
        turnId: runtimeTurnId ?? undefined,
      });
      if (!content || !maintenanceEnabled) return;

      const coversUntil = uncovered[uncovered.length - 1].createdAt;
      await storage.saveSummary({ content, coversUntil, createdAt: Date.now() });
      summary = content;
      summaryCoversUntil = coversUntil;
      commit();
    } catch {
      // 摘要失败同理：下次消息量再次超阈值时会重试。
    }
  }

  async function buildContext(
    history: readonly ChatMessage[],
    now = Date.now(),
    options: { query?: string; recentFallback?: boolean } = {},
  ) {
    const repository = memoryRepository;
    let memoriesForPrompt: string[];
    if (!repository) {
      // 没有 V2 存储：保持原来的「最近记忆全量注入」。
      memoriesForPrompt = memoryLines(memories);
    } else if (options.query?.trim()) {
      // 有 query 就按检索结果注入；无相关命中就是不注入，不硬扯无关记忆。
      const hits = await repository.retrieve({ text: options.query, now, limit: 8, tokenBudget: 400 });
      memoriesForPrompt = hits.map((hit) => `${MEMORY_TYPE_LABELS[hit.record.type]}：${hit.record.content}`);
    } else {
      // 主动消息没有 query：用最近记忆当「想起对方」的素材。
      memoriesForPrompt = options.recentFallback ? memoryLines(memories) : [];
    }
    return buildCompanionContext({
      messages: history,
      memories: memoriesForPrompt,
      summary,
      timestamps,
      now,
    });
  }

  /**
   * 一轮对话。
   *
   * turn 的生命周期、取消、落库全部由 CompanionRuntime 负责；这里只做三件事——
   * 把用户操作交给 Runtime、把 Runtime 事件映射成界面状态、结算后对齐存储。
   *
   * 语音轮在**生成完成时**就返回，不等交付回执：调用方要拿到回复才去启动播放，
   * 等在这里会直接死锁。交付结算在后台继续。
   */
  async function sendTurn(
    services: RuntimeServices,
    content: string,
    source: MessageSource,
    onPartial?: (partial: PartialReply) => void,
    request?: VoiceTurnRequest,
  ): Promise<CompanionReply | null> {
    if (!content.trim() || !connected() || request?.signal.aborted) return null;
    setSending(true);

    // Runtime 不认识 React，配置从这里同步过去。
    services.settings.set(provider);
    services.settings.setStickers(stickers);

    const askedAt = Date.now();
    const pendingId = uuid();
    const optimisticAsked = userMessage(content, askedAt, request?.turnId);
    const pending: ChatMessage = {
      id: pendingId, role: "assistant", content: "",
      createdAt: askedAt, time: formatClockTime(askedAt), pending: true, turnId: request?.turnId,
    };
    patchMessages((current) => [...current, ...(source === "proactive" ? [] : [optimisticAsked]), pending]);

    let latestPartial: PartialReply = {
      japaneseText: "", chineseTranslation: "", mood: "neutral", japaneseComplete: false,
    };
    let reply: CompanionReply | null = null;
    let failureDetail = "";
    let resolveGenerated!: () => void;
    const generated = new Promise<void>((resolve) => {
      resolveGenerated = resolve;
    });

    const handle = services.runtime.submit({
      text: content, source, mode: modeConfig, voiceTurnId: request?.turnId,
    });
    kernelTurnId = handle.turnId;
    commit();

    const patchPending = (partial: PartialReply) => {
      latestPartial = partial;
      patchMessages((current) => current.map((message) => (
        message.id === pendingId
          ? {
              ...message,
              content: partial.japaneseText,
              japaneseText: partial.japaneseText,
              chineseTranslation: partial.chineseTranslation,
              mood: partial.mood,
            }
          : message
      )));
      onPartial?.(partial);
    };

    const unsubscribe = services.runtime.subscribe((event) => {
      // 旧轮的迟到事件不许覆盖新消息。
      if (event.turnId !== handle.turnId) return;
      if (kernelTurnId !== handle.turnId) return;
      if (event.type === "replyDelta") {
        patchPending({ ...latestPartial, japaneseText: event.cumulative, japaneseComplete: false });
        return;
      }
      if (event.type === "generated") {
        reply = toCompanionReply(event.reply);
        patchPending({
          japaneseText: reply.japaneseText,
          chineseTranslation: reply.chineseTranslation ?? "",
          mood: reply.mood ?? "neutral",
          japaneseComplete: true,
        });
        resolveGenerated();
        return;
      }
      if (event.type === "error") {
        failureDetail = event.message || event.code;
      }
    });

    const onAbort = () => services.runtime.cancel(handle.turnId);
    request?.signal.addEventListener("abort", onAbort, { once: true });
    if (request) {
      // 播放进度由 TTS 侧给，Runtime 据此决定这轮算 complete 还是 interrupted。
      //
      // precision 用 confirmed 而不是 proxy：onPlaybackComplete 对应的是播放队列
      // 的 drained——「交给它的文本全念完了」是确证的，不是估算。
      // TTS 侧记 trace 要用 Runtime 的轮次 uuid（request.turnId 是语音回合号）。
      request.runtimeTurnId = handle.turnId;
      request.onPlaybackComplete = () => services.runtime.reportDelivery({
        turnId: handle.turnId, status: "complete", precision: "confirmed",
      });
      request.onPlaybackFailed = () => services.runtime.reportDelivery({
        turnId: handle.turnId, status: "failed", precision: "unknown",
      });
    }

    /** 结算之后把界面对齐到库里的实际结果，并按需要跑后台记忆工作。 */
    const finish = async (settlement: Awaited<typeof handle.done>) => {
      unsubscribe();
      request?.signal.removeEventListener("abort", onAbort);
      if (disposed) return;

      if (settlement.state === "failed" || !settlement.persisted) {
        failureDetail ||= settlement.errorCode || "STORAGE_FAILED";
        // Runtime 只负责把这轮判失败，它不写「发不出去」这种界面消息。
        const failedAt = Date.now();
        const failure: ChatMessage = {
          id: pendingId, role: "assistant",
          content: `这次没有发出去：${failureDetail || settlement.errorCode || "STORAGE_FAILED"}`,
          turnId: request?.turnId, runtimeTurnId: handle.turnId,
          createdAt: failedAt, time: formatClockTime(failedAt), error: true,
        };
        patchMessages((current) => replacePendingMessage(current, pendingId, failure));
        try {
          await persist(failure);
        } catch (error) {
          setStorageError(error instanceof Error ? error.message : String(error));
          return;
        }
      }

      // 旧轮结算不能用存储快照覆盖新轮的乐观消息与流式气泡。
      if (kernelTurnId !== handle.turnId) return;
      const rows = await resyncMessages(handle.turnId);
      if (settlement.state === "completed" && settlement.persisted
        && rows.some((row) => row.runtimeTurnId === handle.turnId
          && row.role === "assistant" && row.completion !== "interrupted")) {
        void runBackgroundMemoryWork(rows, handle.turnId);
      }
    };

    try {
      if (request) {
        // 语音：生成完就把控制权交回去，交付结算在后台继续。
        await Promise.race([generated, handle.done]);
        void handle.done.then(finish).catch((error) => {
          setStorageError(error instanceof Error ? error.message : String(error));
          patchMessages((current) => current.filter((message) => message.id !== pendingId));
        });
      } else {
        await finish(await handle.done);
      }
      return failureDetail ? null : reply;
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
      patchMessages((current) => current.filter((message) => message.id !== pendingId));
      return null;
    } finally {
      // kernelTurnId 保留为「最近一轮的 Runtime turn」：结算回调要拿它判定
      // 是否已被新轮取代，过早清空会让本轮的对齐与后台维护静默丢失。
      if (kernelTurnId === handle.turnId) setSending(false);
    }
  }

  /**
   * 编排入口。
   *
   * 全仓只有这一条路径：Runtime 由展示插件从注册表注入。没有 Runtime 时说明宿主
   * 装配不完整（或装配失败走了兜底 Presenter），此时不发请求，也不退回第二套编排。
   */
  async function send(
    content: string,
    source: MessageSource = "text",
    onPartial?: (partial: PartialReply) => void,
    request?: VoiceTurnRequest,
  ): Promise<CompanionReply | null> {
    if (!runtimeServices) return null;
    return sendTurn(runtimeServices, content, source, onPartial, request);
  }

  /**
   * 从存储和界面上删掉这些消息。
   *
   * 顺序是「先删再投／先删再遗忘」，不能反过来：Runtime 每轮新建 id 重新持久化
   * 用户消息，先投后删就有一个窗口里库里存在两条相同的用户消息，而删除的是哪一条
   * 也说不清。删失败就把这一轮留在原处，界面和库不许对不上。
   */
  async function dropMessages(ids: readonly string[]): Promise<boolean> {
    try {
      await storage?.deleteMessages(ids);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
      return false;
    }
    const doomed = new Set(ids);
    patchMessages((current) => current.filter((message) => !doomed.has(message.id)));
    return true;
  }

  /**
   * 重跑一轮：先整轮删掉，再用同一句原话重投。
   *
   * 重试与重新生成走的是同一条路径，区别只在谁有资格进来（domain 的两个判定）。
   */
  async function resubmitTurn(turn: MessageTurn | null): Promise<CompanionReply | null> {
    if (sending || !turn) return null;
    if (!await dropMessages(turn.ids)) return null;
    return send(turn.text, turn.source);
  }

  async function retry(messageId: string): Promise<CompanionReply | null> {
    return resubmitTurn(retryableTurn(messages, messageId));
  }

  async function regenerate(messageId: string): Promise<CompanionReply | null> {
    return resubmitTurn(regeneratableTurn(messages, messageId));
  }

  /**
   * 撤回这一轮。
   *
   * 开场白不可撤回：它从来不落库，删它只是让问候语在这次会话里凭空消失。
   *
   * 删完要自己刷新 timestamps——关系状态是按它现算的，而撤回后面没有新的一轮
   * 来顺带对齐存储（重投有，所以那条路径不需要）。
   */
  async function withdraw(messageId: string): Promise<void> {
    if (sending) return;
    const turn = messageTurn(messages, messageId);
    if (!turn || turn.ids.includes(WELCOME_MESSAGE_ID)) return;
    if (!await dropMessages(turn.ids)) return;
    await refreshTimestamps();
    await forgetCandidatesFrom(turn.ids);
    commit();
  }

  /**
   * 关系状态按 timestamps 现算，删完必须自己刷新。
   * 重投路径不需要：后面那一轮结算时会顺带对齐存储。
   */
  async function refreshTimestamps(): Promise<void> {
    try {
      if (storage) timestamps = [...await storage.listMessageTimestamps()];
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 回到这一条：截断它之后的全部消息。
   *
   * 界面侧会先要一次确认（删的量可能很大且不可撤销），所以这里不再问，直接执行。
   */
  async function rewind(messageId: string): Promise<void> {
    if (sending) return;
    const plan = rewindPlan(messages, messageId);
    if (!plan) return;
    if (!await dropMessages(plan.ids)) return;
    await refreshTimestamps();
    await forgetCandidatesFrom(plan.ids);
    await markSummaryGap(plan.anchorAt);
    commit();
  }

  /**
   * 回退之后给摘要标一个 gap，而不是回滚它。
   *
   * 摘要没有可用的消息溯源（只记了 coversUntil），没法只摘掉其中一句；整段作废
   * 又会让每次回退都触发一次重新压缩。所以留着它，但标明这段历史被回退过——
   * 否则她会把摘要里已经不存在的事当成真发生过。
   *
   * 回退点不比摘要覆盖范围早时什么都不做：那些被摘要覆盖的消息一条都没删。
   *
   * 先 deleteSummaries 再存：sqlite 侧的 latestSummary 按 covers_until 排序取一条，
   * 同 coversUntil 追加一行的话拿回来的可能还是旧那条。
   */
  async function markSummaryGap(anchorAt: number): Promise<void> {
    if (!storage || !summary || anchorAt >= summaryCoversUntil) return;
    if (summary.includes(REWIND_GAP_NOTE)) return;
    const content = `${summary}\n${REWIND_GAP_NOTE}`;
    try {
      await storage.deleteSummaries?.();
      await storage.saveSummary({ content, coversUntil: summaryCoversUntil, createdAt: Date.now() });
      summary = content;
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 撤回连带遗忘：来源与被撤回消息有交集、且用户还没确认过的候选。
   *
   * 只删 `candidate` 是刻意的。抽取输入是最近 4 条消息（见 runBackgroundMemoryWork），
   * 一条记忆的来源常常跨两轮，所以「来源有交集」是个宽判据；用它无差别删除会牵连
   * 别的轮次。用户确认过的记忆是他明确说过要留的，不能因为一次撤回悄悄消失。
   *
   * V1 记忆路径没有来源字段，溯源不了，就什么都不做——不假装联动。
   */
  async function forgetCandidatesFrom(ids: readonly string[]): Promise<void> {
    const repository = memoryRepository;
    if (!repository) return;
    const doomed = new Set(ids);
    try {
      const linked = (await repository.list()).filter((record) => (
        record.status === "candidate" && record.sourceMessageIds.some((id) => doomed.has(id))
      ));
      if (!linked.length) return;
      for (const record of linked) await repository.forget(record.id);
      memories = visibleMemories(await repository.list());
    } catch (error) {
      // 记忆联动失败不能把已经删掉的消息变回来；如实报出去，消息侧保持已撤回。
      setStorageError(error instanceof Error ? error.message : String(error));
    }
  }

  /** 主动消息。频率闸门与理由选择都在 domain/proactive.ts，这里只负责跑一次。 */
  async function runProactiveTick(): Promise<void> {
    if (!runtimeServices || !storage || !ready || !connected() || !proactive.enabled || sending) return;

    const now = Date.now();
    const lastMessageAt = timestamps.length ? timestamps[timestamps.length - 1] : null;
    const messagesToday = await storage.countProactiveSince(startOfToday(now));
    const allowed = canSend({
      nowMillis: now,
      hour: new Date(now).getHours(),
      quietStartHour: proactive.quietStartHour,
      quietEndHour: proactive.quietEndHour,
      messagesToday,
      lastMessageAt,
      enabled: proactive.enabled,
    });
    if (!allowed) return;

    try {
      const context = await buildContext(messages, now, { recentFallback: true });
      const lastUserAt = [...messages].reverse().find((message) => message.role === "user")?.createdAt ?? null;
      const reason = chooseProactiveReason({
        recentTurns: context.recentTurns,
        memories: context.memories,
        now: new Date(now),
        hoursSinceLastUserMessage: lastUserAt === null ? null : (now - lastUserAt) / 3_600_000,
        lastReasonKind: (await storage.getSetting(SETTING_KEYS.proactiveLastReason)) as ProactiveReasonKind | null,
      });

      const reply = await sendTurn(runtimeServices, buildProactiveInput(context, reason), "proactive");
      if (!reply) return;

      const message = companionMessage(reply, Date.now(), uuid(), "proactive");
      await storage.setSetting(SETTING_KEYS.proactiveLastReason, reason.kind);
      await storage.setSetting(SETTING_KEYS.proactiveLastSentAt, String(message.createdAt));
      await notifier.notify({ title: DEFAULT_CHARACTER.name, body: reply.japaneseText || reply.chineseTranslation });
    } catch {
      // 主动消息发不出去就安静地跳过：不要用错误提示打扰用户。
    }
  }

  async function setProvider(next: ProviderConfig): Promise<void> {
    provider = next;
    commit();
    if (storage) await saveProvider(storage, next);
  }

  async function setProactive(next: ProactiveSettings): Promise<void> {
    proactive = next;
    commit();
    await storage?.setSetting(SETTING_KEYS.proactive, JSON.stringify(next));
    syncProactiveTimer();
  }

  async function setMemoryExtractionEnabled(enabled: boolean): Promise<void> {
    maintenanceEnabled = enabled;
    memoryExtractionEnabled = enabled;
    // 关闭即作废旧批次并停止排程；重新开启不自动复活（epoch 语义在队列内）。
    maintenance?.setEnabled(enabled);
    commit();
    await storage?.setSetting(SETTING_KEYS.memoryExtraction, String(enabled));
  }

  async function setVoiceBackend(next: VoiceBackendConfig): Promise<void> {
    voiceBackend = next;
    commit();
    await storage?.setSetting(SETTING_KEYS.voiceBackend, next.backend);
    await storage?.setSetting(SETTING_KEYS.whisperEndpoint, next.whisperEndpoint);
  }

  async function setVoiceOutput(next: VoiceOutputConfig): Promise<void> {
    if (!voiceOutputSettings) {
      const failure = new Error("语音输出设置不可用：本机没有配置存储");
      voiceOutputErrors.add(failure.message);
      setStorageError(appendVisibleError(storageError, failure.message));
      throw failure;
    }
    try {
      // 持久化成功才切内存与引擎；失败保留原配置（错误可见，不悄悄回滚）。
      await voiceOutputSettings.save(next);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failure = new Error(`语音输出设置保存失败：${detail}`);
      voiceOutputErrors.add(failure.message);
      setStorageError(appendVisibleError(storageError, failure.message));
      throw failure;
    }
    for (const previous of [...voiceOutputErrors]) {
      voiceOutputErrors.delete(previous);
      setStorageError(removeVisibleError(storageError, previous));
    }
    voiceOutput = next;
    deps.applyVoiceOutput?.(next);
    commit();
  }

  /** 显式删除已保存的云端 TTS Key；空 Key 的保存语义是"保持"，删除必须走这里。 */
  async function removeVoiceApiKey(): Promise<void> {
    if (!voiceOutputSettings) {
      const failure = new Error("语音输出设置不可用：本机没有配置存储");
      throw failure;
    }
    await voiceOutputSettings.removeApiKey();
    if (voiceOutput) voiceOutput = { ...voiceOutput, apiKey: "" };
    commit();
  }

  async function setModeConfig(next: ModeConfig): Promise<void> {
    const normalized = normalizeModeConfig(next);
    if (!storage) {
      const failure = new Error("模式设置保存失败：本地存储尚未准备好");
      modeSaveErrors.add(failure.message);
      setStorageError(appendVisibleError(storageError, failure.message));
      throw failure;
    }
    try {
      // 只有持久化成功后才确认新的内存状态；失败时保留原配置，
      // 避免界面看起来已经切换但重载后悄悄回滚。
      await storage.setSetting(SETTING_KEYS.mode, JSON.stringify(normalized));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failure = new Error(`模式设置保存失败：${detail}`);
      modeSaveErrors.add(failure.message);
      setStorageError(appendVisibleError(storageError, failure.message));
      throw failure;
    }
    if (modeSaveErrors.size) {
      const errors = modeSaveErrors;
      modeSaveErrors = new Set<string>();
      let next = storageError;
      for (const modeSaveError of errors) next = removeVisibleError(next, modeSaveError);
      setStorageError(next);
    }
    modeConfig = normalized;
    commit();
  }

  async function exitScenario(): Promise<void> {
    await setModeConfig(exitScenarioMode(modeConfig));
  }

  /** 从仓储重读界面列表。没有仓储（V1 路径）时什么都不做。 */
  async function refreshMemories(): Promise<void> {
    const repository = memoryRepository;
    if (!repository) return;
    try {
      memories = visibleMemories(await repository.list());
      commit();
    } catch {
      // 重读失败不该让对话页报错：列表保持上一次的样子，下一次改动再试。
    }
  }

  async function confirmMemory(id: string): Promise<void> {
    const repository = memoryRepository;
    if (repository) {
      const record = (await repository.list()).find((item) => item.id === id);
      if (record) {
        // 确认是用户的动作，不是抽取的结果：这里写 confirmed 并记下确认时间。
        await repository.upsert([{ ...record, status: "confirmed", lastConfirmedAt: Date.now() }]);
        memories = visibleMemories(await repository.list());
        commit();
        // 管理页要看到这条已经确认过了。
        memoryAccess?.notifyChanged();
        return;
      }
    }
    await storage?.setMemoryStatus(id, "confirmed");
    memories = memories.map((memory) => (
      memory.id === id ? { ...memory, status: "confirmed", updatedAt: Date.now() } : memory
    ));
    commit();
  }

  async function deleteMemory(id: string): Promise<void> {
    const repository = memoryRepository;
    if (repository) {
      // forget 会落下抑制标记并触发摘要失效；被删的来源之后不会让记忆复活。
      await repository.forget(id);
      memories = visibleMemories(await repository.list());
      commit();
      // 这里不喊 notifyChanged：forget 已经经 onInvalidate 扇出到 changed 订阅者了。
      return;
    }
    await storage?.deleteMemory(id);
    memories = memories.filter((memory) => memory.id !== id);
    commit();
  }

  function getSnapshot(): CompanionViewModel {
    if (!cached || dirty) {
      cached = Object.freeze({
        ready,
        activeTurnId: sending ? kernelTurnId : null,
        busy: sending,
        messages,
        mode: modeConfig,
        error: storageError || null,
        storageError,
        storageKind,
        keyIsSecure,
        connected: connected(),
        sending,
        provider,
        memories,
        memoryExtractionEnabled,
        proactive,
        voiceBackend,
        voiceOutput: voiceOutput ? {
          output: voiceOutput.output,
          baseUrl: voiceOutput.baseUrl,
          model: voiceOutput.model,
          voice: voiceOutput.voice,
          speed: voiceOutput.speed,
          hasApiKey: Boolean(voiceOutput.apiKey),
        } : null,
        stickers,
        relationship: computeRelationship(deriveRelationshipSignals(timestamps)),
        summary,
      });
      dirty = false;
    }
    return cached;
  }

  return {
    start,
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send,
    cancel() {
      if (runtimeServices && kernelTurnId) runtimeServices.runtime.cancel(kernelTurnId);
    },
    retry,
    regenerate,
    withdraw,
    rewind,
    setProvider,
    setProactive,
    setMemoryExtractionEnabled,
    setVoiceBackend,
    setVoiceOutput,
    removeVoiceApiKey,
    setModeConfig,
    exitScenario,
    confirmMemory,
    deleteMemory,
    dispose() {
      if (disposed) return;
      disposed = true;
      maintenance?.dispose();
      maintenance = null;
      if (proactiveTimer !== null) {
        interval.clear(proactiveTimer);
        proactiveTimer = null;
      }
      unsubscribeInvalidation?.();
      unsubscribeInvalidation = null;
      unsubscribeMemoryChanged?.();
      unsubscribeMemoryChanged = null;
      listeners = new Set();
      // 迟到事件不再更新快照：disposed 让 commit() 变成 no-op。
    },
  };
}

