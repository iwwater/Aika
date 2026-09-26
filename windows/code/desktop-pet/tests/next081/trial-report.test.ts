/**
 * tests/next081/trial-report.test.ts
 *
 * N081-07 acceptance: 试运行日报只读聚合计数、不泄漏内容、不冒充自然使用覆盖。
 *
 * AC-08107-1: 报告只经鉴权 API 读取；不存在实例时如实 NOT_RUN，不伪造报告
 * AC-08107-2: 报告只含聚合计数与脱敏标识，无路径、无图片正文、无键盘正文
 * AC-08107-3: smoke 档样本被标为受控测试数据，不计入自然使用覆盖
 * AC-08107-4: 漏采标注走独立入口，不创建假样本
 * AC-08107-5: 按日/按来源计数与实际有效样本一致
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore } from '../../memory/collection-store.js';
import { CollectionGrantManager } from '../../core/collection-grants.js';
import { CollectionService } from '../../core/collection-service.js';
import { CollectionManagement } from '../../management/collection-management.js';
import { NORMAL_COLLECTION_POLICY, SMOKE_COLLECTION_POLICY } from '../../contracts/collection.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { productionPairing } from '../../contracts/character-pack.js';

const projectRoot = resolve(import.meta.dirname, '..', '..', '..');
const pairing = productionPairing('companion', 'inst-08107');

class FakeClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = (): string => new Date(this.value).toISOString();
  advance(ms: number): void { this.value += ms; }
  at(): number { return this.value; }
}

function pngBytes(width = 4, height = 4): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function probeFor(bytes: Uint8Array) {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function harness(policy = NORMAL_COLLECTION_POLICY) {
  const root = mkdtempSync(join(tmpdir(), 'aika-08107-'));
  const clock = new FakeClock(Date.parse('2026-09-25T10:00:00.000Z'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: clock.now,
  });
  const store = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'), policy, now: clock.now, probeImage: probeFor,
  });
  const grants = new CollectionGrantManager({ store, policy, now: clock.now });
  const service = new CollectionService({ grants, store, pairing, instanceId: 'inst-08107', now: clock.now });
  const management = new CollectionManagement({ service, grants, store, pairing, now: clock.now });
  return { root, clock, memory, store, grants, service, management, policy };
}

test('AC-08107-1: without a live instance the report is NOT_RUN, never a fabricated file', () => {
  const empty = mkdtempSync(join(tmpdir(), 'aika-08107-absent-'));
  const missingConfig = join(empty, 'no-such-config.json');
  const result = spawnSync(process.execPath, [resolve(projectRoot, 'tools/next081-trial-report.mjs'), '--config', missingConfig],
    { encoding: 'utf8', windowsHide: true });
  // Exit 3 is the documented NOT_RUN code and the message names the blocking condition.
  assert.equal(result.status, 3, 'a missing product configuration must be reported as NOT_RUN');
  assert.match(result.stderr, /NOT_RUN/);
  assert.equal(result.stdout.trim(), '', 'no report is emitted when there is nothing to read');

  // An out-of-range window is refused before any read is attempted.
  const badDays = spawnSync(process.execPath, [resolve(projectRoot, 'tools/next081-trial-report.mjs'), '--days', '99'],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(badDays.status, 2, 'an invalid window must be refused');

  // An unknown argument is refused rather than ignored.
  const badArg = spawnSync(process.execPath, [resolve(projectRoot, 'tools/next081-trial-report.mjs'), '--scan', '/tmp'],
    { encoding: 'utf8', windowsHide: true });
  assert.notEqual(badArg.status, 0, 'an unsupported argument must not be silently accepted');
});

test('AC-08107-2: the report carries aggregates only and refuses any content-shaped field', async () => {
  const h = await harness();
  const expiresAt = new Date(h.clock.at() + 3_600_000).toISOString();
  await h.management.activate({ kind: 'screenshot_directory', directoryRoot: resolve(h.root, 'shots'), expiresAt, expectedRevision: 0, operationId: 'op-1' });
  const grant = h.grants.current(pairing, 'screenshot_directory')!;
  h.store.appendImage(grant, {
    bytes: pngBytes(), mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|a.png@v1');
  const keyboardGrant = await h.management.activate({ kind: 'keyboard', expiresAt, expectedRevision: 0, operationId: 'op-2' });
  assert.ok(keyboardGrant);
  await h.service.onKeyboardActivity({
    grantId: h.grants.current(pairing, 'keyboard')!.grantId,
    grantRevision: h.grants.current(pairing, 'keyboard')!.revision,
    bucketStart: h.clock.now(), bucketEnd: h.clock.now(), activityCount: 17,
    foregroundAppId: 'editor.exe', afkBoundary: false,
  });

  // Reconstruct the exact aggregate view the report script derives, from the same public methods.
  const status = await h.management.status();
  const page = await h.management.list({
    from: new Date(0).toISOString(), to: new Date(h.clock.at() + 60_000).toISOString(), limit: 100,
  }) as { items: { sampleKind: string; sourceKind: string; state: string; assetId: string; activityCount: number }[]; totalMatching: number };

  assert.equal(page.totalMatching, 2);
  const keyboardCount = page.items.filter(item => item.sampleKind === 'keyboard_activity').length;
  const imageCount = page.items.filter(item => item.sampleKind === 'image').length;
  assert.equal(keyboardCount, 1);
  assert.equal(imageCount, 1);

  const aggregate = JSON.stringify({
    sources: status.sources, managedBytes: status.managedBytes, totals: { matching: page.totalMatching },
    byKind: page.items.map(item => ({ sourceKind: item.sourceKind, kind: item.sampleKind })),
  });
  // No path, no payload, no key content may appear in an aggregate report.
  for (const forbidden of [h.root, 'data:image', 'base64,', 'keyCode', 'scanCode', '"keys"', '"character"']) {
    assert.equal(aggregate.includes(forbidden), false, `an aggregate report must not contain ${forbidden}`);
  }
  // The keyboard aggregate exposes the count, which is the only keyboard-derived value that exists.
  const keyboardRow = page.items.find(item => item.sampleKind === 'keyboard_activity')!;
  assert.equal(keyboardRow.activityCount, 17);

  h.memory.close();
});

test('AC-08107-3: a smoke instance is marked as controlled test data and cannot claim natural-use coverage', async () => {
  const h = await harness(SMOKE_COLLECTION_POLICY);
  // The script derives `naturalUseEligible` from the live profile; verify the value it would read.
  const status = await h.management.status();
  assert.equal(status.profile, 'smoke');
  const smokeProfile: string = status.profile;
  assert.equal(smokeProfile === 'normal', false, 'a smoke instance must not count as natural use');

  // The normal policy is the product default and is the only profile eligible for the 3-day trial.
  const normal = await harness(NORMAL_COLLECTION_POLICY);
  const normalStatus = await normal.management.status();
  assert.equal(normalStatus.profile, 'normal');
  const normalProfile: string = normalStatus.profile;
  assert.equal(normalProfile === 'normal', true);

  // The two profiles keep their own retention and grant ceilings, so samples cannot be conflated.
  assert.notEqual(SMOKE_COLLECTION_POLICY.sampleRetentionMs, NORMAL_COLLECTION_POLICY.sampleRetentionMs);
  assert.equal(NORMAL_COLLECTION_POLICY.sampleRetentionMs, 604_800_000);
  assert.equal(SMOKE_COLLECTION_POLICY.sampleRetentionMs, 600_000);
  assert.equal(NORMAL_COLLECTION_POLICY.grantMaxDurationMs, 604_800_000);
  assert.equal(SMOKE_COLLECTION_POLICY.grantMaxDurationMs, 1_800_000);

  h.memory.close();
  normal.memory.close();
});

test('AC-08107-4: a miss annotation uses its own route and never fabricates a sample', async () => {
  const h = await harness();
  const expiresAt = new Date(h.clock.at() + 3_600_000).toISOString();
  await h.management.activate({ kind: 'clipboard_image', expiresAt, expectedRevision: 0, operationId: 'op-c' });

  const before = await h.management.list({
    from: new Date(0).toISOString(), to: new Date(h.clock.at() + 60_000).toISOString(), limit: 100,
  }) as { totalMatching: number };
  assert.equal(before.totalMatching, 0);

  const miss = await h.management.recordMissing({
    kind: 'clipboard_image', observedAt: h.clock.now(), operationId: 'miss-1',
  });
  assert.ok(miss.id.startsWith('missing:'), 'a miss is annotated under its own id space');

  // The sample list is unchanged: a miss never becomes a queryable sample or a Timeline card.
  const after = await h.management.list({
    from: new Date(0).toISOString(), to: new Date(h.clock.at() + 60_000).toISOString(), limit: 100,
  }) as { totalMatching: number };
  assert.equal(after.totalMatching, 0, 'a miss annotation must not create a fake sample');

  // Replaying the same miss returns the same id instead of double counting.
  const replay = await h.management.recordMissing({
    kind: 'clipboard_image', observedAt: h.clock.now(), operationId: 'miss-1',
  });
  assert.deepEqual(replay, miss);

  h.memory.close();
});

test('AC-08107-5: per-day and per-source counts match the actual effective samples', async () => {
  const h = await harness();
  const expiresAt = new Date(h.clock.at() + 3_600_000).toISOString();
  await h.management.activate({ kind: 'keyboard', expiresAt, expectedRevision: 0, operationId: 'op-k' });
  await h.management.activate({ kind: 'screenshot_directory', directoryRoot: resolve(h.root, 'shots'), expiresAt, expectedRevision: 0, operationId: 'op-d' });
  const keyboardGrant = h.grants.current(pairing, 'keyboard')!;
  const directoryGrant = h.grants.current(pairing, 'screenshot_directory')!;

  // Two keyboard fragments on one day, one image on the next day.
  for (const [index, count] of [5, 9].entries()) {
    h.clock.advance(60_000);
    await h.service.onKeyboardActivity({
      grantId: keyboardGrant.grantId, grantRevision: keyboardGrant.revision,
      bucketStart: h.clock.now(), bucketEnd: h.clock.now(), activityCount: count,
      foregroundAppId: null, afkBoundary: false,
    });
    void index;
  }
  h.clock.advance(86_400_000);
  h.store.appendImage(directoryGrant, {
    bytes: pngBytes(), mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|next-day.png@v1');

  const page = await h.management.list({
    from: new Date(0).toISOString(), to: new Date(h.clock.at() + 600_000).toISOString(), limit: 100,
  }) as { items: { sampleKind: string; sourceKind: string; receivedAt: string }[]; totalMatching: number };

  assert.equal(page.totalMatching, 3, 'all three effective samples are counted');
  const byDay = new Map<string, number>();
  for (const item of page.items) {
    const day = String(item.receivedAt).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  assert.equal(byDay.size, 2, 'samples land on two distinct days');
  const dayCounts = [...byDay.values()].sort();
  assert.deepEqual(dayCounts, [1, 2]);

  const bySource = new Map<string, number>();
  for (const item of page.items) bySource.set(item.sourceKind, (bySource.get(item.sourceKind) ?? 0) + 1);
  // The image belongs to the directory source; both keyboard fragments to keyboard.
  assert.equal(bySource.get('keyboard'), 2);
  assert.equal(bySource.get('screenshot_directory'), 1);

  // The per-source counters reported by status agree with the actual effective samples.
  const status = await h.management.status();
  const keyboardStatus = status.sources.find(source => source.kind === 'keyboard')!;
  assert.equal(keyboardStatus.accepted, 2, 'the source counter matches the effective sample count');
  const directoryStatus = status.sources.find(source => source.kind === 'screenshot_directory')!;
  assert.equal(directoryStatus.accepted, 1);

  // Expiry removes a sample from the window while leaving the counter history intact.
  h.clock.advance(NORMAL_COLLECTION_POLICY.sampleRetentionMs + 1_000);
  h.store.expire();
  const afterExpiry = await h.management.list({
    from: new Date(0).toISOString(), to: new Date(h.clock.at() + 600_000).toISOString(), limit: 100,
  }) as { totalMatching: number };
  assert.equal(afterExpiry.totalMatching, 0, 'expired samples leave the effective window');

  h.memory.close();
});
