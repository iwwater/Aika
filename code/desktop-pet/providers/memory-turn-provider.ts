import type { MemoryChange } from '../contracts/index.js';
import type { MemoryTurnInput, MemoryTurnPlan, MemoryTurnProvider } from '../contracts/memory-lifecycle.js';
import { checkAbort, scopeKey } from '../media/scope.js';
import { completedText, exactFields, nonempty, parseMemoryChanges } from './memory-json.js';
import { type EndpointConfig, parseModelJson, ProviderTransport } from './transport.js';
import { type CheckedSource, assertMemoryWireMode, type MemoryWireMode } from './memory-wire.js';
import { checkRetentions, parseRetentions } from './memory-retention.js';
import { buildMemoryTurnFormat } from './memory-turn-format.js';
import { parseMemoryDynamicsPlan } from './memory-dynamics-plan.js';

function checkChanges(changes: readonly MemoryChange[], known: ReadonlyMap<string, CheckedSource>, suppressed: ReadonlySet<string>): void {
  const written = new Set<string>(), created = new Set<string>();
  const texts = new Set([...known.values()].filter(source => source.kind === 'memory').map(source => source.text));
  for (const change of changes) {
    const op = change.operation;
    const targetIds = op.type === 'add' ? [] : op.type === 'merge' ? op.targets.map(target => target.id) : [op.id];
    for (const id of targetIds) { if (written.has(id)) throw new Error('Repeated memory plan target'); written.add(id); }
    const addition = op.type === 'add' ? op : op.type === 'merge' ? op.replacement : null;
    if (addition) {
      if (known.has(addition.id) || created.has(addition.id)) throw new Error('New memory plan ID already exists');
      created.add(addition.id);
      if (op.type === 'add') {
        if (texts.has(op.text)) throw new Error('Identical memory already exists; update or merge the existing records');
        texts.add(op.text);
      }
    }
    const refs = op.type === 'add' || op.type === 'update' ? op.sourceIds : op.type === 'merge' ? op.replacement.sourceIds : [];
    if (refs.some(id => suppressed.has(id))) throw new Error('Memory plan reuses suppressed source');
  }
}

export abstract class MemoryTurnProviderBase implements MemoryTurnProvider {
  protected constructor(private readonly config: EndpointConfig, private readonly transport: ProviderTransport, private readonly mode: MemoryWireMode, private readonly dialect: 'qwen' | 'deepseek', private readonly dynamics=false) { assertMemoryWireMode(mode); }
  async plan(original: MemoryTurnInput, signal: AbortSignal): Promise<MemoryTurnPlan> {
    checkAbort(signal);
    // Freeze the exact request snapshot across network waits; storage revalidates on commit.
    const { input, known, wire, data, system } = buildMemoryTurnFormat(original, this.mode,this.dynamics);
    const raw = await this.transport.request(this.config, input.scope, 'memory_turn', { messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(data) }], stream: false, ...(this.dialect === 'deepseek' ? { thinking: { type: 'disabled' } } : { enable_thinking: false }), response_format: { type: 'json_object' } }, signal);
    checkAbort(signal);
    const parsed = parseModelJson(completedText(raw)); exactFields(parsed, ['request', 'changes', 'suppressSources', 'retainSources', 'clarification', 'reason', ...(this.dynamics&&Object.hasOwn(parsed,'dynamics')?['dynamics']:[])]);
    if (parsed.request !== 'none' && parsed.request !== 'correction' && parsed.request !== 'forget') throw new Error('Invalid memory request kind');
    const reason = nonempty(parsed.reason), clarification = parsed.clarification === null ? null : nonempty(parsed.clarification);
    const suppressSources = wire.versions(parsed.suppressSources);
    if (suppressSources.some(ref => known.get(ref.id)?.kind === 'memory')) throw new Error('Use a memory operation for a memory target');
    const retainSources = parseRetentions(parsed.retainSources, wire, suppressSources);
    const fragments = new Set(retainSources.map(item => item.fragmentId));
    const changes = parseMemoryChanges(wire.changes(parsed.changes, fragments), input, new Set([...known.keys(), ...fragments]));
    if (clarification && (changes.length || suppressSources.length || retainSources.length)) throw new Error('Clarification cannot include mutations');
    if (parsed.request !== 'none' && !clarification && !changes.length && !suppressSources.length) throw new Error('Explicit memory request has no executable targets');
    if (parsed.request === 'correction' && suppressSources.some(ref => ref.id === input.currentMessageId) && !retainSources.some(item => item.source.id === input.currentMessageId)) throw new Error('Correction must retain current evidence before suppressing its message');
    const suppressed = new Set(suppressSources.map(ref => ref.id));
    if (parsed.request === 'forget' && !clarification && !suppressed.has(input.currentMessageId)) throw new Error('Forget must explicitly handle its current message');
    checkChanges(changes, known, suppressed);
    checkRetentions(retainSources, changes, known, suppressed);
    // Model IDs for new records are batch aliases. Actual IDs cannot rely on the
    // model seeing every record in the role's database. Full scope + index is stable
    // for replay and distinct across turns/sessions/characters/generations.
    const assigned = changes.map((change, index): MemoryChange => {
      const operationId = `memory-turn:${scopeKey(input.scope)}:${index}`, id = `${operationId}:record`, op = change.operation;
      const operation = op.type === 'add' ? { ...op, id } : op.type === 'merge' ? { ...op, replacement: { ...op.replacement, id } } : op;
      return { ...change, operationId, operation };
    });
    const dynamics=Object.hasOwn(parsed,'dynamics')?parseMemoryDynamicsPlan(parsed.dynamics,input,wire,parsed.changes,assigned,parsed.request):undefined;
    if(clarification&&dynamics&&(dynamics.traits.length||dynamics.reinforcements.length))throw new Error('Clarification cannot change dynamics');
    return { scope: input.scope, request: parsed.request, changes: assigned, suppressSources, retainSources, clarification, reason, ...(dynamics?{dynamics}:{}) };
  }
}
