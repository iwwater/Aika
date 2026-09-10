import { runContextSourceConformance } from "./contextSource.conformance";
import { createContextAssembler, type ContextSource } from "./contextAssembler";
import { createMemorySource } from "../memory/memorySource";
import { createMemoryRepository } from "../memory/memoryRepository";
import { emptySnapshot } from "../memory/memoryStore";
import { createMemoryV2 } from "../../domain/memory";
import { DEFAULT_CHARACTER_SOUL, DEFAULT_MODE_CONFIG } from "../../domain/soul";
import { computeRelationship, deriveRelationshipSignals } from "../../domain/relationship";

for (const name of ["memorySource (真实 repository)", "deterministic stub"]) {
  runContextSourceConformance({ name, create(scenario) {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const fault = async () => {
      if (scenario === "error") throw new Error("fixture failure");
      if (scenario === "timeout") await wait;
    };
    const record = createMemoryV2({ id: "coffee", content: "喜欢咖啡", type: "preference", status: "confirmed", sourceMessageIds: ["user-1"], now: 1000 })!;
    const subject: ContextSource = name.startsWith("memorySource")
      ? createMemorySource(createMemoryRepository({ store: {
        load: async () => { await fault(); return { ...emptySnapshot(), records: [record] }; },
        save: async () => undefined,
      } }))
      : { id: "stub", section: "memory", load: async () => {
        await fault(); return [{ content: "喜欢咖啡", source: "memory", precision: "confirmed" }];
      } };
    const handlers = new Set<() => void>();
    const assembler = createContextAssembler({ sources: [subject], timers: {
      setTimeout: (fn) => { handlers.add(fn); return fn; }, clearTimeout: (fn) => { handlers.delete(fn as () => void); },
    } });
    const input = { query: "咖啡", now: 1000, signal: new AbortController().signal };
    return { subject, input,
      assemble: () => assembler.assemble({ ...input, timeZone: "UTC", characterSoul: DEFAULT_CHARACTER_SOUL,
        relationship: computeRelationship(deriveRelationshipSignals([], 1000)), mode: DEFAULT_MODE_CONFIG, history: [], summary: null }),
      fireTimeout: () => { for (const fn of [...handlers]) fn(); }, resolveLate: release,
    };
  } });
}
