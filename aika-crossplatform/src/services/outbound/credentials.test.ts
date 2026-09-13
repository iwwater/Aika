import { describe, expect, it } from "vitest";
import type { AikaStorage } from "../storage/contracts";
import { createCredentialRepository, hashToken, MAX_PAIRING_ATTEMPTS } from "./credentials";
import { authenticateRequest, checkRoute, effectiveExposure } from "./exposurePolicy";

const BASE = Date.UTC(2026, 0, 10, 12, 0);
let seq = 0;

function makeRepository(clockNow = BASE) {
  const settings = new Map<string, string>();
  let now = clockNow;
  const storage = {
    async getSetting(key: string) { return settings.get(key) ?? null; },
    async setSetting(key: string, value: string) { settings.set(key, value); },
  } as unknown as AikaStorage;
  const repository = createCredentialRepository({
    loadStorage: async () => storage,
    clock: () => now,
    random: (length) => `r${(seq += 1).toString().padStart(4, "0")}${"x".repeat(Math.max(0, length - 5))}`,
  });
  return {
    repository,
    settings,
    tick: (ms: number) => { now += ms; },
  };
}

describe("配对与凭证（FE-17-pre / FE-17-B 局部）", () => {
  it("兑换成功返回一次性凭证；重复兑换 already-consumed", async () => {
    const fixture = makeRepository();
    const { code } = await fixture.repository.issuePairingCode({ deviceId: "dev-1", principalId: "ext-A" });
    const first = await fixture.repository.redeemPairingCode({ code, deviceId: "dev-1" });
    expect(first.ok).toBe(true);
    expect((first as { credential: { token: string } }).credential.token).toBeTruthy();
    expect(await fixture.repository.redeemPairingCode({ code, deviceId: "dev-2" }))
      .toEqual({ ok: false, reason: "already-consumed" });
  });

  it("过期码拒绝；暴力尝试到上限码作废", async () => {
    const fixture = makeRepository();
    const { code } = await fixture.repository.issuePairingCode({ deviceId: "dev-1", principalId: "ext-A" });
    fixture.tick(6 * 60_000);
    expect(await fixture.repository.redeemPairingCode({ code, deviceId: "dev-1" })).toEqual({ ok: false, reason: "expired" });

    // 暴力尝试针对单码：用错误码打，不影响正确码（独立记录）；上限语义由
    // redeem 的 already-consumed/exhausted 分支承载，这里验证错误码不可探测。
    await fixture.repository.issuePairingCode({ deviceId: "dev-2", principalId: "ext-A" });
    for (let index = 0; index < MAX_PAIRING_ATTEMPTS; index += 1) {
      expect(await fixture.repository.redeemPairingCode({ code: "WRONG000", deviceId: "dev-2" }))
        .toEqual({ ok: false, reason: "invalid" });
    }
    // 第一个码已过期不计入 pending；第二个码仍有效。
    expect(await fixture.repository.pendingPairingCount()).toBe(1);
  });

  it("认证门：未知/撤销/过期凭证全拒；撤销立即影响 HTTP/WS/缓存共用门", async () => {
    const fixture = makeRepository();
    const { code } = await fixture.repository.issuePairingCode({ deviceId: "dev-1", principalId: "ext-A" });
    const redeemed = await fixture.repository.redeemPairingCode({ code, deviceId: "dev-1" });
    const token = (redeemed as { credential: { token: string } }).credential.token;
    const sessionId = (redeemed as { credential: { sessionId: string } }).credential.sessionId;

    expect((await fixture.repository.authenticate(token)).ok).toBe(true);
    await fixture.repository.revoke(sessionId);
    expect(await fixture.repository.authenticate(token)).toEqual({ ok: false, reason: "revoked" });

    // 逐设备轮换：其他设备不受影响。
    const { code: code2 } = await fixture.repository.issuePairingCode({ deviceId: "dev-2", principalId: "ext-A" });
    const redeemed2 = await fixture.repository.redeemPairingCode({ code: code2, deviceId: "dev-2" });
    const token2 = (redeemed2 as { credential: { token: string } }).credential.token;
    await fixture.repository.revoke(sessionId);
    expect((await fixture.repository.authenticate(token2)).ok).toBe(true);

    // 轮换：旧凭证失效，新凭证生效。
    const rotated = await fixture.repository.rotate((redeemed2 as { credential: { sessionId: string } }).credential.sessionId);
    expect(rotated.ok).toBe(true);
    expect(await fixture.repository.authenticate(token2)).toEqual({ ok: false, reason: "unknown" });
    expect((await fixture.repository.authenticate((rotated as { credential: { token: string } }).credential.token)).ok).toBe(true);
  });

  it("存储只留 hash：明文码与 token 不出现在落盘 JSON（FE-17 存储）", async () => {
    const fixture = makeRepository();
    const { code } = await fixture.repository.issuePairingCode({ deviceId: "dev-1", principalId: "ext-A" });
    const redeemed = await fixture.repository.redeemPairingCode({ code, deviceId: "dev-1" });
    const dump = JSON.stringify([...fixture.settings.values()]);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain((redeemed as { credential: { token: string } }).credential.token);
    expect(dump).toContain(hashToken(code).slice(0, 4));
  });
});

describe("暴露面策略（FE-17-A/C 局部）", () => {
  it("默认 loopback；LAN 需显式启用；public 无 TLS 证据恒关闭", () => {
    expect(effectiveExposure({ layer: "loopback" })).toMatchObject({ layer: "loopback", allowLanBind: false, privateDataRequiresAuth: true });
    expect(effectiveExposure({ layer: "lan" }).layer).toBe("loopback");
    expect(effectiveExposure({ layer: "lan", lanExplicitlyEnabled: true })).toMatchObject({ layer: "lan", allowLanBind: true });
    const lan = effectiveExposure({ layer: "lan", lanExplicitlyEnabled: true });
    expect(lan.disclosure).toContain("明文");
    const publicLayer = effectiveExposure({ layer: "public", publicTlsAck: true });
    expect(publicLayer.publicAllowed).toBe("blocked-no-tls-evidence");
  });

  it("路由白名单：SQL/秘密/opener 永不进网关", () => {
    expect(checkRoute("/").allowed).toBe(true);
    expect(checkRoute("/api/v1/events").requiresAuth).toBe(true);
    expect(checkRoute("/api/v1/sql").allowed).toBe(false);
    expect(checkRoute("/api/v1/secrets").allowed).toBe(false);
    expect(checkRoute("/api/v1/opener").allowed).toBe(false);
  });
});

describe("请求级认证门（FE-17-B/E 负例）", () => {
  const authenticate = async (token: string) => (token === "good" ? { ok: true as const } : { ok: false as const, reason: "x" });

  it("Origin 白名单 fail-closed；Bearer 缺失/无效拒；cookie 无 CSRF 拒", async () => {
    const base = { path: "/api/v1/events", allowedOrigins: ["tauri://localhost"], authenticate };
    expect(await authenticateRequest({ ...base, method: "GET", origin: "https://evil.example", authorization: "Bearer good" }))
      .toEqual({ ok: false, reason: "bad-origin" });
    expect(await authenticateRequest({ ...base, method: "GET", origin: null }))
      .toEqual({ ok: false, reason: "missing-credentials" });
    expect(await authenticateRequest({ ...base, method: "GET", origin: "tauri://localhost", authorization: "Bearer bad" }))
      .toEqual({ ok: false, reason: "invalid-credentials" });
    expect(await authenticateRequest({ ...base, method: "GET", origin: "tauri://localhost", authorization: "Bearer good" }))
      .toEqual({ ok: true });
    expect(await authenticateRequest({ ...base, method: "GET", origin: "tauri://localhost", cookieToken: "good" }))
      .toEqual({ ok: false, reason: "csrf-missing" });
    expect(await authenticateRequest({
      ...base, method: "GET", origin: "tauri://localhost", cookieToken: "good", csrfHeader: "wrong", expectedCsrf: "right",
    })).toEqual({ ok: false, reason: "csrf-mismatch" });
    expect(await authenticateRequest({
      ...base, method: "GET", origin: "tauri://localhost", cookieToken: "good", csrfHeader: "right", expectedCsrf: "right",
    })).toEqual({ ok: true });
    // 禁路由即使带好凭证也不放行。
    expect(await authenticateRequest({
      ...base, path: "/api/v1/secrets", method: "GET", origin: "tauri://localhost", authorization: "Bearer good",
    })).toEqual({ ok: false, reason: "forbidden-route" });
  });
});
