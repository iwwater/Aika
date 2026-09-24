import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../memory/sqlite-fixture.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { CompanionEventHub } from '../../core/companion-event-hub.js';
import { ProactiveInvitationRuntime } from '../../companion/proactive-invitation-runtime.js';
import { SqliteContinuityMemoryStore } from '../../memory/continuity-memory-store.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { UnifiedTimelineService } from '../../memory/unified-timeline.js';

const PAIR = productionPairing('companion', 'companion-default');
const MILESTONE = (operationId: string, text: string, evidenceEligible = true) => ({
  pairing: PAIR, operationId, layer: 'user_wiki' as const, kind: 'milestone' as const,
  text, sourceIds: [`saved-message:${operationId}`], origin: 'manual' as const,
  evidenceEligible, status: 'active' as const,
});

test('08-04 production path is opt-in, starts at an explicit checkpoint, and creates generic text-only invitations', async t => {
  const f = fixture(); t.after(f.cleanup);
  let now = '2026-09-24T10:00:00.000Z';
  const store = f.open();
  const continuity = await SqliteContinuityMemoryStore.open(store);
  continuity.record(MILESTONE('old-milestone', '此前已经确认的重要节点。'));
  const hub = new CompanionEventHub();
  const runtime = new ProactiveInvitationRuntime(store.rawDatabaseForKnowledge(), continuity, store.invitations, hub, () => now);
  const packs = await CharacterPackStore.open(store.rawDatabaseForKnowledge());
  const timeline = new UnifiedTimelineService(store.rawDatabaseForKnowledge(), packs);
  hub.subscribeDomain(['companion'], event => { timeline.recordEventSync(event); }, PAIR);

  assert.equal(runtime.policy(PAIR).enabled, false, 'the durable invitation feature defaults off');
  assert.equal(runtime.sync(PAIR), 0);
  const initial = runtime.policy(PAIR);
  const enabled = runtime.configure(PAIR, initial.revision, { ...initial, enabled: true });
  assert.equal(enabled.enabled, true);
  assert.equal(runtime.sync(PAIR), 0, 'enabling records a revision checkpoint and does not backfill history');

  continuity.record(MILESTONE('ineligible-milestone', '未达到证据门槛的内容。', false));
  continuity.record(MILESTONE('new-milestone', '用户保存的真实节点正文，不应出现在邀请或时间线。'));
  assert.equal(runtime.sync(PAIR), 1, 'only a future active evidence-eligible milestone becomes a candidate');
  assert.equal(runtime.sync(PAIR), 0, 'revision replay is idempotent');

  now = '2026-09-24T10:00:30.000Z';
  const busy = runtime.showNext(PAIR, { isTyping: true });
  assert.equal(busy, null, 'typing presence suppresses display');
  const shown = runtime.showNext(PAIR, {});
  assert.ok(shown);
  assert.equal(typeof shown.sourceVersion, 'number');
  const sourceVersion = shown.sourceVersion!;
  assert.equal(shown.status, 'shown');
  assert.equal(shown.sourceKind, 'continuity_fact');
  assert.equal(shown.actionKind, 'text');
  assert.equal(shown.text, '想继续聊聊你之前整理的一个重要节点吗？');
  assert.equal(shown.responseText, '我想继续聊聊之前整理的重要节点。');
  assert.equal(shown.expiresAt, '2026-09-24T10:15:00.000Z', 'candidate retention is capped at the frozen 15-minute contract');
  assert.ok(!JSON.stringify(shown).includes('真实节点正文'), 'invitation payloads never duplicate source fact text');
  assert.throws(() => runtime.configure(PAIR, initial.revision, { ...initial, enabled: false }), /proactive_policy_revision_conflict/);

  const presented = await timeline.queryTimeline({ pairing: PAIR, domains: ['companion'] });
  assert.equal(presented.items.length, 1);
  assert.equal(presented.items[0]?.type, 'companion.invitation.presented');
  assert.deepEqual(presented.items[0]?.companionActivityDetails,
    { invitationId: shown.id, actionKind: 'text', status: 'presented', sourceKind: 'continuity_fact' });
  assert.equal(presented.items[0]?.summary, '呈现了一条主动陪伴邀请');

  // A new process can recover the same shown card without inserting another delivery.
  const restarted = new ProactiveInvitationRuntime(store.rawDatabaseForKnowledge(), continuity, store.invitations, hub, () => now);
  assert.deepEqual(restarted.shown(PAIR), shown);
  assert.equal(restarted.showNext(PAIR, {}), null, 'restoring a shown invitation does not spend quota twice');
  const accepted = restarted.accept(PAIR, shown.id);
  assert.deepEqual(accepted, { type: 'submit_text', text: '我想继续聊聊之前整理的重要节点。', invitationId: shown.id,
    eventId: shown.eventId, sourceVersion });
  assert.equal(restarted.accept(PAIR, shown.id), null, 'a repeated click cannot create another text turn');
  assert.equal(restarted.shown(PAIR), null);
  assert.equal((store.rawDatabaseForKnowledge().prepare('SELECT status FROM proactive_invitation_candidates WHERE id=?').get(shown.id) as { status: string }).status,
    'clicked', 'a duplicate click must not rewrite an already accepted invitation as expired');
  const afterAccept = await timeline.queryTimeline({ pairing: PAIR, domains: ['companion'] });
  assert.equal(afterAccept.items.length, 2);
  const acceptedActivity = afterAccept.items.find(item => item.type === 'companion.invitation.accepted');
  assert.ok(acceptedActivity);
  assert.deepEqual(acceptedActivity.companionActivityDetails,
    { invitationId: shown.id, actionKind: 'text', status: 'accepted', sourceKind: 'continuity_fact' });

  continuity.forget({ pairing: PAIR, operationId: 'forget-proactive-source', targetId: shown.eventId,
    expectedVersion: sourceVersion, reason: 'test forgetting propagation' });
  const afterForget = await timeline.queryTimeline({ pairing: PAIR, domains: ['companion'] });
  assert.equal(afterForget.items.length, 0, 'forgetting a source hides presentation and acceptance audit from future timeline reads');
  store.close();
});

test('08-04 continuity candidates expire after 15 minutes and scrub invitation text', async t => {
  const f = fixture(); t.after(f.cleanup);
  let now = '2026-09-24T10:00:00.000Z';
  const store = f.open();
  const continuity = await SqliteContinuityMemoryStore.open(store);
  const runtime = new ProactiveInvitationRuntime(store.rawDatabaseForKnowledge(), continuity, store.invitations, new CompanionEventHub(), () => now);
  const initial = runtime.policy(PAIR);
  runtime.configure(PAIR, initial.revision, { ...initial, enabled: true });
  const fact = continuity.record(MILESTONE('short-lived-milestone', '短期事实')).fact;
  assert.equal(runtime.sync(PAIR), 1);
  now = '2026-09-24T10:15:01.000Z';
  assert.equal(runtime.showNext(PAIR, {}), null);
  const row = store.rawDatabaseForKnowledge().prepare('SELECT status,text,response_text FROM proactive_invitation_candidates WHERE source_id=?').get(fact.id) as {
    status: string; text: string; response_text: string;
  };
  assert.deepEqual(row, { status: 'expired', text: '', response_text: '' });
  store.close();
});

test('08-04 expired shown invitation cannot be accepted or dismissed through a stale command', async t => {
  const f = fixture(); t.after(f.cleanup);
  let now = '2026-09-24T10:00:00.000Z';
  const store = f.open();
  const continuity = await SqliteContinuityMemoryStore.open(store);
  const runtime = new ProactiveInvitationRuntime(store.rawDatabaseForKnowledge(), continuity, store.invitations, new CompanionEventHub(), () => now);
  const initial = runtime.policy(PAIR);
  runtime.configure(PAIR, initial.revision, { ...initial, enabled: true, dndStartHour: 0, dndEndHour: 0 });
  continuity.record(MILESTONE('expired-command-milestone', '已到期节点'));
  runtime.sync(PAIR);
  now = '2026-09-24T10:00:30.000Z';
  const shown = runtime.showNext(PAIR, {});
  assert.ok(shown);
  now = '2026-09-24T10:15:00.000Z';
  assert.equal(runtime.accept(PAIR, shown.id), null);
  assert.equal(runtime.ignore(PAIR, shown.id), null);
  const row = store.rawDatabaseForKnowledge().prepare('SELECT status,text,response_text FROM proactive_invitation_candidates WHERE id=?').get(shown.id) as {
    status: string; text: string; response_text: string;
  };
  assert.deepEqual(row, { status: 'expired', text: '', response_text: '' });
  store.close();
});

test('08-04 persisted policy enforces DND without expiring a still-current shown card', async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  const continuity = await SqliteContinuityMemoryStore.open(store);
  const runtime = new ProactiveInvitationRuntime(store.rawDatabaseForKnowledge(), continuity, store.invitations, new CompanionEventHub(), () => f.options.clock());
  const initial = runtime.policy(PAIR);
  runtime.configure(PAIR, initial.revision, { ...initial, enabled: true, dndStartHour: 19, dndEndHour: 20 });
  f.setTime('2026-09-24T10:50:00.000Z'); // 18:50 Asia/Shanghai
  continuity.record(MILESTONE('dnd-milestone', '节点'));
  assert.equal(runtime.sync(PAIR), 1);
  f.setTime('2026-09-24T10:50:30.000Z');
  const shown = runtime.showNext(PAIR, {});
  assert.ok(shown);
  f.setTime('2026-09-24T11:00:00.000Z'); // 19:00 Asia/Shanghai
  assert.equal(runtime.showNext(PAIR, {}), null, 'DND suppresses redisplay and other candidate delivery');
  assert.equal(runtime.shown(PAIR)?.id, shown.id, 'DND does not discard a still-valid shown invitation');
  store.close();
});

test('08-04 delivery cooldown and daily quota remain shared across pairings', async t => {
  const f = fixture(); t.after(f.cleanup);
  const store = f.open();
  const continuity = await SqliteContinuityMemoryStore.open(store);
  const primary = new ProactiveInvitationRuntime(store.rawDatabaseForKnowledge(), continuity, store.invitations, new CompanionEventHub(), () => f.options.clock());
  const initial = primary.policy(PAIR);
  primary.configure(PAIR, initial.revision, { ...initial, enabled: true, dndStartHour: 0, dndEndHour: 0 });
  f.setTime('2026-09-24T10:00:00.000Z');
  continuity.record(MILESTONE('primary-delivery', '主角色节点'));
  primary.sync(PAIR);
  f.setTime('2026-09-24T10:00:30.000Z');
  assert.ok(primary.showNext(PAIR, {}));

  const otherPair = productionPairing('companion', 'another-instance');
  const other = new ProactiveInvitationRuntime(store.rawDatabaseForKnowledge(), continuity, store.invitations, new CompanionEventHub(), () => f.options.clock());
  const otherInitial = other.policy(otherPair);
  other.configure(otherPair, otherInitial.revision, { ...otherInitial, enabled: true, dndStartHour: 0, dndEndHour: 0 });
  f.setTime('2026-09-24T10:01:00.000Z');
  continuity.record({ ...MILESTONE('other-milestone', '另一个实例的节点'), pairing: otherPair });
  other.sync(otherPair);
  f.setTime('2026-09-24T10:01:30.000Z');
  assert.equal(other.showNext(otherPair, {}), null, 'another instance cannot bypass the shared three-hour cooldown');

  const quotaPair = productionPairing('companion', 'daily-quota-instance');
  const quota = new ProactiveInvitationRuntime(store.rawDatabaseForKnowledge(), continuity, store.invitations, new CompanionEventHub(), () => f.options.clock());
  const quotaInitial = quota.policy(quotaPair);
  quota.configure(quotaPair, quotaInitial.revision, { ...quotaInitial, enabled: true, dailyMax: 1, dndStartHour: 0, dndEndHour: 0 });
  f.setTime('2026-09-24T13:00:00.000Z'); // 21:00 Asia/Shanghai, same local day as primary delivery
  continuity.record({ ...MILESTONE('quota-milestone', '配额节点'), pairing: quotaPair });
  quota.sync(quotaPair);
  // Age the isolated primary delivery past the shared cooldown while keeping it on the same local day.
  store.rawDatabaseForKnowledge().prepare('UPDATE invitation_deliveries SET shown_ms=?').run(Date.parse('2026-09-24T01:00:30.000Z'));
  f.setTime('2026-09-24T13:00:30.000Z');
  assert.equal(quota.showNext(quotaPair, {}), null, 'another pairing cannot exceed the shared daily quota');
  store.close();
});
