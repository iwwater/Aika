import { describe, expect, it } from "vitest";
import { createManualClock } from "./fakeEnvironment";
import {
  BUSY_OBSERVATION_MAX_AGE_MS,
  createBusyObserver,
  createTauriBusyAdapter,
  type BusyHostAdapter,
} from "./busySource";

/**
 * FE-19-J：busy 生产判定用固定 fixture；普通窗口 false、全屏或锁定 true、
 * 过期/失败 null。实际 Win32+DPI 真机另列，不用 fake 冒充。
 */

function adapterWith(busy: boolean | null, reason: string): BusyHostAdapter {
  return { query: async () => ({ busy, reason }) };
}

describe("busySource（FE-19-J）", () => {
  it("普通窗口 false；全屏/锁定 true；最小化、无前台、失败 null", async () => {
    const clock = createManualClock(0);
    const normal = createBusyObserver(adapterWith(false, "normal_window"), { clock, hostEpoch: "e" });
    expect((await normal.refresh()).value).toBe(false);
    normal.clear();

    const fullscreen = createBusyObserver(adapterWith(true, "fullscreen"), { clock, hostEpoch: "e" });
    expect((await fullscreen.refresh()).value).toBe(true);
    fullscreen.clear();

    const locked = createBusyObserver(adapterWith(true, "session_locked"), { clock, hostEpoch: "e" });
    expect((await locked.refresh()).value).toBe(true);
    locked.clear();

    for (const fixture of [
      adapterWith(null, "minimized"),
      adapterWith(null, "no_foreground"),
      adapterWith(null, "lock_unknown"),
    ] as BusyHostAdapter[]) {
      const observer = createBusyObserver(fixture, { clock, hostEpoch: "e" });
      expect((await observer.refresh()).value).toBeNull();
    }
  });

  it("adapter 抛错按 unknown（query_failed）记录，不伪装成 false", async () => {
    const clock = createManualClock(0);
    const observer = createBusyObserver({
      query: async () => {
        throw new Error("ipc gone");
      },
    }, { clock, hostEpoch: "e" });
    const observation = await observer.refresh();
    expect(observation.value).toBeNull();
    expect(observation.reasonCode).toBe("query_failed");
  });

  it("观测有效期 2000ms：年龄 ≤2000ms 有效、2001ms 起 unknown；refresh 重置", async () => {
    const clock = createManualClock(0);
    const observer = createBusyObserver(adapterWith(false, "normal_window"), { clock, hostEpoch: "e" });
    await observer.refresh();

    clock.advance(BUSY_OBSERVATION_MAX_AGE_MS);
    expect(observer.current()).toMatchObject({ value: false, reasonCode: "normal_window" });

    clock.advance(1);
    expect(observer.current()).toMatchObject({ value: null, reasonCode: "stale" });

    await observer.refresh();
    expect(observer.current()).toMatchObject({ value: false });
  });

  it("观测带宿主 epoch 与单调测点；clear 后读 unknown", async () => {
    const clock = createManualClock(5000);
    const observer = createBusyObserver(adapterWith(true, "fullscreen"), { clock, hostEpoch: "host-9" });
    await observer.refresh();
    const observation = observer.current();
    expect(observation).toEqual({ value: true, observedMonotonicMs: 5000, hostEpoch: "host-9", reasonCode: "fullscreen" });

    observer.clear();
    expect(observer.current()).toMatchObject({ value: null, reasonCode: "no_observation" });
  });

  it("Tauri adapter 形状校验：布尔/字符串透传，畸形按 malformed+null", async () => {
    const good = createTauriBusyAdapter(async () => ({ busy: true, reason: "fullscreen" }));
    expect(await good.query()).toEqual({ busy: true, reason: "fullscreen" });

    const malformed = createTauriBusyAdapter(async () => ({ busy: "yes", reason: 1 }));
    expect(await malformed.query()).toEqual({ busy: null, reason: "malformed" });

    const nothing = createTauriBusyAdapter(async () => null);
    expect(await nothing.query()).toEqual({ busy: null, reason: "malformed" });
  });
});
