import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvaluationBudget } from '../../core/evaluation-budget.js';
import { deepseekPeakEstimate, DeepSeekComparisonAuthorizer, DEEPSEEK_MODEL, DEEPSEEK_ENDPOINT, DEEPSEEK_RESERVATION, DEEPSEEK_WORST_MICROS } from '../../app/deepseek-comparison-budget.js';
import { assertComparisonOpen, comparisonHash, reviewedComparisonCount } from '../../app/deepseek-comparison-phase.js';
import type { MemoryTrialBundle } from '../../app/memory-trial.js';
import type { CallRequest } from '../../providers/transport.js';

const scope = { operationIdPrefix: 'phase:', limitMicros: 5_000_000, maxCalls: 4 };
test('stage reservations count unknown costs and preserve the original shared budget across restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pet-stage-budget-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'budget.json'), budget = new EvaluationBudget(file, 'shared', 10_000_000);
  await budget.reserve('previous', 'qwen', 1_000_000); await budget.settle('previous', 195738);
  await budget.reserve('phase:raw', DEEPSEEK_MODEL, DEEPSEEK_RESERVATION, scope);
  await budget.settle('phase:raw', null);
  const before = await readFile(file, 'utf8');
  const reopened = new EvaluationBudget(file, 'shared', 10_000_000);
  await assert.rejects(reopened.reserve('phase:closure', DEEPSEEK_MODEL, DEEPSEEK_RESERVATION, scope), /Phase budget/);
  assert.equal(await readFile(file, 'utf8'), before);
});
test('each successful settlement releases only its known estimate; zero-cost attempts still count toward four', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pet-stage-budget-')); t.after(() => rm(root, { recursive: true, force: true }));
  const budget = new EvaluationBudget(join(root, 'budget.json'), 'shared', 10_000_000);
  for (let n = 0; n < 4; n++) { await budget.reserve(`phase:${n}`, DEEPSEEK_MODEL, DEEPSEEK_RESERVATION, scope); await budget.settle(`phase:${n}`, 0); }
  await assert.rejects(budget.reserve('phase:4', DEEPSEEK_MODEL, DEEPSEEK_RESERVATION, scope), /generation limit/);
  assert.equal((await budget.snapshot()).entries.length, 4);
});
test('global ceiling and phase ceiling are enforced by the same transaction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pet-stage-budget-')); t.after(() => rm(root, { recursive: true, force: true }));
  const budget = new EvaluationBudget(join(root, 'budget.json'), 'shared', 10_000_000);
  await budget.reserve('previous', 'other', 7_000_000); await budget.settle('previous', 7_000_000);
  await assert.rejects(budget.reserve('phase:raw', DEEPSEEK_MODEL, DEEPSEEK_RESERVATION, scope), /Shared evaluation budget/);
  assert.equal((await budget.snapshot()).entries.length, 1);
  await assert.rejects(budget.reserve('outside', DEEPSEEK_MODEL, 1, scope), /Invalid scoped/);
});
test('DeepSeek estimates use peak CNY prices and do not depend on cache discounts', () => {
  assert.equal(DEEPSEEK_WORST_MICROS, 3_637_248); assert.ok(DEEPSEEK_WORST_MICROS < DEEPSEEK_RESERVATION);
  assert.equal(deepseekPeakEstimate({ prompt_tokens: 32768, completion_tokens: 393216, prompt_cache_hit_tokens: 32768 }), DEEPSEEK_WORST_MICROS);
  assert.equal(deepseekPeakEstimate({ prompt_tokens: 100, completion_tokens: 10 }), 390);
  for (const usage of [null, {}, { prompt_tokens: '1', completion_tokens: 2 }, { prompt_tokens: -1, completion_tokens: 1 }]) assert.equal(deepseekPeakEstimate(usage), null);
});
test('comparison authorizer refuses other operations, duplicate case attempts, unknown cost and changed historical records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pet-comparison-auth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = `${root}/.local/deepseek-comparison`, ledger = `${root}/.local/model-evaluation`;
  await mkdir(directory, { recursive: true }); await mkdir(ledger, { recursive: true });
  const entries = Array.from({ length: 113 }, (_, i) => ({ operationId: `old:${i}`, model: 'qwen', reservedMicros: 1_000_000, actualMicros: i === 0 ? 195738 : 0, status: 'settled' }));
  await writeFile(`${ledger}/budget.json`, JSON.stringify({ batchId: 'D09-S1-20260906-01', currency: 'CNY', limitMicros: 10_000_000, blocked: false, entries }));
  await writeFile(`${directory}/prior-budget.json`, JSON.stringify({ count: 113, estimatedMicros: 195738, entriesSha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }));
  const request: CallRequest = { model: DEEPSEEK_MODEL, endpoint: DEEPSEEK_ENDPOINT, operation: 'memory_turn', scope: { characterId: 'friend', sessionId: 's', turnId: 't', generation: 1 } }, signal = new AbortController().signal;
  const authorizer = new DeepSeekComparisonAuthorizer(root, 'raw-only');
  await assert.rejects(authorizer.authorize({ ...request, operation: 'dialogue' }, signal));
  await assert.rejects(authorizer.authorize({ ...request, endpoint: 'https://unit.invalid' }, signal));
  await assert.rejects(authorizer.authorize({ ...request, model: 'deepseek-v4-pro' }, signal));
  const permit = await authorizer.authorize(request, signal);
  await permit.settle({ status: 'success', usage: { prompt_tokens: 100, completion_tokens: 10 }, requestId: 'controlled' });
  await assert.rejects(authorizer.authorize(request, signal), /Per-case/);
  const closure = new DeepSeekComparisonAuthorizer(root, 'closure'), failed = await closure.authorize(request, signal);
  await failed.settle({ status: 'failed', usage: null, requestId: null });
  await assert.rejects(closure.authorize(request, signal), /Unsettled or unknown/);
  const state = JSON.parse(await readFile(`${ledger}/budget.json`, 'utf8')); state.entries[0].actualMicros = 1;
  await writeFile(`${ledger}/budget.json`, JSON.stringify(state));
  await assert.rejects(closure.authorize(request, signal), /Previous shared budget records changed/);
});
test('both stop and complete records prevent loading more phase inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pet-comparison-stop-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = `${root}/.local/deepseek-comparison`; await mkdir(directory, { recursive: true });
  for (const name of ['STOPPED.json', 'COMPLETED.json']) {
    await writeFile(`${directory}/${name}`, '{}'); await assert.rejects(assertComparisonOpen(root), /has ended/); await rm(`${directory}/${name}`);
  }
});
test('next case requires ordered review of immutable original evidence, not only an applied result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pet-comparison-review-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = `${root}/.local/deepseek-comparison`, runId = 'lifecycle-deepseek-test', out = `${root}/.local/${runId}`;
  await mkdir(dir, { recursive: true }); await mkdir(out, { recursive: true });
  const bundle = { cases: [{ id: 'raw-only', maxPlans: 1 }] } as MemoryTrialBundle;
  assert.equal(await reviewedComparisonCount(root, bundle, 'config'), 0);
  const content = { 'manifest.json': { configSha256: 'config', model: DEEPSEEK_MODEL, promptSha256: '69a69d32fb7183337f8597a89477275ec5320699d71ada53d168db29ee9e389f', selectedCaseId: 'raw-only', generationCalls: 1 }, 'scenarios.json': { selectedCaseId: 'raw-only', checks: [{ id: 'raw-only', passed: true }] }, 'review.json': { passed: true, reviewedBy: 'W0-I', selectedCaseId: 'raw-only' }, 'model-responses.json': [], 'plan-traces.json': [] };
  const fingerprints: Record<string, string> = {};
  for (const [name, data] of Object.entries(content)) { const text = JSON.stringify(data); await writeFile(`${out}/${name}`, text); fingerprints[name] = comparisonHash(text); }
  await writeFile(`${dir}/raw-only-call-owner.json`, JSON.stringify({ runId, configSha256: 'config' }));
  await writeFile(`${dir}/approvals.json`, JSON.stringify([{ caseId: 'raw-only', runId, passed: true, reviewedBy: 'W0-I', fingerprints }]));
  assert.equal(await reviewedComparisonCount(root, bundle, 'config'), 1);
  await writeFile(`${out}/model-responses.json`, '["changed"]');
  await assert.rejects(reviewedComparisonCount(root, bundle, 'config'), /evidence changed/);
});
