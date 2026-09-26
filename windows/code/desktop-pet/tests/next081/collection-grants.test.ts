/**
 * tests/next081/collection-grants.test.ts
 *
 * N081-01 acceptance: 来源授权状态机、配对隔离、暂停/撤销、资源 lease 释放。
 *
 * AC-08101-1: 默认零授权；三来源开关互不影响
 * AC-08101-2: 授权到期停止新采集；旧修订与迟到回调被拒绝
 * AC-08101-3: 跨用户/角色实例不能读取或写入
 * AC-08101-4: 单帧 CaptureGrant 不能升级为持续来源授权
 * AC-08101-5: 暂停/撤销/锁屏/包停用后 listener 全释放，重复停用幂等
 * AC-08101-6: 配置档授权上限生效；目录来源必须带目录且非目录来源不得带目录
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CollectionGrantManager,
  CollectionGrantError,
  type CollectionGrantRecord,
  type CollectionGrantStorePort,
} from '../../core/collection-grants.js';
import { NORMAL_COLLECTION_POLICY, SMOKE_COLLECTION_POLICY } from '../../contracts/collection.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';
import { CaptureGrantManager } from '../../core/perception-grant.js';
import type { CollectionGrantState, CollectionSourceKind } from '../../contracts/collection.js';

/** In-memory stand-in for the N081-02 durable owner; the manager's own persistence is N081-02 scope. */
class FakeGrantStore implements CollectionGrantStorePort {
  private readonly records = new Map<string, CollectionGrantRecord>();
  readonly updates: string[] = [];

  #key(pairing: PairingScope, kind: CollectionSourceKind): string {
    return `${pairing.userId}|${pairing.characterId}|${pairing.characterInstanceId}|${kind}`;
  }

  current(pairing: PairingScope, kind: CollectionSourceKind): CollectionGrantRecord | null {
    return this.records.get(this.#key(pairing, kind)) ?? null;
  }

  insert(record: CollectionGrantRecord): CollectionGrantRecord {
    const key = this.#key(record.pairing, record.kind);
    if (this.records.has(key)) throw new Error('duplicate grant');
    this.records.set(key, record);
    return record;
  }

  update(input: {
    grantId: string; expectedRevision: number; state: CollectionGrantState; revision: number;
    expiresAt?: string; directoryRoot?: string | null; policyVersion?: number;
  }): CollectionGrantRecord {
    for (const [key, record] of this.records) {
      if (record.grantId !== input.grantId) continue;
      if (record.revision !== input.expectedRevision) throw new Error('revision conflict');
      const next: CollectionGrantRecord = {
        ...record,
        state: input.state,
        revision: input.revision,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.directoryRoot !== undefined ? { directoryRoot: input.directoryRoot } : {}),
        ...(input.policyVersion !== undefined ? { policyVersion: input.policyVersion } : {}),
      };
      this.records.set(key, next);
      this.updates.push(`${record.state}->${input.state}@${input.revision}`);
      return next;
    }
    throw new Error('grant not found');
  }
}

/** Deterministic clock so TTL/expiry assertions never sleep. */
class FakeClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = (): string => new Date(this.value).toISOString();
  advance(ms: number): void { this.value += ms; }
  /** Current instant in epoch ms, for expiry arithmetic in tests. */
  at(): number { return this.value; }
}

const pairing = productionPairing('companion', 'inst-08101');
const otherInstance = productionPairing('companion', 'inst-08101-other');
const otherUser: PairingScope = { userId: 'someone-else', characterId: 'companion', characterInstanceId: 'inst-08101' };

function managerWith(clock: FakeClock, policy = NORMAL_COLLECTION_POLICY) {
  const store = new FakeGrantStore();
  const manager = new CollectionGrantManager({ store, policy, now: clock.now });
  return { store, manager };
}

test('AC-08101-1: no authorization by default and the three sources are independent', () => {
  const clock = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const { manager } = managerWith(clock);

  for (const kind of ['keyboard', 'screenshot_directory', 'clipboard_image'] as const) {
    assert.equal(manager.current(pairing, kind), null, `${kind} must start unauthorized`);
  }

  const keyboard = manager.issue({
    pairing, kind: 'keyboard', expiresAt: new Date(clock.now ? Date.parse(clock.now()) + 60_000 : 0).toISOString(),
    expectedRevision: 0, operationId: 'op-kb-1',
  });
  assert.equal(keyboard.state, 'active');
  assert.equal(keyboard.kind, 'keyboard');
  assert.equal(keyboard.destination, 'local');
  assert.equal(keyboard.purpose, 'local_sample_trial');
  assert.equal(keyboard.directoryRoot, undefined);

  // Enabling keyboard must not authorize the other two.
  assert.equal(manager.current(pairing, 'screenshot_directory'), null);
  assert.equal(manager.current(pairing, 'clipboard_image'), null);

  // Pausing keyboard must not touch an independently enabled directory source.
  manager.issue({
    pairing, kind: 'screenshot_directory', directoryRoot: 'F:/tmp/08101/shots',
    expiresAt: new Date(Date.parse(clock.now()) + 120_000).toISOString(), expectedRevision: 0, operationId: 'op-dir-1',
  });
  const paused = manager.transition({ pairing, kind: 'keyboard', action: 'pause', expectedRevision: keyboard.revision, operationId: 'op-kb-pause' });
  assert.equal(paused.state, 'paused');
  assert.equal(manager.current(pairing, 'screenshot_directory')?.state, 'active');
});

test('AC-08101-2: expiry stops new collection and stale revisions or late callbacks are refused', () => {
  const clock = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const { manager } = managerWith(clock);

  // A 1 ms lifetime: valid at issue time, then provably elapsed once the fake clock advances.
  const grant = manager.issue({
    pairing, kind: 'keyboard', expiresAt: new Date(clock.at() + 1).toISOString(), expectedRevision: 0, operationId: 'op-a',
  });
  assert.equal(grant.revision, 1);

  // A current callback is accepted at the live revision.
  assert.equal(manager.assertActive({ grantId: grant.grantId, grantRevision: grant.revision, pairing, kind: 'keyboard' }).revision, 1);

  // Advancing the clock past expiry flips the grant and stops new collection.
  clock.advance(1);
  const expired = manager.current(pairing, 'keyboard');
  assert.equal(expired?.state, 'expired');
  assert.throws(
    () => manager.assertActive({ grantId: grant.grantId, grantRevision: grant.revision, pairing, kind: 'keyboard' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'expired',
  );

  // A stale revision (superseded notification) is refused even while the source stays active.
  const clock2 = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const second = managerWith(clock2);
  const live = second.manager.issue({
    pairing, kind: 'clipboard_image', expiresAt: new Date(Date.parse(clock2.now()) + 60_000).toISOString(),
    expectedRevision: 0, operationId: 'op-b',
  });
  const bumped = second.manager.transition({ pairing, kind: 'clipboard_image', action: 'pause', expectedRevision: live.revision, operationId: 'op-b-pause' });
  second.manager.transition({ pairing, kind: 'clipboard_image', action: 'resume', expectedRevision: bumped.revision, operationId: 'op-b-resume' });
  assert.throws(
    () => second.manager.assertActive({ grantId: live.grantId, grantRevision: live.revision, pairing, kind: 'clipboard_image' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'version_conflict',
    'a callback from a superseded revision must not be written',
  );

  // A caller believing nothing is authorized cannot overwrite a live grant.
  assert.throws(
    () => second.manager.issue({
      pairing, kind: 'clipboard_image', expiresAt: new Date(Date.parse(clock2.now()) + 60_000).toISOString(),
      expectedRevision: 0, operationId: 'op-b-clobber',
    }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'version_conflict',
  );

  // Revoked sources need a new authorization rather than a resume.
  const revoked = second.manager.transition({ pairing, kind: 'clipboard_image', action: 'revoke', expectedRevision: second.manager.current(pairing, 'clipboard_image')!.revision, operationId: 'op-revoke' });
  assert.equal(revoked.state, 'revoked');
  assert.throws(
    () => second.manager.transition({ pairing, kind: 'clipboard_image', action: 'resume', expectedRevision: revoked.revision, operationId: 'op-resume-revoked' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'invalid_request',
  );
});

test('AC-08101-3: another user or character instance can neither read nor write this pairing', () => {
  const clock = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const { manager } = managerWith(clock);
  const grant = manager.issue({
    pairing, kind: 'keyboard', expiresAt: new Date(Date.parse(clock.now()) + 60_000).toISOString(),
    expectedRevision: 0, operationId: 'op-iso',
  });

  // Different instance and different user see no grant at all.
  assert.equal(manager.current(otherInstance, 'keyboard'), null);
  assert.equal(manager.current(otherUser, 'keyboard'), null);

  // Even with the correct grantId, a mismatched pairing is refused.
  assert.throws(
    () => manager.assertActive({ grantId: grant.grantId, grantRevision: grant.revision, pairing: otherUser, kind: 'keyboard' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'not_found',
  );
  assert.throws(
    () => manager.assertActive({ grantId: grant.grantId, grantRevision: grant.revision, pairing: otherInstance, kind: 'keyboard' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'not_found',
  );

  // A cross-pairing transition cannot mutate the original grant.
  assert.throws(
    () => manager.transition({ pairing: otherUser, kind: 'keyboard', action: 'revoke', expectedRevision: 1, operationId: 'op-cross' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'not_found',
  );
  assert.equal(manager.current(pairing, 'keyboard')?.state, 'active');
});

test('AC-08101-4: a single-frame CaptureGrant cannot be presented as a continuous source grant', () => {
  const clock = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const { manager } = managerWith(clock);

  const single = new CaptureGrantManager().issueGrant({
    sessionId: 'session-08101', scopeType: 'screen', targetId: 'screen-primary',
    purpose: 'local_sample_trial', destination: 'local', duration: 'single',
  });

  // The 0.8 grant id has no collection record; using it as a collection credential is refused.
  assert.throws(
    () => manager.assertActive({ grantId: single.grantId, grantRevision: 1, pairing, kind: 'keyboard' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'not_found',
  );

  // Issuing a collection grant never reuses the 0.8 grant id space.
  const collection = manager.issue({
    pairing, kind: 'keyboard', expiresAt: new Date(Date.parse(clock.now()) + 60_000).toISOString(),
    expectedRevision: 0, operationId: 'op-separate',
  });
  assert.notEqual(collection.grantId, single.grantId);

  // And the 0.8 manager keeps its own semantics untouched.
  assert.equal(single.duration, 'single');
  assert.equal(single.destination, 'local');
});

test('AC-08101-5: pause/revoke/suspend release every listener and repeated stop stays idempotent', async () => {
  const clock = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const { manager } = managerWith(clock);
  const expiresAt = new Date(Date.parse(clock.now()) + 300_000).toISOString();

  const kinds = ['keyboard', 'screenshot_directory', 'clipboard_image'] as const;
  const grants: Record<string, string> = {};
  for (const kind of kinds) {
    const grant = manager.issue({
      pairing, kind, ...(kind === 'screenshot_directory' ? { directoryRoot: 'F:/tmp/08101/shots' } : {}),
      expiresAt, expectedRevision: 0, operationId: `op-${kind}`,
    });
    grants[kind] = grant.grantId;
  }

  // Host registrar mirror: record what is outstanding so a leak is detectable.
  const outstanding = new Set<string>();
  const registrar = {
    register(_kind: string, id: string, _release: () => void | Promise<void>) { outstanding.add(id); },
    async release(id: string) { outstanding.delete(id); },
    get outstanding() { return [...outstanding]; },
  };

  const released: string[] = [];
  for (const kind of kinds) {
    await manager.attachLease({
      kind, grantId: grants[kind]!, grantRevision: 1,
      release: () => { released.push(kind); },
    }, registrar as never);
    assert.equal(manager.hasLease(kind), true);
  }
  assert.equal(outstanding.size, 3);
  assert.equal(manager.hasLease('keyboard'), true);

  // A second live lease for the same kind is a caller bug, not a silent replacement.
  await assert.rejects(
    async () => manager.attachLease({ kind: 'keyboard', grantId: grants.keyboard!, grantRevision: 1, release: () => {} }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'invalid_request',
  );

  // Lock/pack/session suspension releases all three and pauses each active grant.
  await manager.suspendAll('session_locked', pairing);
  assert.equal(released.length, 3);
  assert.equal(manager.hasLease('keyboard'), false);
  assert.equal(manager.hasLease('screenshot_directory'), false);
  assert.equal(manager.hasLease('clipboard_image'), false);
  assert.equal(outstanding.size, 0, 'every host resource must be released');
  for (const kind of kinds) {
    assert.equal(manager.current(pairing, kind)?.state, 'paused', `${kind} must be paused after suspension`);
  }

  // Repeated close is idempotent and releases nothing twice.
  await manager.close();
  await manager.close();
  assert.equal(released.length, 3);

  // A closed manager refuses new work instead of running on stale in-memory state.
  assert.throws(
    () => manager.issue({ pairing, kind: 'keyboard', expiresAt, expectedRevision: 0, operationId: 'op-after-close' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'store_unavailable',
  );
});

test('AC-08101-6: profile ceilings, directory rules and strict input validation hold', () => {
  const clock = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const { manager } = managerWith(clock);
  const now = Date.parse(clock.now());

  // Beyond the normal 7-day ceiling is refused.
  assert.throws(
    () => manager.issue({ pairing, kind: 'keyboard', expiresAt: new Date(now + NORMAL_COLLECTION_POLICY.grantMaxDurationMs + 1).toISOString(), expectedRevision: 0, operationId: 'op-long' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'invalid_request',
  );
  // Exactly at the ceiling is allowed.
  const atCeiling = manager.issue({
    pairing, kind: 'keyboard', expiresAt: new Date(now + NORMAL_COLLECTION_POLICY.grantMaxDurationMs).toISOString(),
    expectedRevision: 0, operationId: 'op-ceiling',
  });
  assert.equal(atCeiling.state, 'active');
  // A past or unparseable expiry is refused.
  assert.throws(
    () => manager.issue({ pairing, kind: 'clipboard_image', expiresAt: new Date(now - 1).toISOString(), expectedRevision: 0, operationId: 'op-past' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'invalid_request',
  );
  assert.throws(
    () => manager.issue({ pairing, kind: 'clipboard_image', expiresAt: 'not-a-date', expectedRevision: 0, operationId: 'op-bad-date' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'invalid_request',
  );
  // Empty operationId is refused: every write must be idempotency-addressable.
  assert.throws(
    () => manager.issue({ pairing, kind: 'clipboard_image', expiresAt: new Date(now + 60_000).toISOString(), expectedRevision: 0, operationId: '  ' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'invalid_request',
  );

  // Directory rules: required for the directory source, forbidden for the others.
  assert.throws(
    () => manager.issue({ pairing, kind: 'screenshot_directory', expiresAt: new Date(now + 60_000).toISOString(), expectedRevision: 0, operationId: 'op-no-dir' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'directory_required',
  );
  assert.throws(
    () => manager.issue({ pairing, kind: 'keyboard', directoryRoot: 'F:/tmp/x', expiresAt: new Date(now + 60_000).toISOString(), expectedRevision: 0, operationId: 'op-dir-on-kb' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'directory_forbidden',
  );

  // The smoke profile has a much shorter ceiling; a normal-length grant must not fit it.
  const smokeClock = new FakeClock(now);
  const smoke = managerWith(smokeClock, SMOKE_COLLECTION_POLICY);
  assert.throws(
    () => smoke.manager.issue({
      pairing, kind: 'keyboard', expiresAt: new Date(now + NORMAL_COLLECTION_POLICY.grantMaxDurationMs).toISOString(),
      expectedRevision: 0, operationId: 'op-smoke-too-long',
    }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'invalid_request',
  );
  const bounded = smoke.manager.issue({
    pairing, kind: 'keyboard', expiresAt: new Date(now + SMOKE_COLLECTION_POLICY.grantMaxDurationMs).toISOString(),
    expectedRevision: 0, operationId: 'op-smoke-ok',
  });
  assert.equal(bounded.policyVersion, SMOKE_COLLECTION_POLICY.policyVersion);

  // Without a durable store the manager refuses to issue instead of holding unpersisted authority.
  const noStore = new CollectionGrantManager({ policy: NORMAL_COLLECTION_POLICY, now: clock.now });
  assert.equal(noStore.available, false);
  assert.throws(
    () => noStore.issue({ pairing, kind: 'keyboard', expiresAt: new Date(now + 60_000).toISOString(), expectedRevision: 0, operationId: 'op-no-store' }),
    (error: unknown) => error instanceof CollectionGrantError && error.code === 'store_unavailable',
  );
});
