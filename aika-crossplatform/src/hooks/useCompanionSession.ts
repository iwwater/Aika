import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { DEFAULT_CHARACTER } from "../domain/character";
import type { CompanionReply } from "../domain/companion";
import {
  buildCompanionContext, companionMessage, formatClockTime, toCompanionTurns, userMessage,
  type ChatMessage, type MessageSource,
} from "../domain/conversation";
import { memoryLines, type MemoryRecord } from "../domain/memory";
import { buildConversationInput, buildInstructions, buildProactiveInput } from "../domain/prompt";
import {
  canSend, chooseProactiveReason, DEFAULT_PROACTIVE_SETTINGS,
  type ProactiveReasonKind, type ProactiveSettings,
} from "../domain/proactive";
import { PROVIDER_PRESETS, type ProviderConfig } from "../domain/providers";
import { computeRelationship, deriveRelationshipSignals } from "../domain/relationship";
import type { Sticker } from "../domain/stickers";
import { RAW_TURN_WINDOW, SUMMARY_INPUT_LIMIT, shouldSummarize } from "../domain/summary";
import { createModelMemoryExtractor, formatTranscript } from "../services/memory/extractor";
import { isAbortError, sendChat, streamChat, type PartialReply } from "../services/providerClient";
import { loadStickers } from "../services/stickers/library";
import { DEFAULT_VOICE_BACKEND, type VoiceBackendConfig } from "../services/voice/inputEngine";
import type { PlaybackStatus, VoiceTurnRequest } from "../domain/voiceRuntime";
import {
  loadProvider, openStorage, saveProvider, secretStore, SETTING_KEYS,
  type AikaStorage,
} from "../services/storage";
import { createSerializedMessagePersister } from "../services/storage/messagePersistence";

const MESSAGE_WINDOW = 200;
const PROACTIVE_TICK_MS = 60_000;

function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function welcomeMessage(): ChatMessage {
  const createdAt = Date.now();
  return {
    id: "welcome",
    role: "assistant",
    content: DEFAULT_CHARACTER.greeting,
    japaneseText: DEFAULT_CHARACTER.greeting,
    chineseTranslation: DEFAULT_CHARACTER.greetingTranslation,
    source: "text",
    createdAt,
    time: formatClockTime(createdAt),
  };
}

function replacePendingMessage(
  current: ChatMessage[],
  pendingId: string,
  replacement: ChatMessage | null,
): ChatMessage[] {
  const index = current.findIndex((message) => message.id === pendingId);
  if (index < 0) return replacement ? [...current, replacement] : current;
  if (!replacement) return current.filter((message) => message.id !== pendingId);
  return current.map((message) => (message.id === pendingId ? replacement : message));
}

function interruptedMessage(
  partial: PartialReply,
  pendingId: string,
  source: MessageSource,
  turnId: number | undefined,
  playbackStatus: PlaybackStatus = "unknown",
): ChatMessage | null {
  const content = (partial.japaneseText || partial.chineseTranslation).trim();
  if (!content) return null;
  const createdAt = Date.now();
  return {
    id: pendingId,
    role: "assistant",
    content,
    japaneseText: partial.japaneseText || undefined,
    chineseTranslation: partial.chineseTranslation || undefined,
    mood: partial.mood,
    ...(turnId === undefined ? {} : { turnId }),
    source,
    completion: "interrupted",
    playbackStatus,
    createdAt,
    time: formatClockTime(createdAt),
  };
}

async function notify(title: string, body: string) {
  try {
    if (!("__TAURI_INTERNALS__" in globalThis)) return;
    const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // 通知失败不该影响消息本身：消息已经落库，用户打开窗口就能看到。
  }
}

export function useCompanionSession() {
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [storageKind, setStorageKind] = useState<AikaStorage["kind"]>("local");
  const [keyIsSecure, setKeyIsSecure] = useState(false);
  const [provider, setProviderState] = useState<ProviderConfig>(PROVIDER_PRESETS[1]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [timestamps, setTimestamps] = useState<number[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryCoversUntil, setSummaryCoversUntil] = useState(0);
  const [proactive, setProactiveState] = useState<ProactiveSettings>(DEFAULT_PROACTIVE_SETTINGS);
  const [memoryExtractionEnabled, setMemoryExtractionEnabledState] = useState(true);
  const [voiceBackend, setVoiceBackendState] = useState<VoiceBackendConfig>(DEFAULT_VOICE_BACKEND);
  /** 她能挑的表情包。目录为空时是空数组，提示词里一个字都不提。 */
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [sending, setSending] = useState(false);

  const storageRef = useRef<AikaStorage | null>(null);
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const stickersRef = useRef(stickers);
  stickersRef.current = stickers;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const busyRef = useRef(false);
  const requestSeqRef = useRef(0);
  const activeRequestRef = useRef<number | null>(null);
  const persistedMessageIdsRef = useRef(new Set<string>());
  const persistRef = useRef<((message: ChatMessage) => Promise<void>) | null>(null);
  if (!persistRef.current) {
    persistRef.current = createSerializedMessagePersister(
      () => storageRef.current,
      persistedMessageIdsRef.current,
      (createdAt) => setTimestamps((current) => [...current, createdAt]),
    );
  }

  const extractor = useMemo(() => createModelMemoryExtractor(() => providerRef.current), []);
  const connected = Boolean(provider.apiKey && provider.baseUrl && provider.model);
  const relationship = useMemo(
    () => computeRelationship(deriveRelationshipSignals(timestamps)),
    [timestamps],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await load();
      } catch (error) {
        if (cancelled) return;
        // 打不开存储是必须看得见的故障：静默卡在加载态等于把记忆悄悄丢了。
        setStorageError(error instanceof Error ? error.message : String(error));
        setReady(true);
      }
    })();

    async function load() {
      const storage = await openStorage();
      if (cancelled) return;
      storageRef.current = storage;

      const [
        savedProvider, savedMessages, savedMemories, savedTimestamps, savedSummary,
        rawProactive, rawExtraction, rawBackend, rawEndpoint,
      ] = await Promise.all([
          loadProvider(storage, PROVIDER_PRESETS[1]),
          storage.listMessages(MESSAGE_WINDOW),
          storage.listMemories(),
          storage.listMessageTimestamps(),
          storage.latestSummary(),
          storage.getSetting(SETTING_KEYS.proactive),
          storage.getSetting(SETTING_KEYS.memoryExtraction),
          storage.getSetting(SETTING_KEYS.voiceBackend),
          storage.getSetting(SETTING_KEYS.whisperEndpoint),
        ]);
      if (cancelled) return;

      // 清单读不出来就当没有表情包，不该拦住这次启动。
      setStickers(await loadStickers());
      if (cancelled) return;

      setStorageKind(storage.kind);
      setKeyIsSecure(await secretStore.secure());
      setProviderState(savedProvider);
      setMessages(savedMessages.length ? savedMessages : [welcomeMessage()]);
      setMemories(savedMemories);
      setTimestamps(savedTimestamps);
      setSummary(savedSummary?.content ?? null);
      setSummaryCoversUntil(savedSummary?.coversUntil ?? 0);
      if (rawProactive) setProactiveState({ ...DEFAULT_PROACTIVE_SETTINGS, ...JSON.parse(rawProactive) });
      if (rawExtraction) setMemoryExtractionEnabledState(rawExtraction === "true");
      setVoiceBackendState({
        backend: (rawBackend as VoiceBackendConfig["backend"]) || DEFAULT_VOICE_BACKEND.backend,
        whisperEndpoint: rawEndpoint || DEFAULT_VOICE_BACKEND.whisperEndpoint,
      });
      setReady(true);
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (message: ChatMessage) => {
    await persistRef.current?.(message);
  }, []);

  /** 抽取候选记忆并压缩更早的对话。失败只记录，不打断聊天。 */
  const runBackgroundMemoryWork = useCallback(async (allMessages: ChatMessage[]) => {
    const storage = storageRef.current;
    if (!storage || !memoryExtractionEnabled) return;

    try {
      const turns = toCompanionTurns(allMessages.slice(-4));
      const extracted = await extractor.extract(turns, memories);
      if (extracted.length) {
        await storage.addMemories(extracted);
        setMemories((current) => [...current, ...extracted]);
      }
    } catch {
      // 抽取失败不影响这一轮对话，下一轮会再试。
    }

    try {
      const olderThanWindow = allMessages.slice(0, Math.max(0, allMessages.length - RAW_TURN_WINDOW));
      const uncovered = olderThanWindow.filter((message) => message.createdAt > summaryCoversUntil);
      if (!shouldSummarize(uncovered.length)) return;

      const transcript = formatTranscript(toCompanionTurns(uncovered.slice(-SUMMARY_INPUT_LIMIT)));
      const content = await extractor.summarize(summary, transcript);
      if (!content) return;

      const coversUntil = uncovered[uncovered.length - 1].createdAt;
      await storage.saveSummary({ content, coversUntil, createdAt: Date.now() });
      setSummary(content);
      setSummaryCoversUntil(coversUntil);
    } catch {
      // 摘要失败同理：下次消息量再次超阈值时会重试。
    }
  }, [extractor, memories, memoryExtractionEnabled, summary, summaryCoversUntil]);

  const buildContext = useCallback((history: ChatMessage[], now = Date.now()) => (
    buildCompanionContext({
      messages: history,
      memories: memoryLines(memories),
      summary,
      timestamps,
      now,
    })
  ), [memories, summary, timestamps]);

  /**
   * 发一轮。
   *
   * 走流式：气泡逐字长出来，语音页据此让第一句提前开口。
   * `onPartial` 是给语音页的额外出口——聊天气泡的更新在这里已经做掉了。
   */
  const send = useCallback(async (
    content: string,
    source: MessageSource = "text",
    onPartial?: (partial: PartialReply) => void,
    request?: VoiceTurnRequest,
  ): Promise<CompanionReply | null> => {
    if (!content || busyRef.current || !connected || request?.signal.aborted) return null;
    const requestId = ++requestSeqRef.current;
    activeRequestRef.current = requestId;
    busyRef.current = true;
    setSending(true);

    const asked = userMessage(content, Date.now(), request?.turnId);
    const history = messagesRef.current;
    const pendingId = crypto.randomUUID();
    const pending: ChatMessage = {
      id: pendingId, role: "assistant", content: "",
      createdAt: asked.createdAt, time: asked.time, pending: true, turnId: request?.turnId,
    };
    setMessages((current) => [...current, asked, pending]);

    let latestPartial: PartialReply = {
      japaneseText: "",
      chineseTranslation: "",
      mood: "neutral",
      japaneseComplete: false,
    };
    let completedMessage: ChatMessage | null = null;
    let playbackSettled = false;
    let deferredPlaybackCompletion: ((status: PlaybackStatus) => void) | null = null;

    const persistAsked = async () => {
      await persist(asked);
    };

    const persistInterrupted = async () => {
      await persistAsked();
      const partial = interruptedMessage(
        latestPartial,
        pendingId,
        source,
        request?.turnId,
        request?.getPlaybackStatus?.() ?? "unknown",
      );
      setMessages((current) => replacePendingMessage(current, pendingId, partial));
      if (partial) await persist(partial);
    };

    const markCompletedTurnInterrupted = async () => {
      if (!completedMessage || completedMessage.completion === "interrupted") return;
      deferredPlaybackCompletion = null;
      const interrupted: ChatMessage = {
        ...completedMessage,
        completion: "interrupted",
        playbackStatus: request?.getPlaybackStatus?.() ?? "unknown",
      };
      completedMessage = interrupted;
      setMessages((current) => current.map((message) => (
        message.id === pendingId ? interrupted : message
      )));
      await persistAsked();
      await persist(interrupted);
    };

    const settlePlayback = (status: PlaybackStatus) => {
      if (playbackSettled) return;
      playbackSettled = true;
      request?.signal.removeEventListener("abort", onAbort);
      const finalize = deferredPlaybackCompletion;
      deferredPlaybackCompletion = null;
      finalize?.(status);
    };

    const onAbort = () => {
      // AbortController 只负责尽快停止可取消的网络读取；下面的 turnId/current
      // 检查仍然是服务不支持取消时的最后一道迟到结果屏障。
      if (activeRequestRef.current === requestId) {
        busyRef.current = false;
        setSending(false);
      }
      if (completedMessage && !playbackSettled) void markCompletedTurnInterrupted();
    };
    request?.signal.addEventListener("abort", onAbort, { once: true });
    if (request) {
      request.onPlaybackComplete = () => settlePlayback("played");
      request.onPlaybackFailed = () => settlePlayback("unknown");
    }

    try {
      // 上下文不含刚发出的这一句：它作为「用户刚刚说」单独交给提示词。
      const context = buildContext(history);
      const reply = await streamChat(
        providerRef.current,
        buildInstructions(context, DEFAULT_CHARACTER.systemPrompt, stickersRef.current),
        [{ role: "user", content: buildConversationInput(content, context) }],
        (partial) => {
          if (request?.signal.aborted) return;
          latestPartial = partial;
          setMessages((current) => current.map((message) => (
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
        },
        stickersRef.current.map((sticker) => sticker.id),
        request ? { signal: request.signal, turnId: request.turnId } : undefined,
      );

      if (request?.signal.aborted) {
        await persistInterrupted();
        return null;
      }

      const answered = companionMessage(reply, Date.now(), pendingId, source, request?.turnId);
      completedMessage = answered;
      const next = [...history, asked, answered];
      setMessages((current) => replacePendingMessage(current, pendingId, answered));
      await persistAsked();
      if (request?.signal.aborted) {
        await markCompletedTurnInterrupted();
        return null;
      }
      if (request) {
        deferredPlaybackCompletion = (status) => {
          if (request.signal.aborted) return;
          const finalized = {
            ...answered,
            playbackStatus: status,
          } satisfies ChatMessage;
          completedMessage = finalized;
          setMessages((current) => replacePendingMessage(current, pendingId, finalized));
          void (async () => {
            await persist(finalized);
            if (status === "played" && !request.signal.aborted) void runBackgroundMemoryWork(next);
          })();
        };
      } else {
        await persist(answered);
        void runBackgroundMemoryWork(next);
      }
      return reply;
    } catch (error) {
      if (request?.signal.aborted || isAbortError(error)) {
        await persistInterrupted();
        return null;
      }
      const detail = error instanceof Error ? error.message : String(error);
      const failedAt = Date.now();
      const failure: ChatMessage = {
        id: pendingId, role: "assistant", content: `这次没有发出去：${detail}`, turnId: request?.turnId,
        createdAt: failedAt, time: formatClockTime(failedAt), error: true,
      };
      setMessages((current) => replacePendingMessage(current, pendingId, failure));
      await persistAsked();
      await persist(failure);
      return null;
    } finally {
      if (activeRequestRef.current === requestId) {
        activeRequestRef.current = null;
        busyRef.current = false;
        setSending(false);
      }
      if (!completedMessage || playbackSettled || !request) {
        request?.signal.removeEventListener("abort", onAbort);
      }
    }
  }, [buildContext, connected, persist, runBackgroundMemoryWork]);

  /** 主动消息。频率闸门与理由选择都在 domain/proactive.ts，这里只负责跑一次。 */
  const runProactiveTick = useCallback(async () => {
    const storage = storageRef.current;
    if (!storage || !ready || !connected || !proactive.enabled || busyRef.current) return;

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

    busyRef.current = true;
    try {
      const context = buildContext(messages, now);
      const lastUserAt = [...messages].reverse().find((message) => message.role === "user")?.createdAt ?? null;
      const reason = chooseProactiveReason({
        recentTurns: context.recentTurns,
        memories: context.memories,
        now: new Date(now),
        hoursSinceLastUserMessage: lastUserAt === null ? null : (now - lastUserAt) / 3_600_000,
        lastReasonKind: (await storage.getSetting(SETTING_KEYS.proactiveLastReason)) as ProactiveReasonKind | null,
      });

      const reply = await sendChat(
        providerRef.current,
        buildInstructions(context, DEFAULT_CHARACTER.systemPrompt, stickersRef.current),
        [{ role: "user", content: buildProactiveInput(context, reason) }],
        stickersRef.current.map((sticker) => sticker.id),
      );

      const message = companionMessage(reply, Date.now(), crypto.randomUUID(), "proactive");
      setMessages((current) => [...current, message]);
      await persist(message);
      await storage.setSetting(SETTING_KEYS.proactiveLastReason, reason.kind);
      await storage.setSetting(SETTING_KEYS.proactiveLastSentAt, String(message.createdAt));
      await notify(DEFAULT_CHARACTER.name, reply.japaneseText || reply.chineseTranslation);
    } catch {
      // 主动消息发不出去就安静地跳过：不要用错误提示打扰用户。
    } finally {
      busyRef.current = false;
    }
  }, [buildContext, connected, messages, persist, proactive, ready, timestamps]);

  const proactiveRef = useRef(runProactiveTick);
  proactiveRef.current = runProactiveTick;

  useEffect(() => {
    if (!proactive.enabled) return;
    const timer = window.setInterval(() => void proactiveRef.current(), PROACTIVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [proactive.enabled]);

  const setProvider = useCallback(async (next: ProviderConfig) => {
    setProviderState(next);
    if (storageRef.current) await saveProvider(storageRef.current, next);
  }, []);

  const setProactive = useCallback(async (next: ProactiveSettings) => {
    setProactiveState(next);
    await storageRef.current?.setSetting(SETTING_KEYS.proactive, JSON.stringify(next));
  }, []);

  const setMemoryExtractionEnabled = useCallback(async (enabled: boolean) => {
    setMemoryExtractionEnabledState(enabled);
    await storageRef.current?.setSetting(SETTING_KEYS.memoryExtraction, String(enabled));
  }, []);

  const setVoiceBackend = useCallback(async (next: VoiceBackendConfig) => {
    setVoiceBackendState(next);
    await storageRef.current?.setSetting(SETTING_KEYS.voiceBackend, next.backend);
    await storageRef.current?.setSetting(SETTING_KEYS.whisperEndpoint, next.whisperEndpoint);
  }, []);

  const confirmMemory = useCallback(async (id: string) => {
    await storageRef.current?.setMemoryStatus(id, "confirmed");
    setMemories((current) => current.map((memory) => (
      memory.id === id ? { ...memory, status: "confirmed", updatedAt: Date.now() } : memory
    )));
  }, []);

  const deleteMemory = useCallback(async (id: string) => {
    await storageRef.current?.deleteMemory(id);
    setMemories((current) => current.filter((memory) => memory.id !== id));
  }, []);

  return {
    ready, storageKind, storageError, keyIsSecure, connected, sending,
    provider, setProvider,
    messages, send,
    memories, confirmMemory, deleteMemory,
    memoryExtractionEnabled, setMemoryExtractionEnabled,
    proactive, setProactive,
    voiceBackend, setVoiceBackend,
    stickers,
    relationship, summary,
  };
}
