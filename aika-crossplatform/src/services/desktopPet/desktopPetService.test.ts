import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PET_OFFLINE_BACKOFF_MS,
  PET_PROBE_INTERVAL_MS,
  normalizeLoopbackEndpoint,
  normalizePetConfig,
  projectPetText,
  type DesktopPetService,
} from "./contracts";
import { createDesktopPetService, capabilityIsUsable } from "./desktopPetService";
import {
  capabilityAllows,
  deriveCapabilities,
  resolveEmotionId,
  unknownCapabilities,
  validatePetProfile,
} from "./profile";
import { MOODS } from "../../domain/mood";
import {
  connection,
  createFakeAdapter,
  createFakeClock,
  createFakeProcessPort,
  createFakeTimers,
  fakePetProfile,
  fakePetStatus,
  type FakeDesktopPetAdapter,
  type FakeTimers,
} from "./fakeDesktopPet";

/**
 * PET-02 定向测试。
 *
 * 被测的是**生产实现**：Service、profile 校验、能力推导、结果归一化。
 * 只有外部依赖（第三方 Runtime 的 HTTP、时钟、定时器、进程端口）是 fake。
 */

function build(options: {
  adapter: FakeDesktopPetAdapter;
  clock?: ReturnType<typeof createFakeClock>;
  timers?: FakeTimers;
  profile?: ReturnType<typeof fakePetProfile> | null;
  config?: Parameters<typeof createDesktopPetService>[0]["config"];
  process?: ReturnType<typeof createFakeProcessPort>;
}): DesktopPetService {
  return createDesktopPetService({
    adapter: options.adapter,
    clock: options.clock ?? createFakeClock(1_000),
    timers: options.timers ?? createFakeTimers(),
    profile: options.profile === undefined ? fakePetProfile() : options.profile,
    ...(options.config ? { config: options.config } : {}),
    ...(options.process ? { process: options.process } : {}),
  });
}

describe("PET-02-A 五个归一化方法的稳定结果", () => {
  it("say/action/emotion/event 走 adapter，accepted 只表示受理", async () => {
    const adapter = createFakeAdapter();
    const clock = createFakeClock(1_000);
    const service = build({ adapter, clock });
    await service.enable();

    const say = await service.say("回来啦");
    const action = await service.action("wave");
    const emotion = await service.emotion("happy");
    const event = await service.event("thinking", "让我想一下……");

    expect([say, action, emotion, event]).toEqual([
      { outcome: "accepted" }, { outcome: "accepted" },
      { outcome: "accepted" }, { outcome: "accepted" },
    ]);
    // adapter 收到的是**归一化后**的语义名，不是供应商 id。
    expect(adapter.calls.say).toEqual(["回来啦"]);
    expect(adapter.calls.action).toEqual(["wave"]);
    expect(adapter.calls.emotion).toEqual(["happy"]);
    expect(adapter.calls.event).toEqual([{ type: "thinking", message: "让我想一下……" }]);

    // commandId / expiresAt 由 Service 分配，业务调用者看不到也不需要手造。
    const context = adapter.lastContext();
    expect(context?.commandId).toMatch(/^\d+-\d+$/);
    expect(context?.expiresAt).toBe(clock.now() + 4_000);
  });

  it("status 快照区分连接与能力：不把 accepted 写成 played", async () => {
    const adapter = createFakeAdapter();
    const service = build({ adapter });
    await service.enable();
    const status = await service.status();
    expect(status.connection).toBe("ready");
    expect(status.capabilities.say).toBe("native");
    expect(status.stale).toBe(false);
    // 结果类型里没有 played 这个概念，接口本身就不给伪造的机会。
    expect(Object.keys(await service.say("在的"))).toEqual(["outcome"]);
  });

  it("结果代码原样上交：上游拒绝就是 failed/http_error", async () => {
    const adapter = createFakeAdapter({ result: { outcome: "failed", code: "http_error" } });
    const service = build({ adapter });
    await service.enable();
    expect(await service.say("在的")).toEqual({ outcome: "failed", code: "http_error" });
    expect(service.diagnostics().failed).toBe(1);
    expect(service.diagnostics().lastErrorCode).toBe("http_error");
  });
});

describe("PET-02-B endpoint 归一化与文本边界", () => {
  it("localhost 归一化为 127.0.0.1，IPv6 loopback 合法", () => {
    expect(normalizeLoopbackEndpoint("http://localhost:17321")?.endpoint).toBe("http://127.0.0.1:17321");
    expect(normalizeLoopbackEndpoint("http://[::1]:17321")?.endpoint).toBe("http://[::1]:17321");
    expect(normalizeLoopbackEndpoint("http://127.0.0.1:17321/")?.endpoint).toBe("http://127.0.0.1:17321");
  });

  it("LAN、公网、https、凭证、路径、query 一律拒绝", () => {
    for (const bad of [
      "http://10.0.0.5:17321",
      "http://192.168.1.10:17321",
      "https://example.com:17321",
      "http://pet.example.com:17321",
      "http://user:pass@127.0.0.1:17321",
      "http://127.0.0.1:17321/api/status",
      "http://127.0.0.1:17321/?redirect=1",
      "http://127.0.0.1:17321#frag",
      "http://127.0.0.1",
      "ftp://127.0.0.1:17321",
      "",
    ]) {
      expect(normalizeLoopbackEndpoint(bad), bad).toBeNull();
    }
  });

  it("配置里的非法地址显式抛错，不静默退回默认值", () => {
    expect(() => normalizePetConfig({ endpoint: "http://10.0.0.5:17321" })).toThrow(/桌宠地址非法/);
    const config = normalizePetConfig({ endpoint: "http://localhost:17321", mode: "managed" });
    expect(config.endpoint).toBe("http://127.0.0.1:17321");
    expect(config.enabled).toBe(false);
    expect(config.mode).toBe("managed");
  });

  it("空文本拒绝，Unicode 按 code point 截断且不劈开代理对", () => {
    expect(projectPetText("   ").text).toBe("");

    const emoji = "🙂".repeat(600);
    const projection = projectPetText(emoji);
    expect(projection.truncated).toBe(true);
    expect(Array.from(projection.text).length).toBe(500);
    expect(projection.text.endsWith("…")).toBe(true);
    // 截断处不是半个代理对（U+FFFD 或孤立 surrogate）。
    expect(projection.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(projection.removed).toBe(101);

    expect(projectPetText("短").truncated).toBe(false);
  });

  it("Service 层同样执行文本规则：空 say 判 invalid_input，超长计入截断计数", async () => {
    const adapter = createFakeAdapter();
    const service = build({ adapter });
    await service.enable();
    expect(await service.say("   ")).toEqual({ outcome: "skipped", code: "invalid_input" });
    expect(adapter.calls.say).toEqual([]);

    await service.say("字".repeat(700));
    expect(Array.from(adapter.calls.say[0]!).length).toBe(500);
    expect(service.diagnostics().truncatedTexts).toBe(1);
  });
});

describe("PET-02-C 能力不靠猜：断线、版本、角色与缺失字段", () => {
  it("断线时标 stale 且能力回落，不把缓存当可用", async () => {
    const adapter = createFakeAdapter();
    const service = build({ adapter });
    await service.enable();
    expect(service.snapshot().capabilities.say).toBe("native");

    adapter.setStatus(connection("offline"));
    await service.status();
    expect(service.snapshot().stale).toBe(true);
    expect(service.snapshot().capabilities).toEqual(unknownCapabilities());
    expect(service.snapshot().actions).toEqual([]);
    expect(await service.say("在的")).toEqual({ outcome: "skipped", code: "offline" });
  });

  it("版本与锁定 profile 不符时不猜动作，也不猜请求体", async () => {
    const adapter = createFakeAdapter({ status: fakePetStatus({ runtimeVersion: "v9.9.9" }) });
    const service = build({ adapter });
    await service.enable();
    expect(service.snapshot().capabilities).toEqual(unknownCapabilities());
    expect(await service.action("wave")).toEqual({ outcome: "skipped", code: "unsupported" });
  });

  it("当前角色与 profile 不符：say 仍可，动作/情绪降级为 unknown", async () => {
    const adapter = createFakeAdapter({ status: fakePetStatus({ petId: "someone-else" }) });
    const service = build({ adapter });
    await service.enable();
    const snapshot = service.snapshot();
    expect(snapshot.capabilities.say).toBe("native");
    expect(snapshot.capabilities.action).toBe("unknown");
    expect(snapshot.capabilities.emotion).toBe("unknown");
    expect(snapshot.actions).toEqual([]);
  });

  it("没有 profile 时没有任何能力被宣称；OpenPet 明确没有点击回传/音频/口型", () => {
    const capabilities = deriveCapabilities({
      profile: null,
      connection: "ready",
      declared: {},
      provider: "openpet",
    });
    expect(capabilities).toEqual(unknownCapabilities());

    const withProfile = deriveCapabilities({
      profile: fakePetProfile(),
      connection: "ready",
      declared: {},
      provider: "openpet",
    });
    expect(withProfile.interactionEvents).toBe("unsupported");
    expect(withProfile.audio).toBe("unsupported");
    expect(withProfile.lipSync).toBe("unsupported");
    expect(capabilityAllows(withProfile.action)).toBe(true);
    expect(capabilityAllows("unknown")).toBe(false);
  });

  it("运行期角色切换立即失效旧映射并递增 generation", async () => {
    const adapter = createFakeAdapter({ status: fakePetStatus({ petId: "default" }) });
    const service = build({ adapter });
    await service.enable();
    const before = service.snapshot().generation;

    adapter.setStatus(fakePetStatus({ petId: "other-role" }));
    await service.status();
    expect(service.snapshot().generation).toBeGreaterThan(before);
    expect(service.snapshot().actions).toEqual([]);
  });

  it("损坏的 profile 等价于没有 profile，而不是让接入层起不来", () => {
    expect(validatePetProfile({ schemaVersion: 1, provider: "openpet" })).toBeNull();
    expect(validatePetProfile({
      ...fakePetProfile(),
      actions: { "../../evil.sh": "x" },
    })).toBeNull();
    const service = build({ adapter: createFakeAdapter(), profile: null });
    expect(service.snapshot().capabilities).toEqual(unknownCapabilities());
  });
});

describe("PET-02-D 生命周期幂等：20 次开关不留订阅与定时器", () => {
  it("反复 enable/disable/dispose 不残留定时器，旧 generation 的迟到结果不写新状态", async () => {
    const adapter = createFakeAdapter();
    const timers = createFakeTimers();
    const service = build({ adapter, timers });

    for (let i = 0; i < 20; i += 1) {
      await service.enable();
      await service.enable();
      expect(timers.active()).toBe(1);
      expect(timers.pendingDelays()).toEqual([PET_PROBE_INTERVAL_MS]);
      await service.disable();
      await service.disable();
      expect(timers.active()).toBe(0);
    }

    await service.enable();
    const deferred = adapter.deferNextStatus();
    const pending = service.status();
    await service.disable();
    deferred.resolve(fakePetStatus({ connection: "ready" }));
    await pending;
    // 旧探测按新状态判定为过期，快照必须停在 disabled。
    expect(service.snapshot().connection).toBe("disabled");
    expect(service.snapshot().stale).toBe(true);

    await service.dispose();
    await service.dispose();
    expect(adapter.calls.dispose).toBe(1);
    expect(timers.active()).toBe(0);
  });

  it("退订之后不再收到通知", async () => {
    const adapter = createFakeAdapter();
    const service = build({ adapter });
    const seen: unknown[] = [];
    const unsubscribe = service.subscribe((snapshot) => seen.push(snapshot));
    unsubscribe();
    await service.enable();
    expect(seen).toEqual([]);
  });

  it("离线按 2/4/8/16/30 秒退避，不无限高频探测", async () => {
    const adapter = createFakeAdapter({ status: connection("offline") });
    const timers = createFakeTimers();
    const service = build({ adapter, timers });
    await service.enable();

    const observed: number[] = [];
    for (let i = 0; i < PET_OFFLINE_BACKOFF_MS.length; i += 1) {
      observed.push(timers.pendingDelays()[0]!);
      timers.advance(observed[i]!);
      await flush();
    }
    expect(observed).toEqual([...PET_OFFLINE_BACKOFF_MS]);
    await service.dispose();
  });

  it("托管模式启动失败转 offline，不抛给调用方", async () => {
    const adapter = createFakeAdapter({ status: connection("offline") });
    const process = createFakeProcessPort("managed", false);
    process.setFailure(new Error("spawn failed"));
    const service = build({
      adapter,
      process,
      config: { mode: "managed", executablePath: "C:\\pet\\pet.exe" },
    });
    await service.enable();
    // 启动失败只降级，不抛：业务侧看到的仍是一个可用（只是离线）的服务。
    expect(service.snapshot().connection).toBe("offline");
    expect(service.snapshot().stale).toBe(true);
    expect(process.attempts).toBe(1);
    expect(process.ready).toBe(0);
  });
});

describe("PET-02-E adapter 异常不外溢：没有第二套编排", () => {
  it("adapter 抛异常时业务轮次照常提交", async () => {
    const adapter = createFakeAdapter();
    adapter.setResult(() => Promise.reject(new Error("boom")));
    const service = build({ adapter });
    await service.enable();

    // 这一段模拟对话编排：它只等自己的 Runtime，桌宠结果只是旁路返回值。
    const submissions: string[] = [];
    const fakeRuntime = {
      async submit(text: string) {
        submissions.push(text);
        return `turn-${submissions.length}`;
      },
    };

    const [petResult, turnId] = await Promise.all([
      service.say("在的"),
      fakeRuntime.submit("在的"),
    ]);
    expect(petResult).toEqual({ outcome: "unknown", code: "protocol_error" });
    expect(turnId).toBe("turn-1");
    expect(submissions).toEqual(["在的"]);
  });

  it("探测异常只转成 offline 诊断", async () => {
    const adapter = createFakeAdapter();
    adapter.setStatus(() => Promise.reject(new Error("connection refused")));
    const service = build({ adapter });
    await service.enable();
    expect(service.snapshot().connection).toBe("offline");
    expect(service.diagnostics().probeFailures).toBe(1);
  });

  it("接入层源码不 import 对话编排或 Provider", () => {
    const dir = import.meta.dirname ?? ".";
    const offenders: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (!/\.ts$/.test(entry) || /\.test\.ts$/.test(entry)) continue;
      if (entry === "fakeDesktopPet.ts") continue;
      // 剥掉注释再判：说明「为什么不 import 编排」的中文注释是有价值的，
      // 真正要禁的是代码依赖（与 kernel/architecture.test.ts 同一口径）。
      const source = readFileSync(join(dir, entry), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
      if (/providerClient|companionRuntime|RuntimeToken|providerAdapter/.test(source)) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });
});

describe("PET-02-F 可选契约登记与能力缺失降级", () => {
  it("共享契约已登记 desktopPet.integration.v1", () => {
    const doc = readFileSync(join(import.meta.dirname ?? ".", "../../../../docs/modules/CONTRACTS.md"), "utf8");
    expect(doc).toContain("desktopPet.integration.v1");
    expect(doc).toContain("DesktopPetServiceToken");
  });

  it("宿主没有桌宠能力时消费方拿到 null 并隐藏入口", () => {
    // 消费方写法：optional 声明 + tryResolve。这里用一个最小的注册表替身证明降级路径。
    const consumer = (resolve: () => DesktopPetService | null) => {
      const service = resolve();
      return service ? "visible" : "hidden";
    };
    expect(consumer(() => null)).toBe("hidden");
    const service = build({ adapter: createFakeAdapter() });
    expect(consumer(() => service)).toBe("visible");
    expect(service.isEnabled()).toBe(false);
    expect(capabilityIsUsable("native")).toBe(true);
    expect(capabilityIsUsable("unsupported")).toBe(false);
  });
});

describe("PET-02-G profile 的键空间必须能容纳 Aiki 自己的词表", () => {
  function profileWith(emotions: Record<string, string>): unknown {
    return {
      schemaVersion: 1, provider: "openpet", release: "v0.1.6", petId: "nia", source: "manual",
      actions: { wave: "waving" }, emotions, events: {},
    };
  }

  it("七个 mood 名都能作为 emotions 的键（包括带下划线的 gentle_smile）", () => {
    // 这条是 PET-07 真机核对撞出来的：早期 SEMANTIC_NAME 不允许下划线，于是
    // profile 里写一个 `gentle_smile` 会让**整份 profile** 校验失败 → 能力全部降为
    // unknown → 一条命令都发不出去，而界面/日志/上游响应里没有任何迹象。
    for (const mood of MOODS) {
      const profile = validatePetProfile(profileWith({ [mood]: "waiting" }));
      expect(profile, mood).not.toBeNull();
      expect(resolveEmotionId(profile, mood), mood).toBe("waiting");
    }
  });

  it("仍然拒绝路径、命令行与带空格的键", () => {
    for (const bad of ["../etc/passwd", "a/b", "a.b", "A-B", "a b", "a;rm", "-lead", "a\\b"]) {
      expect(validatePetProfile(profileWith({ [bad]: "waving" })), bad).toBeNull();
    }
  });

  it("一个坏键就让整份 profile 失效：fail-closed，不静默放行", () => {
    expect(validatePetProfile(profileWith({ "Gentle Smile": "waving" }))).toBeNull();
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}
