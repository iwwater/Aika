import { describe, expect, it } from "vitest";
import { createHostLifecycle, type HostLivenessState } from "./hostLifecycle";

interface FakeTime {
  now(): number;
  advance(ms: number): void;
  timers: {
    set: (handler: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  };
}

function fakeTime(): FakeTime {
  let now = 1_000_000;
  let jobSeq = 0;
  const jobs = new Map<unknown, { at: number; fn: () => void }>();
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [handle, job] of [...jobs]) {
        if (job.at <= now) {
          jobs.delete(handle);
          job.fn();
        }
      }
    },
    timers: {
      set: (handler: () => void, ms: number) => {
        const handle = { id: jobSeq += 1 };
        jobs.set(handle, { at: now + ms, fn: handler });
        return handle;
      },
      clear: (handle: unknown) => {
        jobs.delete(handle);
      },
    },
  };
}

function makeLifecycle(overrides: { leaseMs?: number; recoveringMs?: number } = {}) {
  const time = fakeTime();
  const states: HostLivenessState[] = [];
  const lifecycle = createHostLifecycle({
    clock: time.now,
    timers: time.timers,
    ...(overrides.leaseMs === undefined ? {} : { leaseMs: overrides.leaseMs }),
    ...(overrides.recoveringMs === undefined ? {} : { recoveringMs: overrides.recoveringMs }),
  });
  lifecycle.subscribe((state) => states.push(state));
  return { time, states, lifecycle };
}

describe("宿主存活状态（RT-01-D）", () => {
  it("启动即 online，epoch 在存活期内恒定", () => {
    const { lifecycle } = makeLifecycle();
    expect(lifecycle.state()).toBe("online");
    expect(lifecycle.epoch()).toBe(lifecycle.epoch());
    lifecycle.dispose();
  });

  it("租约过期 → offline（可观测，不猜宿主还活着）", () => {
    const { time, states, lifecycle } = makeLifecycle({ leaseMs: 1_000 });
    time.advance(1_500);
    expect(lifecycle.state()).toBe("offline");
    expect(states).toEqual(["offline"]);
    lifecycle.dispose();
  });

  it("持续心跳保持 online，不误报", () => {
    const { time, states, lifecycle } = makeLifecycle({ leaseMs: 1_000 });
    for (let index = 0; index < 5; index += 1) {
      time.advance(500);
      lifecycle.markAlive();
    }
    expect(lifecycle.state()).toBe("online");
    expect(states).toEqual([]);
    lifecycle.dispose();
  });

  it("离线后重新喂心跳先进入 recovering，确认窗口内不再过期才回 online", () => {
    const { time, states, lifecycle } = makeLifecycle({ leaseMs: 1_000, recoveringMs: 500 });
    time.advance(2_000);
    expect(lifecycle.state()).toBe("offline");

    lifecycle.markAlive();
    expect(lifecycle.state()).toBe("recovering");

    // 确认窗口过去、租约 renewed 过：online。
    time.advance(300);
    lifecycle.markAlive();
    time.advance(600);
    expect(lifecycle.state()).toBe("online");
    expect(states).toEqual(["offline", "recovering", "online"]);
    lifecycle.dispose();
  });

  it("recovering 期间再次失约：回到 offline，不假装稳定", () => {
    const { time, lifecycle } = makeLifecycle({ leaseMs: 1_000, recoveringMs: 500 });
    time.advance(2_000);
    lifecycle.markAlive();
    expect(lifecycle.state()).toBe("recovering");

    time.advance(1_200);
    expect(lifecycle.state()).toBe("offline");
    lifecycle.dispose();
  });

  it("markStopping 立即 offline：关闭是事实，不等租约过期", () => {
    const { lifecycle } = makeLifecycle({ leaseMs: 60_000 });
    lifecycle.markStopping();
    expect(lifecycle.state()).toBe("offline");
    lifecycle.dispose();
  });

  it("重启宿主 = 新实例新 epoch（宿主 epoch 区分存活期）", () => {
    const first = makeLifecycle();
    const second = makeLifecycle();
    expect(first.lifecycle.epoch()).not.toBe(second.lifecycle.epoch());
    first.lifecycle.dispose();
    second.lifecycle.dispose();
  });

  it("dispose 后不再改变状态，也不再有定时器", () => {
    const { time, lifecycle } = makeLifecycle({ leaseMs: 1_000 });
    lifecycle.dispose();
    time.advance(10_000);
    expect(lifecycle.state()).toBe("online");
  });
});
