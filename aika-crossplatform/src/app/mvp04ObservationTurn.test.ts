import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../domain/conversation";
import { DEFAULT_MODE_CONFIG } from "../domain/soul";
import type { SessionSummary } from "../domain/summary";
import { createFakeEnvironmentSource, createManualClock, fakeEventInput } from "../services/environment/fakeEnvironment";
import { createEnvironmentMonitor } from "../services/environment/monitor";
import { createEnvironmentContextSource, createScreenTextContextSource } from "../services/environment/contextSource";
import { createRuleProactivePolicy } from "../services/environment/ruleProactivePolicy";
import {
  SCREEN_CONTEXT_SCHEMA_VERSION,
  SCREEN_CONTEXT_SOURCE_ID,
} from "../services/environment/screenContextProjection";
import { createEnvironmentTrigger } from "../presentation/environmentTrigger";
import { createDesktopPetPresenter } from "../presentation/desktopPetPresenter";
import { createDesktopPetService } from "../services/desktopPet/desktopPetService";
import { createFakeAdapter, createFakeClock, createFakeTimers, fakePetProfile, fakePetStatus } from "../services/desktopPet/fakeDesktopPet";
import {
  createCompanionRuntime,
  type ProviderStreamEvent,
  type RuntimeProvider,
  type RuntimeStorage,
} from "../services/runtime/companionRuntime";

/**
 * MVP-04-C：生产规则 → 上下文源 → 生产 Runtime → fake Provider → 表现端口。
 *
 * 这条链上除了外部世界（传感器、LLM、桌宠进程）之外**全部是生产实现**：
 * `environmentTrigger` / `ruleProactivePolicy` / `contextSource` / `CompanionRuntime` /
 * `desktopPetPresenter`。断言的是「恰好一次生成、上下文里带着这次观察」以及
 * 「OCR 原文没有授权就出不去」。
 */

const OCR_RAW = "OCR-原文：这一行只该留在本机";

function createStorage(): RuntimeStorage & { rows: ChatMessage[] } {
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

/** 记录被组装出来的上下文，并立刻给出一个终包（不模拟流式）。 */
function createRecordingProvider() {
  const seen: string[] = [];
  const provider: RuntimeProvider = {
    generate(input) {
      seen.push(JSON.stringify(input.context));
      return (async function* stream(): AsyncIterable<ProviderStreamEvent> {
        yield {
          type: "reply",
          reply: {
            schemaVersion: 1,
            mood: "happy",
            replyText: "五杀！这一局结束得漂亮。",
            translation: "五杀！",
            memoryCandidates: [],
            actions: [],
          },
        };
      })();
    },
  };
  return { provider, seen };
}

async function flush(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function screenResult(capturedAt: number) {
  return {
    schemaVersion: SCREEN_CONTEXT_SCHEMA_VERSION,
    id: `ctx-${capturedAt}`,
    sourceId: SCREEN_CONTEXT_SOURCE_ID,
    sourceTrust: "environment",
    captureGeneration: 1,
    sessionGeneration: 1,
    reason: "change",
    window: { processName: "game.exe", windowId: "w1", monitorId: "primary" },
    region: { x: 0, y: 0, width: 400, height: 300 },
    capturedMonotonicMs: capturedAt,
    expiresAtMonotonicMs: capturedAt + 60_000,
    language: "en",
    confidence: 0.93,
    readStatus: "ok",
    excerpts: [{ order: 0, text: OCR_RAW, confidence: 0.93, truncated: false }],
    truncated: false,
    retryAtMonotonicMs: null,
  } as const;
}

interface Harness {
  emitPentakill(): void;
  readonly generations: string[];
  readonly petSays: string[];
  readonly petEmotions: string[];
}

async function setup(options: { screenTextEnabled: boolean; captureAuthorized?: boolean }): Promise<Harness> {
  const clock = createManualClock(0);
  // 1. 观察：生产 monitor + 假传感器（传感器是宿主能力，fake 天经地义）。
  const screen = createFakeEnvironmentSource({ id: "screen" });
  const monitor = createEnvironmentMonitor([screen], { clock, hostEpoch: "test-epoch" });
  const started = monitor.setSourceEnabled("screen", true);
  screen.resolveStart();
  await started;

  // 2. 上下文源：环境摘要 + 屏幕文字摘录，两者各自授权（生产实现）。
  const environmentSource = createEnvironmentContextSource({
    monitor,
    clock,
    getContextEnabled: async () => true,
  });
  const screenTextSource = createScreenTextContextSource({
    current: (now) => (now < 60_000 ? screenResult(0) : null),
    getScreenTextEnabled: async () => options.screenTextEnabled,
    clock,
  });

  // 3. 生产 Runtime + fake Provider。
  const storage = createStorage();
  const recording = createRecordingProvider();
  const runtime = createCompanionRuntime({
    provider: recording.provider,
    storage,
    sources: [environmentSource, screenTextSource],
    clock: { now: () => clock.now() },
  });

  // 4. 表现端口：桌宠展示桥接 + 生产 Service（假 adapter 记录真实命令）。
  const adapter = createFakeAdapter({ status: fakePetStatus({ petId: "nia" }) });
  const service = createDesktopPetService({
    adapter,
    clock: createFakeClock(0),
    timers: createFakeTimers(),
    profile: fakePetProfile({ petId: "nia", emotions: { happy: "jumping" } }),
  });
  await service.enable();
  const presenter = createDesktopPetPresenter({ service, runtime, clock: createFakeClock(0) });
  presenter.start();

  // 5. 触发器：与生产同一份策略与门禁形状。
  const trigger = createEnvironmentTrigger({
    monitor,
    policy: createRuleProactivePolicy(),
    busy: {
      refresh: async () => ({ value: false, observedMonotonicMs: clock.now(), hostEpoch: "e", reasonCode: "normal_window" }),
      current: () => ({ value: false, observedMonotonicMs: clock.now(), hostEpoch: "e", reasonCode: "normal_window" }),
      clear: () => undefined,
    },
    clock,
    gates: {
      globalProactive: async () => true,
      environmentProactive: async () => true,
      contextEnabled: async () => true,
      canSend: async () => true,
    },
    attemptSend: async (event, reasonKind) => {
      runtime.submit({
        text: `[${reasonKind}] ${event.eventId}`,
        source: "proactive",
        mode: DEFAULT_MODE_CONFIG,
      });
      return true;
    },
  });
  trigger.start();

  return {
    get generations() {
      return recording.seen;
    },
    get petSays() {
      return adapter.calls.say;
    },
    get petEmotions() {
      return adapter.calls.emotion;
    },
    emitPentakill() {
      screen.emit(fakeEventInput({
        payload: { kind: "game_event", event: "pentakill" },
        sourceId: "screen",
        confidence: 0.93,
      }));
    },
  };
}

describe("MVP-04-C 一次观察 → 一次生成 → 表现端口", () => {
  it("重复帧只产生一次生成，上下文带着这次观察，桌宠收到正文与情绪", async () => {
    const h = await setup({ screenTextEnabled: false });
    // 同一屏被识别两次（重复帧）：去重后只有一次观察、一次生成。
    h.emitPentakill();
    h.emitPentakill();
    await flush();

    expect(h.generations).toHaveLength(1);
    // 上下文里带着这次观察的受控规则 ID（不是 OCR 原文）。
    expect(h.generations[0]).toMatch(/pentakill/i);
    // 表现端口：正文与情绪都经生产桥接发给了桌宠。
    expect(h.petSays).toEqual(["五杀！这一局结束得漂亮。"]);
    expect(h.petEmotions).toEqual(["happy"]);
  });

  it("屏幕文字授权开着时摘录随上下文进入；关着时一句都不出（AC-E）", async () => {
    const opened = await setup({ screenTextEnabled: true });
    opened.emitPentakill();
    await flush();
    expect(opened.generations).toHaveLength(1);
    expect(opened.generations[0]).toContain(OCR_RAW);

    const closed = await setup({ screenTextEnabled: false });
    closed.emitPentakill();
    await flush();
    expect(closed.generations).toHaveLength(1);
    expect(closed.generations[0]).toMatch(/pentakill/i);
    expect(closed.generations[0]).not.toContain(OCR_RAW);
  });

  it("传感器没跑起来时：零观察、零生成（关闭就是关闭）", async () => {
    const clock = createManualClock(0);
    const screen = createFakeEnvironmentSource({ id: "screen" });
    const monitor = createEnvironmentMonitor([screen], { clock, hostEpoch: "test-epoch" });
    // 刻意不 enable：source 停在 off。
    const recording = createRecordingProvider();
    const trigger = createEnvironmentTrigger({
      monitor,
      policy: createRuleProactivePolicy(),
      busy: null,
      clock,
      gates: {
        globalProactive: async () => true,
        environmentProactive: async () => true,
        contextEnabled: async () => true,
        canSend: async () => true,
      },
      attemptSend: async () => true,
    });
    trigger.start();
    screen.emit(fakeEventInput({
      payload: { kind: "game_event", event: "pentakill" },
      sourceId: "screen",
      confidence: 0.93,
    }));
    await flush();
    // monitor 没有运行中的 source：事件进不来，一次生成都没有。
    expect(monitor.recent()).toEqual([]);
    expect(recording.seen).toEqual([]);
  });
});

describe("MVP-04-C OCR 不直接调用桌宠（边界检查）", () => {
  it("环境/观察层的源码里没有桌宠与表现层的 import", () => {
    const directory = join(import.meta.dirname, "../services/environment");
    const offenders: string[] = [];
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(directory, name), "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (/^\s*(import|export).*from\s+["'].*(desktopPet|presentation)/.test(line)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    // 观察层只认识 domain/environment 与自己的契约；桌宠是表现层的事。
    expect(offenders).toEqual([]);
  });
});
