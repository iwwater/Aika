import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import type { BudgetState } from '../../core/evaluation-budget.js';
import { ProviderTransport } from '../../providers/transport.js';
import type { MemoryRecord } from '../../memory/ledger.js';
import { runSemanticCase, loadOriginalSemanticCases, evaluateMemorySemantics, semanticEvidenceFetcher, prepareRegisteredSemanticBatch, type SemanticFixture } from '../../app/evaluate-memory-semantics.js';
import { compileMemoryPrototype, prototypeSnapshot, type SemanticDeclaration } from '../../app/memory-planning-prototype.js';
import { buildMemorySemanticFormat, type MemorySemanticFormat } from '../../app/memory-semantic-format.js';
import { runMemorySemanticAttempt, buildSemanticRequestBody, type SemanticAttemptEvent } from '../../app/memory-semantic-adapter.js';
import { beginSemanticCase, loadSemanticPhase, semanticHash, semanticInputHash, semanticPeakEstimate, semanticOrder,
  SEMANTIC_PHASE, SEMANTIC_DIRECTORY, SEMANTIC_MODEL, SEMANTIC_ENDPOINT, SEMANTIC_PARAMETERS, type SemanticPhaseConfig,
  SEMANTIC_RECHECK_PHASE, semanticPhaseProfile, type SemanticPhaseId, type SemanticBatchId, SEMANTIC_BATCH_ROOT, SEMANTIC_POLICY, migrateSemanticBudget20,
  SEMANTIC_PRO_MODEL, semanticModelProfile, assertSemanticModelOnlyRequest, assertSemanticThinkingOnlyRequest, assertSemanticSystemOnlyRequest, SEMANTIC_THINKING_PARAMETERS } from '../../app/memory-semantic-phase.js';

const input: MemoryTurnInput = { scope: { characterId: 'companion', sessionId: 'offline-phase', turnId: 'current', generation: 1 },
  currentMessageId: 'current', messages: [{ characterId: 'companion', id: 'current', role: 'user', text: 'hello', createdAt: '2026-09-01T00:00:00.000Z' }],
  relevantMemories: [], sources: [{ scope: { characterId: 'companion', sessionId: 'offline-phase', turnId: 'current', generation: 1 }, id: 'current', version: 1,
    kind: 'transcript', messageRole: 'user', text: 'hello', createdAt: '2026-09-01T00:00:00.000Z', sourceVersions: [], evidenceEligible: true }] };
const ledger = '.local/model-evaluation/budget.json';
async function phaseHarness(t: TestContext, phaseId: SemanticPhaseId = SEMANTIC_PHASE) {
  const root = await mkdtemp(join(tmpdir(), 'semantic-phase-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (relative: string, value: unknown) => { const path = join(root, relative); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value) + '\n'); };
  const read = async (relative: string) => JSON.parse(await readFile(join(root, relative), 'utf8'));
  const profile = semanticPhaseProfile(phaseId), old = profile.protectedPaths;
  const source = 'code/desktop-pet/app/test-owned-source.ts';
  const pins: Record<string, string> = {};
  for (const path of [...old, source]) { await write(path, { synthetic: true, path }); pins[path] = semanticHash(await readFile(join(root, path))); }
  const state: BudgetState = { batchId: 'D09-S1-20260906-01', currency: 'CNY', limitMicros: 10_000_000, blocked: false,
    entries: [{ operationId: 'historical:synthetic', model: 'historical', reservedMicros: 300_000, actualMicros: 276_594, status: 'settled' }] };
  if (phaseId === SEMANTIC_RECHECK_PHASE) for (let i = 1; i < 117; i++) state.entries.push({ operationId: `historical:test-only:${i}`, model: 'historical', reservedMicros: 1, actualMicros: 0, status: 'settled' });
  await write(ledger, state);
  const config: SemanticPhaseConfig = { phaseId, model: SEMANTIC_MODEL, endpoint: SEMANTIC_ENDPOINT, parameters: SEMANTIC_PARAMETERS,
    maxAttempts: profile.maxAttempts, phaseLimitMicros: profile.phaseLimitMicros, sharedLimitMicros: 10_000_000, reservationMicros: 3_700_000, inputLimit: 32768,
    promptSha256: semanticHash('offline synthetic system'), inputHashes: Object.fromEntries((phaseId === SEMANTIC_PHASE ? [...semanticOrder, 'closure:expanded'] : ['raw-only']).map(id => [id, semanticInputHash(input)])),
    artifactPins: Object.fromEntries(old.map(path => [path, pins[path]!])), sourcePins: { [source]: pins[source]! },
    priorBudget: { count: state.entries.length, entriesSha256: semanticHash(JSON.stringify(state.entries)) }, cases: profile.order.map(id => ({ id, maxAttempts: id === 'closure' ? 2 : 1 })) };
  const publish = async (approved = true) => {
    if (phaseId === SEMANTIC_RECHECK_PHASE) { await write(`${profile.directory}/prior-budget.json`, state); config.artifactPins[`${profile.directory}/prior-budget.json`] = semanticHash(await readFile(join(root, profile.directory, 'prior-budget.json'))); }
    await write(`${profile.directory}/config.json`, config);
    const configSha256 = semanticHash(await readFile(join(root, profile.directory, 'config.json')));
    if (phaseId === SEMANTIC_RECHECK_PHASE && approved) await write(`${profile.directory}/authorization.json`, { status: 'approved', phase_id: phaseId, config_sha256: configSha256,
      executor: 'W0-I', max_attempts: 1, phase_limit_micros: 4_000_000, active_shared_limit_micros: 10_000_000, testOnly: 'Simulated permission in a disposable test root,not user authorization' });
    await write('docs/agent/blackboard/CURRENT.json', { publication_pending: false, semantic_model_evaluation: { status: approved ? 'approved_for_bounded_evaluation' : 'offline_only',
      phase_id: phaseId, config_sha256: configSha256, executor: 'W0-I', authorization_record: phaseId === SEMANTIC_RECHECK_PHASE ? `${profile.directory}/authorization.json` : 'Test-owned simulated authorization; not user/model evidence' } });
  };
  await publish();
  return { root, write, read, config, state, publish, source, old, profile };
}
const signal = () => new AbortController().signal;
function transport(usage: unknown, onPost = () => {}) {
  return new ProviderTransport(async () => { onPost(); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage }), { headers: { 'x-request-id': 'controlled-request' } }); });
}
async function attempt(session: Awaited<ReturnType<typeof beginSemanticCase>>, config: SemanticPhaseConfig, usage: unknown, getKey = () => 'test-only', bodyInput = input) {
  const endpoint = await session.prepareAttempt(bodyInput, config.promptSha256, 2300, getKey);
  return transport(usage).request(endpoint, bodyInput.scope, 'memory_turn', { messages: [], ...SEMANTIC_PARAMETERS }, signal());
}

test('semantic phase rejects missing approval, STOPPED and source/config drift without changing its ledger', async t => {
  const h = await phaseHarness(t), before = await readFile(join(h.root, ledger));
  await h.publish(false); await assert.rejects(beginSemanticCase(h.root, 'semantic-unauthorized', signal()), /not authorized/);
  await h.publish(); await h.write(`${SEMANTIC_DIRECTORY}/STOPPED.json`, { synthetic: true });
  await assert.rejects(beginSemanticCase(h.root, 'semantic-stopped', signal()), /stopped/);
  await rm(join(h.root, SEMANTIC_DIRECTORY, 'STOPPED.json'));
  await h.write(h.source, { altered: true }); await assert.rejects(beginSemanticCase(h.root, 'semantic-drift', signal()), /changed/);
  assert.deepEqual(await readFile(join(h.root, ledger)), before);
  await assert.rejects(access(join(h.root, SEMANTIC_DIRECTORY, 'claims')));
});

test('semantic cost uses peak rates and rejects malformed or inconsistent usage', () => {
  assert.equal(semanticPeakEstimate({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }), 210);
  for (const usage of [null, {}, { prompt_tokens: '10', completion_tokens: 2 }, { prompt_tokens: -1, completion_tokens: 2 },
    { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 15 }]) assert.equal(semanticPeakEstimate(usage), null);
});

test('one semantic call is reserved once and settled; an unreviewed case cannot advance or retry', async t => {
  const h = await phaseHarness(t), s = await beginSemanticCase(h.root, 'semantic-first', signal());
  assert.equal(s.caseId, 'raw-only'); let keys = 0;
  await attempt(s, h.config, { prompt_tokens: 10, completion_tokens: 20 }, () => { keys++; return 'test-only'; });
  assert.equal(keys, 1);
  await assert.rejects(s.prepareAttempt(input, h.config.promptSha256, 2300, () => { keys++; return 'test-only'; }));
  assert.equal(keys, 1); await s.finish(true);
  const state = await h.read(ledger); assert.deepEqual(state.entries[0], h.state.entries[0]);
  assert.equal(state.entries.length, 2); assert.equal(state.entries[1].reservedMicros, 3_700_000); assert.equal(state.entries[1].actualMicros, 210);
  await assert.rejects(beginSemanticCase(h.root, 'semantic-unreviewed', signal()), /claimed/);
});

test('unknown usage retains its full reservation and permanently stops the new phase', async t => {
  const h = await phaseHarness(t), s = await beginSemanticCase(h.root, 'semantic-unknown', signal());
  try { await assert.rejects(attempt(s, h.config, null), /phase stopped/); } finally { await s.finish(false); }
  const state = await h.read(ledger); assert.equal(state.entries[1].actualMicros, null); assert.equal(state.entries[1].status, 'unknown'); assert.equal(state.entries[1].reservedMicros, 3_700_000);
  await assert.rejects(beginSemanticCase(h.root, 'semantic-after-failure', signal()), /stopped/);
  for (const path of h.old) assert.equal(semanticHash(await readFile(join(h.root, path))), h.config.artifactPins[path]);
});

test('input mismatch and cancellation reject before the credential callback and budget reservation', async t => {
  const h = await phaseHarness(t), controller = new AbortController(), s = await beginSemanticCase(h.root, 'semantic-input', controller.signal);
  let keys = 0; const before = await readFile(join(h.root, ledger));
  try {
    await assert.rejects(attempt(s, h.config, {}, () => { keys++; return 'test-only'; }, { ...input, currentMessageId: 'other' }), /pinned original/);
    controller.abort(); await assert.rejects(s.prepareAttempt(input, h.config.promptSha256, 2300, () => { keys++; return 'test-only'; }));
    assert.equal(keys, 0); assert.deepEqual(await readFile(join(h.root, ledger)), before);
  } finally { await s.finish(false); }
});

test('both budget limits reject before a claim; old entries and unresolved calls cannot be reset', async t => {
  const h = await phaseHarness(t);
  h.state.entries[0]!.actualMicros = 6_500_000; h.state.entries[0]!.reservedMicros = 7_000_000;
  h.config.priorBudget.entriesSha256 = semanticHash(JSON.stringify(h.state.entries)); await h.write(ledger, h.state); await h.publish();
  await assert.rejects(beginSemanticCase(h.root, 'semantic-total-budget', signal()), /Shared budget/);
  h.state.entries[0]!.actualMicros = 276_594; h.state.entries[0]!.reservedMicros = 300_000;
  h.config.priorBudget.entriesSha256 = semanticHash(JSON.stringify(h.state.entries));
  h.state.entries.push({ operationId: `${SEMANTIC_PHASE}:raw-only:synthetic:1`, model: SEMANTIC_MODEL, reservedMicros: 3_700_000, actualMicros: 1_400_000, status: 'settled' });
  await h.write(ledger, h.state); await h.publish(); await assert.rejects(beginSemanticCase(h.root, 'semantic-phase-budget', signal()), /Phase budget/);
  h.state.entries[0]!.actualMicros = 0; await h.write(ledger, h.state); await assert.rejects(loadSemanticPhase(h.root).then(() => beginSemanticCase(h.root, 'semantic-prior-changed', signal())), /Previous shared ledger/);
});

test('actual evaluator entry refuses before credential, fetch and ledger write when paid approval is absent', async t => {
  const h = await phaseHarness(t), before = await readFile(join(h.root, ledger)); await h.publish(false);
  let keys = 0, posts = 0; const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { posts++; throw Error('No external fetch allowed in this test'); };
  try { await assert.rejects(evaluateMemorySemantics(h.root, 'semantic-denied', () => { keys++; return 'test-only'; }, signal()), /not authorized/); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(keys, 0); assert.equal(posts, 0); assert.deepEqual(await readFile(join(h.root, ledger)), before);
});

test('recheck rejects unknown identities, other-phase approval and altered configuration before key, fetch or run creation', async t => {
  assert.throws(() => semanticPhaseProfile('arbitrary-new-phase' as SemanticPhaseId), /Unknown semantic phase/);
  const mutations: [string, (h: Awaited<ReturnType<typeof phaseHarness>>) => Promise<void>, RegExp][] = [
    ['unapproved', h => h.publish(false), /not authorized/],
    ['wrong board phase', async h => { const board = await h.read('docs/agent/blackboard/CURRENT.json'); board.semantic_model_evaluation.phase_id = SEMANTIC_PHASE; await h.write('docs/agent/blackboard/CURRENT.json', board); }, /Blackboard phase/],
    ['wrong approval phase', async h => { const path = `${h.profile.directory}/authorization.json`, approval = await h.read(path); approval.phase_id = SEMANTIC_PHASE; await h.write(path, approval); }, /Approval belongs/],
    ['wrong approved fingerprint', async h => { const board = await h.read('docs/agent/blackboard/CURRENT.json'); board.semantic_model_evaluation.config_sha256 = '0'.repeat(64); await h.write('docs/agent/blackboard/CURRENT.json', board); }, /fingerprint differs/],
    ['wrong config phase', async h => { h.config.phaseId = SEMANTIC_PHASE; await h.publish(); }, /Configuration belongs/],
    ['extra attempts', async h => { h.config.maxAttempts = 6; await h.publish(); }, /Phase attempt limit differs/],
    ['larger phase budget', async h => { h.config.phaseLimitMicros = 5_000_000; await h.publish(); }, /Phase budget differs/],
  ];
  for (const [name, mutate, message] of mutations) {
    const h = await phaseHarness(t, SEMANTIC_RECHECK_PHASE), before = await readFile(join(h.root, ledger)); await mutate(h);
    let keys = 0, posts = 0; const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { posts++; throw Error('Unexpected actual network'); };
    try { await assert.rejects(evaluateMemorySemantics(h.root, 'semantic-recheck-denied', () => { keys++; return 'test-only'; }, signal(), SEMANTIC_RECHECK_PHASE), message, name); }
    finally { globalThis.fetch = originalFetch; }
    assert.equal(keys, 0, name); assert.equal(posts, 0, name); assert.deepEqual(await readFile(join(h.root, ledger)), before, name);
    await assert.rejects(access(join(h.root, h.profile.directory, 'claims'))); await assert.rejects(access(join(h.root, h.profile.directory, 'runs')));
  }
});

test('recheck has one exclusive attempt, preserves 117 prior entries and never advances after a reviewed success', async t => {
  const h = await phaseHarness(t, SEMANTIC_RECHECK_PHASE);
  await assert.rejects(loadSemanticPhase(h.root), /stopped/); // The original default cannot become the new phase.
  const runId = 'semantic-recheck-one', s = await beginSemanticCase(h.root, runId, signal(), SEMANTIC_RECHECK_PHASE);
  assert.equal(s.caseId, 'raw-only'); assert.equal(s.phaseId, SEMANTIC_RECHECK_PHASE);
  await assert.rejects(beginSemanticCase(h.root, 'semantic-racing-claim', signal(), SEMANTIC_RECHECK_PHASE), /claimed/);
  let keys = 0; await attempt(s, h.config, { prompt_tokens: 10, completion_tokens: 20 }, () => { keys++; return 'test-only'; });
  await assert.rejects(s.prepareAttempt(input, h.config.promptSha256, 2300, () => { keys++; return 'test-only'; })); assert.equal(keys, 1);
  await s.finish(true);
  const state = await h.read(ledger); assert.deepEqual(state.entries.slice(0, 117), h.state.entries); assert.equal(state.entries.length, 118);
  assert.equal(state.entries[117].reservedMicros, 3_700_000); assert.equal(state.entries[117].actualMicros, 210);
  assert.ok(state.entries[117].operationId.startsWith(`${SEMANTIC_RECHECK_PHASE}:raw-only:`));
  await assert.rejects(beginSemanticCase(h.root, 'semantic-unreviewed-retry', signal(), SEMANTIC_RECHECK_PHASE), /claimed/);
  const path = `${h.profile.directory}/runs/${runId}`, configSha256 = semanticHash(await readFile(join(h.root, h.profile.directory, 'config.json')));
  // Test-owned review metadata exercises the one-case boundary; it is not actual model/SQLite evidence.
  await h.write(`${path}/manifest.json`, { phaseId: SEMANTIC_RECHECK_PHASE, configSha256, caseId: 'raw-only', model: SEMANTIC_MODEL, origin: 'real_provider', attempts: 1, passed: true, testOnly: true });
  await h.write(`${path}/result.json`, { id: 'raw-only', passed: true, testOnly: true });
  await h.write(`${path}/attempts.json`, { testOnly: true }); await h.write(`${path}/state.sqlite`, { testOnly: 'Review hash fixture,not a database result' });
  const fingerprints = Object.fromEntries(await Promise.all(['manifest.json', 'result.json', 'attempts.json', 'state.sqlite'].map(async name => [name, semanticHash(await readFile(join(h.root, path, name)))])));
  await h.write(`${h.profile.directory}/reviews.json`, [{ caseId: 'raw-only', runId, reviewedBy: 'W0-I', passed: true, fingerprints }]);
  await assert.rejects(beginSemanticCase(h.root, 'semantic-no-next-case', signal(), SEMANTIC_RECHECK_PHASE), /already been reviewed/);
  assert.deepEqual(await h.read(ledger), state); await assert.rejects(loadSemanticPhase(h.root), /stopped/);
});

test('recheck failure keeps the full reservation and stops only its own phase without changing prior evidence', async t => {
  const h = await phaseHarness(t, SEMANTIC_RECHECK_PHASE), s = await beginSemanticCase(h.root, 'semantic-recheck-failure', signal(), SEMANTIC_RECHECK_PHASE);
  try { await assert.rejects(attempt(s, h.config, null), /phase stopped/); } finally { await s.finish(false); }
  const state = await h.read(ledger); assert.deepEqual(state.entries.slice(0, 117), h.state.entries);
  assert.equal(state.entries[117].status, 'unknown'); assert.equal(state.entries[117].reservedMicros, 3_700_000); assert.equal(state.entries[117].actualMicros, null);
  const stopped = await h.read(`${h.profile.directory}/STOPPED.json`); assert.equal(stopped.phaseId, SEMANTIC_RECHECK_PHASE); assert.equal(stopped.attempts, 1);
  await assert.rejects(beginSemanticCase(h.root, 'semantic-recheck-after-failure', signal(), SEMANTIC_RECHECK_PHASE), /stopped/);
  for (const path of h.old) assert.equal(semanticHash(await readFile(join(h.root, path))), h.config.artifactPins[path]);
  await assert.rejects(access(join(h.root, '.local/model-evaluation/backend.lock')));
});

test('recheck shared funds and prior-snapshot disagreement reject before claim or ledger transaction', async t => {
  const h = await phaseHarness(t, SEMANTIC_RECHECK_PHASE);
  h.state.entries[0]!.actualMicros = 6_500_000; h.state.entries[0]!.reservedMicros = 7_000_000;
  h.config.priorBudget.entriesSha256 = semanticHash(JSON.stringify(h.state.entries)); await h.write(ledger, h.state); await h.publish();
  const before = await readFile(join(h.root, ledger));
  await assert.rejects(beginSemanticCase(h.root, 'semantic-recheck-no-funds', signal(), SEMANTIC_RECHECK_PHASE), /Shared budget/);
  await assert.rejects(access(join(h.root, h.profile.directory, 'claims')));
  h.config.priorBudget.entriesSha256 = '0'.repeat(64); await h.publish();
  await assert.rejects(beginSemanticCase(h.root, 'semantic-recheck-bad-prior', signal(), SEMANTIC_RECHECK_PHASE), /snapshot differs/);
  assert.deepEqual(await readFile(join(h.root, ledger)), before);
});

test('recheck cancellation and frozen-source drift stop before credential or budget access', async t => {
  for (const kind of ['cancel', 'source'] as const) {
    const h = await phaseHarness(t, SEMANTIC_RECHECK_PHASE), controller = new AbortController();
    const s = await beginSemanticCase(h.root, `semantic-recheck-${kind}`, controller.signal, SEMANTIC_RECHECK_PHASE), before = await readFile(join(h.root, ledger));
    let keys = 0;
    if (kind === 'cancel') controller.abort(); else await h.write(h.source, { changed: true });
    try { await assert.rejects(s.prepareAttempt(input, h.config.promptSha256, 2300, () => { keys++; return 'test-only'; })); }
    finally { await s.finish(false); }
    assert.equal(keys, 0); assert.deepEqual(await readFile(join(h.root, ledger)), before);
    assert.equal((await h.read(`${h.profile.directory}/STOPPED.json`)).phaseId, SEMANTIC_RECHECK_PHASE);
  }
});

async function batchHarness(t: TestContext) {
  const h = await phaseHarness(t, SEMANTIC_RECHECK_PHASE);
  const setup = async (id: SemanticBatchId, cases: SemanticPhaseConfig['cases'] = [{ id: 'raw-only', maxAttempts: 1 }]) => {
    const profile = semanticPhaseProfile(id), state: BudgetState = await h.read(ledger);
    state.limitMicros = 20_000_000; await h.write(ledger, state);
    const artifactPins: Record<string, string> = {};
    for (const path of profile.protectedPaths) {
      try { await access(join(h.root, path)); } catch { await h.write(path, { testOnly: true }); }
      artifactPins[path] = semanticHash(await readFile(join(h.root, path)));
    }
    await h.write(SEMANTIC_POLICY, { version: 1, status: 'approved', currency: 'CNY', executor: 'W0-I', coordinator: 'W0-C', project_total_limit_micros: 20_000_000, testOnly: 'Disposable authorization,not user evidence' });
    const policySha256 = semanticHash(await readFile(join(h.root, SEMANTIC_POLICY)));
    await h.write(`${SEMANTIC_BATCH_ROOT}/registrations/${id}.json`, { testOnly: true });
    const config: SemanticPhaseConfig = { ...h.config, phaseId: id, batchVersion: 1, policySha256, maxAttempts: cases.reduce((sum, item) => sum + item.maxAttempts, 0),
      phaseLimitMicros: 4_000_000, sharedLimitMicros: 20_000_000, cases, artifactPins,
      inputHashes: Object.fromEntries([...cases.map(item => item.id), ...(cases.some(item => item.id === 'closure') ? ['closure:expanded'] : [])].map(key => [key, semanticInputHash(input)])),
      priorBudget: { count: state.entries.length, entriesSha256: semanticHash(JSON.stringify(state.entries)) } };
    const publish = async () => {
      await h.write(`${profile.directory}/prior-budget.json`, state);
      await h.write(`${profile.directory}/requests.json`, { testOnly: true }); await h.write(`${profile.directory}/system.txt`, { testOnly: true });
      for (const path of [SEMANTIC_POLICY, `${SEMANTIC_BATCH_ROOT}/registrations/${id}.json`, ...['prior-budget.json', 'requests.json', 'system.txt'].map(name => `${profile.directory}/${name}`)]) config.artifactPins[path] = semanticHash(await readFile(join(h.root, path)));
      await h.write(`${profile.directory}/config.json`, config); const configSha256 = semanticHash(await readFile(join(h.root, profile.directory, 'config.json')));
      await h.write(`${profile.directory}/authorization.json`, { status: 'approved', phase_id: id, config_sha256: configSha256, executor: 'W0-I', coordinator: 'W0-C',
        max_attempts: config.maxAttempts, phase_limit_micros: config.phaseLimitMicros, active_shared_limit_micros: 20_000_000, project_policy: SEMANTIC_POLICY, project_policy_sha256: policySha256, order: cases.map(item => item.id), testOnly: true });
      await h.write('docs/agent/blackboard/CURRENT.json', { publication_pending: false,
        model_budget_policy: { status: 'approved', record: SEMANTIC_POLICY, sha256: policySha256, project_total_limit_micros: 20_000_000 },
        semantic_model_evaluation: { status: 'approved_for_bounded_evaluation', phase_id: id, config_sha256: configSha256, executor: 'W0-I', authorization_record: `${profile.directory}/authorization.json` } });
    };
    await publish(); return { ...h, profile, config, state, publish, setup };
  };
  // Deliberately use a different historical count from117/118 to verify dynamic prior snapshots.
  h.state.entries = h.state.entries.slice(0, 3); await h.write(ledger, h.state);
  return setup('memory-semantic-batch-20260909-01');
}

async function proHarness(t: TestContext) {
  const h = await batchHarness(t), format = buildMemorySemanticFormat(input);
  const baselineId = 'memory-semantic-batch-20260909-99', baselineDirectory = `${SEMANTIC_BATCH_ROOT}/${baselineId}`;
  const baseline = { id: 'raw-only', input: structuredClone(input), body: { ...format.body, model: SEMANTIC_MODEL }, requestSha256: '' };
  baseline.requestSha256 = semanticHash(JSON.stringify(baseline.body));
  await h.write(`${baselineDirectory}/requests.json`, [baseline]);
  const baselineRequestHash = semanticHash(await readFile(join(h.root, baselineDirectory, 'requests.json')));
  await h.write(`${baselineDirectory}/config.json`, { phaseId: baselineId, model: SEMANTIC_MODEL, parameters: SEMANTIC_PARAMETERS,
    promptSha256: semanticHash(format.system), artifactPins: { [`${baselineDirectory}/requests.json`]: baselineRequestHash } });
  const baselineConfigHash = semanticHash(await readFile(join(h.root, baselineDirectory, 'config.json')));
  const pricingPath = '.local/test-only-pro-pricing.json'; await h.write(pricingPath, { testOnly: 'Synthetic pricing binding;not official source evidence' });
  const pricingHash = semanticHash(await readFile(join(h.root, pricingPath)));
  Object.assign(h.config, { batchVersion: 2, model: SEMANTIC_PRO_MODEL, reservationMicros: 11_000_000, phaseLimitMicros: 12_000_000,
    promptSha256: semanticHash(format.system), comparison: { phaseId: baselineId, configSha256: baselineConfigHash, requestSha256: baseline.requestSha256 }, pricingEvidence: { path: pricingPath, sha256: pricingHash } });
  Object.assign(h.config.artifactPins, { [`${baselineDirectory}/config.json`]: baselineConfigHash, [`${baselineDirectory}/requests.json`]: baselineRequestHash, [pricingPath]: pricingHash });
  const request = { ...baseline, input: structuredClone(input), body: { ...structuredClone(format.body), model: SEMANTIC_PRO_MODEL }, requestSha256: '' };
  const publish = async () => {
    await h.write(`${h.profile.directory}/prior-budget.json`, h.state);
    request.requestSha256 = semanticHash(JSON.stringify(request.body));
    await h.write(`${h.profile.directory}/requests.json`, [request]); await h.write(`${h.profile.directory}/system.txt`, format.system);
    for (const name of ['prior-budget.json', 'requests.json', 'system.txt']) h.config.artifactPins[`${h.profile.directory}/${name}`] = semanticHash(await readFile(join(h.root, h.profile.directory, name)));
    await h.write(`${h.profile.directory}/config.json`, h.config); const hash = semanticHash(await readFile(join(h.root, h.profile.directory, 'config.json')));
    const approval = await h.read(`${h.profile.directory}/authorization.json`); Object.assign(approval, { config_sha256: hash, phase_limit_micros: h.config.phaseLimitMicros });
    await h.write(`${h.profile.directory}/authorization.json`, approval);
    const board = await h.read('docs/agent/blackboard/CURRENT.json'); board.semantic_model_evaluation.config_sha256 = hash; await h.write('docs/agent/blackboard/CURRENT.json', board);
  };
  await publish(); return { ...h, publish, request, baseline };
}

async function thinkingHarness(t: TestContext) {
  const h = await proHarness(t), format = buildMemorySemanticFormat(input);
  const comparison = h.config.comparison!, directory = `${SEMANTIC_BATCH_ROOT}/${comparison.phaseId}`;
  const baseline = { ...h.baseline, body: { ...format.body, model: SEMANTIC_PRO_MODEL }, requestSha256: '' };
  baseline.requestSha256 = semanticHash(JSON.stringify(baseline.body));
  await h.write(`${directory}/requests.json`, [baseline]);
  const requestHash = semanticHash(await readFile(join(h.root, directory, 'requests.json')));
  const baselineConfig = await h.read(`${directory}/config.json`);
  Object.assign(baselineConfig, { model: SEMANTIC_PRO_MODEL, artifactPins: { [`${directory}/requests.json`]: requestHash } });
  await h.write(`${directory}/config.json`, baselineConfig);
  comparison.configSha256 = semanticHash(await readFile(join(h.root, directory, 'config.json'))); comparison.requestSha256 = baseline.requestSha256;
  Object.assign(h.config.artifactPins, { [`${directory}/config.json`]: comparison.configSha256, [`${directory}/requests.json`]: requestHash });
  Object.assign(h.config, { batchVersion: 3, parameters: structuredClone(SEMANTIC_THINKING_PARAMETERS) });
  h.request.body = { ...buildSemanticRequestBody(format, 'high'), model: SEMANTIC_PRO_MODEL };
  await h.publish(); return { ...h, baseline };
}

test('thinking comparison permits only the two official mode fields and preserves all default request bytes', () => {
  const format = buildMemorySemanticFormat(input), baseline = { ...format.body, model: SEMANTIC_PRO_MODEL };
  for (const model of [SEMANTIC_MODEL, SEMANTIC_PRO_MODEL]) assert.equal(JSON.stringify({ ...buildSemanticRequestBody(format), model }), JSON.stringify({ ...format.body, model }));
  const high = { ...buildSemanticRequestBody(format, 'high'), model: SEMANTIC_PRO_MODEL };
  assertSemanticThinkingOnlyRequest(baseline, high);
  for (const mutate of [
    (x: any) => { x.model = SEMANTIC_MODEL; }, (x: any) => { x.thinking.type = 'disabled'; },
    (x: any) => { x.reasoning_effort = 'max'; }, (x: any) => { delete x.reasoning_effort; },
    (x: any) => { x.messages[0].content += ' '; }, (x: any) => { x.messages[1].content += ' '; },
    (x: any) => { x.max_tokens = 256; }, (x: any) => { x.stream = true; }, (x: any) => { delete x.response_format; },
  ]) { const bad = structuredClone(high); mutate(bad); assert.throws(() => assertSemanticThinkingOnlyRequest(baseline, bad)); }
  assert.throws(() => buildSemanticRequestBody(format, 'invented' as 'high'), /Unknown/);
  assert.deepEqual(baseline, { ...buildMemorySemanticFormat(input).body, model: SEMANTIC_PRO_MODEL });
});

test('thinking adapter uses identical evidence and POST bytes; invalid modes and cancellation cannot reopen credentials', async () => {
  const format = buildMemorySemanticFormat(input), answer = { request: 'none', erase: [], facts: [], assessments: [], reason: 'No memory request', unresolved: null };
  const record: MemoryRecord = { characterId: 'companion', id: 'current', kind: 'transcript', state: 'active', version: 1, text: 'hello', sources: [],
    createdAt: input.sources[0]!.createdAt, deletedAt: null, reason: null, perception: null, evidenceEligible: true, fragment: null, logicalOrder: 1, message: input.messages[0]! };
  for (const mode of ['disabled', 'high', 'invalid', 'cancel-request', 'cancel-response', 'cancel-compiled'] as const) {
    const controller = new AbortController(), events: SemanticAttemptEvent[] = []; let keys = 0, posts = 0;
    const run = runMemorySemanticAttempt({ snapshot: prototypeSnapshot(input, [record]), config: { endpoint: SEMANTIC_ENDPOINT, model: SEMANTIC_PRO_MODEL,
      apiKey: () => { keys++; return 'controlled-only'; }, authorizer: { async authorize() { return { async settle() {} }; } } },
      ...(mode === 'disabled' ? {} : { reasoningEffort: (mode === 'invalid' ? 'invalid' : 'high') as 'high' }),
      transport: new ProviderTransport(async (_url, init) => {
        posts++; const request = events.find(e => e.type === 'request')!.data as any;
        assert.equal(init?.body, request.requestJson); assert.equal(semanticHash(String(init?.body)), request.requestSha256);
        assert.deepEqual(JSON.parse(String(init?.body)), { ...buildSemanticRequestBody(format, mode === 'disabled' ? undefined : 'high'), model: SEMANTIC_PRO_MODEL });
        assert.equal(request.requestBodyBytes, Buffer.byteLength(JSON.stringify(request.body)));
        return Response.json({ model: SEMANTIC_PRO_MODEL, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer), reasoning_content: 'Controlled reasoning fixture' } }], usage: { prompt_tokens: 10, completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 100 } } });
      }), provenance: { kind: 'controlled_stub', runId: `thinking-${mode}`, attemptId: '1' }, signal: controller.signal,
      evidence: async e => { events.push(e); if (mode === `cancel-${e.type}`) controller.abort(); },
    });
    if (mode === 'high' || mode === 'disabled') assert.equal((await run).compiled.status, 'ready');
    else await assert.rejects(run);
    assert.equal(keys, mode === 'invalid' || mode === 'cancel-request' ? 0 : 1); assert.equal(posts, keys);
    if (mode === 'invalid') assert.deepEqual(events.map(e => e.type), ['failure']);
  }
});

test('thinking frozen gates reject changed mode, baseline, input, pricing or version before credential and claim', async t => {
  for (const mode of ['valid', 'parameter', 'request-mode', 'effort', 'baseline', 'input', 'pricing', 'version'] as const) {
    const h = await thinkingHarness(t), before = await readFile(join(h.root, ledger));
    if (mode === 'parameter') h.config.parameters = SEMANTIC_PARAMETERS;
    if (mode === 'request-mode') (h.request.body as any).thinking.type = 'disabled';
    if (mode === 'effort') (h.request.body as any).reasoning_effort = 'max';
    if (mode === 'baseline') h.config.comparison!.configSha256 = '0'.repeat(64);
    if (mode === 'input') h.request.input = { ...h.request.input, currentMessageId: 'changed' };
    if (mode === 'pricing') h.config.pricingEvidence!.sha256 = '0'.repeat(64);
    if (mode === 'version') h.config.batchVersion = 2;
    await h.publish(); let keys = 0;
    if (mode === 'valid') assert.equal((await loadSemanticPhase(h.root, true, h.profile.phaseId)).config.batchVersion, 3);
    else await assert.rejects(evaluateMemorySemantics(h.root, 'semantic-thinking-denied', () => { keys++; throw Error('No key'); }, signal(), h.profile.phaseId));
    assert.equal(keys, 0); assert.deepEqual(await readFile(join(h.root, ledger)), before); await assert.rejects(access(join(h.root, h.profile.directory, 'claims')));
  }
});

test('thinking cost charges all completion tokens once and validates the optional reasoning breakdown', () => {
  const usage = { prompt_tokens: 10, completion_tokens: 120, total_tokens: 130, completion_tokens_details: { reasoning_tokens: 100 } };
  assert.equal(semanticPeakEstimate(usage, SEMANTIC_PRO_MODEL, true), 3330);
  assert.equal(semanticPeakEstimate({ prompt_tokens: 32768, completion_tokens: 393216, completion_tokens_details: { reasoning_tokens: 393216 } }, SEMANTIC_PRO_MODEL, true), 10_911_744);
  assert.equal(semanticPeakEstimate({ prompt_tokens: 10, completion_tokens: 120 }, SEMANTIC_PRO_MODEL, true), 3330);
  for (const details of [null, [], { reasoning_tokens: -1 }, { reasoning_tokens: 121 }, { reasoning_tokens: 0.5 }, { reasoning_tokens: '100' }]) {
    assert.equal(semanticPeakEstimate({ ...usage, completion_tokens_details: details }, SEMANTIC_PRO_MODEL, true), null);
  }
});

test('thinking reserves11 before transport and settles total reasoning plus visible output; malformed usage stops without retry', async t => {
  for (const malformed of [false, true]) {
    const h = await thinkingHarness(t), s = await beginSemanticCase(h.root, 'semantic-thinking-cost', signal(), h.profile.phaseId); let posts = 0, keys = 0;
    try {
      const endpoint = await s.prepareAttempt(input, h.config.promptSha256, 2300, () => { keys++; return 'controlled-only'; });
      const transport = new ProviderTransport(async (_url, init) => {
        posts++; assert.deepEqual(JSON.parse(String(init?.body)), h.request.body);
        const b = await h.read(ledger); assert.equal(b.entries.at(-1).reservedMicros, 11_000_000); assert.equal(b.entries.at(-1).status, 'reserved');
        return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 120, completion_tokens_details: { reasoning_tokens: malformed ? 121 : 100 } } });
      });
      const run = transport.request(endpoint, input.scope, 'memory_turn', buildSemanticRequestBody(buildMemorySemanticFormat(input), 'high'), signal());
      if (malformed) await assert.rejects(run, /phase stopped/); else await run;
    } finally { await s.finish(false); }
    assert.equal(posts, 1); assert.equal(keys, 1); const b = await h.read(ledger);
    assert.deepEqual(b.entries.slice(0, h.state.entries.length), h.state.entries);
    assert.equal(b.entries.at(-1).status, malformed ? 'unknown' : 'settled'); assert.equal(b.entries.at(-1).actualMicros, malformed ? null : 3330);
    const after = await readFile(join(h.root, ledger)); await assert.rejects(beginSemanticCase(h.root, 'semantic-thinking-retry', signal(), h.profile.phaseId), /stopped/); assert.deepEqual(await readFile(join(h.root, ledger)), after);
  }
});

test('Pro uses official peak bounds while legacy Flash estimates stay unchanged', () => {
  assert.equal(semanticPeakEstimate({ prompt_tokens: 10, completion_tokens: 20 }), 210);
  assert.equal(semanticPeakEstimate({ prompt_tokens: 10, completion_tokens: 20 }, SEMANTIC_PRO_MODEL), 630);
  assert.equal(semanticPeakEstimate({ prompt_tokens: 32768, completion_tokens: 393216 }, SEMANTIC_PRO_MODEL), 10_911_744);
  assert.equal(semanticModelProfile(SEMANTIC_PRO_MODEL).reservationMicros, 11_000_000);
  assert.ok(Object.isFrozen(semanticModelProfile(SEMANTIC_PRO_MODEL)));
  assert.equal(semanticPeakEstimate({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 9 }, SEMANTIC_PRO_MODEL), null);
  assert.throws(() => semanticModelProfile('invented' as typeof SEMANTIC_MODEL), /Unknown/);
});

test('Pro comparison rejects any request difference besides model, including omitted or changed parameters', () => {
  const baseline = { ...buildMemorySemanticFormat(input).body, model: SEMANTIC_MODEL };
  const valid = { ...structuredClone(baseline), model: SEMANTIC_PRO_MODEL };
  assertSemanticModelOnlyRequest(baseline, valid);
  const mutations = [
    (x: any) => { x.messages[0].content += ' '; }, (x: any) => { x.messages[1].content += ' '; },
    (x: any) => { x.thinking.type = 'enabled'; }, (x: any) => { x.stream = true; },
    (x: any) => { delete x.response_format; }, (x: any) => { x.max_tokens = 256; },
    (x: any) => { x.model = SEMANTIC_MODEL; }, (x: any) => { x.model = 'unknown'; },
  ];
  for (const mutate of mutations) { const bad = structuredClone(valid); mutate(bad); assert.throws(() => assertSemanticModelOnlyRequest(baseline, bad)); }
  assert.deepEqual(baseline, { ...buildMemorySemanticFormat(input).body, model: SEMANTIC_MODEL });
});

test('Pro frozen configuration validates comparison, pricing, model and full original input before claims', async t => {
  for (const kind of ['valid', 'flash', 'reservation', 'phase', 'pricing', 'baseline', 'system', 'input', 'parameters'] as const) {
    const h = await proHarness(t), before = await readFile(join(h.root, ledger));
    if (kind === 'flash') h.config.model = SEMANTIC_MODEL;
    if (kind === 'reservation') h.config.reservationMicros = 3_700_000;
    if (kind === 'phase') h.config.phaseLimitMicros = 4_000_000;
    if (kind === 'pricing') h.config.pricingEvidence!.sha256 = '0'.repeat(64);
    if (kind === 'baseline') h.config.comparison!.configSha256 = '0'.repeat(64);
    if (kind === 'system') (h.request.body as any).messages[0].content += ' changed';
    if (kind === 'input') h.request.input = { ...h.request.input, currentMessageId: 'another' };
    if (kind === 'parameters') Object.assign(h.request.body, { max_tokens: 256 });
    await h.publish(); let keys = 0, posts = 0;
    if (kind === 'valid') assert.equal((await loadSemanticPhase(h.root, true, h.profile.phaseId)).config.model, SEMANTIC_PRO_MODEL);
    else {
      const originalFetch = globalThis.fetch; globalThis.fetch = async () => { posts++; throw Error('No real network'); };
      try { await assert.rejects(evaluateMemorySemantics(h.root, 'semantic-pro-denied', () => { keys++; return 'test-only'; }, signal(), h.profile.phaseId)); }
      finally { globalThis.fetch = originalFetch; }
    }
    assert.equal(keys, 0); assert.equal(posts, 0); assert.deepEqual(await readFile(join(h.root, ledger)), before);
    await assert.rejects(access(join(h.root, h.profile.directory, 'claims')));
  }
});

test('Pro sends the selected model, reserves11 before transport, settles its own rate and refuses reuse', async t => {
  const h = await proHarness(t), s = await beginSemanticCase(h.root, 'semantic-pro-single', signal(), h.profile.phaseId); let keys = 0, posts = 0;
  try {
    const endpoint = await s.prepareAttempt(input, h.config.promptSha256, 2300, () => { keys++; return 'test-only'; });
    const transport = new ProviderTransport(async (_url, init) => {
      posts++; assert.equal(JSON.parse(String(init?.body)).model, SEMANTIC_PRO_MODEL);
      const b = await h.read(ledger); assert.deepEqual(b.entries.slice(0, h.state.entries.length), h.state.entries);
      assert.equal(b.entries.at(-1).model, SEMANTIC_PRO_MODEL); assert.equal(b.entries.at(-1).reservedMicros, 11_000_000); assert.equal(b.entries.at(-1).status, 'reserved');
      return Response.json({ model: SEMANTIC_PRO_MODEL, choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    });
    await transport.request(endpoint, input.scope, 'memory_turn', buildMemorySemanticFormat(input).body, signal());
    await assert.rejects(s.prepareAttempt(input, h.config.promptSha256, 2300, () => { keys++; return 'test-only'; }));
  } finally { await s.finish(false); }
  assert.equal(keys, 1); assert.equal(posts, 1);
  const b = await h.read(ledger); assert.equal(b.entries.at(-1).actualMicros, 630); assert.equal(b.entries.at(-1).status, 'settled');
  const before = await readFile(join(h.root, ledger)); await assert.rejects(beginSemanticCase(h.root, 'semantic-pro-retry', signal(), h.profile.phaseId), /stopped/);
  assert.deepEqual(await readFile(join(h.root, ledger)), before);
});

test('Pro unknown or excessive usage stops its batch and preserves cost instead of using Flash reservation', async t => {
  for (const usage of [null, { prompt_tokens: 10, completion_tokens: 393217 }, { prompt_tokens: 32769, completion_tokens: 0 }]) {
    const h = await proHarness(t), s = await beginSemanticCase(h.root, 'semantic-pro-usage', signal(), h.profile.phaseId);
    try { await assert.rejects(attempt(s, h.config, usage), /phase stopped/); } finally { await s.finish(false); }
    const b = await h.read(ledger); assert.equal(b.entries.at(-1).reservedMicros, 11_000_000);
    assert.equal(b.entries.at(-1).actualMicros, usage === null ? null : semanticPeakEstimate(usage, SEMANTIC_PRO_MODEL));
    assert.equal(b.entries.at(-1).status, usage === null ? 'unknown' : 'settled');
    await assert.rejects(beginSemanticCase(h.root, 'semantic-pro-stopped', signal(), h.profile.phaseId), /stopped/);
  }
});

test('Pro counts prior shared spending and rejects unknown cost, cancellation and input drift before credentials', async t => {
  for (const kind of ['funds', 'unknown', 'cancel', 'input'] as const) {
    const h = await proHarness(t), controller = new AbortController(); let keys = 0;
    if (kind === 'funds') { h.state.entries[0]!.actualMicros = 9_000_001; h.state.entries[0]!.reservedMicros = 10_000_000; }
    if (kind === 'unknown') { h.state.entries[0]!.actualMicros = null; h.state.entries[0]!.status = 'unknown'; }
    h.config.priorBudget.entriesSha256 = semanticHash(JSON.stringify(h.state.entries)); await h.write(ledger, h.state); await h.publish();
    const before = await readFile(join(h.root, ledger));
    if (kind === 'funds' || kind === 'unknown') await assert.rejects(beginSemanticCase(h.root, 'semantic-pro-budget', controller.signal, h.profile.phaseId));
    else {
      const s = await beginSemanticCase(h.root, 'semantic-pro-input', controller.signal, h.profile.phaseId);
      if (kind === 'cancel') controller.abort();
      try { await assert.rejects(s.prepareAttempt(kind === 'input' ? { ...input, currentMessageId: 'changed' } : input, h.config.promptSha256, 2300, () => { keys++; return 'test-only'; })); }
      finally { await s.finish(false); }
    }
    assert.equal(keys, 0); assert.deepEqual(await readFile(join(h.root, ledger)), before);
  }
});

test('registered batches reject unregistered preparation, identifiers, cases and frozen input/policy drift before any execution effects', async t => {
  for (const id of ['memory-semantic-batch-../../escape', 'memory-semantic-batch-20260909-x', '/tmp/phase']) assert.throws(() => semanticPhaseProfile(id as SemanticPhaseId), /Unknown/);
  const mutations: ((h: Awaited<ReturnType<typeof batchHarness>>) => Promise<void>)[] = [
    async h => { h.config.cases = []; await h.publish(); },
    async h => { h.config.cases = [{ id: 'unknown' as 'raw-only', maxAttempts: 1 }]; await h.publish(); },
    async h => { h.config.cases = [{ id: 'raw-only', maxAttempts: 1 }, { id: 'raw-only', maxAttempts: 1 }]; await h.publish(); },
    async h => { h.config.cases = [{ id: 'merge', maxAttempts: 1 }, { id: 'raw-only', maxAttempts: 1 }]; await h.publish(); },
    async h => { h.config.maxAttempts = 7; await h.publish(); },
    async h => { h.config.phaseLimitMicros = 20_000_001; await h.publish(); },
    async h => { h.config.sharedLimitMicros = 10_000_000; await h.publish(); },
    async h => { h.config.policySha256 = '0'.repeat(64); await h.publish(); },
    async h => { const b = await h.read('docs/agent/blackboard/CURRENT.json'); b.model_budget_policy.sha256 = '0'.repeat(64); await h.write('docs/agent/blackboard/CURRENT.json', b); },
    async h => { const b = await h.read('docs/agent/blackboard/CURRENT.json'); b.semantic_model_evaluation.config_sha256 = '0'.repeat(64); await h.write('docs/agent/blackboard/CURRENT.json', b); },
    async h => { const b = await h.read('docs/agent/blackboard/CURRENT.json'); b.semantic_model_evaluation.status = 'offline_only'; await h.write('docs/agent/blackboard/CURRENT.json', b); },
    ...['requests.json', 'prior-budget.json'].map(name => async (h: Awaited<ReturnType<typeof batchHarness>>) => { await h.write(`${h.profile.directory}/${name}`, { changed: true }); }),
    async h => { await h.write(h.source, { changed: true }); },
  ];
  for (const mutate of mutations) {
    const h = await batchHarness(t), before = await readFile(join(h.root, ledger)); await mutate(h);
    let keys = 0, posts = 0; const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => { posts++; throw Error('No actual network'); };
    try { await assert.rejects(evaluateMemorySemantics(h.root, 'semantic-denied', () => { keys++; return 'test-only'; }, signal(), h.profile.phaseId)); }
    finally { globalThis.fetch = oldFetch; }
    assert.equal(keys, 0); assert.equal(posts, 0); assert.deepEqual(await readFile(join(h.root, ledger)), before);
    await assert.rejects(access(join(h.root, h.profile.directory, 'claims'))); await assert.rejects(access(join(h.root, h.profile.directory, 'runs')));
  }
  const h = await batchHarness(t);
  await assert.rejects(prepareRegisteredSemanticBatch(h.root, 'memory-semantic-batch-20260909-02'));
  await assert.rejects(access(join(h.root, SEMANTIC_BATCH_ROOT, 'memory-semantic-batch-20260909-02')));
});

test('registered second batch reuses the same code, preserves prior batch cost and stops only its selected case', async t => {
  const h = await batchHarness(t), s = await beginSemanticCase(h.root, 'semantic-batch-first', signal(), h.profile.phaseId);
  await attempt(s, h.config, { prompt_tokens: 10, completion_tokens: 20 }); await s.finish(false);
  const oldStop = await readFile(join(h.root, h.profile.directory, 'STOPPED.json')), firstState = await h.read(ledger);
  await assert.rejects(beginSemanticCase(h.root, 'semantic-first-retry', signal(), h.profile.phaseId), /stopped/);
  const second = await h.setup('memory-semantic-batch-20260909-02', [{ id: 'merge', maxAttempts: 1 }]);
  assert.equal(second.config.priorBudget.count, 4);
  const next = await beginSemanticCase(h.root, 'semantic-batch-second', signal(), second.profile.phaseId); assert.equal(next.caseId, 'merge');
  await attempt(next, second.config, { prompt_tokens: 10, completion_tokens: 20 }); await next.finish(true);
  const final = await h.read(ledger); assert.deepEqual(final.entries.slice(0, 4), firstState.entries); assert.equal(final.entries.length, 5);
  await assert.rejects(beginSemanticCase(h.root, 'semantic-unreviewed-again', signal(), second.profile.phaseId), /claimed/);
  const configSha256 = semanticHash(await readFile(join(h.root, second.profile.directory, 'config.json'))), path = `${second.profile.directory}/runs/semantic-batch-second`;
  for (const name of ['attempts.json', 'state.sqlite']) await h.write(`${path}/${name}`, { testOnly: 'Review boundary fixture only' });
  await h.write(`${path}/manifest.json`, { phaseId: second.profile.phaseId, configSha256, caseId: 'merge', passed: true, origin: 'real_provider', model: SEMANTIC_MODEL, attempts: 1, testOnly: true });
  await h.write(`${path}/result.json`, { id: 'merge', passed: true, testOnly: true });
  const fingerprints = Object.fromEntries(await Promise.all(['attempts.json', 'state.sqlite', 'manifest.json', 'result.json'].map(async name => [name, semanticHash(await readFile(join(h.root, path, name)))])));
  await h.write(`${second.profile.directory}/reviews.json`, [{ caseId: 'merge', runId: 'semantic-batch-second', passed: true, reviewedBy: 'W0-I', fingerprints }]);
  await assert.rejects(beginSemanticCase(h.root, 'semantic-no-unselected-case', signal(), second.profile.phaseId), /already been reviewed/);
  await h.write(`${second.profile.directory}/COMPLETED.json`, { testOnly: true });
  await assert.rejects(loadSemanticPhase(h.root, true, second.profile.phaseId), /completed/);
  assert.deepEqual(await readFile(join(h.root, h.profile.directory, 'STOPPED.json')), oldStop);
});

test('registered shared20 counts historical cost and rejects unsettled or altered prior entries before claim', async t => {
  for (const mode of ['exhausted', 'reserved', 'unknown', 'changed'] as const) {
    const h = await batchHarness(t);
    if (mode === 'exhausted') { h.state.entries[0]!.actualMicros = 16_300_001; h.state.entries[0]!.reservedMicros = 17_000_000; }
    if (mode === 'reserved' || mode === 'unknown') { h.state.entries[0]!.status = mode; h.state.entries[0]!.actualMicros = null; h.state.entries[0]!.reservedMicros = 19_000_000; }
    h.config.priorBudget.entriesSha256 = semanticHash(JSON.stringify(h.state.entries)); await h.publish();
    if (mode === 'changed') h.state.entries[0]!.actualMicros = 1;
    await h.write(ledger, h.state); const before = await readFile(join(h.root, ledger));
    await assert.rejects(beginSemanticCase(h.root, 'semantic-budget-denied', signal(), h.profile.phaseId));
    assert.deepEqual(await readFile(join(h.root, ledger)), before); await assert.rejects(access(join(h.root, h.profile.directory, 'claims')));
  }
});

test('explicit10to20 migration preserves every entry and rejects locks, active batches, unsettled cost and wrong metadata', async t => {
  for (const mode of ['valid', 'backend-lock', 'budget-lock', 'active', 'unknown', 'wrong-limit', 'wrong-currency'] as const) {
    const h = await batchHarness(t), b = await h.read('docs/agent/blackboard/CURRENT.json');
    if (mode !== 'active') b.semantic_model_evaluation.status = 'stopped_after_declaration_compile_failure';
    await h.write('docs/agent/blackboard/CURRENT.json', b); h.state.limitMicros = mode === 'wrong-limit' ? 9_000_000 : 10_000_000;
    if (mode === 'unknown') { h.state.entries[0]!.status = 'unknown'; h.state.entries[0]!.actualMicros = null; }
    if (mode === 'wrong-currency') Object.assign(h.state, { currency: 'USD' });
    await h.write(ledger, h.state); const before = await readFile(join(h.root, ledger));
    if (mode === 'backend-lock') await h.write('.local/model-evaluation/backend.lock', { owner: 'test-other-writer' });
    if (mode === 'budget-lock') await h.write(`${ledger}.lock`, { owner: 'test-other-writer' });
    if (mode === 'valid') {
      await migrateSemanticBudget20(h.root); const after = await h.read(ledger);
      assert.deepEqual({ ...after, limitMicros: 10_000_000 }, h.state);
      assert.deepEqual(await readFile(join(h.root, '.local/model-evaluation/limit-20-v1/before.json')), before);
      await assert.rejects(migrateSemanticBudget20(h.root)); assert.deepEqual(await h.read(ledger), after);
    } else { await assert.rejects(migrateSemanticBudget20(h.root)); assert.deepEqual(await readFile(join(h.root, ledger)), before); }
  }
});

test('registered cancellation keeps credentials unread and unknown usage retains its reservation with a stopped batch', async t => {
  for (const mode of ['cancel', 'unknown'] as const) {
    const h = await batchHarness(t), controller = new AbortController(), before = await h.read(ledger);
    const s = await beginSemanticCase(h.root, `semantic-managed-${mode}`, controller.signal, h.profile.phaseId);
    let keys = 0;
    try {
      if (mode === 'cancel') {
        controller.abort(); await assert.rejects(s.prepareAttempt(input, h.config.promptSha256, 2300, () => { keys++; return 'test-only'; })); assert.equal(keys, 0);
      } else await assert.rejects(attempt(s, h.config, null), /phase stopped/);
    } finally { await s.finish(false); }
    const after = await h.read(ledger); assert.deepEqual(after.entries.slice(0, 3), before.entries);
    if (mode === 'unknown') { assert.equal(after.entries[3].status, 'unknown'); assert.equal(after.entries[3].actualMicros, null); assert.equal(after.entries[3].reservedMicros, 3_700_000); }
    else assert.deepEqual(after, before);
    await assert.rejects(loadSemanticPhase(h.root, true, h.profile.phaseId), /stopped/);
    await assert.rejects(access(join(h.root, '.local/model-evaluation/backend.lock')));
  }
});

const simpleFixture = (): SemanticFixture => {
  const record: MemoryRecord = { characterId: 'companion', id: 'current', kind: 'transcript', state: 'active', version: 1, text: 'hello', sources: [],
    createdAt: input.sources[0]!.createdAt, deletedAt: null, reason: null, perception: null, evidenceEligible: true, fragment: null, logicalOrder: 1, message: input.messages[0]! };
  return { id: 'clarification', input, records: [record], query: 'hello', expectClarification: true };
};
function clarification(): SemanticDeclaration {
  return { annotationSource: 'human_controlled', scope: input.scope, request: 'none', erase: [], facts: [], assessments: [], reason: 'Controlled runner check',
    unresolved: { question: 'Which fact?', basis: [{ source: { id: 'current', version: 1 }, quote: { text: 'hello' } }] } };
}
test('real SQLite runner keeps an explicit clarification read/compile/commit pure and records physical reopen separately', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'semantic-runner-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await runSemanticCase({ filename: join(dir, 'state.sqlite'), fixture: simpleFixture(), origin: 'controlled_stub', signal: signal(), countInput: () => 2300,
    async attempt(snapshot) { const declaration = clarification(); return { declaration, compiled: compileMemoryPrototype(snapshot, declaration, signal()) }; } });
  assert.equal(result.passed, true, JSON.stringify(result.error)); assert.equal(result.attempts, 1);
  assert.equal(result.unresolvedZeroTableWrites, true); assert.equal(result.consumedTicketRejectedWithoutWrite, true);
  assert.equal(result.wholeAcceptance, false); assert.equal(result.origin, 'controlled_stub'); assert.ok(result.reopen);
});

test('late cancellation prevents a valid compiled plan from writing and preserves the full failure checkpoint', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'semantic-runner-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const result = await runSemanticCase({ filename: join(dir, 'state.sqlite'), fixture: simpleFixture(), origin: 'controlled_stub', signal: controller.signal, countInput: () => 2300,
    async attempt(snapshot) { const declaration = clarification(), compiled = compileMemoryPrototype(snapshot, declaration, controller.signal); controller.abort(); return { declaration, compiled }; } });
  assert.equal(result.passed, false); assert.equal(result.attempts, 1); assert.equal(result.outcome, undefined);
  assert.deepEqual(result.finalWholeDatabase, result.wholeDatabaseBefore); assert.equal(result.allStoresClosed, true);
});

test('runner never treats needs_semantics as an invitation for another call', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'semantic-runner-test-')); t.after(() => rm(dir, { recursive: true, force: true })); let count = 0;
  const result = await runSemanticCase({ filename: join(dir, 'state.sqlite'), fixture: simpleFixture(), origin: 'controlled_stub', signal: signal(), countInput: () => 2300,
    async attempt() { count++; return { declaration: clarification(), compiled: { status: 'needs_semantics', sources: [{ id: 'current', version: 1 }] } }; } });
  assert.equal(count, 1); assert.equal(result.passed, false); assert.deepEqual(result.finalWholeDatabase, result.wholeDatabaseBefore);
});

test('fixed five-case sequence uses at most six attempts, requires closure expansion proof and fingerprinted reviews', async t => {
  const h = await phaseHarness(t), reviews: object[] = [];
  for (const [index, id] of semanticOrder.entries()) {
    const runId = `semantic-sequence-${index}`, s = await beginSemanticCase(h.root, runId, signal()); assert.equal(s.caseId, id);
    await attempt(s, h.config, { prompt_tokens: 10, completion_tokens: 20 });
    if (id === 'closure') {
      let keys = 0;
      await assert.rejects(s.prepareAttempt(input, h.config.promptSha256, 2300, () => { keys++; return 'test-only'; })); assert.equal(keys, 0);
      const config = await s.prepareAttempt(input, h.config.promptSha256, 2300, () => 'test-only', { firstAttempt: 1, status: 'needs_sources', zeroTableWrites: true, requiredSources: 18, expandedInputSha256: semanticInputHash(input) });
      await transport({ prompt_tokens: 10, completion_tokens: 20 }).request(config, input.scope, 'memory_turn', { ...SEMANTIC_PARAMETERS }, signal());
      await assert.rejects(s.prepareAttempt(input, h.config.promptSha256, 2300, () => { keys++; return 'test-only'; })); assert.equal(keys, 0);
    }
    await s.finish(true);
    const path = `${SEMANTIC_DIRECTORY}/runs/${runId}`, configSha256 = semanticHash(await readFile(join(h.root, SEMANTIC_DIRECTORY, 'config.json')));
    const manifest = { configSha256, caseId: id, model: SEMANTIC_MODEL, origin: 'controlled_stub', attempts: id === 'closure' ? 2 : 1, passed: true, testOnly: true };
    await h.write(`${path}/manifest.json`, manifest); await h.write(`${path}/result.json`, { id, passed: true, testOnly: true });
    await h.write(`${path}/attempts.json`, { testOnly: true }); await h.write(`${path}/state.sqlite`, { testOnly: 'Review pin test; not a database result' });
    const fingerprint = async () => Object.fromEntries(await Promise.all(['manifest.json', 'result.json', 'attempts.json', 'state.sqlite'].map(async name => [name, semanticHash(await readFile(join(h.root, path, name)))])));
    reviews.push({ caseId: id, runId, reviewedBy: 'W0-I', passed: true, fingerprints: await fingerprint() });
    await h.write(`${SEMANTIC_DIRECTORY}/reviews.json`, reviews);
    await assert.rejects(beginSemanticCase(h.root, `semantic-controlled-cannot-advance-${index}`, signal()), /real_provider/);
    // Test-owned simulation of an explicit independently reviewed real run, not a claim of actual model evidence.
    await h.write(`${path}/manifest.json`, { ...manifest, origin: 'real_provider', testOnly: true });
    reviews[index] = { caseId: id, runId, reviewedBy: 'W0-I', passed: true, fingerprints: await fingerprint() };
    await h.write(`${SEMANTIC_DIRECTORY}/reviews.json`, reviews);
  }
  const state = await h.read(ledger); assert.equal(state.entries.length - h.state.entries.length, 6);
  assert.deepEqual(state.entries[0], h.state.entries[0]);
  await assert.rejects(beginSemanticCase(h.root, 'semantic-seventh', signal()), /already been reviewed/);
  await h.write(`${SEMANTIC_DIRECTORY}/runs/semantic-sequence-0/result.json`, { changed: true });
  await assert.rejects(beginSemanticCase(h.root, 'semantic-altered-review', signal()), /evidence changed/);
});

test('exact HTTP evidence survives malformed JSON and unknown-usage settlement errors without storing headers', async () => {
  for (const body of [' { broken JSON \n', JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: null })]) {
    const captured: any[] = [];
    const provider = new ProviderTransport(semanticEvidenceFetcher(async () => new Response(body, { headers: { 'x-request-id': 'controlled-raw', 'authorization': 'do-not-record' } }), async record => { captured.push(record); }));
    await assert.rejects(provider.request({ endpoint: SEMANTIC_ENDPOINT, model: SEMANTIC_MODEL, apiKey: () => 'offline-only-never-send', authorizer: { async authorize() { return { async settle() { throw Error('Unknown usage'); } }; } } }, input.scope, 'memory_turn', {}, signal()));
    assert.equal(captured.length, 1); assert.equal(captured[0].rawText, body); assert.equal(captured[0].rawSha256, semanticHash(Buffer.from(body)));
    assert.equal(Buffer.from(captured[0].rawBase64, 'base64').toString(), body); assert.equal(captured[0].requestId, 'controlled-raw');
    assert.ok(!JSON.stringify(captured).includes('do-not-record')); assert.ok(!JSON.stringify(captured).includes('offline-only-never-send'));
  }
});

// Only test code translates already-pinned human declarations into injected wire responses.
// The transformation preserves all semantic values; it never derives discards or supplies missing claims.
// Test-only traversal keeps each quote bound to its own frozen source id AND version.
function mapHumanQuotes(value: any, format: MemorySemanticFormat, visit: (quote: { text: string; start?: number }, body: string | undefined) => any, ref?: { id: string; version: number }): any {
  if (Array.isArray(value)) return value.map(item => mapHumanQuotes(item, format, visit, ref));
  if (!value || typeof value !== 'object') return value;
  if ('source' in value) ref = value.source && typeof value.source.id === 'string' && Number.isSafeInteger(value.source.version) ? value.source : undefined;
  if (typeof value.text === 'string' && Object.keys(value).every(key => ['text', 'start'].includes(key))) {
    const source = ref ? format.known.get(ref.id) : undefined;
    return visit(value, source && source.version === ref?.version ? source.text : undefined);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapHumanQuotes(item, format, visit, ref)]));
}
// Only an exact whole-source start:0 is an equivalent optional representation.
// Never apply this comparison helper to compiled plans or persisted originals.
function normalizedWholeSourceQuotes(value: SemanticDeclaration, format: MemorySemanticFormat): SemanticDeclaration {
  return mapHumanQuotes(value, format, (quote, body) => quote.start === 0 && quote.text === body ? { text: quote.text } : { ...quote });
}
function humanQuoteWire(quote: { text: string; start?: number }, body: string | undefined): object {
  assert.ok(body !== undefined, 'A human quote must name its own read source/version');
  const points = [...body], size = [...quote.text].length, hits: number[] = [];
  for (let i = 0; i + size <= points.length; i++) if (points.slice(i, i + size).join('') === quote.text) hits.push(i);
  const start = quote.start ?? (hits.length === 1 ? hits[0] : undefined);
  assert.ok(start !== undefined && Number.isSafeInteger(start) && hits.includes(start), 'Invalid human quote selection');
  if (quote.start === undefined || quote.text === body) return { text: quote.text, context: null };
  return { text: quote.text, context: { before: points.slice(0, start).join(''), after: points.slice(start + size).join('') } };
}
function originalDeclarationWire(draft: SemanticDeclaration, format: MemorySemanticFormat): object {
  const aliases = new Map<string, string>();
  const rows = (format.wire.data() as { sources: { id: string; sourceVersions: { id: string; version: number }[] }[] }).sources;
  for (const row of rows) {
    const source = format.wire.source(row.id); aliases.set(source.id, row.id);
    row.sourceVersions.forEach((ref, index) => aliases.set(source.sourceVersions[index]!.id, ref.id));
  }
  const encode = (value: any): any => {
    if (Array.isArray(value)) return value.map(encode);
    if (!value || typeof value !== 'object') return value;
    if ('id' in value && 'version' in value && Object.keys(value).length === 2) { assert.ok(aliases.has(value.id)); return { id: aliases.get(value.id), version: value.version }; }
    if ('source' in value && Object.keys(value).every(k => ['source', 'quote'].includes(k))) return { source: encode(value.source), quote: value.quote ? encode(value.quote) : null };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  };
  const { annotationSource: _source, scope: _scope, ...declaration } = mapHumanQuotes(draft, format, humanQuoteWire);
  return { ...encode(declaration), unresolved: declaration.unresolved ? encode(declaration.unresolved) : null };
}

test('preserved real raw-only none remains a semantic failure beside the valid original declaration', { skip: !process.env.W0_I_SEMANTIC_ROOT }, async t => {
  const root = resolve(process.env.W0_I_SEMANTIC_ROOT!), savedOut = process.env.W2_SEMANTIC_SCOPE_OUT;
  const out = savedOut ? resolve(savedOut) : await mkdtemp(join(tmpdir(), 'semantic-scope-pair-'));
  if (savedOut) { assert.ok(out.startsWith(`${root}/.local/`)); await mkdir(out, { recursive: false }); }
  else t.after(() => rm(out, { recursive: true, force: true }));
  const phase = '.local/memory-semantic-offline-v1/phase', run = `${phase}/runs/semantic-raw-only-01`;
  const pins: Record<string, string> = {
    [`${run}/wire-responses.jsonl`]: '1230ef37256f7c201627aca649af4b35efaf6b2497a050917a3f6dcb79998551',
    [`${run}/attempts.json`]: 'b529a84bbde41d2d33f24cfc515b037d3359e77a69efd1fa16af3a496bb69432',
    [`${run}/result.json`]: '858269e22a35994b90529895d29cf86ab5bc25b7bd134fce9ec197fb257f53c3',
  };
  const readPinned = async (path: string) => {
    const bytes = await readFile(join(root, path)); assert.equal(semanticHash(bytes), pins[path]); return JSON.parse(bytes.toString());
  };
  const wire = await readPinned(`${run}/wire-responses.jsonl`), saved = await readPinned(`${run}/attempts.json`), failed = await readPinned(`${run}/result.json`);
  const raw = Buffer.from(wire.rawBase64, 'base64'); assert.equal(semanticHash(raw), wire.rawSha256); assert.equal(raw.toString(), wire.rawText);
  const savedRequest = saved.events.find((e: SemanticAttemptEvent) => e.type === 'request').data;
  const savedResponse = saved.events.find((e: SemanticAttemptEvent) => e.type === 'response').data;
  assert.deepEqual(JSON.parse(raw.toString()), savedResponse.raw); assert.equal(wire.rawSha256, savedResponse.rawSha256);
  const originals = await loadOriginalSemanticCases(root), fixture = originals.cases.find(f => f.id === 'raw-only')!; assert.ok(fixture);
  assert.equal(semanticInputHash(fixture.input), semanticInputHash(savedRequest.input));
  const base = '.local/memory-planning-evidence-v2', originalPath = `${base}/merged-originals/raw-only.json`;
  const review = JSON.parse(await readFile(join(root, base, 'review.json'), 'utf8'));
  pins[originalPath] = review.artifactHashes['merged-originals/raw-only.json']; Object.assign(pins, originals.inputPins);
  const original = await readPinned(originalPath), outcomes: object[] = [];
  for (const mode of ['preserved-failure', 'valid-original'] as const) {
    const events: SemanticAttemptEvent[] = []; let posts = 0;
    const result = await runSemanticCase({ filename: join(out, `${mode}.sqlite`), fixture, origin: 'controlled_stub', signal: signal(),
      countInput: actual => buildMemorySemanticFormat(actual).inputUpperBound,
      async attempt(snapshot) {
        assert.equal(semanticInputHash(snapshot.input), semanticInputHash(savedRequest.input));
        const format = buildMemorySemanticFormat(snapshot.input);
        const answer = await runMemorySemanticAttempt({ snapshot, config: { endpoint: SEMANTIC_ENDPOINT, model: SEMANTIC_MODEL, apiKey: () => 'controlled-test-only',
          authorizer: { async authorize() { return { async settle() {} }; } } },
          transport: new ProviderTransport(async (_url, init) => {
            posts++; const request = JSON.parse(String(init?.body));
            assert.equal(request.messages[1].content, savedRequest.request.messages[1].content);
            assert.deepEqual(request, { ...format.body, model: SEMANTIC_MODEL });
            if (mode === 'preserved-failure') return new Response(raw, { status: wire.status });
            return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(originalDeclarationWire(original.traces[0].declaration, format)) } }] });
          }), provenance: { kind: 'controlled_stub', runId: `scope-${mode}`, attemptId: '1' }, signal: signal(), evidence: async event => { events.push(event); } });
        const expected = mode === 'preserved-failure' ? failed.traces[0] : original.traces[0];
        assert.deepEqual(normalizedWholeSourceQuotes(answer.declaration, format), normalizedWholeSourceQuotes({ ...expected.declaration, annotationSource: 'model_evaluation' }, format));
        assert.deepEqual(answer.compiled, expected.compiled);
        return answer;
      },
    });
    assert.equal(posts, 1); assert.equal(result.attempts, 1); assert.equal(result.origin, 'controlled_stub');
    assert.equal(result.wholeAcceptance, false); assert.equal(result.allStoresClosed, true);
    assert.deepEqual(result.traces[0]!.wholeDatabaseBefore, result.traces[0]!.wholeDatabaseAfterAttempt);
    if (mode === 'preserved-failure') {
      assert.equal(result.passed, false); assert.deepEqual(result.error, failed.error);
      assert.deepEqual(result.outcome, failed.outcome); assert.deepEqual(result.contextAfter, failed.contextAfter);
      assert.deepEqual(result.sourcesBefore, result.finalSources);
      const before = result.wholeDatabaseBefore as Record<string, unknown[]>;
      const after = result.finalWholeDatabase as Record<string, unknown[]>;
      assert.deepEqual(Object.keys(after).filter(key => JSON.stringify(after[key]) !== JSON.stringify(before[key])), ['memory_turn_outcomes']);
      assert.equal(after.memory_turn_outcomes!.length, before.memory_turn_outcomes!.length + 1);
      const event = events.find(e => e.type === 'response')!.data as typeof savedResponse;
      assert.deepEqual(event.raw, savedResponse.raw); assert.equal(event.content, savedResponse.content);
    } else {
      assert.equal(result.passed, true, JSON.stringify(result.error));
      const context = result.contextAfter as typeof original.contextAfter;
      assert.deepEqual(context.recent.map((m: { text: string }) => m.text), original.contextAfter.recent.map((m: { text: string }) => m.text));
      assert.deepEqual(context.memories, original.contextAfter.memories); assert.equal(context.summary, original.contextAfter.summary);
    }
    await writeFile(join(out, `${mode}.json`), JSON.stringify({ ...result, events }, null, 2) + '\n', { flag: 'wx' });
    outcomes.push({ mode, passed: result.passed, error: result.error ?? null, posts, attempts: result.attempts });
  }
  for (const [path, hash] of Object.entries(pins)) assert.equal(semanticHash(await readFile(join(root, path))), hash);
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ outcomes, inputPins: pins, modelCalls: 0, actualNetwork: false,
    origin: 'controlled_stub', semanticModelReliabilityProven: false, wholeAcceptance: false }, null, 2) + '\n', { flag: 'wx' });
});

test('context-v2 rejects preserved legacy offsets and gap while independent human coverage controls remain strict', { skip: !process.env.W0_I_SEMANTIC_ROOT }, async t => {
  const root = resolve(process.env.W0_I_SEMANTIC_ROOT!), savedOut = process.env.W2_SEMANTIC_QUOTE_OUT;
  const out = savedOut ? resolve(savedOut) : await mkdtemp(join(tmpdir(), 'semantic-quote-test-'));
  if (savedOut) { assert.ok(out.startsWith(`${root}/.local/`)); await mkdir(out, { recursive: false }); }
  else t.after(() => rm(out, { recursive: true, force: true }));
  const gapRun = '.local/semantic-raw-recheck-v1/runs/semantic-raw-recheck-20260909-one';
  const offsetRun = '.local/semantic-batches/memory-semantic-batch-20260909-01/runs/semantic-batch20-20260909-01-raw';
  const pins: Record<string, string> = {
    [`${gapRun}/wire-responses.jsonl`]: '868bb481997f08ed0df84e0f1390f9bfcacb243bd2065775380aebcb4068fe9b',
    [`${gapRun}/attempts.json`]: 'cb71dedb9feaa30376c2872dea33d7378abfb1c088d05f38012c04d7acd1c876',
    [`${gapRun}/result.json`]: '0862dba2205cce2b7ed8fec38a2b15f738dc53aeb91b046dfcb7ce80be719854',
    [`${offsetRun}/wire-responses.jsonl`]: '28dec870d32d3b2223b1c84828c948e550f8a2eba36be5617fa026ad1054f752',
    [`${offsetRun}/attempts.json`]: 'b8947d3e5e0a72206cb073180ddea9a1bf03bce7edac61bae4266d0e53c5b797',
    [`${offsetRun}/result.json`]: '971a8c8405a2088761254c9a5f49e1c55aaee18a19cea6f0a0ddac1fe339c324',
  };
  const readPinned = async (path: string) => {
    const bytes = await readFile(join(root, path)); assert.equal(semanticHash(bytes), pins[path]); return JSON.parse(bytes.toString());
  };
  const loadLegacy = async (run: string) => {
    const wire = await readPinned(`${run}/wire-responses.jsonl`), saved = await readPinned(`${run}/attempts.json`), result = await readPinned(`${run}/result.json`);
    const raw = Buffer.from(wire.rawBase64, 'base64'); assert.equal(semanticHash(raw), wire.rawSha256); assert.equal(raw.toString(), wire.rawText);
    const request = saved.events.find((e: SemanticAttemptEvent) => e.type === 'request').data;
    const response = saved.events.find((e: SemanticAttemptEvent) => e.type === 'response').data;
    assert.deepEqual(JSON.parse(raw.toString()), response.raw);
    return { wire, saved, result, raw, request, response };
  };
  const gap = await loadLegacy(gapRun), offset = await loadLegacy(offsetRun);
  assert.equal(gap.saved.events.find((e: SemanticAttemptEvent) => e.type === 'failure').data.stage, 'compile');
  assert.equal(offset.saved.events.find((e: SemanticAttemptEvent) => e.type === 'failure').data.stage, 'decode');
  assert.match(offset.result.error.message, /Invalid semantic quote code-point start/);
  const originals = await loadOriginalSemanticCases(root), fixture = originals.cases.find(f => f.id === 'raw-only')!; assert.ok(fixture);
  for (const old of [gap, offset]) assert.equal(semanticInputHash(fixture.input), semanticInputHash(old.request.input));
  const base = '.local/memory-planning-evidence-v2', originalPath = `${base}/merged-originals/raw-only.json`;
  const review = JSON.parse(await readFile(join(root, base, 'review.json'), 'utf8'));
  pins[originalPath] = review.artifactHashes['merged-originals/raw-only.json']; Object.assign(pins, originals.inputPins);
  const original = await readPinned(originalPath), valid: SemanticDeclaration = original.traces[0].declaration;
  // Both negatives originate only from the complete human declaration, never a provider response.
  const complete = structuredClone(valid), missingCurrent: SemanticDeclaration = { ...complete,
    assessments: complete.assessments.filter(a => a.source.id !== fixture.input.currentMessageId) };
  assert.equal(missingCurrent.assessments.length, valid.assessments.length - 1);
  assert.deepEqual({ ...missingCurrent, assessments: valid.assessments }, valid);
  const humanGap = structuredClone(valid), retained = humanGap.assessments.find(a => a.retain.length)!.retain[0]!;
  const fullQuote = structuredClone(retained.quote); assert.equal(fullQuote.start, undefined); assert.ok([...fullQuote.text].length > 1);
  (retained as { quote: { text: string } }).quote = { text: [...fullQuote.text].slice(1).join('') };
  const restored = structuredClone(humanGap); (restored.assessments.find(a => a.retain.length)!.retain[0]! as { quote: typeof fullQuote }).quote = fullQuote;
  assert.deepEqual(restored, valid);
  const current = fixture.input.sources.find(s => s.id === fixture.input.currentMessageId)!;
  const outcomes: object[] = [];
  for (const mode of ['legacy-gap', 'legacy-offset', 'valid-original', 'human-gap', 'human-missing-current'] as const) {
    const legacy = mode === 'legacy-gap' ? gap : mode === 'legacy-offset' ? offset : null;
    const human = mode === 'human-gap' ? humanGap : mode === 'human-missing-current' ? missingCurrent : valid;
    const events: SemanticAttemptEvent[] = []; let posts = 0;
    const result = await runSemanticCase({ filename: join(out, `${mode}.sqlite`), fixture, origin: 'controlled_stub', signal: signal(),
      countInput: actual => buildMemorySemanticFormat(actual).inputUpperBound,
      async attempt(snapshot) {
        assert.equal(semanticInputHash(snapshot.input), semanticInputHash(gap.request.input));
        const format = buildMemorySemanticFormat(snapshot.input);
        return runMemorySemanticAttempt({ snapshot, config: { endpoint: SEMANTIC_ENDPOINT, model: SEMANTIC_MODEL, apiKey: () => 'controlled-test-only',
          authorizer: { async authorize() { return { async settle() {} }; } } },
          transport: new ProviderTransport(async (_url, init) => {
            posts++; const request = JSON.parse(String(init?.body));
            assert.equal(request.messages[1].content, gap.request.request.messages[1].content);
            assert.deepEqual(request, { ...format.body, model: SEMANTIC_MODEL });
            if (legacy) return new Response(legacy.raw, { status: legacy.wire.status });
            return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(originalDeclarationWire(human, format)) } }] });
          }), provenance: { kind: 'controlled_stub', runId: `quote-${mode}`, attemptId: '1' }, signal: signal(), evidence: async e => { events.push(e); } });
      },
    });
    assert.equal(posts, 1); assert.equal(result.attempts, 1); assert.equal(result.origin, 'controlled_stub');
    assert.equal(result.wholeAcceptance, false); assert.equal(result.allStoresClosed, true);
    assert.deepEqual(result.traces[0]!.wholeDatabaseBefore, result.traces[0]!.wholeDatabaseAfterAttempt);
    if (mode === 'valid-original') {
      assert.equal(result.passed, true, JSON.stringify(result.error));
      assert.deepEqual(result.traces[0]!.compiled, original.traces[0].compiled);
      const context = result.contextAfter as typeof original.contextAfter;
      assert.deepEqual(context.recent.map((m: { text: string }) => m.text), original.contextAfter.recent.map((m: { text: string }) => m.text));
      assert.deepEqual(context.memories, original.contextAfter.memories); assert.equal(context.summary, original.contextAfter.summary);
    } else {
      assert.equal(result.passed, false); assert.equal(result.outcome, undefined); assert.equal(result.contextAfter, undefined);
      assert.equal(Object.keys(result.wholeDatabaseBefore as object).length, 16);
      assert.deepEqual(result.wholeDatabaseBefore, result.finalWholeDatabase); assert.deepEqual(result.sourcesBefore, result.finalSources);
    }
    if (legacy) {
      assert.deepEqual(result.error, { name: 'Error', message: 'Invalid memory JSON fields', aborted: false });
      assert.deepEqual(events.map(e => e.type), ['request', 'response', 'failure']);
      assert.deepEqual(events.find(e => e.type === 'response')!.data, legacy.response);
      assert.equal((events.find(e => e.type === 'failure')!.data as any).stage, 'decode');
      assert.notDeepEqual(result.error, legacy.result.error, 'New obsolete-format refusal is not the original v1 failure');
    } else {
      const format = buildMemorySemanticFormat(fixture.input), decoded = (events.find(e => e.type === 'declaration')!.data as any).declaration;
      assert.deepEqual(normalizedWholeSourceQuotes(decoded, format), normalizedWholeSourceQuotes({ ...human, annotationSource: 'model_evaluation' }, format));
      if (mode === 'human-gap') {
        assert.match((result.error as any).message, /incomplete_or_overlapping_source_partition/);
        assert.equal(events.some(e => e.type === 'compiled'), false);
        assert.equal((events.find(e => e.type === 'failure')!.data as any).stage, 'compile');
      } else if (mode === 'human-missing-current') {
        assert.deepEqual(result.traces[0]!.compiled, { status: 'needs_semantics', sources: [{ id: current.id, version: current.version }] });
      }
    }
    await writeFile(join(out, `${mode}.json`), JSON.stringify({ ...result, events }, null, 2) + '\n', { flag: 'wx' });
    outcomes.push({ mode, passed: result.passed, error: result.error ?? null, posts, attempts: result.attempts, compiled: result.traces[0]!.compiled ?? null });
  }
  for (const [path, hash] of Object.entries(pins)) assert.equal(semanticHash(await readFile(join(root, path))), hash);
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ outcomes, inputPins: pins, modelCalls: 0, actualNetwork: false,
    legacyErrorsUnchanged: { gap: gap.result.error, offset: offset.result.error },
    origin: 'controlled_stub', semanticModelReliabilityProven: false, wholeAcceptance: false }, null, 2) + '\n', { flag: 'wx' });
});

test('original nine cases pass strict injected response, real SQLite ticket/expansion/commit and actual context checks', { skip: !process.env.W0_I_SEMANTIC_ROOT }, async t => {
  const root = resolve(process.env.W0_I_SEMANTIC_ROOT!), savedOut = process.env.W2_SEMANTIC_ORIGINALS_OUT ?? process.env.W0_I_SEMANTIC_OUT;
  const out = savedOut ? resolve(savedOut) : await mkdtemp(join(tmpdir(), 'semantic-originals-test-'));
  if (savedOut) { assert.ok(out.startsWith(process.env.W2_SEMANTIC_ORIGINALS_OUT ? `${root}/.local/worktrees/W2/.local/semantic-quote-repair-v1/` : `${root}/.local/memory-semantic-offline-v1/`)); await mkdir(out, { recursive: false }); }
  else t.after(() => rm(out, { recursive: true, force: true }));
  const originalBase = '.local/memory-planning-evidence-v2', review = JSON.parse(await readFile(`${root}/${originalBase}/review.json`, 'utf8'));
  const originals = await loadOriginalSemanticCases(root), results: object[] = [], ticketInputs: Record<string, MemoryTurnInput> = {};
  const pins = { ...originals.inputPins };
  for (const fixture of originals.cases) {
    const relative = `merged-originals/${fixture.id}.json`, bytes = await readFile(`${root}/${originalBase}/${relative}`);
    assert.equal(semanticHash(bytes), review.artifactHashes[relative]); pins[`${originalBase}/${relative}`] = semanticHash(bytes);
    const original = JSON.parse(bytes.toString()), events: SemanticAttemptEvent[] = []; let posts = 0;
    const result = await runSemanticCase({ filename: `${out}/${fixture.id}.sqlite`, fixture, expanded: originals.expanded, signal: signal(), origin: 'controlled_stub',
      countInput: actual => buildMemorySemanticFormat(actual).inputUpperBound,
      attempt: async (snapshot, ordinal) => {
        const historical = original.traces[ordinal - 1]; assert.ok(historical);
        assert.equal(semanticInputHash(snapshot.input), semanticInputHash(historical.input));
        ticketInputs[ordinal === 1 ? fixture.id : `${fixture.id}:expanded`] = structuredClone(snapshot.input);
        const format = buildMemorySemanticFormat(snapshot.input), response = originalDeclarationWire(historical.declaration, format);
        const actual = await runMemorySemanticAttempt({ snapshot, config: { endpoint: SEMANTIC_ENDPOINT, model: SEMANTIC_MODEL, apiKey: () => 'controlled-test-only',
          authorizer: { async authorize() { return { async settle() {} }; } } }, transport: new ProviderTransport(async (_url, init) => {
            posts++; const request = JSON.parse(String(init?.body)); assert.deepEqual(request, { ...format.body, model: SEMANTIC_MODEL });
            return Response.json({ model: SEMANTIC_MODEL, system_fingerprint: 'controlled-only', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
          }), provenance: { kind: 'controlled_stub', runId: `original-${fixture.id}`, attemptId: String(ordinal) }, signal: signal(), evidence: async event => { events.push(event); } });
        assert.deepEqual(normalizedWholeSourceQuotes(actual.declaration, format), normalizedWholeSourceQuotes({ ...historical.declaration, annotationSource: 'model_evaluation' }, format));
        assert.deepEqual(actual.compiled, historical.compiled); return actual;
      },
    });
    await writeFile(`${out}/${fixture.id}.json`, JSON.stringify({ ...result, events }, null, 2) + '\n', { flag: 'wx' });
    results.push({ id: fixture.id, passed: result.passed, posts, attempts: result.attempts, error: result.error ?? null });
    assert.equal(result.passed, true, `${fixture.id}: ${JSON.stringify(result.error)}`);
    assert.equal(posts, fixture.id === 'closure' ? 2 : 1); assert.equal(result.origin, 'controlled_stub');
    assert.equal(result.wholeAcceptance, false); assert.equal(result.allStoresClosed, true);
  }
  for (const [path, sha] of Object.entries(pins)) assert.equal(semanticHash(await readFile(`${root}/${path}`)), sha);
  await writeFile(`${out}/ticket-inputs.json`, JSON.stringify(ticketInputs, null, 2) + '\n', { flag: 'wx' });
  await writeFile(`${out}/manifest.json`, JSON.stringify({ results, originalInputPins: pins, ticketInputsSha256: semanticHash(await readFile(`${out}/ticket-inputs.json`)),
    originalCasesPassed: results.length, modelCalls: 0, origin: 'controlled_stub', actualNetwork: false, semanticModelReliabilityProven: false, wholeAcceptance: false }, null, 2) + '\n', { flag: 'wx' });
});

async function systemComparisonHarness(t: TestContext, actualInput = input) {
  const h = await thinkingHarness(t), format = buildMemorySemanticFormat(actualInput);
  const comparison = h.config.comparison!, directory = `${SEMANTIC_BATCH_ROOT}/${comparison.phaseId}`;
  const baselineBody = structuredClone({ ...buildSemanticRequestBody(format, 'high'), model: SEMANTIC_PRO_MODEL });
  (baselineBody as any).messages[0].content = 'Prior controlled high-mode system; not a historical model response.';
  const baseline = { id: 'raw-only', input: structuredClone(actualInput), body: baselineBody, requestSha256: semanticHash(JSON.stringify(baselineBody)) };
  await h.write(`${directory}/requests.json`, [baseline]);
  const requestHash = semanticHash(await readFile(join(h.root, directory, 'requests.json')));
  await h.write(`${directory}/config.json`, { phaseId: comparison.phaseId, batchVersion: 3, model: SEMANTIC_PRO_MODEL, parameters: SEMANTIC_THINKING_PARAMETERS,
    promptSha256: semanticHash((baselineBody as any).messages[0].content), artifactPins: { [`${directory}/requests.json`]: requestHash } });
  comparison.configSha256 = semanticHash(await readFile(join(h.root, directory, 'config.json'))); comparison.requestSha256 = baseline.requestSha256;
  Object.assign(h.config.artifactPins, { [`${directory}/config.json`]: comparison.configSha256, [`${directory}/requests.json`]: requestHash });
  Object.assign(h.config, { batchVersion: 4, promptSha256: semanticHash(format.system), inputHashes: { 'raw-only': semanticInputHash(actualInput) } });
  h.request.input = structuredClone(actualInput); h.request.body = structuredClone({ ...buildSemanticRequestBody(format, 'high'), model: SEMANTIC_PRO_MODEL });
  await h.publish(); return { ...h, baseline };
}

test('system comparison changes only nonempty system content against a prior Pro high request', () => {
  const baseline = { ...buildSemanticRequestBody(buildMemorySemanticFormat(input), 'high'), model: SEMANTIC_PRO_MODEL };
  const candidate = structuredClone(baseline); (candidate as any).messages[0].content += '\nControlled prompt change.';
  assertSemanticSystemOnlyRequest(baseline, candidate);
  assert.throws(() => assertSemanticSystemOnlyRequest(baseline, baseline), /actual prompt change/);
  assert.throws(() => assertSemanticThinkingOnlyRequest(baseline, candidate));
  assert.throws(() => assertSemanticSystemOnlyRequest({ ...baseline, ...SEMANTIC_PARAMETERS }, candidate));
  for (const mutate of [
    (x: any) => { x.model = SEMANTIC_MODEL; }, (x: any) => { x.thinking.type = 'disabled'; },
    (x: any) => { x.reasoning_effort = 'max'; }, (x: any) => { delete x.reasoning_effort; },
    (x: any) => { x.messages[0].content = ' '; }, (x: any) => { x.messages[0].role = 'user'; },
    (x: any) => { x.messages[1].content += ' changed input'; }, (x: any) => { x.messages.push({ role: 'user', content: 'extra' }); },
    (x: any) => { x.max_tokens = 128; }, (x: any) => { x.stream = true; }, (x: any) => { delete x.response_format; },
  ]) { const bad = structuredClone(candidate); mutate(bad); assert.throws(() => assertSemanticSystemOnlyRequest(baseline, bad)); }
});

test('system comparison version4 freezes high baseline and rejects drift before claims, credentials or ledger writes', async t => {
  for (const mode of ['valid', 'old-version', 'unknown-version', 'no-change', 'input', 'system-pin', 'baseline', 'baseline-version', 'baseline-mode', 'pricing', 'effort', 'parameters'] as const) {
    const h = await systemComparisonHarness(t), before = await readFile(join(h.root, ledger));
    if (mode === 'old-version') h.config.batchVersion = 3;
    if (mode === 'unknown-version') (h.config as any).batchVersion = 5;
    if (mode === 'no-change') { (h.request.body as any).messages[0].content = (h.baseline.body as any).messages[0].content; h.config.promptSha256 = semanticHash((h.request.body as any).messages[0].content); }
    if (mode === 'input') h.request.input = { ...h.request.input, currentMessageId: 'changed' };
    if (mode === 'system-pin') h.config.promptSha256 = '0'.repeat(64);
    if (mode === 'baseline') h.config.comparison!.requestSha256 = '0'.repeat(64);
    if (mode === 'baseline-version' || mode === 'baseline-mode') {
      const path = `${SEMANTIC_BATCH_ROOT}/${h.config.comparison!.phaseId}/config.json`, old = await h.read(path);
      if (mode === 'baseline-version') old.batchVersion = 2; else old.parameters = SEMANTIC_PARAMETERS;
      await h.write(path, old); const hash = semanticHash(await readFile(join(h.root, path)));
      h.config.comparison!.configSha256 = hash; h.config.artifactPins[path] = hash;
    }
    if (mode === 'pricing') h.config.pricingEvidence!.sha256 = '0'.repeat(64);
    if (mode === 'effort') (h.request.body as any).reasoning_effort = 'max';
    if (mode === 'parameters') h.config.parameters = SEMANTIC_PARAMETERS;
    await h.publish(); let keys = 0, posts = 0;
    const oldFetch = globalThis.fetch; globalThis.fetch = async () => { posts++; throw Error('No network in controlled gate'); };
    try {
      if (mode === 'valid') assert.equal((await loadSemanticPhase(h.root, true, h.profile.phaseId)).config.batchVersion, 4);
      else await assert.rejects(evaluateMemorySemantics(h.root, 'semantic-system-denied', () => { keys++; return 'controlled'; }, signal(), h.profile.phaseId));
    } finally { globalThis.fetch = oldFetch; }
    assert.equal(keys, 0); assert.equal(posts, 0); assert.deepEqual(await readFile(join(h.root, ledger)), before);
    await assert.rejects(access(join(h.root, h.profile.directory, 'claims')));
  }
});

test('system comparison retains high-mode cost accounting and stops on malformed reasoning usage', async t => {
  for (const malformed of [false, true]) {
    const h = await systemComparisonHarness(t), s = await beginSemanticCase(h.root, 'semantic-system-cost', signal(), h.profile.phaseId); let posts = 0, keys = 0;
    try {
      const endpoint = await s.prepareAttempt(input, h.config.promptSha256, buildMemorySemanticFormat(input).inputUpperBound, () => { keys++; return 'controlled-only'; });
      const transport = new ProviderTransport(async (_url, init) => {
        posts++; assert.deepEqual(JSON.parse(String(init?.body)), h.request.body);
        assert.equal((await h.read(ledger)).entries.at(-1).reservedMicros, 11_000_000);
        return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 120, completion_tokens_details: { reasoning_tokens: malformed ? 121 : 100 } } });
      });
      const run = transport.request(endpoint, input.scope, 'memory_turn', buildSemanticRequestBody(buildMemorySemanticFormat(input), 'high'), signal());
      if (malformed) await assert.rejects(run, /phase stopped/); else await run;
    } finally { await s.finish(false); }
    const after = await h.read(ledger); assert.equal(keys, 1); assert.equal(posts, 1);
    assert.deepEqual(after.entries.slice(0, h.state.entries.length), h.state.entries);
    assert.equal(after.entries.at(-1).actualMicros, malformed ? null : 3330); assert.equal(after.entries.at(-1).status, malformed ? 'unknown' : 'settled');
    const bytes = await readFile(join(h.root, ledger)); await assert.rejects(beginSemanticCase(h.root, 'semantic-system-retry', signal(), h.profile.phaseId), /stopped/);
    assert.deepEqual(await readFile(join(h.root, ledger)), bytes);
  }
});

test('system comparison actual evaluator sends frozen Pro high bytes with an injected response and isolated ledger', { skip: !process.env.W0_I_SEMANTIC_ROOT }, async t => {
  const root = resolve(process.env.W0_I_SEMANTIC_ROOT!), originals = await loadOriginalSemanticCases(root);
  const prior = JSON.parse(await readFile(`${root}/.local/memory-planning-evidence-v2/merged-originals/raw-only.json`, 'utf8'));
  const h = await systemComparisonHarness(t, prior.traces[0].input);
  execFileSync('git', ['init', '--quiet'], { cwd: h.root });
  execFileSync('git', ['-c', 'user.name=Controlled Test', '-c', 'user.email=controlled@localhost', 'commit', '--quiet', '--allow-empty', '-m', 'Isolated evaluator fixture'], { cwd: h.root });
  for (const [path, hash] of Object.entries(originals.inputPins)) {
    const bytes = await readFile(`${root}/${path}`); assert.equal(semanticHash(bytes), hash);
    await mkdir(dirname(join(h.root, path)), { recursive: true }); await writeFile(join(h.root, path), bytes); h.config.artifactPins[path] = hash;
  }
  const manifestPath = '.local/prompt-trial-inputs/manifest.json';
  const manifest = await readFile(`${root}/${manifestPath}`); await writeFile(join(h.root, manifestPath), manifest);
  await h.publish(); let keys = 0, posts = 0;
  const oldFetch = globalThis.fetch; globalThis.fetch = async (_url, init) => {
    posts++; assert.equal(init?.body, JSON.stringify(h.request.body));
    const format = buildMemorySemanticFormat(prior.traces[0].input);
    const response = originalDeclarationWire(prior.traces[0].declaration, format);
    return Response.json({ model: SEMANTIC_PRO_MODEL, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }],
      usage: { prompt_tokens: 10, completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 100 } } });
  };
  try {
    const result = await evaluateMemorySemantics(h.root, 'semantic-system-injected', () => { keys++; return 'controlled-only'; }, signal(), h.profile.phaseId);
    assert.equal(result.passed, true); assert.equal(result.wholeAcceptance, false); assert.equal(result.allStoresClosed, true);
    assert.equal(keys, 1); assert.equal(posts, 1);
    const budget = await h.read(ledger); assert.equal(budget.entries.at(-1).actualMicros, 3330); assert.deepEqual(budget.entries.slice(0, h.state.entries.length), h.state.entries);
    // The production entry labels itself real_provider; this test replaces fetch and is only a controlled integration check.
    if (process.env.W0_I_SYSTEM_GATE_RECEIPT) await writeFile(process.env.W0_I_SYSTEM_GATE_RECEIPT, JSON.stringify({ origin: 'controlled_injected_fetch',
      modelCalls: 0, actualNetworkCalls: 0, realCredentialsRead: 0, injectedRequests: posts, originalCriteriaPassed: result.passed,
      highModeActualRequestSha256: semanticHash(JSON.stringify(h.request.body)), estimatedControlledMicros: 3330, wholeAcceptance: false }, null, 2) + '\n', { flag: 'wx' });
  } finally { globalThis.fetch = oldFetch; }
});
