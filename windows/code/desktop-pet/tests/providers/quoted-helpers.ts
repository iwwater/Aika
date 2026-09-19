import type { TurnScope } from '../../contracts/index.js';
import type { MemorySource, MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { QwenMemoryTurnProvider } from '../../providers/qwen-memory-lifecycle.js';
import { ProviderTransport } from '../../providers/transport.js';
import type { MemoryWireMode } from '../../providers/memory-wire.js';

export const scope: TurnScope = { characterId: 'friend', sessionId: 'quoted', turnId: 'current', generation: 1 };
export const signal = () => new AbortController().signal;
export const ref = (id: string, version = 1) => ({ id, version });
export function source(id: string, text: string, patch: Partial<MemorySource> = {}): MemorySource {
  return { scope, id, text, version: 1, kind: 'transcript', messageRole: 'user', createdAt: '2026-09-01T00:00:00Z', sourceVersions: [], evidenceEligible: true, ...patch };
}
export function input(sources = [source('current:user', '保留无关事实'), source('old:user', '前句。🐱e\u0301；后句。')]): MemoryTurnInput {
  const active = sources[0]!.scope;
  return { scope: active, currentMessageId: sources[0]!.id, sources,
    messages: sources.filter(s => s.kind === 'transcript').map(s => ({ characterId: active.characterId, id: s.id, text: s.text, role: s.messageRole!, createdAt: s.createdAt })),
    relevantMemories: sources.filter(s => s.kind === 'memory').map(s => ({ characterId: active.characterId, id: s.id, text: s.text, version: s.version, sourceIds: (s.sourceVersions ?? []).map(r => r.id) })) };
}
export const plan = (patch: Record<string, unknown> = {}) => ({ request: 'none', changes: [], suppressSources: [], retainSources: [], clarification: null, reason: '独立受控候选', ...patch });
export const retained = (quote: unknown, range: unknown = null, sourceId = 's1', fragmentId = 'f0', supportSourceIds: string[] = []) => ({ source: ref(sourceId), fragmentId, quote, range, supportSourceIds });
export const change = (operation: unknown) => ({ reason: '独立受控依据', operation });
export const config = { endpoint: 'https://controlled.invalid/completions', model: 'fixture', apiKey: () => 'test-only', authorizer: { async authorize() { return { async settle() {} }; } } };
export function harness(answer: unknown | ((body: any) => unknown), mode: MemoryWireMode = 'quoted-v2', after?: () => void) {
  const requests: any[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    const value = typeof answer === 'function' ? answer(body) : answer;
    after?.();
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] });
  });
  return { provider: new QwenMemoryTurnProvider(config, transport, mode), requests };
}
