import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AikaKernel, AikaPlugin } from "../kernel";
import { testHostPlugins } from "./hosts";
import { defaultSpeechEngines, memoryPlugin, providerSettingsPlugin, runtimePlugin, voicePlugin } from "./plugins";
import type { ConsumerObservation, ConsumerScenario, MatrixCase, MatrixResult } from "./swapMatrix";
import { runMatrix } from "./swapMatrix";
import type { AikaStorage } from "../services/storage/contracts";
import { createLocalStorage } from "../services/storage/localStorageStorage";
import { createSqliteStorage } from "../services/storage/sqliteStorage";
import { openMemorySqlite } from "../services/storage/nodeSqlite.harness";
import {
  createDesktopSecretStore, createInsecureSecretStore, type TauriSecretPorts,
} from "../services/storage/secretStore";
import { SecretStoreToken, StorageToken } from "../services/storage/tokens";
import { MemoryRepositoryToken } from "../services/memory/tokens";
import { emptySnapshot } from "../services/memory/memoryStore";
import { createMemoryV2 } from "../domain/memory";
import { ContextSourcesToken } from "../services/context/tokens";
import { createContextAssembler, type ContextSource } from "../services/context/contextAssembler";
import { ProviderToken } from "../services/runtime/tokens";
import type { ProviderConfig } from "../domain/providers";
import type { RuntimeGenerateInput } from "../services/runtime/companionRuntime";
import { buildContextClock } from "../domain/context";
import { DEFAULT_CHARACTER_SOUL, DEFAULT_MODE_CONFIG } from "../domain/soul";
import { computeRelationship, deriveRelationshipSignals } from "../domain/relationship";
import { SpeechEnginesToken, type SpeechEngines } from "../services/voice/tokens";
import { createWebSpeechInputEngine } from "../services/voice/webSpeechInput";
import { createWhisperInputEngine } from "../services/voice/whisperInput";

/**
 * CORE-07 替换矩阵。
 *
 * 本文件只回答一个问题：**换实现，消费侧真的不用改吗？**
 *
 * 规矩（对应 SPEC 的约束）：
 * 1. 消费侧场景只依赖端口契约，拿到的只有 `AikaKernel`——它拿不到「这次装的是哪个
 *    实现」，所以按实现分支在结构上就不可能（下面还有一条静态断言兜底）。
 * 2. 实现选择只经组合根：每一格用 `createAikaKernel({ hostPlugins, featurePlugins })`
 *    装配，矩阵驱动不 `new` 任何实现塞进注册表。
 * 3. 场景在所有格子里逐字相同；差异只允许出现在实现自己的 `unsupported` 声明里
 *    （由各端口的 `<port>.conformance.ts` 单独验证，本文件不重复断言）。
 * 4. 只测「换掉一个端口」。同时换多个属于组合爆炸，不做。
 */

const SOURCE = readFileSync(new URL(import.meta.url), "utf8");

async function freshSqlite(): Promise<{ storage: AikaStorage; close: () => void }> {
  const { db, executor } = openMemorySqlite();
  return { storage: await createSqliteStorage(executor), close: () => db.close() };
}

function stubLocalStorage(): () => void {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  return () => vi.unstubAllGlobals();
}

function memoryBackend() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => void values.set(key, value),
  };
}

/** 假 DPAPI：只做存取，对齐 src-tauri/src/secret_store.rs 的契约。 */
function fakeVault(): TauriSecretPorts {
  const entries = new Map<string, string>();
  return {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const name = String(args?.name ?? "");
      switch (command) {
        case "secret_available": return true as T;
        case "secret_get": return (entries.get(name) ?? null) as T;
        case "secret_set": entries.set(name, String(args?.value ?? "")); return undefined as T;
        case "secret_delete": entries.delete(name); return undefined as T;
        default: throw new Error(`unexpected command ${command}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// AikaStorage / SecretStore / MemoryV2Store
// ---------------------------------------------------------------------------

const storageScenario: ConsumerScenario = {
  name: "写两条消息再读回，设置往返",
  async run(kernel: AikaKernel): Promise<ConsumerObservation> {
    const storage = kernel.registry.resolve(StorageToken);
    await storage.appendMessage({ id: "m2", role: "assistant", content: "在的", createdAt: 200, time: "00:00", source: "text" });
    await storage.appendMessage({ id: "m1", role: "user", content: "你好", createdAt: 100, time: "00:00", source: "text" });
    await storage.setSetting("fixture.key", "值");
    const messages = await storage.listMessages(10);
    return {
      order: messages.map((message) => message.id),
      contents: messages.map((message) => message.content),
      setting: await storage.getSetting("fixture.key"),
      neverWritten: await storage.getSetting("fixture.never"),
      summary: await storage.latestSummary(),
    };
  },
};

const secretScenario: ConsumerScenario = {
  name: "存一把 Key 再读回，删掉后读不到",
  async run(kernel: AikaKernel): Promise<ConsumerObservation> {
    const secrets = kernel.registry.resolve(SecretStoreToken);
    await secrets.set("provider.fixture.apiKey", "sk-1");
    const stored = await secrets.get("provider.fixture.apiKey");
    await secrets.remove("provider.fixture.apiKey");
    return { stored, afterRemove: await secrets.get("provider.fixture.apiKey") };
  },
};

const memoryScenario: ConsumerScenario = {
  name: "记住一件事并检索到",
  async run(kernel: AikaKernel): Promise<ConsumerObservation> {
    const repository = kernel.registry.resolve(MemoryRepositoryToken);
    await repository.upsert([createMemoryV2({
      id: "coffee", content: "喜欢浅烘焙", type: "preference", status: "confirmed",
      sourceMessageIds: ["msg-1"], now: 1_000,
    })!]);
    const hits = await repository.retrieve({ text: "咖啡", now: 2_000, limit: 5, tokenBudget: 400 });
    return { ids: hits.map((hit) => hit.record.id), contents: hits.map((hit) => hit.record.content) };
  },
};

function storageCases(): MatrixCase[] {
  return [
    {
      port: "AikaStorage", implementation: "sqliteStorage(node:sqlite)",
      async open() {
        const { storage, close } = await freshSqlite();
        return { hostPlugins: testHostPlugins({ storage }), featurePlugins: [], close };
      },
    },
    {
      port: "AikaStorage", implementation: "localStorageStorage",
      async open() {
        const restore = stubLocalStorage();
        return {
          hostPlugins: testHostPlugins({ storage: createLocalStorage() }),
          featurePlugins: [],
          close: restore,
        };
      },
    },
  ];
}

function secretCases(): MatrixCase[] {
  return [
    {
      port: "SecretStore", implementation: "insecureSecretStore(明文回退)",
      async open() {
        const { storage, close } = await freshSqlite();
        return {
          hostPlugins: testHostPlugins({ storage, secrets: createInsecureSecretStore(memoryBackend()) }),
          featurePlugins: [], close,
        };
      },
    },
    {
      port: "SecretStore", implementation: "desktopSecretStore(fake DPAPI)",
      async open() {
        const { storage, close } = await freshSqlite();
        return {
          hostPlugins: testHostPlugins({ storage, secrets: createDesktopSecretStore(fakeVault()) }),
          featurePlugins: [], close,
        };
      },
    },
  ];
}

function memoryCases(): MatrixCase[] {
  return [
    {
      port: "MemoryV2Store", implementation: "sqliteMemoryStore(node:sqlite)",
      async open() {
        const { storage, close } = await freshSqlite();
        return { hostPlugins: testHostPlugins({ storage }), featurePlugins: [memoryPlugin()], close };
      },
    },
    {
      port: "MemoryV2Store", implementation: "localMemoryStore(浏览器回退)",
      async open() {
        const restore = stubLocalStorage();
        return {
          hostPlugins: testHostPlugins({ storage: createLocalStorage() }),
          featurePlugins: [memoryPlugin()],
          close: restore,
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// ContextSource：1 个真实实现 + 1 个确定性替身（证据弱，报告里单独标注）
// ---------------------------------------------------------------------------

function confirmedMemorySnapshot() {
  return {
    ...emptySnapshot(),
    migrationVersion: 1,
    records: [createMemoryV2({
      id: "coffee", content: "喜欢咖啡", type: "preference", status: "confirmed",
      sourceMessageIds: ["user-1"], now: 1_000,
    })!],
  };
}

function stubContextSourcePlugin(source: ContextSource): AikaPlugin {
  return {
    id: "test.contextSources.stub",
    version: "0.0.0",
    provides: [ContextSourcesToken],
    activate(context) {
      context.registrar.provide(ContextSourcesToken, () => [source]);
    },
  };
}

const contextScenario: ConsumerScenario = {
  name: "装配一轮上下文，检索到那条确认记忆",
  async run(kernel: AikaKernel): Promise<ConsumerObservation> {
    const sources = kernel.registry.resolve(ContextSourcesToken);
    const assembler = createContextAssembler({
      sources,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    const result = await assembler.assemble({
      query: "咖啡", now: 1_000, timeZone: "UTC",
      characterSoul: DEFAULT_CHARACTER_SOUL,
      relationship: computeRelationship(deriveRelationshipSignals([], 1_000)),
      mode: DEFAULT_MODE_CONFIG,
      history: [], summary: null,
      signal: new AbortController().signal,
    });
    return {
      memories: result.context.memories.map((snippet) => snippet.content),
      dropped: result.droppedSources.map((item) => item.reason),
    };
  },
};

function contextCases(): MatrixCase[] {
  return [
    {
      port: "ContextSource", implementation: "memorySource(真实 repository)",
      async open() {
        const { storage, close } = await freshSqlite();
        await storage.memoryV2?.save(confirmedMemorySnapshot());
        return { hostPlugins: testHostPlugins({ storage }), featurePlugins: [memoryPlugin()], close };
      },
    },
    {
      port: "ContextSource", implementation: "deterministic stub(测试替身)",
      async open() {
        const { storage, close } = await freshSqlite();
        const source: ContextSource = {
          id: "stub", section: "memory",
          load: async () => [{ content: "喜欢咖啡", source: "memory", precision: "confirmed" }],
        };
        return {
          hostPlugins: testHostPlugins({ storage }),
          featurePlugins: [stubContextSourcePlugin(source)],
          close,
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// RuntimeProvider：4 种协议（同一适配器，按 config.protocol 走不同分支）
// ---------------------------------------------------------------------------

function providerConfig(protocol: ProviderConfig["protocol"]): ProviderConfig {
  return {
    id: "fixture", name: protocol, protocol,
    baseUrl: "https://fixture.invalid", model: "fixture", apiKey: "fixture",
  };
}

function providerInput(): RuntimeGenerateInput {
  return {
    turnId: "matrix-turn",
    signal: new AbortController().signal,
    mode: DEFAULT_MODE_CONFIG,
    context: {
      schemaVersion: 1, query: "你好", clock: buildContextClock(1_000, "UTC"),
      characterSoul: DEFAULT_CHARACTER_SOUL, userSoul: null,
      relationship: computeRelationship(deriveRelationshipSignals([], 1_000)), mode: DEFAULT_MODE_CONFIG,
      recentConversation: [], summary: null, memories: [], knowledge: [], environment: [],
    },
  };
}

/** 每个协议各自的 SSE 增量编码；除编码方式外，四格没有区别。 */
function protocolFixture(protocol: ProviderConfig["protocol"]): { fetch: typeof fetch } {
  const encode = (text: string) => {
    switch (protocol) {
      case "openai-responses": return { type: "response.output_text.delta", delta: text };
      case "anthropic": return { type: "content_block_delta", delta: { type: "text_delta", text } };
      case "gemini": return { candidates: [{ content: { parts: [{ text }] } }] };
      default: return { choices: [{ delta: { content: text } }] };
    }
  };
  const impl = vi.fn(async () => {
    const parts = ['{"replyText":"こん', 'にちは","translation":"你好"}'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(encode(part))}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  });
  return { fetch: impl as unknown as typeof fetch };
}

const providerScenario: ConsumerScenario = {
  name: "跑完一轮生成：累计增量 + 唯一终包",
  async run(kernel: AikaKernel): Promise<ConsumerObservation> {
    const provider = kernel.registry.resolve(ProviderToken);
    const events = [];
    for await (const event of provider.generate(providerInput())) events.push(event);
    return {
      deltas: events.filter((event) => event.type === "delta").map((event) => (event as { text: string }).text),
      replies: events.filter((event) => event.type === "reply").length,
      reply: events.find((event) => event.type === "reply") ?? null,
      errors: events.filter((event) => event.type === "error").length,
    };
  },
};

function providerCases(): MatrixCase[] {
  const protocols: ProviderConfig["protocol"][] = ["openai-responses", "openai-compatible", "anthropic", "gemini"];
  return protocols.map((protocol) => ({
    port: "RuntimeProvider", implementation: `providerAdapter(${protocol})`,
    async open() {
      const { storage, close } = await freshSqlite();
      vi.stubGlobal("fetch", protocolFixture(protocol).fetch);
      return {
        hostPlugins: testHostPlugins({ storage }),
        featurePlugins: [providerSettingsPlugin(providerConfig(protocol)), memoryPlugin(), runtimePlugin()],
        close: () => { close(); vi.unstubAllGlobals(); },
      };
    },
  }));
}

// ---------------------------------------------------------------------------
// SpeechInputEngine：两个真实实现（假传输层，不碰真实设备）
// ---------------------------------------------------------------------------

/** 一段说完就报 final 的假识别器：脚本化传输层，不模拟真实时序。 */
class AutoRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  start() {
    this.onstart?.();
    this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "おはよう。" } }] });
  }
  stop() { this.onend?.(); }
  abort() { this.onend?.(); }
}

function whisperPorts() {
  let events: { onFrame(frame: Float32Array, start: number, end: number): void } | null = null;
  const script: number[] = [];
  let cursor = 0;
  const capture = {
    isAvailable: () => true,
    async start(next: { onFrame(frame: Float32Array, start: number, end: number): void }) {
      events = next;
      // 4 帧有声越过 minSpeechMs，14 帧静音越过 silenceMs：等价于「一段说完」。
      for (const probability of [...Array<number>(4).fill(0.9), ...Array<number>(14).fill(0.1)]) script.push(probability);
      for (let index = 0; index < script.length; index += 1) {
        const start = index * 512;
        events.onFrame(new Float32Array(512), start, start + 512);
      }
    },
    stop() { /* 场景自己调 stop，这里不需要副作用 */ },
    async dispose() { events = null; },
    read: (from: number, to: number) => new Float32Array(Math.max(0, to - from)),
    totalSamples: () => 0,
    sampleRate: () => 16_000,
    timeAtSample: (sample: number) => sample,
  };
  const vad = {
    async probability() { return script[cursor++] ?? 0; },
    reset() { cursor = 0; script.length = 0; },
    async dispose() { script.length = 0; },
  };
  const client = { async probe() { return true; }, async transcribe() { return "おはよう。"; } };
  return { capture: () => capture, vad: () => vad, client: () => client };
}

function speechEngines(create: SpeechEngines["createInputEngine"]): SpeechEngines {
  return { ...defaultSpeechEngines(), createInputEngine: create };
}

const speechInputScenario: ConsumerScenario = {
  name: "开一次收音，拿到一段带文本的最终片段",
  async run(kernel: AikaKernel): Promise<ConsumerObservation> {
    const engines = kernel.registry.resolve(SpeechEnginesToken);
    const resolved = await engines.createInputEngine({ backend: "auto", whisperEndpoint: "http://fixture.invalid" });
    const finals = await new Promise<string[]>((resolve) => {
      const collected: string[] = [];
      resolved.engine.start("ja-JP", {
        onFinal: (result) => { collected.push(result.text); resolve(collected); },
      });
    });
    resolved.engine.stop();
    resolved.engine.dispose();
    return { finals, hasSegmentId: finals.length > 0 };
  },
};

function speechInputCases(): MatrixCase[] {
  return [
    {
      port: "SpeechInputEngine", implementation: "webSpeechInput",
      async open() {
        vi.stubGlobal("window", { SpeechRecognition: AutoRecognition });
        const { storage, close } = await freshSqlite();
        return {
          hostPlugins: testHostPlugins({ storage }),
          featurePlugins: [voicePlugin(speechEngines(async () => ({
            engine: createWebSpeechInputEngine(), note: "矩阵：web-speech", degraded: false,
          })))],
          close: () => { close(); vi.unstubAllGlobals(); },
        };
      },
    },
    {
      port: "SpeechInputEngine", implementation: "whisperInput",
      async open() {
        const { storage, close } = await freshSqlite();
        return {
          hostPlugins: testHostPlugins({ storage }),
          featurePlugins: [voicePlugin(speechEngines(async () => ({
            engine: createWhisperInputEngine({ endpoint: () => "http://fixture.invalid", ports: whisperPorts() }),
            note: "矩阵：whisper-local",
            degraded: false,
          })))],
          close,
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// SpeechOutputEngine：只有一个真实实现，矩阵这一行是 BLOCKED
// ---------------------------------------------------------------------------

class AutoUtterance {
  static last: AutoUtterance | null = null;
  lang = "";
  voice: unknown = null;
  rate = 1;
  pitch = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(public text: string) {
    AutoUtterance.last = this;
  }
}

function stubAutoSpeechSynthesis(): () => void {
  const synthesis = {
    getVoices: () => [],
    cancel: () => undefined,
    speak: (utterance: AutoUtterance) => {
      utterance.onstart?.();
      queueMicrotask(() => utterance.onend?.());
    },
  };
  vi.stubGlobal("SpeechSynthesisUtterance", AutoUtterance);
  vi.stubGlobal("window", { speechSynthesis: synthesis, SpeechSynthesisUtterance: AutoUtterance });
  return () => vi.unstubAllGlobals();
}

function speechOutputCases(): MatrixCase[] {
  return [
    {
      port: "SpeechOutputEngine", implementation: "webSpeechOutput",
      async open() {
        const restore = stubAutoSpeechSynthesis();
        const { storage, close } = await freshSqlite();
        return {
          hostPlugins: testHostPlugins({ storage }),
          featurePlugins: [voicePlugin(speechEngines(async () => ({
            engine: createWebSpeechInputEngine(), note: "", degraded: false,
          })))],
          close: () => { close(); restore(); },
        };
      },
    },
  ];
}

const speechOutputScenario: ConsumerScenario = {
  name: "念一句：开始与结束各一次",
  async run(kernel: AikaKernel): Promise<ConsumerObservation> {
    const engines = kernel.registry.resolve(SpeechEnginesToken);
    let starts = 0;
    const ends = await new Promise<number>((resolve) => {
      engines.outputEngine.speak({ text: "おかえり。", language: "ja-JP" }, {
        onStart: () => { starts += 1; },
        onEnd: () => resolve(1),
      });
    });
    return { starts, ends, available: engines.outputEngine.isAvailable() };
  },
};

// ---------------------------------------------------------------------------
// 矩阵
// ---------------------------------------------------------------------------

/**
 * 装配必须成功；成功后所有格子给出**同一个**消费侧可见行为。
 *
 * 这里也是「场景不按实现分支」的最终证据：如果哪一格需要例外，断言会直接红——
 * 而那意味着抽象没成立，不是靠加分支绕过去。
 */
function assertConsistent(result: MatrixResult): ConsumerObservation[] {
  for (const entry of result.entries) {
    expect(entry.ok, `${result.port} / ${entry.implementation}：${entry.failure ?? "未知失败"}`).toBe(true);
  }
  const observations = result.entries.map((entry) => entry.observation as ConsumerObservation);
  const first = observations[0];
  for (let index = 1; index < observations.length; index += 1) {
    expect(
      observations[index],
      `${result.entries[0].implementation} 与 ${result.entries[index].implementation} 的消费侧可见行为不一致`,
    ).toEqual(first);
  }
  return observations;
}

describe("CORE-07 替换矩阵", () => {
  it("场景代码不按实现分支，也不认识具体实现名", () => {
    // 结构上：ConsumerScenario.run 只拿 AikaKernel。这条是兜底断言。
    expect(SOURCE).not.toMatch(/implementation\s*===|impl\s*===|case\s+["']sqlite["']/);
    expect(SOURCE).not.toMatch(/if\s*\(\s*(implementation|impl)\b/);
  });

  it("AikaStorage：sqlite 与浏览器回退下，消费侧可见行为一致", async () => {
    const observations = assertConsistent(await runMatrix(storageScenario, storageCases()));
    expect(observations).toHaveLength(2);
  });

  it("SecretStore：明文回退与桌面保险库下，消费侧可见行为一致", async () => {
    const observations = assertConsistent(await runMatrix(secretScenario, secretCases()));
    expect(observations).toHaveLength(2);
  });

  it("MemoryV2Store：sqlite 与浏览器回退下，消费侧可见行为一致", async () => {
    const observations = assertConsistent(await runMatrix(memoryScenario, memoryCases()));
    expect(observations).toHaveLength(2);
  });

  it("ContextSource：真实 memorySource 与确定性替身下，消费侧可见行为一致", async () => {
    const observations = assertConsistent(await runMatrix(contextScenario, contextCases()));
    expect(observations).toHaveLength(2);
  });

  it("RuntimeProvider：4 种协议下，消费侧可见行为一致", async () => {
    const observations = assertConsistent(await runMatrix(providerScenario, providerCases()));
    expect(observations).toHaveLength(4);
  });

  it("SpeechInputEngine：webSpeech 与 whisper-local 下，消费侧可见行为一致", async () => {
    const observations = assertConsistent(await runMatrix(speechInputScenario, speechInputCases()));
    expect(observations).toHaveLength(2);
  });

  /**
   * 这一格是**已知不完整**：SPEC 指定的第二输出实现 `cloudTtsOutput` 来自
   * `stash@{0}`，而那个 stash 在当前仓库不存在（见 CORE-05 报告）。CORE-05-G
   * 因此没有整体 PASS，CORE-07 的这一行只能标 BLOCKED。
   *
   * 下面这条断言是**提醒**：第二实现一旦进来，它会失败——那时应当把这一格换成
   * 真正的两实现一致性断言，而不是把这里的期望值改大。
   */
  it("SpeechOutputEngine：矩阵缺第二实现（BLOCKED，见 CORE-05-G）", async () => {
    const cases = speechOutputCases();
    expect(cases).toHaveLength(1);

    // 唯一那个实现仍然跑得通场景本身，证明驱动可用、只是没有第二个对象可比。
    const result = await runMatrix(speechOutputScenario, cases);
    assertConsistent(result);
    expect(result.entries[0].observation).toEqual({ starts: 1, ends: 1, available: true });
  });
});
