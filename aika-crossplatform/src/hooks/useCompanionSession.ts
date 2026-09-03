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
import { RAW_TURN_WINDOW, SUMMARY_INPUT_LIMIT, shouldSummarize } from "../domain/summary";
import { createModelMemoryExtractor, formatTranscript } from "../services/memory/extractor";
import { sendChat, streamChat, type PartialReply } from "../services/providerClient";
import { DEFAULT_VOICE_BACKEND, type VoiceBackendConfig } from "../services/voice/inputEngine";
import {
  loadProvider, openStorage, saveProvider, secretStore, SETTING_KEYS,
  type AikaStorage,
} from "../services/storage";

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
  const [sending, setSending] = useState(false);

  const storageRef = useRef<AikaStorage | null>(null);
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const busyRef = useRef(false);

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
    await storageRef.current?.appendMessage(message);
    if (!message.error) setTimestamps((current) => [...current, message.createdAt]);
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
  ): Promise<CompanionReply | null> => {
    if (!content || busyRef.current || !connected) return null;
    busyRef.current = true;
    setSending(true);

    const asked = userMessage(content);
    const history = messages;
    const pendingId = crypto.randomUUID();
    setMessages([...history, asked, {
      id: pendingId, role: "assistant", content: "",
      createdAt: asked.createdAt, time: asked.time, pending: true,
    }]);

    try {
      // 上下文不含刚发出的这一句：它作为「用户刚刚说」单独交给提示词。
      const context = buildContext(history);
      const reply = await streamChat(
        providerRef.current,
        buildInstructions(context, DEFAULT_CHARACTER.systemPrompt),
        [{ role: "user", content: buildConversationInput(content, context) }],
        (partial) => {
          setMessages((current) => current.map((message) => (
            message.id === pendingId
              ? {
                  ...message,
                  content: partial.japaneseText,
                  japaneseText: partial.japaneseText,
                  chineseTranslation: partial.chineseTranslation,
                }
              : message
          )));
          onPartial?.(partial);
        },
      );

      const answered = companionMessage(reply, Date.now(), pendingId, source);
      const next = [...history, asked, answered];
      setMessages(next);
      await persist(asked);
      await persist(answered);
      void runBackgroundMemoryWork(next);
      return reply;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failedAt = Date.now();
      const failure: ChatMessage = {
        id: pendingId, role: "assistant", content: `这次没有发出去：${detail}`,
        createdAt: failedAt, time: formatClockTime(failedAt), error: true,
      };
      setMessages([...history, asked, failure]);
      await persist(asked);
      await persist(failure);
      return null;
    } finally {
      busyRef.current = false;
      setSending(false);
    }
  }, [buildContext, connected, messages, persist, runBackgroundMemoryWork]);

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
        buildInstructions(context, DEFAULT_CHARACTER.systemPrompt),
        [{ role: "user", content: buildProactiveInput(context, reason) }],
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
    relationship, summary,
  };
}
