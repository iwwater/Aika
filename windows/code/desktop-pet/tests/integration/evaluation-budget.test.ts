import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvaluationBudget } from '../../core/evaluation-budget.js';
async function fixture(body: (file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'pet-budget-'));
  try { await body(join(dir, 'batch.json')); } finally { await rm(dir, {recursive: true, force: true}); }
}
test('one shared ceiling survives restart and unknown failures keep their reservation', async () => fixture(async file => {
  const budget = new EvaluationBudget(file, 'batch', 10_000_000);
  await budget.reserve('a', 'model', 6_000_000); await budget.settle('a', null);
  const resumed = new EvaluationBudget(file, 'batch', 10_000_000);
  await assert.rejects(resumed.reserve('b', 'model', 5_000_000), /exhausted/);
  await resumed.reserve('b', 'model', 4_000_000);
  assert.equal((await resumed.snapshot()).entries.length, 2);
}));
test('settled known cost releases unused allowance but repeated calls and conflicting settlements fail', async () => fixture(async file => {
  const budget = new EvaluationBudget(file, 'batch', 100);
  await budget.reserve('a', 'model', 90); await budget.settle('a', 10);
  await assert.rejects(budget.reserve('a', 'model', 1), /already reserved/);
  await budget.settle('a', 10);
  await assert.rejects(budget.settle('a', 11), /conflict/);
  await budget.reserve('b', 'model', 90);
}));
test('concurrent writers cannot both reserve beyond the same shared ceiling', async () => fixture(async file => {
  const a = new EvaluationBudget(file, 'batch', 100), b = new EvaluationBudget(file, 'batch', 100);
  const results = await Promise.allSettled([a.reserve('a', 'model', 75), b.reserve('b', 'model', 75)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await a.snapshot()).entries.length, 1);
}));
test('unexpected charge exceeding a conservative reservation blocks further calls', async () => fixture(async file => {
  const budget = new EvaluationBudget(file, 'batch', 100);
  await budget.reserve('a', 'model', 10); await budget.settle('a', 11);
  await assert.rejects(budget.reserve('b', 'model', 1), /blocked/);
}));
