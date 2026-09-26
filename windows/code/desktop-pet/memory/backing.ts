import type { CharacterId } from '../contracts/index.js';
import type { MemoryRecord, RecordKind, SourceVersion } from './ledger.js';

export interface RecordCollection {
  get(id: string): MemoryRecord | undefined;
  has(id: string): boolean;
  set(id: string, record: MemoryRecord): unknown;
  select(kind?: RecordKind, state?: MemoryRecord['state']): readonly MemoryRecord[];
  lineage(): readonly { id: string; sources: readonly SourceVersion[] }[];
}
export interface LedgerBacking {
  readonly characterId: CharacterId;
  readonly records: RecordCollection;
  revision: number;
  epoch: number;
  readonly operations: { has(id: string): boolean; add(id: string): unknown };
}
class InMemoryRecords extends Map<string, MemoryRecord> implements RecordCollection {
  select(kind?: RecordKind, state?: MemoryRecord['state']): readonly MemoryRecord[] {
    return [...this.values()].filter(record => (!kind || record.kind === kind) && (!state || record.state === state));
  }
  lineage(): readonly { id: string; sources: readonly SourceVersion[] }[] {
    return [...this.values()].map(({ id, sources }) => ({ id, sources }));
  }
}
export function memoryBacking(characterId: CharacterId): LedgerBacking {
  return { characterId, records: new InMemoryRecords(), revision: 0, epoch: 0, operations: new Set<string>() };
}
