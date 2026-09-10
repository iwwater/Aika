/**
 * LLM-03 接入侧验收：Hook 在有记忆 V2 存储时的行为。
 *
 * 这里验证的是「接线」而不是算法：
 * 启动迁移、确认、删除联动摘要失效、以及按本轮 query 检索后再注入提示词。
 * 检索排序本身由 domain/memoryRetrieval 的测试负责。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookHarness, flushMicrotasks } from "./hookHarness";
import type { ChatMessage } from "../domain/conversation";
import type { CompanionReply } from "../domain/companion";
import type { MemoryRecord } from "../domain/memory";
import { createInMemoryMemoryStore, type MemoryV2Store } from "../services/memory/memoryStore";

const mocks = vi.hoisted(() => {
  const state: any = {
    hook: null,
    storage: null,
    presenter: null,
    streamChat: vi.fn(),
  };
  state.openStorage = vi.fn(async () => state.storage);
  state.loadProvider = vi.fn(async (_storage: unknown, fallback: unknown) => ({ ...(fallback as object), apiKey: "test-key" }));
  state.secretStore = { secure: vi.fn(async () => false) };
  return state;
});

vi.mock("react", () => ({
  useRef: (initial: unknown) => mocks.hook.useRef(initial),
  useState: (initial: unknown) => mocks.hook.useState(initial),
  useMemo: (factory: () => unknown, deps: readonly unknown[]) => mocks.hook.useMemo(factory, deps),
  useCallback: (factory: unknown, deps: readonly unknown[]) => mocks.hook.useCallback(factory, deps),
  useEffect: (effect: () => void | (() => void), deps: readonly unknown[]) => mocks.hook.useEffect(effect, deps),
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) =>
    mocks.hook.useSyncExternalStore(subscribe, getSnapshot),
}));

// CORE-04：Hook 只经 useService 取 Presenter，测试给出生产 Presenter。
vi.mock("../app/kernelContext", () => ({
  useService: (token: { key: string }) => (
    token.key === "presentation.companion" ? mocks.presenter : null
  ),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => false,
  requestPermission: async () => "denied",
  sendNotification: async () => undefined,
}));

vi.mock("../services/storage", () => ({
  openStorage: (...args: unknown[]) => mocks.openStorage(...args),
  loadProvider: (...args: unknown[]) => mocks.loadProvider(...args),
  saveProvider: vi.fn(async () => undefined),
  secretStore: mocks.secretStore,
  SETTING_KEYS: {
    proactive: "proactive",
    memoryExtraction: "memory.extraction",
    voiceBackend: "voice.backend",
    whisperEndpoint: "voice.whisperEndpoint",
    provider: "provider",
    proactiveLastReason: "proactive.lastReason",
    proactiveLastSentAt: "proactive.lastSentAt",
    mode: "llm.mode",
  },
}));

vi.mock("../services/memory/extractor", () => ({
  createModelMemoryExtractor: () => ({
    extract: vi.fn(async () => [] as MemoryRecord[]),
    summarize: vi.fn(async () => ""),
  }),
  formatTranscript: () => "",
}));
vi.mock("../services/stickers/library", () => ({ loadStickers: async () => [] }));
vi.mock("../services/providerClient", () => ({
  streamChat: (...args: unknown[]) => mocks.streamChat(...args),
  sendChat: vi.fn(),
  isAbortError: () => false,
}));

import { useCompanionSession } from "./useCompanionSession";
import { createCompanionPresenter } from "../presentation/companionPresenter";
import { createCompanionRuntime } from "../services/runtime/companionRuntime";
import { createStreamChatProvider } from "../services/runtime/providerAdapter";
import { createProviderSettings } from "../services/runtime/providerSettings";
import { PROVIDER_PRESETS } from "../domain/providers";
import { createMemoryRepository } from "../services/memory/memoryRepository";
import { createMemorySource } from "../services/memory/memorySource";

/** CORE-06：只有一条编排路径，Runtime 直接注入 Presenter。 */
function createRuntime() {
  const settings = createProviderSettings(PROVIDER_PRESETS[1]);
  // 记忆上下文源在生产上由 memoryPlugin 提供；这里按同样的方式接上，
  // 否则提示词里不会有检索到的记忆，测的就不是同一件事了。
  const store = mocks.storage.memoryV2;
  const sources = store
    ? [createMemorySource(createMemoryRepository({ store }))]
    : [];
  return {
    settings,
    runtime: createCompanionRuntime({
      provider: createStreamChatProvider({
        getConfig: () => settings.get(),
        getStickers: () => settings.getStickers(),
      }),
      storage: mocks.storage,
      sources,
    }),
  };
}

const providerReply: CompanionReply = {
  japaneseText: "浅煎りだよね。",
  chineseTranslation: "你喜欢浅烘焙的吧。",
  mood: "neutral",
  schemaVersion: 1,
  replyText: "浅煎りだよね。",
  translation: "你喜欢浅烘焙的吧。",
  memoryCandidates: [],
  actions: [],
};

function createStorage(legacyMemories: MemoryRecord[], memoryV2: MemoryV2Store, summary: string | null) {
  const rows: ChatMessage[] = [];
  const settings = new Map<string, string>();
  const storage = {
    kind: "local" as const,
    memoryV2,
    rows,
    deleteSummariesCalls: 0,
    listMessages: async () => rows.slice(-200),
    appendMessage: async (message: ChatMessage) => {
      const index = rows.findIndex((item) => item.id === message.id);
      if (index >= 0) rows[index] = message;
      else rows.push(message);
    },
    listMessageTimestamps: async () => rows.map((message) => message.createdAt),
    countMessagesSince: async () => 0,
    countProactiveSince: async () => 0,
    clearMessages: async () => { rows.length = 0; },
    listMemories: async () => legacyMemories,
    addMemories: async () => undefined,
    setMemoryStatus: async () => undefined,
    deleteMemory: async () => undefined,
    latestSummary: async () => (summary ? { content: summary, coversUntil: 1, createdAt: 1 } : null),
    saveSummary: async () => undefined,
    deleteSummaries: async () => { storage.deleteSummariesCalls += 1; },
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => { settings.set(key, value); },
  };
  return storage;
}

function legacyMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "legacy-1",
    category: "偏好",
    content: "喝咖啡只喝浅烘焙",
    status: "pending",
    createdAt: 1_788_998_400_000,
    updatedAt: 1_788_998_400_000,
    ...overrides,
  };
}

async function render(): Promise<{ session: any; harness: HookHarness }> {
  const harness = mocks.hook as HookHarness;
  mocks.presenter = createCompanionPresenter({
    loadStorage: async () => mocks.storage,
    notifier: { notify: async () => false },
    runtime: createRuntime(),
  });
  harness.render(() => useCompanionSession());
  await flushMicrotasks();
  return { session: harness.rerender(), harness };
}

beforeEach(() => {
  mocks.hook = new HookHarness();
  mocks.streamChat.mockReset();
  mocks.streamChat.mockResolvedValue(providerReply);
});

afterEach(() => {
  mocks.hook.cleanup();
});

describe("记忆 V2 接入", () => {
  it("启动时把 V1 记忆迁进 V2，界面显示的是 V2 内容", async () => {
    const store = createInMemoryMemoryStore();
    mocks.storage = createStorage([legacyMemory()], store, null);

    const { session } = await render();

    expect(session.memories).toEqual([
      expect.objectContaining({ id: "legacy-1", content: "喝咖啡只喝浅烘焙", category: "偏好", status: "pending" }),
    ]);
    const snapshot = store.current();
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({ sourceKind: "legacy", sourceMessageIds: [], importance: 0.5 });
    expect(snapshot.migrationVersion).toBe(1);
  });

  it("确认记忆写入 V2 的 confirmed 状态", async () => {
    const store = createInMemoryMemoryStore();
    mocks.storage = createStorage([legacyMemory()], store, null);
    const { session } = await render();

    await session.confirmMemory("legacy-1");
    await flushMicrotasks();

    expect(store.current().records[0]).toMatchObject({ status: "confirmed" });
    expect(store.current().records[0].lastConfirmedAt).not.toBeNull();
  });

  it("删除记忆会落下抑制标记并让摘要失效", async () => {
    const store = createInMemoryMemoryStore();
    mocks.storage = createStorage(
      [legacyMemory({ id: "m1", content: "喝咖啡只喝浅烘焙" })],
      store,
      "她记得用户喜欢浅烘焙",
    );
    const { harness, session } = await render();
    expect(session.summary).toBe("她记得用户喜欢浅烘焙");

    await session.deleteMemory("m1");
    await flushMicrotasks();

    // 状态更新在 HookHarness 的槽位里，要 rerender 才能看到新的返回值。
    const next = harness.rerender();

    expect(store.current().records).toEqual([]);
    expect(store.current().suppressions[0]).toMatchObject({ id: "m1" });
    expect(mocks.storage.deleteSummariesCalls).toBe(1);
    expect(next.memories).toEqual([]);
  });

  it("本轮 query 检索不到相关记忆时，提示词里不塞无关记忆", async () => {
    const store = createInMemoryMemoryStore();
    mocks.storage = createStorage([legacyMemory({ id: "m1", content: "喝咖啡只喝浅烘焙" })], store, null);
    const { session } = await render();

    await session.send("今天下雨了", "text");
    await flushMicrotasks();

    const instructions = mocks.streamChat.mock.calls[0][1] as string;
    expect(instructions).not.toContain("浅烘焙");
  });

  it("命中记忆时带上检索到的事实", async () => {
    const store = createInMemoryMemoryStore();
    mocks.storage = createStorage([legacyMemory({ id: "m1", content: "喝咖啡只喝浅烘焙" })], store, null);
    const { session } = await render();

    await session.send("他平时喝什么咖啡", "text");
    await flushMicrotasks();

    const instructions = mocks.streamChat.mock.calls[0][1] as string;
    expect(instructions).toContain("喝咖啡只喝浅烘焙");
  });
});
