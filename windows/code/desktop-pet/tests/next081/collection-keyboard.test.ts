/**
 * tests/next081/collection-keyboard.test.ts
 *
 * N081-03 acceptance: keyboard 活动聚合、AFK 边界、无正文串行化边界。
 *
 * AC-08103-1: normal/smoke 桶/静默/AFK 参数驱动聚合，鼠标-only 不产生 keyboard 活动
 * AC-08103-2: 锁屏/暂停/迟到回调不能补写；grant 复检在写入前生效
 * AC-08103-3: adapter → 存储 的序列化边界无键码/字符/逐键序列
 * AC-08103-4: 受控 helper 的真实启停、NDJSON 协议与资源释放（Windows 实机）
 * AC-08103-5: helper 缺失或清单不匹配时来源报 unavailable，产品不被破坏
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore } from '../../memory/collection-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { NORMAL_COLLECTION_POLICY, SMOKE_COLLECTION_POLICY } from '../../contracts/collection.js';
import { CollectionGrantManager } from '../../core/collection-grants.js';
import { CollectionService } from '../../core/collection-service.js';
import {
  CollectionHelperClient, CollectionHelperError, loadCollectionHelperManifest,
  collectionHelperPaths, sweepStaleStaging,
} from '../../core/collection-helper-client.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08103');
// The compiled test runs from dist/tests/next081, so walk up to the package root, not to dist/.
const projectRoot = resolve(import.meta.dirname, '..', '..', '..');

class FakeClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = (): string => new Date(this.value).toISOString();
  advance(ms: number): void { this.value += ms; }
  at(): number { return this.value; }
}

async function harness(policy = NORMAL_COLLECTION_POLICY) {
  const root = mkdtempSync(join(tmpdir(), 'aika-08103-'));
  const clock = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: clock.now,
  });
  const store = await CollectionStore.open(memory, { collectionDirectory: resolve(root, 'collection'), policy, now: clock.now });
  const grants = new CollectionGrantManager({ store, policy, now: clock.now });
  const service = new CollectionService({ grants, store, pairing, instanceId: 'inst-08103', now: clock.now });
  return { root, clock, memory, store, grants, service, policy };
}

function keyGrant(h: Awaited<ReturnType<typeof harness>>, lifetime = 600_000) {
  return h.grants.issue({
    pairing, kind: 'keyboard', expiresAt: new Date(h.clock.at() + lifetime).toISOString(),
    expectedRevision: 0, operationId: 'op-kb',
  });
}

function bucket(clock: FakeClock, count: number, afk = false, offsetMs = 0) {
  const start = new Date(clock.at() + offsetMs).toISOString();
  return {
    bucketStart: start, bucketEnd: new Date(clock.at() + offsetMs + 10_000).toISOString(),
    activityCount: count, foregroundAppId: 'code.exe', afkBoundary: afk,
  };
}

test('AC-08103-1: policy drives aggregation and zero-activity buckets are refused', async () => {
  const normal = await harness(NORMAL_COLLECTION_POLICY);
  const normalGrant = keyGrant(normal);
  const first = await normal.service.onKeyboardActivity({ ...bucket(normal.clock, 12), grantId: normalGrant.grantId, grantRevision: normalGrant.revision });
  assert.equal(first?.outcome, 'inserted');

  const page = normal.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(normal.clock.at() + 60_000).toISOString(), limit: 50 });
  const sample = page.items[0]!;
  assert.ok(sample.sampleKind === 'keyboard_activity');
  assert.equal(sample.activityCount, 12);
  assert.equal(sample.foregroundAppId, 'code.exe');
  assert.equal(sample.afkBoundary, false);
  // The stored fragment is an interval, not a keystroke log.
  assert.equal(typeof sample.bucketStart, 'string');
  assert.equal(typeof sample.bucketEnd, 'string');

  // A mouse-only period produces zero-count buckets; nothing is fabricated from mouse movement.
  const empty = await normal.service.onKeyboardActivity({ ...bucket(normal.clock, 0), grantId: normalGrant.grantId, grantRevision: normalGrant.revision });
  assert.equal(empty, null, 'a zero-activity bucket must not become an activity fragment');
  const negative = await normal.service.onKeyboardActivity({ ...bucket(normal.clock, -5), grantId: normalGrant.grantId, grantRevision: normalGrant.revision });
  assert.equal(negative, null);

  const after = normal.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(normal.clock.at() + 60_000).toISOString(), limit: 50 });
  assert.equal(after.items.length, 1, 'mouse-only movement adds no keyboard evidence');
  normal.memory.close();

  // The same bucket boundary logic is exercised with the smoke numbers, proving policy-driven shape.
  const smoke = await harness(SMOKE_COLLECTION_POLICY);
  const smokeGrant = keyGrant(smoke, SMOKE_COLLECTION_POLICY.grantMaxDurationMs);
  assert.equal(smoke.store.policy.keyboardBucketMs, 1_000);
  assert.equal(smoke.store.policy.keyboardQuietMs, 2_000);
  assert.equal(smoke.store.policy.afkMs, 15_000);
  const inserted = await smoke.service.onKeyboardActivity({ ...bucket(smoke.clock, 3), grantId: smokeGrant.grantId, grantRevision: smokeGrant.revision });
  assert.equal(inserted?.outcome, 'inserted');
  smoke.memory.close();
});

test('AC-08103-2: pause, revoke, expiry and stale revisions cannot be backfilled', async () => {
  const h = await harness();
  const grant = keyGrant(h);

  // Live bucket is accepted.
  assert.equal((await h.service.onKeyboardActivity({ ...bucket(h.clock, 5), grantId: grant.grantId, grantRevision: grant.revision }))?.outcome, 'inserted');

  // Paused: the same notification is refused and nothing is written.
  h.grants.transition({ pairing, kind: 'keyboard', action: 'pause', expectedRevision: grant.revision, operationId: 'op-pause' });
  h.clock.advance(120_000);
  const duringPause = await h.service.onKeyboardActivity({ ...bucket(h.clock, 9), grantId: grant.grantId, grantRevision: grant.revision });
  assert.equal(duringPause, null, 'a bucket arriving while paused must not be written');

  // Resumed: only NEW events are accepted; the paused interval is not reconstructed.
  const resumed = h.grants.transition({ pairing, kind: 'keyboard', action: 'resume', expectedRevision: h.grants.current(pairing, 'keyboard')!.revision, operationId: 'op-resume' });
  const stale = await h.service.onKeyboardActivity({ ...bucket(h.clock, 4), grantId: grant.grantId, grantRevision: grant.revision });
  assert.equal(stale, null, 'a callback from a superseded revision must not be written');
  const fresh = await h.service.onKeyboardActivity({ ...bucket(h.clock, 4, false, 20_000), grantId: grant.grantId, grantRevision: resumed.revision });
  assert.equal(fresh?.outcome, 'inserted', 'a current revision is accepted after resume');

  // Revoked: further notifications are refused.
  h.grants.transition({ pairing, kind: 'keyboard', action: 'revoke', expectedRevision: h.grants.current(pairing, 'keyboard')!.revision, operationId: 'op-revoke' });
  const afterRevoke = await h.service.onKeyboardActivity({ ...bucket(h.clock, 6, false, 40_000), grantId: grant.grantId, grantRevision: resumed.revision });
  assert.equal(afterRevoke, null);

  // Only the two genuinely accepted fragments exist.
  const page = h.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 120_000).toISOString(), limit: 50 });
  assert.equal(page.items.length, 2);

  // Expiry behaves the same way.
  const expiring = await harness();
  const shortLived = keyGrant(expiring, 1);
  expiring.clock.advance(5);
  const afterExpiry = await expiring.service.onKeyboardActivity({ ...bucket(expiring.clock, 7), grantId: shortLived.grantId, grantRevision: shortLived.revision });
  assert.equal(afterExpiry, null, 'an expired grant cannot accept new activity');
  h.memory.close();
  expiring.memory.close();
});

test('AC-08103-3: the serialization boundary carries no keys and the store keeps aggregates only', async () => {
  const h = await harness();
  const grant = keyGrant(h);
  // A hostile callback attempts to smuggle per-key data alongside the aggregate shape.
  const smuggled = await h.service.onKeyboardActivity({
    ...bucket(h.clock, 2), grantId: grant.grantId, grantRevision: grant.revision,
    // @ts-expect-error deliberate: prohibited fields are not part of the accepted shape.
    keyCode: 65, scanCode: 30, character: 'a', composition: 'a', keys: ['a', 'b'],
  });
  assert.equal(smuggled?.outcome, 'inserted');

  const db = h.memory.rawDatabaseForKnowledge();
  const row = db.prepare('SELECT * FROM collection_samples WHERE id=?').get(smuggled!.sampleId) as Record<string, unknown>;
  const columns = Object.keys(row);
  for (const forbidden of ['key_code', 'scan_code', 'character', 'composition', 'keys', 'sequence', 'input_text', 'text']) {
    assert.equal(columns.includes(forbidden), false, `no ${forbidden} column may exist`);
  }
  // The smuggling attempt left no trace in any column value.
  const values = JSON.stringify(Object.values(row));
  for (const leak of ['"a","b"', '"keyCode"', '"scanCode"']) {
    assert.equal(values.includes(leak), false, `stored row leaked ${leak}`);
  }
  assert.equal(row.activity_count, 2, 'only the aggregate count is persisted');

  // The helper client refuses an upstream message carrying forbidden fields. The parser is public
  // precisely so this guard is proven without an OS transport.
  const rejected: string[] = [];
  const client = new CollectionHelperClient({
    paths: { binaryPath: 'nonexistent.exe', manifestPath: 'nonexistent.json', stagingRoot: join(h.root, 'staging') },
    instanceId: 'inst-08103',
    onEvent: event => rejected.push(String(event.payload.code ?? event.op)),
  });
  // A clean message is accepted and surfaced.
  client.handleUpstreamLine(JSON.stringify({ op: 'activity', kind: 'keyboard', requestId: 'r1', grantRevision: 1, payload: { bucketStart: 'x', activityCount: 3 } }));
  assert.deepEqual(rejected, ['activity']);
  rejected.length = 0;
  // A payload smuggling a character field is refused outright and never forwarded.
  client.handleUpstreamLine(JSON.stringify({ op: 'activity', kind: 'keyboard', requestId: 'r2', grantRevision: 1, payload: { activityCount: 3, character: 'a' } }));
  assert.deepEqual(rejected, ['forbidden_upstream_field'], 'a payload carrying text must be refused');
  rejected.length = 0;
  // A top-level key field is likewise refused.
  client.handleUpstreamLine(JSON.stringify({ op: 'activity', keyCode: 65, kind: 'keyboard', requestId: 'r3', grantRevision: 1, payload: {} }));
  assert.deepEqual(rejected, ['forbidden_upstream_field'], 'a top-level key field must be refused');
  rejected.length = 0;
  // Malformed JSON is reported as a code, not thrown into the stream handler.
  client.handleUpstreamLine('{ not json');
  assert.deepEqual(rejected, ['malformed_upstream']);
  h.memory.close();
});

test('AC-08103-4: the real helper aggregates injected keystrokes and releases on stop', { skip: process.platform !== 'win32' }, async () => {
  const paths = collectionHelperPaths(projectRoot);
  const manifest = loadCollectionHelperManifest(paths);
  // A missing artifact must be reported as NOT_RUN explicitly. It must never be silently skipped:
  // this test is the only evidence that the real native keyboard source works.
  assert.ok(manifest, `NOT_RUN: collection helper artifact missing at ${paths.binaryPath}; run npm run build:collection.`);

  const stagingRoot = mkdtempSync(join(tmpdir(), 'aika-08103-stage-'));
  const instanceId = `inst-${Date.now()}`;
  const events: { op: string; kind: string; grantRevision: number; raw: string; payload: Record<string, unknown> }[] = [];
  const client = new CollectionHelperClient({
    paths: { ...paths, stagingRoot },
    instanceId,
    onEvent: event => events.push({
      op: event.op, kind: event.kind, grantRevision: event.grantRevision,
      raw: JSON.stringify(event.payload), payload: event.payload,
    }),
  });

  try {
    client.start();
    assert.equal(client.running, true);

    // A short bucket makes the aggregation window observable within the test's lifetime.
    const policy = { keyboardBucketMs: 1_000, keyboardQuietMs: 500, afkMs: 15_000 };
    await client.startKeyboard({ grantId: 'g-real', grantRevision: 7, policy });
    await new Promise(done => setTimeout(done, 250));

    // Inject synthetic keystrokes so a headless run still exercises the real Raw Input path.
    const { spawnSync } = await import('node:child_process');
    const injectKeys = () => spawnSync('powershell', ['-NoProfile', '-Command',
      'Add-Type -Namespace W -Name K -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);\';'
      + ' for ($i=0; $i -lt 12; $i++) { [W.K]::keybd_event(0x41,0,0,[System.UIntPtr]::Zero); [W.K]::keybd_event(0x41,0,2,[System.UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }',
    ], { windowsHide: true, stdio: 'ignore' });

    injectKeys();
    await new Promise(done => setTimeout(done, 2_000));
    if (events.filter(e => e.op === 'activity').length === 0) {
      injectKeys();
      await new Promise(done => setTimeout(done, 2_000));
    }
    await client.stopKeyboard({ grantId: 'g-real', grantRevision: 7 });
    await new Promise(done => setTimeout(done, 200));

    // The real source produced at least one aggregate bucket carrying the live grant revision.
    const activity = events.filter(event => event.op === 'activity');
    assert.ok(activity.length >= 1, 'the real Raw Input path must report at least one activity bucket');
    const bucket = activity[0]!;
    assert.equal(bucket.grantRevision, 7, 'the bucket must echo the live grant revision');
    assert.equal(typeof bucket.payload.activityCount, 'number');
    assert.ok(Number(bucket.payload.activityCount) > 0, 'a bucket means activity happened');
    assert.equal(typeof bucket.payload.bucketStart, 'string');
    assert.equal(typeof bucket.payload.bucketEnd, 'string');
    // The reported instant must be a real current time, not a mis-based file-time epoch.
    const start = Date.parse(String(bucket.payload.bucketStart));
    assert.equal(Number.isNaN(start), false, 'bucketStart must be a parseable ISO instant');
    assert.equal(Math.abs(Date.now() - start) < 600_000, true, 'bucketStart must be near the actual wall clock');

    // No key identity may appear anywhere in the upstream payload.
    for (const event of events) {
      for (const forbidden of ['keyCode', 'key_code', 'scanCode', 'scan_code', 'character', 'composition', 'keys', 'sequence']) {
        assert.equal(event.raw.includes(forbidden), false, `upstream payload must not contain ${forbidden}`);
      }
    }

    await client.close();
    assert.equal(client.running, false);

    // Repeated close is idempotent and leaks no process.
    await client.close();
    assert.equal(client.running, false);

    // `forbidden_upstream_field` must never have been reported: the helper emits aggregates only.
    const forbidden = events.filter(event => event.payload.code === 'forbidden_upstream_field');
    assert.equal(forbidden.length, 0, 'the real helper must not send key/text fields');
    const errors = events.filter(event => event.op === 'error');
    for (const error of errors) {
      assert.notEqual(error.payload.code, 'keyboard_unavailable', 'keyboard observation must be available in this session');
    }
  } finally {
    if (client.running) await client.close();
  }
});

test('AC-08103-5: a missing or mismatched helper reports unavailable without breaking the product', async () => {
  const h = await harness();
  const grant = keyGrant(h);
  void grant;

  const absentPaths = { binaryPath: join(h.root, 'absent.exe'), manifestPath: join(h.root, 'absent.json'), stagingRoot: join(h.root, 'staging') };
  assert.equal(loadCollectionHelperManifest(absentPaths), null);
  const client = new CollectionHelperClient({ paths: absentPaths, instanceId: 'inst-08103', onEvent: () => undefined });
  assert.equal(client.running, false);
  assert.throws(() => client.start(), (error: unknown) => error instanceof CollectionHelperError && error.code === 'helper_unavailable');

  // The service reports the keyboard source as active (it has a live grant) but refuses to start
  // it because no adapter is wired; an unwired source is `unavailable`, never a false "healthy".
  const status = h.service.status();
  const keyboard = status.sources.find(source => source.kind === 'keyboard')!;
  assert.equal(keyboard.state, 'active', 'an active grant is reported as active');
  await assert.rejects(async () => h.service.startSource('keyboard'), /keyboard_source_unavailable/);

  // Unwired sources are reported unavailable, which is distinct from simply not authorized.
  const directory = status.sources.find(source => source.kind === 'screenshot_directory')!;
  assert.equal(directory.state, 'unavailable');
  const clipboard = status.sources.find(source => source.kind === 'clipboard_image')!;
  assert.equal(clipboard.state, 'unavailable');
  // Zero accepted samples with a live grant are still reported as zero, never as healthy traffic.
  assert.equal(directory.accepted, 0);
  assert.equal(directory.lastAcceptedAt, null);

  // A manifest that disagrees with this build is refused rather than partially trusted.
  const badDirectory = mkdtempSync(join(tmpdir(), 'aika-08103-bad-'));
  writeFileSync(join(badDirectory, 'aika-collection-helper.exe'), 'not-a-real-binary');
  writeFileSync(join(badDirectory, 'helper-build.json'), JSON.stringify({ schemaVersion: 1, protocolSchemaVersion: 2, platform: 'win32', maxLineLength: 1024 }));
  assert.equal(loadCollectionHelperManifest({
    binaryPath: join(badDirectory, 'aika-collection-helper.exe'),
    manifestPath: join(badDirectory, 'helper-build.json'),
    stagingRoot: badDirectory,
  }), null, 'a manifest from another protocol revision must be refused');

  // Staged files beyond the age cap are swept; fresh ones are kept.
  const sweepRoot = mkdtempSync(join(tmpdir(), 'aika-08103-sweep-'));
  const instanceDirectory = join(sweepRoot, 'inst-x');
  mkdirSync(instanceDirectory, { recursive: true });
  writeFileSync(join(instanceDirectory, 'old.bmp'), 'x');
  const removed = sweepStaleStaging(sweepRoot, 0, Date.now() + 10_000);
  assert.equal(removed, 1);
  assert.equal(readdirSync(instanceDirectory).length, 0);
  assert.equal(existsSync(sweepRoot), true);

  await client.close();
  await h.service.close();
  h.memory.close();
});
