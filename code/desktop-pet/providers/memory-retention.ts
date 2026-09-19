import type { MemoryChange } from '../contracts/index.js';
import type { SourceRetention, SourceVersion } from '../contracts/memory-lifecycle.js';
import { exactFields, nonempty } from './memory-json.js';
import { type CheckedSource, fragmentAlias, MemoryWire } from './memory-wire.js';
import { object } from './transport.js';

function quotedRange(quoteValue: unknown, range: unknown, text: string): { start: unknown; end: unknown } {
  const quote = nonempty(quoteValue), source = Array.from(text), fragment = Array.from(quote);
  if (range !== null) {
    const explicit = object(range); exactFields(explicit, ['start', 'end']);
    const { start, end } = explicit;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(start) >= Number(end) || Number(end) > source.length) throw new Error('Invalid Unicode code point range');
    if (source.slice(Number(start), Number(end)).join('') !== quote) throw new Error('Quote differs from explicit range');
    return { start, end };
  }
  let match: number | undefined;
  for (let start = 0; start <= source.length - fragment.length; start++) {
    if (!fragment.every((point, index) => source[start + index] === point)) continue;
    if (match !== undefined) throw new Error('Quote has multiple exact matches; explicit range required');
    match = start;
  }
  if (match === undefined) throw new Error('Quote has no exact match');
  return { start: match, end: match + fragment.length };
}

export function parseRetentions(raw: unknown, wire: MemoryWire, suppressSources: readonly SourceVersion[]): SourceRetention[] {
  if (!Array.isArray(raw)) throw new Error('Retention array required');
  const aliases = new Set<string>(), suppressed = new Set(suppressSources.map(ref => ref.id));
  const spans = new Map<string, { start: number; end: number }[]>();
  const rows = raw.map(value => {
    const item = object(value); exactFields(item, wire.mode === 'quoted-v2' ? ['source', 'fragmentId', 'quote', 'range', 'supportSourceIds'] : ['source', 'fragmentId', 'start', 'end', 'supportSourceIds']);
    const fragmentId = nonempty(item.fragmentId), source = wire.reference(item.source), parent = wire.known.get(source.id)!;
    if (!fragmentAlias(fragmentId) || aliases.has(fragmentId) || wire.known.has(fragmentId) || (wire.mode === 'quoted-v2' && wire.collidesWithIdentity(fragmentId))) throw new Error('Invalid or colliding fragment alias');
    aliases.add(fragmentId);
    if (parent.kind === 'memory' || !parent.evidenceEligible || !suppressed.has(source.id)) throw new Error('Fragment must retain an explicitly suppressed readable transcript or summary');
    const { start, end } = wire.mode === 'quoted-v2' ? quotedRange(item.quote, item.range, parent.text) : item;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(start) >= Number(end) || Number(end) > Array.from(parent.text).length) throw new Error('Invalid Unicode code point range');
    const span = { start: Number(start), end: Number(end) }, prior = spans.get(source.id) ?? [];
    if (prior.some(other => span.start < other.end && span.end > other.start)) throw new Error('Overlapping source fragments');
    prior.push(span); spans.set(source.id, prior);
    // Preserve whitespace and code points exactly. Whitespace-only fragments cannot supply facts.
    nonempty(Array.from(parent.text).slice(span.start, span.end).join(''));
    return { source, fragmentId, ...span, rawSupport: item.supportSourceIds };
  });
  return rows.map(({ rawSupport, ...item }) => ({ ...item, supportSourceIds: wire.evidenceIds(rawSupport, aliases) }));
}

export function operationSources(change: MemoryChange): readonly string[] {
  const op = change.operation;
  return op.type === 'add' || op.type === 'update' ? op.sourceIds : op.type === 'merge' ? op.replacement.sourceIds : [];
}

/** Validates visible plan dependencies only. Storage owns invisible ancestry, epoch and atomic effects. */
export function checkRetentions(retained: readonly SourceRetention[], changes: readonly MemoryChange[], known: ReadonlyMap<string, CheckedSource>, suppress: ReadonlySet<string>): void {
  const fragments = new Map(retained.map(item => [item.fragmentId, item])), changed = new Set<string>();
  for (const { operation: op } of changes) {
    for (const id of op.type === 'add' ? [] : op.type === 'merge' ? op.targets.map(target => target.id) : [op.id]) changed.add(id);
  }
  const affected = new Set([...suppress, ...changed]);
  // A still-present descendant cannot be an unchanged support when a dependency changes.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const source of known.values()) if (!affected.has(source.id) && source.sourceVersions.some(ref => affected.has(ref.id))) {
      affected.add(source.id); expanded = true;
    }
  }
  for (const item of retained) {
    const parent = known.get(item.source.id)!;
    if (parent.messageRole === 'user' || parent.origin === 'manual') {
      if (item.supportSourceIds.length) throw new Error('User fragments are independent roots');
    } else if (!item.supportSourceIds.length) {
      // The wire has no hidden ancestor status. W3 must prove every ancestor was naturally expired raw.
      if (parent.kind !== 'summary' || !parent.sourceVersions.length || parent.sourceVersions.some(ref => known.has(ref.id))) throw new Error('Derived fragment needs surviving evidence');
    }
    for (const id of item.supportSourceIds) {
      if (!fragments.has(id) && (!known.has(id) || affected.has(id) || !known.get(id)!.evidenceEligible)) throw new Error('Fragment support will change or is unavailable');
    }
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Cyclic fragment support');
    if (done.has(id)) return;
    visiting.add(id);
    for (const support of fragments.get(id)!.supportSourceIds) if (fragments.has(support)) visit(support);
    visiting.delete(id); done.add(id);
  };
  for (const id of fragments.keys()) visit(id);
  for (const change of changes) for (const id of operationSources(change)) {
    const source = known.get(id);
    // Merge may cite its target records; existing operation semantics flatten their evidence in storage.
    if (source && (suppress.has(id) || source.sourceVersions.some(ref => suppress.has(ref.id)))) throw new Error('Memory plan reuses suppressed source');
  }
}
