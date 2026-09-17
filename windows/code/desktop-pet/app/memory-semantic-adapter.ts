/** Independent single-attempt evaluation adapter; the integration phase owns permission, tickets and commits. */
import { createHash } from 'node:crypto';
import type { TurnScope } from '../contracts/index.js';
import type { MemoryTurnPlan } from '../contracts/memory-lifecycle.js';
import { assertScope, checkAbort } from '../media/scope.js';
import { completedText, nonempty } from '../providers/memory-json.js';
import { checkRetentions, operationSources } from '../providers/memory-retention.js';
import { fragmentAlias } from '../providers/memory-wire.js';
import { ProviderRequestFailure, parseModelJson, type EndpointConfig, type ProviderTransport } from '../providers/transport.js';
import { compileMemoryPrototype, type PrototypeResult, type PrototypeSnapshot, type SemanticDeclaration } from './memory-planning-prototype.js';
import { buildMemorySemanticFormat, decodeMemorySemanticDeclaration, MEMORY_SEMANTIC_INPUT_LIMIT, type MemorySemanticFormat } from './memory-semantic-format.js';
import { attachSemanticDynamics } from './memory-semantic-dynamics.js';

export interface SemanticAttemptProvenance { readonly kind: 'controlled_stub' | 'real_provider'; readonly runId: string; readonly attemptId: string }
export interface SemanticAttemptEvent {
  readonly type: 'request' | 'response' | 'declaration' | 'compiled' | 'failure';
  readonly provenance: SemanticAttemptProvenance;
  readonly scope: TurnScope;
  readonly elapsedMs: number;
  readonly data: unknown;
}
export interface MemorySemanticAttempt {
  readonly snapshot: PrototypeSnapshot;
  readonly config: EndpointConfig;
  readonly transport: ProviderTransport;
  readonly provenance: SemanticAttemptProvenance;
  readonly signal: AbortSignal;
  readonly evidence: (event: SemanticAttemptEvent) => Promise<void>;
  readonly reasoningEffort?: 'high';
  readonly dynamics?: boolean;
  readonly managementTarget?: import('../contracts/memory-lifecycle.js').SourceVersion;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** The same restricted body feeds request evidence and transport; omitted mode preserves the legacy bytes. */
export function buildSemanticRequestBody(format: MemorySemanticFormat, reasoningEffort?: 'high'): Record<string, unknown> {
  if (reasoningEffort === undefined) return format.body;
  if (reasoningEffort !== 'high') throw new Error('Unknown semantic thinking mode');
  return { ...format.body, thinking: { type: 'enabled' }, reasoning_effort: 'high' };
}

/** Mirrors the existing provider's final guards without changing its wire or implementation. */
export function assertCompiledSemanticPlan(plan: MemoryTurnPlan, format: MemorySemanticFormat): void {
  const { known, input, wire } = format;
  assertScope(input.scope, plan.scope); nonempty(plan.reason);
  if (!['none', 'forget', 'correction'].includes(plan.request)) throw new Error('Invalid memory request kind');
  const suppressed = new Set<string>(), retained = plan.retainSources ?? [];
  for (const ref of plan.suppressSources) {
    const source = known.get(ref.id);
    if (!source || source.kind === 'memory' || !source.evidenceEligible || source.version !== ref.version || suppressed.has(ref.id)) throw new Error('Invalid compiled suppression');
    suppressed.add(ref.id);
  }
  const fragments = new Set<string>(), spans = new Map<string, { start: number; end: number }[]>();
  for (const item of retained) {
    const source = known.get(item.source.id);
    if (!source || source.kind === 'memory' || !source.evidenceEligible || source.version !== item.source.version || !suppressed.has(source.id)) throw new Error('Invalid compiled fragment source');
    if (!fragmentAlias(item.fragmentId) || fragments.has(item.fragmentId) || wire.collidesWithIdentity(item.fragmentId)) throw new Error('Invalid or colliding fragment alias');
    fragments.add(item.fragmentId);
    if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < 0 || item.start >= item.end || item.end > [...source.text].length) throw new Error('Invalid Unicode code point range');
    nonempty([...source.text].slice(item.start, item.end).join(''));
    const prior = spans.get(source.id) ?? [];
    if (prior.some(span => item.start < span.end && span.start < item.end)) throw new Error('Overlapping source fragments');
    prior.push(item); spans.set(source.id, prior);
    if (new Set(item.supportSourceIds).size !== item.supportSourceIds.length) throw new Error('Repeated source reference');
  }
  if (plan.clarification !== null) {
    nonempty(plan.clarification);
    if (plan.changes.length || suppressed.size || retained.length) throw new Error('Clarification cannot include mutations');
  }
  if (plan.request !== 'none' && !plan.clarification && !plan.changes.length && !suppressed.size) throw new Error('Explicit memory request has no executable targets');
  if (plan.request === 'correction' && suppressed.has(input.currentMessageId) && !retained.some(item => item.source.id === input.currentMessageId)) throw new Error('Correction must retain current evidence before suppressing its message');
  if (plan.request === 'forget' && !plan.clarification && !suppressed.has(input.currentMessageId)) throw new Error('Forget must explicitly handle its current message');
  const written = new Set<string>(), created = new Set<string>(), operationIds = new Set<string>();
  const texts = new Set([...known.values()].filter(source => source.kind === 'memory').map(source => source.text));
  for (const change of plan.changes) {
    assertScope(input.scope, change.scope); nonempty(change.reason); nonempty(change.operationId);
    if (operationIds.has(change.operationId)) throw new Error('Repeated operation ID'); operationIds.add(change.operationId);
    const op = change.operation;
    const targets = op.type === 'add' ? [] : op.type === 'merge' ? op.targets : [{ id: op.id, expectedVersion: op.expectedVersion }];
    if (op.type === 'merge' && targets.length < 2) throw new Error('Merge needs at least two targets');
    for (const target of targets) {
      const source = known.get(target.id);
      if (!source || source.kind !== 'memory' || !source.evidenceEligible || target.expectedVersion !== source.version) throw new Error('Memory target/version not in this character context');
      if (written.has(target.id)) throw new Error('Repeated memory plan target'); written.add(target.id);
    }
    const addition = op.type === 'add' ? op : op.type === 'merge' ? op.replacement : null;
    if (addition) {
      nonempty(addition.id); nonempty(addition.text);
      if (wire.collidesWithIdentity(addition.id) || fragments.has(addition.id) || created.has(addition.id)) throw new Error('New memory plan ID already exists');
      created.add(addition.id);
      if (op.type === 'add') { if (texts.has(op.text)) throw new Error('Identical memory already exists; update or merge the existing records'); texts.add(op.text); }
    }
    if (op.type === 'update') nonempty(op.text);
    const refs = operationSources(change);
    if ((op.type === 'add' || op.type === 'update' || op.type === 'merge') && !refs.length) throw new Error('Memory cites an unavailable source');
    if (refs.some(id => !fragments.has(id) && !known.get(id)?.evidenceEligible)) throw new Error('Memory cites an unavailable source');
    if (refs.some(id => suppressed.has(id))) throw new Error('Memory plan reuses suppressed source');
  }
  checkRetentions(retained, plan.changes, known, suppressed);
}

export async function runMemorySemanticAttempt(args: MemorySemanticAttempt): Promise<{ declaration: SemanticDeclaration; compiled: PrototypeResult }> {
  // Clone before any async boundary; evidence consumers never receive these live objects.
  const snapshot = structuredClone(args.snapshot), config = { ...args.config }, provenance = structuredClone(args.provenance);
  const scope = snapshot.input.scope, signal = args.signal, started = performance.now();
  const emit = async (type: SemanticAttemptEvent['type'], data: unknown) => {
    await args.evidence(structuredClone({ type, provenance, scope, elapsedMs: performance.now() - started, data }));
  };
  let stage = 'input';
  try {
    checkAbort(signal);
    if (provenance.kind !== 'controlled_stub' && provenance.kind !== 'real_provider') throw new Error('Unknown semantic host provenance');
    nonempty(provenance.runId); nonempty(provenance.attemptId); nonempty(config.model);
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Explicit HTTPS provider endpoint required');
    const format = buildMemorySemanticFormat(snapshot.input,args.dynamics,args.managementTarget);
    if (format.inputUpperBound > MEMORY_SEMANTIC_INPUT_LIMIT) throw new Error('Semantic request exceeds input budget');
    const body = buildSemanticRequestBody(format, args.reasoningEffort);
    const request = { ...body, model: config.model }, requestJson = JSON.stringify(request);
    stage = 'request_evidence';
    await emit('request', { input: format.input, graph: snapshot.graph, system: format.system, data: format.data, body,
      endpoint: config.endpoint, request, requestJson, requestSha256: sha(requestJson), systemSha256: sha(format.system),
      inputSha256: sha(JSON.stringify(format.input)), systemBytes: format.systemBytes, dataBytes: format.dataBytes,
      messageBytes: format.messageBytes, inputUpperBound: format.inputUpperBound, requestBodyBytes: Buffer.byteLength(JSON.stringify(body)), requestBytes: Buffer.byteLength(requestJson) });
    checkAbort(signal); stage = 'transport';
    const raw = await args.transport.request(config, scope, 'memory_turn', body, signal);
    stage = 'response_evidence';
    // Preserve even malformed/truncated choices, before completedText or any structured decoding.
    const choices = raw.choices;
    const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : null;
    const content = choice && typeof choice === 'object' && choice.message && typeof choice.message === 'object' ? choice.message.content ?? null : null;
    await emit('response', { raw, content, rawSha256: sha(JSON.stringify(raw)) });
    checkAbort(signal); stage = 'decode';
    const decoded=parseModelJson(completedText(raw)),hasDynamics=args.dynamics&&Object.hasOwn(decoded,'dynamics');
    const semantic={...decoded};if(hasDynamics)delete semantic.dynamics;
    const declaration = decodeMemorySemanticDeclaration(semantic, format);
    await emit('declaration', { declaration }); checkAbort(signal); stage = 'compile';
    let compiled = compileMemoryPrototype(snapshot, declaration, signal);
    if(compiled.status==='ready'&&hasDynamics)compiled={...compiled,plan:attachSemanticDynamics(decoded.dynamics,format,compiled.plan)};
    await emit('compiled', { compiled }); checkAbort(signal); stage = 'ready_guard';
    if (compiled.status === 'ready') assertCompiledSemanticPlan(compiled.plan, format);
    checkAbort(signal); return { declaration, compiled };
  } catch (error) {
    try { await emit('failure', { stage, name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : 'Semantic attempt failed', aborted: signal.aborted, ...(error instanceof ProviderRequestFailure ? {transport:error.diagnostic} : {}) }); }
    catch (sinkError) { throw new AggregateError([error, sinkError], 'Semantic attempt and evidence persistence failed'); }
    throw error;
  }
}
