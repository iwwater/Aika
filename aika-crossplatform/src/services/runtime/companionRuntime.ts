/**
 * CompanionRuntime：与 React、麦克风、TTS 都无关的会话编排层。
 *
 * 一轮对话在这里只有一条路：assembling → generating → completed（文字）或
 * awaitingDelivery → 收到交付回执才结算（语音）。所有异步边界——网络增量、
 * 存储写入、播放回执——都可能晚到，所以每一处都用 turn revision 判断
 * 「这还是不是当前这一轮」，晚到的旧轮结果一律作废。
 *
 * 两件不能含糊的事：
 * 1. 生成完成与落库成功是两个事件：只有写进存储（并按交付回执确定播放范围）
 *    才算是完整历史，中断的片段必须标 interrupted，不能混在完整历史里。
 * 2. 播放范围拿不到就写 unknown，绝不把「生成完」当成「用户听完了」。
 */

import { toCompanionReply, type ReplyEnvelopeV1 } from "../../domain/companion";
import { companionMessage, formatClockTime, type ChatMessage } from "../../domain/conversation";
import {
  normalizeHistoryMessages,
  type AgentContext, type ContextAssemblyResult, type ContextBudget, type DroppedSource,
} from "../../domain/context";
import { normalizeMood, type Mood } from "../../domain/mood";
import { computeRelationship, deriveRelationshipSignals } from "../../domain/relationship";
import { DEFAULT_CHARACTER_SOUL, DEFAULT_MODE_CONFIG, type CharacterSoul, type ModeConfig, type UserSoul } from "../../domain/soul";
import type { SessionSummary } from "../../domain/summary";
import type { PlaybackStatus } from "../../domain/voiceRuntime";
import {
  createContextAssembler, ContextTooLargeError,
  type ContextAssembler, type ContextSource, type TimerPort,
} from "../context/contextAssembler";

export type TurnState =
  | "assembling"
  | "generating"
  | "awaitingDelivery"
  | "completed"
  | "cancelled"
  | "failed";

export type TurnSource = "text" | "voice" | "proactive";

export interface SubmitRequest {
  text: string;
  source: TurnSource;
  mode: ModeConfig;
}

export interface TurnSettlement {
  state: "completed" | "cancelled" | "failed";
  /** 这一轮产生的消息是否都写进了存储。 */
  persisted: boolean;
  errorCode?: string;
}

export interface TurnHandle {
  turnId: string;
  done: Promise<TurnSettlement>;
}

export interface DeliveryReceipt {
  turnId: string;
  status: "complete" | "interrupted" | "failed";
  deliveredText?: string;
  precision: "confirmed" | "proxy" | "unknown";
}

export type ProviderStreamEvent =
  | { type: "delta"; text: string; translation?: string; mood?: Mood }
  | { type: "reply"; reply: ReplyEnvelopeV1 }
  | { type: "error"; code: string; retryable: boolean; message?: string };

export interface RuntimeGenerateInput {
  turnId: string;
  context: AgentContext;
  mode: ModeConfig;
  signal: AbortSignal;
}

/**
 * Provider 端口。返回 AsyncIterable 的解析事件：Runtime 才能在取消时
 * 通过 for-await 的 return() 真正关掉底层流，而不是让它在后台继续烧 token。
 */
export interface RuntimeProvider {
  generate(input: RuntimeGenerateInput): AsyncIterable<ProviderStreamEvent>;
}

/** 只取 Runtime 真正用到的存储能力，便于注入 fake。 */
export interface RuntimeStorage {
  listMessages(limit: number): Promise<ChatMessage[]>;
  appendMessage(message: ChatMessage): Promise<void>;
  listMessageTimestamps(): Promise<number[]>;
  latestSummary(): Promise<SessionSummary | null>;
}

export interface RuntimeClock {
  now(): number;
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

export type RuntimeEvent =
  | { turnId: string; seq: number; type: "state"; state: TurnState }
  | { turnId: string; seq: number; type: "replyDelta"; text: string; cumulative: string }
  | { turnId: string; seq: number; type: "generated"; reply: ReplyEnvelopeV1 }
  | { turnId: string; seq: number; type: "settled"; state: TurnSettlement["state"]; persisted: boolean; errorCode?: string }
  | { turnId: string; seq: number; type: "error"; code: string; retryable: boolean; message?: string };

/** 一轮的降级 trace：来源为什么没进上下文，只在日志/报告里出现，不进正文。 */
export interface TurnTrace {
  turnId: string;
  droppedSources: DroppedSource[];
  estimatedTokens: number;
  historyDropped: number;
  historyRepaired: number;
}

export interface CompanionRuntime {
  submit(request: SubmitRequest): TurnHandle;
  cancel(turnId: string): void;
  reportDelivery(receipt: DeliveryReceipt): void;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  dispose(): void;
}

export interface CompanionRuntimeOptions {
  provider: RuntimeProvider;
  storage: RuntimeStorage;
  assembler?: ContextAssembler;
  sources?: readonly ContextSource[];
  budget?: Partial<ContextBudget>;
  clock?: RuntimeClock;
  timers?: TimerPort;
  characterSoul?: CharacterSoul;
  userSoul?: UserSoul | null;
  timeZone?: string;
  /** 读进上下文的最近消息条数上限。 */
  historyLimit?: number;
  /** 语音交付等待上限：无进度到此就失败，不无限占着 busy。 */
  deliveryTimeoutMs?: number;
  idFactory?: () => string;
  onTrace?: (trace: TurnTrace) => void;
}

export const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;

interface Turn {
  id: string;
  /** 每次 submit 递增：晚到的旧轮回调靠它作废。 */
  revision: number;
  source: TurnSource;
  mode: ModeConfig;
  query: string;
  state: TurnState;
  seq: number;
  controller: AbortController;
  settled: boolean;
  cancelled: boolean;
  persistFailed: boolean;
  fragmentPersisted: boolean;
  draftText: string;
  translation: string;
  mood: Mood;
  reply: ReplyEnvelopeV1 | null;
  assistantId: string | null;
  deliveryTimer: unknown;
  resolve: (settlement: TurnSettlement) => void;
  done: Promise<TurnSettlement>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function defaultIdFactory(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 只有 delta 没有终包时，用累计正文兜一个 envelope，字段仍走 LLM-01 的协议。 */
function envelopeFromDraft(turn: Turn): ReplyEnvelopeV1 {
  return {
    schemaVersion: 1,
    mood: turn.mood,
    replyText: turn.draftText,
    translation: turn.translation,
    memoryCandidates: [],
    actions: [],
  };
}

function assistantMessage(
  turn: Turn,
  reply: ReplyEnvelopeV1,
  createdAt: number,
  completion: "complete" | "interrupted",
  playbackStatus?: PlaybackStatus,
): ChatMessage {
  const base = companionMessage(
    toCompanionReply(reply),
    createdAt,
    turn.assistantId ?? (turn.assistantId = defaultIdFactory()),
    turn.source,
  );
  return {
    ...base,
    completion,
    ...(playbackStatus ? { playbackStatus } : {}),
  };
}

export function createCompanionRuntime(options: CompanionRuntimeOptions): CompanionRuntime {
  const clock = options.clock ?? { now: () => Date.now() };
  const timers = options.timers ?? {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const idFactory = options.idFactory ?? defaultIdFactory;
  const timeZone = options.timeZone ?? defaultTimeZone();
  const characterSoul = options.characterSoul ?? DEFAULT_CHARACTER_SOUL;
  const historyLimit = options.historyLimit ?? 200;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  const assembler = options.assembler
    ?? createContextAssembler({
      sources: options.sources,
      budget: options.budget,
      timers,
    });

  const listeners = new Set<(event: RuntimeEvent) => void>();
  const turns = new Map<string, Turn>();
  const userSoul = options.userSoul ?? null;

  let revision = 0;
  let active: Turn | null = null;
  let disposed = false;
  /** 所有轮次共享的写入队列：取消与生成完成竞争时，落库顺序仍与提交顺序一致。 */
  let writeChain: Promise<void> = Promise.resolve();

  function emit(turn: Turn, event: DistributiveOmit<RuntimeEvent, "turnId" | "seq">): void {
    turn.seq += 1;
    const full = { ...event, turnId: turn.id, seq: turn.seq } as RuntimeEvent;
    for (const listener of [...listeners]) {
      try {
        listener(full);
      } catch {
        // 一个订阅者抛错不能影响其它订阅者，更不能拖垮这一轮。
      }
    }
  }

  function setState(turn: Turn, state: TurnState): void {
    if (turn.state === state) return;
    turn.state = state;
    emit(turn, { type: "state", state });
  }

  /** 轮次起始状态必须发一次事件：订阅者要从 assembling 起算，不能跳过。 */
  function announceState(turn: Turn, state: TurnState): void {
    turn.state = state;
    emit(turn, { type: "state", state });
  }

  function clearDeliveryTimer(turn: Turn): void {
    if (turn.deliveryTimer === null) return;
    timers.clearTimeout(turn.deliveryTimer);
    turn.deliveryTimer = null;
  }

  function settle(turn: Turn, state: TurnSettlement["state"], errorCode?: string): void {
    if (turn.settled) return;
    turn.settled = true;
    clearDeliveryTimer(turn);
    setState(turn, state);
    const settlement: TurnSettlement = {
      state,
      persisted: !turn.persistFailed,
      ...(errorCode ? { errorCode } : {}),
    };
    emit(turn, {
      type: "settled",
      state,
      persisted: settlement.persisted,
      ...(errorCode ? { errorCode } : {}),
    });
    if (active === turn) active = null;
    // 终态之后不再接受交付回执：迟到的回执不许改写已经结算的结果。
    turns.delete(turn.id);
    turn.resolve(settlement);
  }

  function fail(turn: Turn, code: string, retryable: boolean, message?: string): void {
    emit(turn, { type: "error", code, retryable, ...(message ? { message } : {}) });
    settle(turn, "failed", code);
  }

  /**
   * 串行落库。写入是异步的，所以调用点必须在 await 之后重新验证轮次是否还有效，
   * 而不是只在发起前检查一次。
   */
  function persist(turn: Turn, message: ChatMessage): Promise<void> {
    const operation = writeChain.then(
      async () => {
        await options.storage.appendMessage(message);
        return true;
      },
      () => false,
    ).then((ok) => ok, () => false);
    writeChain = operation.then(() => undefined);
    return operation.then((ok) => {
      if (!ok) turn.persistFailed = true;
    });
  }

  function isStale(turn: Turn): boolean {
    return disposed || turn.settled || turn.revision !== revision;
  }

  async function persistFragment(turn: Turn): Promise<void> {
    if (turn.fragmentPersisted) return;
    const content = turn.draftText.trim();
    if (!content) {
      turn.fragmentPersisted = true;
      return;
    }
    turn.fragmentPersisted = true;
    const message = assistantMessage(
      turn,
      turn.reply ?? envelopeFromDraft(turn),
      clock.now(),
      // 中断片段永远不能写成完整历史，播放范围也只能是 unknown。
      "interrupted",
      "unknown",
    );
    await persist(turn, message);
  }

  async function finishAsInterrupted(turn: Turn): Promise<void> {
    await persistFragment(turn);
    settle(turn, "cancelled");
  }

  async function cancelTurn(turn: Turn): Promise<void> {
    if (turn.settled) return;
    turn.cancelled = true;
    turn.controller.abort();
    await finishAsInterrupted(turn);
  }

  function createTurn(query: string, source: TurnSource, mode: ModeConfig): Turn {
    const controller = new AbortController();
    let resolve!: (settlement: TurnSettlement) => void;
    const done = new Promise<TurnSettlement>((settlePromise) => {
      resolve = settlePromise;
    });
    return {
      id: idFactory(),
      revision: 0,
      source,
      mode,
      query,
      state: "assembling",
      seq: 0,
      controller,
      settled: false,
      cancelled: false,
      persistFailed: false,
      fragmentPersisted: false,
      draftText: "",
      translation: "",
      mood: normalizeMood(null),
      reply: null,
      assistantId: null,
      deliveryTimer: null,
      resolve,
      done,
    };
  }

  function armDeliveryTimer(turn: Turn): void {
    clearDeliveryTimer(turn);
    turn.deliveryTimer = timers.setTimeout(() => {
      turn.deliveryTimer = null;
      if (turn.settled || !turn.reply) return;
      void persist(turn, assistantMessage(turn, turn.reply, clock.now(), "interrupted", "unknown"))
        .then(() => settle(turn, "failed", "DELIVERY_TIMEOUT"));
    }, deliveryTimeoutMs);
  }

  async function persistFinal(
    turn: Turn,
    reply: ReplyEnvelopeV1,
    completion: "complete" | "interrupted",
    playbackStatus?: PlaybackStatus,
  ): Promise<void> {
    turn.fragmentPersisted = true;
    await persist(turn, assistantMessage(turn, reply, clock.now(), completion, playbackStatus));
  }

  function emitTrace(turn: Turn, assembled: ContextAssemblyResult, history: { droppedCount: number; repairedCount: number }): void {
    options.onTrace?.({
      turnId: turn.id,
      droppedSources: assembled.droppedSources,
      estimatedTokens: assembled.estimatedTokens,
      historyDropped: history.droppedCount,
      historyRepaired: history.repairedCount,
    });
  }

  async function run(turn: Turn): Promise<void> {
    const startedAt = clock.now();
    const asked: ChatMessage = {
      id: idFactory(),
      role: "user",
      content: turn.query,
      createdAt: startedAt,
      time: formatClockTime(startedAt),
      source: turn.source,
    };

    let history: ChatMessage[];
    let timestamps: number[];
    try {
      [history, timestamps] = await Promise.all([
        options.storage.listMessages(historyLimit),
        options.storage.listMessageTimestamps(),
      ]);
    } catch (error) {
      fail(turn, "STORAGE_FAILED", true, messageOf(error));
      return;
    }
    if (isStale(turn)) return;

    // 旧消息缺 id/createdAt 时补齐而不是丢弃：迁移不该让老用户失忆。
    const normalized = normalizeHistoryMessages(history, { now: startedAt });
    if (isStale(turn)) return;

    let summary: string | null = null;
    try {
      summary = (await options.storage.latestSummary())?.content ?? null;
    } catch {
      summary = null;
    }
    if (isStale(turn)) return;

    const signalSource = timestamps.length ? timestamps : normalized.messages.map((message) => message.createdAt);
    let assembled: ContextAssemblyResult;
    try {
      assembled = await assembler.assemble({
        query: turn.query,
        now: startedAt,
        timeZone,
        characterSoul,
        userSoul,
        relationship: computeRelationship(deriveRelationshipSignals(signalSource, startedAt)),
        mode: turn.mode,
        history: normalized.messages,
        summary,
        signal: turn.controller.signal,
      });
    } catch (error) {
      if (error instanceof ContextTooLargeError) {
        fail(turn, error.code, false, error.message);
        return;
      }
      fail(turn, "CONTEXT_FAILED", true, messageOf(error));
      return;
    }
    if (isStale(turn)) return;
    emitTrace(turn, assembled, normalized);

    // 用户说过的话先落库：后面生成失败，这一句也不该丢。
    await persist(turn, asked);
    if (isStale(turn)) return;

    setState(turn, "generating");

    let failure: { code: string; retryable: boolean; message?: string } | null = null;
    try {
      for await (const event of options.provider.generate({
        turnId: turn.id,
        context: assembled.context,
        mode: turn.mode,
        signal: turn.controller.signal,
      })) {
        // 每一片都要重新问一次：这一片还是不是当前这一轮的。
        if (isStale(turn) || turn.controller.signal.aborted) {
          await finishAsInterrupted(turn);
          return;
        }
        if (event.type === "delta") {
          const cumulative = event.text ?? "";
          const delta = cumulative.startsWith(turn.draftText)
            ? cumulative.slice(turn.draftText.length)
            : cumulative;
          turn.draftText = cumulative;
          if (event.translation !== undefined) turn.translation = event.translation;
          if (event.mood !== undefined) turn.mood = normalizeMood(event.mood);
          if (delta) emit(turn, { type: "replyDelta", text: delta, cumulative });
          continue;
        }
        if (event.type === "reply") {
          turn.reply = event.reply;
          turn.draftText = event.reply.replyText || turn.draftText;
          turn.translation = event.reply.translation || turn.translation;
          turn.mood = normalizeMood(event.reply.mood);
          continue;
        }
        failure = { code: event.code, retryable: event.retryable, ...(event.message ? { message: event.message } : {}) };
        emit(turn, { type: "error", code: event.code, retryable: event.retryable, ...(event.message ? { message: event.message } : {}) });
        break;
      }
    } catch (error) {
      if (turn.cancelled || turn.controller.signal.aborted || isAbortError(error)) {
        await finishAsInterrupted(turn);
        return;
      }
      failure = { code: "PROVIDER_FAILED", retryable: true, message: messageOf(error) };
      emit(turn, { type: "error", code: "PROVIDER_FAILED", retryable: true, message: messageOf(error) });
    }

    if (isStale(turn) || turn.controller.signal.aborted) {
      await finishAsInterrupted(turn);
      return;
    }
    if (failure) {
      settle(turn, "failed", failure.code);
      return;
    }

    const reply = turn.reply ?? envelopeFromDraft(turn);
    if (!(reply.replyText || reply.translation)) {
      fail(turn, "EMPTY_REPLY", true, "模型没有返回可显示的正文");
      return;
    }
    turn.reply = reply;
    emit(turn, { type: "generated", reply });

    if (turn.source === "voice") {
      // 语音：生成完不等于用户听完，等 TTS 的交付回执（或超时）才结算。
      setState(turn, "awaitingDelivery");
      armDeliveryTimer(turn);
      return;
    }

    await persistFinal(turn, reply, "complete");
    if (isStale(turn)) return;
    settle(turn, "completed");
  }

  function rejected(code: string, retryable: boolean, message: string): TurnHandle {
    const turn = createTurn("", "text", DEFAULT_MODE_CONFIG);
    turn.settled = true;
    turn.state = "failed";
    emit(turn, { type: "error", code, retryable, message });
    emit(turn, { type: "settled", state: "failed", persisted: false, errorCode: code });
    turn.resolve({ state: "failed", persisted: false, errorCode: code });
    // 输入错误不建立半活跃轮：它不进 active，也不进 turns。
    return { turnId: turn.id, done: turn.done };
  }

  return {
    submit(request: SubmitRequest): TurnHandle {
      const text = (request.text ?? "").trim();
      if (disposed) return rejected("DISPOSED", false, "Runtime 已释放，不再接受新的轮次");
      if (!text) return rejected("EMPTY_INPUT", false, "空输入不会建立新的轮次");

      // 单会话最多一个活动轮：新的一句先把旧的取消掉，再生成新的 turnId。
      if (active && !active.settled) void cancelTurn(active);

      const turn = createTurn(text, request.source, request.mode ?? DEFAULT_MODE_CONFIG);
      revision += 1;
      turn.revision = revision;
      active = turn;
      turns.set(turn.id, turn);
      announceState(turn, "assembling");
      void run(turn);
      return { turnId: turn.id, done: turn.done };
    },

    cancel(turnId: string): void {
      const turn = turns.get(turnId);
      if (!turn || turn.settled) return;
      void cancelTurn(turn);
    },

    reportDelivery(receipt: DeliveryReceipt): void {
      const turn = turns.get(receipt.turnId);
      if (!turn || turn.settled || turn.state !== "awaitingDelivery" || !turn.reply) return;
      clearDeliveryTimer(turn);

      const generated = turn.reply.replyText.trim();
      const delivered = (receipt.deliveredText ?? "").trim();
      // 只有「播放完整 + 精度确认」才算听完；deliveredText 短于正文说明没播完。
      const fullyDelivered = receipt.status === "complete"
        && receipt.precision === "confirmed"
        && (!delivered || !generated || delivered.length >= generated.length);

      if (receipt.status === "failed") {
        void persistFinal(turn, turn.reply, "interrupted", "unknown")
          .then(() => settle(turn, "failed", "DELIVERY_FAILED"));
        return;
      }

      void persistFinal(
        turn,
        turn.reply,
        fullyDelivered ? "complete" : "interrupted",
        fullyDelivered ? "played" : "unknown",
      ).then(() => {
        if (isStale(turn)) return;
        settle(turn, "completed");
      });
    },

    subscribe(listener: (event: RuntimeEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (active && !active.settled) void cancelTurn(active);
      listeners.clear();
    },
  };
}
