import { describe, expect, it, vi } from "vitest";
import type { DesktopPetService } from "./contracts";
import { createPresentationLifecycle, OPENPET_PRESENTATION_MANIFEST } from "./lifecycle";

describe("presentation lifecycle", () => {
  it("stops only the presentation service and preserves the external process boundary", async () => {
    const enable = vi.fn(async () => undefined);
    const disable = vi.fn(async () => undefined);
    const lifecycle = createPresentationLifecycle({ enable, disable, snapshot: () => ({ connection: "ready" }) } as unknown as DesktopPetService);
    expect(OPENPET_PRESENTATION_MANIFEST.isolation).toBe("external-process");
    await lifecycle.start();
    expect((await lifecycle.health()).state).toBe("running");
    await lifecycle.stop();
    expect(disable).toHaveBeenCalled();
    await lifecycle.start();
    expect(enable).toHaveBeenCalledTimes(2);
    await lifecycle.stop();
  });
  it("startup rejection is contained and disables partial state", async () => {
    const disable = vi.fn(async () => undefined);
    const lifecycle = createPresentationLifecycle({ enable: async () => { throw Error(); }, disable } as unknown as DesktopPetService);
    expect(await lifecycle.start()).toMatchObject({ state: "failed", code: "start_failed" });
    expect(disable).toHaveBeenCalledTimes(1);
  });
});
