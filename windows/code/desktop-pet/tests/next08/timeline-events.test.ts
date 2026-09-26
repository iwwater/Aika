/**
 * tests/next08/timeline-events.test.ts
 *
 * 08-01 Acceptance Test Suite:
 * Validates domain event routing (CompanionEventHub) and cross-domain UnifiedTimelineService.
 *
 * AC-0801-1: Domain isolation (Canon, Companion, Work)
 * AC-0801-2: Idempotent projection and conflict rejection
 * AC-0801-3: Out-of-order event ordering resilience
 * AC-0801-4: Pairing / tenant isolation
 * AC-0801-5: Revocation and forgetting propagation
 * AC-0801-6: Restart outbox recovery
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionEventHub } from '../../core/companion-event-hub.js';
import { UnifiedTimelineService } from '../../memory/unified-timeline.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { CompanionEventEnvelope } from '../../contracts/perception.js';

async function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'timeline-0801-test-'));
  const dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  const characterPacks = await CharacterPackStore.open(db);
  const timelineService = new UnifiedTimelineService(db, characterPacks);
  const eventHub = new CompanionEventHub();

  const cleanup = () => {
    try { db.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  };

  return { dir, db, characterPacks, timelineService, eventHub, cleanup };
}

test('AC-0801-1: Domain isolation - Work, Companion, and Canon maintain strict boundaries', async t => {
  const f = await createFixture();
  t.after(f.cleanup);

  const pairing = productionPairing('companion', 'inst-alpha');
  const now = new Date('2026-09-23T12:00:00.000Z').toISOString();

  // 1. Record Companion event
  const companionEnv: CompanionEventEnvelope = {
    eventId: 'evt-companion-001',
    schemaVersion: 1,
    domain: 'companion',
    type: 'companion.turn.saved',
    pairing,
    turnId: 'turn-1',
    sourceRef: { id: 'turn-1', version: 1 },
    occurredAt: now,
    receivedAt: now,
    payload: { userText: '今天天气真好', assistantText: '是呀，适合出门散步。' },
    summary: '今天天气真好',
  };
  await f.timelineService.recordEvent(companionEnv);

  // 2. Record Work event
  const workEnv: CompanionEventEnvelope = {
    eventId: 'evt-work-001',
    schemaVersion: 1,
    domain: 'work',
    type: 'work.task.receipt',
    pairing,
    sourceRef: { id: 'task-101', version: 1 },
    occurredAt: new Date('2026-09-23T12:05:00.000Z').toISOString(),
    receivedAt: new Date('2026-09-23T12:05:00.000Z').toISOString(),
    payload: { executorId: 'codex', taskId: 'task-101', status: 'succeeded', title: '编译静态资源', instruction: 'npm run build' },
    summary: '执行代码编译任务',
  };
  await f.timelineService.recordEvent(workEnv);

  // Query ONLY companion domain
  const compQuery = await f.timelineService.queryTimeline({ pairing, domains: ['companion'] });
  assert.equal(compQuery.items.length, 1);
  assert.equal(compQuery.items[0]?.domain, 'companion');
  assert.equal(compQuery.items[0]?.companionDetails?.userText, '今天天气真好');
  assert.equal(compQuery.items[0]?.workDetails, undefined, 'Work details must not appear in companion domain');

  // Query ONLY work domain
  const workQuery = await f.timelineService.queryTimeline({ pairing, domains: ['work'] });
  assert.equal(workQuery.items.length, 1);
  assert.equal(workQuery.items[0]?.domain, 'work');
  assert.equal(workQuery.items[0]?.workDetails?.executorId, 'codex');
  assert.equal(workQuery.items[0]?.companionDetails, undefined, 'Companion details must not appear in work domain');

  // Query ALL domains
  const allQuery = await f.timelineService.queryTimeline({ pairing });
  assert.equal(allQuery.items.length, 2);
});

test('AC-0801-2: Idempotent projection and conflict detection', async t => {
  const f = await createFixture();
  t.after(f.cleanup);

  const pairing = productionPairing('companion', 'inst-alpha');
  const now = new Date('2026-09-23T12:00:00.000Z').toISOString();

  const workEnv: CompanionEventEnvelope = {
    eventId: 'evt-work-idem-1',
    schemaVersion: 1,
    domain: 'work',
    type: 'work.task.receipt',
    pairing,
    sourceRef: { id: 'task-idem', version: 1 },
    occurredAt: now,
    receivedAt: now,
    payload: { executorId: 'acp', taskId: 'task-idem', status: 'running', title: '分析项目依赖', instruction: 'analyze' },
    summary: '分析项目依赖',
  };

  const first = await f.timelineService.recordEvent(workEnv);
  assert.equal(first, 'inserted');

  // Replaying identical event must return duplicate
  const duplicate = await f.timelineService.recordEvent(workEnv);
  assert.equal(duplicate, 'duplicate');

  // Divergent payload on same eventId must throw conflict error
  const conflictingEnv: CompanionEventEnvelope = {
    ...workEnv,
    payload: { executorId: 'acp', taskId: 'task-idem', status: 'failed', title: '已改变的标题', instruction: 'different' },
  };
  await assert.rejects(
    async () => f.timelineService.recordEvent(conflictingEnv),
    /conflict/i,
    'Conflicting event on same eventId must throw',
  );
});

test('Work timeline refuses a receipt without an explicit execution status', async t => {
  const f = await createFixture();
  t.after(f.cleanup);
  const now = new Date('2026-09-23T12:00:00.000Z').toISOString();
  const event: CompanionEventEnvelope = {
    eventId: 'evt-work-missing-status',
    schemaVersion: 1,
    domain: 'work',
    type: 'work.task.receipt',
    pairing: productionPairing('companion', 'inst-alpha'),
    sourceRef: { id: 'task-missing-status', version: 1 },
    occurredAt: now,
    receivedAt: now,
    payload: { executorId: 'acp', taskId: 'task-missing-status', title: 'Unknown result' },
    summary: 'Work result not supplied',
  };
  await assert.rejects(() => f.timelineService.recordEvent(event), /valid execution status is required/);
});

test('AC-0801-3: Out-of-order event ordering resilience', async t => {
  const f = await createFixture();
  t.after(f.cleanup);

  const pairing = productionPairing('companion', 'inst-alpha');

  // Insert events in reverse arrival order: 12:10 first, then 12:00, then 12:05
  const t1 = '2026-09-23T12:00:00.000Z';
  const t2 = '2026-09-23T12:05:00.000Z';
  const t3 = '2026-09-23T12:10:00.000Z';

  await f.timelineService.recordEvent({
    eventId: 'evt-order-3', schemaVersion: 1, domain: 'companion', type: 'companion.turn.saved',
    pairing, sourceRef: { id: 's3', version: 1 }, occurredAt: t3, receivedAt: t3,
    payload: { userText: '第三句话 (12:10)' }, summary: '第三句话',
  });

  await f.timelineService.recordEvent({
    eventId: 'evt-order-1', schemaVersion: 1, domain: 'companion', type: 'companion.turn.saved',
    pairing, sourceRef: { id: 's1', version: 1 }, occurredAt: t1, receivedAt: t1,
    payload: { userText: '第一句话 (12:00)' }, summary: '第一句话',
  });

  await f.timelineService.recordEvent({
    eventId: 'evt-order-2', schemaVersion: 1, domain: 'companion', type: 'companion.turn.saved',
    pairing, sourceRef: { id: 's2', version: 1 }, occurredAt: t2, receivedAt: t2,
    payload: { userText: '第二句话 (12:05)' }, summary: '第二句话',
  });

  const query = await f.timelineService.queryTimeline({ pairing, domains: ['companion'] });
  assert.equal(query.items.length, 3);
  assert.equal(query.items[0]?.eventId, 'evt-order-1');
  assert.equal(query.items[1]?.eventId, 'evt-order-2');
  assert.equal(query.items[2]?.eventId, 'evt-order-3');
});

test('AC-0801-4: Pairing / tenant isolation', async t => {
  const f = await createFixture();
  t.after(f.cleanup);

  const pairingA = productionPairing('companion', 'inst-alpha');
  const pairingB = productionPairing('companion', 'inst-beta');

  await f.timelineService.recordEvent({
    eventId: 'evt-pairing-a', schemaVersion: 1, domain: 'companion', type: 'companion.turn.saved',
    pairing: pairingA, sourceRef: { id: 'sa', version: 1 }, occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
    payload: { userText: '用户 A 的私有消息' }, summary: '用户 A 消息',
  });

  await f.timelineService.recordEvent({
    eventId: 'evt-pairing-b', schemaVersion: 1, domain: 'companion', type: 'companion.turn.saved',
    pairing: pairingB, sourceRef: { id: 'sb', version: 1 }, occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(),
    payload: { userText: '用户 B 的私有消息' }, summary: '用户 B 消息',
  });

  const resA = await f.timelineService.queryTimeline({ pairing: pairingA });
  assert.equal(resA.items.length, 1);
  assert.equal(resA.items[0]?.companionDetails?.userText, '用户 A 的私有消息');

  const resB = await f.timelineService.queryTimeline({ pairing: pairingB });
  assert.equal(resB.items.length, 1);
  assert.equal(resB.items[0]?.companionDetails?.userText, '用户 B 的私有消息');
});

test('AC-0801-5: Revocation and forgetting propagation', async t => {
  const f = await createFixture();
  t.after(f.cleanup);

  const pairing = productionPairing('companion', 'inst-alpha');
  const sourceId = 'source-secret-tea';
  const workSourceId = 'op-secret-task';
  const occurredAt = new Date().toISOString();

  await f.timelineService.recordEvent({
    eventId: 'evt-revoke-test', schemaVersion: 1, domain: 'companion', type: 'companion.turn.saved',
    pairing, sourceRef: { id: sourceId, version: 1 }, occurredAt, receivedAt: occurredAt,
    payload: { userText: '我最喜欢喝红茶', assistantText: '记下了！', sourceIds: [sourceId] },
    summary: '喜欢红茶',
  });
  await f.timelineService.recordEvent({
    eventId: 'evt-work-revoke-test', schemaVersion: 1, domain: 'work', type: 'work.task.receipt',
    pairing, sourceRef: { id: workSourceId, version: 1 }, occurredAt, receivedAt: occurredAt,
    payload: {
      executorId: 'fixture', taskId: workSourceId, status: 'succeeded', title: 'Private task',
      instruction: 'secret task instruction', resultSummary: 'private result',
    },
    summary: 'Private task',
  });

  // Verify visible before revocation
  const beforeRevoke = await f.timelineService.queryTimeline({ pairing });
  assert.equal(beforeRevoke.items.length, 2);
  assert.equal(beforeRevoke.items.find(item => item.domain === 'companion')?.companionDetails?.userText, '我最喜欢喝红茶');
  assert.equal(beforeRevoke.items.find(item => item.domain === 'work')?.workDetails?.instruction, 'secret task instruction');

  // Forget both source IDs. Work sourceRef.id is the operation ID.
  f.characterPacks.revokeSource(pairing.characterId, sourceId, '用户请求遗忘红茶');
  f.characterPacks.revokeSource(pairing.characterId, workSourceId, '用户请求遗忘工作任务');

  // Query again: revoked source items from both domains must be dynamically excluded.
  const afterRevoke = await f.timelineService.queryTimeline({ pairing });
  assert.equal(afterRevoke.items.length, 0, 'Revoked Companion and Work sources must be omitted from timeline query');

  // Reopen the actual SQLite file to ensure revocation remains effective after process restart.
  f.db.close();
  const reopenedDb = new Database(join(f.dir, 'test.db'));
  try {
    const reopenedPacks = await CharacterPackStore.open(reopenedDb);
    const reopenedTimeline = new UnifiedTimelineService(reopenedDb, reopenedPacks);
    const afterRestart = await reopenedTimeline.queryTimeline({ pairing });
    assert.equal(afterRestart.items.length, 0, 'Forgotten Work content must not return after reopening the database');
  } finally {
    reopenedDb.close();
  }
});

test('AC-0801-6: Restart recovery via outbox drainage', async t => {
  const f = await createFixture();
  t.after(f.cleanup);

  const pairing = productionPairing('companion', 'inst-alpha');
  // The real History owner is a separate lifecycle concern; model its minimal source-state table so
  // UnifiedTimeline can exercise the same history:<message-id> revocation check after recovery.
  f.db.exec('CREATE TABLE memory_records(character_id TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(character_id,id))');
  f.db.prepare('INSERT INTO memory_records(character_id,id,state,kind,text,version) VALUES(?,?,?,?,?,?)').run('companion', 'turn-staged-1:user', 'active', 'transcript', '崩溃前用户说的话', 1);
  f.db.prepare('INSERT INTO memory_records(character_id,id,state,kind,text,version) VALUES(?,?,?,?,?,?)').run('companion', 'turn-staged-1:assistant', 'active', 'transcript', '崩溃前桌宠的回复', 1);

  // 1. Stage turn in outbox (as happens during crash before projection drain)
  f.characterPacks.stageCompanionProjection({
    pairing,
    sessionId: 'session-restart',
    turnId: 'turn-staged-1',
  });

  // 2. Mock history inspector
  const mockHistory = new Map([
    ['turn-staged-1:user', { state: 'active', role: 'user', text: '崩溃前用户说的话' }],
    ['turn-staged-1:assistant', { state: 'active', role: 'assistant', text: '崩溃前桌宠的回复' }],
  ]);

  // 3. Drain pending companion events (simulating restart recovery)
  const projectedCount = f.characterPacks.projectPendingCompanionEvents((_scope: unknown, messageId: string) => {
    return mockHistory.get(messageId) ?? null;
  });
  assert.equal(projectedCount.projected, 1, 'Outbox must project 1 staged turn');

  // 4. Verify projected item is now retrievable in UnifiedTimelineService
  const query = await f.timelineService.queryTimeline({ pairing, domains: ['companion'] });
  assert.equal(query.items.length, 1);
  assert.equal(query.items[0]?.companionDetails?.userText, '崩溃前用户说的话');
  assert.equal(query.items[0]?.companionDetails?.assistantText, '崩溃前桌宠的回复');
});

test('CompanionEventHub: publish, subscribe by domain, and drainage', async () => {
  const hub = new CompanionEventHub();
  const received: CompanionEventEnvelope[] = [];

  const unsub = hub.subscribeDomain(['companion', 'work'], async env => {
    await new Promise(r => setTimeout(r, 10));
    received.push(env);
  });

  const pairing = productionPairing('companion', 'inst-1');
  const now = new Date().toISOString();

  hub.publishEnvelope({
    eventId: 'h-1', schemaVersion: 1, domain: 'companion', type: 'companion.test',
    pairing, sourceRef: { id: 's1', version: 1 }, occurredAt: now, receivedAt: now,
    payload: { ok: true }, summary: 'test companion',
  });

  hub.publishEnvelope({
    eventId: 'h-2', schemaVersion: 1, domain: 'canon', type: 'canon.test',
    pairing, sourceRef: { id: 's2', version: 1 }, occurredAt: now, receivedAt: now,
    payload: { ok: true }, summary: 'test canon',
  });

  hub.publishEnvelope({
    eventId: 'h-3', schemaVersion: 1, domain: 'work', type: 'work.test',
    pairing, sourceRef: { id: 's3', version: 1 }, occurredAt: now, receivedAt: now,
    payload: { ok: true }, summary: 'test work',
  });

  await hub.drain();

  // 'canon' event was not subscribed, so only companion & work (2 events) should be received
  assert.equal(received.length, 2);
  assert.equal(received[0]?.eventId, 'h-1');
  assert.equal(received[1]?.eventId, 'h-3');

  unsub();
  assert.equal(hub.listenerCount, 0);
});
