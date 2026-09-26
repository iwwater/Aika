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
import { plan, change, harness, signal } from './quoted-helpers.js';
import { completeClosure as original_completeClosure, originalSourceCases as original_originalSourceCases, type OriginalSourceCase } from './fixtures/quoted-original-sources.js';

const completeClosure = companionFixture(original_completeClosure);
const originalSourceCases = companionFixture(original_originalSourceCases);

const ordered = <T extends { readonly id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const normalized = (value: MemoryTurnInput) => ({ ...value, sources: ordered(value.sources), messages: ordered(value.messages), relevantMemories: ordered(value.relevantMemories) });
export function quotedUpperBound(value: MemoryTurnInput) { const f = buildMemoryTurnFormat(value, 'quoted-v2'); return Buffer.byteLength(JSON.stringify(f.data)) + Buffer.byteLength(f.system) + 2048; }
function restored(t: TestContext, input: MemoryTurnInput, records: readonly MemoryRecord[]) {
  const parent = fileURLToPath(new URL('../../../../../.local/quoted-v2/tmp/', import.meta.url)); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(`${parent}case-`), filename = `${directory}/test.sqlite`;
  const now = input.sources.find(s => s.id === input.currentMessageId)!.createdAt;
  const store = new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => now });
  const writeRecord = (record: MemoryRecord) => { const db = new Database(filename); try { new SqliteLedgerBacking(db, input.scope.characterId).records.set(record.id, record); } finally { db.close(); } };
  const db = new Database(filename);
  try { const backing = new SqliteLedgerBacking(db, input.scope.characterId); db.transaction(() => { for (const record of records) backing.records.set(record.id, record); })(); } finally { db.close(); }
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  for (const record of records) assert.deepEqual(store.inspect(input.scope, record.id), record);
  return { store, writeRecord };
}
function port(store: SqliteMemoryStore, provider: MemoryTurnProvider, maxSupplementaryPlans: 0 | 1 = 0) {
  return new SqliteLifecycleMemoryPort(store, {
    context: { maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, inputTokenBudget: 32768, countTokens: contextInputUpperBound, relevance: () => 1 },
    turn: { provider, inputTokenBudget: 32768, countTokens: quotedUpperBound, maxSupplementaryPlans },
    summary: { minMessages: 4, maxMessages: 4, inputTokenBudget: 32768, countTokens: () => 1, provider: { async summarize() { throw Error('unused'); } } },
  });
}
function request(input: MemoryTurnInput) { return input.sources.find(s => s.id === input.currentMessageId)!; }
function rowsFor(value: MemoryTurnInput) { const format = buildMemoryTurnFormat(value, 'quoted-v2'), data = format.data as any; return { format, rows: [data.currentMessage, ...data.evidence] as any[] }; }

/** Independently authored complete new plan from actual source identities; never converts an old model output. */
export function candidate(fixture: OriginalSourceCase) {
  const { format, rows } = rowsFor(fixture.input);
  const row = (id: string) => rows.find(r => format.wire.source(r.id).id === id)!;
  const version = (id: string) => ({ id: row(id).id, version: row(id).version });
  const targets = fixture.targets, retained: any[] = [], changes: any[] = [];
  if (targets.raw) retained.push({ source: version(targets.raw), fragmentId: 'f0', quote: '我养的猫叫团子。', range: null, supportSourceIds: [] });
  if (targets.derived) retained.push({ source: version(targets.derived), fragmentId: targets.raw ? 'f1' : 'f0', quote: row(targets.derived).kind === 'summary' ? '用户的猫叫团子。' : '不过团子听起来就让人开心多了！它是不是特别爱蜷成一团睡觉？', range: null, supportSourceIds: targets.raw ? ['f0'] : [] });
  if (targets.forgetMemory) changes.push(change({ type: 'soft_delete', id: row(targets.forgetMemory).id, expectedVersion: row(targets.forgetMemory).version }));
  if (targets.catMemory) changes.push(change({ type: 'update', id: row(targets.catMemory).id, expectedVersion: row(targets.catMemory).version, text: row(targets.catMemory).text, sourceIds: ['f0'] }));
  return plan({ request: 'forget', changes, suppressSources: [fixture.input.currentMessageId, targets.raw, targets.derived].filter((id): id is string => id !== null).map(version), retainSources: retained });
}

for (const fixture of originalSourceCases) test(`original ${fixture.name}: numeric failure unchanged, independent quoted plan applies to identity-adapted SQLite read state`, async t => {
  const original = harness(fixture.originalModelText, 'numeric-v1');
  assert.equal(createHash('sha256').update(fixture.originalModelText).digest('hex'), fixture.originalModelTextSha256);
  await assert.rejects(original.provider.plan(fixture.input, signal()), /Invalid Unicode code point range/);
  assert.deepEqual(original.requests[0].messages, fixture.numericMessages); assert.equal(original.requests.length, 1);
  const records = [...fixture.sourcesBefore, ...(fixture.expiredRaw ? [fixture.expiredRaw] : [])];
  const { store } = restored(t, fixture.input, records), run = harness(candidate(fixture)), current = request(fixture.input);
  const lifecycle = port(store, { async plan(selected, abort) {
    assert.deepEqual(normalized(selected), normalized(fixture.input));
    return run.provider.plan({ ...selected, sources: fixture.input.sources.map(s => selected.sources.find(row => row.id === s.id)!) }, abort);
  } }, 1);
  const outcome = await lifecycle.prepareTurn(fixture.input.scope, current.id, current.text, signal());
  assert.equal(outcome.status, 'applied', outcome.rejectionCode ?? ''); assert.equal(run.requests.length, 1);
  const active = ['transcript', 'memory', 'summary', 'keyword_index', 'context_cache'].flatMap(kind => store.visible(fixture.input.scope, kind as MemoryRecord['kind']));
  assert.ok(active.every(r => !r.text.includes('面试'))); assert.ok(active.some(r => r.text.includes('团子')));
  assert.deepEqual(store.search(fixture.input.scope, '面试失败', 32, 'lexical'), []);
  if (fixture.targets.catMemory) { const cat = store.inspect(fixture.input.scope, fixture.targets.catMemory)!; assert.equal(cat.version, 2); assert.ok(cat.sources.every(r => store.inspect(fixture.input.scope, r.id)?.fragment)); }
  const context = store.contextRecords(fixture.input.scope, '猫叫什么', 24, 32, 8);
  assert.equal(JSON.stringify(context).includes('面试'), false);
  t.diagnostic('Controlled exact before-record restoration and new plan only; original numeric model failure remains a failure');
});

test('quoted protocol errors and missing already-read memory disposition cannot trigger supplementation or writes', async t => {
  const fixture = originalSourceCases[0]!, records = fixture.sourcesBefore, current = request(fixture.input);
  for (const mode of ['quote', 'omission'] as const) {
    const { store } = restored(t, fixture.input, records), before = store.revision(fixture.input.scope);
    const body: Record<string, unknown> = candidate(fixture);
    if (mode === 'quote') (body.retainSources as any[])[0].quote = '不存在的引用';
    else body.changes = (body.changes as any[]).slice(0, 1);
    const run = harness(body), lifecycle = port(store, { async plan(selected, abort) { assert.deepEqual(normalized(selected), normalized(fixture.input)); return run.provider.plan(fixture.input, abort); } }, 1);
    if (mode === 'quote') await assert.rejects(lifecycle.prepareTurn(fixture.input.scope, current.id, current.text, signal()), /no exact match/);
    else { const outcome = await lifecycle.prepareTurn(fixture.input.scope, current.id, current.text, signal()); assert.equal(outcome.status, 'rejected'); assert.equal(outcome.rejectionCode, 'unresolved_memory_suppression'); }
    assert.equal(run.requests.length, 1); assert.equal(store.revision(fixture.input.scope), before);
    for (const r of records) assert.deepEqual(store.inspect(fixture.input.scope, r.id), r);
  }
});

test('quoted provider cannot infer u ancestry is expired; storage rejects hidden ancestry atomically', async t => {
  const fixture = originalSourceCases[2]!, hidden = { ...fixture.expiredRaw!, state: 'invalidated' as const };
  const records = [...fixture.sourcesBefore, hidden], { store } = restored(t, fixture.input, records), run = harness(candidate(fixture)), current = request(fixture.input);
  const lifecycle = port(store, run.provider);
  const result = await lifecycle.prepareTurn(fixture.input.scope, current.id, current.text, signal());
  assert.equal(result.status, 'rejected'); assert.equal(run.requests.length, 1);
  for (const r of records) assert.deepEqual(store.inspect(fixture.input.scope, r.id), r);
});

test('quoted plan cannot commit a source version changed during the provider wait', async t => {
  const fixture = originalSourceCases[0]!, { store, writeRecord } = restored(t, fixture.input, fixture.sourcesBefore);
  const changed = fixture.sourcesBefore.find(r => r.id === fixture.targets.raw)!;
  const run = harness(candidate(fixture), 'quoted-v2', () => writeRecord({ ...changed, version: changed.version + 1 }));
  const lifecycle = port(store, run.provider, 1), current = request(fixture.input);
  const result = await lifecycle.prepareTurn(fixture.input.scope, current.id, current.text, signal());
  assert.equal(result.status, 'rejected'); assert.equal(run.requests.length, 1);
  for (const r of fixture.sourcesBefore) assert.deepEqual(store.inspect(fixture.input.scope, r.id), r.id === changed.id ? { ...r, version: r.version + 1 } : r);
});

for (const mode of ['enabled', 'disabled', 'known_omission'] as const) test(`quoted original42raw closure: ${mode} preserves supplementation and atomic boundaries`, async t => {
  const full = completeClosure.input, { store } = restored(t, full, completeClosure.records), memory = full.sources.find(s => s.kind === 'memory')!, current = request(full);
  const rawId = memory.sourceVersions![0]!.id, revision = store.revision(full.scope), calls: MemoryTurnInput[] = [];
  const lifecycle = port(store, { async plan(selected, abort) {
    assert.equal(store.revision(full.scope), revision); assert.equal(store.lifecycle.outcome(full.scope, current.id, current.text), null);
    assert.deepEqual(normalized(selected), normalized(calls.length ? full : completeClosure.firstInput)); calls.push(selected);
    const { format, rows } = rowsFor(selected), byId = (id: string) => rows.find(r => format.wire.source(r.id).id === id)!;
    let handled = selected.sources.filter(s => s.id === current.id || s.id === rawId || s.messageRole === 'assistant');
    if (mode === 'known_omission') handled = handled.filter(s => s.id !== selected.sources.find(r => r.messageRole === 'assistant')!.id);
    const retainSources = calls.length === 2 ? selected.sources.filter(s => s.messageRole === 'assistant').map((source, index) => {
      const supports = source.sourceVersions!.map(r => selected.sources.find(s => s.id === r.id)).filter(s => s?.messageRole === 'user' && s.id !== rawId && s.id !== current.id);
      const last = supports[0]!; assert.ok(last);
      return { source: { id: byId(source.id).id, version: source.version }, fragmentId: `f${index}`, quote: source.text, range: null, supportSourceIds: [byId(last.id).id] };
    }) : [];
    const body = plan({ request: 'forget', changes: [change({ type: 'soft_delete', id: byId(memory.id).id, expectedVersion: memory.version })], suppressSources: handled.map(s => ({ id: byId(s.id).id, version: s.version })), retainSources });
    const run = harness(body); return run.provider.plan(selected, abort);
  } }, mode === 'disabled' ? 0 : 1);
  {
    const outcome = await lifecycle.prepareTurn(full.scope, current.id, current.text, signal());
    assert.equal(outcome.status, mode === 'enabled' ? 'applied' : 'rejected', outcome.rejectionCode ?? '');
    if (mode !== 'enabled') assert.equal(outcome.rejectionCode, mode === 'disabled' ? 'unread_preservation_support' : 'unresolved_source_disposition');
  }
  assert.equal(calls.length, mode === 'enabled' ? 2 : 1); assert.equal(calls[0]!.sources.length, 25);
  if (mode === 'enabled') {
    assert.equal(calls[1]!.sources.length, 43); assert.equal(calls[1]!.messages.length, 42);
    assert.equal(store.inspect(full.scope, memory.id)!.state, 'deleted'); assert.equal(store.search(full.scope, '团子', 32).length, 0);
    assert.equal(store.visible(full.scope, 'transcript').filter(r => r.fragment).length, 20);
    for (const s of full.sources.filter(s => s.messageRole === 'user' && s.id !== rawId && s.id !== current.id)) assert.equal(store.inspect(full.scope, s.id)!.state, 'active');
  } else { assert.equal(store.revision(full.scope), revision); for (const r of completeClosure.records) assert.deepEqual(store.inspect(full.scope, r.id), r); }
  assert.ok(calls.every(value => quotedUpperBound(value) <= 32768));
});


test('an actually unread target produces no guessed plan or supplementation', async t => {
  const full = completeClosure.input, current = request(full);
  const value: MemoryTurnInput = { ...full, sources: [current], messages: full.messages.filter(m => m.id === current.id), relevantMemories: [] };
  const record = completeClosure.records.find(r => r.id === current.id)!, { store } = restored(t, value, [record]);
  const run = harness(plan({ request: 'forget', reason: '目标本身不可见，不能猜测ID或版本' })), lifecycle = port(store, run.provider, 1);
  await assert.rejects(lifecycle.prepareTurn(value.scope, current.id, current.text, signal()), /no executable targets/);
  assert.equal(run.requests.length, 1); assert.deepEqual(JSON.parse(run.requests[0].messages[1].content).evidence, []);
  assert.deepEqual(store.inspect(value.scope, record.id), record); assert.equal(store.lifecycle.outcome(value.scope, current.id, current.text), null);
});
