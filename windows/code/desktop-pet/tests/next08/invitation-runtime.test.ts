import test from 'node:test';
import assert from 'node:assert/strict';
import type { BackendToDesktop } from '../../contracts/desktop-bridge.js';
import { BackendSession } from '../../app/backend-session.js';
import { DesktopViewState } from '../../desktop/view-state.js';
import { MemoryMediaStore } from '../../media/store.js';
import { fixture, scope, seed, NOW } from '../memory/sqlite-fixture.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { UnifiedTimelineService } from '../../memory/unified-timeline.js';
import { productionPairing } from '../../contracts/character-pack.js';

test('08-04: the renderer clears a dismissed invitation without creating a dialogue scope', () => {
  const view = new DesktopViewState();
  view.setSession('companion', 'invitation-dismissal-view');
  const invitation = { characterId: 'companion' as const, id: 'dismiss-view', eventId: 'job', text: '稍后再说也可以。', gesture: 'wave',
    eligibleAt: NOW, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), status: 'shown' as const };
  assert.equal(view.receive({ type: 'invitation', invitation }), true);
  view.command({ type: 'ignore_invitation', invitationId: invitation.id });
  assert.equal(view.invitation, null);
  assert.equal(view.scope, null);
  assert.equal(view.state, 'idle');
});

test('08-04: a shown persisted invitation click enters the sole voice turn; stale clicks cannot capture', async t => {
  const f = fixture(); t.after(f.cleanup);
  const persistent = f.open(); seed(persistent);
  persistent.invitations.register(scope(), { id: 'shown-invite', eventId: 'job', text: '愿意聊聊最近的工作吗？', gesture: 'wave',
    eligibleAt: NOW, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  const shown = persistent.invitations.showNext(scope());
  assert.equal(shown?.status, 'shown');
  assert.deepEqual(persistent.invitations.showNext(scope()), shown,
    'an outstanding shown invitation must be resumed instead of consuming quota for another card');
  const outgoing: BackendToDesktop[] = [];
  const accepted: string[] = [];
  const media = new MemoryMediaStore();
  let session!: BackendSession;
  session = new BackendSession({
    mediaStore: media,
    acceptInvitation(id) {
      accepted.push(id);
      return persistent.invitations.clickForCharacter('companion', id) ? { type: 'start_voice' } : null;
    },
    ignoreInvitation(id) { return persistent.invitations.ignoreForCharacter('companion', id) !== null; },
    perception: { async perceive() { throw new Error('voice must not finish in this test'); } },
    dialogue: { async reply() { throw new Error('voice must not reach dialogue'); } },
    tts: { async synthesize() { throw new Error('voice must not synthesize'); } },
    memory: {
      async append() { throw new Error('voice must not write memory'); },
      async context() { throw new Error('voice must not build context'); },
      maintenanceInput(scope) { return { scope, messages: [], relevantMemories: [] }; },
      async maintain() { return []; },
    },
  }, message => {
    outgoing.push(message);
    if (message.channel === 'capture_start' || message.channel === 'capture_stop' || message.channel === 'stop') {
      queueMicrotask(() => void session.receiveLine(JSON.stringify({ channel: 'ack', requestId: message.requestId })));
    }
  }, () => {});

  try {
    assert.equal(session.presentInvitation(shown!), true);
    assert.equal(session.presentInvitation({ ...shown!, characterId: 'other-character' }), false,
      'a persisted invitation for a different character must not reach this desktop session');
    assert.equal(outgoing.filter(message => message.channel === 'event' && message.event.type === 'invitation').length, 1);
    await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'click_invitation', invitationId: 'shown-invite' } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const turns = outgoing.filter(message => message.channel === 'event' && message.event.type === 'turn');
    assert.equal(turns.length, 1);
    assert.ok(turns[0]?.channel === 'event' && turns[0].event.type === 'turn');
    assert.equal(turns[0].event.input.kind, 'voice');
    assert.equal(outgoing.filter(message => message.channel === 'capture_start').length, 1,
      'only the explicit click may enter the existing microphone authorization path');
    assert.equal(persistent.invitations.inspect(scope(), 'shown-invite')?.status, 'clicked');

    await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'click_invitation', invitationId: 'expired-invite' } }));
    assert.deepEqual(accepted, ['shown-invite', 'expired-invite']);
    assert.equal(outgoing.filter(message => message.channel === 'capture_start').length, 1,
      'a stale or unshown invitation must not start capture');
    assert.equal(outgoing.filter(message => message.channel === 'event' && message.event.type === 'turn').length, 1);

    await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'cancel' } }));
    await session.drain();
    assert.equal(outgoing.filter(message => message.channel === 'capture_stop').length, 1);

    const policy = persistent.invitations.policy();
    persistent.invitations.configure({ ...policy, minIntervalMs: 0 });
    persistent.invitations.register(scope(), { id: 'later-invite', eventId: 'job', text: '现在不聊也可以。', gesture: 'wave',
      eligibleAt: NOW, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    const later = persistent.invitations.showNext(scope());
    assert.equal(later?.status, 'shown');
    assert.equal(session.presentInvitation(later!), true);
    await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'ignore_invitation', invitationId: 'later-invite' } }));
    assert.equal(persistent.invitations.inspect(scope(), 'later-invite')?.status, 'ignored');
    assert.equal(outgoing.filter(message => message.channel === 'event' && message.event.type === 'turn').length, 1,
      'ignoring an invitation must not create a dialogue turn');
    assert.equal(outgoing.filter(message => message.channel === 'capture_start').length, 1,
      'ignoring an invitation must not start capture');
  } finally {
    await session.close();
  }
});

test('08-04: a text invitation click enters an ordinary text turn without microphone capture', async t => {
  const f = fixture(); t.after(f.cleanup);
  const outgoing: BackendToDesktop[] = [];
  const media = new MemoryMediaStore();
  const session = new BackendSession({
    mediaStore: media,
    acceptInvitation(id) { return id === 'text-invite' ? { type: 'submit_text', text: '我想继续聊聊之前整理的重要节点。' } : null; },
    perception: { async perceive() { throw new Error('text invitations must not capture or perceive'); } },
    dialogue: { async reply() { throw new Error('dialogue response is not needed to verify the authorized input kind'); } },
    tts: { async synthesize() { throw new Error('text invitation acceptance must not synthesize speech'); } },
    memory: {
      async append() { throw new Error('text invitation acceptance must not reach turn persistence in this focused test'); },
      async context() { throw new Error('unused'); },
      maintenanceInput(scope) { return { scope, messages: [], relevantMemories: [] }; },
      async maintain() { return []; },
    },
  }, message => outgoing.push(message), () => {});
  try {
    await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'click_invitation', invitationId: 'text-invite' } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const turns = outgoing.filter(message => message.channel === 'event' && message.event.type === 'turn');
    assert.equal(turns.length, 1);
    assert.ok(turns[0]?.channel === 'event' && turns[0].event.type === 'turn');
    assert.equal(turns[0].event.input.kind, 'text');
    assert.equal(outgoing.filter(message => message.channel === 'capture_start').length, 0);
    assert.equal(outgoing.filter(message => message.channel === 'capture_finish').length, 0);
  } finally {
    await session.close();
  }
});

test('08-01/08-04: invitation acceptance is an idempotent activity projection and source forgetting hides it', async t => {
  const f = fixture(); t.after(f.cleanup);
  const persistent = f.open(); seed(persistent);
  const source = persistent.inspect(scope(), 'job');
  assert.ok(source && source.state === 'active');
  const packs = await CharacterPackStore.open(persistent.rawDatabaseForKnowledge());
  const timeline = new UnifiedTimelineService(persistent.rawDatabaseForKnowledge(), packs);
  const pairing = productionPairing('companion', 'companion-default');
  const occurredAt = NOW;
  const event = {
    eventId: 'invitation-accepted-source-linked', schemaVersion: 1 as const, domain: 'companion' as const,
    type: 'companion.invitation.accepted', pairing, sourceRef: { id: source.id, version: source.version },
    occurredAt, receivedAt: occurredAt,
    payload: { invitationId: 'shown-invite', actionKind: 'start_voice', status: 'accepted' },
    summary: 'caller-provided text must not become a dialogue record',
  };
  assert.equal(timeline.recordEventSync(event), 'inserted');
  assert.equal(timeline.recordEventSync(event), 'duplicate');
  const visible = await timeline.queryTimeline({ pairing, domains: ['companion'] });
  assert.equal(visible.items.length, 1);
  assert.equal(visible.items[0]?.type, 'companion.invitation.accepted');
  assert.equal(visible.items[0]?.companionDetails, undefined);
  assert.deepEqual(visible.items[0]?.companionActivityDetails,
    { invitationId: 'shown-invite', actionKind: 'voice_start', status: 'accepted' });
  assert.equal(visible.items[0]?.summary, '接受了一条主动陪伴邀请');
  const dismissed = { ...event, eventId: 'invitation-dismissed-shown-invite', type: 'companion.invitation.dismissed',
    payload: { invitationId: 'shown-invite', actionKind: 'start_voice', status: 'dismissed' }, summary: '暂不接受这条主动陪伴邀请' };
  assert.equal(timeline.recordEventSync(dismissed), 'inserted');
  assert.equal(timeline.recordEventSync({ ...dismissed }), 'duplicate');
  const withDismissal = await timeline.queryTimeline({ pairing, domains: ['companion'] });
  assert.equal(withDismissal.items.length, 2);
  assert.deepEqual(withDismissal.items.find(item => item.eventId === dismissed.eventId)?.companionActivityDetails,
    { invitationId: 'shown-invite', actionKind: 'voice_start', status: 'dismissed' });
  assert.equal(timeline.recordEventSync({ ...event, eventId: 'unsupported-lifecycle', type: 'companion.invitation.cancelled' }), 'ignored');
  assert.equal((await timeline.queryTimeline({ pairing, domains: ['companion'] })).items.length, 2,
    'unsupported lifecycle events must not be mislabeled as dialogue');
  assert.throws(() => timeline.recordEventSync({ ...event, payload: { invitationId: 'different', actionKind: 'start_voice', status: 'accepted' } }),
    /Companion activity timeline conflict/);

  persistent.apply({ scope: scope(), operationId: 'forget-invitation-source', reason: 'synthetic source withdrawal', createdAt: NOW,
    operation: { type: 'soft_delete', id: source.id, expectedVersion: source.version } });
  const afterForget = await timeline.queryTimeline({ pairing, domains: ['companion'] });
  assert.equal(afterForget.items.length, 0, 'a forgotten source must hide accepted and dismissed invitation activities from future reads');
  persistent.close();
});
