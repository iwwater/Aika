import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTrialBackend, StrictTrialMemoryProvider } from '../../app/trial-backend.js';
import { ProviderTransport } from '../../providers/transport.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { buildMemorySemanticFormat } from '../../app/memory-semantic-format.js';
import type { SemanticAttemptEvent } from '../../app/memory-semantic-adapter.js';

test('trial backend refuses missing explicit activation without opening the old backend', async () => {
  await assert.rejects(startTrialBackend({}), /Explicit trial/);
  await assert.rejects(startTrialBackend({ PET_TRIAL_CONFIG: '/nonexistent-trial/config.json', PET_TRIAL_ACTIVATION: '/nonexistent-trial/activation.json' }), /尚未就绪/);
});

test('trial strict adapter compiles controlled provider semantics into actual SQLite and survives reopen', async t => {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../.local/companion-step1-01/tmp');
  await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, 'strict-trial-'));
  const filename = join(root, 'state.sqlite');
  let store = new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const events: SemanticAttemptEvent[] = []; let calls = 0;
  const transport = new ProviderTransport(async (_url, options) => {
    calls++; const request = JSON.parse(String(options?.body)); assert.equal(request.reasoning_effort, 'high');
    const data = JSON.parse(request.messages[1].content), current = data.currentMessage;
    const evidence = { source: { id: current.id, version: current.version }, quote: { text: current.text, context: null } };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ request: 'none', erase: [],
      facts: [{ intent: 'remember', statement: current.text, evidence: [evidence], basis: [evidence] }], assessments: [], reason: 'Controlled fixture', unresolved: null }) } }] });
  });
  const provider = new StrictTrialMemoryProvider(store, { endpoint: 'https://example.invalid/chat', model: 'controlled', apiKey: () => 'controlled-key',
    authorizer: { async authorize() { return { async settle() {} }; } } }, transport, 'controlled-trial', async event => { events.push(event); }, 'high', 'controlled_stub');
  const memory = new SqliteLifecycleMemoryPort(store, { context: { inputTokenBudget: 32768, maxRecentMessages: 12, maxMemories: 8, summaryLimit: 4,
    countTokens: context => JSON.stringify(context).length, relevance: () => 1 },
    turn: { provider, inputTokenBudget: 32768, countTokens: input => buildMemorySemanticFormat(input).inputUpperBound, maxSupplementaryPlans: 1 },
    summary: { minMessages: 100, maxMessages: 100, inputTokenBudget: 32768, countTokens: input => JSON.stringify(input).length,
      provider: { async summarize() { throw new Error('No summary in fixture'); } } } });
  const scope = { characterId: 'companion' as const, sessionId: 's', turnId: 't', generation: 1 }, text = '我每周五练吉他。';
  await memory.append(scope, [{ characterId: 'companion', id: 'current', role: 'user', text, createdAt: new Date().toISOString() }]);
  const result = await memory.prepareTurn(scope, 'current', text, new AbortController().signal);
  assert.equal(result.status, 'applied'); assert.equal(calls, 1);
  assert.deepEqual(events.map(event => event.type), ['request', 'response', 'declaration', 'compiled']);
  assert.ok(events.every(event => event.provenance.kind === 'controlled_stub'));
  assert.equal(store.visible(scope, 'memory')[0]?.text, text); assert.throws(() => store.visible({ ...scope, characterId: 'retired-fixture' }, 'memory'), /unknown_character/);
  store.close(); store = new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  assert.equal(store.visible(scope, 'memory')[0]?.text, text);
});
