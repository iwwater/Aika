import { textJsonProtocol } from './text-protocol.js';
import type { SummaryInput, SummaryProposal, SummaryProvider } from '../contracts/memory-lifecycle.js';
import { checkAbort } from '../media/scope.js';
import { completedText, exactFields, nonempty } from './memory-json.js';
import { SUMMARY_PROMPT } from './memory-lifecycle-prompt.js';
import { type EndpointConfig, parseModelJson, ProviderTransport } from './transport.js';
import { checkedSources, MemoryWire, type MemoryWireMode } from './memory-wire.js';
import { MemoryTurnProviderBase } from './memory-turn-provider.js';

export class QwenMemoryTurnProvider extends MemoryTurnProviderBase {
  constructor(config: EndpointConfig, transport = new ProviderTransport(), mode: MemoryWireMode = 'numeric-v1', dynamics=false) {
    super(config, transport, mode, 'qwen',dynamics);
  }
}

export class JsonSummaryProvider implements SummaryProvider {
  constructor(private readonly config: EndpointConfig, private readonly transport = new ProviderTransport()) {}
  async summarize(original: SummaryInput, signal: AbortSignal): Promise<SummaryProposal> {
    checkAbort(signal);
    const input = structuredClone(original), known = checkedSources(input.scope, input.sources), wire = new MemoryWire(known);
    if ([...known.values()].some(source => !source.evidenceEligible)) throw new Error('Display-only source cannot enter summary');
    const raw = await this.transport.request(this.config, input.scope, 'summary', { messages: [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: JSON.stringify(wire.data()) }], ...textJsonProtocol(this.config) }, signal);
    checkAbort(signal);
    const parsed = parseModelJson(completedText(raw)); exactFields(parsed, ['text', 'sourceVersions']);
    const text = nonempty(parsed.text), sourceVersions = wire.versions(parsed.sourceVersions);
    if (sourceVersions.length !== known.size) throw new Error('Summary must cover every input source version');
    return { scope: input.scope, text, sourceVersions };
  }
}

export class QwenSummaryProvider extends JsonSummaryProvider {}
