import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryRecord } from '../../memory/ledger.js';
import type { MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { runMemoryTrial, reviewedTrialCount, MemoryTrialCallGuard, type MemoryTrialBundle, type MemoryTrialCase } from '../../app/memory-trial.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import type { SourceCaseFactory } from '../../app/source-regression-scenarios.js';
import { evaluateLifecycle } from '../../app/evaluate-lifecycle.js';

async function fixtures(t: TestContext, excessive = false) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-trial-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const out = join(directory, 'result'), cases: MemoryTrialCase[] = [];
  for (const id of ['first', 'second']) {
    const scope = { characterId: 'companion', sessionId: 'trial', turnId: id, generation: 1 } as const;
    const records: MemoryRecord[] = ['今天聊聊日常安排', id === 'first' ? '忘记猫名' : '日常问候'].map((text, index) => {
      const message = { characterId: 'companion' as const, id: `${id}-${index}`, role: 'user' as const, text, createdAt: `2026-09-01T00:00:0${index}.000Z` };
      return { characterId: 'companion', id: message.id, kind: 'transcript', version: 1, state: 'active', text, sources: [], createdAt: message.createdAt, deletedAt: null, reason: null, message, perception: null, evidenceEligible: true, logicalOrder: index + 1, fragment: null };
    });
    const input: MemoryTurnInput = { scope, currentMessageId: `${id}-1`, sources: records.map(record => ({ scope, id: record.id, version: 1, kind: 'transcript', messageRole: 'user', text: record.text, createdAt: record.createdAt, sourceVersions: [], evidenceEligible: true })), messages: records.map(record => record.message!), relevantMemories: [] };
    cases.push({ id, input, records, maxPlans: 1, criteria: { kind: id === 'first' ? 'closure' : 'unchanged', query: '日常安排是什么？', presentText: '日常安排', absentText: '猫', unchangedIds: id === 'first' ? ['first-0'] : records.map(record => record.id), deletedMemoryIds: [], retainedParentIds: [], memoryCount: 0 } });
  }
  const stores: SqliteMemoryStore[] = [], calls: string[] = [];
  const create: SourceCaseFactory = (id, options) => {
    const store = new SqliteMemoryStore({ filename: `${out}/${id}.sqlite`, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => options!.now! }); stores.push(store);
    const memory = new SqliteLifecycleMemoryPort(store, {
      context: { maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, inputTokenBudget: 32768, countTokens: () => 1, relevance: () => 1 },
      turn: { inputTokenBudget: 32768, countTokens: () => 1, maxSupplementaryPlans: 1, provider: { async plan(input) {
        calls.push(id);
        const suppressed = id === 'first' ? input.sources.filter(source => excessive || source.id === input.currentMessageId).map(source => ({ id: source.id, version: source.version })) : [];
        return { scope: input.scope, request: id === 'first' ? 'forget' : 'none', changes: [], suppressSources: suppressed, retainSources: [], clarification: null, reason: 'Controlled fixture only' };
      } } },
      summary: { minMessages: 4, maxMessages: 4, inputTokenBudget: 32768, countTokens: () => 1, provider: { async summarize() { throw Error('must not call summary'); } } },
    });
    return { store, memory, dialogue: { async reply() { throw Error('must not call dialogue'); } } };
  };
  return { out, bundle: { stage: 'known', cases, sourceFingerprints: {} } as MemoryTrialBundle, create, stores, calls };
}

test('trial checks actual unrelated preservation and issued context before proceeding', async t => {
  const f = await fixtures(t); await runMemoryTrial(f.out, f.bundle, f.create, () => 1);
  assert.deepEqual(f.calls, ['first', 'second']); assert.ok(f.stores.every(store => store.closed));
  const result = JSON.parse(await readFile(`${f.out}/scenarios.json`, 'utf8'));
  assert.equal(result.allPassed, true); assert.equal(result.humanReviewRequired, true); assert.equal(result.wholeAcceptance, false);
});
test('applied excessive deletion fails semantics and prevents the next provider call', async t => {
  const f = await fixtures(t, true); await runMemoryTrial(f.out, f.bundle, f.create, () => 1);
  const first = JSON.parse(await readFile(`${f.out}/first.json`, 'utf8'));
  assert.equal(first.outcome.status, 'applied'); assert.equal(first.passed, false); assert.match(first.errorMessage, /Unrelated source changed/);
  assert.deepEqual(f.calls, ['first']); assert.ok(f.stores.every(store => store.closed));
  const result = JSON.parse(await readFile(`${f.out}/scenarios.json`, 'utf8'));
  assert.equal(result.allPassed, false); assert.deepEqual(result.unexecuted, ['second']);
});
test('last restored input mismatch prevents all generation and closes every case', async t => {
  const f = await fixtures(t); f.bundle.cases[1]!.records[0] = { ...f.bundle.cases[1]!.records[0]!, version: 2 };
  await assert.rejects(runMemoryTrial(f.out, f.bundle, f.create, () => 1), /Trial selected contents differ/);
  assert.deepEqual(f.calls, []); assert.ok(f.stores.every(store => store.closed));
});
test('trial call guard counts supplementary attempts and refuses unexpected or excessive calls', async t => {
  const f = await fixtures(t), first = f.bundle.cases[0]!; first.maxPlans = 2;
  const guard = new MemoryTrialCallGuard(f.bundle);
  assert.equal(guard.beforeRequest(first.input.scope), 1); assert.equal(guard.beforeRequest(first.input.scope), 2);
  assert.throws(() => guard.beforeRequest(first.input.scope), /Per-case/);
  assert.throws(() => guard.beforeRequest({ ...first.input.scope, generation: 2 }), /Unexpected/);
  assert.equal(guard.beforeRequest(f.bundle.cases[1]!.input.scope), 3);
  const holdout = new MemoryTrialCallGuard({ stage: 'holdout', sourceFingerprints: {}, cases: Array.from({ length: 4 }, (_, index) => ({ ...first, id: String(index), maxPlans: 1, input: { ...first.input, scope: { ...first.input.scope, turnId: String(index) } } })) });
  for (let index = 0; index < 3; index++) assert.equal(holdout.beforeRequest({ ...first.input.scope, turnId: String(index) }), index + 1);
  assert.throws(() => holdout.beforeRequest({ ...first.input.scope, turnId: '3' }), /Stage generation limit/);
});

test('a real evaluation step executes only its selected case and requires later review to advance', async t => {
  const f = await fixtures(t); await runMemoryTrial(f.out, f.bundle, f.create, () => 1, 'first');
  assert.deepEqual(f.calls, ['first']); assert.ok(f.stores.every(store => store.closed));
  const result = JSON.parse(await readFile(`${f.out}/scenarios.json`, 'utf8'));
  assert.equal(result.selectedCaseId, 'first'); assert.equal(result.allPassed, false);
  assert.equal(result.humanReviewRequired, true); assert.deepEqual(result.unexecuted, ['second']);
});

test('advancing a trial requires ordered independent review, unchanged evidence and the same candidate', async t => {
  const f = await fixtures(t), root = join(f.out, '..'), directory = join(root, '.local/prompt-trial-inputs');
  await mkdir(directory, { recursive: true });
  assert.equal(await reviewedTrialCount(root, f.bundle, 'fixed-prompt'), 0);
  const runId = 'lifecycle-controlled-first', run = join(root, '.local', runId); await mkdir(run);
  const evidence = {
    'manifest.json': { trialPromptHash: 'fixed-prompt', memoryWireMode: 'quoted-v2', generationCalls: 1 },
    'scenarios.json': { selectedCaseId: 'first', checks: [{ id: 'first', passed: true }] },
    'review.json': { reviewedBy: 'W0-I', passed: true }, 'model-responses.json': [{ synthetic: true }], 'plan-traces.json': [{ synthetic: true }],
  };
  const fingerprints: Record<string, string> = {};
  for (const [name, value] of Object.entries(evidence)) { const bytes = JSON.stringify(value); await writeFile(join(run, name), bytes); fingerprints[name] = createHash('sha256').update(bytes).digest('hex'); }
  await writeFile(join(directory, 'known-first-call-owner.json'), JSON.stringify({ runId, promptSha256: 'fixed-prompt' }));
  const approval = { caseId: 'first', runId, reviewedBy: 'W0-I', passed: true, promptSha256: 'fixed-prompt', fingerprints };
  const path = join(directory, 'known-approvals.json'); await writeFile(path, JSON.stringify([approval]));
  assert.equal(await reviewedTrialCount(root, f.bundle, 'fixed-prompt'), 1);
  await assert.rejects(reviewedTrialCount(root, f.bundle, 'different-prompt'));
  await writeFile(path, JSON.stringify([{ ...approval, caseId: 'second' }]));
  await assert.rejects(reviewedTrialCount(root, f.bundle, 'fixed-prompt'), /Trial order/);
  await writeFile(path, JSON.stringify([{ ...approval, passed: false }]));
  await assert.rejects(reviewedTrialCount(root, f.bundle, 'fixed-prompt'));
  await writeFile(path, JSON.stringify([approval])); await writeFile(join(run, 'model-responses.json'), 'changed');
  await assert.rejects(reviewedTrialCount(root, f.bundle, 'fixed-prompt'), /Reviewed trial evidence changed/);
});

test('a stopped trial rejects either stage before reading credentials or source bundles', async t => {
  const f = await fixtures(t), root = join(f.out, '..'), directory = join(root, '.local/prompt-trial-inputs');
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'STOPPED.json'), '{}');
  for (const suite of ['prompt-trial-known', 'prompt-trial-holdout'] as const) {
    await assert.rejects(evaluateLifecycle(root, '/must-not-read-credentials', 'lifecycle-must-not-run', suite, 'quoted-v2'), /Bounded trial is stopped/);
  }
});
