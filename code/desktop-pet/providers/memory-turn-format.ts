import type { MemoryTurnInput } from '../contracts/memory-lifecycle.js';
import { MEMORY_TURN_PROMPT } from './memory-lifecycle-prompt.js';
import { MEMORY_QUOTED_PROMPT } from './memory-quoted-prompt.js';
import { assertMemoryWireMode, checkedTurn, MemoryWire, type MemoryWireMode } from './memory-wire.js';
import { MEMORY_DYNAMICS_PROMPT } from './memory-dynamics-plan.js';

/** Pure shared construction for the provider and integration's mode-matched input counter. */
export function buildMemoryTurnFormat(original: MemoryTurnInput, mode: MemoryWireMode = 'numeric-v1', dynamics=false) {
  assertMemoryWireMode(mode);
  const input = structuredClone(original), known = checkedTurn(input), wire = new MemoryWire(known, mode);
  const data = wire.data(input.currentMessageId), system = (mode === 'numeric-v1' ? MEMORY_TURN_PROMPT : MEMORY_QUOTED_PROMPT) + (dynamics?MEMORY_DYNAMICS_PROMPT:'');
  return { mode, input, known, wire, data, system };
}
