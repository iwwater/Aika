import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { TurnScope } from '../../contracts/index.js';
import type { MemoryTurnInput, MemoryTurnPlan } from '../../contracts/memory-lifecycle.js';
import type { MemoryRecord } from '../../memory/ledger.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteLedgerBacking } from '../../memory/sqlite-backing.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { compileMemoryPrototype, prototypeSnapshot, type SemanticDeclaration, type SemanticAssessment, type SemanticEvidence, type FactMeaning } from '../../app/memory-planning-prototype.js';
import { buildMemorySemanticFormat, decodeMemorySemanticDeclaration, MEMORY_SEMANTIC_SYSTEM, type MemorySemanticFormat } from '../../app/memory-semantic-format.js';
import { assertCompiledSemanticPlan, runMemorySemanticAttempt, type SemanticAttemptEvent } from '../../app/memory-semantic-adapter.js';
import { ProviderTransport, type EndpointConfig } from '../../providers/transport.js';

const scope: TurnScope = { characterId: 'companion', sessionId: 'prototype-tests', turnId: 'current', generation: 1 };
const at = '2026-09-01T12:00:00.000Z';
const r = (id: string, version = 1) => ({ id, version });
const kinds = ['transcript', 'memory', 'summary', 'keyword_index', 'vector_index', 'context_cache', 'emotion'] as const;
const quote = (text: string, start?: number) => start === undefined ? { text } : { text, start };
const e = (id: string, text: string, start?: number): SemanticEvidence => ({ source: r(id), quote: quote(text, start) });
const basis = (text = '忘记那件事，保留猫名。') => [e('current', text)];
const removed = (text: string, target: string, evidence = basis(), start?: number) => ({ quote: quote(text, start), target: r(target), basis: evidence });
function record(id: string, text: string, order: number, kind: MemoryRecord['kind'] = 'transcript', sources: string[] = [], role: 'user' | 'assistant' = 'user'): MemoryRecord {
  return { characterId: 'companion', id, kind, version: 1, state: 'active', text, sources: sources.map(id => r(id)), createdAt: at,
    deletedAt: null, reason: null, perception: null, fragment: null, logicalOrder: order, evidenceEligible: true,
    message: kind === 'transcript' ? { characterId: 'companion', id, role, text, createdAt: at } : null };
}
const mixedRecords = () => [record('raw', '忘记的事。猫叫团子。', 1), record('index', '忘记 猫 团子', 2, 'keyword_index', ['raw']), record('current', '忘记那件事，保留猫名。', 3)];
const mixedDraft = (current = '忘记那件事，保留猫名。'): SemanticDeclaration => ({ annotationSource: 'human_controlled', scope, request: 'forget', erase: [r('raw')], facts: [], reason: 'Human control annotation',
  assessments: [{ source: r('raw'), classification: 'mixed', retain: [{ quote: quote('猫叫团子。'), supports: [] }], discard: [removed('忘记的事。', 'raw', basis(current))] },
    { source: r('current'), classification: 'target_only', retain: [], discard: [removed(current, 'raw', basis(current))] }] });

async function harness(t: TestContext, records: MemoryRecord[], recent = 24) {
  const directory = await mkdtemp(join(tmpdir(), 'memory-planning-prototype-')), filename = join(directory, 'state.sqlite');
  let store: SqliteMemoryStore;
  const open = () => new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => at });
  store = open();
  const db = new Database(filename);
  try { db.transaction(() => { for (const value of records) new SqliteLedgerBacking(db, value.characterId).records.set(value.id, value); })(); }
  finally { db.close(); }
  t.after(async () => { if (!store.closed) store.close(); await rm(directory, { recursive: true, force: true }); });
  const all = () => {
    const ids = new Set([...records.map(value => value.id), ...kinds.flatMap(kind => store.visible(scope, kind).map(value => value.id))]);
    return [...ids].sort().map(id => store.inspect(scope, id)).filter((value): value is MemoryRecord => value !== null && value !== undefined);
  };
  const options = { maxRecentMessages: recent, maxMemories: 32, summaryLimit: 8, inputTokenBudget: 32768, countTokens: () => 1 };
  const read = () => store.lifecycle.readTurn(scope, 'current', store.inspect(scope, 'current')!.text, options);
  const port = (provider: { plan(input: MemoryTurnInput, signal: AbortSignal): Promise<MemoryTurnPlan> }) => new SqliteLifecycleMemoryPort(store, {
    context: { ...options, relevance: () => 1 }, turn: { provider, countTokens: () => 1, inputTokenBudget: 32768 },
    summary: { minMessages: 4, maxMessages: 4, inputTokenBudget: 32768, countTokens: () => 1, provider: { async summarize() { throw Error('No summary model'); } } },
  });
  const compile = (draft: SemanticDeclaration, input = read().input, signal = new AbortController().signal) => compileMemoryPrototype(prototypeSnapshot(input, all()), draft, signal);
  const database = () => {
    const connection = new Database(filename, { readonly: true });
    try { return Object.fromEntries((connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => {
      assert.match(name, /^[a-z_]+$/); return [name, connection.prepare(`SELECT * FROM ${name}`).all()];
    })); } finally { connection.close(); }
  };
  return { get store() { return store; }, all, database, read, compile, port, options, reopen() { store.close(); store = open(); } };
}

test('mixed source compiles purely, commits exact remainder, invalidates indexes and survives replay/reopen', async t => {
  const h = await harness(t, mixedRecords()), ticket = h.read(), before = h.all(), draft = mixedDraft();
  const inputCopy = structuredClone(ticket.input), draftCopy = structuredClone(draft);
  const result = h.compile(draft, ticket.input); assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.deepEqual(h.all(), before); assert.deepEqual(ticket.input, inputCopy); assert.deepEqual(draft, draftCopy);
  assert.deepEqual(h.compile(draft, ticket.input), result);
  assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'applied');
  const raw = h.store.visible(scope, 'transcript'); assert.deepEqual(raw.map(value => value.text), ['猫叫团子。']);
  assert.equal(h.store.inspect(scope, 'index')!.state, 'invalidated'); assert.equal(h.store.inspect(scope, 'index')!.text, '');
  const committed = h.all(), noModel = { async plan() { throw Error('Idempotent replay must not replan'); } };
  const replay = await h.port(noModel).prepareTurn(scope, 'current', mixedRecords()[2]!.text, new AbortController().signal);
  assert.equal(replay.status, 'applied'); assert.deepEqual(h.all(), committed);
  h.reopen(); assert.deepEqual(h.all(), committed);
  const context = await h.port(noModel).context({ ...scope, sessionId: 'reopened' }, '猫叫什么？', null, new AbortController().signal);
  assert.ok(JSON.stringify(context.recent).includes('团子')); assert.ok(!JSON.stringify(context.recent).includes('忘记'));
});

test('missing semantic assessment yields no plan or write instead of assuming an unrelated record can be lost', async t => {
  const h = await harness(t, mixedRecords()), before = h.all();
  const result = h.compile({ ...mixedDraft(), assessments: mixedDraft().assessments.slice(1) });
  assert.equal(result.status, 'needs_semantics'); assert.ok(!('plan' in result)); assert.deepEqual(h.all(), before);
});

test('code-point quotes reject ambiguity and preserve the selected repeated Unicode occurrence', async t => {
  const h = await harness(t, [record('raw', '🐈猫。🐈猫。', 1), record('current', '忘记前一次。', 2)]);
  const draft = mixedDraft('忘记前一次。');
  const assess = (start?: number): SemanticAssessment => ({ source: r('raw'), classification: 'mixed', retain: [{ quote: quote('🐈猫。', start), supports: [] }], discard: [removed('🐈猫。', 'raw', basis('忘记前一次。'), 0)] });
  assert.throws(() => h.compile({ ...draft, assessments: [assess(), draft.assessments[1]!] }), /ambiguous_or_inexact_quote/);
  const result = h.compile({ ...draft, assessments: [assess(3), draft.assessments[1]!] });
  assert.equal(result.status, 'ready'); if (result.status === 'ready') assert.deepEqual(result.plan.retainSources?.map(x => [x.start, x.end]), [[3, 6]]);
  assert.throws(() => h.compile({ ...draft, assessments: [assess(4), draft.assessments[1]!] }), /ambiguous_or_inexact_quote/);
});

test('unrelated classification cannot discard part of its text or accept an overlapping remainder', async t => {
  const h = await harness(t, mixedRecords()), draft = mixedDraft(), before = h.all();
  assert.throws(() => h.compile({ ...draft, assessments: [{ ...draft.assessments[0]!, classification: 'unrelated' }, draft.assessments[1]!] }), /incomplete_unrelated_content/);
  assert.throws(() => h.compile({ ...draft, assessments: [{ ...draft.assessments[0]!, retain: [...draft.assessments[0]!.retain, ...draft.assessments[0]!.retain] }, draft.assessments[1]!] }), /overlapping_remainders/);
  assert.deepEqual(h.all(), before);
});

test('unknown memory, wrong source kind, stale version and other-role annotation reject without writes', async t => {
  const h = await harness(t, mixedRecords()), before = h.all(), draft = mixedDraft();
  assert.throws(() => h.compile({ ...draft, facts: [{ intent: 'retire', target: r('m0'), basis: basis() }] }), /unavailable_or_stale_source/);
  assert.throws(() => h.compile({ ...draft, facts: [{ intent: 'retire', target: r('raw'), basis: basis() }] }), /invalid_or_duplicate_memory_target/);
  assert.throws(() => h.compile({ ...draft, erase: [r('raw', 2)] }), /unavailable_or_stale_source/);
  assert.throws(() => h.compile({ ...draft, scope: { ...scope, characterId: 'sweetheart' } }), /annotation_scope_or_origin/);
  assert.deepEqual(h.all(), before); assert.throws(() => h.store.visible({ ...scope, characterId: 'sweetheart' }, 'transcript'), /unknown_character/);
});

test('legacy identity with identical record IDs cannot enter the companion compiler or database', async t => {
  const records = [...mixedRecords(), record('pet', '猫叫团子。', 4, 'memory', ['raw'])];
  const h = await harness(t, records), foreign: TurnScope = { ...scope, characterId: 'sweetheart' };
  const before = h.all(), ticket = h.read();
  const draft: SemanticDeclaration = { ...mixedDraft(), facts: [{ intent: 'revise', target: r('pet'), basis: basis(), statement: '猫叫团子。', evidence: [{ source: r('raw'), quote: quote('猫叫团子。') }] }] };
  assert.throws(() => h.compile({ ...draft, scope: foreign }, ticket.input), /annotation_scope_or_origin/);
  assert.throws(() => h.store.append(foreign, [{characterId:'sweetheart',id:'raw',role:'user',text:'猫叫豆包。',createdAt:at}]), /unknown_character/);
  assert.throws(() => h.store.inspect(foreign, 'pet'), /unknown_character/);
  assert.deepEqual(h.all(), before);
  const result=h.compile(draft,ticket.input);assert.equal(result.status,'ready');if(result.status!=='ready')return;
  assert.equal(h.store.lifecycle.commitTurn(ticket,result.plan).status,'applied');assert.equal(h.store.inspect(scope,'pet')!.version,2);
  const port=h.port({async plan():Promise<MemoryTurnPlan>{throw Error('No model');}}),signal=new AbortController().signal;
  const context=await port.context(scope,'猫叫什么？',null,signal);
  assert.ok(JSON.stringify(context).includes('团子'));assert.ok(!JSON.stringify(context).includes('豆包'));
  await assert.rejects(port.context(foreign,'猫叫什么？',null,signal),/unknown_character/);
});

function closureRecords() {
  return [record('cat', '我的猫叫团子。', 1), record('cat-memory', '猫名团子', 2, 'memory', ['cat']),
    record('u1', '第一项日常安排。', 3), record('a1', '第一项安排的回复。', 4, 'transcript', ['cat', 'u1'], 'assistant'),
    record('u2', '第二项日常安排。', 5), record('a2', '第二项安排的回复。', 6, 'transcript', ['cat', 'u2'], 'assistant'), record('current', '忘记猫。', 7)];
}
function closureDraft(input: MemoryTurnInput): SemanticDeclaration {
  return { annotationSource: 'human_controlled', scope, request: 'forget', erase: [], facts: [{ intent: 'retire', target: r('cat-memory'), basis: basis('忘记猫。') }], reason: 'Controlled unrelated content annotation',
    assessments: input.sources.filter(source => ['cat', 'current', 'a1', 'a2'].includes(source.id)).map(source => source.messageRole === 'assistant'
      ? { source: r(source.id), classification: 'unrelated', retain: [{ quote: quote(source.text), supports: [{ source: r(source.id === 'a1' ? 'u1' : 'u2') }] }], discard: [] }
      : { source: r(source.id), classification: 'target_only', retain: [], discard: [removed(source.text, 'cat-memory', basis('忘记猫。'))] }) };
}

test('necessary-source expansion uses a read-only probe and preserves independent user and assistant contents', async t => {
  const h = await harness(t, closureRecords(), 4), ticket = h.read(), before = h.all();
  const result = h.compile(closureDraft(ticket.input), ticket.input);
  assert.equal(result.status, 'needs_sources'); if (result.status !== 'needs_sources') return;
  assert.ok(result.readProbe); assert.deepEqual(h.all(), before);
  const expansion = h.store.lifecycle.expandTurn(ticket, result.readProbe, h.options);
  assert.equal(expansion.status, 'expanded'); if (expansion.status !== 'expanded') return;
  assert.deepEqual(h.all(), before);
  const ready = h.compile(closureDraft(expansion.ticket.input), expansion.ticket.input);
  assert.equal(ready.status, 'ready'); if (ready.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(expansion.ticket, ready.plan).status, 'applied');
  for (const id of ['u1', 'u2']) assert.deepEqual(h.store.inspect(scope, id), before.find(value => value.id === id));
  for (const [parent, support] of [['a1', 'u1'], ['a2', 'u2']]) {
    const fragment = h.store.visible(scope, 'transcript').find(value => value.fragment?.parent.id === parent)!;
    assert.equal(fragment.text, before.find(value => value.id === parent)!.text); assert.ok(fragment.sources.some(value => value.id === support));
  }
  assert.ok(h.store.visible(scope, 'transcript').every(value => !value.text.includes('猫')));
});

test('a surviving but unrelated support cannot replace the original assistant provenance', async t => {
  const h = await harness(t, closureRecords()), ticket = h.read(), draft = closureDraft(ticket.input), before = h.all();
  const bad = { ...draft, assessments: draft.assessments.map(value => value.source.id === 'a1' ? { ...value, retain: [{ quote: quote('第一项安排的回复。'), supports: [{ source: r('u2') }] }] } : value) };
  assert.throws(() => h.compile(bad, ticket.input), /support_not_in_original_provenance/); assert.deepEqual(h.all(), before);
});

test('expired raw payload is not reopened to preserve a surviving summary', async t => {
  const raw = { ...record('raw', '', 1), state: 'expired' as const };
  const h = await harness(t, [raw, record('summary', '旧事；猫叫团子。', 2, 'summary', ['raw']), record('current', '忘记旧事。', 3)]);
  const draft: SemanticDeclaration = { ...mixedDraft(), erase: [r('summary')], assessments: [{ source: r('summary'), classification: 'mixed', retain: [{ quote: quote('猫叫团子。'), supports: [] }], discard: [removed('旧事；', 'summary', basis('忘记旧事。'))] },
    { source: r('current'), classification: 'target_only', retain: [], discard: [removed('忘记旧事。', 'summary', basis('忘记旧事。'))] }] };
  const ticket = h.read(), result = h.compile(draft, ticket.input); assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'applied');
  assert.deepEqual(h.store.inspect(scope, 'raw'), raw);
  assert.deepEqual(h.store.visible(scope, 'summary').map(value => value.text), ['猫叫团子。']);
});

test('natural consolidation uses supplied equivalence and never merges differently qualified facts', async t => {
  const h = await harness(t, [record('raw', '周五晚练吉他。', 1), record('m1', '每周五晚上练吉他', 2, 'memory', ['raw']), record('m2', '固定练琴时间是周五晚', 3, 'memory', ['raw']), record('current', '练琴前如何热身？', 4)]);
  const friday = (id: string): FactMeaning => ({ fact: 'guitar-practice', factEvidence: [e(id, h.store.inspect(scope, id)!.text)], qualifiers: { weekday: { value: 'Friday', evidence: [e(id, '周五')] }, time: { value: 'evening', evidence: [e(id, '晚')] } } });
  const draft: SemanticDeclaration = { annotationSource: 'human_controlled', scope, request: 'none', erase: [], assessments: [], reason: 'Controlled equivalent meanings', facts: [{ intent: 'consolidate', basis: [e('m1', '每周五晚上练吉他'), e('m2', '固定练琴时间是周五晚')], meaning: friday('raw'), members: [{ target: r('m1'), meaning: friday('m1') }, { target: r('m2'), meaning: friday('m2') }], statement: '每周五晚上练吉他', evidence: [{ source: r('raw') }] }] };
  const before = h.all(), edit = draft.facts[0]!; assert.equal(edit.intent, 'consolidate'); if (edit.intent !== 'consolidate') return;
  const second = edit.members[1]!.meaning;
  assert.throws(() => h.compile({ ...draft, facts: [{ ...edit, members: [edit.members[0]!, { ...edit.members[1]!, meaning: { ...second, qualifiers: { ...second.qualifiers, weekday: { ...second.qualifiers.weekday!, value: 'Saturday' } } } }] }] }), /distinct_qualified_facts/);
  assert.deepEqual(h.all(), before);
  const ticket = h.read(), result = h.compile(draft, ticket.input); assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'applied'); assert.equal(h.store.visible(scope, 'memory').length, 1);
  assert.ok(['m1', 'm2'].every(id => h.store.inspect(scope, id)!.state === 'deleted')); assert.deepEqual(h.store.inspect(scope, 'raw'), before.find(value => value.id === 'raw'));
});

test('natural job revision retires old evidence while retaining the current user statement', async t => {
  const h = await harness(t, [record('old', '我在晨星做设计。', 1), record('job', '在晨星做设计', 2, 'memory', ['old']), record('current', '这周入职青禾做产品设计。', 3)]);
  const ticket = h.read(), draft: SemanticDeclaration = { ...mixedDraft(), request: 'none', erase: [], assessments: [{ source: r('old'), classification: 'target_only', retain: [], discard: [removed('我在晨星做设计。', 'job', basis('这周入职青禾做产品设计。'))] }], facts: [{ intent: 'revise', target: r('job'), basis: basis('这周入职青禾做产品设计。'), statement: '在青禾做产品设计', evidence: [{ source: r('current') }] }] };
  const result = h.compile(draft, ticket.input); assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'applied'); assert.equal(h.store.inspect(scope, 'job')!.version, 2);
  assert.equal(h.store.inspect(scope, 'job')!.text, '在青禾做产品设计'); assert.equal(h.store.inspect(scope, 'current')!.state, 'active'); assert.equal(h.store.inspect(scope, 'old')!.state, 'invalidated');
});

test('new facts can be remembered without a pre-existing memory object', async t => {
  const h = await harness(t, [record('current', '我的猫叫团子。', 1)]), ticket = h.read();
  const draft: SemanticDeclaration = { ...mixedDraft(), request: 'none', erase: [], assessments: [], facts: [{ intent: 'remember', basis: basis('我的猫叫团子。'), statement: '猫叫团子', evidence: [{ source: r('current') }] }] };
  const result = h.compile(draft, ticket.input); assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'applied'); assert.deepEqual(h.store.visible(scope, 'memory').map(x => x.text), ['猫叫团子']);
});

test('stale compiled plans and aborted work never commit over a changed or cancelled turn', async t => {
  const h = await harness(t, mixedRecords()), first = h.read(), second = h.read(), before = h.all();
  const abort = new AbortController(); abort.abort(); assert.throws(() => h.compile(mixedDraft(), first.input, abort.signal)); assert.deepEqual(h.all(), before);
  const ready = h.compile(mixedDraft(), first.input); assert.equal(ready.status, 'ready'); if (ready.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(first, ready.plan).status, 'applied');
  const after = h.all(); const stale = h.store.lifecycle.commitTurn(second, { ...ready.plan, reason: 'Changed payload for old ticket' });
  assert.equal(stale.status, 'rejected'); assert.deepEqual(h.all(), after);
});

test('port cancellation while a local provider is pending leaves all business sources unchanged', async t => {
  const h = await harness(t, mixedRecords()), before = h.all(), abort = new AbortController();
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = h.port({ async plan() { started(); return new Promise<MemoryTurnPlan>((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })); } }).prepareTurn(scope, 'current', mixedRecords()[2]!.text, abort.signal);
  await entered; abort.abort(); await assert.rejects(pending); assert.deepEqual(h.all(), before);
});

test('a false semantic classification is a known limitation, not a programmatically proven correct deletion', async t => {
  const h = await harness(t, mixedRecords()), ticket = h.read();
  const falseAnnotation: SemanticDeclaration = { ...mixedDraft(), assessments: mixedDraft().assessments.map(value => ({ ...value, classification: 'target_only', retain: [], discard: [removed(h.store.inspect(scope, value.source.id)!.text, 'raw')] })) };
  const result = h.compile(falseAnnotation, ticket.input); assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'applied');
  assert.equal(h.store.visible(scope, 'transcript').some(value => value.text.includes('团子')), false, 'Incorrect semantics remain capable of losing the unrelated fact');
});

test('discarded and retained spans must account for the entire original with a declared target and quoted basis', async t => {
  const h = await harness(t, mixedRecords()), before = h.database(), draft = mixedDraft();
  const original = draft.assessments[0]!;
  const check = (assessment: SemanticAssessment, error: RegExp) => {
    assert.throws(() => h.compile({ ...draft, assessments: [assessment, draft.assessments[1]!] }), error);
    assert.deepEqual(h.database(), before);
  };
  check({ ...original, discard: undefined } as unknown as SemanticAssessment, /missing_discard_evidence/);
  check({ ...original, discard: [] }, /incomplete_or_overlapping_source_partition/);
  check({ ...original, discard: [removed('的事。', 'raw')] }, /incomplete_or_overlapping_source_partition/);
  check({ ...original, discard: [removed('忘记的事。猫', 'raw')] }, /incomplete_or_overlapping_source_partition/);
  check({ ...original, discard: [removed('忘记的事。', 'current')] }, /discard_target_not_declared/);
  check({ ...original, discard: [removed('忘记的事。', 'raw', [])] }, /discard_without_evidence/);
  check({ ...original, discard: [removed('忘记的事。', 'raw', [{ source: r('current') }])] }, /discard_requires_quote/);
  check({ ...original, discard: [removed('忘记的事。', 'raw', [{ source: r('current', 2), quote: quote('忘记') }])] }, /unavailable_or_stale_source/);
});

test('completion retirement requires exact evidence and commits without suppressing the completion message', async t => {
  const text = '周末演出已经结束，不用再提醒我练节目了。';
  const h = await harness(t, [record('raw', '提醒我为周末演出练节目。', 1), record('event', '周末演出前练节目', 2, 'memory', ['raw']), record('current', text, 3)]);
  const edit = { intent: 'retire' as const, target: r('event'), basis: basis(text) };
  const draft: SemanticDeclaration = { ...mixedDraft(), request: 'none', erase: [], facts: [edit], assessments: [
    { source: r('raw'), classification: 'target_only', retain: [], discard: [removed('提醒我为周末演出练节目。', 'event', basis(text))] },
  ] };
  const before = h.database();
  for (const invalid of [undefined, [], [{ source: r('current') }], [e('current', '演出取消')]]) {
    assert.throws(() => h.compile({ ...draft, facts: [{ ...edit, basis: invalid }] } as unknown as SemanticDeclaration), /action_without_evidence|action_requires_quote|ambiguous_or_inexact_quote/);
    assert.deepEqual(h.database(), before);
  }
  const ticket = h.read(), result = h.compile(draft, ticket.input); assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'applied');
  assert.equal(h.store.inspect(scope, 'event')!.state, 'deleted'); assert.equal(h.store.inspect(scope, 'raw')!.state, 'invalidated');
  assert.equal(h.store.inspect(scope, 'current')!.text, text); assert.equal(h.store.inspect(scope, 'current')!.state, 'active');
});

function meaningFixture() {
  const records = [record('r1', '周五晚上练吉他。', 1), record('m1', '周五晚上练吉他。', 2, 'memory', ['r1']),
    record('r2', '周六晚上练吉他。', 3), record('m2', '周六晚上练吉他。', 4, 'memory', ['r2']), record('current', '帮我整理练琴安排。', 5)];
  const meaning = (id: string, actualDay: string, declaredDay = actualDay): FactMeaning => ({ fact: 'guitar-practice', factEvidence: [e(id, '练吉他')],
    qualifiers: { weekday: { value: declaredDay, evidence: [e(id, actualDay)] }, time: { value: 'evening', evidence: [e(id, '晚上')] } } });
  const edit = { intent: 'consolidate' as const, basis: basis('帮我整理练琴安排。'), statement: '周五晚上练吉他。', evidence: [e('r1', '周五晚上练吉他。')],
    meaning: meaning('r1', '周五'), members: [{ target: r('m1'), meaning: meaning('m1', '周五') }, { target: r('m2'), meaning: meaning('m2', '周六', '周五') }] };
  const draft: SemanticDeclaration = { ...mixedDraft(), request: 'none', erase: [], assessments: [], facts: [edit] };
  return { records, edit, draft };
}

test('merge facts and declared qualifiers require exact evidence from each member', async t => {
  const { records, edit, draft } = meaningFixture(), h = await harness(t, records), before = h.database();
  const member = edit.members[1]!, original = member.meaning;
  const invalid: [FactMeaning, RegExp][] = [
    [{ ...original, factEvidence: [] }, /fact_meaning_without_evidence/],
    [{ ...original, qualifiers: undefined } as unknown as FactMeaning, /invalid_fact_meaning/],
    [{ ...original, qualifiers: { weekday: { value: '周五', evidence: [] } } }, /qualifier_without_evidence/],
    [{ ...original, qualifiers: { weekday: { value: '周五', evidence: [{ source: r('m2') }] } } }, /qualifier_requires_quote/],
    [{ ...original, factEvidence: [e('m1', '练吉他')] }, /meaning_evidence_not_member/],
    [{ ...original, qualifiers: { ...original.qualifiers, weekday: { value: '周五', evidence: [e('m2', '周五')] } } }, /ambiguous_or_inexact_quote/],
  ];
  for (const [meaning, error] of invalid) {
    assert.throws(() => h.compile({ ...draft, facts: [{ ...edit, members: [edit.members[0]!, { ...member, meaning }] }] }), error);
    assert.deepEqual(h.database(), before);
  }
});

test('exact quotes cannot prove false equivalence labels or completeness of an explicitly empty qualifier set', async t => {
  const { records, edit, draft } = meaningFixture(), h = await harness(t, records);
  // Actual Friday and Saturday quotes are valid; the human has falsely labelled both Friday.
  const result = h.compile(draft); assert.equal(result.status, 'ready');
  const unqualified = { ...edit, meaning: { ...edit.meaning, qualifiers: {} }, members: edit.members.map(member => ({ ...member, meaning: { ...member.meaning, qualifiers: {} } })) };
  const ticket = h.read(), omitted = h.compile({ ...draft, facts: [unqualified] }, ticket.input);
  assert.equal(omitted.status, 'ready'); if (omitted.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(ticket, omitted.plan).status, 'applied');
  assert.deepEqual(h.store.visible(scope, 'memory').map(value => value.text), ['周五晚上练吉他。']);
  assert.equal(h.store.inspect(scope, 'm2')!.state, 'deleted', 'Valid structural evidence still permits this incorrect semantic merge');
});

test('unresolved intention returns clarification and commits with zero changes to every SQLite table', async t => {
  const h = await harness(t, [record('raw', '猫叫团子。狗叫豆包。', 1), record('current', '忘记它的名字吧。', 2)]);
  const draft: SemanticDeclaration = { ...mixedDraft(), erase: [], facts: [], assessments: [], unresolved: { question: '你是指猫还是狗的名字？', basis: basis('忘记它的名字吧。') } };
  const before = h.database();
  for (let attempt = 0; attempt < 2; attempt++) {
    const ticket = h.read(), result = h.compile(draft, ticket.input);
    assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
    assert.deepEqual(result.plan.changes, []); assert.deepEqual(result.plan.suppressSources, []); assert.deepEqual(result.plan.retainSources, []);
    assert.equal(result.plan.clarification, draft.unresolved!.question);
    assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'needs_clarification');
    assert.deepEqual(h.database(), before, 'Even turn-outcome rows must remain unchanged for clarification');
  }
});

test('unresolved intention cannot include guessed mutations or hide missing input behind a question', async t => {
  const h = await harness(t, mixedRecords()), before = h.database();
  const unresolved = { question: '你是指哪件事？', basis: basis() };
  const draft: SemanticDeclaration = { ...mixedDraft(), erase: [], assessments: [], unresolved };
  for (const invalid of [{ ...draft, erase: [r('raw')] }, { ...draft, assessments: mixedDraft().assessments },
    { ...draft, facts: [{ intent: 'remember', basis: basis(), statement: '猜测', evidence: basis() }] },
    { ...draft, unresolved: { ...unresolved, question: ' ' } }, { ...draft, unresolved: { ...unresolved, basis: [] } },
    { ...draft, unresolved: { ...unresolved, basis: [e('unread', '缺少的原文')] } }]) {
    assert.throws(() => h.compile(invalid as SemanticDeclaration), /unresolved_with_mutations_or_empty_question|unresolved_intent_without_evidence|unavailable_or_stale_source/);
    assert.deepEqual(h.database(), before);
  }
  const { unresolved: _unresolved, ...withoutQuestion } = draft;
  const ordinary = h.compile({ ...withoutQuestion, request: 'none' });
  assert.equal(ordinary.status, 'ready'); if (ordinary.status === 'ready') assert.equal(ordinary.plan.clarification, null);
  const missing = h.compile({ ...mixedDraft(), assessments: [] });
  assert.equal(missing.status, 'needs_semantics'); assert.ok(!('plan' in missing)); assert.deepEqual(h.database(), before);
});

test('quoted action evidence still cannot establish that the replacement statement is entailed', async t => {
  const h = await harness(t, [record('current', '我去青禾面试了。', 1)]), ticket = h.read();
  const draft: SemanticDeclaration = { ...mixedDraft(), request: 'none', erase: [], assessments: [], facts: [
    { intent: 'remember', basis: basis('我去青禾面试了。'), statement: '用户已入职青禾。', evidence: [e('current', '我去青禾面试了。')] },
  ] };
  const result = h.compile(draft, ticket.input); assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'applied');
  assert.deepEqual(h.store.visible(scope, 'memory').map(value => value.text), ['用户已入职青禾。'], 'This exact-quote counterexample is a semantic failure, not accepted employment truth');
});

test('action evidence cannot read a payload merely because its graph metadata is known', async t => {
  const h = await harness(t, [record('unread', '旧记录的原文。', 1), record('current', '聊聊今天吧。', 2)], 1);
  const before = h.database(), ticket = h.read();
  assert.ok(!ticket.input.sources.some(value => value.id === 'unread'));
  assert.throws(() => h.compile({ ...mixedDraft(), request: 'none', erase: [], assessments: [], facts: [
    { intent: 'remember', basis: [e('unread', '旧记录的原文。')], statement: '旧记录', evidence: [e('current', '聊聊今天吧。')] },
  ] }, ticket.input), /source_not_read/);
  assert.deepEqual(h.database(), before);
});

test('membership in original provenance does not prove that a partial support set entails the whole remainder', async t => {
  const records = closureRecords().map(value => value.id === 'u1' ? record('u1', '第一项安排要先签到。', 3)
    : value.id === 'u2' ? record('u2', '还要带证件。', 5)
    : value.id === 'a1' ? record('a1', '第一项安排要先签到，还要带证件。', 4, 'transcript', ['cat', 'u1', 'u2'], 'assistant') : value);
  const h = await harness(t, records), ticket = h.read(), draft = closureDraft(ticket.input);
  const result = h.compile(draft, ticket.input); assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'applied');
  const remainder = h.store.visible(scope, 'transcript').find(value => value.fragment?.parent.id === 'a1')!;
  assert.equal(remainder.text, '第一项安排要先签到，还要带证件。');
  assert.deepEqual(remainder.sources.filter(value => ['u1', 'u2'].includes(value.id)), [r('u1')], 'u2 is semantically needed but the structural guard cannot establish that');
});

// The only annotation-to-wire encoder is test-local. Production never loads gold declarations.
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
function semanticWire(draft: SemanticDeclaration, format: MemorySemanticFormat): any {
  const aliases = new Map<string, string>();
  const rows = (format.wire.data() as { sources: { id: string; sourceVersions: { id: string; version: number }[] }[] }).sources;
  for (const row of rows) {
    const source = format.wire.source(row.id); aliases.set(source.id, row.id);
    row.sourceVersions.forEach((ref, index) => aliases.set(source.sourceVersions[index]!.id, ref.id));
  }
  const encode = (value: any): any => {
    if (Array.isArray(value)) return value.map(encode);
    if (!value || typeof value !== 'object') return value;
    if ('id' in value && 'version' in value && Object.keys(value).length === 2) {
      assert.ok(aliases.has(value.id), `No test wire alias for ${value.id}`); return { id: aliases.get(value.id), version: value.version };
    }
    if ('source' in value && Object.keys(value).every(k => ['source', 'quote'].includes(k))) return { source: encode(value.source), quote: value.quote ? encode(value.quote) : null };
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  };
  const { annotationSource: _origin, scope: _scope, ...declaration } = mapHumanQuotes(draft, format, humanQuoteWire);
  return { ...encode(declaration), unresolved: declaration.unresolved ? encode(declaration.unresolved) : null };
}
function semanticTransport(reply: unknown, events: SemanticAttemptEvent[] = []) {
  let calls = 0, keys = 0, permits = 0;
  const requests: any[] = [];
  const config: EndpointConfig = { endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash',
    apiKey: () => { keys++; return 'offline-placeholder-only'; }, authorizer: { async authorize() { permits++; return { async settle() {} }; } } };
  const transport = new ProviderTransport(async (_url, init) => {
    calls++; requests.push(JSON.parse(String(init?.body)));
    return Response.json({ model: config.model, system_fingerprint: 'controlled', choices: [{ finish_reason: 'stop', message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  return { config, transport, requests, get calls() { return calls; }, get keys() { return keys; }, get permits() { return permits; },
    provenance: { kind: 'controlled_stub' as const, runId: 'offline-unit', attemptId: '1' }, signal: new AbortController().signal,
    evidence: async (event: SemanticAttemptEvent) => { events.push(structuredClone(event)); } };
}

test('semantic adapter uses host origin, preserves exact request/raw response and compiles without any database write', async t => {
  const h = await harness(t, mixedRecords()), input = h.read().input, snapshot = prototypeSnapshot(input, h.all());
  const format = buildMemorySemanticFormat(input), reply = semanticWire(mixedDraft(), format), events: SemanticAttemptEvent[] = [];
  const net = semanticTransport(reply, events), before = h.database();
  const result = await runMemorySemanticAttempt({ ...net, snapshot });
  assert.equal(net.calls, 1); assert.equal(result.declaration.annotationSource, 'model_evaluation'); assert.equal(result.compiled.status, 'ready');
  assert.deepEqual(h.database(), before); assert.deepEqual(events.map(e => e.type), ['request', 'response', 'declaration', 'compiled']);
  assert.ok(events.every(e => e.provenance.kind === 'controlled_stub'));
  const requested = events[0]!.data as any, response = events[1]!.data as any;
  assert.deepEqual(requested.request, net.requests[0]); assert.equal(requested.requestJson, JSON.stringify(net.requests[0]));
  assert.equal(requested.requestBytes, Buffer.byteLength(requested.requestJson));
  assert.equal(format.inputUpperBound, Buffer.byteLength(format.system) + Buffer.byteLength(JSON.stringify(format.data)) + 2048);
  assert.equal(requested.inputUpperBound, format.inputUpperBound); assert.equal(response.content, JSON.stringify(reply));
  assert.deepEqual(response.raw.choices[0].message.content, JSON.stringify(reply));
  assert.deepEqual(Object.keys(net.requests[0]).sort(), ['messages', 'model', 'response_format', 'stream', 'thinking']);
  assert.equal(JSON.stringify(requested).includes('offline-placeholder-only'), false);
  assert.equal(JSON.stringify(format.data).includes('annotationSource'), false);
  assert.equal(Object.hasOwn(net.requests[0], 'graph'), false);
  assert.throws(() => decodeMemorySemanticDeclaration({ ...reply, annotationSource: 'human_controlled' }, format), /fields/);
});

test('semantic decoder rejects malformed nested declarations without supplying defaults or dropping fields', async t => {
  const h = await harness(t, mixedRecords()), format = buildMemorySemanticFormat(h.read().input), original = semanticWire(mixedDraft(), format);
  const bad = (mutate: (value: any) => void, match: RegExp) => { const value = structuredClone(original); mutate(value); assert.throws(() => decodeMemorySemanticDeclaration(value, format), match); };
  bad(v => { delete v.unresolved; }, /fields/);
  bad(v => { v.scope = scope; }, /fields/);
  bad(v => { v.facts = {}; }, /array/);
  bad(v => { v.erase[0].version = '1'; }, /version/);
  bad(v => { v.erase[0].version++; }, /Stale/);
  bad(v => { v.assessments[0].classification = 'safe'; }, /classification/);
  bad(v => { v.assessments[0].discard[0].basis = []; }, /evidence required/);
  bad(v => { v.assessments[0].discard[0].basis[0].quote = null; }, /requires an exact quote/);
  bad(v => { v.assessments[0].discard[0].quote.extra = true; }, /fields/);
  bad(v => { v.assessments[0].retain[0].quote.start = '5'; }, /fields/);
  bad(v => { v.assessments[0].retain[0].quote.text = '猫叫豆包。'; }, /inexact/);
  bad(v => { v.assessments.push(v.assessments[0]); }, /repeated semantic assessment/);
  bad(v => { v.assessments[0].discard[0].target = v.assessments[1].source; }, /Undeclared/);
  bad(v => { v.facts = [{ intent: 'retire', target: v.erase[0], basis: v.assessments[0].discard[0].basis }]; }, /kind/);
  bad(v => { v.unresolved = { question: '什么？', basis: v.assessments[0].discard[0].basis }; }, /cannot include mutations/);
  assert.deepEqual(decodeMemorySemanticDeclaration(original, format), { ...mixedDraft(), annotationSource: 'model_evaluation' });
});

test('human comparison only omits exact full-source zero with matching source id and version', async t => {
  const h = await harness(t, mixedRecords()), format = buildMemorySemanticFormat(h.read().input), draft = mixedDraft();
  const full: any = structuredClone(draft); full.assessments[1]!.discard[0]!.quote = { ...full.assessments[1]!.discard[0]!.quote, start: 0 };
  const original = structuredClone(full);
  assert.deepEqual(normalizedWholeSourceQuotes(full, format), draft); assert.deepEqual(full, original);
  for (const mutate of [
    (v: any) => { v.assessments[1].discard[0].quote.start = 1; },
    (v: any) => { v.assessments[1].discard[0].quote.text = '忘记'; },
    (v: any) => { v.assessments[1].discard[0].quote.text += ' '; },
    (v: any) => { v.assessments[1].source.id = 'raw'; },
    (v: any) => { v.assessments[1].source.id = 'absent'; },
    (v: any) => { v.assessments[1].source.version++; },
    (v: any) => { delete v.assessments[1].source.version; },
    (v: any) => { delete v.assessments[1].source; },
  ]) {
    const changed = structuredClone(full); mutate(changed);
    assert.deepEqual(normalizedWholeSourceQuotes(changed, format), changed);
    assert.notDeepEqual(normalizedWholeSourceQuotes(changed, format), draft);
  }
});

test('semantic context-v2 selects repeated Unicode occurrences without model offsets', async t => {
  const h = await harness(t, [record('raw', '🐈猫。🐈猫。', 1), record('current', '忘记前一次。', 2)]), input = h.read().input, before = h.database();
  const draft: SemanticDeclaration = { ...mixedDraft('忘记前一次。'), assessments: [{ source: r('raw'), classification: 'mixed', retain: [{ quote: quote('🐈猫。', 3), supports: [] }], discard: [removed('🐈猫。', 'raw', basis('忘记前一次。'), 0)] }, mixedDraft('忘记前一次。').assessments[1]!] };
  const format = buildMemorySemanticFormat(input), wire = semanticWire(draft, format);
  assert.deepEqual(wire.assessments[0].retain[0].quote, { text: '🐈猫。', context: { before: '🐈猫。', after: '' } });
  assert.deepEqual(wire.assessments[0].discard[0].quote, { text: '🐈猫。', context: { before: '', after: '🐈猫。' } });
  const valid = decodeMemorySemanticDeclaration(wire, format), compiled = h.compile(valid, input);
  assert.deepEqual(valid, { ...draft, annotationSource: 'model_evaluation' });
  assert.equal(compiled.status, 'ready'); if (compiled.status === 'ready') assert.deepEqual(compiled.plan.retainSources?.map(r => [r.start, r.end, [...format.known.get(r.source.id)!.text].slice(r.start, r.end).join('')]), [[3, 6, '🐈猫。']]);
  // Swap only the chosen spans: either repeated occurrence remains representable.
  const first = structuredClone(wire);
  [first.assessments[0].retain[0].quote, first.assessments[0].discard[0].quote] = [first.assessments[0].discard[0].quote, first.assessments[0].retain[0].quote];
  const firstPlan = h.compile(decodeMemorySemanticDeclaration(first, format), input);
  assert.equal(firstPlan.status, 'ready'); if (firstPlan.status === 'ready') assert.deepEqual(firstPlan.plan.retainSources?.map(r => [r.start, r.end]), [[0, 3]]);
  const badQuotes = [
    { text: '🐈猫。', context: null }, { text: '🐈猫。', context: { before: '', after: '' } },
    { text: '🐈猫。', context: { before: '猫', after: '' } }, { text: '🐈猫。', context: { before: '', after: '。' } },
    { text: '🐈猫。', context: { before: '🐈猫。🐈猫。', after: '' } },
    { text: '🐈猫. ', context: { before: '🐈猫。', after: '' } },
    ...[null, 0, 3, 4, -1, 3.5].map(start => ({ text: '🐈猫。', start })),
    { text: '🐈猫。', context: { before: '🐈猫。', after: '' }, start: 3 },
  ];
  for (const quote of badQuotes) {
    const bad = structuredClone(wire); bad.assessments[0].retain[0].quote = quote;
    assert.throws(() => decodeMemorySemanticDeclaration(bad, format), /quote|fields/, JSON.stringify(quote));
  }
  const triples = await harness(t, [record('raw', '🐈猫。🐈猫。🐈猫。', 1), record('current', '忘记前一次。', 2)]);
  const three = buildMemorySemanticFormat(triples.read().input);
  assert.throws(() => decodeMemorySemanticDeclaration(wire, three), /Ambiguous.*quote/);
  assert.deepEqual(h.database(), before);
});

test('semantic context-v2 checks unique anchors, exact whitespace, fields and same-source adjacency', async t => {
  const raw = '🐈前 猫。\t后', h = await harness(t, [record('raw', raw, 1), record('other', '外 猫。', 2), ...mixedRecords().slice(-1)]), input = h.read().input;
  const draft: SemanticDeclaration = { ...mixedDraft(), assessments: [{ source: r('raw'), classification: 'mixed', retain: [{ quote: quote('猫。'), supports: [] }],
    discard: [removed('🐈前 ', 'raw'), removed('\t后', 'raw')] }, mixedDraft().assessments[1]!] };
  const format = buildMemorySemanticFormat(input), wire = semanticWire(draft, format), before = h.database();
  assert.ok(format.system.includes('context-v2')); assert.ok(!format.system.includes('Quote Q is exactly {text,start}'));
  for (const context of [null, { before: '🐈前 ', after: '\t后' }, { before: ' ', after: '' }, { before: '', after: '\t' }]) {
    const value = structuredClone(wire); value.assessments[0].retain[0].quote.context = context;
    const declaration = decodeMemorySemanticDeclaration(value, format), result = h.compile(declaration, input);
    assert.deepEqual(declaration.assessments[0]!.retain[0]!.quote, context === null ? { text: '猫。' } : { text: '猫。', start: 3 });
    assert.equal(result.status, 'ready'); if (result.status === 'ready') assert.deepEqual(result.plan.retainSources?.map(r => [r.start, r.end, [...format.known.get(r.source.id)!.text].slice(r.start, r.end).join('')]), [[3, 5, '猫。']]);
  }
  const badQuotes = [
    { text: '猫。' }, { text: '猫。', context: undefined }, { text: '猫。', context: {} },
    ...[0, false, '', [], { before: '' }, { after: '' }, { before: '', after: '' }, { before: null, after: '\t' }, { before: ' ', after: 0 },
      { before: ' ', after: '', extra: true }, { before: '  ', after: '' }, { before: '', after: ' 后' },
      { before: '🐈前', after: '' }, { before: '', after: '后' }, { before: '外 ', after: '' },
      { before: '前\u00a0', after: '' }, { before: '🐈前 ', after: 'wrong' }].map(context => ({ text: '猫。', context })),
    ...['猫', '猫．', '猫。 ', '不存在'].map(text => ({ text, context: { before: '🐈前 ', after: '\t后' } })),
  ];
  for (const quote of badQuotes) {
    const bad = structuredClone(wire); bad.assessments[0].retain[0].quote = quote;
    assert.throws(() => decodeMemorySemanticDeclaration(bad, format), /quote|fields|object/, JSON.stringify(quote));
  }
  assert.deepEqual(h.database(), before);
});

test('semantic metadata supports allow necessary reads but forbid unread text, wrong child, wrong version and basis promotion', async t => {
  const h = await harness(t, closureRecords(), 4), ticket = h.read(), format = buildMemorySemanticFormat(ticket.input), before = h.database();
  const wire = semanticWire(closureDraft(ticket.input), format), assistant = wire.assessments.find((a: any) => a.retain.length && a.retain[0].supports[0].source.id.startsWith('u'));
  assert.ok(assistant); const pending = assistant.retain[0].supports[0].source;
  const first = h.compile(decodeMemorySemanticDeclaration(wire, format), ticket.input);
  assert.equal(first.status, 'needs_sources'); assert.deepEqual(h.database(), before);
  const badQuote = structuredClone(wire); badQuote.assessments.find((a: any) => a.source.id === assistant.source.id).retain[0].supports[0].quote = { text: 'invented unread', start: null };
  assert.throws(() => decodeMemorySemanticDeclaration(badQuote, format), /Unread semantic support/);
  const badVersion = structuredClone(wire); badVersion.assessments.find((a: any) => a.source.id === assistant.source.id).retain[0].supports[0].source.version++;
  assert.throws(() => decodeMemorySemanticDeclaration(badVersion, format), /original child provenance/);
  const badBasis = structuredClone(wire); badBasis.facts[0].basis[0].source = pending;
  assert.throws(() => decodeMemorySemanticDeclaration(badBasis, format), /Unknown wire source/);
  const badStatement = structuredClone(wire); badStatement.facts.push({ intent: 'remember', statement: 'invented', evidence: [{ source: pending, quote: null }], basis: badStatement.facts[0].basis });
  assert.throws(() => decodeMemorySemanticDeclaration(badStatement, format), /Unknown wire source/);
  const badChild = structuredClone(wire); badChild.assessments.find((a: any) => a.source.id !== assistant.source.id && a.retain.length).retain[0].supports = [{ source: pending, quote: null }];
  assert.throws(() => decodeMemorySemanticDeclaration(badChild, format), /original child provenance/);
  if (first.status !== 'needs_sources' || !first.readProbe) return;
  const expansion = h.store.lifecycle.expandTurn(ticket, first.readProbe, h.options); assert.equal(expansion.status, 'expanded'); assert.deepEqual(h.database(), before);
  if (expansion.status !== 'expanded') return;
  const full = buildMemorySemanticFormat(expansion.ticket.input);
  const final = h.compile(decodeMemorySemanticDeclaration(semanticWire(closureDraft(expansion.ticket.input), full), full), expansion.ticket.input);
  assert.equal(final.status, 'ready'); if (final.status === 'ready') assertCompiledSemanticPlan(final.plan, full);
  assert.throws(() => decodeMemorySemanticDeclaration(wire, full)); assert.deepEqual(h.database(), before);
});

test('semantic model path preserves missing-semantics status and rejects extra unaffected assessments without a second call', async t => {
  const h = await harness(t, [...mixedRecords(), record('extra', '无关且未受影响。', 2)]), input = h.read().input, format = buildMemorySemanticFormat(input);
  const snapshot = prototypeSnapshot(input, h.all()), before = h.database();
  const missing = semanticWire({ ...mixedDraft(), assessments: mixedDraft().assessments.slice(1) }, format), net = semanticTransport(missing);
  const result = await runMemorySemanticAttempt({ ...net, snapshot }); assert.equal(result.compiled.status, 'needs_semantics'); assert.equal(net.calls, 1);
  const extra = semanticWire({ ...mixedDraft(), assessments: [...mixedDraft().assessments, { source: r('extra'), classification: 'unrelated', retain: [{ quote: quote('无关且未受影响。'), supports: [] }], discard: [] }] }, format);
  const invalid = semanticTransport(extra); await assert.rejects(runMemorySemanticAttempt({ ...invalid, snapshot }), /unexpected_source_assessment/); assert.equal(invalid.calls, 1);
  assert.deepEqual(h.database(), before);
});

test('semantic normal no-op, explicit unresolved intention and forged host origin remain distinct', async t => {
  const h = await harness(t, mixedRecords()), input = h.read().input, format = buildMemorySemanticFormat(input), before = h.database();
  const noop: SemanticDeclaration = { annotationSource: 'human_controlled', scope, request: 'none', reason: 'No maintenance needed', erase: [], facts: [], assessments: [] };
  const valid = decodeMemorySemanticDeclaration(semanticWire(noop, format), format), ordinary = h.compile(valid, input);
  const unclear = decodeMemorySemanticDeclaration(semanticWire({ ...noop, request: 'forget', unresolved: { question: '哪件事？', basis: basis() } }, format), format), resolved = h.compile(unclear, input);
  assert.equal(ordinary.status, 'ready'); assert.equal(resolved.status, 'ready');
  if (ordinary.status === 'ready' && resolved.status === 'ready') { assert.equal(ordinary.plan.clarification, null); assert.equal(resolved.plan.clarification, '哪件事？'); assertCompiledSemanticPlan(resolved.plan, format); }
  assert.throws(() => h.compile({ ...noop, annotationSource: 'real_verified' as any }), /annotation_scope_or_origin/);
  assert.deepEqual(h.database(), before);
});

test('semantic adapter freezes caller input and shields execution from evidence-consumer mutations', async t => {
  const h = await harness(t, mixedRecords()), input = h.read().input, snapshot = prototypeSnapshot(input, h.all()), format = buildMemorySemanticFormat(input);
  const net = semanticTransport(semanticWire(mixedDraft(), format)), before = h.database();
  const result = await runMemorySemanticAttempt({ ...net, snapshot, evidence: async event => {
    if (event.type === 'request') { (snapshot.input.sources[0] as any).text = 'caller changed'; (event.data as any).body.messages[0].content = 'sink changed'; (snapshot.graph[0] as any).version = 99; }
  } });
  assert.equal(net.requests[0].messages[0].content, MEMORY_SEMANTIC_SYSTEM); assert.equal(result.compiled.status, 'ready'); assert.deepEqual(h.database(), before);
});

test('semantic cancellation before a call or during request evidence prevents key access and fetch', async t => {
  const h = await harness(t, mixedRecords()), snapshot = prototypeSnapshot(h.read().input, h.all());
  for (const already of [true, false]) {
    const controller = new AbortController(), net = semanticTransport({}); if (already) controller.abort();
    await assert.rejects(runMemorySemanticAttempt({ ...net, snapshot, signal: controller.signal, evidence: async e => { if (e.type === 'request') controller.abort(); } }), { name: 'AbortError' });
    assert.equal(net.calls, 0); assert.equal(net.keys, 0); assert.equal(net.permits, 0);
  }
});

test('semantic late transport result cannot compile into a cancelled turn or contaminate another scope', async t => {
  const h = await harness(t, mixedRecords()), snapshot = prototypeSnapshot(h.read().input, h.all()), format = buildMemorySemanticFormat(snapshot.input), reply = semanticWire(mixedDraft(), format);
  const controller = new AbortController(), events: SemanticAttemptEvent[] = [], net = semanticTransport(reply, events), before = h.database();
  const transport = new ProviderTransport(async () => { controller.abort(); return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }] }); });
  await assert.rejects(runMemorySemanticAttempt({ ...net, snapshot, signal: controller.signal, transport }), { name: 'AbortError' });
  assert.equal(events.filter(e => e.type === 'compiled').length, 0); assert.deepEqual(h.database(), before);
  assert.throws(() => buildMemorySemanticFormat({ ...snapshot.input, scope: { ...scope, characterId: 'sweetheart' } }), /different turn|Cross-character/);
});

for (const failure of ['bad-json', 'extra-field', 'length', 'http-401', 'http-429', 'http-500']) {
  test(`semantic ${failure} failure retains available raw evidence and never retries`, async t => {
    const h = await harness(t, mixedRecords()), snapshot = prototypeSnapshot(h.read().input, h.all()), format = buildMemorySemanticFormat(snapshot.input);
    const events: SemanticAttemptEvent[] = [], net = semanticTransport({}, events), original = semanticWire(mixedDraft(), format); let calls = 0;
    const text = failure === 'bad-json' ? '{' : JSON.stringify({ ...original, ...(failure === 'extra-field' ? { autoFixed: true } : {}) });
    const transport = new ProviderTransport(async () => { calls++; return failure.startsWith('http-') ? new Response('', { status: Number(failure.slice(5)) }) : Response.json({ choices: [{ finish_reason: failure === 'length' ? 'length' : 'stop', message: { content: text } }] }); });
    await assert.rejects(runMemorySemanticAttempt({ ...net, snapshot, transport })); assert.equal(calls, 1);
    assert.equal(events.at(-1)?.type, 'failure'); assert.equal(events.filter(e => e.type === 'compiled').length, 0);
    if (!failure.startsWith('http-')) { const event = events.find(e => e.type === 'response')!; assert.equal((event.data as any).content, text); assert.ok(events.indexOf(event) < events.length - 1); }
  });
}

test('semantic input overflow and failed request evidence stop before key access', async t => {
  const h = await harness(t, mixedRecords()), snapshot = prototypeSnapshot(h.read().input, h.all());
  const oversized = structuredClone(snapshot), current = oversized.input.sources.find(s => s.id === oversized.input.currentMessageId)!;
  (current as any).text = '过长'.repeat(20000); (oversized.input.messages.find(m => m.id === current.id) as any).text = current.text;
  const huge = semanticTransport({}); await assert.rejects(runMemorySemanticAttempt({ ...huge, snapshot: oversized }), /input budget/); assert.equal(huge.keys, 0);
  const net = semanticTransport({}); await assert.rejects(runMemorySemanticAttempt({ ...net, snapshot, evidence: async e => { if (e.type === 'request') throw Error('Evidence disk unavailable'); } }), /Evidence disk unavailable/); assert.equal(net.keys, 0);
});

test('compiled semantic plan must pass explicit-request, source, duplicate and retention guards', async t => {
  const records = [...mixedRecords(), record('mem', '已有事实。', 4, 'memory', ['raw'])], h = await harness(t, records), input = h.read().input, format = buildMemorySemanticFormat(input);
  const noop: MemoryTurnPlan = { scope, request: 'none', changes: [], suppressSources: [], retainSources: [], clarification: null, reason: 'Guard regression' };
  assertCompiledSemanticPlan(noop, format);
  assert.throws(() => assertCompiledSemanticPlan({ ...noop, request: 'forget' }, format), /no executable targets/);
  const add = { scope, operationId: 'test:add', reason: 'explicit', createdAt: at, operation: { type: 'add' as const, id: 'new', text: '已有事实。', sourceIds: ['current'] } };
  assert.throws(() => assertCompiledSemanticPlan({ ...noop, changes: [add] }, format), /Identical memory/);
  const change = { ...add, operation: { type: 'soft_delete' as const, id: 'mem', expectedVersion: 1 } };
  assert.throws(() => assertCompiledSemanticPlan({ ...noop, changes: [change, { ...change, operationId: 'another' }] }, format), /Repeated memory plan target/);
  assert.throws(() => assertCompiledSemanticPlan({ ...noop, clarification: '哪条？', changes: [change] }, format), /Clarification cannot/);
  assert.throws(() => assertCompiledSemanticPlan({ ...noop, request: 'forget', changes: [change] }, format), /handle its current message/);
  assert.throws(() => assertCompiledSemanticPlan({ ...noop, request: 'correction', suppressSources: [r('current')] }, format), /retain current evidence/);
  assert.throws(() => assertCompiledSemanticPlan({ ...noop, changes: [{ ...add, operation: { ...add.operation, text: '新的事实', sourceIds: ['missing'] } }] }, format), /unavailable source/);
});

const semanticOriginalPins = {
  "raw-only": "bea10be165568be9b90d0158342af8b8ba542eb709950ab74eafa0dd1e29a62a",
  "summary-only": "a0bb6499c796fefc41ce46e22ffe6b36f84777904730d61d3b86b5cc8a9f442c",
  "closure": "f98425d5b9b35c7c2290d472c408e2d78b68d727419532472b9265d3ea08f01a",
  "merge": "2709b03367f1c12c51d0bb37b76eb53f91142517e6b93230cc3abcb1907e6a04",
  "retire": "9c2eec6d7899929d2ed2c659230ae55bdd5c6399767659e313004bd1fa19d7c8",
  "mixed-memory": "628c8ac7bd285aa6210c24247051d02857662913a0b732d715177f824c5a2ab9",
  "echo": "5d81d7f31bdc4c9aa6a6be7fd7dab33febd27f4a3df088acdc3ce06f0c7cdbd3",
  "retire-recall": "550f82aea4efb1c3bb650208834b06048012416dd78d02450bbddd3d222d257c",
  "natural-update": "2a58e77ea1bfb2ee5403abdb2dc81d4d989c5ad85dc1fa92dc5d8a3f0da9c7f4"
} as const;

test('original nine controlled declarations retain exact wire qualification and original 25-to-43 boundary', { skip: !process.env.W2_SEMANTIC_ORIGINALS }, async t => {
  const receipts: unknown[] = [];
  for (const [id, pin] of Object.entries(semanticOriginalPins)) {
    const bytes = await readFile(join(process.env.W2_SEMANTIC_ORIGINALS!, `${id}.json`));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pin);
    const original = JSON.parse(bytes.toString());
    for (const [index, trace] of original.traces.entries()) {
      const format = buildMemorySemanticFormat(trace.input), reply = semanticWire(trace.declaration, format), events: SemanticAttemptEvent[] = [];
      const net = semanticTransport(reply, events), snapshot = prototypeSnapshot(trace.input, original.sourcesBefore);
      const result = await runMemorySemanticAttempt({ ...net, snapshot });
      assert.deepEqual(normalizedWholeSourceQuotes(result.declaration, format), normalizedWholeSourceQuotes({ ...trace.declaration, annotationSource: 'model_evaluation' }, format));
      assert.deepEqual(result.compiled, trace.compiled);
      assert.equal(net.calls, 1); assert.ok(format.inputUpperBound <= 32768);
      if (id === 'closure' && index === 0) {
        assert.equal(format.input.sources.length, 25); assert.equal(result.compiled.status, 'needs_sources');
        if (result.compiled.status === 'needs_sources') { assert.equal(result.compiled.sources.length, 18); assert.ok(result.compiled.readProbe); }
        const readIds = new Set(format.input.sources.map(s => s.id));
        const metadata = format.input.sources.flatMap(s => (s.sourceVersions ?? []).filter(p => !readIds.has(p.id)));
        assert.equal(metadata.length, 207); assert.equal(new Set(metadata.map(p => p.id)).size, 18);
      } else assert.equal(result.compiled.status, 'ready');
      receipts.push({ id, index, originalSha256: pin, sourceCount: format.input.sources.length, compiledStatus: result.compiled.status, systemBytes: format.systemBytes, dataBytes: format.dataBytes,
        inputUpperBound: format.inputUpperBound, requestBytes: (events[0]!.data as any).requestBytes, requestSha256: (events[0]!.data as any).requestSha256,
        systemSha256: createHash('sha256').update(format.system).digest('hex'), responseExact: (events[1]!.data as any).content === JSON.stringify(reply), evidence: 'controlled_stub; no network, no SQLite commit, no semantic model guarantee' });
    }
  }
  t.diagnostic(JSON.stringify(receipts));
  if (process.env.W2_SEMANTIC_RECEIPT) await writeFile(process.env.W2_SEMANTIC_RECEIPT, JSON.stringify(receipts, null, 2) + '\n');
});

test('model declaration keeps member quote requirements and does not convert semantic counterexamples into acceptance', async t => {
  const { records, draft } = meaningFixture(), h = await harness(t, records), format = buildMemorySemanticFormat(h.read().input);
  const falseMeaning = semanticWire(draft, format), before = h.database();
  for (const mutate of [
    (v: any) => { delete v.facts[0].members[0].meaning.factEvidence; },
    (v: any) => { v.facts[0].members[0].meaning.qualifiers.weekday.evidence = []; },
    (v: any) => { v.facts[0].members[0].meaning.factEvidence[0].source = v.facts[0].members[1].target; },
    (v: any) => { v.facts[0].members[0].meaning.qualifiers.weekday.evidence[0].quote = null; },
  ]) { const bad = structuredClone(falseMeaning); mutate(bad); assert.throws(() => decodeMemorySemanticDeclaration(bad, format)); }
  const parsed = decodeMemorySemanticDeclaration(falseMeaning, format);
  const falselyMerged = h.compile(parsed); assert.equal(falselyMerged.status, 'ready');
  if (falselyMerged.status === 'ready') assertCompiledSemanticPlan(falselyMerged.plan, format);
  const missingQualifiers = structuredClone(falseMeaning); missingQualifiers.facts[0].meaning.qualifiers = {};
  for (const member of missingQualifiers.facts[0].members) member.meaning.qualifiers = {};
  assert.equal(h.compile(decodeMemorySemanticDeclaration(missingQualifiers, format)).status, 'ready');
  t.diagnostic('False equivalence/omitted qualifiers still compile: semantic failure remains OPEN, no acceptance claimed.');
  assert.deepEqual(h.database(), before);
});

test('model path keeps exact-quote non-entailment as a semantic failure even when its plan is structurally valid', async t => {
  const h = await harness(t, [record('current', '我去青禾面试了。', 1)]), input = h.read().input, format = buildMemorySemanticFormat(input);
  const draft: SemanticDeclaration = { ...mixedDraft(), request: 'none', erase: [], assessments: [], facts: [{ intent: 'remember', statement: '用户已入职青禾。', basis: basis('我去青禾面试了。'), evidence: [e('current', '我去青禾面试了。')] }] };
  const net = semanticTransport(semanticWire(draft, format)), before = h.database();
  const result = await runMemorySemanticAttempt({ ...net, snapshot: prototypeSnapshot(input, h.all()) });
  assert.equal(result.compiled.status, 'ready'); assert.deepEqual(h.database(), before);
  t.diagnostic('Interview does not entail employment. Exact quote + compiled ready remains a semantic counterexample.');
});

test('semantic supports can cite two retained pieces of one original parent without duplicating an identical support', async t => {
  const records = [record('raw', '删掉。甲。乙。', 1), record('reply', '甲和乙都需要。', 2, 'transcript', ['raw'], 'assistant'), record('current', '只忘记删掉。', 3)];
  const h = await harness(t, records), input = h.read().input, format = buildMemorySemanticFormat(input);
  const draft: SemanticDeclaration = { ...mixedDraft('只忘记删掉。'), assessments: [
    { source: r('raw'), classification: 'mixed', retain: [{ quote: quote('甲。'), supports: [] }, { quote: quote('乙。'), supports: [] }], discard: [removed('删掉。', 'raw', basis('只忘记删掉。'))] },
    { source: r('reply'), classification: 'unrelated', retain: [{ quote: quote('甲和乙都需要。'), supports: [e('raw', '甲。'), e('raw', '乙。')] }], discard: [] },
    mixedDraft('只忘记删掉。').assessments[1]!,
  ] };
  const wire = semanticWire(draft, format), result = h.compile(decodeMemorySemanticDeclaration(wire, format), input);
  assert.equal(result.status, 'ready'); if (result.status === 'ready') {
    assertCompiledSemanticPlan(result.plan, format);
    assert.equal(result.plan.retainSources?.find(r => r.source.id === 'reply')?.supportSourceIds.length, 2);
  }
  const repeated = structuredClone(wire); repeated.assessments[1].retain[0].supports.push(repeated.assessments[1].retain[0].supports[0]);
  assert.throws(() => decodeMemorySemanticDeclaration(repeated, format), /Duplicate semantic support/);
});

test('semantic decoder and compiler retain display-only, graph-version and cross-role refusal', async t => {
  const h = await harness(t, closureRecords()), input = h.read().input, snapshot = prototypeSnapshot(input, h.all()), format = buildMemorySemanticFormat(input);
  const original = semanticWire(closureDraft(input), format), before = h.database();
  const display = structuredClone(input); (display.sources.find(s => s.id === 'a1') as any).evidenceEligible = false;
  assert.throws(() => decodeMemorySemanticDeclaration(original, buildMemorySemanticFormat(display)), /ineligible/);
  const decoded = decodeMemorySemanticDeclaration(original, format);
  for (const mutate of [
    (value: any) => { value.graph.find((s: any) => s.id === 'u1').version++; },
    (value: any) => { value.graph.find((s: any) => s.id === 'u1').state = 'expired'; },
    (value: any) => { value.graph.find((s: any) => s.id === 'u1').eligible = false; },
    (value: any) => { value.graph.find((s: any) => s.id === 'u1').characterId = 'sweetheart'; },
  ]) { const bad = structuredClone(snapshot); mutate(bad); assert.throws(() => compileMemoryPrototype(bad, decoded, new AbortController().signal), /unavailable_or_stale_source|graph_scope_or_duplicate/); }
  assert.deepEqual(h.database(), before);
});

test('fact evidence binding keeps one entire retained fragment for exact and interior Unicode quotes', async t => {
  const prefix = '🐈删掉。', kept = '「猫e\u0301\n\t叫团子🐾。」';
  for (const text of [kept, '猫e\u0301\n\t叫团子🐾', '团子']) {
    const h = await harness(t, [record('raw', prefix + kept, 1), record('current', '忘记那件事，保留猫名。', 2)]);
    const ticket = h.read(), before = h.database();
    const draft: SemanticDeclaration = { ...mixedDraft(), assessments: [
      { source: r('raw'), classification: 'mixed', retain: [{ quote: quote(kept), supports: [] }], discard: [removed(prefix, 'raw')] },
      mixedDraft().assessments[1]!,
    ], facts: [{ intent: 'remember', statement: '猫叫团子。', basis: basis(), evidence: [e('raw', text)] }] };
    const result = h.compile(draft, ticket.input), exact = h.compile({ ...draft, facts: [{ intent: 'remember', statement: '猫叫团子。', basis: basis(), evidence: [e('raw', kept)] }] }, ticket.input);
    assert.equal(result.status, 'ready'); if (result.status !== 'ready') continue;
    assert.deepEqual(result, exact); assert.deepEqual(h.database(), before);
    assert.deepEqual(result.plan.retainSources?.map(x => [x.source, x.start, x.end]), [[r('raw'), [...prefix].length, [...prefix + kept].length]]);
    assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'applied');
    const fragments = h.store.visible(scope, 'transcript'), memory = h.store.visible(scope, 'memory');
    assert.equal(fragments.length, 1); assert.deepEqual(Buffer.from(fragments[0]!.text), Buffer.from(kept));
    assert.deepEqual(memory[0]!.sources, [r(fragments[0]!.id)]);
    h.reopen(); assert.deepEqual(h.store.visible(scope, 'transcript'), fragments); assert.deepEqual(h.store.visible(scope, 'memory'), memory);
  }
});

test('fact evidence binding refuses partial overlap, discarded gaps, adjacent-fragment unions and normalization', async t => {
  const h = await harness(t, [record('raw', '甲。丢。乙。丙。e\u0301\n', 1), mixedRecords()[2]!]), before = h.database();
  const draft: SemanticDeclaration = { ...mixedDraft(), assessments: [
    { source: r('raw'), classification: 'mixed', retain: ['甲。', '乙。', '丙。', 'e\u0301\n'].map(text => ({ quote: quote(text), supports: [] })), discard: [removed('丢。', 'raw')] },
    mixedDraft().assessments[1]!,
  ] };
  const cases: [SemanticEvidence, RegExp][] = [
    [{ source: r('raw') }, /affected_evidence_requires_retained_quote/],
    ...['丢。', '。丢', '丢。乙', '甲。丢。乙。', '乙。丙。', '甲。丢。乙。丙。e\u0301\n'].map(text => [e('raw', text), /evidence_not_retained/] as [SemanticEvidence, RegExp]),
    ...['甲。乙。', 'é', 'e\u0301 ', ''].map(text => [e('raw', text), /ambiguous_or_inexact_quote|empty_quote/] as [SemanticEvidence, RegExp]),
  ];
  for (const [evidence, error] of cases) {
    assert.throws(() => h.compile({ ...draft, facts: [{ intent: 'remember', statement: '候选事实', basis: basis(), evidence: [evidence] }] }), error);
    assert.deepEqual(h.database(), before);
  }
});

test('fact evidence binding never substitutes another repeated occurrence or another source', async t => {
  const current = '忘记前一次。', h = await harness(t, [record('raw', '🐈猫。🐈猫。', 1), record('other', '🐈猫。', 2), record('current', current, 3)]);
  const draft: SemanticDeclaration = { ...mixedDraft(current), erase: [r('raw'), r('other')], assessments: [
    { source: r('raw'), classification: 'mixed', retain: [{ quote: quote('🐈猫。', 3), supports: [] }], discard: [removed('🐈猫。', 'raw', basis(current), 0)] },
    { source: r('other'), classification: 'target_only', retain: [], discard: [removed('🐈猫。', 'other', basis(current))] },
    mixedDraft(current).assessments[1]!,
  ] };
  const withEvidence = (evidence: SemanticEvidence): SemanticDeclaration => ({ ...draft, facts: [{ intent: 'remember', statement: '猫。', basis: basis(current), evidence: [evidence] }] });
  const before = h.database();
  assert.equal(h.compile(withEvidence(e('raw', '猫', 4))).status, 'ready');
  for (const [evidence, error] of [
    [e('raw', '猫', 1), /evidence_not_retained/], [e('raw', '猫'), /ambiguous_or_inexact_quote/],
    [e('raw', '猫', 5), /ambiguous_or_inexact_quote/], [e('other', '猫'), /evidence_not_retained/],
  ] as const) assert.throws(() => h.compile(withEvidence(evidence)), error);
  assert.deepEqual(h.database(), before);
});

test('fact evidence binding preserves version, eligibility, role, scope and read-state refusal', async t => {
  const h = await harness(t, mixedRecords()), input = h.read().input, snapshot = prototypeSnapshot(input, h.all()), before = h.database();
  const draft: SemanticDeclaration = { ...mixedDraft(), facts: [{ intent: 'remember', statement: '猫叫团子。', basis: basis(), evidence: [e('raw', '团子')] }] };
  assert.equal(h.compile(draft, input).status, 'ready');
  const cases: [string, (value: any) => void, RegExp][] = [
    ['stale graph', s => s.graph.find((x: any) => x.id === 'raw').version++, /unavailable_or_stale_source/],
    ...['expired', 'deleted', 'invalidated'].map(state => [state, (s: any) => { s.graph.find((x: any) => x.id === 'raw').state = state; }, /unavailable_or_stale_source/] as [string, (value: any) => void, RegExp]),
    ['ineligible graph', s => { s.graph.find((x: any) => x.id === 'raw').eligible = false; }, /unavailable_or_stale_source/],
    ['display-only payload', s => { s.input.sources.find((x: any) => x.id === 'raw').evidenceEligible = false; }, /source_not_read/],
    ['other role', s => { s.graph.find((x: any) => x.id === 'raw').characterId = 'sweetheart'; }, /graph_scope_or_duplicate/],
    ...['characterId', 'sessionId', 'turnId', 'generation'].map(field => [field, (s: any) => { const source = s.input.sources.find((x: any) => x.id === 'raw'); source.scope = { ...source.scope, [field]: field === 'generation' ? 2 : 'other' }; }, /input_graph_mismatch/] as [string, (value: any) => void, RegExp]),
    ['unread payload', s => { s.input.sources = s.input.sources.filter((x: any) => x.id !== 'raw'); }, /source_not_read/],
    ['unavailable graph', s => { s.graph = s.graph.filter((x: any) => x.id !== 'raw'); }, /unavailable_or_stale_source/],
  ];
  for (const [name, mutate, error] of cases) {
    const bad = structuredClone(snapshot); mutate(bad);
    assert.throws(() => compileMemoryPrototype(bad, draft, new AbortController().signal), error, name);
  }
  assert.throws(() => h.compile({ ...draft, facts: [{ intent: 'remember', statement: '猫叫团子。', basis: basis(), evidence: [{ source: r('raw', 2), quote: quote('团子') }] }] }, input), /unavailable_or_stale_source/);
  assert.deepEqual(h.database(), before);
});

test('fact evidence binding applies to revision and consolidation without changing member-meaning checks', async t => {
  for (const intent of ['revise', 'consolidate'] as const) {
    const ids = intent === 'revise' ? ['m1'] : ['m1', 'm2'];
    const h = await harness(t, [...mixedRecords(), ...ids.map((id, index) => record(id, '猫叫团子。', index + 4, 'memory', ['raw']))]);
    const fact = { statement: '猫叫团子。', basis: basis(), evidence: [e('raw', '团子')] };
    const meaning = (id: string): FactMeaning => ({ fact: '猫名', factEvidence: [e(id, '团子')], qualifiers: {} });
    const draft: SemanticDeclaration = { ...mixedDraft(), facts: intent === 'revise' ? [{ intent, target: r('m1'), ...fact }] : [
      { intent, members: ids.map(id => ({ target: r(id), meaning: meaning(id) })), meaning: meaning('raw'), ...fact },
    ] };
    const ticket = h.read(), result = h.compile(draft, ticket.input); assert.equal(result.status, 'ready'); if (result.status !== 'ready') continue;
    assert.equal(h.store.lifecycle.commitTurn(ticket, result.plan).status, 'applied');
    const memory = h.store.visible(scope, 'memory'), fragment = h.store.visible(scope, 'transcript')[0]!;
    assert.equal(memory.length, 1); assert.equal(memory[0]!.text, '猫叫团子。'); assert.deepEqual(memory[0]!.sources, [r(fragment.id)]);
  }
});

test('fact evidence binding leaves derived supports exact for every support position', async t => {
  const current = '只忘记删掉。', records = [record('raw', '删掉。甲。乙。', 1), record('reply', '甲和乙都需要。', 2, 'transcript', ['raw'], 'assistant'), record('current', current, 3)];
  const h = await harness(t, records), before = h.database();
  const reply: SemanticAssessment = { source: r('reply'), classification: 'unrelated', retain: [{ quote: quote('甲和乙都需要。'), supports: [e('raw', '甲。'), e('raw', '乙。')] }], discard: [] };
  const draft: SemanticDeclaration = { ...mixedDraft(current), assessments: [
    { source: r('raw'), classification: 'mixed', retain: ['甲。', '乙。'].map(text => ({ quote: quote(text), supports: [] })), discard: [removed('删掉。', 'raw', basis(current))] },
    reply, mixedDraft(current).assessments[1]!,
  ], facts: [{ intent: 'remember', statement: '甲和乙都需要。', basis: basis(current), evidence: [e('reply', '甲和乙')] }] };
  const result = h.compile(draft); assert.equal(result.status, 'ready');
  for (const index of [0, 1]) {
    const supports = reply.retain[0]!.supports.map((item, i) => i === index ? e('raw', index === 0 ? '甲' : '乙') : item);
    const changed = { ...reply, retain: [{ ...reply.retain[0]!, supports }] };
    assert.throws(() => h.compile({ ...draft, assessments: [draft.assessments[0]!, changed, draft.assessments[2]!] }), /evidence_not_retained/);
  }
  assert.deepEqual(h.database(), before);
});

test('fact evidence binding compiles the complete unchanged batch05 final without opening its database', { skip: !process.env.W2_SEMANTIC_BINDING_BATCH05 }, async () => {
  const root = process.env.W2_SEMANTIC_BINDING_BATCH05!, run = join(root, 'runs/semantic-pro-high-300s-20260909-05-raw');
  const wire = JSON.parse((await readFile(join(run, 'wire-responses.jsonl'), 'utf8')).trim());
  const raw = Buffer.from(wire.rawBase64, 'base64');
  assert.equal(createHash('sha256').update(raw).digest('hex'), '402c5f33e229c35c3bad3a3e07e08ed11a0d431a4a2056583715ba72421d8278');
  const content = JSON.parse(raw.toString('utf8')).choices[0].message.content;
  assert.equal(Buffer.byteLength(content), 2000);
  const audit = JSON.parse(await readFile(join(root, 'response-audit.json'), 'utf8'));
  const original = JSON.parse(await readFile(join(run, 'result.json'), 'utf8')), trace = original.traces[0];
  const final = JSON.parse(content); assert.deepEqual(final, audit.finalContent);
  const format = buildMemorySemanticFormat(trace.input), decoded = decodeMemorySemanticDeclaration(final, format);
  assert.deepEqual(decoded, audit.decodedDeclaration);
  const result = compileMemoryPrototype({ input: trace.input, graph: trace.graph }, decoded, new AbortController().signal);
  assert.equal(result.status, 'ready'); if (result.status !== 'ready') return;
  assertCompiledSemanticPlan(result.plan, format);
  const fact = decoded.facts[0]!; assert.equal(fact.intent, 'remember'); if (fact.intent !== 'remember') return;
  const retained = result.plan.retainSources!.find(x => x.source.id === fact.evidence[0]!.source.id)!;
  assert.deepEqual([retained.start, retained.end], [15, 23]);
  const operation = result.plan.changes[0]!.operation;
  assert.equal(operation.type, 'add'); if (operation.type === 'add') assert.deepEqual(operation.sourceIds, [retained.fragmentId]);
  assert.deepEqual(final, audit.finalContent);
});

test('current instruction controls preserve sole facts and distinct events through exact fragments', async t => {
  const cases = [
    { target: '那次面试失败', kept: '我不喝茶，只在周末喝无糖咖啡，也许下月才改变。', query: '我什么时候喝什么？' },
    { target: '甲公司的面试失败', kept: '乙公司的面试可能在周五，别忘了。', query: '乙公司的面试什么时候？' },
  ];
  for (const value of cases) {
    const prefix = `忘记${value.target}；`, current = prefix + value.kept, raw = `${value.target}让我难过。`;
    const h = await harness(t, [record('raw', raw, 1), record('current', current, 2)]), ticket = h.read(), before = h.database();
    const draft: SemanticDeclaration = { ...mixedDraft(current), assessments: [
      { source: r('raw'), classification: 'target_only', retain: [], discard: [removed(raw, 'raw', basis(current))] },
      { source: r('current'), classification: 'mixed', retain: [{ quote: quote(value.kept), supports: [] }], discard: [removed(prefix, 'raw', basis(current))] },
    ], facts: [{ intent: 'remember', statement: value.kept, basis: basis(current), evidence: [e('current', value.kept)] }] };
    const format = buildMemorySemanticFormat(ticket.input), net = semanticTransport(semanticWire(draft, format));
    const result = await runMemorySemanticAttempt({ ...net, snapshot: prototypeSnapshot(ticket.input, h.all()) });
    assert.equal(result.compiled.status, 'ready'); if (result.compiled.status !== 'ready') continue;
    assert.deepEqual(h.database(), before);
    assert.equal(h.store.lifecycle.commitTurn(ticket, result.compiled.plan).status, 'applied');
    const kept = h.store.visible(scope, 'transcript'); assert.equal(kept.length, 1);
    assert.deepEqual(Buffer.from(kept[0]!.text), Buffer.from(value.kept));
    assert.deepEqual(kept[0]!.fragment, { parent: r('current'), start: [...prefix].length, end: [...current].length });
    assert.deepEqual(h.store.visible(scope, 'memory')[0]!.sources, [r(kept[0]!.id)]);
    const noModel = { async plan(): Promise<MemoryTurnPlan> { throw Error('No new planning'); } };
    const context = await h.port(noModel).context(scope, value.query, null, new AbortController().signal);
    const payload = JSON.stringify({ recent: context.recent, memories: context.memories, summary: context.summary });
    assert.ok(!payload.includes(value.target)); assert.ok(payload.includes(value.kept));
    h.reopen(); const reopened = await h.port(noModel).context(scope, value.query, null, new AbortController().signal);
    assert.deepEqual(reopened, context);
  }
  t.diagnostic('Injected human declarations prove exact preservation and context behavior, not model understanding of the prompt.');
});

test('current instruction controls leave historical commands and negated reminders as none', async t => {
  for (const current of ['今天只想聊咖啡。', '不要忘记乙公司的面试。']) {
    const h = await harness(t, [record('history', '忘记甲公司的面试失败。', 1), record('current', current, 2)]), ticket = h.read(), before = h.all();
    const draft: SemanticDeclaration = { annotationSource: 'human_controlled', scope, request: 'none', erase: [], facts: [], assessments: [], reason: 'Controlled current intent, not replay of a historical command' };
    const format = buildMemorySemanticFormat(ticket.input), result = await runMemorySemanticAttempt({ ...semanticTransport(semanticWire(draft, format)), snapshot: prototypeSnapshot(ticket.input, h.all()) });
    assert.equal(result.compiled.status, 'ready'); if (result.compiled.status !== 'ready') continue;
    assert.deepEqual(result.compiled.plan.changes, []); assert.deepEqual(result.compiled.plan.suppressSources, []);
    assert.equal(h.store.lifecycle.commitTurn(ticket, result.compiled.plan).status, 'unchanged');
    assert.deepEqual(h.all(), before);
  }
});

test('current instruction controls preserve correction evidence and an unrelated negation', async t => {
  const current = '猫现在叫糯米；我不喝茶。';
  const h = await harness(t, [record('old', '猫叫团子。', 1), record('cat', '猫叫团子。', 2, 'memory', ['old']), record('current', current, 3)]), ticket = h.read();
  const draft: SemanticDeclaration = { ...mixedDraft(current), request: 'correction', erase: [r('old'), r('current')], assessments: [
    { source: r('old'), classification: 'target_only', retain: [], discard: [removed('猫叫团子。', 'old', basis(current))] },
    { source: r('current'), classification: 'unrelated', retain: ['猫现在叫糯米；', '我不喝茶。'].map(text => ({ quote: quote(text), supports: [] })), discard: [] },
  ], facts: [{ intent: 'revise', target: r('cat'), statement: '猫叫糯米。', evidence: [e('current', '猫现在叫糯米')], basis: basis(current) }] };
  const format = buildMemorySemanticFormat(ticket.input), result = await runMemorySemanticAttempt({ ...semanticTransport(semanticWire(draft, format)), snapshot: prototypeSnapshot(ticket.input, h.all()) });
  assert.equal(result.compiled.status, 'ready'); if (result.compiled.status !== 'ready') return;
  assert.equal(h.store.lifecycle.commitTurn(ticket, result.compiled.plan).status, 'applied');
  assert.equal(h.store.inspect(scope, 'cat')!.text, '猫叫糯米。');
  const fragments = h.store.visible(scope, 'transcript');
  assert.deepEqual(fragments.map(x => x.text).sort(), ['我不喝茶。', '猫现在叫糯米；'].sort());
  const catFragment = fragments.find(x => x.text === '猫现在叫糯米；')!;
  assert.deepEqual(h.store.inspect(scope, 'cat')!.sources, [r(catFragment.id)]);
  const noModel = { async plan(): Promise<MemoryTurnPlan> { throw Error('No new planning'); } };
  const context = await h.port(noModel).context(scope, '猫叫什么，我喝茶吗？', null, new AbortController().signal);
  assert.ok(JSON.stringify(context).includes('我不喝茶。')); assert.ok(!JSON.stringify(context).includes('团子'));
});

test('current instruction old complete 03 and 06 outputs remain structurally valid semantic failures', { skip: !process.env.W2_SEMANTIC_CURRENT_ROOT }, async t => {
  const root = process.env.W2_SEMANTIC_CURRENT_ROOT!;
  const { loadMemoryTrial, assertMemoryTrialResult } = await import('../../app/memory-trial.js');
  const originals = await loadMemoryTrial(root, 'known'), fixture = originals.cases.find(x => x.id === 'raw-only')!;
  for (const [batch, runId, expectedSha] of [
    ['03', 'semantic-pro-20260909-03-raw', '50ad452392e912e1618590d3449a0182345d650ff76daa214bf996637201e51b'],
    ['06', 'semantic-binding-pro-high-300s-20260909-06-raw', 'a7361e19f9b9bd2142d198516c9b5abe20fc1f70639a4f8bb60685a2696f7fe4'],
  ]) {
    const run = join(root, `.local/semantic-batches/memory-semantic-batch-20260909-${batch}/runs/${runId}`);
    const original = JSON.parse(await readFile(join(run, 'result.json'), 'utf8'));
    const wire = JSON.parse((await readFile(join(run, 'wire-responses.jsonl'), 'utf8')).trim()), raw = Buffer.from(wire.rawBase64, 'base64');
    assert.equal(createHash('sha256').update(raw).digest('hex'), expectedSha);
    const content = JSON.parse(raw.toString('utf8')).choices[0].message.content, trace = original.traces[0];
    assert.deepEqual(trace.input, fixture.input);
    const net = semanticTransport(content), result = await runMemorySemanticAttempt({ ...net, snapshot: { input: trace.input, graph: trace.graph } });
    assert.deepEqual(result.declaration, trace.declaration); assert.deepEqual(result.compiled, trace.compiled);
    assert.equal(result.compiled.status, 'ready'); assert.equal(original.outcome.status, 'applied');
    assert.throws(() => assertMemoryTrialResult(fixture, original.outcome, original.sourcesAfter, original.activeAfter, original.contextAfter), /Target remains in active sources/);
    t.diagnostic(`${batch}: unchanged full final compiles; recorded original active/context still fail original criteria. No original database opened or replayed.`);
  }
});
