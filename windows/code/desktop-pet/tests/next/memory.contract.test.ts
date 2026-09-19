// Production SqliteMemoryStore/SqliteMemoryPort on a temp database: append/context isolation and cancellation at the memory boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationMessage, TurnScope } from '../../contracts/index.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteMemoryPort } from '../../memory/sqlite-port.js';
import { nextScope, tempStore } from './harness.js';

function setup(store: SqliteMemoryStore): SqliteMemoryPort {
  return new SqliteMemoryPort(store, { summaryLimit: 1000, inputTokenBudget: 5000, maxRecentMessages: 20, maxMemories: 5, countTokens: () => 0, relevance: () => 0 });
}

const message = (id: string, role: 'user' | 'assistant', text: string): ConversationMessage =>
  ({ characterId: 'companion', id, role, text, createdAt: '2026-09-19T00:00:00.000Z' });

test('context recent history is the companion shared stream; turn isolation lives in scopes, not transcript partitioning', async t => {
  const temp = await tempStore();
  t.after(() => temp.cleanup());
  const store = new SqliteMemoryStore({ filename: temp.filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const port = setup(store);

  const first: TurnScope = nextScope('turn-1', 1, 'session-a');
  await port.append(first, [message(`${first.turnId}:user`, 'user', '记住我喜欢深夜写代码')]);
  const contextA = await port.context(first, '我喜欢什么？', null, new AbortController().signal);
  assert.ok(contextA.recent.some(m => m.text === '记住我喜欢深夜写代码'), 'same-session context contains the transcript');
  assert.equal(contextA.scope.sessionId, first.sessionId);
  assert.equal(contextA.scope.characterId, first.characterId, 'context is bound to the requesting character');

  const second: TurnScope = nextScope('turn-2', 1, 'session-b');
  const contextB = await port.context(second, '我刚才说了什么？', null, new AbortController().signal);
  assert.ok(contextB.recent.some(m => m.text === '记住我喜欢深夜写代码'), 'upstream recent history is the companion shared stream across runtime sessions (characterized behavior)');
  store.close();
});

test('a pre-aborted signal refuses memory work instead of racing the query', async t => {
  const temp = await tempStore();
  t.after(() => temp.cleanup());
  const store = new SqliteMemoryStore({ filename: temp.filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const port = setup(store);
  const controller = new AbortController();
  controller.abort();

  // checkAbort rethrows signal.reason: a bare abort() surfaces as the platform AbortError, not the memory_cancelled marker.
  await assert.rejects(
    port.context(nextScope('turn-3', 1, 'session-a'), '查询', null, controller.signal),
    /abort/i
  );
  store.close();
});
