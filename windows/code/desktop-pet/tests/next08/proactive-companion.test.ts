/**
 * tests/next08/proactive-companion.test.ts
 *
 * 08-04 Acceptance Test Suite:
 * Validates ProactiveCompanionService against arbitration policies, fake clock,
 * user busy states, action isolation, source revocation, and tenant isolation.
 *
 * AC-0804-1: Fake clock quota, minimum interval, and timezone daily limit
 * AC-0804-2: DND window and user busy state interception
 * AC-0804-3: Source revocation immediately invalidates candidate
 * AC-0804-4: Action & permission isolation (text vs voice_start)
 * AC-0804-5: Duplicate event replay idempotency
 * AC-0804-6: Pairing & tenant isolation between character instances
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionEventHub } from '../../core/companion-event-hub.js';
import { ProactiveCompanionService } from '../../core/proactive-companion.js';
import type { ProactivePolicy } from '../../core/proactive-companion.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { InvitationCandidate, CompanionEventEnvelope } from '../../contracts/perception.js';

function createCandidate(
  id: string,
  pairing = productionPairing('companion', 'inst-alpha'),
  overrides: Partial<InvitationCandidate> = {},
): InvitationCandidate {
  return {
    id,
    pairing,
    reasonCode: 'idle_checkin',
    text: '要不要休息一下，喝杯热茶？',
    actionKind: 'text',
    quotaDomain: 'greeting',
    createdAt: '2026-09-24T10:00:00.000Z',
    validUntil: '2026-09-24T18:00:00.000Z',
    status: 'pending',
    ...overrides,
  };
}

test('AC-0804-1: Fake clock quota, minimum interval, and timezone daily limit', () => {
  let currentTime = '2026-09-24T10:00:00.000Z'; // 18:00 in Asia/Shanghai
  const clock = () => currentTime;
  const hub = new CompanionEventHub();
  const pairing = productionPairing('companion', 'inst-alpha');

  const policy: ProactivePolicy = {
    enabled: true,
    dailyMax: 2,
    minIntervalMs: 3 * 3600 * 1000, // 3 hours
    timezone: 'Asia/Shanghai',
    dndStartHour: 23,
    dndEndHour: 7,
  };

  const service = new ProactiveCompanionService(hub, policy, clock);

  service.registerCandidate(createCandidate('c1', pairing));
  service.registerCandidate(createCandidate('c2', pairing, { createdAt: '2026-09-24T10:01:00.000Z' }));
  service.registerCandidate(createCandidate('c3', pairing, { createdAt: '2026-09-24T10:02:00.000Z' }));

  // 1. First invitation presented at 10:00 UTC (18:00 Shanghai)
  const presented1 = service.presentNext(pairing);
  assert.ok(presented1);
  assert.equal(presented1?.id, 'c1');

  // 2. Immediate second presentation fails due to cooldown (3h min interval)
  currentTime = '2026-09-24T11:00:00.000Z'; // +1 hour
  const decision2 = service.evaluateArbitration(pairing);
  assert.equal(decision2.canPresent, false);
  assert.equal(decision2.reasonCode, 'cooldown_active');

  // 3. Advance fake clock past 3 hours cooldown (13:01 UTC = 21:01 Shanghai)
  currentTime = '2026-09-24T13:01:00.000Z';
  const presented2 = service.presentNext(pairing);
  assert.ok(presented2);
  assert.equal(presented2?.id, 'c2');

  // 4. Advance fake clock past another 3 hours (16:05 UTC = 00:05 Shanghai next day? Wait: 16:05 UTC is 00:05 Sept 25!)
  // Let's test daily max before midnight: 13:01 UTC was 21:01 Shanghai. 22:30 Shanghai is 14:30 UTC.
  // Between 13:01 and 14:30 is 1.5h (cooldown).
  // But dailyMax is 2. Both c1 and c2 were delivered on Sept 24 Shanghai day!
  // If we set minIntervalMs to 0 to test quota alone:
  service.updatePolicy({ minIntervalMs: 0 });
  currentTime = '2026-09-24T14:00:00.000Z'; // 22:00 Shanghai, same day
  const decisionQuota = service.evaluateArbitration(pairing);
  assert.equal(decisionQuota.canPresent, false);
  assert.equal(decisionQuota.reasonCode, 'daily_quota_exceeded');

  // 5. Cross midnight into next day (2026-09-25 09:00 Shanghai = 2026-09-25 01:00 UTC)
  currentTime = '2026-09-25T01:00:00.000Z';
  service.registerCandidate(createCandidate('c4', pairing, { validUntil: '2026-09-25T18:00:00.000Z' }));
  const presentedNextDay = service.presentNext(pairing);
  assert.ok(presentedNextDay);
  assert.equal(presentedNextDay?.id, 'c4', 'Quota resets automatically across local midnight');
});

test('AC-0804-2: DND window and user busy state interception', () => {
  let currentTime = '2026-09-24T10:00:00.000Z'; // 18:00 in Asia/Shanghai
  const clock = () => currentTime;
  const hub = new CompanionEventHub();
  const pairing = productionPairing('companion', 'inst-alpha');

  const policy: ProactivePolicy = {
    enabled: true,
    dailyMax: 5,
    minIntervalMs: 0,
    timezone: 'Asia/Shanghai',
    dndStartHour: 23,
    dndEndHour: 7,
  };

  const service = new ProactiveCompanionService(hub, policy, clock);
  service.registerCandidate(createCandidate('cand-dnd', pairing));

  // 1. In normal hours (18:00), arbitration passes
  assert.equal(service.evaluateArbitration(pairing).canPresent, true);

  // 2. User is typing -> blocked
  assert.equal(service.evaluateArbitration(pairing, { isTyping: true }).reasonCode, 'user_busy');

  // 3. User is speaking -> blocked
  assert.equal(service.evaluateArbitration(pairing, { isSpeaking: true }).reasonCode, 'user_busy');

  // 4. Turn is active (thinking / speaking) -> blocked
  assert.equal(service.evaluateArbitration(pairing, { isTurnActive: true }).reasonCode, 'user_busy');

  // 5. Work card pending confirmation -> blocked
  assert.equal(service.evaluateArbitration(pairing, { isWorkPendingConfirmation: true }).reasonCode, 'user_busy');

  // 6. Enter DND window (23:30 Shanghai = 15:30 UTC)
  currentTime = '2026-09-24T15:30:00.000Z';
  const dndDecision = service.evaluateArbitration(pairing);
  assert.equal(dndDecision.canPresent, false);
  assert.equal(dndDecision.reasonCode, 'dnd_active');
});

test('AC-0804-3: Source revocation immediately invalidates candidate and emits audit event', () => {
  const clock = () => '2026-09-24T10:00:00.000Z';
  const hub = new CompanionEventHub();
  const pairing = productionPairing('companion', 'inst-alpha');
  const service = new ProactiveCompanionService(hub, {
    enabled: true,
    dailyMax: 5,
    minIntervalMs: 0,
    timezone: 'Asia/Shanghai',
  }, clock);

  const events: CompanionEventEnvelope[] = [];
  hub.subscribeDomain(['companion'], env => { events.push(env); });

  // Register candidate bound to an observation
  service.registerCandidate(createCandidate('cand-obs', pairing, {
    sourceRef: { kind: 'observation', id: 'obs-win-999', version: 1 },
  }));

  // Arbitration passes initially
  assert.equal(service.evaluateArbitration(pairing).canPresent, true);

  // Source observation is revoked
  const revokedCount = service.revokeBySource('obs-win-999');
  assert.equal(revokedCount, 1);

  // Immediate evaluation rejects with no_candidates (candidate was expired)
  const afterRevokeDecision = service.evaluateArbitration(pairing);
  assert.equal(afterRevokeDecision.canPresent, false);
  assert.equal(afterRevokeDecision.reasonCode, 'no_candidates');

  // Audit event was broadcast to hub
  const expiredEvent = events.find(e => e.type === 'companion.invitation.expired');
  assert.ok(expiredEvent);
  assert.equal((expiredEvent.payload as any).invitationId, 'cand-obs');
});

test('AC-0804-4: Action & permission isolation (text vs voice_start)', () => {
  const clock = () => '2026-09-24T10:00:00.000Z';
  const hub = new CompanionEventHub();
  const pairing = productionPairing('companion', 'inst-alpha');
  const service = new ProactiveCompanionService(hub, {
    enabled: true,
    dailyMax: 5,
    minIntervalMs: 0,
    timezone: 'Asia/Shanghai',
  }, clock);

  // 1. Text invitation
  service.registerCandidate(createCandidate('cand-text', pairing, { actionKind: 'text', text: '来看看今日资讯' }));
  const presentedText = service.presentNext(pairing);
  assert.ok(presentedText);

  // Accepting text invitation returns startVoice === false
  const textResult = service.accept('cand-text', pairing);
  assert.ok(textResult);
  assert.equal(textResult.action, 'text');
  assert.equal(textResult.startVoice, false, 'Text invitation must not start voice/mic');

  // 2. Voice start invitation
  service.registerCandidate(createCandidate('cand-voice', pairing, { actionKind: 'voice_start', text: '点击和我聊聊天？' }));
  const presentedVoice = service.presentNext(pairing);
  assert.ok(presentedVoice);

  // Accepting voice_start invitation returns startVoice === true
  const voiceResult = service.accept('cand-voice', pairing);
  assert.ok(voiceResult);
  assert.equal(voiceResult.action, 'voice_start');
  assert.equal(voiceResult.startVoice, true, 'Voice start invitation triggers voice recording intent');
});

test('AC-0804-5: Duplicate event replay idempotency', () => {
  const clock = () => '2026-09-24T10:00:00.000Z';
  const hub = new CompanionEventHub();
  const pairing = productionPairing('companion', 'inst-alpha');
  const service = new ProactiveCompanionService(hub, {
    enabled: true,
    dailyMax: 5,
    minIntervalMs: 0,
    timezone: 'Asia/Shanghai',
  }, clock);

  // Candidate 1 from event X
  service.registerCandidate(createCandidate('cand-replay-1', pairing, {
    sourceRef: { kind: 'observation', id: 'event-fixed-100', version: 1 },
  }));
  const first = service.presentNext(pairing);
  assert.equal(first?.id, 'cand-replay-1');

  // Candidate 2 from the exact same event X arrives (e.g. replay)
  service.registerCandidate(createCandidate('cand-replay-2', pairing, {
    sourceRef: { kind: 'observation', id: 'event-fixed-100', version: 1 },
  }));

  // Second candidate with same source event on same day is skipped
  const second = service.presentNext(pairing);
  assert.equal(second, null, 'Replay of same source event on the same day must not present again');
});

test('AC-0804-6: Pairing & tenant isolation between character instances', () => {
  const clock = () => '2026-09-24T10:00:00.000Z';
  const hub = new CompanionEventHub();
  const pairingA = productionPairing('companion', 'inst-alpha');
  const pairingB = productionPairing('companion', 'inst-beta');

  const service = new ProactiveCompanionService(hub, {
    enabled: true,
    dailyMax: 5,
    minIntervalMs: 0,
    timezone: 'Asia/Shanghai',
  }, clock);

  // Register candidate for pairing A only
  service.registerCandidate(createCandidate('cand-for-a', pairingA));

  // Pairing B evaluates arbitration
  const decisionB = service.evaluateArbitration(pairingB);
  assert.equal(decisionB.canPresent, false);
  assert.equal(decisionB.reasonCode, 'no_candidates', 'Candidates for pairing A must not be visible to pairing B');

  // Pairing A presents
  const presentedA = service.presentNext(pairingA);
  assert.equal(presentedA?.id, 'cand-for-a');

  // Attempt to accept pairing A candidate from pairing B
  const crossAccept = service.accept('cand-for-a', pairingB);
  assert.equal(crossAccept, null, 'Accepting candidate from wrong pairing must fail');
});
