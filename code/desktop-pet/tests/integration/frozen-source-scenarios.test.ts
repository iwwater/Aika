import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import type { MemoryRecord } from '../../memory/ledger.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { runFrozenSourceScenarios } from '../../app/frozen-source-scenarios.js';
import type { SourceCaseFactory } from '../../app/source-regression-scenarios.js';

async function fixtures(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'frozen-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = join(directory, 'original'), out = join(directory, 'result'); await mkdir(original);
  const fingerprints: Record<string, string> = {}, plans: unknown[] = Array(15).fill(null);
  const responses: unknown[] = Array.from({ length: 15 }, () => ({ operation: 'memory_turn' }));
  const ids = ['mixed-long-memory-forget', 'mixed-raw-only-forget', 'mixed-summary-only-forget', 'echo-forget'];
  const positions = [7, 9, 11, 14], inputs: MemoryTurnInput[] = [];
  async function save(name: string, data: unknown) {
    const text = JSON.stringify(data); fingerprints[name] = createHash('sha256').update(text).digest('hex');
    await writeFile(join(original, name), text);
  }
  for (const [index, id] of ids.entries()) {
    const scope = { characterId: 'companion', sessionId: 'synthetic', turnId: id, generation: 1 } as const;
    const message = { characterId: scope.characterId, id: `${id}:user`, role: 'user', text: '合成问候', createdAt: '2026-09-01T00:00:00.000Z' } as const;
    const record: MemoryRecord = { characterId: scope.characterId, id: message.id, kind: 'transcript', version: 1, state: 'active', text: message.text,
      sources: [], createdAt: message.createdAt, deletedAt: null, reason: null, message, perception: null, evidenceEligible: true, logicalOrder: 1, fragment: null };
    const input: MemoryTurnInput = { scope, currentMessageId: message.id, messages: [message], relevantMemories: [], sources: [{ scope, id: message.id, kind: 'transcript', version: 1, text: message.text,
      createdAt: message.createdAt, messageRole: 'user', sourceVersions: [], evidenceEligible: true }] };
    inputs.push(input); plans[positions[index]!] = { input }; responses[positions[index]!] = { scope, operation: 'memory_turn', modelText: 'Original controlled placeholder; no semantic success claim' };
    await save(`${id}.json`, { synthetic: true, scope, text: message.text, sourcesBefore: [record] });
    if (index === 2) await save('mixed-summary-only-before.json', { raw: { ...record, id: 'expired', text: '', state: 'expired', logicalOrder: 0, message: { ...message, id: 'expired', text: '' } } });
  }
  await save('plan-traces.json', plans); await save('model-responses.json', responses);
  await writeFile(join(original, 'review.json'), JSON.stringify({ fingerprints }));
  const stores: SqliteMemoryStore[] = [], received: MemoryTurnInput[] = [];
  const create: SourceCaseFactory = (name, options) => {
    const store = new SqliteMemoryStore({ filename: `${out}/${name}.sqlite`, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => options!.now! });
    stores.push(store);
    const memory = new SqliteLifecycleMemoryPort(store, {
      context: { maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, inputTokenBudget: 32768, countTokens: () => 1, relevance: () => 1 },
      turn: { inputTokenBudget: 32768, countTokens: () => 1, maxSupplementaryPlans: 1, provider: { async plan(input) {
        received.push(structuredClone(input));
        return { scope: input.scope, request: 'none', changes: [], suppressSources: [], retainSources: [], clarification: null, reason: 'Controlled no-op only' };
      } } },
      summary: { minMessages: 4, maxMessages: 4, inputTokenBudget: 32768, countTokens: () => 1, provider: { async summarize() { throw Error('not used'); } } },
    });
    return { store, memory, dialogue: { async reply() { throw Error('not used'); } } };
  };
  return { original, out, create, stores, received, inputs, ids, fingerprints, save };
}

test('frozen source runner verifies all original selections and preserves evidence without dialogue calls', async t => {
  const f = await fixtures(t);
  await runFrozenSourceScenarios(f.out, f.original, f.create, () => 1);
  assert.deepEqual(f.received, f.inputs); assert.ok(f.stores.every(store => store.closed));
  for (const id of f.ids) {
    const result = JSON.parse(await readFile(join(f.out, `${id}.json`), 'utf8'));
    assert.equal(result.completed, true); assert.equal(result.outcome.status, 'unchanged');
    assert.equal(result.semanticAcceptance, false); assert.equal(result.historicalTransactionReplay, false);
    assert.deepEqual(result.sourcesAfter, result.sourcesBefore);
  }
  for (const [name, hash] of Object.entries(f.fingerprints)) assert.equal(createHash('sha256').update(await readFile(join(f.original, name))).digest('hex'), hash);
});

test('a corrupt last frozen source prevents all case creation and generation', async t => {
  const f = await fixtures(t); await writeFile(join(f.original, 'echo-forget.json'), '{}');
  await assert.rejects(runFrozenSourceScenarios(f.out, f.original, f.create, () => 1), /Original source evidence changed/);
  assert.equal(f.stores.length, 0); assert.equal(f.received.length, 0);
});

test('a last-case restored version mismatch rejects before every model call and closes all stores', async t => {
  const f = await fixtures(t), name = 'echo-forget.json';
  const scene = JSON.parse(await readFile(join(f.original, name), 'utf8')); scene.sourcesBefore[0].version = 2;
  await f.save(name, scene); await writeFile(join(f.original, 'review.json'), JSON.stringify({ fingerprints: f.fingerprints }));
  await assert.rejects(runFrozenSourceScenarios(f.out, f.original, f.create, () => 1), /Selected source\/message contents differ/);
  assert.equal(f.received.length, 0); assert.equal(f.stores.length, 4); assert.ok(f.stores.every(store => store.closed));
});
