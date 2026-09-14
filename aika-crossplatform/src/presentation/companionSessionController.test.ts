import { describe, expect, it } from "vitest";
import { createManualClock } from "../services/environment/fakeEnvironment";
import { createCaptureScheduler } from "../services/environment/captureScheduler";
import { createScreenContextSource, type WindowCaptureOutcome, type WindowCapturePort } from "../services/environment/screenContextSource";
import type { OcrEngine, OcrResult } from "../services/environment/ocrText";
import { SETTING_KEYS } from "../services/storage/contracts";
import { COMPANION_INTENT_SCHEMA, type CompanionIntentV1, type CompanionIntentKind } from "./companionIntent";
import {
  SCREEN_TALK_TEXT,
  createCompanionSessionController,
  type CompanionSessionController,
} from "./companionSessionController";

/**
 * FE-31-A～F（生产逻辑轨）。
 *
 * 外部端口（采集、OCR、可选视图端口、发送路径）全部是 fake：证明的是**会话控制、
 * 门禁与撤销**，不是真实读屏、真实回复或真实角色表现。FE-31-G（真实设备逐项
 * 演示）不在本文件，记 NOT RUN。
 */

const PNG = "iVBORw0KGgo=";

function okFrame(windowId = "w1"): WindowCaptureOutcome {
  return {
    status: "ok",
    frame: {
      pngBase64: PNG,
      window: { processName: "chrome.exe", windowId, monitorId: "primary" },
      region: { x: 0, y: 0, width: 800, height: 600 },
    },
  };
}

function lines(text: string, confidence = 0.92): OcrResult {
  return { text, words: [], lines: [{ text, confidence }] };
}

interface Harness {
  controller: CompanionSessionController;
  clock: ReturnType<typeof createManualClock>;
  capture: WindowCapturePort & { calls: number };
  submitted: Array<{ text: string; trigger: string }>;
  proactive: number;
  viewCalls: string[];
  settingsStore: Map<string, string>;
  sensorCalls: boolean[];
  setOcr(next: () => OcrResult | null): void;
  failSensor(error: Error): void;
  setSubmitUser(fn: (input: { text: string; trigger: string }) => Promise<boolean>): void;
}

function harness(options?: { captureAuthorized?: boolean }): Harness {
  const clock = createManualClock(1000);
  const scheduler = createCaptureScheduler({ clock });
  let ocrNext: () => OcrResult | null = () => lines("第一屏的内容 alpha");
  const capture = {
    calls: 0,
    async captureWindow() {
      capture.calls += 1;
      return okFrame();
    },
  };
  const ocr: OcrEngine = {
    async recognize() {
      return ocrNext();
    },
    async dispose() {},
    reset() {},
    state() {
      return "ready";
    },
  };
  const screenContext = createScreenContextSource({
    capture,
    ocr,
    scheduler,
    clock,
    getCaptureAuthorized: async () => options?.captureAuthorized ?? true,
  });

  const settingsStore = new Map<string, string>();
  const sensorCalls: boolean[] = [];
  let sensorError: Error | null = null;
  const submitted: Array<{ text: string; trigger: string }> = [];
  const viewCalls: string[] = [];
  const state = { proactive: 0 };
  let submitUser = async (input: { text: string; trigger: string }) => {
    submitted.push(input);
    return true;
  };

  const controller = createCompanionSessionController({
    screenContext,
    sensors: {
      async setScreenEnabled(enabled) {
        sensorCalls.push(enabled);
        if (enabled && sensorError) throw sensorError;
      },
    },
    settings: {
      async getString(key) {
        return settingsStore.get(key) ?? null;
      },
      async setString(key, value) {
        settingsStore.set(key, value);
      },
      async getBoolean(key, fallback) {
        const raw = settingsStore.get(key);
        return raw === undefined ? fallback : raw === "true";
      },
      async setBoolean(key, value) {
        settingsStore.set(key, String(value));
      },
    },
    // 主窗不再拥有任何桌宠窗口（MVP-03 删掉了自研窗口），所以只给可选视图端口。
    // 不传也能工作：会话控制不该依赖某个窗口是否存在。
    view: {
      async open() {
        viewCalls.push("open");
      },
      async close() {
        viewCalls.push("close");
      },
      async focusMain() {
        viewCalls.push("focusMain");
      },
    },
    submitUser: (input) => submitUser(input),
    submitProactive: async () => {
      state.proactive += 1;
      return true;
    },
    clock,
  });

  return {
    controller,
    clock,
    capture,
    submitted,
    get proactive() {
      return state.proactive;
    },
    viewCalls,
    settingsStore,
    sensorCalls,
    setOcr(next) {
      ocrNext = next;
    },
    failSensor(error) {
      sensorError = error;
    },
    setSubmitUser(fn) {
      submitUser = fn;
    },
  };
}

function intent(kind: CompanionIntentKind, overrides: Partial<CompanionIntentV1> = {}): CompanionIntentV1 {
  return {
    schemaVersion: COMPANION_INTENT_SCHEMA,
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    sessionEpoch: "epoch-1",
    kind,
    text: kind === "talk" ? "聊两句" : null,
    ...overrides,
  };
}

/** 让自动路径越过「稳定 ≥3 秒」这道门：同一屏观察两次，中间推进时钟。 */
async function settleAuto(h: Harness): Promise<void> {
  await h.controller.onScreenChanged();
  h.clock.advance(3000);
  await h.controller.onScreenChanged();
}

describe("FE-31-A 默认关闭与一次确认", () => {
  it("默认 off；没有一次确认时点开启不会启动采集", async () => {
    const h = harness();
    await h.controller.start();
    expect(h.controller.getSnapshot().mode).toBe("off");
    expect(h.controller.hasConsent()).toBe(false);

    const ok = await h.controller.enable("active");
    expect(ok).toBe(false);
    expect(h.sensorCalls).toEqual([]);
    expect(h.controller.getSnapshot().readState).toBe("denied");
    expect(h.controller.getSnapshot().notice).toContain("确认采集范围");
  });

  it("一次确认后进入 running；之后再开不需要重复确认，也不用逐个找开关", async () => {
    const h = harness();
    await h.controller.start();
    expect(await h.controller.enable("active", { consent: true })).toBe(true);

    const view = h.controller.getSnapshot();
    expect(view.mode).toBe("active");
    expect(view.readState).toBe("reading");
    expect(h.sensorCalls).toEqual([true]);
    expect(h.viewCalls).toEqual(["open"]);
    expect(h.settingsStore.get(SETTING_KEYS.companionConsent)).toBe("true");
    expect(h.settingsStore.get(SETTING_KEYS.companionMode)).toBe("active");

    await h.controller.end();
    expect(await h.controller.enable("quiet")).toBe(true);
    expect(h.controller.getSnapshot().mode).toBe("quiet");
  });

  it("应用启动本身不采集：start 只读回上次选择，不启动传感器", async () => {
    const h = harness();
    h.settingsStore.set(SETTING_KEYS.companionConsent, "true");
    h.settingsStore.set(SETTING_KEYS.companionMode, "active");
    await h.controller.start();
    expect(h.controller.getSnapshot().mode).toBe("active");
    expect(h.controller.getSnapshot().readState).toBe("off");
    expect(h.sensorCalls).toEqual([]);
  });

  it("启动失败：清理资源、显示失败，不留下半开状态", async () => {
    const h = harness();
    await h.controller.start();
    h.failSensor(new Error("permission denied by user"));

    expect(await h.controller.enable("active", { consent: true })).toBe(false);
    const view = h.controller.getSnapshot();
    expect(view.readState).toBe("denied");
    expect(view.mode).toBe("off");
    // 开启失败后有一次显式的停用清理。
    expect(h.sensorCalls).toEqual([true, false]);
  });
});

describe("FE-31-B active / quiet 的自动路径", () => {
  it("active：画面有意义变化形成候选并发送；同一屏不重复请求", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("active", { consent: true });

    await settleAuto(h);
    expect(h.proactive).toBe(1);

    // 同一屏再变化：差异不足 20%，不重复发。
    h.clock.advance(5000);
    await h.controller.onScreenChanged();
    expect(h.proactive).toBe(1);

    // 换一屏且稳定够久：再发一条。
    h.setOcr(() => lines("完全不同的另一屏 beta gamma delta"));
    await settleAuto(h);
    expect(h.proactive).toBe(2);
  });

  it("内容没稳定够 3 秒不发（闪一下不算）", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("active", { consent: true });

    await h.controller.onScreenChanged();
    h.clock.advance(2999);
    await h.controller.onScreenChanged();
    expect(h.proactive).toBe(0);
    h.clock.advance(1);
    await h.controller.onScreenChanged();
    expect(h.proactive).toBe(1);
  });

  it("低置信度的段不作为自动候选", async () => {
    const h = harness();
    h.setOcr(() => lines("模糊的一屏内容", 0.4));
    await h.controller.start();
    await h.controller.enable("active", { consent: true });
    await settleAuto(h);
    expect(h.proactive).toBe(0);
  });

  it("quiet：OCR 照常更新本地上下文，但自动提交为 0", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("quiet", { consent: true });

    await settleAuto(h);
    expect(h.proactive).toBe(0);
    expect(h.capture.calls).toBeGreaterThan(0);
    expect(h.controller.getSnapshot().lastReadStatus).toBe("ok");
  });

  it("active → quiet 之后不再自动发送（切模式不需要重开采集）", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("active", { consent: true });
    await h.controller.setMode("quiet");

    await settleAuto(h);
    expect(h.proactive).toBe(0);
    // 没有为了切模式而重启采集。
    expect(h.sensorCalls).toEqual([true]);
  });
});

describe("FE-31-C/D 意图（视图端口）与普通输入", () => {
  it("screen_talk：静止画面也触发一次新 OCR，并走用户发送路径", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("active", { consent: true });
    const before = h.capture.calls;

    expect(await h.controller.handleIntent(intent("screen_talk"), "epoch-1")).toBe(true);
    expect(h.capture.calls).toBe(before + 1);
    expect(h.submitted).toEqual([{ text: SCREEN_TALK_TEXT, trigger: "pet_screen_talk" }]);
  });

  it("screen_talk 在 quiet、主动关闭、暂停时依然可用（不受主动额度限制）", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("quiet", { consent: true });
    expect(await h.controller.handleIntent(intent("screen_talk"), "epoch-1")).toBe(true);

    await h.controller.pause();
    expect(h.controller.getSnapshot().readState).toBe("paused");
    expect(await h.controller.handleIntent(intent("screen_talk"), "epoch-1")).toBe(true);
    expect(h.submitted).toHaveLength(2);
  });

  it("读屏失败：提示「未读到屏幕」，对话仍然继续，且不编造页面内容", async () => {
    const h = harness();
    h.setOcr(() => null); // OCR 超时/失败
    await h.controller.start();
    await h.controller.enable("active", { consent: true });

    expect(await h.controller.handleIntent(intent("screen_talk"), "epoch-1")).toBe(true);
    const view = h.controller.getSnapshot();
    expect(view.lastReadStatus).toBe("timeout");
    expect(view.notice).toContain("没读完屏幕");
    // 发出去的仍然只有那句固定的用户动作文本，没有任何页面内容。
    expect(h.submitted).toEqual([{ text: SCREEN_TALK_TEXT, trigger: "pet_screen_talk" }]);
  });

  it("没有屏幕权限也能普通聊天（talk 不碰采集）", async () => {
    const h = harness({ captureAuthorized: false });
    await h.controller.start();
    await h.controller.enable("quiet", { consent: true });

    expect(await h.controller.handleIntent(intent("talk", { text: "在吗" }), "epoch-1")).toBe(true);
    expect(h.submitted).toEqual([{ text: "在吗", trigger: "pet_talk" }]);
    expect(h.capture.calls).toBe(0);
  });

  it("发送中的重复点击只接受一次，并显示状态（不静默丢弃）", async () => {
    const h = harness();
    let release!: (value: boolean) => void;
    h.setSubmitUser(() => new Promise<boolean>((resolve) => {
      release = resolve;
    }));
    await h.controller.start();
    await h.controller.enable("active", { consent: true });

    const first = h.controller.handleIntent(intent("talk", { text: "第一句" }), "epoch-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await h.controller.handleIntent(intent("talk", { text: "第一句" }), "epoch-1");
    expect(second).toBe(false);
    expect(h.controller.getSnapshot().notice).toContain("还在发送中");

    release(true);
    expect(await first).toBe(true);
  });

  it("同一个 requestId 重放只发一轮（双击/重放）", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("active", { consent: true });
    const replayed = intent("talk", { text: "只发一次" });

    expect(await h.controller.handleIntent(replayed, "epoch-1")).toBe(true);
    expect(await h.controller.handleIntent(replayed, "epoch-1")).toBe(false);
    expect(h.submitted).toHaveLength(1);
  });

  it("open_main / pause_reading / end_session 走会话控制，不发消息", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("active", { consent: true });

    await h.controller.handleIntent(intent("open_main"), "epoch-1");
    expect(h.viewCalls).toContain("focusMain");

    await h.controller.handleIntent(intent("pause_reading"), "epoch-1");
    expect(h.controller.getSnapshot().readState).toBe("paused");

    await h.controller.handleIntent(intent("end_session"), "epoch-1");
    expect(h.controller.getSnapshot().mode).toBe("off");
    expect(h.viewCalls).toContain("close");
    expect(h.submitted).toEqual([]);
  });
});

describe("FE-31-E 暂停/结束/撤销与迟到结果", () => {
  it("暂停：停采集、清空上下文与候选，可选视图保留，普通聊天仍可用", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("active", { consent: true });
    await settleAuto(h);
    expect(h.proactive).toBe(1);

    await h.controller.pause();
    expect(h.sensorCalls).toEqual([true, false]);
    expect(h.viewCalls).toEqual(["open"]); // 没有 close：可选视图保留

    // 暂停后自动路径彻底不动。
    h.setOcr(() => lines("暂停之后的新一屏 epsilon"));
    await settleAuto(h);
    expect(h.proactive).toBe(1);

    expect(await h.controller.handleIntent(intent("talk", { text: "还能聊" }), "epoch-1")).toBe(true);
  });

  it("结束：撤销代数、停自己的采集、清缓存并关闭可选视图", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("active", { consent: true });
    const before = h.controller.getSnapshot().generation;

    await h.controller.end();
    const view = h.controller.getSnapshot();
    expect(view.mode).toBe("off");
    expect(view.readState).toBe("off");
    expect(view.generation).toBeGreaterThan(before);
    expect(h.sensorCalls).toEqual([true, false]);
    expect(h.viewCalls).toEqual(["open", "close"]);
    expect(h.settingsStore.get(SETTING_KEYS.companionMode)).toBe("off");
  });

  it("采集/识别期间结束：迟到的结果不形成候选、不外发", async () => {
    const h = harness();
    let release!: (value: OcrResult | null) => void;
    const pending = new Promise<OcrResult | null>((resolve) => {
      release = resolve;
    });
    await h.controller.start();
    await h.controller.enable("active", { consent: true });
    // 先让一屏稳定下来，确保只差「发送」这一步。
    await h.controller.onScreenChanged();
    h.clock.advance(3000);

    h.setOcr(() => pending as unknown as OcrResult);
    const inflight = h.controller.onScreenChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.controller.end();
    release(lines("第一屏的内容 alpha"));
    await inflight;

    expect(h.proactive).toBe(0);
  });

  it("全局「停止全部感知」：会话读屏标为暂停，不冒充仍在运行", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("active", { consent: true });
    h.controller.markStoppedExternally();
    expect(h.controller.getSnapshot().readState).toBe("paused");

    await settleAuto(h);
    expect(h.proactive).toBe(0);
  });
});

describe("FE-31-F 越权与竞争", () => {
  it("旧 sessionEpoch 的意图被丢弃", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.enable("active", { consent: true });

    expect(await h.controller.handleIntent(intent("talk", { sessionEpoch: "epoch-0" }), "epoch-1")).toBe(false);
    expect(h.submitted).toEqual([]);
  });

  it("用户点击与自动事件同刻：最多提交用户那一轮，自动候选被撤销", async () => {
    const h = harness();
    let releaseUser!: (value: boolean) => void;
    h.setSubmitUser((input) => {
      h.submitted.push(input);
      return new Promise<boolean>((resolve) => {
        releaseUser = resolve;
      });
    });
    await h.controller.start();
    await h.controller.enable("active", { consent: true });

    // 自动路径已经观察到稳定的一屏，只差最后一步。
    await h.controller.onScreenChanged();
    h.clock.advance(3000);

    const userTurn = h.controller.handleIntent(intent("talk", { text: "我先说" }), "epoch-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.controller.onScreenChanged();

    expect(h.proactive).toBe(0);
    releaseUser(true);
    expect(await userTurn).toBe(true);
    expect(h.submitted).toEqual([{ text: "我先说", trigger: "pet_talk" }]);
  });
});
