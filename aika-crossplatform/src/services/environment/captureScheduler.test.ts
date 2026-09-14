import { describe, expect, it } from "vitest";
import { createManualClock } from "./fakeEnvironment";
import { createCaptureScheduler, OCR_QUOTA_PER_MINUTE } from "./captureScheduler";

/**
 * FE-32-E：统一调度器的并发 1 / pending 1 / 手动优先 / 滚动总额 10。
 *
 * 这里验的是「谁能跑、谁被顶、额度怎么算」，不涉及真实截图与识别。
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("captureScheduler 并发与优先级（FE-32-E）", () => {
  it("并发 1：第二个任务要等第一个结束才开始", async () => {
    const clock = createManualClock(0);
    const scheduler = createCaptureScheduler({ clock });
    const first = deferred<string>();
    const started: string[] = [];

    const a = scheduler.submit(async () => {
      started.push("a");
      return first.promise;
    }, { priority: "auto" });
    await tick();
    const b = scheduler.submit(async () => {
      started.push("b");
      return "b";
    }, { priority: "auto" });
    await tick();

    expect(started).toEqual(["a"]);
    expect(scheduler.running()).toBe(true);
    expect(scheduler.pending()).toBe("auto");

    first.resolve("a");
    await expect(a).resolves.toEqual({ status: "done", value: "a" });
    await expect(b).resolves.toEqual({ status: "done", value: "b" });
    expect(started).toEqual(["a", "b"]);
  });

  it("pending 1：排队中的 auto 被后到者顶掉，得到 superseded（不排队积压）", async () => {
    const clock = createManualClock(0);
    const scheduler = createCaptureScheduler({ clock });
    const running = deferred<string>();
    const first = scheduler.submit(async () => running.promise, { priority: "auto" });
    await tick();

    const queued = scheduler.submit(async () => "queued", { priority: "auto" });
    await tick();
    const newest = scheduler.submit(async () => "newest", { priority: "auto" });
    await tick();

    await expect(queued).resolves.toEqual({ status: "superseded" });
    running.resolve("first");
    await expect(first).resolves.toEqual({ status: "done", value: "first" });
    await expect(newest).resolves.toEqual({ status: "done", value: "newest" });
  });

  it("手动优先：manual 顶掉未开始的 auto；auto 顶不掉排队中的 manual", async () => {
    const clock = createManualClock(0);
    const scheduler = createCaptureScheduler({ clock });
    const running = deferred<string>();
    const busy = scheduler.submit(async () => running.promise, { priority: "auto" });
    await tick();

    const auto = scheduler.submit(async () => "auto", { priority: "auto" });
    await tick();
    const manual = scheduler.submit(async () => "manual", { priority: "manual" });
    await tick();
    // manual 在排队时，后到的 auto 直接出局——不是把 manual 挤掉。
    const lateAuto = scheduler.submit(async () => "late-auto", { priority: "auto" });
    await tick();

    await expect(auto).resolves.toEqual({ status: "superseded" });
    await expect(lateAuto).resolves.toEqual({ status: "superseded" });
    running.resolve("busy");
    await expect(busy).resolves.toEqual({ status: "done", value: "busy" });
    await expect(manual).resolves.toEqual({ status: "done", value: "manual" });
  });

  it("滚动总额 10 次/分钟：手动也计入同一份额度，超限给出下一次可用时间", async () => {
    const clock = createManualClock(1000);
    const scheduler = createCaptureScheduler({ clock });
    for (let index = 0; index < OCR_QUOTA_PER_MINUTE; index += 1) {
      // 前 9 次走 auto、第 10 次走 manual：证明手动不是绕过限流的后门。
      const priority = index === OCR_QUOTA_PER_MINUTE - 1 ? "manual" : "auto";
      const outcome = await scheduler.submit(async () => index, { priority });
      expect(outcome).toEqual({ status: "done", value: index });
      clock.advance(100);
    }

    const blockedManual = await scheduler.submit(async () => "nope", { priority: "manual" });
    expect(blockedManual).toEqual({ status: "rate_limited", retryAtMonotonicMs: 1000 + 60_000 });
    expect(scheduler.quota()).toEqual({ used: 10, limit: 10, retryAtMonotonicMs: 61_000 });

    // 滚动窗口推进后额度回来（不是整点清零）。
    clock.advance(60_000);
    expect(scheduler.quota().used).toBe(0);
    await expect(scheduler.submit(async () => "ok", { priority: "auto" }))
      .resolves.toEqual({ status: "done", value: "ok" });
  });

  it("被顶掉与被取消的候选不消耗额度", async () => {
    const clock = createManualClock(0);
    const scheduler = createCaptureScheduler({ clock });
    const running = deferred<string>();
    const busy = scheduler.submit(async () => running.promise, { priority: "auto" });
    await tick();
    const dropped = scheduler.submit(async () => "dropped", { priority: "auto" });
    await tick();
    scheduler.submit(async () => "newest", { priority: "auto" });
    await tick();

    await expect(dropped).resolves.toEqual({ status: "superseded" });
    running.resolve("busy");
    await busy;
    await tick();
    // 跑过的只有 busy 与 newest 两次。
    expect(scheduler.quota().used).toBe(2);
  });

  it("cancelAll 撤销排队候选并中止在途任务（暂停/结束/停止全部感知）", async () => {
    const clock = createManualClock(0);
    const scheduler = createCaptureScheduler({ clock });
    let observedAbort = false;
    const running = deferred<string>();
    const inflight = scheduler.submit(async (signal) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
      });
      return running.promise;
    }, { priority: "auto" });
    await tick();
    const queued = scheduler.submit(async () => "queued", { priority: "manual" });
    await tick();

    scheduler.cancelAll();
    await expect(queued).resolves.toEqual({ status: "cancelled" });
    expect(observedAbort).toBe(true);

    // 迟到的完成同样收敛成 cancelled：结果不会被当成有效数据用。
    running.resolve("late");
    await expect(inflight).resolves.toEqual({ status: "cancelled" });
  });

  it("调用方 signal 已 abort：既不排队也不消耗额度", async () => {
    const clock = createManualClock(0);
    const scheduler = createCaptureScheduler({ clock });
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const outcome = await scheduler.submit(async () => {
      ran = true;
      return "x";
    }, { priority: "manual", signal: controller.signal });
    expect(outcome).toEqual({ status: "cancelled" });
    expect(ran).toBe(false);
    expect(scheduler.quota().used).toBe(0);
  });
});
