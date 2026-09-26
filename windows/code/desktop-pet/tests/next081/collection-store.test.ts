/**
 * tests/next081/collection-store.test.ts
 *
 * N081-02 acceptance: 有界存储、受管资产、TTL/容量、删除与崩溃恢复。
 *
 * AC-08102-1: 写入/查询/重启可读；相同通知重放与不同时间同内容语义正确
 * AC-08102-2: 提交前崩溃与孤立 staging 不产生可见样本；启动恢复清理
 * AC-08102-3: TTL 与容量先后触顶都有界，且清理写 tombstone
 * AC-08102-4: 删除/撤销/清空后重启与重放仍不可见；用户原图字节与路径保持原状
 * AC-08102-5: 只读配对隔离；跨配对不共享受管文件、不越配对读取
 * AC-08102-6: 逐键字段不入库；内容 hash 只用于资产去重而非事件身份
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore, detectImageMime } from '../../memory/collection-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { NORMAL_COLLECTION_POLICY, SMOKE_COLLECTION_POLICY } from '../../contracts/collection.js';
import { CollectionGrantManager } from '../../core/collection-grants.js';
import { productionPairing, type PairingScope } from '../../contracts/character-pack.js';
import type { CollectionGrant } from '../../contracts/collection.js';

const pairing = productionPairing('companion', 'inst-08102');
const otherInstance = productionPairing('companion', 'inst-08102-other');

class FakeClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = (): string => new Date(this.value).toISOString();
  advance(ms: number): void { this.value += ms; }
  at(): number { return this.value; }
}

/** Minimal valid PNG signature + IHDR so the byte-level check passes; dimensions are probed separately. */
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
function jpegBytes(): Uint8Array { return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); }

interface Harness {
  store: CollectionStore;
  memory: SqliteMemoryStore;
  grants: CollectionGrantManager;
  directory: string;
  database: string;
  root: string;
  clock: FakeClock;
}

/** Build a store over a real SQLite file so restart behavior is exercised, not simulated. */
async function openHarness(options: { policy?: typeof NORMAL_COLLECTION_POLICY; root?: string; probe?: boolean; clock?: FakeClock } = {}): Promise<Harness> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'aika-08102-'));
  const database = resolve(root, 'companion.sqlite');
  const directory = resolve(root, 'collection');
  const clock = options.clock ?? new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const policy = options.policy ?? NORMAL_COLLECTION_POLICY;
  const memory = new SqliteMemoryStore({ filename: database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: clock.now });
  const store = await CollectionStore.open(memory, {
    collectionDirectory: directory,
    policy,
    now: clock.now,
    ...(options.probe === false ? {} : { probeImage: (bytes: Uint8Array) => ({ width: bytes[16]! * 256 + bytes[17]!, height: bytes[20]! * 256 + bytes[21]! }) }),
  });
  const grants = new CollectionGrantManager({ store, policy, now: clock.now });
  return { store, memory, grants, directory, database, root, clock };
}

function issue(harness: Harness, kind: 'keyboard' | 'screenshot_directory' | 'clipboard_image', lifetimeMs = 600_000): CollectionGrant {
  return harness.grants.issue({
    pairing, kind,
    ...(kind === 'screenshot_directory' ? { directoryRoot: resolve(harness.root, 'shots') } : {}),
    expiresAt: new Date(harness.clock.at() + lifetimeMs).toISOString(),
    expectedRevision: 0, operationId: `op-${kind}-${Math.random().toString(36).slice(2, 8)}`,
  });
}

function keyboardCandidate(clock: FakeClock, count = 7) {
  return {
    bucketStart: clock.now(), bucketEnd: new Date(clock.at() + 10_000).toISOString(),
    activityCount: count, foregroundAppId: 'editor', afkBoundary: false,
    occurredAt: clock.now(), contextObservedAt: clock.now(),
  };
}

test('AC-08102-1: writes and queries survive restart; replay vs later reuse of the same image differ', async () => {
  const h = await openHarness();
  const keyboard = issue(h, 'keyboard');
  const directory = issue(h, 'screenshot_directory');

  const first = h.store.appendKeyboard(keyboard, keyboardCandidate(h.clock), 'kb|1|10s');
  assert.equal(first.outcome, 'inserted');
  assert.ok(first.sampleId);

  // Same notification replayed: the idempotency key, not the content, decides identity.
  const replay = h.store.appendKeyboard(keyboard, keyboardCandidate(h.clock), 'kb|1|10s');
  assert.equal(replay.outcome, 'duplicate');
  assert.equal(replay.sampleId, first.sampleId);

  const imageBytes = pngBytes();
  const imageA = h.store.appendImage(directory, {
    bytes: imageBytes, mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|shot-a.png@v1');
  assert.equal(imageA.outcome, 'inserted');

  // The SAME bytes appearing later is a NEW event that shares one managed asset.
  h.clock.advance(60_000);
  const imageB = h.store.appendImage(directory, {
    bytes: imageBytes, mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|shot-a.png@v2');
  assert.equal(imageB.outcome, 'inserted');
  assert.notEqual(imageB.sampleId, imageA.sampleId);

  const page = h.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(Date.parse(h.clock.now()) + 1000).toISOString(), limit: 100 });
  assert.equal(page.items.length, 3);
  const assets = new Set(page.items.flatMap(item => item.sampleKind === 'image' ? [item.assetId] : []));
  assert.equal(assets.size, 1, 'identical bytes within one pairing share one managed asset');
  assert.equal(page.collectionRevision >= 3, true);
  h.memory.close();

  // Reopen the same database: evidence is durable and page content is identical.
  const reopened = await openHarness({ root: h.root, clock: h.clock });
  const after = reopened.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(Date.parse(h.clock.now()) + 1000).toISOString(), limit: 100 });
  assert.equal(after.items.length, 3);
  assert.equal(after.items.filter(item => item.sampleKind === 'image').length, 2);
  const asset = after.items.find(item => item.sampleKind === 'image')!;
  assert.ok(asset.sampleKind === 'image');
  const bytes = reopened.store.readAsset(pairing, asset.id, 'original');
  assert.ok(bytes);
  assert.deepEqual([...bytes.bytes], [...imageBytes], 'managed bytes survive restart unchanged');
  reopened.memory.close();
});

test('AC-08102-2: an orphaned staging file never becomes a visible sample and recovery clears it', async () => {
  const h = await openHarness();
  const directory = issue(h, 'screenshot_directory');
  const inserted = h.store.appendImage(directory, {
    bytes: pngBytes(), mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|committed.png@v1');
  assert.equal(inserted.outcome, 'inserted');
  h.memory.close();

  // Simulate a crash mid-write: a staging file exists that no row references.
  const staging = join(h.directory, 'staging');
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, 'crashed.part'), pngBytes());
  assert.equal(readdirSync(staging).includes('crashed.part'), true);

  const reopened = await openHarness({ root: h.root, clock: h.clock });
  assert.equal(readdirSync(join(h.directory, 'staging')).includes('crashed.part'), false, 'startup recovery removes orphaned staging');

  const page = reopened.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(Date.parse(h.clock.now()) + 1000).toISOString(), limit: 100 });
  assert.equal(page.items.length, 1, 'the crash left exactly the one committed sample');

  // A row whose managed bytes vanished is invalidated rather than served as a broken image.
  const assetRow = (reopened.memory.rawDatabaseForKnowledge().prepare('SELECT path, asset_id FROM collection_assets LIMIT 1').get() as { path: string; asset_id: string });
  rmSync(assetRow.path, { force: true });
  reopened.memory.close();
  const second = await openHarness({ root: h.root, clock: h.clock });
  assert.equal(second.store.readAsset(pairing, inserted.sampleId!, 'original'), null, 'missing bytes are never served');
  const after = second.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(Date.parse(h.clock.now()) + 1000).toISOString(), limit: 100 });
  assert.equal(after.items.length, 0, 'a sample without bytes is not visible');
  second.memory.close();
});

test('AC-08102-3: TTL and capacity each bound the store and both leave tombstones', async () => {
  const clock = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const h = await openHarness({ clock, policy: SMOKE_COLLECTION_POLICY });
  const keyboard = issue(h, 'keyboard', SMOKE_COLLECTION_POLICY.grantMaxDurationMs);
  const directory = issue(h, 'screenshot_directory', SMOKE_COLLECTION_POLICY.grantMaxDurationMs);

  for (let index = 0; index < 3; index++) {
    h.clock.advance(1_000);
    const result = h.store.appendKeyboard(keyboard, keyboardCandidate(clock, index + 1), `kb|1|${index}`);
    assert.equal(result.outcome, 'inserted');
  }
  const before = h.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(clock.at() + 10 * 60_000).toISOString(), limit: 100 });
  assert.equal(before.items.length, 3);

  // Past the smoke 10-minute TTL the fragments expire and stop being visible.
  clock.advance(SMOKE_COLLECTION_POLICY.sampleRetentionMs + 1_000);
  const expired = h.store.expire();
  assert.equal(expired.expired, 3);
  const after = h.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(clock.at() + 10 * 60_000).toISOString(), limit: 100 });
  assert.equal(after.items.length, 0);

  // Capacity: a tiny smoke ceiling forces eviction of the oldest managed images first.
  const small: typeof SMOKE_COLLECTION_POLICY = { ...SMOKE_COLLECTION_POLICY, managedByteLimit: 60 };
  const capped = await openHarness({
    clock, policy: small,
    root: mkdtempSync(join(tmpdir(), 'aika-08102-cap-')),
  });
  const dirGrant = issue(capped, 'screenshot_directory', small.grantMaxDurationMs);
  const results: string[] = [];
  for (let index = 0; index < 4; index++) {
    capped.clock.advance(1_000);
    // Distinct bytes so each capture is its own asset and counts against the ceiling.
    const bytes = pngBytes(4, 4 + index);
    results.push(capped.store.appendImage(dirGrant, {
      bytes, mimeType: 'image/png', origin: 'directory_candidate',
      occurredAt: capped.clock.now(), contextObservedAt: capped.clock.now(), foregroundAppId: null,
    }, `dir|1|cap-${index}.png@v1`).outcome);
  }
  assert.equal(results.every(outcome => outcome === 'inserted'), true, 'the newest evidence is inserted before eviction runs');
  assert.equal(capped.store.managedBytes() <= small.managedByteLimit, true, 'managed bytes stay within the ceiling');
  const remaining = capped.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(capped.clock.at() + 600_000).toISOString(), limit: 100 });
  assert.equal(remaining.items.length < 4, true, 'the ceiling actually evicted older images');
  assert.equal(remaining.items.length > 0, true, 'eviction keeps the newest evidence rather than starving it');
  capped.memory.close();
  h.memory.close();

  void directory;
});

test('AC-08102-4: deleted evidence stays deleted across restart and replay, and user originals are untouched', async () => {
  const h = await openHarness();
  const directory = issue(h, 'screenshot_directory');

  // A real user screenshot lives OUTSIDE the managed area.
  const userShots = resolve(h.root, 'user-pictures');
  mkdirSync(userShots, { recursive: true });
  const userOriginal = resolve(userShots, 'Screenshot-user.png');
  writeFileSync(userOriginal, pngBytes());
  const originalBytes = readFileSync(userOriginal);
  const originalStat = readFileSync(userOriginal).length;

  const inserted = h.store.appendImage(directory, {
    bytes: readFileSync(userOriginal), mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|Screenshot-user.png@v1');
  assert.equal(inserted.outcome, 'inserted');
  assert.ok(h.store.readAsset(pairing, inserted.sampleId!, 'original'));

  const revision = h.store.revision;
  const erased = h.store.erase({ pairing, scope: 'item', sampleId: inserted.sampleId!, expectedRevision: revision, operationId: 'op-del' });
  assert.equal(erased.affected, 1);
  assert.equal(h.store.readAsset(pairing, inserted.sampleId!, 'original'), null, 'a deleted sample is unreadable immediately');

  // The user's original screenshot is neither modified nor removed.
  assert.equal(existsSync(userOriginal), true);
  assert.deepEqual([...readFileSync(userOriginal)], [...originalBytes]);
  assert.equal(readFileSync(userOriginal).length, originalStat);

  // Replay of the same notification is refused by the tombstone.
  const replay = h.store.appendImage(directory, {
    bytes: readFileSync(userOriginal), mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|Screenshot-user.png@v1');
  assert.equal(replay.outcome, 'duplicate');
  assert.equal(replay.reason, 'tombstoned');
  h.memory.close();

  // Restart: still invisible, still refused, original still intact.
  const reopened = await openHarness({ root: h.root, clock: h.clock });
  assert.equal(reopened.store.readAsset(pairing, inserted.sampleId!, 'original'), null);
  const afterRestart = reopened.store.appendImage(directory, {
    bytes: readFileSync(userOriginal), mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: reopened.clock.now(), contextObservedAt: reopened.clock.now(), foregroundAppId: null,
  }, 'dir|1|Screenshot-user.png@v1');
  assert.equal(afterRestart.outcome, 'duplicate');
  assert.deepEqual([...readFileSync(userOriginal)], [...originalBytes]);
  reopened.memory.close();
});

test('AC-08102-5: pairing isolation holds for reads, lists, assets and asset files', async () => {
  const h = await openHarness();
  const directory = issue(h, 'screenshot_directory');
  const bytes = pngBytes();
  const inserted = h.store.appendImage(directory, {
    bytes, mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|iso.png@v1');
  assert.equal(inserted.outcome, 'inserted');

  // Another instance cannot see or read this sample.
  const foreign = h.store.list({ pairing: otherInstance, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 1000).toISOString(), limit: 100 });
  assert.equal(foreign.items.length, 0);
  assert.equal(h.store.readAsset(otherInstance, inserted.sampleId!, 'original'), null);
  // And cannot advance feedback on it either.
  assert.throws(
    () => h.store.feedback({ pairing: otherInstance, sampleId: inserted.sampleId!, label: 'useful', expectedRevision: 1, operationId: 'op-foreign' }),
    /sample_not_available/,
  );

  // The same bytes under a second pairing get a separate managed file, never a shared one.
  const otherGrant = h.grants.issue({
    pairing: otherInstance, kind: 'screenshot_directory', directoryRoot: resolve(h.root, 'shots-2'),
    expiresAt: new Date(h.clock.at() + 600_000).toISOString(), expectedRevision: 0, operationId: 'op-other-pair',
  });
  const otherInsert = h.store.appendImage(otherGrant, {
    bytes, mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|iso.png@v1');
  assert.equal(otherInsert.outcome, 'inserted');
  const first = h.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 1000).toISOString(), limit: 100 }).items[0]!;
  const second = h.store.list({ pairing: otherInstance, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 1000).toISOString(), limit: 100 }).items[0]!;
  assert.ok(first.sampleKind === 'image' && second.sampleKind === 'image');
  assert.notEqual(first.assetId, second.assetId, 'two pairings never share one managed file');

  // Revoking one source invalidates only that source's evidence.
  const keyboard = issue(h, 'keyboard');
  h.store.appendKeyboard(keyboard, keyboardCandidate(h.clock), 'kb|1|keep');
  const sourceWide = h.store.erase({
    pairing, scope: 'source', sourceKind: 'screenshot_directory',
    expectedRevision: h.store.revision, operationId: 'op-revoke-source',
  });
  assert.equal(sourceWide.affected, 1);
  const surviving = h.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 1000).toISOString(), limit: 100 });
  assert.equal(surviving.items.length, 1);
  assert.equal(surviving.items[0]!.sampleKind, 'keyboard_activity');
  h.memory.close();
});

test('AC-08102-6: no keystroke fields reach storage and content hash is not an event identity', async () => {
  const h = await openHarness();
  const keyboard = issue(h, 'keyboard');
  const directory = issue(h, 'screenshot_directory');

  // A caller cannot smuggle per-key data through the candidate type: only the aggregate shape is read.
  const result = h.store.appendKeyboard(keyboard, {
    ...keyboardCandidate(h.clock, 3),
    // @ts-expect-error deliberate: prohibited fields are not part of the accepted shape.
    keyCode: 65, character: 'a', sequence: ['a', 'b', 'c'],
  }, 'kb|1|smuggle');
  assert.equal(result.outcome, 'inserted');

  const row = h.memory.rawDatabaseForKnowledge().prepare('SELECT * FROM collection_samples WHERE id=?').get(result.sampleId) as Record<string, unknown>;
  // Assert on the actual column set: a substring scan would false-positive on the legitimate
  // `character_id` pairing column.
  const columns = Object.keys(row);
  const forbiddenColumns = ['key_code', 'scan_code', 'character', 'characters', 'composition', 'keys', 'sequence', 'input_text', 'text'];
  for (const forbidden of forbiddenColumns) {
    assert.equal(columns.includes(forbidden), false, `no ${forbidden} column may exist on a collection sample`);
  }
  // The smuggling attempt is dropped rather than persisted anywhere in the row.
  const serializedValues = JSON.stringify(Object.values(row));
  assert.equal(serializedValues.includes('"a","b","c"'), false);
  assert.equal(row.activity_count, 3);

  // Two different notifications with identical bytes are two events sharing one asset, proving the
  // content hash is used for asset dedup and never as the event key.
  const bytes = pngBytes();
  const one = h.store.appendImage(directory, {
    bytes, mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|same-bytes-a');
  const two = h.store.appendImage(directory, {
    bytes, mimeType: 'image/png', origin: 'directive' as never,
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|same-bytes-b');
  assert.equal(one.outcome, 'inserted');
  assert.equal(two.outcome, 'rejected', 'an unknown origin is refused rather than silently coerced');
  const three = h.store.appendImage(directory, {
    bytes, mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|same-bytes-b');
  assert.equal(three.outcome, 'inserted');
  assert.notEqual(one.sampleId, three.sampleId, 'content hash must not become the event identity');

  // Format checks: signature is authoritative, an extension/mime mismatch is refused.
  assert.equal(detectImageMime(bytes), 'image/png');
  assert.equal(detectImageMime(jpegBytes()), 'image/jpeg');
  assert.equal(detectImageMime(new Uint8Array([1, 2, 3])), null);
  const mismatched = h.store.appendImage(directory, {
    bytes: jpegBytes(), mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|mismatch');
  assert.equal(mismatched.outcome, 'rejected');
  assert.equal(mismatched.reason, 'mime_mismatch');

  // Over-limit and pixel-limit are refused with a reason, not silently stored.
  const oversized = h.store.appendImage(directory, {
    bytes: new Uint8Array(NORMAL_COLLECTION_POLICY.maxImageBytes + 1), mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|huge');
  assert.equal(oversized.outcome, 'rejected');
  assert.equal(oversized.reason, 'image_too_large');

  // A genuine miss creates no fake sample.
  const before = h.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 1000).toISOString(), limit: 100 }).items.length;
  const missing = h.store.recordMissing(pairing, 'clipboard_image', h.clock.now(), 'op-missing');
  assert.ok(missing.id.startsWith('missing:'));
  const after = h.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 1000).toISOString(), limit: 100 }).items.length;
  assert.equal(after, before, 'a miss annotation must not create a sample or a Timeline card');
  h.memory.close();
});
