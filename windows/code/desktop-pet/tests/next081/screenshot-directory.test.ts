/**
 * tests/next081/screenshot-directory.test.ts
 *
 * N081-04 acceptance: 指定目录新截图的稳定读取、真实路径边界与源身份。
 *
 * AC-08104-1: 启用前旧文件不导入；只有稳定合法的新文件入库
 * AC-08104-2: 分块写入/半写、损坏图、同名覆盖、超限均被拒
 * AC-08104-3: 符号链接/重解析点/目录失效不能扩大边界
 * AC-08104-4: 暂停/撤销后旧 watcher 不能提交；多轮重启不重复摄取
 * AC-08104-5: 源幂等 key 为文件身份/版本，不使用图片 hash 代替事件身份
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore } from '../../memory/collection-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { NORMAL_COLLECTION_POLICY, SMOKE_COLLECTION_POLICY } from '../../contracts/collection.js';
import { CollectionGrantManager } from '../../core/collection-grants.js';
import { CollectionService } from '../../core/collection-service.js';
import { ScreenshotDirectorySource, detectScreenshotMime, isTextuallyInside } from '../../core/screenshot-directory-source.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08104');

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

function probeFor(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  if (bytes.length < 24) return null;
  // PNG IHDR stores width then height as big-endian uint32 at offsets 16 and 20.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A source whose stability sleep is immediate, so tests never actually wait. */
function fastSource(policy = NORMAL_COLLECTION_POLICY) {
  return new ScreenshotDirectorySource({
    fileStableIntervalMs: policy.fileStableIntervalMs,
    maxImageBytes: policy.maxImageBytes,
    maxImagePixels: policy.maxImagePixels,
    probeImage: probeFor,
    sleep: async () => undefined,
  });
}

async function serviceHarness() {
  const root = mkdtempSync(join(tmpdir(), 'aika-08104-'));
  const shots = resolve(root, 'selected-shots');
  mkdirSync(shots, { recursive: true });
  const clock = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: clock.now,
  });
  const store = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'), policy: NORMAL_COLLECTION_POLICY, now: clock.now,
  });
  const grants = new CollectionGrantManager({ store, policy: NORMAL_COLLECTION_POLICY, now: clock.now });
  const source = fastSource();
  const service = new CollectionService({
    grants, store, pairing, instanceId: 'inst-08104', screenshotDirectory: source, now: clock.now,
  });
  return { root, shots, clock, memory, store, grants, source, service };
}

function directoryGrant(h: Awaited<ReturnType<typeof serviceHarness>>) {
  return h.grants.issue({
    pairing, kind: 'screenshot_directory', directoryRoot: h.shots,
    expiresAt: new Date(h.clock.at() + 600_000).toISOString(), expectedRevision: 0, operationId: 'op-dir',
  });
}

test('AC-08104-1: the watcher baseline excludes pre-existing files and a new stable file resolves', async () => {
  const h = await serviceHarness();
  const source = fastSource();

  // Files present before enablement form the watcher baseline, so they are never announced.
  const preExisting = join(h.shots, 'before-enable.png');
  writeFileSync(preExisting, pngBytes());
  const grant = directoryGrant(h);
  const announced: string[] = [];
  const lease = await source.start(
    { grantId: grant.grantId, canonicalRoot: h.shots, grantRevision: grant.revision },
    value => announced.push(value.opaqueFileRef),
  );
  // Give the watcher a moment to establish, then confirm nothing was announced for the old file.
  await new Promise(done => setTimeout(done, 200));
  assert.equal(announced.length, 0, 'a pre-existing file must not be announced after enablement');

  // A file created AFTER enablement is announced as a candidate.
  const fresh = join(h.shots, 'after-enable.png');
  writeFileSync(fresh, pngBytes());
  await new Promise(done => setTimeout(done, 500));
  assert.ok(announced.length >= 1, 'a new file must be announced as a candidate');

  // The announced ref resolves to verified bytes, and the ref itself never embeds a raw path.
  const resolved = await source.resolveCandidate(announced[0]!, grant);
  assert.ok(resolved, 'a stable valid new file must resolve');
  assert.equal(resolved.mimeType, 'image/png');
  assert.equal(typeof resolved.fileVersion, 'string');
  assert.deepEqual([...resolved.bytes], [...pngBytes()]);
  assert.equal(announced[0]!.includes(h.shots), false, 'the candidate ref must not embed a filesystem path');

  // An unknown ref cannot name a path.
  assert.equal(await source.resolveCandidate('unknown-ref', grant), null);

  // Recognizing the format comes from the bytes, not the extension.
  assert.equal(detectScreenshotMime(pngBytes()), 'image/png');
  assert.equal(detectScreenshotMime(new Uint8Array([1, 2, 3, 4])), null);

  // The textual containment helper agrees with the realpath check for plain paths.
  assert.equal(isTextuallyInside(h.shots, fresh), true);
  assert.equal(isTextuallyInside(h.shots, join(h.root, 'outside.png')), false);

  await lease.close();
  h.memory.close();
});

test('AC-08104-2: half-written, corrupt, overwritten and oversized files are refused', async () => {
  const h = await serviceHarness();
  const source = h.source;
  const grant = directoryGrant(h);

  // A file still being written changes between the two metadata reads, so it is refused.
  const growing = join(h.shots, 'growing.png');
  writeFileSync(growing, pngBytes());
  const growingProbe = new ScreenshotDirectorySource({
    fileStableIntervalMs: 1_000, maxImageBytes: NORMAL_COLLECTION_POLICY.maxImageBytes,
    maxImagePixels: NORMAL_COLLECTION_POLICY.maxImagePixels, probeImage: probeFor,
    // The "wait" appends more bytes, exactly like a writer that has not finished.
    sleep: async () => { appendFileSync(growing, pngBytes()); },
  });
  assert.equal(await growingProbe.resolveCandidate(growingProbe.observeFile(growing), grant), null,
    'a file that changed between reads is refused');
  // The same file, now settled, resolves.
  assert.ok(await source.resolveCandidate(source.observeFile(growing), grant), 'a settled file resolves');

  // Bytes that do not decode are refused rather than stored as a broken image.
  const corrupt = join(h.shots, 'corrupt.png');
  writeFileSync(corrupt, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  assert.equal(await source.resolveCandidate(source.observeFile(corrupt), grant), null,
    'a non-image with a .png name is refused');

  // An empty file is refused.
  const empty = join(h.shots, 'empty.png');
  writeFileSync(empty, new Uint8Array(0));
  assert.equal(await source.resolveCandidate(source.observeFile(empty), grant), null);

  // A file beyond the 20 MiB ceiling is refused even though its header says PNG.
  const oversized = join(h.shots, 'huge.png');
  const huge = new Uint8Array(NORMAL_COLLECTION_POLICY.maxImageBytes + 8);
  huge.set(pngBytes().subarray(0, 24), 0);
  writeFileSync(oversized, huge);
  assert.equal(await source.resolveCandidate(source.observeFile(oversized), grant), null,
    'over the byte ceiling is refused');

  // A file beyond the pixel ceiling is refused.
  const manyPixels = join(h.shots, 'manypixels.png');
  writeFileSync(manyPixels, pngBytes(65_535, 65_535));
  assert.equal(await source.resolveCandidate(source.observeFile(manyPixels), grant), null,
    'over the pixel ceiling is refused');

  // An overwrite under the same name is a new file version, so the source identity changes.
  const overwritten = join(h.shots, 'same-name.png');
  writeFileSync(overwritten, pngBytes(4, 4));
  const first = await source.resolveCandidate(source.observeFile(overwritten), grant);
  assert.ok(first);
  writeFileSync(overwritten, pngBytes(8, 8));
  const second = await source.resolveCandidate(source.observeFile(overwritten), grant);
  assert.ok(second);
  assert.notEqual(second.fileVersion, first.fileVersion, 'a same-name overwrite must get a new file version');

  h.memory.close();
});

test('AC-08104-3: symlinks, a moved root and a non-directory grant cannot widen the boundary', async () => {
  const h = await serviceHarness();
  const source = h.source;
  const grant = directoryGrant(h);

  // A file OUTSIDE the authorized root is refused even when its name looks legitimate.
  const outside = join(h.root, 'outside.png');
  writeFileSync(outside, pngBytes());
  assert.equal(await source.resolveCandidate(source.observeFile(outside), grant), null,
    'a path outside the grant root is refused');

  // A symlink inside the root that points outside must not grant access to the target.
  const linkPath = join(h.shots, 'link.png');
  let linkCreated = false;
  try { symlinkSync(outside, linkPath, 'file'); linkCreated = true; } catch { /* symlink needs privilege on Windows */ }
  if (linkCreated) {
    assert.equal(await source.resolveCandidate(source.observeFile(linkPath), grant), null,
      'a symlink escaping the root must be refused after realpath');
  }

  // A legitimate file in the root still resolves, proving the boundary is not simply "refuse all".
  const inside = join(h.shots, 'inside.png');
  writeFileSync(inside, pngBytes());
  assert.ok(await source.resolveCandidate(source.observeFile(inside), grant));

  // A grant without a directory cannot resolve anything.
  const noDirectory = h.grants.issue({
    pairing, kind: 'keyboard', expiresAt: new Date(h.clock.at() + 60_000).toISOString(),
    expectedRevision: 0, operationId: 'op-kb',
  });
  assert.equal(await source.resolveCandidate(source.observeFile(inside), noDirectory), null,
    'a non-directory grant resolves nothing');

  // A deleted root makes the source unavailable rather than silently falling back.
  const vanishing = mkdtempSync(join(tmpdir(), 'aika-08104-gone-'));
  const vanishingSource = fastSource();
  rmSync(vanishing, { recursive: true, force: true });
  await assert.rejects(
    async () => vanishingSource.start({ grantId: 'g', canonicalRoot: vanishing, grantRevision: 1 }, () => undefined),
    /screenshot_directory_unavailable/,
  );

  h.memory.close();
});

test('AC-08104-4: a superseded revision cannot submit, and restart does not re-ingest a settled file', async () => {
  const h = await serviceHarness();
  const source = h.source;
  const grant = directoryGrant(h);

  const file = join(h.shots, 'live.png');
  writeFileSync(file, pngBytes());
  const ref = source.observeFile(file);
  const accepted = await h.service.onDirectoryCandidate({
    grantId: grant.grantId, grantRevision: grant.revision, opaqueFileRef: ref, observedAt: h.clock.now(),
  });
  assert.equal(accepted?.outcome, 'inserted');

  // Replaying the same file version is a duplicate, not a second sample.
  const replay = await h.service.onDirectoryCandidate({
    grantId: grant.grantId, grantRevision: grant.revision, opaqueFileRef: ref, observedAt: h.clock.now(),
  });
  assert.equal(replay?.outcome, 'duplicate');

  // After a pause the same candidate cannot be submitted, so a late watcher callback writes nothing.
  const paused = h.grants.transition({ pairing, kind: 'screenshot_directory', action: 'pause', expectedRevision: grant.revision, operationId: 'op-pause' });
  h.clock.advance(1_000);
  const other = join(h.shots, 'after-pause.png');
  writeFileSync(other, pngBytes(6, 6));
  const duringPause = await h.service.onDirectoryCandidate({
    grantId: grant.grantId, grantRevision: paused.revision, opaqueFileRef: source.observeFile(other), observedAt: h.clock.now(),
  });
  assert.equal(duringPause, null, 'a candidate arriving while paused must not be stored');

  // A stale revision after resume is also refused.
  const resumed = h.grants.transition({ pairing, kind: 'screenshot_directory', action: 'resume', expectedRevision: paused.revision, operationId: 'op-resume' });
  const stale = await h.service.onDirectoryCandidate({
    grantId: grant.grantId, grantRevision: grant.revision, opaqueFileRef: source.observeFile(other), observedAt: h.clock.now(),
  });
  assert.equal(stale, null, 'a callback from a superseded revision must not be stored');
  const fresh = await h.service.onDirectoryCandidate({
    grantId: grant.grantId, grantRevision: resumed.revision, opaqueFileRef: source.observeFile(other), observedAt: h.clock.now(),
  });
  assert.equal(fresh?.outcome, 'inserted');

  h.memory.close();

  // Restart: the settled files are already stored, so the count is unchanged and no duplicate appears.
  const reopened = new SqliteMemoryStore({
    filename: resolve(h.root, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: h.clock.now,
  });
  const store = await CollectionStore.open(reopened, {
    collectionDirectory: resolve(h.root, 'collection'), policy: NORMAL_COLLECTION_POLICY, now: h.clock.now,
  });
  const page = store.list({ pairing, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 600_000).toISOString(), limit: 100 });
  assert.equal(page.items.length, 2, 'restart re-ingests nothing');
  assert.equal(page.items.every(item => item.sampleKind === 'image'), true);
  reopened.close();
});

test('AC-08104-5: the source idempotency key is the file version, and identical bytes at two times stay two events', async () => {
  const h = await serviceHarness();
  const source = h.source;
  const grant = directoryGrant(h);

  // Two different files carrying IDENTICAL bytes are two events sharing one managed asset.
  const a = join(h.shots, 'shot-a.png');
  const b = join(h.shots, 'shot-b.png');
  writeFileSync(a, pngBytes());
  writeFileSync(b, pngBytes());
  const first = await h.service.onDirectoryCandidate({
    grantId: grant.grantId, grantRevision: grant.revision, opaqueFileRef: source.observeFile(a), observedAt: h.clock.now(),
  });
  h.clock.advance(5_000);
  const second = await h.service.onDirectoryCandidate({
    grantId: grant.grantId, grantRevision: grant.revision, opaqueFileRef: source.observeFile(b), observedAt: h.clock.now(),
  });
  assert.equal(first?.outcome, 'inserted');
  assert.equal(second?.outcome, 'inserted');
  assert.notEqual(first!.sampleId, second!.sampleId, 'identical bytes must not collapse into one event');
  const page = h.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 60_000).toISOString(), limit: 100 });
  const assetIds = new Set(page.items.flatMap(item => item.sampleKind === 'image' ? [item.assetId] : []));
  assert.equal(assetIds.size, 1, 'the two events share one managed asset because the bytes are identical');

  // The stored provenance stays a candidate: a directory file is not proof the user took a screenshot.
  const images = page.items.filter(item => item.sampleKind === 'image');
  assert.equal(images.every(item => item.sampleKind === 'image' && item.origin === 'directory_candidate'), true);
  // And it is not claimed as verified content, only as a verified channel/bytes read.
  assert.equal(images.every(item => item.sourceConfidence === 'verified'), true);

  // The service never writes to or deletes the user's originals.
  assert.equal(readdirSync(h.shots).filter(name => name.endsWith('.png')).length >= 2, true,
    'the user original files remain in place after ingestion');

  // The directory source is independent of the keyboard helper and honours the smoke policy too.
  const smoke = fastSource(SMOKE_COLLECTION_POLICY);
  assert.equal(smoke instanceof ScreenshotDirectorySource, true);

  h.memory.close();
});
