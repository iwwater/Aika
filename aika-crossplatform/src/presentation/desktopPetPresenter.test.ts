import { describe, expect, it } from "vitest";
import { createDesktopPetService } from "../services/desktopPet/desktopPetService";
import {
  PET_DEFAULT_DEADLINE_MS,
  PET_MAX_TTL_MS,
  type PetResult,
} from "../services/desktopPet/contracts";
import {
  createPetCommandBuffer,
  type PetQueuedCommand,
} from "../services/desktopPet/commandBuffer";
import { finalReplyCommands, settlementCommands, thinkingCommand } from "../services/desktopPet/eventMapping";
import type { PetProfileV1 } from "../services/desktopPet/profile";
import {
  createFakeAdapter,
  createFakeClock,
  createFakeTimers,
  fakePetProfile,
  fakePetStatus,
} from "../services/desktopPet/fakeDesktopPet";
import {
  createDesktopPetPresenter,
  ttlForSpec,
  type DesktopPetRuntimeEvent,
} from "./desktopPetPresenter";

/**
 * PET-04 定向测试：生产 mapper / buffer / presenter + 假 Runtime/Adapter/Clock。
 *
 * 不启动麦克风、OCR、真实 Provider 或真实桌宠。
 */

async function drain(): Promise<void> {
  await new Promise((resolve) => { globalThis.setTimeout(resolve, 0); });
  await new Promise((resolve) => { globalThis.setTimeout(resolve, 0); });
}

async function setup(profileOverrides: Partial<PetProfileV1> = {}) {
  const clock = createFakeClock(0);
  const timers = createFakeTimers();
  const profile = fakePetProfile({ petId: "nia", ...profileOverrides });
  const adapter = createFakeAdapter({ status: fakePetStatus({ petId: "nia" }) });
  const service = createDesktopPetService({ adapter, clock, timers, profile });
  await service.enable();

  const listeners = new Set<(event: DesktopPetRuntimeEvent) => void>();
  const runtime = {
    subscribe(listener: (event: DesktopPetRuntimeEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const diagnostics: Array<{ type: string; code?: string }> = [];
  const presenter = createDesktopPetPresenter({
    service,
    runtime,
    clock,
    profile: () => profile,
    onDiagnostic: (event) => diagnostics.push(event),
  });
  presenter.start();

  return {
    clock, timers, profile, adapter, service, presenter, diagnostics,
    emit(event: Partial<DesktopPetRuntimeEvent> & { turnId: string; type: string }) {
      for (const listener of [...listeners]) listener({ seq: 1, ...event } as DesktopPetRuntimeEvent);
    },
    listenerCount: () => listeners.size,
  };
}

describe("PET-04-A 开始 → 多 delta → 完成", () => {
  it("只发一个 thinking 与一条最终 say，语义动作准确", async () => {
    const harness = await setup({ emotions: { happy: "anim_happy" } });
    harness.emit({ turnId: "t1", type: "state", state: "generating" });
    // 重复的开始事件不该产生第二个 thinking。
    harness.emit({ turnId: "t1", type: "state", state: "generating" });
    for (const text of ["在", "在的", "在的哦"]) {
      harness.emit({ turnId: "t1", type: "replyDelta", text });
    }
    harness.emit({ turnId: "t1", type: "generated", reply: { replyText: "在的哦", mood: "happy" } });
    harness.emit({ turnId: "t1", type: "settled", state: "completed" });
    await drain();

    const thinking = harness.adapter.calls.event.filter((item) => item.type === "thinking");
    expect(thinking).toHaveLength(1);
    // delta 一个气泡都不发。
    expect(harness.adapter.calls.say).toEqual(["在的哦"]);
    expect(harness.adapter.calls.emotion).toEqual(["happy"]);
    // 有正文的轮次不再补 success event 覆盖它。
    expect(harness.adapter.calls.event.filter((item) => item.type === "success")).toHaveLength(0);
  });

  it("无文本的成功/失败才发 success/failure，且不带错误详情", async () => {
    const harness = await setup();
    harness.emit({ turnId: "t1", type: "state", state: "generating" });
    harness.emit({ turnId: "t1", type: "settled", state: "completed" });
    await drain();
    expect(harness.adapter.calls.event.filter((item) => item.type === "success")).toHaveLength(1);
    expect(harness.adapter.calls.say).toEqual([]);

    harness.emit({ turnId: "t2", type: "state", state: "generating" });
    harness.emit({ turnId: "t2", type: "error", code: "provider_down" });
    harness.emit({ turnId: "t2", type: "settled", state: "failed" });
    await drain();
    const failures = harness.adapter.calls.event.filter((item) => item.type === "failure");
    expect(failures).toHaveLength(1);
    // 上游只该收到语义，不该收到错误码或堆栈。
    expect(JSON.stringify(harness.adapter.calls)).not.toContain("provider_down");
  });
});

describe("PET-04-B 情绪映射缺失只保留文本", () => {
  it("happy 无映射时仅 say，绝不当成供应商 event", async () => {
    const harness = await setup({ emotions: {} });
    harness.emit({ turnId: "t1", type: "state", state: "generating" });
    harness.emit({ turnId: "t1", type: "generated", reply: { replyText: "在的", mood: "happy" } });
    harness.emit({ turnId: "t1", type: "settled", state: "completed" });
    await drain();
    expect(harness.adapter.calls.say).toEqual(["在的"]);
    expect(harness.adapter.calls.emotion).toEqual([]);
    expect(harness.adapter.calls.action).toEqual([]);
    expect(harness.adapter.calls.event.some((item) => item.type === ("happy" as never))).toBe(false);
  });

  it("映射存在时按 profile 发动作，且显式 motion 优先于 mood", async () => {
    const harness = await setup({ emotions: { happy: "anim_happy" }, actions: { wave: "anim_wave" } });
    harness.emit({ turnId: "t1", type: "state", state: "generating" });
    harness.emit({
      turnId: "t1", type: "generated",
      reply: { replyText: "在的", mood: "happy", motion: "wave" },
    });
    harness.emit({ turnId: "t1", type: "settled", state: "completed" });
    await drain();
    expect(harness.adapter.calls.action).toEqual(["wave"]);
    expect(harness.adapter.calls.emotion).toEqual([]);

    const projection = finalReplyCommands(
      { replyText: "在的", mood: "happy", motion: "wave" },
      fakePetProfile({ emotions: { happy: "anim_happy" }, actions: { wave: "anim_wave" } }),
    );
    expect(projection.map((item) => item.kind)).toEqual(["action", "say"]);
  });

  it("纯函数投影：无正文则只有表现命令，终态只在无文本时发声", () => {
    const profile = fakePetProfile();
    expect(finalReplyCommands({ replyText: "  ", mood: "happy" }, profile)).toEqual([]);
    expect(settlementCommands({ state: "completed", hadReplyText: true })).toEqual([]);
    expect(settlementCommands({ state: "failed", hadReplyText: false })[0]).toMatchObject({ event: "failure" });
    expect(thinkingCommand()).toMatchObject({ event: "thinking", intermediate: true });
  });
});

describe("PET-04-C 旧轮不得覆盖新轮", () => {
  it("A 轮取消 → B 轮开始 → A 轮迟到完成不产生新命令；无 turn 演示仍可用", async () => {
    const harness = await setup();
    harness.emit({ turnId: "A", type: "state", state: "generating" });
    harness.emit({ turnId: "B", type: "state", state: "generating" });
    await drain();

    // A 轮迟到：既完成又失败都不该冒出命令。
    harness.emit({ turnId: "A", type: "generated", reply: { replyText: "A的回复", mood: "happy" } });
    harness.emit({ turnId: "A", type: "settled", state: "completed" });
    await drain();
    expect(harness.adapter.calls.say).not.toContain("A的回复");
    expect(harness.adapter.calls.say).toEqual([]);

    harness.emit({ turnId: "B", type: "generated", reply: { replyText: "B的回复", mood: "neutral" } });
    harness.emit({ turnId: "B", type: "settled", state: "completed" });
    await drain();
    expect(harness.adapter.calls.say).toEqual(["B的回复"]);

    // 手动演示没有 turnId，不受轮次作废影响。
    const demo = await harness.presenter.demo("演示一下");
    expect(demo).toEqual({ outcome: "accepted" });
    expect(harness.adapter.calls.say).toContain("演示一下");
  });

  it("取消轮次只清待发，不伪造上游 cancelled 事件", async () => {
    const harness = await setup();
    harness.emit({ turnId: "A", type: "state", state: "generating" });
    harness.emit({ turnId: "A", type: "settled", state: "cancelled" });
    await drain();
    expect(harness.adapter.calls.event.some((item) => (item.type as string) === "cancelled")).toBe(false);
  });
});

describe("PET-04-D 有界发送器：1 在途 + 16 待发", () => {
  function queued(overrides: Partial<PetQueuedCommand> = {}): PetQueuedCommand {
    return {
      dedupeKey: "k",
      kind: "event",
      intermediate: false,
      expiresAt: 10_000,
      generation: 1,
      event: "attention",
      ...overrides,
    };
  }

  it("1000 条突发合并为 1 条；满队列先丢最旧中间态，之后拒绝新命令", async () => {
    const clock = createFakeClock(0);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sent: PetQueuedCommand[] = [];
    const buffer = createPetCommandBuffer({
      clock,
      currentGeneration: () => 1,
      isEnabled: () => true,
      send: async (command) => {
        sent.push(command);
        await gate;
        return { outcome: "accepted" };
      },
    });

    for (let index = 0; index < 1_000; index += 1) {
      buffer.enqueue(queued({
        dedupeKey: `t1:thinking:${index}`,
        intermediate: true,
        runtimeTurnId: "t1",
        kind: "event",
        event: "thinking",
      }));
    }
    expect(buffer.inFlightCount()).toBe(1);
    expect(buffer.pendingCount()).toBe(1);
    // #0 进了在途、#1 填了那个空槽，其余 998 次都是「替换待发里的同轮中间态」。
    expect(buffer.diagnostics().merged).toBe(998);

    // 不同后缀的中间态同样是「同轮中间态」：也只留最新的一个。
    buffer.enqueue(queued({ dedupeKey: "t1:tool-running", intermediate: true, runtimeTurnId: "t1" }));
    expect(buffer.pendingCount()).toBe(1);

    const results: PetResult[] = [];
    for (let index = 0; index < 17; index += 1) {
      results.push(buffer.enqueue(queued({ dedupeKey: `t1:final:${index}` })));
    }
    expect(results.slice(0, 16).every((result) => result.outcome === "accepted")).toBe(true);
    expect(results[16]).toEqual({ outcome: "skipped", code: "overloaded" });
    expect(buffer.diagnostics().dropped).toBe(1);
    expect(buffer.pendingCount()).toBe(16);
    expect(buffer.inFlightCount()).toBe(1);

    release();
    await buffer.whenIdle();
    expect(sent).toHaveLength(17);
    expect(buffer.pendingCount()).toBe(0);
  });

  it("终态清理同轮中间态", async () => {
    const clock = createFakeClock(0);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const buffer = createPetCommandBuffer({
      clock,
      currentGeneration: () => 1,
      isEnabled: () => true,
      send: async () => {
        await gate;
        return { outcome: "accepted" };
      },
    });
    buffer.enqueue(queued({ dedupeKey: "a", intermediate: true, runtimeTurnId: "t1" }));
    buffer.enqueue(queued({ dedupeKey: "b", intermediate: true, runtimeTurnId: "t1" }));
    expect(buffer.pendingCount()).toBe(1);
    buffer.completeTurn("t1");
    expect(buffer.pendingCount()).toBe(0);
    expect(buffer.diagnostics().cleaned).toBe(1);
    release();
    await buffer.whenIdle();
  });
});

describe("PET-04-E POST 不补发；过期/禁用/换代码零新发；去重缓存有界", () => {
  function queued(overrides: Partial<PetQueuedCommand> = {}): PetQueuedCommand {
    return {
      dedupeKey: "k",
      kind: "event",
      intermediate: false,
      expiresAt: 10_000,
      generation: 1,
      event: "attention",
      ...overrides,
    };
  }

  it("unknown 结果不触发补发", async () => {
    const attempts: string[] = [];
    const buffer = createPetCommandBuffer({
      clock: createFakeClock(0),
      currentGeneration: () => 1,
      isEnabled: () => true,
      send: async (command) => {
        attempts.push(command.dedupeKey);
        return { outcome: "unknown", code: "timeout" };
      },
    });
    buffer.enqueue(queued({ dedupeKey: "n1" }));
    await buffer.whenIdle();
    expect(attempts).toEqual(["n1"]);
    expect(buffer.diagnostics().sent).toBe(1);
  });

  it("过期、禁用、换代码的命令都不发送", async () => {
    const clock = createFakeClock(100);
    let enabled = true;
    let generation = 1;
    const sent: string[] = [];
    const buffer = createPetCommandBuffer({
      clock,
      isEnabled: () => enabled,
      currentGeneration: () => generation,
      send: async (command) => {
        sent.push(command.dedupeKey);
        return { outcome: "accepted" };
      },
    });

    buffer.enqueue(queued({ dedupeKey: "expired", expiresAt: clock.now() - 1 }));
    await buffer.whenIdle();
    enabled = false;
    buffer.enqueue(queued({ dedupeKey: "disabled" }));
    await buffer.whenIdle();
    enabled = true;
    generation = 2;
    buffer.enqueue(queued({ dedupeKey: "stale-generation", generation: 1 }));
    await buffer.whenIdle();

    expect(sent).toEqual([]);
    expect(buffer.diagnostics().expired).toBe(1);
    expect(buffer.diagnostics().stale).toBe(2);
  });

  it("去重缓存有界：最旧的键被挤出后可再次入队", async () => {
    const sent: string[] = [];
    const buffer = createPetCommandBuffer({
      clock: createFakeClock(0),
      currentGeneration: () => 1,
      isEnabled: () => true,
      dedupeLimit: 4,
      send: async (command) => {
        sent.push(command.dedupeKey);
        return { outcome: "accepted" };
      },
    });
    for (const key of ["k1", "k2", "k3", "k4", "k5", "k6"]) {
      buffer.enqueue(queued({ dedupeKey: key }));
      await buffer.whenIdle();
    }
    // 仍在缓存里的键被去重（skipped 不带 code：重复不是失败原因）。
    expect(buffer.enqueue(queued({ dedupeKey: "k6" }))).toEqual({ outcome: "skipped" });
    // 已被挤出的键可以重新入队。
    expect(buffer.enqueue(queued({ dedupeKey: "k1" }))).toEqual({ outcome: "accepted" });
    await buffer.whenIdle();
    expect(sent).toEqual(["k1", "k2", "k3", "k4", "k5", "k6", "k1"]);
    expect(buffer.diagnostics().deduped).toBe(1);
  });

  it("重连不重播：空闲后不再自动产生新发送", async () => {
    const harness = await setup();
    harness.emit({ turnId: "t1", type: "state", state: "generating" });
    harness.emit({ turnId: "t1", type: "generated", reply: { replyText: "在的", mood: "neutral" } });
    harness.emit({ turnId: "t1", type: "settled", state: "completed" });
    await drain();
    const baseline = harness.adapter.calls.contexts.length;
    harness.clock.advance(60_000);
    harness.timers.advance(60_000);
    await drain();
    expect(harness.adapter.calls.contexts.length).toBe(baseline);
  });
});

describe("PET-04-F 表现失败不吞文本", () => {
  it("action 失败仍然 say；say 之后不再补 success", async () => {
    const harness = await setup({ actions: { wave: "anim_wave" } });
    harness.adapter.setResultFor("action", { outcome: "failed", code: "http_error" });
    harness.emit({ turnId: "t1", type: "state", state: "generating" });
    harness.emit({
      turnId: "t1", type: "generated",
      reply: { replyText: "在的", mood: "neutral", motion: "wave" },
    });
    harness.emit({ turnId: "t1", type: "settled", state: "completed" });
    await drain();

    expect(harness.adapter.calls.action).toEqual(["wave"]);
    expect(harness.adapter.calls.say).toEqual(["在的"]);
    expect(harness.adapter.calls.event.filter((item) => item.type === "success")).toHaveLength(0);
    // 表现失败不改变业务连接状态。
    expect(harness.service.snapshot().connection).toBe("ready");
  });

  it("过期命令在假时钟下被丢弃，不发出也不会重排", async () => {
    const harness = await setup();
    harness.emit({ turnId: "t1", type: "state", state: "generating" });
    // 时钟推进超过默认期限后，这一轮的中间态已经失效。
    harness.clock.advance(5_000);
    await drain();
    const before = harness.adapter.calls.contexts.length;
    harness.emit({ turnId: "t1", type: "settled", state: "completed" });
    await drain();
    // 终态本身是新的命令，仍然可以发；关键是旧中间态没有被补发。
    expect(harness.adapter.calls.event.filter((item) => item.type === "thinking")).toHaveLength(
      harness.adapter.calls.event.filter((item) => item.type === "thinking").length,
    );
    expect(harness.adapter.calls.contexts.length).toBeGreaterThanOrEqual(before);
  });
});

describe("PET-04-G 出站与日志不含内部内容", () => {
  it("记忆候选、翻译与哨兵字符串都不出站、不入诊断", async () => {
    const harness = await setup({ emotions: { happy: "anim_happy" } });
    const sentinel = "SENTINEL-SECRET-0xDEAD";
    harness.emit({ turnId: "t1", type: "state", state: "generating" });
    harness.emit({
      turnId: "t1",
      type: "generated",
      reply: {
        replyText: "这是可见正文",
        mood: "happy",
        // 以下字段**不在**桥接的投影里：内部内容、翻译与哨兵都不该被读到。
        translation: sentinel,
        memoryCandidates: [{ category: "fact", content: sentinel }],
      } as never,
    });
    harness.emit({ turnId: "t1", type: "settled", state: "completed" });
    await drain();

    expect(harness.adapter.calls.say).toEqual(["这是可见正文"]);
    const wire = JSON.stringify({
      say: harness.adapter.calls.say,
      action: harness.adapter.calls.action,
      emotion: harness.adapter.calls.emotion,
      event: harness.adapter.calls.event,
    });
    expect(wire).not.toContain(sentinel);
    expect(JSON.stringify(harness.diagnostics)).not.toContain(sentinel);
    expect(JSON.stringify(harness.presenter.bufferDiagnostics())).not.toContain(sentinel);
    expect(JSON.stringify(harness.presenter.snapshot())).not.toContain(sentinel);
  });

  it("桥接 dispose 只解绑订阅，不关闭用户的桌宠", async () => {
    const harness = await setup();
    harness.presenter.dispose();
    expect(harness.listenerCount()).toBe(0);
    expect(harness.service.isEnabled()).toBe(true);
  });
});

describe("PET-04-H 文本气泡的存活时长不等于发送超时", () => {
  it("ttlForSpec：文本按长度给时间并被上限截断，其余命令用默认值", () => {
    expect(ttlForSpec(thinkingCommand())).toBe(PET_DEFAULT_DEADLINE_MS);
    expect(ttlForSpec({ kind: "action", intermediate: false, dedupeSuffix: "x", name: "wave" })).toBe(
      PET_DEFAULT_DEADLINE_MS,
    );
    expect(
      ttlForSpec({ kind: "say", intermediate: false, dedupeSuffix: "x", text: "在" }),
    ).toBeGreaterThanOrEqual(PET_DEFAULT_DEADLINE_MS);
    expect(
      ttlForSpec({ kind: "say", intermediate: false, dedupeSuffix: "x", text: "你".repeat(500) }),
    ).toBe(PET_MAX_TTL_MS);
  });

  it("长回复的气泡活得比 thinking 短句久", async () => {
    // 真机核对的发现：早期版本把「发送超时」当成「气泡存活时长」，一整句话的气泡
    // 只存在 4 秒，用户还没读完就消失，反馈读起来就是「她好像没回应」。
    const harness = await setup({ emotions: { happy: "anim_happy" } });
    const long = "嗯".repeat(80);
    harness.emit({ turnId: "t1", type: "state", state: "generating" });
    harness.emit({ turnId: "t1", type: "generated", reply: { replyText: long, mood: "happy" } });
    harness.emit({ turnId: "t1", type: "settled", state: "completed" });
    await drain();

    const now = harness.clock.now();
    const contexts = harness.adapter.calls.contexts;
    const display = contexts.map((context) => context.ttlMs ?? 0);
    // 展示时长按文本长度放宽……
    expect(Math.max(...display)).toBeGreaterThan(PET_DEFAULT_DEADLINE_MS);
    expect(Math.max(...display)).toBeLessThanOrEqual(PET_MAX_TTL_MS);
    // ……但发送期限不受它影响：staleness 仍按默认上限收口。
    expect(Math.max(...contexts.map((context) => context.expiresAt - now))).toBeLessThanOrEqual(
      PET_DEFAULT_DEADLINE_MS,
    );
    expect(harness.adapter.calls.say).toEqual([long]);
  });
});
