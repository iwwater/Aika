import { describe, expect, it } from "vitest";
import type { AccountKeyV1 } from "../../domain/identity";
import type { AikaStorage } from "../../services/storage/contracts";
import { SETTING_KEYS } from "../../services/storage/contracts";
import { createBindingService, MAX_CLAIM_ATTEMPTS_PER_CODE } from "./binding";

const BASE = Date.UTC(2026, 0, 10, 12, 0);

function account(overrides: Partial<AccountKeyV1> = {}): AccountKeyV1 {
  return {
    version: 1,
    platform: "telegram",
    botAccount: "aika_bot",
    tenant: "-10086",
    sender: "10086",
    ...overrides,
  };
}

interface Fixture {
  service: ReturnType<typeof createBindingService>;
  settings: Map<string, string>;
  now: number;
  tick(ms: number): void;
  seq: { n: number };
  failReads: { on: boolean };
}

function makeFixture(): Fixture {
  const settings = new Map<string, string>();
  let now = BASE;
  let seqN = 0;
  const failReads = { on: false };
  const storage = {
    async getSetting(key: string) {
      if (failReads.on) throw new Error("db gone");
      return settings.get(key) ?? null;
    },
    async setSetting(key: string, value: string) {
      if (failReads.on) throw new Error("db gone");
      settings.set(key, value);
    },
  } as unknown as AikaStorage;
  const service = createBindingService({
    loadStorage: async () => storage,
    clock: () => now,
    idFactory: () => `id-${(seqN += 1).toString().padStart(4, "0")}-0000`,
  });
  return { service, settings, now, tick: (ms: number) => { now += ms; }, seq: { n: seqN }, failReads };
}

describe("绑定服务（RT-02-A/D）", () => {
  it("本地签发码 → 外部认领成功且一次性：同码再用是 invalid-code", async () => {
    const fixture = makeFixture();
    const { code } = await fixture.service.issueBindingCode();

    const first = await fixture.service.claim(code, account());
    expect(first).toEqual({ ok: true, principalId: expect.any(String) });

    // 一次性：同一个码第二次认领必须被拒。
    const second = await fixture.service.claim(code, account({ sender: "20002" }));
    expect(second).toEqual({ ok: false, reason: "invalid-code" });
  });

  it("过期码被拒绝", async () => {
    const fixture = makeFixture();
    const { code } = await fixture.service.issueBindingCode();
    fixture.tick(6 * 60_000);
    expect(await fixture.service.claim(code, account())).toEqual({ ok: false, reason: "expired" });
  });

  it("暴力尝试：错误码不消耗真实码；同一码错到上限即作废", async () => {
    const fixture = makeFixture();
    const { code } = await fixture.service.issueBindingCode();

    // 全错的码怎么试都只是 invalid-code。
    for (let index = 0; index < MAX_CLAIM_ATTEMPTS_PER_CODE + 2; index += 1) {
      expect(await fixture.service.claim("WRONG000", account())).toEqual({ ok: false, reason: "invalid-code" });
    }

    // 真实码：用错的账户键反复打（缺字段 → invalid-account 也计数？不会——
    // invalid-account 是请求本身非法，不计入码的暴力计数；真正计的是已有绑定的顶替尝试）。
    const bound = await fixture.service.claim(code, account());
    expect(bound.ok).toBe(true);

    // 对新码重复认领同一账户：already-bound 逐次计数，到上限码作废。
    const second = await fixture.service.issueBindingCode();
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS_PER_CODE; attempt += 1) {
      expect(await fixture.service.claim(second.code, account())).toEqual({ ok: false, reason: "already-bound" });
    }
    // 上限之后码作废，连 already-bound 都不再返回。
    expect(await fixture.service.claim(second.code, account({ tenant: "-10087" })))
      .toEqual({ ok: false, reason: "invalid-code" });
  });

  it("重复绑定同一账户被拒，旧主体不被顶替", async () => {
    const fixture = makeFixture();
    const first = await fixture.service.issueBindingCode();
    const bound = await fixture.service.claim(first.code, account());
    expect(bound.ok).toBe(true);

    const second = await fixture.service.issueBindingCode();
    const again = await fixture.service.claim(second.code, account());
    expect(again).toEqual({ ok: false, reason: "already-bound" });
    // 旧绑定仍在。
    expect(await fixture.service.principalFor(account())).toBe((bound as { principalId: string }).principalId);
  });

  it("解除绑定立即失效：查不到 principal，也读不到任何个人数据授权", async () => {
    const fixture = makeFixture();
    const { code } = await fixture.service.issueBindingCode();
    await fixture.service.claim(code, account());
    expect(await fixture.service.principalFor(account())).toBeTruthy();

    await fixture.service.unbind(account());
    expect(await fixture.service.principalFor(account())).toBeNull();
  });

  it("外部声明 userId 无效：四元组缺字段拒绝绑定", async () => {
    const fixture = makeFixture();
    const { code } = await fixture.service.issueBindingCode();
    expect(await fixture.service.claim(code, account({ sender: "" }))).toEqual({ ok: false, reason: "invalid-account" });
    expect(await fixture.service.claim(code, account({ platform: " " }))).toEqual({ ok: false, reason: "invalid-account" });
    // 码仍有效（invalid-account 是请求非法，不消耗码）……但占用失败计数为 0。
    expect(await fixture.service.claim(code, account()).then((result) => result.ok)).toBe(true);
  });

  it("绑定存储损坏按「没有任何绑定」处理（fail-closed）", async () => {
    const fixture = makeFixture();
    fixture.settings.set(SETTING_KEYS.identityBindings, "{not json");
    expect(await fixture.service.principalFor(account())).toBeNull();
    expect(await fixture.service.list()).toEqual([]);
  });

  it("持久化：重启（新实例同库）后绑定仍然生效", async () => {
    const fixture = makeFixture();
    const { code } = await fixture.service.issueBindingCode();
    const claimed = await fixture.service.claim(code, account());
    expect(claimed.ok).toBe(true);

    // 同一份 settings 造新实例，等价于重启后重新打开。
    const storage = {
      async getSetting(key: string) { return fixture.settings.get(key) ?? null; },
      async setSetting(key: string, value: string) { fixture.settings.set(key, value); },
    } as unknown as AikaStorage;
    const reborn = createBindingService({ loadStorage: async () => storage });
    expect(await reborn.principalFor(account())).toBe((claimed as { principalId: string }).principalId);
  });
});
