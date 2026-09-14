import { describe, expect, it } from "vitest";
import { createManualClock } from "./fakeEnvironment";
import { createCaptureScheduler } from "./captureScheduler";
import { createScreenContextSource, type WindowCaptureOutcome, type WindowCapturePort } from "./screenContextSource";
import { SCREEN_CONTEXT_TTL_MS } from "./screenContextProjection";
import type { OcrEngine, OcrResult } from "./ocrText";

/**
 * FE-32-D/E（会话与调度边界）+ FE-32-C 的模块出口部分。
 *
 * 全部用 fake capture / fake OCR：证明的是**编排与边界**，不是识别质量。
 * 识别质量（CER）与真实对话理解分别是 FE-32-A/B，另有独立证据。
 */

const PNG = "iVBORw0KGgo=";

interface FakeCapture extends WindowCapturePort {
  calls: Array<string | null>;
  queue: WindowCaptureOutcome[];
}

function fakeCapture(outcomes: WindowCaptureOutcome[]): FakeCapture {
  const port: FakeCapture = {
    calls: [],
    queue: [...outcomes],
    async captureWindow({ windowId }) {
      port.calls.push(windowId);
      return port.queue.shift() ?? { status: "unavailable" };
    },
  };
  return port;
}

function okFrame(windowId = "w1", processName = "chrome.exe"): WindowCaptureOutcome {
  return {
    status: "ok",
    frame: {
      pngBase64: PNG,
      window: { processName, windowId, monitorId: "primary" },
      region: { x: 10, y: 20, width: 800, height: 600 },
    },
  };
}

function fakeOcr(results: Array<OcrResult | null>): OcrEngine & { calls: number } {
  const engine = {
    calls: 0,
    async recognize(): Promise<OcrResult | null> {
      engine.calls += 1;
      return results.shift() ?? null;
    },
    async dispose() {},
    reset() {},
    state() {
      return "ready" as const;
    },
  };
  return engine;
}

const TEXT: OcrResult = {
  text: "错误：无法读取配置\nTypeError: cannot read property",
  words: [],
  lines: [
    { text: "错误：无法读取配置", confidence: 0.93 },
    { text: "TypeError: cannot read property", confidence: 0.91 },
  ],
};

function build(options: {
  capture: FakeCapture;
  ocr: OcrEngine;
  authorized?: boolean | (() => Promise<boolean>);
  clock?: ReturnType<typeof createManualClock>;
}) {
  const clock = options.clock ?? createManualClock(1000);
  const scheduler = createCaptureScheduler({ clock });
  const source = createScreenContextSource({
    capture: options.capture,
    ocr: options.ocr,
    scheduler,
    clock,
    getCaptureAuthorized: typeof options.authorized === "function"
      ? options.authorized
      : async () => (typeof options.authorized === "boolean" ? options.authorized : true),
  });
  return { clock, scheduler, source };
}

describe("readOnce 授权与采集边界（FE-32-C/D）", () => {
  it("未授权：零采集、零识别，状态是 unauthorized 而不是「没有文字」", async () => {
    const capture = fakeCapture([okFrame()]);
    const ocr = fakeOcr([TEXT]);
    const { source } = build({ capture, ocr, authorized: false });

    const result = await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(result.readStatus).toBe("unauthorized");
    expect(result.excerpts).toEqual([]);
    expect(capture.calls).toEqual([]);
    expect(ocr.calls).toBe(0);
    expect(source.current()).toBeNull();
  });

  it("授权读取抛错按未授权处理（fail-closed）", async () => {
    const capture = fakeCapture([okFrame()]);
    const { source } = build({
      capture,
      ocr: fakeOcr([TEXT]),
      authorized: async () => {
        throw new Error("storage down");
      },
    });
    const result = await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(result.readStatus).toBe("unauthorized");
    expect(capture.calls).toEqual([]);
  });

  it("静止画面的手动读屏照样采集，并给出窗口身份、区域与语言", async () => {
    const capture = fakeCapture([okFrame()]);
    const { source } = build({ capture, ocr: fakeOcr([TEXT]) });

    const result = await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(result.readStatus).toBe("ok");
    expect(result.excerpts.map((item) => item.text)).toEqual([
      "错误：无法读取配置",
      "TypeError: cannot read property",
    ]);
    expect(result.window).toEqual({ processName: "chrome.exe", windowId: "w1", monitorId: "primary" });
    expect(result.region).toEqual({ x: 10, y: 20, width: 800, height: 600 });
    expect(result.language).toBe("mixed");
    expect(result.sourceTrust).toBe("environment");
    // 原图不出本模块：结果里没有任何 base64。
    expect(JSON.stringify(result)).not.toContain(PNG);
  });

  it("点 pet 之后前台是自己：改读点击前记下的外部窗口，不读自己的气泡", async () => {
    const capture = fakeCapture([okFrame("w-code", "Code.exe"), { status: "self_window" }, okFrame("w-code", "Code.exe")]);
    const { source } = build({ capture, ocr: fakeOcr([TEXT, TEXT]) });

    await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(source.lastExternalWindow()?.windowId).toBe("w-code");

    const second = await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(second.readStatus).toBe("ok");
    expect(second.window?.processName).toBe("Code.exe");
    // 第二轮先问当前前台（null），拿到 self_window 后带着记住的窗口重新验证。
    expect(capture.calls).toEqual([null, null, "w-code"]);
  });

  it("没有可用外部窗口时报 unavailable，不返回虚构描述", async () => {
    const capture = fakeCapture([{ status: "self_window" }]);
    const { source } = build({ capture, ocr: fakeOcr([TEXT]) });
    const result = await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(result.readStatus).toBe("unavailable");
    expect(result.excerpts).toEqual([]);
  });

  it("自身窗口盖住目标区域：self_obscured，不硬读", async () => {
    const capture = fakeCapture([{ status: "obscured" }]);
    const { source } = build({ capture, ocr: fakeOcr([TEXT]) });
    const result = await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(result.readStatus).toBe("self_obscured");
  });

  it("识别超时/失败 → timeout；识别到空白 → empty；低置信 → low_confidence", async () => {
    const captureA = fakeCapture([okFrame()]);
    const a = build({ capture: captureA, ocr: fakeOcr([null]) });
    expect((await a.source.readOnce({ reason: "manual", sessionGeneration: 1 })).readStatus).toBe("timeout");

    const captureB = fakeCapture([okFrame()]);
    const b = build({ capture: captureB, ocr: fakeOcr([{ text: "", words: [], lines: [] }]) });
    expect((await b.source.readOnce({ reason: "manual", sessionGeneration: 1 })).readStatus).toBe("empty");

    const captureC = fakeCapture([okFrame()]);
    const c = build({
      capture: captureC,
      ocr: fakeOcr([{ text: "blurry", words: [], lines: [{ text: "blurry", confidence: 0.4 }] }]),
    });
    const low = await c.source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(low.readStatus).toBe("low_confidence");
    expect(low.excerpts[0].confidence).toBe(0.4);
  });
});

describe("TTL、撤销与迟到结果（FE-32-D/E）", () => {
  it("TTL 60 秒从采集计时；过期后 current 为空", async () => {
    const clock = createManualClock(1000);
    const capture = fakeCapture([okFrame()]);
    const { source } = build({ capture, ocr: fakeOcr([TEXT]), clock });

    const result = await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(result.expiresAtMonotonicMs).toBe(result.capturedMonotonicMs + SCREEN_CONTEXT_TTL_MS);
    expect(source.current()).not.toBeNull();

    clock.advance(SCREEN_CONTEXT_TTL_MS - 1);
    expect(source.current()).not.toBeNull();
    clock.advance(1);
    expect(source.current()).toBeNull();
  });

  it("暂停（clear）清空全文与摘录", async () => {
    const capture = fakeCapture([okFrame()]);
    const { source } = build({ capture, ocr: fakeOcr([TEXT]) });
    await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(source.current()).not.toBeNull();
    source.clear();
    expect(source.current()).toBeNull();
  });

  it("会话撤销：旧 generation 的请求与已落地结果一起作废", async () => {
    const capture = fakeCapture([okFrame(), okFrame()]);
    const { source } = build({ capture, ocr: fakeOcr([TEXT, TEXT]) });
    await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(source.current()).not.toBeNull();

    source.revoke(2);
    expect(source.current()).toBeNull();
    const stale = await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(stale.readStatus).toBe("cancelled");
    // 旧 generation 连采集都不发起。
    expect(capture.calls).toEqual([null]);
  });

  it("请求构建中撤销：迟到的识别结果不落地", async () => {
    let release!: (value: OcrResult | null) => void;
    const pending = new Promise<OcrResult | null>((resolve) => {
      release = resolve;
    });
    const capture = fakeCapture([okFrame()]);
    const ocr: OcrEngine = {
      async recognize() {
        return pending;
      },
      async dispose() {},
      reset() {},
      state() {
        return "ready";
      },
    };
    const { source } = build({ capture, ocr });

    const inflight = source.readOnce({ reason: "manual", sessionGeneration: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    source.revoke(2);
    release(TEXT);

    const result = await inflight;
    expect(result.readStatus).toBe("cancelled");
    expect(result.excerpts).toEqual([]);
    expect(source.current()).toBeNull();
  });

  it("signal abort：状态为 cancelled，latest 不被覆盖", async () => {
    const capture = fakeCapture([okFrame(), okFrame()]);
    const { source } = build({ capture, ocr: fakeOcr([TEXT, TEXT]) });
    await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    const before = source.current();

    const controller = new AbortController();
    controller.abort();
    const cancelled = await source.readOnce({ reason: "manual", sessionGeneration: 1, signal: controller.signal });
    expect(cancelled.readStatus).toBe("cancelled");
    expect(source.current()).toBe(before);
  });
});

describe("手动/自动竞争与限流可见（FE-32-E）", () => {
  it("手动优先：排队中的自动候选被替换，状态是 superseded", async () => {
    let release!: (value: OcrResult | null) => void;
    const first = new Promise<OcrResult | null>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const ocr: OcrEngine = {
      async recognize() {
        call += 1;
        return call === 1 ? first : TEXT;
      },
      async dispose() {},
      reset() {},
      state() {
        return "ready";
      },
    };
    const capture = fakeCapture([okFrame(), okFrame(), okFrame()]);
    const { source } = build({ capture, ocr });

    const running = source.readOnce({ reason: "change", sessionGeneration: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queuedAuto = source.readOnce({ reason: "change", sessionGeneration: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const manual = source.readOnce({ reason: "manual", sessionGeneration: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await queuedAuto).readStatus).toBe("superseded");
    release(TEXT);
    expect((await running).readStatus).toBe("ok");
    expect((await manual).readStatus).toBe("ok");
  });

  it("额度用尽：手动也被限流，并带出下一次可用时间", async () => {
    const clock = createManualClock(1000);
    const capture = fakeCapture(Array.from({ length: 12 }, () => okFrame()));
    const { source } = build({
      capture,
      ocr: fakeOcr(Array.from({ length: 12 }, () => TEXT)),
      clock,
    });

    for (let index = 0; index < 10; index += 1) {
      const outcome = await source.readOnce({ reason: "change", sessionGeneration: 1 });
      expect(outcome.readStatus).toBe("ok");
      clock.advance(100);
    }
    const blocked = await source.readOnce({ reason: "manual", sessionGeneration: 1 });
    expect(blocked.readStatus).toBe("rate_limited");
    expect(blocked.retryAtMonotonicMs).toBe(1000 + 60_000);
    expect(source.quota()).toEqual({ used: 10, limit: 10, retryAtMonotonicMs: 61_000 });
  });
});
