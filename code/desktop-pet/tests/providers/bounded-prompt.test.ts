import { companionFixture } from './companion-fixture.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { MemoryTurnInput, MemoryTurnProvider } from '../../contracts/memory-lifecycle.js';
import type { MemoryRecord } from '../../memory/ledger.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteLedgerBacking } from '../../memory/sqlite-backing.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { contextInputUpperBound } from '../../app/input-budgets.js';
import { buildMemoryTurnFormat } from '../../providers/memory-turn-format.js';
import { MEMORY_QUOTED_PROMPT } from '../../providers/memory-quoted-prompt.js';
import { memoryQuotedExamples } from '../../providers/memory-quoted-examples.js';
import { completeClosure as original_completeClosure } from './fixtures/quoted-original-sources.js';
import { boundedOriginals as original_boundedOriginals, type BoundedOriginal } from './fixtures/bounded-prompt-originals.js';
import { harness, plan, change, signal } from './quoted-helpers.js';

const completeClosure = companionFixture(original_completeClosure);
const boundedOriginals = companionFixture(original_boundedOriginals);

const fixture = (name: string) => boundedOriginals.find(f => f.name === name)!;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const normalized = (value: MemoryTurnInput) => ({ ...value, sources: [...value.sources].sort((a,b) => a.id.localeCompare(b.id)), messages: [...value.messages].sort((a,b) => a.id.localeCompare(b.id)), relevantMemories: [...value.relevantMemories].sort((a,b) => a.id.localeCompare(b.id)) });
const upperBound = (value: MemoryTurnInput) => { const f = buildMemoryTurnFormat(value, 'quoted-v2'); return Buffer.byteLength(JSON.stringify(f.data)) + Buffer.byteLength(f.system) + 2048; };
const current = (value: MemoryTurnInput) => value.sources.find(s => s.id === value.currentMessageId)!;

function restore(t: TestContext, f: BoundedOriginal) {
  const parent = fileURLToPath(new URL('../../../../../.local/bounded-prompt/tmp/', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(`${parent}case-`), filename = `${directory}/test.sqlite`;
  const store = new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => current(f.input).createdAt });
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  const db = new Database(filename);
  try { const backing = new SqliteLedgerBacking(db, f.input.scope.characterId); db.transaction(() => { for (const record of f.beforeRecords) backing.records.set(record.id, record); })(); }
  finally { db.close(); }
  for (const r of f.beforeRecords) assert.deepEqual(store.inspect(f.input.scope, r.id), r);
  return store;
}
function port(store: SqliteMemoryStore, provider: MemoryTurnProvider, maxSupplementaryPlans: 0 | 1 = 0) {
  return new SqliteLifecycleMemoryPort(store, {
    context: { maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, inputTokenBudget: 32768, countTokens: contextInputUpperBound, relevance: () => 1 },
    turn: { provider, inputTokenBudget: 32768, countTokens: upperBound, maxSupplementaryPlans },
    summary: { minMessages: 4, maxMessages: 4, inputTokenBudget: 32768, countTokens: () => 1, provider: { async summarize() { throw Error('unused'); } } },
  });
}
function rows(value: MemoryTurnInput) {
  const f = buildMemoryTurnFormat(value, 'quoted-v2'), data = f.data as { currentMessage: { id: string }; evidence: { id: string }[] };
  const all = [data.currentMessage, ...data.evidence];
  const alias = (id: string) => all.find(s => f.wire.source(s.id).id === id)!.id;
  const ref = (id: string) => ({ id: alias(id), version: value.sources.find(s => s.id === id)!.version });
  return { alias, ref };
}

/** Hand-authored candidates from provided records, never repairs an original model response. */
function candidate(f: BoundedOriginal) {
  const input = f.input, { alias, ref } = rows(input), memories = input.sources.filter(s => s.kind === 'memory');
  if (f.name === 'retire-recall') return plan();
  if (f.name === 'merge-decision') {
    const sourceId = memories[0]!.sourceVersions![0]!.id;
    return plan({ changes: [change({ type: 'merge', targets: memories.map(s => ({ id: alias(s.id), expectedVersion: s.version })), replacement: { id: 'n0', text: '用户每周五晚上练吉他。', sourceIds: [alias(sourceId)] } })] });
  }
  if (f.name === 'retire-decision') return plan({ request: 'correction', changes: [change({ type: 'soft_delete', id: alias(memories[0]!.id), expectedVersion: memories[0]!.version })], suppressSources: [ref(memories[0]!.sourceVersions![0]!.id)] });
  const oldRaw = input.sources.find(s => s.messageRole === 'user' && s.id !== input.currentMessageId && s.text.includes('面试'));
  const derived = input.sources.find(s => s.kind === 'summary' || s.messageRole === 'assistant');
  const badMemory = memories.find(s => s.text.includes('面试')), catMemory = memories.find(s => s.text.includes('团子'));
  const retainSources: unknown[] = [], changes: unknown[] = [];
  if (oldRaw) retainSources.push({ source: ref(oldRaw.id), fragmentId: 'f0', quote: '我养的猫叫团子。', range: null, supportSourceIds: [] });
  if (derived) retainSources.push({ source: ref(derived.id), fragmentId: oldRaw ? 'f1' : 'f0', quote: derived.kind === 'summary' ? '用户的猫叫团子。' : '团子听起来就让人开心多了！它是不是特别爱蜷成一团睡觉？', range: null, supportSourceIds: oldRaw ? ['f0'] : [] });
  if (badMemory) changes.push(change({ type: 'soft_delete', id: alias(badMemory.id), expectedVersion: badMemory.version }));
  if (catMemory) changes.push(change({ type: 'update', id: alias(catMemory.id), expectedVersion: catMemory.version, text: catMemory.text, sourceIds: ['f0'] }));
  return plan({ request: 'forget', changes, suppressSources: [input.currentMessageId, oldRaw?.id, derived?.id].filter((id): id is string => id !== undefined).map(ref), retainSources });
}

test('bounded candidate preserves nine example plans, exact input data and every captured-order budget', () => {
  assert.equal(memoryQuotedExamples.length, 9);
  assert.equal(hash(JSON.stringify(memoryQuotedExamples.map(e => e.plan))), 'e56af3ce68ebd172652433dcf33d76a0a9d2605eaff9ca928b0ef7df595c8237');
  assert.ok(Buffer.byteLength(MEMORY_QUOTED_PROMPT) <= 10531);
  for (const f of boundedOriginals) {
    assert.equal(hash(f.originalModelText), f.originalModelTextSha256);
    assert.deepEqual(buildMemoryTurnFormat(f.input, 'quoted-v2').data, f.originalData);
    assert.equal(upperBound(f.input), f.originalUpperBound - 10531 + Buffer.byteLength(MEMORY_QUOTED_PROMPT));
    assert.ok(upperBound(f.input) <= 32768);
  }
  assert.deepEqual(normalized(fixture('closure-expanded').input), normalized(completeClosure.input));
  assert.equal(upperBound(fixture('closure-expanded').input) - upperBound(completeClosure.input), 20);
});

for (const name of ['mixed-raw-only-forget', 'mixed-summary-only-forget', 'retire-recall']) test(`bounded original ${name}: unchanged model text still rejects absent memory before storage`, async t => {
  const f = fixture(name), store = restore(t, f), run = harness(f.originalModelText), revision = store.revision(f.input.scope);
  assert.equal(f.input.relevantMemories.length, 0);
  await assert.rejects(run.provider.plan(f.input, signal()), { message: 'Unknown wire source or wrong source kind' });
  assert.equal(run.requests.length, 1); assert.deepEqual(JSON.parse(run.requests[0].messages[1].content), f.originalData);
  assert.equal(store.revision(f.input.scope), revision);
  for (const r of f.beforeRecords) assert.deepEqual(store.inspect(f.input.scope, r.id), r);
});

test('bounded original parsed plans remain semantic failures, not newly rejected or repaired successes', async () => {
  for (const name of ['closure-first', 'closure-expanded', 'merge-decision', 'merge-recall']) {
    const f = fixture(name), run = harness(f.originalModelText), result = await run.provider.plan(f.input, signal());
    assert.equal(result.retainSources!.length, 0);
    if (name.startsWith('closure')) assert.deepEqual(new Set(result.suppressSources.map(s => s.id)), new Set(f.input.messages.map(s => s.id)));
    else assert.deepEqual(result.changes, []);
    assert.equal(run.requests.length, 1);
  }
});

for (const name of ['mixed-raw-only-forget', 'mixed-summary-only-forget', 'retire-recall', 'merge-decision', 'retire-decision', 'mixed-long-memory-forget', 'echo-forget']) test(`bounded independent ${name}: actual SQLite validates preserved content and issued context`, async t => {
  const f = fixture(name), store = restore(t, f), run = harness(candidate(f));
  const lifecycle = port(store, { async plan(selected, abort) { assert.deepEqual(normalized(selected), normalized(f.input)); return run.provider.plan(f.input, abort); } });
  const result = await lifecycle.prepareTurn(f.input.scope, f.input.currentMessageId, current(f.input).text, signal());
  assert.equal(result.status, name === 'retire-recall' ? 'unchanged' : 'applied', result.rejectionCode ?? '');
  assert.equal(run.requests.length, 1); assert.equal(run.requests[0].messages[0].content, MEMORY_QUOTED_PROMPT);
  const context = store.contextRecords(f.input.scope, current(f.input).text, 24, 32, 8);
  if (name === 'retire-recall') {
    for (const r of f.beforeRecords) assert.deepEqual(store.inspect(f.input.scope, r.id), r);
    assert.ok(JSON.stringify(context).includes('已经取回来了')); assert.equal(store.visible(f.input.scope, 'memory').length, 0);
  } else if (name === 'retire-decision') {
    assert.equal(store.visible(f.input.scope, 'memory').length, 0);
    assert.equal(store.inspect(f.input.scope, f.input.currentMessageId)!.state, 'active');
    assert.ok(JSON.stringify(context).includes('已经取回来了'));
  } else if (name === 'merge-decision') {
    const memories = store.visible(f.input.scope, 'memory'); assert.equal(memories.length, 1);
    assert.equal(memories[0]!.text, '用户每周五晚上练吉他。');
    for (const s of f.input.sources.filter(s => s.kind === 'transcript')) assert.equal(store.inspect(f.input.scope, s.id)!.state, 'active');
    assert.ok(JSON.stringify(context).includes('用户每周五晚上练吉他。'));
  } else {
    const active = ['memory', 'transcript', 'summary', 'keyword_index', 'context_cache'].flatMap(k => store.visible(f.input.scope, k as MemoryRecord['kind']));
    assert.ok(active.every(s => !s.text.includes('面试'))); assert.ok(active.some(s => s.text.includes('团子')));
    assert.deepEqual(store.search(f.input.scope, '面试失败', 32, 'lexical'), []);
    assert.equal(JSON.stringify(context).includes('面试'), false); assert.ok(JSON.stringify(context).includes('团子'));
  }
});

test('bounded independent original closure supplements once and preserves 20 independent users plus 20 assistant bodies', async t => {
  const first = fixture('closure-first'), expanded = fixture('closure-expanded'), store = restore(t, first), revision = store.revision(first.input.scope);
  const inputs: MemoryTurnInput[] = [], lifecycle = port(store, { async plan(selected, abort) {
    assert.equal(store.revision(first.input.scope), revision);
    assert.equal(store.lifecycle.outcome(first.input.scope, first.input.currentMessageId, current(first.input).text), null);
    for (const record of first.beforeRecords) assert.deepEqual(store.inspect(first.input.scope, record.id), record);
    assert.deepEqual(selected, inputs.length ? expanded.input : first.input); inputs.push(selected);
    const { alias, ref } = rows(selected), memory = selected.sources.find(s => s.kind === 'memory')!, raw = memory.sourceVersions![0]!.id;
    const assistants = selected.sources.filter(s => s.messageRole === 'assistant');
    const retained = inputs.length === 1 ? [] : assistants.map((s, index) => {
      const support = s.sourceVersions!.map(r => selected.sources.find(x => x.id === r.id)).find(x => x?.messageRole === 'user' && x.id !== raw && x.id !== selected.currentMessageId)!;
      assert.ok(support);
      return { source: ref(s.id), fragmentId: `f${index}`, quote: s.text, range: null, supportSourceIds: [alias(support.id)] };
    });
    return harness(plan({ request: 'forget', changes: [change({ type: 'soft_delete', id: alias(memory.id), expectedVersion: memory.version })], suppressSources: [selected.currentMessageId, raw, ...assistants.map(s => s.id)].map(ref), retainSources: retained })).provider.plan(selected, abort);
  } }, 1);
  const result = await lifecycle.prepareTurn(first.input.scope, first.input.currentMessageId, current(first.input).text, signal());
  assert.equal(result.status, 'applied', result.rejectionCode ?? ''); assert.deepEqual(inputs.map(i => i.sources.length), [25,43]);
  const raw = expanded.input.sources.find(s => s.kind === 'memory')!.sourceVersions![0]!.id;
  const users = expanded.input.sources.filter(s => s.messageRole === 'user' && ![raw, expanded.input.currentMessageId].includes(s.id));
  assert.equal(users.length, 20);
  for (const s of users) assert.deepEqual(store.inspect(expanded.input.scope, s.id), first.beforeRecords.find(r => r.id === s.id));
  const surviving = store.visible(expanded.input.scope, 'transcript'), fragments = surviving.filter(s => s.fragment);
  assert.equal(fragments.length, 20); assert.ok(fragments.every(s => s.text === '收到，我们聊今天的安排。' && s.sources.every(ref => users.some(u => u.id === ref.id))));
  assert.ok(surviving.every(s => !s.text.includes('猫') && !s.text.includes('团子')));
  const context = JSON.stringify(store.contextRecords(expanded.input.scope, '今天安排', 24, 32, 8));
  assert.ok(context.includes('今天的安排')); assert.ok(!context.includes('团子'));
  t.diagnostic(JSON.stringify({ actualProvider: false, sourceCounts: inputs.map(i => i.sources.length), actualOrderUpperBounds: inputs.map(upperBound), originalOrderUpperBound: upperBound(completeClosure.input), retainedUserRecords: users.length, retainedAssistantFragments: fragments.length }));
});
