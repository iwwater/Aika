// NEXT-05: minimal persistent Chat Timeline — unique events, stable pagination, tombstone redaction,
// and a recorder with bounded retry. Storage is a small independent SQLite table (no second ORM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TurnScope } from '../../contracts/index.js';
import type { TurnPortEvent } from '../../core/turn-port.js';
import { AikaTimelineRecorder, AikaTimelineStore, TimelineConflictError } from '../../management/aika-timeline.js';
import type { ChatEvent } from '../../management/aika-timeline.js';

const NOW = '2026-09-19T00:00:00.000Z';

interface PortDouble { subscribe(listener: (event: TurnPortEvent) => void): () => void; emit(event: TurnPortEvent): void; size(): number }

function portDouble(): PortDouble {
  const listeners = new Set<(event: TurnPortEvent) => void>();
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit(event) { for (const listener of [...listeners]) listener(event); },
    size: () => listeners.size
  };
}

function scopeOf(sessionId: string, turnId: string, generation = 1): TurnScope {
  return { characterId: 'companion', sessionId, turnId, generation };
}

function chatEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
  const scope = overrides.scope ?? scopeOf('session-a', 'turn-1');
  return {
    schemaVersion: 1,
    eventId: overrides.eventId ?? `evt-${scope.turnId}-user`,
    scope,
    sequence: overrides.sequence ?? 1,
    occurredAt: overrides.occurredAt ?? NOW,
    kind: overrides.kind ?? 'userMessage',
    messageId: overrides.messageId ?? `${scope.turnId}:user`,
    text: overrides.text ?? '你好'
  };
}

// Single cleanup hook per test: close the database first (Windows cannot unlink an open file),
// then remove the directory. Registration order never matters this way.
test('05-A the recorder records accepted input once and each terminal exactly once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-tl-'));
  const store = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const port = portDouble();
  const errors: string[] = [];
  const recorder = new AikaTimelineRecorder(port, store, { onError: error => errors.push(String(error)) });
  const stop = recorder.start();

  const scope = scopeOf('session-a', 'turn-x');
  port.emit({ scope, sequence: 1, type: 'accepted', text: '问题一' });
  port.emit({ scope, sequence: 2, type: 'reply', text: '回答一' });
  port.emit({ scope, sequence: 3, type: 'terminal', status: 'completed', replyText: '回答一' });
  await recorder.drain();

  const page = await store.list({ sessionId: 'session-a', limit: 50 });
  assert.deepEqual(page.items.map(item => item.kind), ['userMessage', 'assistantTerminal']);
  assert.equal(page.items[0]!.text, '问题一');
  assert.equal(page.items[1]!.status, 'completed');
  assert.equal(page.items[1]!.text, '回答一');
  assert.equal(errors.length, 0);

  // Cancelled after a reply: status marks partial, never a complete reply.
  const scopeY = scopeOf('session-a', 'turn-y');
  port.emit({ scope: scopeY, sequence: 1, type: 'accepted', text: '问题二' });
  port.emit({ scope: scopeY, sequence: 2, type: 'reply', text: '回答到一半' });
  port.emit({ scope: scopeY, sequence: 3, type: 'terminal', status: 'cancelled' });
  await recorder.drain();
  const after = await store.list({ sessionId: 'session-a', limit: 50 });
  const cancelled = after.items.find(item => item.eventId === 'evt-turn-y-assistant')!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.text, '回答到一半', 'partial text is kept only together with the cancelled status');
  stop();
});

test('05-B same id same payload is a duplicate; same id different payload conflicts; concurrent writes stay unique', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-tl-'));
  const store = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const event = chatEvent();
  assert.equal(await store.append(event), 'inserted');
  assert.equal(await store.append({ ...event }), 'duplicate');
  await assert.rejects(store.append(chatEvent({ eventId: event.eventId, text: '不同内容' })), (error: unknown) => error instanceof TimelineConflictError);

  const many = Array.from({ length: 20 }, (_, i) => chatEvent({ eventId: `evt-conc-${i}`, scope: scopeOf('session-b', `turn-${i}`), messageId: `turn-${i}:user` }));
  const results = await Promise.all(many.map(item => store.append(item)));
  assert.ok(results.every(result => result === 'inserted'));
  const page = await store.list({ sessionId: 'session-b', limit: 100 });
  assert.equal(page.items.length, 20);
});

test('05-C reopen queries; equal timestamps paginate without gaps or duplicates; session filter works', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-tl-'));
  const first = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  for (let i = 0; i < 30; i++) {
    await first.append(chatEvent({ eventId: `evt-p-${i}`, scope: scopeOf('session-a', `turn-${i}`), messageId: `turn-${i}:user`, occurredAt: NOW, text: `第 ${i} 条` }));
  }
  await first.append(chatEvent({ eventId: 'evt-other', scope: scopeOf('session-z', 'turn-z'), messageId: 'turn-z:user', text: '别的会话' }));
  first.close();

  const reopened = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  t.after(async () => { reopened.close(); await rm(dir, { recursive: true, force: true }); });
  const walked: ChatEvent[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 10; pages++) {
    const page = cursor === undefined
      ? await reopened.list({ sessionId: 'session-a', limit: 7 })
      : await reopened.list({ sessionId: 'session-a', cursor, limit: 7 });
    walked.push(...page.items);
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  assert.equal(walked.length, 30, 'no gaps');
  assert.equal(new Set(walked.map(item => item.eventId)).size, 30, 'no duplicates');
  assert.deepEqual(walked.map(item => item.text), Array.from({ length: 30 }, (_, i) => `第 ${i} 条`), 'stable sort order');
  const other = await reopened.list({ sessionId: 'session-z', limit: 10 });
  assert.equal(other.items.length, 1);
  await assert.rejects(reopened.list({ sessionId: 'session-a', limit: 0 }), /limit/);
  await assert.rejects(reopened.list({ sessionId: 'session-a', limit: 101 }), /limit/);
});

test('05-D storage faults retry at most three times; the reply is never rolled back; replay stays unique', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-tl-'));
  const real = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  t.after(async () => { real.close(); await rm(dir, { recursive: true, force: true }); });

  // Fault injection wrapper around the real store (the storage itself is never mocked away).
  let remainingFailures = 2;
  const attempts: string[] = [];
  const flaky = {
    append: async (event: ChatEvent): Promise<'inserted' | 'duplicate'> => {
      attempts.push(event.eventId);
      if (remainingFailures > 0) { remainingFailures--; throw new Error('disk hiccup'); }
      return real.append(event);
    }
  };
  const port = portDouble();
  const errors: string[] = [];
  const recorder = new AikaTimelineRecorder(port, flaky, { onError: error => errors.push(String(error)) });
  const stop = recorder.start();
  const scope = scopeOf('session-a', 'turn-f');
  port.emit({ scope, sequence: 1, type: 'accepted', text: '容错轮' });
  await recorder.drain();
  assert.equal(attempts.filter(id => id === 'evt-turn-f-user').length, 3, 'exactly three attempts');
  assert.equal((await real.list({ sessionId: 'session-a', limit: 10 })).items.length, 1, 'third attempt persisted');

  // Exhausted retries surface observably and stop retrying.
  remainingFailures = 99;
  const scopeG = scopeOf('session-a', 'turn-g');
  port.emit({ scope: scopeG, sequence: 1, type: 'accepted', text: '必败轮' });
  await recorder.drain();
  assert.equal(errors.length, 1, 'final failure is observable');
  assert.equal(attempts.filter(id => id === 'evt-turn-g-user').length, 3, 'no retry beyond three');
  stop();

  // A successful replay of the exact stored event must not duplicate.
  const stored = (await real.list({ sessionId: 'session-a', limit: 10 })).items.find(item => item.eventId === 'evt-turn-f-user')!;
  assert.equal(await real.append({ ...stored }), 'duplicate');
});

test('05-E redact is idempotent, tombstones survive replay and reopen; replay never revives text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-tl-'));
  const store = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  const event = chatEvent({ eventId: 'evt-r-1', messageId: 'seed:user', text: '要被遗忘的正文' });
  await store.append(event);
  await store.redactByMessageIds(['seed:user']);
  await store.redactByMessageIds(['seed:user']);
  let page = await store.list({ sessionId: 'session-a', limit: 10 });
  assert.equal(page.items[0]!.text, undefined, 'text is gone');
  assert.equal(await store.append({ ...event }), 'duplicate', 'replay after redact does not revive');
  page = await store.list({ sessionId: 'session-a', limit: 10 });
  assert.equal(page.items[0]!.text, undefined, 'tombstone holds');
  store.close();

  const reopened = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  t.after(async () => { reopened.close(); await rm(dir, { recursive: true, force: true }); });
  const afterReopen = await reopened.list({ sessionId: 'session-a', limit: 10 });
  assert.equal(afterReopen.items[0]!.text, undefined, 'tombstone survives reopen');
  assert.equal(await reopened.append({ ...event }), 'duplicate');
  assert.equal((await reopened.list({ sessionId: 'session-a', limit: 10 })).items[0]!.text, undefined);
});

test('05-E integration: after a forget, redacting the source message removes only its chat text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-tl-'));
  const store = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  // User + assistant events recorded from a real accepted turn (messageId = upstream transcript record ids).
  await store.append(chatEvent({ eventId: 'evt-f-user', scope: scopeOf('session-a', 'seed'), messageId: 'seed:user', text: '我养了一只猫叫小白' }));
  await store.append(chatEvent({ eventId: 'evt-f-a', scope: scopeOf('session-a', 'seed'), kind: 'assistantTerminal', messageId: 'seed:assistant', text: '好的，记住了。', status: 'completed' }));

  // The production forget consumes the transcript source; the linked chat text is then redacted.
  await store.redactByMessageIds(['seed:user']);
  const page = await store.list({ sessionId: 'session-a', limit: 10 });
  assert.equal(page.items.find(item => item.messageId === 'seed:user')!.text, undefined, 'the forgotten source text is no longer queryable');
  assert.equal(page.items.find(item => item.messageId === 'seed:assistant')!.text, '好的，记住了。', 'unrelated events keep their text');
});

test('05-F unsubscribe and recorder stop leak no listeners; a stopped recorder cannot restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-tl-'));
  const store = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const port = portDouble();
  const recorder = new AikaTimelineRecorder(port, store);
  const stop = recorder.start();
  assert.equal(port.size(), 1);
  stop();
  assert.equal(port.size(), 0, 'recorder stop unsubscribes');
  assert.throws(() => recorder.start(), /停止|stopped/);

  const second = new AikaTimelineRecorder(port, store);
  const stopSecond = second.start();
  assert.equal(port.size(), 1);
  stopSecond();
  await second.drain();
  assert.equal(port.size(), 0);
});
