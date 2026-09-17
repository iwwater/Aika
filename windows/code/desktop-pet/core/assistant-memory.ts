import type { MemoryPort } from '../contracts/index.js';
import type { AssistantMemoryPort } from '../contracts/memory-lifecycle.js';

/** Reject incomplete lifecycle integration before accepting a user turn or paying for a model call. */
export function requireAssistantMemoryPort<T extends MemoryPort>(memory: T): T & AssistantMemoryPort {
  if (!('appendAssistant' in memory) || typeof memory.appendAssistant !== 'function') {
    throw new Error('assistant_memory_provenance_not_implemented');
  }
  return memory as T & AssistantMemoryPort;
}
