import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PetContext } from "./contracts";
import { createOpenPetAdapter } from "./openPetAdapter";
import {
  assertLoopbackBase,
  buildEventRequest,
  buildRequest,
  buildSayRequest,
  OPENPET_ENDPOINTS,
  parseOpenPetResponse,
  PetHttpFailure,
  type PetHttpRequest,
} from "./openPetProtocol";
import { createTauriPetHttpPort } from "./tauriPetHttp";
import {
  alwaysFail,
  alwaysRespond,
  createFakeClock,
  createFakePetHttp,
  fakePetProfile,
} from "./fakeDesktopPet";
import {
  DEVICE_400_BLANK_ANIMATION,
  DEVICE_STATUS_SNAPSHOT,
  jsonResponse,
  OK_POST,
  OK_STATUS,
  OK_STATUS_WITH_VERSION,
  RESPONSE_FIXTURES,
} from "./fixtures/openPetFixtures";

/**
 * PET-03 定向测试：生产 adapter + 假传输端口。
 *
 * 真实 WebView→原生→OpenPet 的链路不在这一层（PET-07）；这里证明的是
 * 「请求形状、判定规则、降级语义」三者正确。
 */

function contextAt(clock: ReturnType<typeof createFakeClock>, ttlMs = 4_000): PetContext {
  return { commandId: "c1", expiresAt: clock.now() + ttlMs };
}

describe("PET-03-A 四端点黄金 fixture", () => {
  it("方法/路径/body 精确匹配固定表；action 不带 ttlMs；emotion 复用已验证 action", async () => {
    const http = createFakePetHttp(alwaysRespond(OK_POST));
    const clock = createFakeClock(1_000);
    // 上游快照里的 activePet.id 是 nia，profile 必须与它一致才认为映射已验证。
    const profile = fakePetProfile({ petId: "nia" });
    const adapter = createOpenPetAdapter({
      http,
      clock,
      endpoint: "http://localhost:17321",
      profile: () => profile,
    });

    const status = await adapter.status();
    expect(status.connection).toBe("ready");
    expect(status.petId).toBe("nia");
    expect(http.calls[0]).toMatchObject({ method: "GET", endpoint: "status", base: "http://127.0.0.1:17321" });
    expect(http.calls[0]!.body).toBeUndefined();

    const context = contextAt(clock);
    await adapter.say("回来啦", context);
    expect(http.calls[1]).toMatchObject({ method: "POST", endpoint: "say" });
    expect(JSON.parse(http.calls[1]!.body!)).toEqual({ text: "回来啦", ttlMs: 4_000 });

    await adapter.action("wave", context);
    expect(http.calls[2]).toMatchObject({ method: "POST", endpoint: "action" });
    // 上游 action 没有 ttlMs 字段：多塞一个就是我们的猜测。
    expect(JSON.parse(http.calls[2]!.body!)).toEqual({ animationId: "anim_wave" });

    await adapter.emotion("happy", context);
    // 没有 /api/emotion：情绪最终仍然走 action，且只用已验证的 animationId。
    expect(http.calls[3]).toMatchObject({ method: "POST", endpoint: "action" });
    expect(JSON.parse(http.calls[3]!.body!)).toEqual({ animationId: "anim_happy" });

    await adapter.event("thinking", "让我想一下……", context);
    expect(http.calls[4]).toMatchObject({ method: "POST", endpoint: "event" });
    expect(JSON.parse(http.calls[4]!.body!)).toEqual({
      type: "thinking", message: "让我想一下……", ttlMs: 4_000,
    });

    // 白名单之外的动作：一次请求都不发。
    expect(await adapter.action("backflip", context)).toEqual({ outcome: "skipped", code: "unsupported" });
    expect(http.calls).toHaveLength(5);
  });

  it("请求构造是纯函数：GET 无 body、POST 带 JSON、TTL 可选", () => {
    expect(buildRequest("http://127.0.0.1:17321", "status")).toEqual({
      method: "GET", base: "http://127.0.0.1:17321", endpoint: "status", timeoutMs: 1_500,
    });
    expect(JSON.parse(buildSayRequest("http://127.0.0.1:17321", "在").body!)).toEqual({ text: "在" });
    expect(JSON.parse(buildSayRequest("http://127.0.0.1:17321", "在", 4_000).body!)).toEqual({ text: "在", ttlMs: 4_000 });
    expect(JSON.parse(buildEventRequest("http://127.0.0.1:17321", "success").body!)).toEqual({ type: "success" });
  });

  it("端点表是封闭的四项，没有 emotion、也没有任意路径", () => {
    expect(Object.keys(OPENPET_ENDPOINTS).sort()).toEqual(["action", "event", "say", "status"]);
    for (const spec of Object.values(OPENPET_ENDPOINTS)) {
      expect(spec.path.startsWith("/api/")).toBe(true);
    }
    // 类型层面就不接受自由路径：请求里带的是端点 key。
    const crafted = { ...buildRequest("http://127.0.0.1:17321", "status"), endpoint: "status" } as PetHttpRequest;
    expect(Object.values(OPENPET_ENDPOINTS).map((spec) => spec.path)).not.toContain(crafted.endpoint);
  });

  it("响应 fixture 逐条判定正确", () => {
    for (const fixture of RESPONSE_FIXTURES) {
      const verdict = parseOpenPetResponse(fixture.response.status, fixture.response.bodyText);
      expect(verdict.kind, fixture.name).toBe(fixture.expect);
    }
    // 上游若提供版本与动作清单，按同名解析（前向兼容，不是对现有字段的断言）。
    const verdict = parseOpenPetResponse(OK_STATUS_WITH_VERSION.status, OK_STATUS_WITH_VERSION.bodyText);
    expect(verdict).toEqual({
      kind: "accepted",
      snapshot: { port: 17321, petId: "nia", runtimeVersion: "0.1.6", actions: ["waving", "jumping"] },
    });
    const minimal = parseOpenPetResponse(OK_STATUS.status, OK_STATUS.bodyText);
    expect(minimal).toEqual({ kind: "accepted", snapshot: { port: 17321, petId: "nia" } });

    // 实机快照：只承认真的存在的字段。上游没有 version、也没有 actions 清单，
    // 所以解析结果里不能凭空多出这两个键——「没有」就是「没有」。
    const device = parseOpenPetResponse(DEVICE_STATUS_SNAPSHOT.status, DEVICE_STATUS_SNAPSHOT.bodyText);
    expect(device).toEqual({ kind: "accepted", snapshot: { port: 17321, petId: "nia" } });
  });
});

describe("PET-03-B 失败分类正确且 POST 永不重发", () => {
  const cases: Array<{ name: string; handler: Parameters<typeof createFakePetHttp>[0]; expect: unknown }> = [
    {
      name: "连接被拒绝（确定没送到）",
      handler: alwaysFail(new PetHttpFailure("connection")),
      expect: { outcome: "failed", code: "offline" },
    },
    {
      name: "超时（可能已送达，只能 unknown）",
      handler: alwaysFail(new PetHttpFailure("timeout")),
      expect: { outcome: "unknown", code: "timeout" },
    },
    {
      name: "响应超大",
      handler: alwaysFail(new PetHttpFailure("too_large")),
      expect: { outcome: "unknown", code: "protocol_error" },
    },
    {
      name: "传输层拦截（非 loopback / 端点表外）",
      handler: alwaysFail(new PetHttpFailure("blocked")),
      expect: { outcome: "failed", code: "unsupported" },
    },
    {
      name: "404 端点不存在",
      handler: alwaysRespond({ status: 404, bodyText: "Not Found" }),
      expect: { outcome: "failed", code: "unsupported" },
    },
    {
      // 实机核对得到的修正：400 是「请求体不合法」，不是「协议不兼容」。
      name: "400 请求体被拒（实机：空 animationId）",
      handler: alwaysRespond(DEVICE_400_BLANK_ANIMATION),
      expect: { outcome: "failed", code: "invalid_input" },
    },
    {
      name: "500 上游错误",
      handler: alwaysRespond({ status: 500, bodyText: "boom" }),
      expect: { outcome: "failed", code: "http_error" },
    },
    {
      name: "200 但 ok=false",
      handler: alwaysRespond(jsonResponse(200, { ok: false, error: "unknown animationId" })),
      expect: { outcome: "failed", code: "protocol_error" },
    },
    {
      name: "200 但响应是 HTML",
      handler: alwaysRespond({ status: 200, bodyText: "<html>hello</html>" }),
      expect: { outcome: "unknown", code: "protocol_error" },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} → ${JSON.stringify(testCase.expect)}`, async () => {
      const http = createFakePetHttp(testCase.handler);
      const clock = createFakeClock(1_000);
      const adapter = createOpenPetAdapter({
        http,
        clock,
        endpoint: "http://127.0.0.1:17321",
        profile: () => fakePetProfile(),
      });
      expect(await adapter.say("在的", contextAt(clock))).toEqual(testCase.expect);
      // 关键断言：POST 只发一次。桌宠气泡绝不能因为重试而说两遍。
      expect(http.countOf("say")).toBe(1);
    });
  }

  it("剩余寿命不足 500ms 时直接 expired，不发请求", async () => {
    const http = createFakePetHttp(alwaysRespond(OK_POST));
    const clock = createFakeClock(1_000);
    const adapter = createOpenPetAdapter({
      http,
      clock,
      endpoint: "http://127.0.0.1:17321",
      profile: () => fakePetProfile(),
    });
    expect(await adapter.say("在的", { commandId: "c", expiresAt: clock.now() + 100 }))
      .toEqual({ outcome: "skipped", code: "expired" });
    expect(http.calls).toHaveLength(0);
  });

  it("TTL 收口到 500–10000ms", async () => {
    const http = createFakePetHttp(alwaysRespond(OK_POST));
    const clock = createFakeClock(0);
    const adapter = createOpenPetAdapter({
      http, clock, endpoint: "http://127.0.0.1:17321", profile: () => fakePetProfile(),
    });
    await adapter.say("a", { commandId: "c", expiresAt: 60_000 });
    expect(JSON.parse(http.calls[0]!.body!)).toEqual({ text: "a", ttlMs: 10_000 });
  });
});

describe("PET-03-C 非 loopback / 重定向 / 任意路径在生产传输层被拒", () => {
  it("构造期就拒绝非 loopback 地址", () => {
    for (const bad of ["http://10.0.0.5:17321", "https://127.0.0.1:17321", "http://127.0.0.1:17321/api"]) {
      expect(() => createOpenPetAdapter({
        http: createFakePetHttp(), clock: createFakeClock(), endpoint: bad,
      }), bad).toThrow(/桌宠地址非法/);
    }
    expect(assertLoopbackBase("http://[::1]:17321")).toBe("http://[::1]:17321");
  });

  it("收到重定向不跟随后续请求，且判为协议不兼容", async () => {
    const http = createFakePetHttp(alwaysRespond({ status: 302, bodyText: "" }));
    const clock = createFakeClock();
    const adapter = createOpenPetAdapter({
      http, clock, endpoint: "http://127.0.0.1:17321", profile: () => fakePetProfile(),
    });
    const status = await adapter.status();
    expect(status.connection).toBe("incompatible");
    expect(status.stale).toBe(true);
    // 重定向目标没有被跟随：只有最初那一次请求。
    expect(http.calls).toHaveLength(1);
  });

  it("识别不出 OpenPet 的响应时不向这个端口发任何控制请求", async () => {
    const http = createFakePetHttp(alwaysRespond({ status: 200, bodyText: "<html>我占着端口</html>" }));
    const clock = createFakeClock();
    const adapter = createOpenPetAdapter({
      http, clock, endpoint: "http://127.0.0.1:17321", profile: () => fakePetProfile(),
    });
    expect((await adapter.status()).connection).toBe("incompatible");
    expect(http.countOf("say")).toBe(0);
    expect(http.countOf("action")).toBe(0);
    expect(http.countOf("event")).toBe(0);
  });

  it("原生端口的 base 再次校验：非法地址连 invoke 都不发", async () => {
    const invokes: Array<Record<string, unknown>> = [];
    const port = createTauriPetHttpPort(async (_command, args) => {
      invokes.push(args ?? {});
      return { status: 200, body: "{}" };
    });
    await port.send({ ...buildRequest("http://localhost:17321", "say"), body: "{}" });
    // 传下去的是**端点 key**与归一化后的 base，不是页面拼出来的路径。
    expect(invokes[0]).toMatchObject({
      base: "http://127.0.0.1:17321", endpoint: "say", timeoutMs: 1_500,
    });
    expect(invokes[0]).not.toHaveProperty("url");

    await expect(port.send(buildRequest("http://10.0.0.5:17321", "say")))
      .rejects.toMatchObject({ kind: "blocked" });
    expect(invokes).toHaveLength(1);
  });

  it("Rust 侧失败码映射回端口语义", async () => {
    const port = createTauriPetHttpPort(async () => {
      throw { kind: "too_large" };
    });
    await expect(port.send(buildRequest("http://127.0.0.1:17321", "status")))
      .rejects.toMatchObject({ kind: "too_large" });

    const weird = createTauriPetHttpPort(async () => {
      throw "unexpected";
    });
    // 认不出的失败按「确定没送到」处理，绝不因此重发。
    await expect(weird.send(buildRequest("http://127.0.0.1:17321", "status")))
      .rejects.toMatchObject({ kind: "connection" });
  });
});

describe("PET-03-D 角色变化与未知响应", () => {
  it("上游角色与 profile 不符时不发旧映射的动作", async () => {
    const http = createFakePetHttp(async (request) => (
      request.endpoint === "status" ? jsonResponse(200, { activePet: { id: "nia" } }) : OK_POST
    ));
    const clock = createFakeClock();
    const adapter = createOpenPetAdapter({
      // profile 说的是 default，上游现在是 nia。
      http, clock, endpoint: "http://127.0.0.1:17321", profile: () => fakePetProfile(),
    });
    expect((await adapter.status()).petId).toBe("nia");
    expect(await adapter.action("wave", contextAt(clock))).toEqual({ outcome: "skipped", code: "unsupported" });
    expect(await adapter.emotion("happy", contextAt(clock))).toEqual({ outcome: "skipped", code: "unsupported" });
    expect(http.countOf("action")).toBe(0);
  });
});

describe("PET-03-E 双轨记录", () => {
  it("Rust 模块固定四端点、禁用代理与重定向、限制响应体积", () => {
    const source = readFileSync(
      join(import.meta.dirname ?? ".", "../../../src-tauri/src/desktop_pet_http.rs"),
      "utf8",
    );
    for (const path of ["/api/status", "/api/say", "/api/action", "/api/event"]) {
      expect(source).toContain(path);
    }
    expect(source).toContain("no_proxy");
    expect(source).toContain("Policy::none");
    expect(source).toContain("MAX_RESPONSE_BYTES");
    // 命令注册在 lib.rs（原生装配点）。
    const lib = readFileSync(
      join(import.meta.dirname ?? ".", "../../../src-tauri/src/lib.rs"),
      "utf8",
    );
    expect(lib).toContain("desktop_pet_http::desktop_pet_http_request");
  });
});
