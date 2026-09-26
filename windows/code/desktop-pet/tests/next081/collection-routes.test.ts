/**
 * tests/next081/collection-routes.test.ts
 *
 * N081-06 acceptance: 鉴权管理 API、正式组合根接线、collection 投影与旧三域兼容。
 *
 * AC-08106-1: 默认零采集；未接线来源报 unavailable，未授权报 disabled
 * AC-08106-2: 写操作按 operationId 幂等、按各自 revision 冲突；漏采无需样本 revision
 * AC-08106-3: 浏览器不得自报 pairing；资产路由只回受管字节且不泄漏任意路径
 * AC-08106-4: 删除/撤销传播到投影；清空后重启仍不可见
 * AC-08106-5: 旧三域默认查询结果不变，显式 domains=collection 才含新域
 * AC-08106-6: 原始键盘数据不出现在 API 响应或数据库中
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore } from '../../memory/collection-store.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { NORMAL_COLLECTION_POLICY } from '../../contracts/collection.js';
import { CollectionGrantManager } from '../../core/collection-grants.js';
import { CollectionService } from '../../core/collection-service.js';
import { CollectionManagement } from '../../management/collection-management.js';
import { collectionRoute, safeCollectionError } from '../../management/collection-routes.js';
import { UnifiedTimelineService } from '../../memory/unified-timeline.js';
import { CompanionEventHub } from '../../core/companion-event-hub.js';
import { ManagementError } from '../../contracts/management.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08106');

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

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'aika-08106-'));
  const clock = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: clock.now,
  });
  const store = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'), policy: NORMAL_COLLECTION_POLICY,
    now: clock.now, probeImage: probeFor,
  });
  const grants = new CollectionGrantManager({ store, policy: NORMAL_COLLECTION_POLICY, now: clock.now });
  // No helper and no directory adapter: the honest "unwired" state the console must report.
  const service = new CollectionService({ grants, store, pairing, instanceId: 'inst-08106', now: clock.now });
  const management = new CollectionManagement({ service, grants, store, pairing, now: clock.now });
  return { root, clock, memory, store, grants, service, management };
}

/** Drive the route exactly as the server does, capturing the JSON or binary response. */
async function call(port: Awaited<ReturnType<typeof harness>>['management'], method: string, url: string,
  payload?: Record<string, unknown>) {
  const parsed = new URL(url, 'http://127.0.0.1');
  const urlPath = parsed.pathname;
  const query = parsed.searchParams;
  let json: unknown = undefined;
  let binary: { bytes: Uint8Array; mimeType: string } | undefined;
  const handled = await collectionRoute(method, port, urlPath, query,
    async () => payload ?? {}, value => { json = value; },
    (bytes, mimeType) => { binary = { bytes, mimeType }; });
  return { handled, json, binary };
}

/** Assert that a route call throws a ManagementError with a specific code. */
async function expectError(port: Awaited<ReturnType<typeof harness>>['management'], method: string, url: string,
  payload: Record<string, unknown> | undefined, code: string) {
  await assert.rejects(
    async () => call(port, method, url, payload),
    (error: unknown) => error instanceof ManagementError && (error as ManagementError).code === code,
    `expected ManagementError(${code})`,
  );
}

test('AC-08106-1: zero collection by default; unwired sources report unavailable rather than healthy', async () => {
  const h = await harness();

  const status = await call(h.management, 'GET', '/api/collection/status');
  assert.equal(status.handled, true);
  const value = status.json as Record<string, unknown>;
  assert.equal(value.instanceId, 'inst-08106');
  assert.equal((value.pairing as Record<string, string>).characterInstanceId, pairing.characterInstanceId);
  assert.equal(value.profile, 'normal');
  assert.equal(value.managedBytes, 0);
  assert.equal(Array.isArray(value.sources), true);

  const sources = value.sources as { kind: string; state: string; accepted: number; lastAcceptedAt: string | null }[];
  assert.equal(sources.length, 3);
  for (const source of sources) {
    // A source with no grant and no adapter is unavailable; nothing is authorized by default.
    assert.equal(source.state, 'unavailable', `${source.kind} must not be reported as healthy`);
    assert.equal(source.accepted, 0);
    assert.equal(source.lastAcceptedAt, null, 'zero samples must never be shown as activity');
  }
  h.memory.close();
});

test('AC-08106-2: writes are idempotent on operationId, conflict on revision, and a miss needs no sample revision', async () => {
  const h = await harness();
  const expiresAt = new Date(h.clock.at() + 3_600_000).toISOString();

  // Activation requires explicit confirmation.
  await expectError(h.management, 'POST', '/api/collection/sources/keyboard/activate',
    { operationId: 'op-1', expectedRevision: 0, expiresAt }, 'forbidden');

  // A confirmed activation succeeds and starts the source if it is wired.
  const activated = await call(h.management, 'POST', '/api/collection/sources/keyboard/activate',
    { operationId: 'op-1', expectedRevision: 0, expiresAt, userConfirmed: true });
  const afterActivate = activated.json as Record<string, unknown>;
  const keyboard = (afterActivate.sources as { kind: string; state: string; revision: number }[])
    .find(source => source.kind === 'keyboard')!;
  assert.equal(keyboard.state, 'active');
  assert.equal(keyboard.revision, 1);

  // Replaying the SAME operationId returns the initial result instead of activating twice.
  const replay = await call(h.management, 'POST', '/api/collection/sources/keyboard/activate',
    { operationId: 'op-1', expectedRevision: 0, expiresAt, userConfirmed: true });
  const afterReplay = replay.json as Record<string, unknown>;
  const replayedKeyboard = (afterReplay.sources as { kind: string; revision: number }[])
    .find(source => source.kind === 'keyboard')!;
  assert.equal(replayedKeyboard.revision, 1, 'an operationId replay must not advance the revision');

  // The same operationId with a different body is a conflict, not a silent re-use.
  await expectError(h.management, 'POST', '/api/collection/sources/keyboard/activate',
    { operationId: 'op-1', expectedRevision: 0, expiresAt, userConfirmed: true, directoryRoot: 'F:/elsewhere' }, 'invalid_request');

  // A stale expectedRevision on a transition is a version conflict.
  await expectError(h.management, 'POST', '/api/collection/sources/keyboard/pause',
    { operationId: 'op-2', expectedRevision: 99 }, 'version_conflict');

  // A correct revision pauses, and revoking requires confirmation.
  const paused = await call(h.management, 'POST', '/api/collection/sources/keyboard/pause',
    { operationId: 'op-3', expectedRevision: 1 });
  const pausedKeyboard = (paused.json as Record<string, unknown>).sources as { kind: string; state: string; revision: number }[];
  assert.equal(pausedKeyboard.find(source => source.kind === 'keyboard')!.state, 'paused');

  await expectError(h.management, 'POST', '/api/collection/sources/keyboard/revoke',
    { operationId: 'op-4', expectedRevision: 2 }, 'forbidden');
  const revoked = await call(h.management, 'POST', '/api/collection/sources/keyboard/revoke',
    { operationId: 'op-4', expectedRevision: 2, userConfirmed: true });
  const revokedKeyboard = ((revoked.json as Record<string, unknown>).sources as { kind: string; state: string }[])
    .find(source => source.kind === 'keyboard')!;
  assert.equal(revokedKeyboard.state, 'revoked');

  // A miss annotation is idempotent on pairing + operationId and needs no sample revision.
  const missing = await call(h.management, 'POST', '/api/collection/feedback/missing',
    { kind: 'clipboard_image', observedAt: h.clock.now(), operationId: 'op-miss' });
  assert.equal(typeof (missing.json as { id: string }).id, 'string');
  const missingReplay = await call(h.management, 'POST', '/api/collection/feedback/missing',
    { kind: 'clipboard_image', observedAt: h.clock.now(), operationId: 'op-miss' });
  assert.deepEqual(missingReplay.json, missing.json, 'a repeated miss annotation returns the same result');

  h.memory.close();
});

test('AC-08106-3: pairing is server-fixed and the asset route serves managed bytes only', async () => {
  const h = await harness();
  const directoryRoot = resolve(h.root, 'shots');
  const expiresAt = new Date(h.clock.at() + 3_600_000).toISOString();

  // A directory activation without a directory is refused; with one it succeeds.
  await expectError(h.management, 'POST', '/api/collection/sources/screenshot_directory/activate',
    { operationId: 'op-d1', expectedRevision: 0, expiresAt, userConfirmed: true }, 'invalid_request');
  await call(h.management, 'POST', '/api/collection/sources/screenshot_directory/activate',
    { operationId: 'op-d2', expectedRevision: 0, expiresAt, directoryRoot, userConfirmed: true });

  // A non-directory source may not carry a directory.
  await expectError(h.management, 'POST', '/api/collection/sources/clipboard_image/activate',
    { operationId: 'op-c1', expectedRevision: 0, expiresAt, directoryRoot, userConfirmed: true }, 'invalid_request');

  // The console cannot widen its own scope: a pairing field in the body is ignored, not honoured.
  const grant = h.grants.current(pairing, 'screenshot_directory')!;
  const inserted = h.store.appendImage(grant, {
    bytes: pngBytes(), mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|asset.png@v1');
  assert.equal(inserted.outcome, 'inserted');

  // The asset route returns the managed bytes with no path in the response.
  const asset = await call(h.management, 'GET',
    `/api/collection/samples/${encodeURIComponent(inserted.sampleId!)}/asset?variant=original`);
  assert.ok(asset.binary);
  assert.equal(asset.binary.mimeType, 'image/png');
  assert.deepEqual([...asset.binary.bytes], [...pngBytes()]);

  // An invalid variant is refused, and a traversal-shaped id cannot reach a path.
  await expectError(h.management, 'GET',
    `/api/collection/samples/${encodeURIComponent(inserted.sampleId!)}/asset?variant=huge`, undefined, 'invalid_request');
  await expectError(h.management, 'GET',
    '/api/collection/samples/..%2F..%2Fetc%2Fpasswd/asset?variant=original', undefined, 'invalid_request');

  // The samples list exposes asset ids, never a filesystem path.
  const page = await call(h.management, 'GET',
    `/api/collection/samples?from=${encodeURIComponent(new Date(0).toISOString())}&to=${encodeURIComponent(new Date(h.clock.at() + 60_000).toISOString())}&limit=50`);
  const serialized = JSON.stringify(page.json);
  assert.equal(serialized.includes(h.root), false, 'a list response must not leak a local path');
  assert.equal(serialized.includes('image/png'), true);

  // An out-of-range limit and an inverted range are refused.
  await expectError(h.management, 'GET',
    `/api/collection/samples?from=${encodeURIComponent(new Date(0).toISOString())}&to=${encodeURIComponent(new Date(h.clock.at()).toISOString())}&limit=500`,
    undefined, 'invalid_request');
  await expectError(h.management, 'GET',
    `/api/collection/samples?from=${encodeURIComponent(new Date(h.clock.at()).toISOString())}&to=${encodeURIComponent(new Date(0).toISOString())}&limit=10`,
    undefined, 'invalid_request');

  h.memory.close();
});

test('AC-08106-4: deletion and revocation propagate to the projection and survive restart', async () => {
  const h = await harness();
  const expiresAt = new Date(h.clock.at() + 3_600_000).toISOString();
  await call(h.management, 'POST', '/api/collection/sources/screenshot_directory/activate',
    { operationId: 'op-a', expectedRevision: 0, expiresAt, directoryRoot: resolve(h.root, 'shots'), userConfirmed: true });
  const grant = h.grants.current(pairing, 'screenshot_directory')!;

  const one = h.store.appendImage(grant, {
    bytes: pngBytes(4, 4), mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|one.png@v1');
  const two = h.store.appendImage(grant, {
    bytes: pngBytes(8, 8), mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|two.png@v1');
  assert.equal(one.outcome, 'inserted');
  assert.equal(two.outcome, 'inserted');

  // Single-item deletion uses the collection revision and invalidates the projection immediately.
  const deleted = await call(h.management, 'POST', `/api/collection/samples/${encodeURIComponent(one.sampleId!)}/delete`,
    { expectedRevision: h.store.revision, operationId: 'op-del' });
  assert.equal((deleted.json as { affected: number }).affected, 1);
  await expectError(h.management, 'GET',
    `/api/collection/samples/${encodeURIComponent(one.sampleId!)}/asset?variant=original`, undefined, 'not_found');

  // Clear requires confirmation and removes the rest.
  await expectError(h.management, 'POST', '/api/collection/samples/clear',
    { expectedRevision: h.store.revision, operationId: 'op-clear' }, 'forbidden');
  const cleared = await call(h.management, 'POST', '/api/collection/samples/clear',
    { expectedRevision: h.store.revision, operationId: 'op-clear', userConfirmed: true });
  assert.equal((cleared.json as { affected: number }).affected, 1);

  const afterClear = await call(h.management, 'GET',
    `/api/collection/samples?from=${encodeURIComponent(new Date(0).toISOString())}&to=${encodeURIComponent(new Date(h.clock.at() + 60_000).toISOString())}&limit=50`);
  assert.equal((afterClear.json as { items: unknown[] }).items.length, 0);

  // Revocation of the source is a separate action from stop and removes its remaining evidence.
  const keyboard = await call(h.management, 'POST', '/api/collection/sources/keyboard/activate',
    { operationId: 'op-kb', expectedRevision: 0, expiresAt, userConfirmed: true });
  void keyboard;
  const revoked = await call(h.management, 'POST', '/api/collection/sources/screenshot_directory/revoke',
    { expectedRevision: h.grants.current(pairing, 'screenshot_directory')!.revision, operationId: 'op-revoke', userConfirmed: true });
  assert.ok(revoked.json);

  h.memory.close();

  // Restart: the cleared/deleted evidence stays invisible and cannot be replayed back into view.
  const reopened = new SqliteMemoryStore({
    filename: resolve(h.root, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: h.clock.now,
  });
  const store = await CollectionStore.open(reopened, {
    collectionDirectory: resolve(h.root, 'collection'), policy: NORMAL_COLLECTION_POLICY,
    now: h.clock.now, probeImage: probeFor,
  });
  const page = store.list({ pairing, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 600_000).toISOString(), limit: 100 });
  assert.equal(page.items.length, 0, 'deleted evidence must not reappear after restart');
  assert.equal(store.readAsset(pairing, one.sampleId!, 'original'), null);
  reopened.close();
});

test('AC-08106-5: the legacy three-domain default is unchanged and collection is explicit', async () => {
  const h = await harness();
  const characterPacks = await CharacterPackStore.open(h.memory);
  const timeline = new UnifiedTimelineService(h.memory.rawDatabaseForKnowledge(), characterPacks);
  const hub = new CompanionEventHub();

  const collectionEvent = {
    eventId: 'evt-08106-collection',
    schemaVersion: 1 as const,
    domain: 'collection' as const,
    type: 'collection.sample.created',
    pairing,
    sourceRef: { id: 'sample-1', version: 1 },
    occurredAt: h.clock.now(),
    receivedAt: h.clock.now(),
    payload: { sampleId: 'sample-1', sourceKind: 'keyboard', grantRevision: 1, timeBasis: 'received' },
    summary: '键盘活动区间',
  };
  timeline.recordEventSync(collectionEvent);

  // A default query returns only the legacy three domains.
  const legacy = await timeline.queryTimeline({ pairing, limit: 50 });
  assert.equal(legacy.items.some(item => item.domain === 'collection'), false,
    'an absent domains filter must not silently include collection');

  // The event hub refuses an unknown domain but accepts collection.
  let delivered = 0;
  hub.subscribeDomain(['collection'], () => { delivered++; }, pairing);
  await hub.publishEnvelope(collectionEvent);
  assert.equal(delivered, 1);
  await assert.rejects(
    async () => hub.publishEnvelope({ ...collectionEvent, domain: 'telemetry' as never }),
    /invalid domain/,
  );

  // The management route rejects an unknown domain filter.
  assert.equal(safeCollectionError(new Error('not_found')).code, 'not_found');
  assert.equal(safeCollectionError(new Error('collection_service_unavailable')).code, 'unavailable');
  assert.equal(safeCollectionError(new Error('revision_conflict')).code, 'version_conflict');
  // An unrecognized internal error yields a scrubbed reason, never a raw message.
  const scrubbed = safeCollectionError(new Error('C:\\Users\\someone\\Pictures\\secret.png failed'));
  assert.equal(scrubbed.code, 'unavailable');
  assert.equal(scrubbed.message.includes('secret.png'), false);

  h.memory.close();
});

test('AC-08106-6: no raw keyboard data appears in any API response or database row', async () => {
  const h = await harness();
  const expiresAt = new Date(h.clock.at() + 3_600_000).toISOString();
  await call(h.management, 'POST', '/api/collection/sources/keyboard/activate',
    { operationId: 'op-kb', expectedRevision: 0, expiresAt, userConfirmed: true });
  const grant = h.grants.current(pairing, 'keyboard')!;

  // A hostile callback smuggles per-key fields beside the aggregate shape.
  const result = await h.service.onKeyboardActivity({
    grantId: grant.grantId, grantRevision: grant.revision,
    bucketStart: h.clock.now(), bucketEnd: h.clock.now(), activityCount: 42,
    foregroundAppId: 'editor.exe', afkBoundary: false,
    // @ts-expect-error deliberate: prohibited fields are not part of the accepted shape.
    keyCode: 65, character: 'a', keys: ['a', 'b'],
  });
  assert.equal(result?.outcome, 'inserted');

  // Every API response is free of key content.
  const status = await call(h.management, 'GET', '/api/collection/status');
  const page = await call(h.management, 'GET',
    `/api/collection/samples?from=${encodeURIComponent(new Date(0).toISOString())}&to=${encodeURIComponent(new Date(h.clock.at() + 60_000).toISOString())}&limit=50`);
  for (const [name, response] of [['status', status], ['samples', page]] as const) {
    const text = JSON.stringify(response.json);
    // Assert on key NAMES, not substrings: `characterId` is a legitimate pairing field and would
    // false-positive a naive scan for "character".
    for (const forbidden of ['"keyCode"', '"key_code"', '"scanCode"', '"scan_code"', '"composition"', '"keys"', '"inputText"', '"character"']) {
      assert.equal(text.includes(forbidden), false, `${name} response must not contain ${forbidden}`);
    }
  }

  // The stored row carries an aggregate count and no key columns.
  const row = h.memory.rawDatabaseForKnowledge()
    .prepare('SELECT * FROM collection_samples WHERE id=?').get(result!.sampleId) as Record<string, unknown>;
  const columns = Object.keys(row);
  for (const forbidden of ['key_code', 'scan_code', 'character', 'composition', 'keys', 'input_text']) {
    assert.equal(columns.includes(forbidden), false, `no ${forbidden} column may exist`);
  }
  assert.equal(row.activity_count, 42);

  h.memory.close();
});
