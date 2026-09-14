import { token } from "../../kernel";
import { createOptionalCapability } from "../../kernel/optionalCapability";
import type { DesktopPetService } from "./contracts";

export const OPENPET_PRESENTATION_MANIFEST = {
  id: "host.desktopPet", version: "1.1.0", isolation: "external-process",
  capabilities: ["say", "action", "emotion:mapped", "event"],
} as const;

export function createPresentationLifecycle(service: DesktopPetService) {
  return createOptionalCapability({
    timeoutMs: 20_000,
    async start(signal) {
      const cancel = () => { void service.disable(); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await service.enable();
        return async () => {
          signal.removeEventListener("abort", cancel);
          await service.disable();
        };
      } catch (error) {
        signal.removeEventListener("abort", cancel);
        await service.disable();
        throw error;
      }
    },
    check: async () => service.snapshot().connection === "ready",
  });
}
export const PresentationLifecycleToken = token<ReturnType<typeof createPresentationLifecycle>>("desktopPet.lifecycle");
