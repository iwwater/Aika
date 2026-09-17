/** Private planning compiler. Origin identifies the host path; only external call evidence proves real model use. */
import { createHash } from 'node:crypto';
import type { MemoryChange, TurnScope } from '../contracts/index.js';
import type { MemorySource, MemoryTurnInput, MemoryTurnPlan, SourceRetention, SourceVersion } from '../contracts/memory-lifecycle.js';
import type { MemoryRecord } from '../memory/ledger.js';
import { sameScope } from '../memory/scope.js';

export interface PrototypeNode extends SourceVersion {
  readonly characterId: TurnScope['characterId'];
  readonly kind: MemoryRecord['kind'];
  readonly state: MemoryRecord['state'];
  readonly eligible: boolean;
  readonly parents: readonly SourceVersion[];
}
export interface PrototypeSnapshot { readonly input: MemoryTurnInput; readonly graph: readonly PrototypeNode[] }
export interface ExactQuote { readonly text: string; readonly start?: number }
export interface SemanticEvidence { readonly source: SourceVersion; readonly quote?: ExactQuote }
export interface SemanticRemainder { readonly quote: ExactQuote; readonly supports: readonly SemanticEvidence[] }
/** A claimed reason to discard this exact span. A valid quote does not prove the claim. */
export interface SemanticDiscard {
  readonly quote: ExactQuote;
  readonly target: SourceVersion;
  readonly basis: readonly SemanticEvidence[];
}
export interface SemanticAssessment {
  readonly source: SourceVersion;
  readonly classification: 'target_only' | 'mixed' | 'unrelated';
  readonly retain: readonly SemanticRemainder[];
  readonly discard: readonly SemanticDiscard[];
}
/** Equality here checks supplied semantic labels, never infers equivalence from keywords. */
export interface FactMeaning {
  readonly fact: string;
  readonly factEvidence: readonly SemanticEvidence[];
  /** Explicit empty sets remain a semantic claim, not proof that nothing was omitted. */
  readonly qualifiers: Readonly<Record<string, { readonly value: string; readonly evidence: readonly SemanticEvidence[] }>>;
}
export type SemanticFactEdit = { readonly basis: readonly SemanticEvidence[] } & (
  | { readonly intent: 'remember'; readonly statement: string; readonly evidence: readonly SemanticEvidence[] }
  | { readonly intent: 'revise'; readonly target: SourceVersion; readonly statement: string; readonly evidence: readonly SemanticEvidence[] }
  | { readonly intent: 'consolidate'; readonly members: readonly { readonly target: SourceVersion; readonly meaning: FactMeaning }[]; readonly meaning: FactMeaning; readonly statement: string; readonly evidence: readonly SemanticEvidence[] }
  | { readonly intent: 'retire'; readonly target: SourceVersion });
export interface SemanticDeclaration {
  readonly annotationSource: 'human_controlled' | 'model_evaluation';
  readonly scope: TurnScope;
  readonly request: MemoryTurnPlan['request'];
  /** Semantic roots only; the compiler discovers dependent records. */
  readonly erase: readonly SourceVersion[];
  readonly facts: readonly SemanticFactEdit[];
  readonly assessments: readonly SemanticAssessment[];
  readonly reason: string;
  /** Ambiguous intention is distinct from both ordinary no-op and missing source data. */
  readonly unresolved?: { readonly question: string; readonly basis: readonly SemanticEvidence[] };
}
export type PrototypeResult =
  | { readonly status: 'ready'; readonly plan: MemoryTurnPlan }
  | { readonly status: 'needs_semantics'; readonly sources: readonly SourceVersion[] }
  | { readonly status: 'needs_sources'; readonly sources: readonly SourceVersion[];
      /** Only usable with existing expandTurn. Never commit this incomplete read probe. */
      readonly readProbe: MemoryTurnPlan | null };
export class PrototypePlanError extends Error { override name = 'PrototypePlanError'; }
const fail = (reason: string): never => { throw new PrototypePlanError(reason); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref = (node: SourceVersion): SourceVersion => ({ id: node.id, version: node.version });
const readable = (node: PrototypeNode) => node.state === 'active' && node.eligible && ['memory', 'transcript', 'summary'].includes(node.kind);

/** Strip unread payloads. Graph metadata alone never authorizes their text for planning. */
export function prototypeSnapshot(input: MemoryTurnInput, records: readonly MemoryRecord[]): PrototypeSnapshot {
  return { input: structuredClone(input), graph: records.map(record => ({ ...ref(record), characterId: record.characterId,
    kind: record.kind, state: record.state, eligible: record.evidenceEligible !== false, parents: record.sources.map(ref) })) };
}
function locate(source: MemorySource, quote: ExactQuote): { start: number; end: number } {
  const text = [...source.text], needle = [...quote.text];
  if (!needle.length) return fail('empty_quote');
  const matches: number[] = [];
  for (let start = 0; start + needle.length <= text.length; start++) {
    if (text.slice(start, start + needle.length).join('') === quote.text) matches.push(start);
  }
  const start = quote.start ?? (matches.length === 1 ? matches[0] : undefined);
  if (start === undefined || !Number.isSafeInteger(start) || !matches.includes(start)) return fail('ambiguous_or_inexact_quote');
  return { start, end: start + needle.length };
}
function meaningKey(value: FactMeaning): string {
  if (!value.fact?.trim() || !value.qualifiers || Array.isArray(value.qualifiers) || typeof value.qualifiers !== 'object') return fail('invalid_fact_meaning');
  const entries = Object.entries(value.qualifiers);
  if (entries.some(([key, item]) => !key.trim() || typeof item?.value !== 'string' || !item.value.trim())) return fail('invalid_fact_meaning');
  return JSON.stringify([value.fact, entries.map(([key, item]) => [key, item.value]).sort(([a], [b]) => a!.localeCompare(b!))]);
}

/** No storage, provider, clock or permanent fragment ID allocation. Storage revalidates at commit. */
export function compileMemoryPrototype(snapshot: PrototypeSnapshot, declaration: SemanticDeclaration, signal: AbortSignal): PrototypeResult {
  signal.throwIfAborted();
  const { input } = snapshot, scope = input.scope;
  if (!['human_controlled', 'model_evaluation'].includes(declaration.annotationSource) || !sameScope(scope, declaration.scope)) return fail('annotation_scope_or_origin');
  if (!['none', 'forget', 'correction'].includes(declaration.request) || !declaration.reason.trim()) return fail('invalid_semantic_request');
  const graph = new Map(snapshot.graph.map(node => [node.id, node]));
  if (graph.size !== snapshot.graph.length || snapshot.graph.some(node => node.characterId !== scope.characterId)) return fail('graph_scope_or_duplicate');
  const allowed = new Map(input.sources.map(source => [source.id, source]));
  if (allowed.size !== input.sources.length) return fail('duplicate_input_source');
  const nodeFor = (target: SourceVersion): PrototypeNode => {
    const node = graph.get(target.id);
    if (!node || node.version !== target.version || !readable(node)) return fail('unavailable_or_stale_source');
    return node;
  };
  const sourceFor = (target: SourceVersion): MemorySource => {
    nodeFor(target); const source = allowed.get(target.id);
    if (!source || source.version !== target.version || !sameScope(scope, source.scope) || source.evidenceEligible === false) return fail('source_not_read');
    return source;
  };
  for (const source of input.sources) {
    const node = nodeFor(source);
    if (node.kind !== source.kind || !sameScope(scope, source.scope) || digest(node.parents) !== digest(source.sourceVersions ?? [])) return fail('input_graph_mismatch');
  }
  const current = sourceFor(ref(allowed.get(input.currentMessageId) ?? fail('missing_current')));
  if (current.messageRole !== 'user') return fail('current_not_user');
  const basis = (items: readonly SemanticEvidence[], context: string, requiredSubject?: SourceVersion) => {
    if (!Array.isArray(items) || !items.length) return fail(`${context}_without_evidence`);
    for (const item of items) {
      const source = sourceFor(item.source);
      if (!item.quote) return fail(`${context}_requires_quote`);
      locate(source, item.quote);
      if (requiredSubject && (source.id !== requiredSubject.id || source.version !== requiredSubject.version)) return fail('meaning_evidence_not_member');
    }
  };
  if (declaration.unresolved !== undefined) {
    if (!declaration.unresolved.question?.trim() || declaration.erase.length || declaration.facts.length || declaration.assessments.length) return fail('unresolved_with_mutations_or_empty_question');
    basis(declaration.unresolved.basis, 'unresolved_intent');
    return { status: 'ready', plan: { scope, request: declaration.request, changes: [], suppressSources: [], retainSources: [],
      clarification: declaration.unresolved.question, reason: declaration.reason } };
  }
  const meaning = (value: FactMeaning, subject?: SourceVersion) => {
    const key = meaningKey(value);
    basis(value.factEvidence, 'fact_meaning', subject);
    for (const qualifier of Object.values(value.qualifiers)) basis(qualifier.evidence, 'qualifier', subject);
    return key;
  };
  const targets = new Set<string>(), roots = new Set<string>();
  const memoryTarget = (target: SourceVersion) => {
    if (sourceFor(target).kind !== 'memory' || targets.has(target.id)) return fail('invalid_or_duplicate_memory_target');
    targets.add(target.id);
  };
  for (const target of declaration.erase) {
    if (sourceFor(target).kind === 'memory' || roots.has(target.id)) return fail('invalid_erase_root');
    roots.add(target.id);
  }
  for (const edit of declaration.facts) {
    if (edit.intent === 'consolidate') {
      if (edit.members.length < 2) return fail('insufficient_merge_members');
      const expected = meaning(edit.meaning);
      for (const member of edit.members) { memoryTarget(member.target); if (meaning(member.meaning, member.target) !== expected) return fail('distinct_qualified_facts'); }
    } else if (edit.intent === 'retire' || edit.intent === 'revise') memoryTarget(edit.target);
    else if (edit.intent !== 'remember') return fail('unknown_fact_intent');
    basis(edit.basis, 'action');
    if (edit.intent !== 'retire') {
      if (!edit.statement.trim() || !edit.evidence.length) return fail('fact_without_evidence');
      for (const evidence of edit.evidence) { sourceFor(evidence.source); if (evidence.quote) locate(sourceFor(evidence.source), evidence.quote); }
    }
    if (edit.intent === 'retire' || edit.intent === 'revise') {
      const newEvidence = new Set<string>();
      if (edit.intent === 'revise') for (const evidence of edit.evidence) {
        newEvidence.add(evidence.source.id); for (const parent of nodeFor(evidence.source).parents) newEvidence.add(parent.id);
      }
      for (const parent of nodeFor(edit.target).parents) {
        const node = graph.get(parent.id);
        if (node?.kind === 'transcript' && node.state === 'active' && !newEvidence.has(node.id)) roots.add(node.id);
      }
    }
  }
  if (declaration.request === 'forget') {
    if (!roots.size && !targets.size) return fail('forget_without_semantic_target');
    roots.add(current.id);
  }
  const descendants = (seeds: Iterable<string>) => {
    const found = new Set(seeds);
    for (let changed = true; changed;) {
      changed = false;
      for (const node of graph.values()) if (!found.has(node.id) && node.parents.some(parent => found.has(parent.id))) { found.add(node.id); changed = true; }
    }
    return found;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const id of descendants([...roots, ...targets])) if (graph.get(id)?.kind === 'summary') {
      for (const parent of graph.get(id)!.parents) {
        const node = graph.get(parent.id);
        if (node?.kind === 'transcript' && node.state === 'active' && !roots.has(node.id)) { roots.add(node.id); changed = true; }
      }
    }
  }
  const affected = descendants([...roots, ...targets]);
  for (const id of [...roots, ...targets]) for (const parent of graph.get(id)?.parents ?? []) {
    if (graph.get(parent.id)?.kind === 'transcript' && graph.get(parent.id)?.state === 'expired') {
      for (const sibling of descendants([parent.id])) if (graph.get(sibling)?.state === 'active') affected.add(sibling);
    }
  }
  const assessments = new Map<string, SemanticAssessment>();
  const declaredTargets = new Set([...declaration.erase.map(item => item.id), ...targets]);
  for (const assessment of declaration.assessments) {
    const source = sourceFor(assessment.source);
    if (source.kind === 'memory' || !affected.has(source.id) || assessments.has(source.id)) return fail('unexpected_source_assessment');
    assessments.set(source.id, assessment);
    const spans = assessment.retain.map(item => locate(source, item.quote)).sort((a, b) => a.start - b.start);
    if (spans.some((span, index) => index > 0 && span.start < spans[index - 1]!.end)) return fail('overlapping_remainders');
    const kept = spans.reduce((size, span) => size + span.end - span.start, 0), length = [...source.text].length;
    if (assessment.classification === 'unrelated') {
      if (kept !== length || !length) return fail('incomplete_unrelated_content');
    } else if (assessment.classification === 'mixed') {
      if (kept === 0 || kept >= length) return fail('invalid_mixed_content');
    } else if (assessment.classification !== 'target_only' || kept) return fail('invalid_target_only_content');
    if (!Array.isArray(assessment.discard)) return fail('missing_discard_evidence');
    const removed = assessment.discard.map(item => {
      sourceFor(item.target);
      if (!declaredTargets.has(item.target.id)) return fail('discard_target_not_declared');
      basis(item.basis, 'discard');
      return locate(source, item.quote);
    });
    const partition = [...spans, ...removed].sort((a, b) => a.start - b.start);
    if (!partition.length || partition[0]!.start !== 0 || partition.at(-1)!.end !== length ||
        partition.some((span, index) => index > 0 && span.start !== partition[index - 1]!.end)) return fail('incomplete_or_overlapping_source_partition');
    for (const remainder of assessment.retain) {
      if ((source.messageRole === 'user' || source.origin === 'manual') && remainder.supports.length) return fail('user_remainder_not_root');
      if (source.messageRole !== 'user' && source.origin !== 'manual' && !remainder.supports.length) {
        const parents = nodeFor(source).parents;
        if (source.kind !== 'summary' || !parents.length || parents.some(parent => graph.get(parent.id)?.state !== 'expired' || graph.get(parent.id)?.kind !== 'transcript' || graph.get(parent.id)?.version !== parent.version)) return fail('missing_derived_support');
      }
      for (const support of remainder.supports) {
        nodeFor(support.source);
        if (!nodeFor(source).parents.some(parent => parent.id === support.source.id && parent.version === support.source.version)) return fail('support_not_in_original_provenance');
        if (allowed.has(support.source.id) && support.quote) locate(sourceFor(support.source), support.quote);
      }
    }
  }
  const needsSemantics: SourceVersion[] = [], needsSources = new Map<string, SourceVersion>();
  for (const id of affected) {
    const node = graph.get(id); if (!node || !readable(node)) continue;
    if (!allowed.has(id)) needsSources.set(id, ref(node));
    else if (node.kind === 'memory' ? !targets.has(id) : !assessments.has(id)) needsSemantics.push(ref(node));
    for (const parent of node.parents) {
      const support = graph.get(parent.id);
      if (support && readable(support) && support.version === parent.version && !allowed.has(parent.id)) needsSources.set(parent.id, ref(support));
    }
  }
  if (needsSemantics.length) return { status: 'needs_semantics', sources: needsSemantics };
  const suppressed = [...affected].filter(id => allowed.has(id) && graph.get(id)?.kind !== 'memory' && readable(graph.get(id)!)).sort().map(id => ref(allowed.get(id)!));
  const createdAt = current.createdAt, key = digest([scope, current.id]);
  const wrap = (operation: MemoryChange['operation'], index: number): MemoryChange => ({ scope, operation, operationId: `prototype:${key}:${index}`, reason: declaration.reason, createdAt });
  if (needsSources.size) {
    // A read-only probe is available for delete-only workloads such as the original closure.
    // Other incomplete declarations return requirements, never an executable partial plan.
    const readProbe = declaration.facts.every(edit => edit.intent === 'retire') ? {
      scope, request: declaration.request, changes: declaration.facts.map((edit, index) => wrap({ type: 'soft_delete', id: edit.target.id, expectedVersion: edit.target.version }, index)),
      suppressSources: suppressed, retainSources: [], clarification: null, reason: 'Read-only source expansion probe; never commit',
    } : null;
    return { status: 'needs_sources', sources: [...needsSources.values()], readProbe };
  }
  const retentions: SourceRetention[] = [], aliases = new Map<string, string>();
  const spanKey = (source: SourceVersion, span: { start: number; end: number }) => JSON.stringify([source.id, source.version, span.start, span.end]);
  const ordered = [...assessments.values()].sort((a, b) => a.source.id.localeCompare(b.source.id));
  for (const assessment of ordered) for (const remainder of assessment.retain) {
    const span = locate(sourceFor(assessment.source), remainder.quote), alias = `f${aliases.size}`;
    aliases.set(spanKey(assessment.source, span), alias);
  }
  const resolveEvidence = (evidence: SemanticEvidence): string => {
    const source = sourceFor(evidence.source);
    if (affected.has(source.id)) {
      if (!evidence.quote) return fail('affected_evidence_requires_retained_quote');
      const alias = aliases.get(spanKey(source, locate(source, evidence.quote)));
      if (!alias) return fail('evidence_not_retained');
      return alias;
    }
    if (evidence.quote) locate(source, evidence.quote);
    return source.id;
  };
  for (const assessment of ordered) for (const remainder of assessment.retain) {
    const span = locate(sourceFor(assessment.source), remainder.quote);
    retentions.push({ source: ref(assessment.source), fragmentId: aliases.get(spanKey(assessment.source, span))!, ...span, supportSourceIds: remainder.supports.map(resolveEvidence) });
  }
  const resolveFactEvidence = (evidence: SemanticEvidence): string => {
    const source = sourceFor(evidence.source);
    if (!affected.has(source.id)) return resolveEvidence(evidence);
    if (!evidence.quote) return fail('affected_evidence_requires_retained_quote');
    const span = locate(source, evidence.quote);
    // A fact may quote part of one surviving fragment; derived supports still require an exact span.
    const retained = retentions.filter(item => item.source.id === source.id && item.source.version === source.version &&
      item.start <= span.start && span.end <= item.end);
    if (retained.length !== 1) return fail('evidence_not_retained');
    return retained[0]!.fragmentId;
  };
  const changes = declaration.facts.map((edit, index) => {
    if (edit.intent === 'retire') return wrap({ type: 'soft_delete', id: edit.target.id, expectedVersion: edit.target.version }, index);
    const sourceIds = [...new Set(edit.evidence.map(resolveFactEvidence))], text = edit.statement;
    if (edit.intent === 'remember') return wrap({ type: 'add', id: `prototype-memory:${key}:${index}`, text, sourceIds }, index);
    if (edit.intent === 'revise') return wrap({ type: 'update', id: edit.target.id, expectedVersion: edit.target.version, text, sourceIds }, index);
    return wrap({ type: 'merge', targets: edit.members.map(member => ({ id: member.target.id, expectedVersion: member.target.version })), replacement: { id: `prototype-memory:${key}:${index}`, text, sourceIds } }, index);
  });
  signal.throwIfAborted();
  return { status: 'ready', plan: { scope, request: declaration.request, changes, suppressSources: suppressed, retainSources: retentions, clarification: null, reason: declaration.reason } };
}
