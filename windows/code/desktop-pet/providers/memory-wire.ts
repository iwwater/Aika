import { isCharacterId } from '../contracts/character.js';
import type { TurnScope } from '../contracts/index.js';
import type { MemorySource, MemoryTurnInput, SourceVersion } from '../contracts/memory-lifecycle.js';
import { assertScope } from '../media/scope.js';
import { assertRoleInput, exactFields, nonempty, strings } from './memory-json.js';
import { object } from './transport.js';

export type CheckedSource = MemorySource & { sourceVersions: readonly SourceVersion[]; evidenceEligible: boolean };
const positiveVersion = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
export const fragmentAlias = (id: string): boolean => /^f(?:0|[1-9]\d*)$/.test(id);
export type MemoryWireMode = 'numeric-v1' | 'quoted-v2';
export function assertMemoryWireMode(mode: unknown): asserts mode is MemoryWireMode {
  if (mode !== 'numeric-v1' && mode !== 'quoted-v2') throw new Error('Unknown memory wire mode');
}

export function checkedSources(scope: TurnScope, sources: readonly MemorySource[]): Map<string, CheckedSource> {
  nonempty(scope.sessionId); nonempty(scope.turnId);
  if (!isCharacterId(scope.characterId) || !Number.isSafeInteger(scope.generation) || scope.generation < 0) throw new Error('Invalid memory source scope');
  if (!Array.isArray(sources) || !sources.length) throw new Error('Memory sources required');
  const known = new Map<string, CheckedSource>();
  for (const source of sources) {
    assertScope(scope, source.scope); nonempty(source.id); nonempty(source.text);
    if (known.has(source.id) || !positiveVersion(source.version) || !Number.isFinite(Date.parse(source.createdAt))) throw new Error('Invalid or duplicate memory source');
    if (!['transcript', 'memory', 'summary'].includes(source.kind) || (source.kind === 'transcript' ? !['user', 'assistant'].includes(source.messageRole ?? '') : source.messageRole !== null)) throw new Error('Invalid memory source kind or role');
    const lineage = source.sourceVersions === undefined ? [] : source.sourceVersions, seen = new Set<string>();
    if (!Array.isArray(lineage)) throw new Error('Invalid source lineage');
    for (const ref of lineage) {
      exactFields(object(ref), ['id', 'version']); nonempty(ref.id);
      if (!positiveVersion(ref.version) || seen.has(ref.id)) throw new Error('Invalid source lineage version');
      seen.add(ref.id);
    }
    // Old unbound assistant records are display-only, never silently promoted to evidence.
    const eligible = source.evidenceEligible === undefined ? source.messageRole !== 'assistant' : source.evidenceEligible;
    if (source.origin !== undefined && !['conversation', 'automatic', 'manual'].includes(source.origin)) throw new Error('Invalid source origin');
    if (source.origin === 'manual' && lineage.length) throw new Error('Manual source cannot claim old utterance lineage');
    if (typeof eligible !== 'boolean' || (!eligible && source.messageRole !== 'assistant') || (eligible && source.messageRole === 'assistant' && !lineage.length && source.origin !== 'manual')) throw new Error('Invalid evidence eligibility');
    known.set(source.id, { ...source, sourceVersions: lineage, evidenceEligible: eligible });
  }
  return known;
}

export function checkedTurn(input: MemoryTurnInput): Map<string, CheckedSource> {
  assertRoleInput(input);
  const known = checkedSources(input.scope, input.sources), seen = new Set<string>();
  for (const message of input.messages) {
    const source = known.get(message.id);
    if (seen.has(message.id) || source?.kind !== 'transcript' || source.text !== message.text || source.messageRole !== message.role || source.createdAt !== message.createdAt || source.origin !== message.origin) throw new Error('Message differs from versioned source');
    seen.add(message.id);
  }
  for (const memory of input.relevantMemories) {
    const source = known.get(memory.id);
    if (seen.has(memory.id) || source?.kind !== 'memory' || source.text !== memory.text || source.version !== memory.version || source.origin !== memory.origin) throw new Error('Memory differs from versioned source');
    seen.add(memory.id);
  }
  if (input.sources.some(source => source.kind !== 'summary' && !seen.has(source.id))) throw new Error('Versioned source missing from model context');
  const current = known.get(input.currentMessageId);
  if (current?.kind !== 'transcript' || current.messageRole !== 'user' || !seen.has(current.id)) throw new Error('Current user message missing');
  return known;
}

/** Request-local identity map. Metadata aliases never grant access to an unavailable ancestor. */
export class MemoryWire {
  readonly #toWire = new Map<string, string>();
  readonly #toSource = new Map<string, CheckedSource>();
  constructor(readonly known: ReadonlyMap<string, CheckedSource>, readonly mode: MemoryWireMode = 'numeric-v1') {
    assertMemoryWireMode(mode);
    const actualIds = new Set([...known.keys(), ...[...known.values()].flatMap(source => source.sourceVersions.map(ref => ref.id))]);
    let sequence = 0, memorySequence = 0;
    for (const source of known.values()) {
      let alias: string;
      do { alias = mode === 'quoted-v2' && source.kind === 'memory' ? `m${memorySequence++}` : `s${sequence++}`; } while (actualIds.has(alias));
      this.#toWire.set(source.id, alias); this.#toSource.set(alias, source);
    }
    for (const source of known.values()) for (const ref of source.sourceVersions) {
      if (!this.#toWire.has(ref.id)) {
        let alias: string;
        do { alias = `u${sequence++}`; } while (actualIds.has(alias));
        this.#toWire.set(ref.id, alias);
      }
    }
  }
  collidesWithIdentity(id: string): boolean { return this.#toWire.has(id) || this.#toSource.has(id); }
  data(currentMessageId?: string): object {
    const rows = [...this.known.values()].map(source => ({
      id: this.#toWire.get(source.id)!, version: source.version, kind: source.kind, messageRole: source.messageRole,
      text: source.text, createdAt: source.createdAt, evidenceEligible: source.evidenceEligible,
      ...(source.origin ? { origin: source.origin } : {}),
      sourceVersions: source.sourceVersions.map(ref => ({ id: this.#toWire.get(ref.id)!, version: ref.version })),
    }));
    if (currentMessageId === undefined) return { sources: rows };
    const currentAlias = this.#toWire.get(currentMessageId);
    return { evidence: rows.filter(row => row.id !== currentAlias), currentMessage: rows.find(row => row.id === currentAlias)! };
  }
  source(value: unknown, kind?: MemorySource['kind']): CheckedSource {
    const alias = nonempty(value), source = this.#toSource.get(alias);
    if (!source || (kind && source.kind !== kind)) throw new Error('Unknown wire source or wrong source kind');
    return source;
  }
  reference(value: unknown): SourceVersion {
    const ref = object(value); exactFields(ref, ['id', 'version']);
    const source = this.source(ref.id);
    if (ref.version !== source.version) throw new Error('Unknown, duplicate or stale source version');
    return { id: source.id, version: source.version };
  }
  versions(value: unknown): SourceVersion[] {
    if (!Array.isArray(value)) throw new Error('Source version array required');
    const seen = new Set<string>();
    return value.map(raw => { const ref = this.reference(raw); if (seen.has(ref.id)) throw new Error('Unknown, duplicate or stale source version'); seen.add(ref.id); return ref; });
  }
  evidenceIds(value: unknown, fragments: ReadonlySet<string>): string[] {
    const ids = strings(value), seen = new Set<string>();
    return ids.map(id => {
      if (seen.has(id)) throw new Error('Repeated source reference'); seen.add(id);
      if (fragments.has(id)) return id;
      const source = this.source(id);
      if (!source.evidenceEligible) throw new Error('Display-only source is not evidence');
      return source.id;
    });
  }
  changes(value: unknown, fragments: ReadonlySet<string>): unknown[] {
    if (!Array.isArray(value)) throw new Error('Missing memory change array');
    const target = (raw: unknown) => { const item = object(raw); return { ...item, id: this.source(item.id, 'memory').id }; };
    const fresh = (raw: unknown) => {
      const item = object(raw), id = nonempty(item.id);
      const reserved = this.mode === 'quoted-v2' ? /^[sumf]\d+$/ : /^[suf]\d+$/;
      if (this.collidesWithIdentity(id) || reserved.test(id) || fragments.has(id)) throw new Error('New memory alias collides with source namespace');
      return { ...item, sourceIds: this.evidenceIds(item.sourceIds, fragments) };
    };
    return value.map(raw => {
      const change = object(raw), operation = object(change.operation);
      switch (operation.type) {
        case 'add': return { ...change, operation: fresh(operation) };
        case 'update': return { ...change, operation: { ...target(operation), sourceIds: this.evidenceIds(operation.sourceIds, fragments) } };
        case 'merge':
          if (!Array.isArray(operation.targets)) throw new Error('Merge targets required');
          return { ...change, operation: { ...operation, targets: operation.targets.map(target), replacement: fresh(operation.replacement) } };
        case 'soft_delete': case 'restore': return { ...change, operation: target(operation) };
        default: throw new Error('Unsupported memory operation');
      }
    });
  }
}
