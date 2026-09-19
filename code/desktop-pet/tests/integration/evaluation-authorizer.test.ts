import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallRequest } from '../../providers/transport.js';
import { CHAT_ENDPOINT, EVALUATION_MODELS, IntegratedEvaluationAuthorizer, estimateMicros } from '../../app/evaluation-authorizer.js';
const request: CallRequest = { operation: 'dialogue', model: EVALUATION_MODELS.dialogue, endpoint: CHAT_ENDPOINT, scope: { characterId: 'friend', sessionId: 's', turnId: 't', generation: 1 } };
test('parallel frontend/background reservations serialize under one budget and unknown usage stays reserved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pet-evaluation-'));
  try {
    const auth = new IntegratedEvaluationAuthorizer(dir);
    const [a, b] = await Promise.all([auth.authorize(request, new AbortController().signal), auth.authorize({ ...request, operation: 'memory_maintenance' }, new AbortController().signal)]);
    await Promise.all([a.settle({ status: 'success', usage: { prompt_tokens: 100, completion_tokens: 10 }, requestId: null }), b.settle({ status: 'cancelled', usage: null, requestId: null })]);
    const state = JSON.parse(await readFile(join(dir, 'budget.json'), 'utf8'));
    assert.equal(state.entries.length, 2); assert.deepEqual(state.entries.map((e: { status: string }) => e.status).sort(), ['settled', 'unknown']);
    assert.equal(state.entries.find((e: { status: string }) => e.status === 'unknown').reservedMicros, 1_000_000);
    await assert.rejects(auth.authorize({ ...request, endpoint: 'https://unit.invalid' }, new AbortController().signal), /outside/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('cost estimates use tiered non-thinking Plus rates and conservative multimodal input accounting', () => {
  assert.equal(estimateMicros(request, { status: 'success', usage: { prompt_tokens: 100, completion_tokens: 10 }, requestId: null }), 100);
  assert.equal(estimateMicros({ ...request, operation: 'perception' }, { status: 'success', usage: { prompt_tokens: 100, completion_tokens: 10 }, requestId: null }), 1933);
  assert.equal(estimateMicros(request, { status: 'failed', usage: {}, requestId: null }), null);
});

test('memory turn and summary use the same authorized shared ledger with separate operation labels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pet-lifecycle-budget-'));
  try {
    const auth = new IntegratedEvaluationAuthorizer(dir);
    for (const operation of ['memory_turn', 'summary'] as const) {
      const permit = await auth.authorize({ ...request, operation, model: EVALUATION_MODELS[operation] }, new AbortController().signal);
      await permit.settle({ status: 'success', usage: { prompt_tokens: 100, completion_tokens: 10 }, requestId: null });
      await assert.rejects(auth.authorize({ ...request, operation, model: EVALUATION_MODELS.tts }, new AbortController().signal), /outside/);
    }
    const budget = JSON.parse(await readFile(join(dir, 'budget.json'), 'utf8'));
    assert.equal(budget.entries.length, 2); assert.equal(budget.entries.reduce((n: number, e: { actualMicros: number }) => n + e.actualMicros, 0), 200);
    const lines = (await readFile(join(dir, 'integrated-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(row => row.operation), ['memory_turn', 'summary']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
