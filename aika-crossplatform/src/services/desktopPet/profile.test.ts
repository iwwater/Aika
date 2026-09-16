import { describe, expect, it } from "vitest";
import { deriveCapabilities } from "./profile";
import { fakePetProfile } from "./fakeDesktopPet";

/**
 * MVP-09-B 定向测试：能力必须绑定**实际版本**与**实际角色**。
 *
 * 这里补的是 fork 之后的缺口：上游 OpenPet 从不报版本（PET-01 已实证），所以旧逻辑
 * 的版本判定形同虚设；PetShell 会在 `product.version` 里如实回报自己的版本，能力
 * 判定必须把它算进去，否则「改了实现却沿用旧 profile」会被当成兼容放过去。
 */

const RELEASE = "0.6.0";
const profile = fakePetProfile({ petId: "nia", release: RELEASE });

describe("MVP-09-B 能力与版本/角色的绑定", () => {
  it("运行时没有版本（旧上游）时不做版本判定", () => {
    const capabilities = deriveCapabilities({
      profile,
      connection: "ready",
      provider: "openpet",
    });
    expect(capabilities.say).toBe("native");
    expect(capabilities.action).toBe("mapped");
  });

  it("上游 version 与 profile 一致时正常派生", () => {
    const capabilities = deriveCapabilities({
      profile,
      connection: "ready",
      provider: "openpet",
      runtimeVersion: RELEASE,
      petId: "nia",
    });
    expect(capabilities.action).toBe("mapped");
    expect(capabilities.emotion).toBe("mapped");
  });

  it("只有 product.version 时同样参与判定：版本不符即全 unknown", () => {
    const mismatched = deriveCapabilities({
      profile,
      connection: "ready",
      provider: "openpet",
      product: { name: "PetShell", version: "9.9.9" },
      petId: "nia",
    });
    // 连 say 都退回 unknown：响应 schema 未实证，不能保证对面还认这个请求体。
    expect(mismatched.say).toBe("unknown");
    expect(mismatched.action).toBe("unknown");

    const matched = deriveCapabilities({
      profile,
      connection: "ready",
      provider: "openpet",
      product: { name: "PetShell", version: RELEASE },
      petId: "nia",
    });
    expect(matched.say).toBe("native");
    expect(matched.action).toBe("mapped");
  });

  it("product.version 与上游 version 同时存在时，上游字段优先", () => {
    const capabilities = deriveCapabilities({
      profile,
      connection: "ready",
      provider: "openpet",
      runtimeVersion: RELEASE,
      product: { name: "PetShell", version: "9.9.9" },
      petId: "nia",
    });
    expect(capabilities.action).toBe("mapped");
  });

  it("角色不匹配时动作与情绪失效，但 say/event 仍然可用", () => {
    const capabilities = deriveCapabilities({
      profile,
      connection: "ready",
      provider: "openpet",
      product: { name: "PetShell", version: RELEASE },
      petId: "someone-else",
    });
    expect(capabilities.say).toBe("native");
    expect(capabilities.action).toBe("unknown");
    expect(capabilities.emotion).toBe("unknown");
  });

  it("未就绪时不给任何能力，也不返回缓存值", () => {
    for (const connection of ["disabled", "connecting", "offline", "incompatible"] as const) {
      const capabilities = deriveCapabilities({
        profile,
        connection,
        provider: "openpet",
        product: { name: "PetShell", version: RELEASE },
      });
      expect(capabilities.say, connection).toBe("unknown");
      expect(capabilities.action, connection).toBe("unknown");
    }
  });
});
