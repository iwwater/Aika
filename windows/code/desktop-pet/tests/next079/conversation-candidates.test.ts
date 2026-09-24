import test from 'node:test';
import assert from 'node:assert/strict';
import { ContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { ConversationCandidateWriter, extractConversationCandidates } from '../../memory/conversation-candidate-writer.js';
import { fixture, message, scope, NOW } from '../memory/sqlite-fixture.js';

const pairing = { userId: 'local-user', characterId: 'companion', characterInstanceId: 'inst-079' } as const;

test('N079-08 only stages exact, explicit, non-sensitive statements as candidates', () => {
  assert.deepEqual(extractConversationCandidates('我喜欢徒步。我的长期目标是成为独立的研究者。'), [
    { layer: 'user_wiki', text: '我喜欢徒步。' },
    { layer: 'user_soul', text: '我的长期目标是成为独立的研究者。' },
  ]);
  assert.deepEqual(extractConversationCandidates('昨天去散步。我的住址是北京市朝阳区。'), []);
});

test('N079-08 recovers ID-only candidate outbox after restart, remains review-only, and revokes on History forgetting', async t => {
  const f = fixture(300_000_000, 'next079-conversation-candidates');
  t.after(() => f.cleanup());
  let history = f.open();
  let continuity = await ContinuityMemoryStore.open(history);
  const old = scope('companion', 'before-install');
  history.append(old, [message('old:user', '我喜欢以前的项目。')]);
  let writer = new ConversationCandidateWriter(history, continuity, () => pairing);
  writer.initialize(pairing);
  writer.recover(pairing);
  assert.equal(continuity.snapshot(pairing, { includeCandidates: true }).candidates.length, 0, 'installation must not silently backfill old transcripts');

  const turn = scope('companion', 'candidate-turn');
  history.append(turn, [message('candidate-turn:user', '我喜欢徒步。'), message('candidate-soul:user', '我的长期目标是成为独立的研究者。')]);
  history.append(turn, [{ ...message('candidate-turn:assistant', '好的。'), role: 'assistant' }]);
  writer.stage(pairing);
  assert.equal((history.rawDatabaseForKnowledge().prepare('SELECT COUNT(*) AS count FROM continuity_conversation_candidate_outbox').get() as { count: number }).count, 2);
  history.close();

  history = f.open();
  continuity = await ContinuityMemoryStore.open(history);
  writer = new ConversationCandidateWriter(history, continuity, () => pairing);
  writer.initialize(pairing);
  writer.recover(pairing);
  writer.recover(pairing);
  let snapshot = continuity.snapshot(pairing, { includeCandidates: true });
  assert.equal(snapshot.candidates.length, 2);
  const wiki = snapshot.candidates.find(candidate => candidate.layer === 'user_wiki')!;
  const soul = snapshot.candidates.find(candidate => candidate.layer === 'user_soul')!;
  assert.equal(wiki.text, '我喜欢徒步。');
  assert.deepEqual(wiki.sourceIds, ['history:candidate-turn:user']);
  assert.equal(soul.text, '我的长期目标是成为独立的研究者。');
  assert.equal(snapshot.wiki.length + snapshot.soul.length, 0, 'conversation evidence can never auto-promote');

  continuity.promote(pairing, 'manual-review-promotion', wiki.id, wiki.version);
  assert.equal(continuity.snapshot(pairing).wiki.length, 1, 'explicit review is the only promotion path');

  continuity.forget({ pairing, operationId: 'forget-candidate', targetId: soul.id, expectedVersion: soul.version, reason: '用户要求忘记该候选' });
  assert.equal((history.rawDatabaseForKnowledge().prepare('SELECT text FROM continuity_facts WHERE id=?').get(soul.id) as { text: string }).text, '');
  f.setTime(new Date(Date.parse(NOW) + 31 * 24 * 60 * 60 * 1000).toISOString());
  history.cleanup();
  snapshot = continuity.snapshot(pairing, { includeCandidates: true });
  assert.equal(snapshot.wiki.length + snapshot.soul.length + snapshot.candidates.length, 0, 'forgetting the source suppresses both reviewed and candidate facts');
  const redacted = history.rawDatabaseForKnowledge().prepare('SELECT status,text FROM continuity_facts WHERE id=?').get(wiki.id) as { status: string; text: string };
  assert.deepEqual(redacted, { status: 'revoked', text: '' }, 'forgetting scrubs stored candidate text');
});
