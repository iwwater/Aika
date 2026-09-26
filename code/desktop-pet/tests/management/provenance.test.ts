import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemorySource, MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { checkedSources, checkedTurn, MemoryWire } from '../../providers/memory-wire.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';

const scope = { characterId: 'companion' as const, sessionId: 'session', turnId: 'turn', generation: 1 };
const manual: MemorySource = { scope, id: 'edited', version: 2, kind: 'transcript', text: '人工修正的资料',
  createdAt: '2026-09-10T00:00:00.000Z', messageRole: 'assistant', evidenceEligible: true, origin: 'manual', sourceVersions: [] };
test('only marked manual edits can be independent assistant evidence and wire preserves provenance', () => {
  const known = checkedSources(scope, [manual]);
  const row = (new MemoryWire(known).data() as { sources: MemorySource[] }).sources[0]!;
  assert.equal(row.origin, 'manual');
  const { origin: _origin, ...unmarked } = manual;
  assert.throws(() => checkedSources(scope, [unmarked]), /eligibility/);
  assert.throws(() => checkedSources(scope, [{ ...manual, sourceVersions: [{ id: 'old', version: 1 }] }]), /old utterance lineage/);
  const user: MemorySource = { ...unmarked, id: 'current', version: 1, messageRole: 'user' };
  const input: MemoryTurnInput = { scope, currentMessageId: 'current', sources: [user, manual],
    messages: [{ characterId: 'companion', id: 'current', role: 'user', text: user.text, createdAt: user.createdAt },
      { characterId: 'companion', id: manual.id, role: 'assistant', text: manual.text, createdAt: manual.createdAt, origin: 'manual' }], relevantMemories: [] };
  checkedTurn(input);
  assert.throws(() => checkedTurn({ ...input, messages: input.messages.map(({ origin: _origin, ...m }) => m) }), /versioned source/);
});

test('actual dialogue serialization carries manual source markers instead of claiming historical speech', async () => {
  let body: Record<string, unknown> | undefined;
  const transport = new ProviderTransport(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: 'reply', expression: { emotion: 'neutral', intensity: 0, delivery: 'normal', gesture: null } }) } }] });
  });
  const provider = new QwenDialogueProvider({ model: 'controlled', endpoint: 'https://controlled.invalid', apiKey: () => 'synthetic',
    authorizer: { async authorize() { return { async settle() {} }; } } }, transport);
  await provider.reply({ scope, text: '本轮问题', context: { scope, characterPrompt: '角色', inputTokenBudget: 10000,
    recent: [{ characterId: 'companion', id: 'edited', role: 'assistant', text: manual.text, createdAt: manual.createdAt, origin: 'manual' }],
    summary: '[人工编辑摘要]当前内容', memories: [], perception: null } }, new AbortController().signal);
  const messages = body!.messages as { role: string; content: string }[];
  const data = JSON.parse(messages.at(-1)!.content); assert.equal(data.history[0].origin, 'manual');
  assert.match(messages[0]!.content, /不证明该文字曾在历史对话中说出/);
});
