import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DialogueReply, DialogueRequest } from '../../contracts/index.js';
import { runAbsenceRegressionScenario, runDialogueRegressionScenarios } from '../../app/dialogue-regression-scenarios.js';

async function fixtures(t: TestContext, cases = ['03-natural-correction', '05-after-forget']) {
  const directory = await mkdtemp(join(tmpdir(), 'dialogue-regression-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = join(directory, 'original'), out = join(directory, 'result');
  await mkdir(original);
  const inputs: DialogueRequest[] = [], fingerprints: Record<string, string> = {};
  for (const id of cases) {
    const scope = { characterId: 'friend', sessionId: 'synthetic', turnId: id, generation: 1 } as const;
    const input: DialogueRequest = { scope, text: '合成当前问句', context: { scope, characterPrompt: '合成角色', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 32768 }, memoryOutcome: { scope, request: 'none', status: 'unchanged', results: [], affectedIds: [], retrievalInvalidated: false, clarification: null } };
    inputs.push(input);
    const bytes = JSON.stringify({ scope, text: input.text, contextBeforeReply: input.context, outcome: input.memoryOutcome, reply: { text: '保留的旧回复' }, synthetic: true });
    fingerprints[`${id}.json`] = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(original, `${id}.json`), bytes);
  }
  await writeFile(join(original, 'review.json'), JSON.stringify({ fingerprints }));
  return { original, out, inputs, fingerprints };
}

test('dialogue comparison uses both exact saved inputs once and preserves original evidence', async t => {
  const f = await fixtures(t), received: DialogueRequest[] = [];
  await runDialogueRegressionScenarios(f.out, f.original, { async reply(input): Promise<DialogueReply> {
    received.push(structuredClone(input));
    return { scope: input.scope, text: '受控回复', expression: { emotion: 'neutral', intensity: 0, delivery: 'natural', gesture: null } };
  } });
  assert.deepEqual(received, f.inputs);
  for (const [name, digest] of Object.entries(f.fingerprints)) {
    assert.equal(createHash('sha256').update(await readFile(join(f.original, name))).digest('hex'), digest);
    const result = JSON.parse(await readFile(join(f.out, name), 'utf8'));
    assert.equal(result.completed, true);
    assert.equal(result.semanticAcceptance, false);
    assert.equal(result.previousReply.text, '保留的旧回复');
  }
});

test('a changed second fixture prevents every generation before the first comparison', async t => {
  const f = await fixtures(t); let calls = 0;
  await writeFile(join(f.original, '05-after-forget.json'), '{}');
  await assert.rejects(() => runDialogueRegressionScenarios(f.out, f.original, { async reply() { calls++; throw new Error('must not call'); } }), /Original dialogue evidence changed/);
  assert.equal(calls, 0);
  await assert.rejects(() => readFile(join(f.out, '03-natural-correction.json')), { code: 'ENOENT' });
});

test('independent absence comparison verifies its own original context and cannot silently reuse v4', async t => {
  const f = await fixtures(t, ['03-original-follow-up']), received: DialogueRequest[] = [];
  const provider = { async reply(input: DialogueRequest): Promise<DialogueReply> {
    received.push(structuredClone(input));
    return { scope: input.scope, text: '受控回复', expression: { emotion: 'neutral', intensity: 0, delivery: 'natural', gesture: null } };
  } };
  await runAbsenceRegressionScenario(f.out, f.original, provider);
  assert.deepEqual(received, f.inputs);
  const result = JSON.parse(await readFile(join(f.out, '03-original-follow-up.json'), 'utf8'));
  assert.equal(result.previousReply.text, '保留的旧回复');
  assert.equal(result.semanticAcceptance, false);
  assert.equal(createHash('sha256').update(await readFile(join(f.original, '03-original-follow-up.json'))).digest('hex'), f.fingerprints['03-original-follow-up.json']);
  await assert.rejects(runDialogueRegressionScenarios(join(f.out, 'wrong-suite'), f.original, provider), { code: 'ENOENT' });
  await writeFile(join(f.original, '03-original-follow-up.json'), '{}');
  await assert.rejects(runAbsenceRegressionScenario(join(f.out, 'changed'), f.original, provider), /Original dialogue evidence changed/);
  assert.equal(received.length, 1);
});
