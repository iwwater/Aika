import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PetConnection } from "./contracts";
import {
  PET_RESTART_BUDGET,
  PetProcessError,
  createPetProcessManager,
  validatePetExecutable,
  type PetProcessManager,
  type PetProcessSpawnOptions,
} from "./processManager";
import {
  createFakeClock,
  createFakeOsProcessPort,
  createFakeTimers,
  createFakeProbe,
  type FakeClock,
  type FakeOsProcessPort,
  type FakeTimers,
} from "./fakeDesktopPet";

/**
 * PET-05 定向测试：生产状态机 + 假操作系统进程端口 + 假时钟。
 *
 * OpenPet 的真实启动/退出留 PET-07；这里证明的是所有权、并发合并、退避与
 * 重启预算的判断全部正确，且任何错误分支都不会误杀别人的进程。
 */

const SLEEPER = "C:\\Program Files\\OpenPet 桌宠\\OpenPet.exe";

interface Harness {
  manager: PetProcessManager;
  port: FakeOsProcessPort;
  clock: FakeClock;
  timers: FakeTimers;
  spawns: () => string[];
  settle<T>(work: Promise<T>, budgetMs?: number): Promise<T>;
  advance(ms: number): Promise<void>;
}

function build(options: {
  mode?: "attach" | "managed";
  executablePath?: string | null;
  autoRestart?: boolean;
  stopOwnedOnExit?: boolean;
  probe?: () => Promise<PetConnection>;
  port?: FakeOsProcessPort;
  createExitToken?: () => string;
  protocolExit?: (token: string) => Promise<boolean>;
} = {}): Harness {
  const clock = createFakeClock(0);
  const timers = createFakeTimers();
  const port = options.port ?? createFakeOsProcessPort();
  const manager = createPetProcessManager({
    clock,
    timers,
    port,
    probe: options.probe ?? createFakeProbe("offline", "ready"),
    config: () => ({
      mode: options.mode ?? "managed",
      executablePath: options.executablePath === undefined ? SLEEPER : options.executablePath,
      autoRestart: options.autoRestart ?? false,
      stopOwnedOnExit: options.stopOwnedOnExit ?? false,
    }),
    ...(options.createExitToken ? { createExitToken: options.createExitToken } : {}),
    ...(options.protocolExit ? { protocolExit: options.protocolExit } : {}),
  });

  async function advance(ms: number): Promise<void> {
    clock.advance(ms);
    timers.advance(ms);
    await new Promise((resolve) => { globalThis.setTimeout(resolve, 0); });
  }

  async function settle<T>(work: Promise<T>, budgetMs = 60_000): Promise<T> {
    let done = false;
    let value: T | undefined;
    let failure: unknown;
    work.then(
      (result) => { done = true; value = result; },
      (error) => { done = true; failure = error; },
    );
    for (let waited = 0; waited <= budgetMs && !done; waited += 500) {
      await advance(500);
    }
    if (!done) throw new Error("wait failed: promise did not settle within budget");
    if (failure) throw failure;
    return value as T;
  }

  return { manager, port, clock, timers, spawns: () => port.spawns, settle, advance };
}

describe("PET-05-A attach 模式零 spawn / 零 stop", () => {
  it("探测到就绪只 attach，绝不接管", async () => {
    const harness = build({ mode: "attach", probe: async () => "ready" });
    await harness.manager.ensureReady();
    expect(harness.manager.status()).toMatchObject({ phase: "ready", owned: false });
    expect(harness.spawns()).toEqual([]);
    await harness.manager.dispose();
    expect(harness.port.stopCalls).toEqual([]);
  });

  it("离线与不兼容同样零 spawn、零 stop", async () => {
    for (const [connection, phase] of [["offline", "offline"], ["incompatible", "incompatible"]] as const) {
      const harness = build({ mode: "attach", probe: async () => connection, stopOwnedOnExit: true });
      await harness.manager.ensureReady();
      expect(harness.manager.status().phase).toBe(phase);
      await harness.manager.dispose();
      expect(harness.spawns()).toEqual([]);
      expect(harness.port.stopCalls).toEqual([]);
    }
  });
});

describe("MVP-09-D 协议退出只作用于 owned 实例", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";

  it("managed 启动时注入令牌，退出时先走协议退出", async () => {
    const seen: string[] = [];
    const harness = build({
      stopOwnedOnExit: true,
      createExitToken: () => TOKEN,
      protocolExit: async (token) => {
        seen.push(token);
        return true;
      },
    });
    await harness.settle(harness.manager.ensureReady());
    // 令牌只在 spawn 时注入，且就是本进程生成的那一份。
    expect(harness.port.spawnTokens).toEqual([TOKEN]);

    await harness.manager.dispose();
    expect(seen).toEqual([TOKEN]);
    // 协议退出成功后仍会释放句柄（否则原生侧句柄表会留下死条目）。
    expect(harness.port.stopCalls).toHaveLength(1);
    expect(harness.manager.diagnostics()).toMatchObject({
      protocolExits: 1,
      protocolExitFallbacks: 0,
    });
  });

  it("协议退出被拒时回退到进程句柄，且计数如实", async () => {
    const harness = build({
      stopOwnedOnExit: true,
      createExitToken: () => TOKEN,
      protocolExit: async () => false,
    });
    await harness.settle(harness.manager.ensureReady());
    await harness.manager.dispose();

    expect(harness.port.stopCalls).toHaveLength(1);
    expect(harness.manager.diagnostics()).toMatchObject({
      protocolExits: 0,
      protocolExitFallbacks: 1,
      stopped: 1,
    });
  });

  it("协议退出挂起时不拖住 dispose，按超时回退", async () => {
    const harness = build({
      stopOwnedOnExit: true,
      createExitToken: () => TOKEN,
      protocolExit: () => new Promise<boolean>(() => {}),
    });
    await harness.settle(harness.manager.ensureReady());
    await harness.settle(harness.manager.dispose());

    expect(harness.port.stopCalls).toHaveLength(1);
    expect(harness.manager.diagnostics().protocolExitFallbacks).toBe(1);
  });

  it("attach 模式既不生成令牌也不尝试协议退出", async () => {
    let called = 0;
    const harness = build({
      mode: "attach",
      probe: async () => "ready",
      stopOwnedOnExit: true,
      createExitToken: () => TOKEN,
      protocolExit: async () => {
        called += 1;
        return true;
      },
    });
    await harness.manager.ensureReady();
    await harness.manager.dispose();

    expect(harness.spawns()).toEqual([]);
    expect(harness.port.spawnTokens).toEqual([]);
    expect(called).toBe(0);
    expect(harness.port.stopCalls).toEqual([]);
  });

  it("stopOwnedOnExit=false 时既不动进程也不请求退出", async () => {
    let called = 0;
    const harness = build({
      stopOwnedOnExit: false,
      createExitToken: () => TOKEN,
      protocolExit: async () => {
        called += 1;
        return true;
      },
    });
    await harness.settle(harness.manager.ensureReady());
    await harness.manager.dispose();

    expect(called).toBe(0);
    expect(harness.port.stopCalls).toEqual([]);
    expect(harness.manager.diagnostics()).toMatchObject({
      protocolExits: 0,
      protocolExitFallbacks: 0,
    });
  });

  it("没有令牌来源时完全不涉及协议退出，行为与旧策略一致", async () => {
    const harness = build({ stopOwnedOnExit: true, protocolExit: async () => true });
    await harness.settle(harness.manager.ensureReady());
    expect(harness.port.spawnTokens).toEqual([undefined]);

    await harness.manager.dispose();
    expect(harness.port.stopCalls).toHaveLength(1);
    expect(harness.manager.diagnostics()).toMatchObject({
      protocolExits: 0,
      protocolExitFallbacks: 0,
      stopped: 1,
    });
  });

  it("单实例转交后释放所有权，不再持有令牌", async () => {
    const seen: string[] = [];
    const port = createFakeOsProcessPort();
    const harness = build({
      port,
      stopOwnedOnExit: true,
      createExitToken: () => TOKEN,
      protocolExit: async (token) => {
        seen.push(token);
        return true;
      },
    });
    // 我们起的进程立刻退出，但端点是通的 → 按 attach 处理。
    port.exitNormally();
    await harness.settle(harness.manager.ensureReady());
    expect(harness.manager.status()).toMatchObject({ owned: false });

    await harness.manager.dispose();
    expect(seen).toEqual([]);
    expect(port.stopCalls).toEqual([]);
  });
});

describe("PET-05-B 并发启动合并与路径校验", () => {
  it("20 个并发启动只 spawn 一次；含空格与中文的路径原样传递", async () => {
    const harness = build();
    const results = Array.from({ length: 20 }, () => harness.manager.ensureReady());
    await harness.settle(Promise.all(results));
    expect(harness.spawns()).toEqual([SLEEPER]);
    expect(harness.manager.status()).toMatchObject({ phase: "ready", owned: true });
  });

  it("安装器、脚本、相对路径、非 exe 一律拒绝且不 spawn", async () => {
    const cases: Array<[string, string]> = [
      ["C:\\Users\\me\\Downloads\\OpenPet_0.1.6_x64-setup.exe", "installer_rejected"],
      ["C:\\pet\\unins000.exe", "installer_rejected"],
      ["C:\\pet\\run.bat", "script_rejected"],
      ["C:\\pet\\run.ps1", "script_rejected"],
      ["pet.exe", "invalid_path"],
      ["C:\\pet\\pet.txt", "invalid_path"],
      ["", "invalid_path"],
    ];
    for (const [path, kind] of cases) {
      const harness = build({ executablePath: path });
      await expect(harness.manager.ensureReady()).rejects.toMatchObject({ kind });
      expect(harness.spawns(), path).toEqual([]);
    }
    expect(validatePetExecutable(SLEEPER)).toEqual({ ok: true, path: SLEEPER });
    expect(validatePetExecutable("C:\\pet\\OpenPet.exe").ok).toBe(true);
  });
});

describe("PET-05-C 超时 / 端口冲突 / 存活但 API 离线", () => {
  it("就绪探测超时：有界报错，不无限启动", async () => {
    const harness = build({ probe: async () => "offline" });
    await expect(harness.settle(harness.manager.ensureReady())).rejects.toMatchObject({ kind: "start_timeout" });
    expect(harness.spawns()).toHaveLength(1);
    expect(harness.manager.status().phase).toBe("offline");
  });

  it("端口被非 OpenPet 占用：不抢端口、不终止占用者，报不兼容", async () => {
    const harness = build({ probe: async () => "incompatible" });
    await expect(harness.manager.ensureReady()).rejects.toMatchObject({ kind: "incompatible" });
    expect(harness.spawns()).toEqual([]);
    expect(harness.port.stopCalls).toEqual([]);
  });

  it("存活但 API 离线：降级并等待，不重复 spawn", async () => {
    const harness = build();
    await harness.settle(harness.manager.ensureReady());
    expect(harness.spawns()).toHaveLength(1);

    harness.manager.observe("offline");
    await harness.advance(1_000);
    expect(harness.manager.status().phase).toBe("offline");
    expect(harness.spawns()).toHaveLength(1);
  });
});

describe("PET-05-D 所有权：只使用本次 spawn 身份", () => {
  it("单实例转交：本次起的进程退出但服务已就绪 → 按 attach 处理", async () => {
    const harness = build();
    const pending = harness.manager.ensureReady();
    // 子进程起来后立刻退出（单实例转交），但端点已经在服务。
    harness.port.exitNormally();
    await harness.settle(pending);
    expect(harness.manager.status()).toMatchObject({ phase: "ready", owned: false });

    await harness.manager.dispose();
    // 不是我们的进程：退出时一个 stop 都不该发。
    expect(harness.port.stopCalls).toEqual([]);
  });

  it("释放所有权后再 dispose 不会误杀", async () => {
    const harness = build({ stopOwnedOnExit: true });
    await harness.settle(harness.manager.ensureReady());
    harness.manager.cancelPending();
    harness.port.exitUnknown();
    harness.manager.observe("offline");
    await harness.advance(1_000);
    await harness.settle(harness.manager.dispose());
    expect(harness.port.stopCalls).toEqual([]);
  });
});

describe("PET-05-E 重启预算：只重启确定崩溃的自有进程", () => {
  function crashHarness(autoRestart = true): Harness {
    const port = createFakeOsProcessPort();
    const harness = build({
      autoRestart,
      port,
      probe: async () => (port.aliveCount() > 0 ? "ready" : "offline"),
    });
    return harness;
  }

  /** 推进假时间直到达到预期 spawn 次数 / 进入某相位。 */
  async function waitFor(harness: Harness, predicate: () => boolean, label: string): Promise<void> {
    for (let waited = 0; waited <= 30_000; waited += 250) {
      if (predicate()) return;
      await harness.advance(250);
    }
    throw new Error(`等待超时：${label}`);
  }

  it("显式开启后按预算重启，5 分钟最多 2 次", async () => {
    const harness = crashHarness(true);
    await harness.settle(harness.manager.ensureReady());
    expect(harness.spawns()).toHaveLength(1);

    for (let round = 0; round < PET_RESTART_BUDGET; round += 1) {
      harness.port.crash();
      harness.manager.observe("offline");
      // 崩溃判定是异步的：先让它跑完并排定重启，再等重启真正就绪。
      await harness.advance(0);
      expect(harness.manager.status().phase, `round ${round}`).toBe("offline");
      const expected = 2 + round;
      await waitFor(harness, () => harness.spawns().length >= expected, `第 ${round + 1} 次重启 spawn`);
      await waitFor(harness, () => harness.manager.status().phase === "ready", `第 ${round + 1} 次重启就绪`);
    }

    // 第三次崩溃：预算用尽，只记数、不再拉起。
    harness.port.crash();
    harness.manager.observe("offline");
    await harness.advance(3_000);
    expect(harness.spawns()).toHaveLength(1 + PET_RESTART_BUDGET);
    expect(harness.manager.diagnostics().budgetExceeded).toBe(1);
  });

  it("正常退出、原因不明、未开启自动重启都不拉起", async () => {
    for (const scenario of ["normal", "unknown", "disabled"] as const) {
      const harness = crashHarness(scenario !== "disabled");
      await harness.settle(harness.manager.ensureReady());
      if (scenario === "normal") harness.port.exitNormally();
      else if (scenario === "unknown") harness.port.exitUnknown();
      else harness.port.crash();
      harness.manager.observe("offline");
      await harness.advance(5_000);
      expect(harness.spawns(), scenario).toHaveLength(1);
    }
  });

  it("宿主不提供退出原因时永不自动重启（fail-safe）", async () => {
    const harness = crashHarness(true);
    await harness.settle(harness.manager.ensureReady());
    harness.port.disableExitInfo();
    harness.port.crash();
    harness.manager.observe("offline");
    await harness.advance(5_000);
    expect(harness.spawns()).toHaveLength(1);
  });
});

describe("PET-05-F 启停边界：不遗留 timer、不阻塞业务", () => {
  it("启动途中取消：报 cancelled 且不遗留定时器", async () => {
    const harness = build({ probe: async () => "offline" });
    const pending = harness.manager.ensureReady();
    await harness.advance(600);
    harness.manager.cancelPending();
    await expect(harness.settle(pending)).rejects.toMatchObject({ kind: "cancelled" });
    expect(harness.timers.active()).toBe(0);
  });

  it("停止超时有界：记录失败但不拖住退出", async () => {
    const harness = build({ stopOwnedOnExit: true });
    await harness.settle(harness.manager.ensureReady());
    // 停不掉的进程：超时必须有界，且不能把定时器留在那。
    harness.port.setStopBehavior("hang");
    await harness.settle(harness.manager.dispose());
    expect(harness.manager.diagnostics().stopFailures).toBe(1);
    expect(harness.timers.active()).toBe(0);
  });

  it("默认保留桌宠：stopOwnedOnExit=false 时释放所有权但不终止进程", async () => {
    const harness = build({ stopOwnedOnExit: false });
    await harness.settle(harness.manager.ensureReady());
    expect(harness.port.aliveCount()).toBe(1);
    await harness.settle(harness.manager.dispose());
    expect(harness.port.stopCalls).toEqual([]);
    expect(harness.port.aliveCount()).toBe(1);
  });

  it("stopOwnedOnExit=true 时只停止自己起的那个进程", async () => {
    const harness = build({ stopOwnedOnExit: true });
    await harness.settle(harness.manager.ensureReady());
    const pid = harness.port.lastPid();
    await harness.settle(harness.manager.dispose());
    expect(harness.port.stopCalls).toEqual([pid]);
  });

  it("spawn 抛错只降级，不抛出非 PetProcessError", async () => {
    // 探测始终不可达：否则第二次调用会走 attach 分支而"成功"，掩盖真正的原因。
    const harness = build({ probe: async () => "offline" });
    harness.port.failSpawnWith(new Error("Access is denied"));
    await expect(harness.settle(harness.manager.ensureReady())).rejects.toBeInstanceOf(PetProcessError);
    await expect(harness.settle(harness.manager.ensureReady())).rejects.toMatchObject({ kind: "spawn_failed" });
    expect(harness.spawns()).toEqual([]);
  });
});

describe("PET-05-G 双轨记录", () => {
  it("原生进程模块存在且具备所有权与无窗口启动", () => {
    const source = readFileSync(
      join(import.meta.dirname ?? ".", "../../../src-tauri/src/desktop_pet_process.rs"),
      "utf8",
    );
    expect(source).toContain("CREATE_NO_WINDOW");
    expect(source).toContain("desktop_pet_process_spawn");
    expect(source).toContain("desktop_pet_process_stop");
    // 只按句柄停止：模块里不存在「按名字批量 kill」的接口。
    expect(source).not.toMatch(/taskkill|by_name/i);
  });
});

/**
 * MVP-12 反向点击通道：武装与撤销必须跟**所有权**同步，而不是跟「配置」同步。
 * 这里钉住的是时机——受管派生才武装、归还所有权就撤销、attach 永不武装。
 */
describe("MVP-12 反向点击通道的武装与撤销", () => {
  function clickPort(
    options: {
      arm?: () => Promise<{ url: string; token: string } | null>;
      withoutCapability?: boolean;
    } = {},
  ): {
    port: FakeOsProcessPort;
    spawnOptions: Array<PetProcessSpawnOptions | undefined>;
    calls: { arm: number; disarm: number };
  } {
    const fake = createFakeOsProcessPort();
    const spawnOptions: Array<PetProcessSpawnOptions | undefined> = [];
    const calls = { arm: 0, disarm: 0 };
    const port: FakeOsProcessPort = {
      ...fake,
      spawn: (path, spawnOption) => {
        spawnOptions.push(spawnOption);
        return fake.spawn(path, spawnOption);
      },
      ...(options.withoutCapability
        ? {}
        : {
            armClickChannel: async () => {
              calls.arm += 1;
              return options.arm
                ? options.arm()
                : { url: "http://127.0.0.1:9/api/pet/click", token: "click-token-0123456789" };
            },
            disarmClickChannel: async () => {
              calls.disarm += 1;
            },
          }),
    };
    return { port, spawnOptions, calls };
  }

  it("受管派生：武装一次并注入成对凭据；归还所有权时撤销", async () => {
    const { port, spawnOptions, calls } = clickPort();
    const harness = build({ port, createExitToken: () => "0123456789abcdef", stopOwnedOnExit: true });
    await harness.settle(harness.manager.ensureReady());

    expect(calls.arm).toBe(1);
    expect(spawnOptions).toHaveLength(1);
    expect(spawnOptions[0]).toMatchObject({
      exitToken: "0123456789abcdef",
      clickUrl: "http://127.0.0.1:9/api/pet/click",
      clickToken: "click-token-0123456789",
      // stopOwnedOnExit 在 spawn 时定死并下沉到 Rust：托盘退出靠它收尾。
      stopOnHostExit: true,
    });

    await harness.settle(harness.manager.dispose());
    expect(calls.disarm).toBe(1);
  });

  it("attach 模式零武装：没有派生就没有反向通道", async () => {
    const { port, spawnOptions, calls } = clickPort();
    const harness = build({ mode: "attach", port });
    await harness.settle(harness.manager.ensureReady());

    expect(calls.arm).toBe(0);
    expect(spawnOptions).toHaveLength(0);
  });

  it("武装失败：派生照常，但不注入点击凭据", async () => {
    const { port, spawnOptions, calls } = clickPort({
      arm: async () => {
        throw new Error("host has no click endpoint");
      },
    });
    const harness = build({ port });
    await harness.settle(harness.manager.ensureReady());

    expect(spawnOptions).toHaveLength(1);
    expect(spawnOptions[0]?.clickUrl).toBeUndefined();
    expect(spawnOptions[0]?.clickToken).toBeUndefined();
    expect(calls.disarm).toBe(0);
  });

  it("宿主没有这个能力：不注入任何东西（不回退成「没凭据也让它上报」）", async () => {
    const { port, spawnOptions, calls } = clickPort({ withoutCapability: true });
    const harness = build({ port });
    await harness.settle(harness.manager.ensureReady());

    expect(spawnOptions).toHaveLength(1);
    expect(spawnOptions[0]).toBeUndefined();
    expect(calls.arm).toBe(0);
  });

  it("武装成功但派生失败：立刻撤销，不让凭据悬着", async () => {
    const { port, calls } = clickPort();
    port.failSpawnWith(new Error("Access is denied"));
    const harness = build({ port });

    await expect(harness.settle(harness.manager.ensureReady())).rejects.toBeInstanceOf(
      PetProcessError,
    );
    expect(calls.arm).toBe(1);
    expect(calls.disarm).toBe(1);
  });
});
