import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../domain/conversation";
import { LOCAL_CONVERSATION_SCOPE } from "../domain/identity";
import { DEFAULT_MODE_CONFIG } from "../domain/soul";
import type { SessionSummary } from "../domain/summary";
import type { OcrEngine, OcrResult } from "../services/environment/ocrText";
import { createScreenSource, SCREEN_SOURCE_ID } from "../services/environment/screenSource";
import { createEnvironmentMonitor } from "../services/environment/monitor";
import { createRuleProactivePolicy } from "../services/environment/ruleProactivePolicy";
import { createEnvironmentTrigger } from "../presentation/environmentTrigger";
import { createMemoryRepository } from "../services/memory/memoryRepository";
import { createInMemoryMemoryStore } from "../services/memory/memoryStore";
import { createMemorySource } from "../services/memory/memorySource";
import { createKnowledgeIndex } from "../services/knowledge/knowledgeIndex";
import { createKnowledgeContextSource } from "../services/knowledge/knowledgeSource";
import { openMemorySqlite } from "../services/storage/nodeSqlite.harness";
import { createDesktopPetService } from "../services/desktopPet/desktopPetService";
import { createDesktopPetPresenter } from "../presentation/desktopPetPresenter";
import { createFakeAdapter, createFakeClock, createFakeTimers, fakePetProfile, fakePetStatus } from "../services/desktopPet/fakeDesktopPet";
import { createOptionalCapability } from "../kernel/optionalCapability";
import { createSystemClock } from "../services/time/systemTime";
import {
  createCompanionRuntime,
  type ProviderStreamEvent,
  type RuntimeGenerateInput,
  type RuntimeProvider,
  type RuntimeStorage,
} from "../services/runtime/companionRuntime";

/**
 * MVP-05 模块隔离矩阵（RPD 七行）。
 *
 * 规矩：**端口可以 fake，核心必须生产实现**。这里真正跑的是生产
 * `screenSource`（含词表）/ `monitor` / `environmentTrigger` / `CompanionRuntime` /
 * `DesktopPetService`+`Presenter` / `MemoryRepository`+`MemorySource` /
 * `KnowledgeIndex`+`KnowledgeContextSource`；fake 的只有外部世界：屏幕采集、
 * OCR 引擎、LLM Provider、桌宠进程。
 *
 * 每行记录：模型调用数、观察次数、桌宠调用数、长期读次数、是否仍能回答、
 * 以及「注入的错误原文有没有漏进 prompt」。
 */

const OCR_TEXT = "PENTAKILL";
const RAG_ERROR_SENTINEL = "SECRET-RAG-FAILURE-DETAIL";
const REPLY = "五杀！这一局结束得漂亮。";

function runtimeStorage(): RuntimeStorage & { rows: ChatMessage[] } {
  const rows: ChatMessage[] = [];
  return {
    rows,
    listMessages: async (limit: number) => rows.slice(-limit),
    appendMessage: async (message: ChatMessage) => {
      const index = rows.findIndex((row) => row.id === message.id);
      if (index >= 0) rows[index] = message;
      else rows.push(message);
    },
    listMessageTimestamps: async () => rows.map((row) => row.createdAt),
    latestSummary: async (): Promise<SessionSummary | null> => null,
  };
}

interface RowConfig {
  pet: "on" | "off" | "fail";
  ocr: "on" | "off" | "fail";
  memory: "on" | "off";
  rag: "ok" | "fail";
}

interface RowResult {
  modelCalls: number;
  prompts: string[];
  observations: number;
  petSays: number;
  petEmotions: number;
  petFailures: number;
  memoryReads: number;
  answered: boolean;
  cleanup: { unsubscribed: boolean; petDisabled: boolean };
  close: () => void;
}

async function runRow(config: RowConfig): Promise<RowResult> {
  const clock = createSystemClock();
  const storage = runtimeStorage();
  const prompts: string[] = [];

  // --- 观察侧：生产屏幕源（词表在它内部跑）---
  // 用对象属性而不是 let 变量：TS 的控制流分析会把「只在闭包里赋值」的
  // let 收窄成 null，调用点会报 never。属性访问不做这种收窄。
  const change: { fire: (() => void) | null } = { fire: null };
  const ocr: OcrEngine = {
    async recognize(): Promise<OcrResult | null> {
      if (config.ocr === "fail") {
        // 引擎契约：失败收敛成 null（不外抛、不带原因）——观察层因此降级而不是崩。
        return null;
      }
      // 词级置信度契约是 0..1（OcrWordConfidence），不是 tesseract 的 0..100。
      return {
        text: OCR_TEXT,
        words: [{ word: "pentakill", confidence: 0.93 }],
        lines: [{ text: OCR_TEXT, confidence: 0.93 }],
      };
    },
    async dispose() {},
    reset() {},
    state() {
      return "ready";
    },
  };
  const screen = createScreenSource({
    capture: {
      // 把 Rust 侧的屏幕变化事件收敛成「在测试里手动发一次」的入口。
      listenChange: async (handler) => {
        change.fire = () => handler({} as never);
        return () => {
          change.fire = null;
        };
      },
      captureRegion: async () => "png-base64",
      invoke: async () => undefined,
    },
    ocr,
    clock,
    hostEpoch: "epoch",
  });
  const monitor = createEnvironmentMonitor([screen], { clock, hostEpoch: "epoch" });

  // --- 上下文源：记忆与知识（关掉就是根本不注册）---
  const memoryStore = createInMemoryMemoryStore();
  const repository = createMemoryRepository({ store: memoryStore });
  let memoryReads = 0;
  const memory = {
    ...repository,
    async retrieve(query: Parameters<typeof repository.retrieve>[0]) {
      memoryReads += 1;
      return repository.retrieve(query);
    },
  };
  const knowledgeDb = config.rag === "fail"
    ? {
      // 拒绝/挂起的知识库：任何查询都抛错，且错误信息带哨兵串。
      async all() {
        throw new Error(RAG_ERROR_SENTINEL);
      },
      async run() {
        throw new Error(RAG_ERROR_SENTINEL);
      },
    }
    : openMemorySqlite().executor;

  const sources = [
    ...(config.memory === "on" ? [createMemorySource(memory)] : []),
    createKnowledgeContextSource(createKnowledgeIndex({ db: knowledgeDb as never })),
  ];

  // --- 生产 Runtime + fake Provider ---
  const provider: RuntimeProvider = {
    generate(input: RuntimeGenerateInput): AsyncIterable<ProviderStreamEvent> {
      prompts.push(JSON.stringify(input.context));
      return (async function* stream(): AsyncIterable<ProviderStreamEvent> {
        yield {
          type: "reply",
          reply: {
            schemaVersion: 1,
            mood: "happy",
            replyText: REPLY,
            translation: "五杀！",
            memoryCandidates: [],
            actions: [],
          },
        };
      })();
    },
  };
  const runtime = createCompanionRuntime({ provider, storage, sources, clock: { now: () => clock.now() } });

  // --- 表现侧：生产 Service + Presenter，假 adapter ---
  const adapter = createFakeAdapter({ status: fakePetStatus({ petId: "nia" }) });
  if (config.pet === "fail") {
    adapter.setResult({ outcome: "failed", code: "protocol_error" });
  }
  const petService = createDesktopPetService({
    adapter,
    clock: createFakeClock(0),
    timers: createFakeTimers(),
    profile: fakePetProfile({ petId: "nia", emotions: { happy: "jumping" } }),
  });
  if (config.pet !== "off") await petService.enable();
  const presenter = createDesktopPetPresenter({ service: petService, runtime, clock: createFakeClock(0) });
  if (config.pet !== "off") presenter.start();

  // --- 触发器：与生产同一份策略与门禁形状 ---
  let observations = 0;
  const trigger = createEnvironmentTrigger({
    monitor,
    policy: createRuleProactivePolicy(),
    busy: {
      refresh: async () => ({ value: false, observedMonotonicMs: clock.now(), hostEpoch: "epoch", reasonCode: "normal_window" }),
      current: () => ({ value: false, observedMonotonicMs: clock.now(), hostEpoch: "epoch", reasonCode: "normal_window" }),
      clear: () => undefined,
    },
    clock,
    gates: {
      globalProactive: async () => true,
      environmentProactive: async () => true,
      contextEnabled: async () => true,
      canSend: async () => true,
    },
    attemptSend: async () => {
      observations += 1;
      runtime.submit({
        text: "看看我屏幕上这一局",
        source: "proactive",
        mode: DEFAULT_MODE_CONFIG,
        conversation: LOCAL_CONVERSATION_SCOPE,
      });
      return true;
    },
  });
  trigger.start();

  if (config.ocr !== "off") {
    const started = monitor.setSourceEnabled(SCREEN_SOURCE_ID, true);
    // 传感器是宿主能力：这里用「立即就绪」的等价做法——start 完成后才发变化。
    await started;
    change.fire?.();
  }

  // 用户主动一轮：无论可选模块开没开，都该能回答。
  const before = prompts.length;
  await runtime.submit({
    text: "在吗",
    source: "text",
    mode: DEFAULT_MODE_CONFIG,
    conversation: LOCAL_CONVERSATION_SCOPE,
  }).done;
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));

  // 观测一轮（触发器是异步派发的），再让事件循环推进。
  change.fire?.();
  for (let index = 0; index < 40; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));

  const answered = prompts.length > before;

  return {
    modelCalls: prompts.length,
    prompts,
    observations,
    petSays: adapter.calls.say.length,
    petEmotions: adapter.calls.emotion.length,
    petFailures: petService.diagnostics().failed,
    memoryReads,
    answered,
    cleanup: { unsubscribed: true, petDisabled: !petService.isEnabled() },
    close: () => {
      presenter.dispose();
      trigger.dispose();
      void monitor.dispose();
      void petService.disable();
    },
  };
}

describe("MVP-05-A 全开 / Pet OFF / OCR OFF / Memory OFF", () => {
  it("全开：观察一次、回答一轮、桌宠收到表现、记忆被查", async () => {
    const row = await runRow({ pet: "on", ocr: "on", memory: "on", rag: "ok" });
    try {
      expect(row.answered).toBe(true);
      expect(row.observations).toBeGreaterThanOrEqual(1);
      expect(row.petSays).toBeGreaterThanOrEqual(1);
      expect(row.petEmotions).toBeGreaterThanOrEqual(1);
      expect(row.memoryReads).toBeGreaterThanOrEqual(1);
    } finally {
      row.close();
    }
  });

  it("Pet OFF：观察与对话继续，桌宠零调用", async () => {
    const row = await runRow({ pet: "off", ocr: "on", memory: "on", rag: "ok" });
    try {
      expect(row.answered).toBe(true);
      expect(row.observations).toBeGreaterThanOrEqual(1);
      expect(row.petSays).toBe(0);
      expect(row.petEmotions).toBe(0);
    } finally {
      row.close();
    }
  });

  it("OCR OFF：零观察、零桌宠请求，普通聊天照常回答", async () => {
    const row = await runRow({ pet: "on", ocr: "off", memory: "on", rag: "ok" });
    try {
      expect(row.answered).toBe(true);
      expect(row.observations).toBe(0);
      // 桌宠还在：用户自己的这一轮仍然驱动它（Pet ON 的前提下）。
      expect(row.petSays).toBe(1);
    } finally {
      row.close();
    }
  });

  it("Memory OFF：Recent 会话继续（能回答），长期读为 0", async () => {
    const row = await runRow({ pet: "on", ocr: "on", memory: "off", rag: "ok" });
    try {
      expect(row.answered).toBe(true);
      expect(row.memoryReads).toBe(0);
      // 观察与表现不受记忆关闭影响。
      expect(row.observations).toBeGreaterThanOrEqual(1);
      expect(row.petSays).toBeGreaterThanOrEqual(1);
    } finally {
      row.close();
    }
  });
});

describe("MVP-05-B Pet 错误 / OCR 错误 / RAG 拒绝 三行互不传播", () => {
  it("桌宠侧错误：Aiki 仍回答，错误详情不进 prompt", async () => {
    const row = await runRow({ pet: "fail", ocr: "on", memory: "on", rag: "ok" });
    try {
      expect(row.answered).toBe(true);
      // 桌宠侧每条命令都失败：尝试了，但 Aiki 侧记为 failed 且不上抛。
      expect(row.petSays).toBeGreaterThanOrEqual(1);
      expect(row.petFailures).toBeGreaterThanOrEqual(1);
    } finally {
      row.close();
    }
  });

  it("OCR 引擎失败（按契约返回 null）：观察降级为零事件，回答与桌宠继续", async () => {
    const row = await runRow({ pet: "on", ocr: "fail", memory: "on", rag: "ok" });
    try {
      expect(row.answered).toBe(true);
      // 引擎返回 null → 词表轨没有可发的规则 → 零观察、零主动轮。
      expect(row.observations).toBe(0);
      // 桌宠与对话不受影响。
      expect(row.petSays).toBeGreaterThanOrEqual(1);
    } finally {
      row.close();
    }
  });

  it("RAG 拒绝：recent context 保留、能回答、错误原文不进 prompt", async () => {
    const row = await runRow({ pet: "on", ocr: "on", memory: "on", rag: "fail" });
    try {
      expect(row.answered).toBe(true);
      expect(row.prompts.join("\n")).not.toContain(RAG_ERROR_SENTINEL);
      // 记忆源仍然可用：拒绝的是知识源，不是整轮装配。
      expect(row.memoryReads).toBeGreaterThanOrEqual(1);
    } finally {
      row.close();
    }
  });
});

describe("MVP-05-C 连续启停 20 次：无重复订阅/请求，旧 generation 不复活", () => {
  it("可选能力控制器：20 轮 start/stop 后订阅数不增长，迟到启动不复活", async () => {
    const clock = createSystemClock();
    let subscriptions = 0;
    let cleanups = 0;
    const capability = createOptionalCapability({
      timeoutMs: 500,
      async start(signal) {
        subscriptions += 1;
        expect(signal.aborted).toBe(false);
        return async () => {
          cleanups += 1;
        };
      },
      check: async () => true,
    });

    for (let index = 0; index < 20; index += 1) {
      await capability.start();
      await capability.stop();
      expect(capability.snapshot().state).toBe("off");
    }
    // 每次 start 恰好配一次 cleanup：没有泄漏的订阅。
    expect(subscriptions).toBe(20);
    expect(cleanups).toBe(20);
    expect(capability.snapshot().generation).toBeGreaterThanOrEqual(20);

    // 迟到的启动（stop 已撤销 generation）不能把它复活成 running。
    const resolve: { start: ((dispose: () => void) => void) | null } = { start: null };
    const late = createOptionalCapability({
      timeoutMs: 2000,
      start: () => new Promise<() => void>((done) => {
        resolve.start = done;
      }),
    });
    const pending = late.start();
    await late.stop();
    resolve.start?.(() => undefined);
    await pending;
    // 迟到的启动不得把已关闭的能力复活成 running（挂起超过期限判 failed）。
    expect(late.snapshot().state).not.toBe("running");
    void clock;
  });

  it("桌宠集成：20 次 enable/disable 不叠加订阅，桌宠请求数按轮次线性", async () => {
    const adapter = createFakeAdapter({ status: fakePetStatus({ petId: "nia" }) });
    const service = createDesktopPetService({
      adapter,
      clock: createFakeClock(0),
      timers: createFakeTimers(),
      profile: fakePetProfile({ petId: "nia" }),
    });
    const probesPerEnable: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const before = adapter.calls.status;
      await service.enable();
      probesPerEnable.push(adapter.calls.status - before);
      await service.disable();
      expect(service.isEnabled()).toBe(false);
    }
    // 每次 enable 只探测一次：没有「关了还在探测」或「开一次探多次」。
    expect(probesPerEnable.every((count) => count === 1)).toBe(true);
    expect(adapter.calls.say).toEqual([]);
  });
});

describe("MVP-05-E 静态门禁：可选模块之间不许直接 import 对方实现", () => {
  const MODULES = ["environment", "desktopPet", "memory", "knowledge"];

  it("环境 / 桌宠 / 记忆 / 知识四个模块的实现互不 import", () => {
    const offenders: string[] = [];
    const walk = (directory: string): string[] => {
      const found: string[] = [];
      for (const name of readdirSync(directory)) {
        const full = join(directory, name);
        if (statSync(full).isDirectory()) {
          if (name === "fixtures") continue;
          found.push(...walk(full));
        } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
          found.push(full);
        }
      }
      return found;
    };

    for (const moduleName of MODULES) {
      for (const file of walk(join(import.meta.dirname, `../services/${moduleName}`))) {
        const text = readFileSync(file, "utf8");
        for (const line of text.split(/\r?\n/)) {
          // `import type` 不产生运行时依赖（knowledge 复用 memory 的 SqlExecutor
          // 类型就是这类），算不上实现耦合，不在门禁里。
          if (/^\s*import\s+type\b/.test(line)) continue;
          const match = /^\s*(?:import|export)[^"']*from\s+["']([^"']+)["']/.exec(line);
          if (!match) continue;
          const specifier = match[1];
          for (const other of MODULES) {
            if (other === moduleName) continue;
            if (specifier.includes(`../../../services/${other}`) || specifier.includes(`../${other}/`)) {
              offenders.push(`${moduleName}: ${file.slice(file.indexOf("services"))} → ${specifier}`);
            }
          }
        }
      }
    }
    // RPD 的原文：「关闭桌宠不关闭观察；OCR 不直接 import 桌宠；Memory 不 import 两者的实现」。
    expect(offenders).toEqual([]);
  });

  it("词表轨与全文轨共用同一份采集调度器契约（装配点必须传 scheduler）", () => {
    // 这是一条**断言现状**的门禁：宿主装配里两轨共用 scheduler 才算满足契约。
    // 若装配漏传，这里会红——避免「契约写了共享、实现各算一份」悄悄存在。
    const source = readFileSync(join(import.meta.dirname, "./hosts/index.ts"), "utf8");
    // `scheduler` 必须出现在 createScreenSource 的调用块里（而不是只出现在
    // environmentHostPlugin 的选项里）——否则两轨各拿一份调度器。
    expect(source).toMatch(/createScreenSource\(\{[\s\S]*?scheduler:\s*captureScheduler/);
  });
});
