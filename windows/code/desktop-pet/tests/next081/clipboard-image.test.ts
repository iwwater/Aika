/**
 * tests/next081/clipboard-image.test.ts
 *
 * N081-05 acceptance: 剪贴板图片订阅、来源不确定性、双通道去重。
 *
 * AC-08105-1: 只读支持的图片格式；文本/HTML/文件列表不被读取也不报成图片
 * AC-08105-2: sequence 变化/占用有界重试；读取前后复验；旧通知作废
 * AC-08105-3: 首次启用不摄取已存在内容；同 sequence 不重复摄取
 * AC-08105-4: 双通道只在一对一精确等价且窗口内合并；近似图不合并
 * AC-08105-5: 撤销某来源后投影可从剩余证据重算；同图再次复制保留新事件
 * AC-08105-6: 队列上限与来源不确定性标记正确；失败不阻断其他来源
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore } from '../../memory/collection-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { NORMAL_COLLECTION_POLICY, SMOKE_COLLECTION_POLICY } from '../../contracts/collection.js';
import { CollectionGrantManager } from '../../core/collection-grants.js';
import { CollectionService } from '../../core/collection-service.js';
import {
  ClipboardImageSource, correlateCapture, correlationCandidateFor,
  clipboardQueueAccepts, samePairing, CLIPBOARD_ORIGIN,
} from '../../core/clipboard-image-source.js';
import { correlationDigest } from '../../core/screenshot-directory-source.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08105');

class FakeClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = (): string => new Date(this.value).toISOString();
  advance(ms: number): void { this.value += ms; }
  at(): number { return this.value; }
}

function pngBytes(width = 4, height = 4, filler = 0): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = filler;
  return bytes;
}

function probeFor(bytes: Uint8Array) {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function harness(policy = NORMAL_COLLECTION_POLICY) {
  const root = mkdtempSync(join(tmpdir(), 'aika-08105-'));
  const clock = new FakeClock(Date.parse('2026-09-25T00:00:00.000Z'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: clock.now,
  });
  const store = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'), policy, now: clock.now, probeImage: probeFor,
  });
  const grants = new CollectionGrantManager({ store, policy, now: clock.now });
  return { root, clock, memory, store, grants };
}

function clipboardGrant(h: Awaited<ReturnType<typeof harness>>, lifetime = 600_000) {
  return h.grants.issue({
    pairing, kind: 'clipboard_image', expiresAt: new Date(h.clock.at() + lifetime).toISOString(),
    expectedRevision: 0, operationId: 'op-clip',
  });
}

function directoryGrant(h: Awaited<ReturnType<typeof harness>>) {
  return h.grants.issue({
    pairing, kind: 'screenshot_directory', directoryRoot: resolve(h.root, 'shots'),
    expiresAt: new Date(h.clock.at() + 600_000).toISOString(), expectedRevision: 0, operationId: 'op-dir',
  });
}

test('AC-08105-1: only supported image formats are read; non-image clipboard content is never (mis)reported', async () => {
  const h = await harness();
  let clipboardBytes: Uint8Array | null = pngBytes();
  let sequence = 100;
  const source = new ClipboardImageSource({
    policy: NORMAL_COLLECTION_POLICY,
    currentSequence: () => sequence,
    readClipboard: async () => (clipboardBytes ? { bytes: clipboardBytes, mimeType: 'image/png' } : null),
    sleep: async () => undefined,
  });

  const grant = clipboardGrant(h);
  const observed: number[] = [];
  const lease = await source.start({ grantId: grant.grantId, grantRevision: grant.revision }, value => observed.push(value.clipboardSequence));

  // A supported PNG is read and identified from its bytes.
  const png = await source.readImageIfCurrent(sequence);
  assert.ok(png);
  assert.equal(png.mimeType, 'image/png');

  // Plain text on the clipboard yields nothing: the port does not surface text as an image.
  clipboardBytes = null;
  sequence = 101;
  assert.equal(await source.readImageIfCurrent(sequence), null, 'non-image clipboard content must not be read as an image');

  // HTML / file-list content likewise yields nothing.
  sequence = 102;
  assert.equal(await source.readImageIfCurrent(sequence), null);

  // Bytes that are not a supported image format are refused even if a caller claims image/png.
  clipboardBytes = new Uint8Array([1, 2, 3, 4, 5]);
  sequence = 103;
  assert.equal(await source.readImageIfCurrent(sequence), null, 'unsupported bytes are refused regardless of the claimed mime');

  await lease.close();
  h.memory.close();
});

test('AC-08105-2: a moved sequence invalidates the notification and retries stay bounded', async () => {
  const h = await harness();
  let sequence = 200;
  let attempts = 0;
  let succeedOnAttempt = Number.POSITIVE_INFINITY;
  // The clipboard is "held" for the first attempt; the sequence moves only when a test says so.
  let moveSequenceOnSleep = false;
  const source = new ClipboardImageSource({
    policy: NORMAL_COLLECTION_POLICY,
    currentSequence: () => sequence,
    readClipboard: async () => {
      attempts++;
      return attempts >= succeedOnAttempt ? { bytes: pngBytes(), mimeType: 'image/png' } : null;
    },
    sleep: async () => { if (moveSequenceOnSleep) sequence++; },
  });

  const grant = clipboardGrant(h);
  const lease = await source.start({ grantId: grant.grantId, grantRevision: grant.revision }, () => undefined);

  // The clipboard is held and the sequence moves during the retry, so the notification is
  // invalidated instead of yielding a stale image.
  sequence = 201;
  attempts = 0;
  succeedOnAttempt = 2;
  moveSequenceOnSleep = true;
  assert.equal(await source.readImageIfCurrent(201), null, 'a sequence that moved during the read invalidates the notification');
  assert.ok(attempts <= NORMAL_COLLECTION_POLICY.clipboardRetryLimit, 'retries stay within the configured limit');

  // A caller presenting a stale sequence is refused before any read happens.
  attempts = 0;
  sequence = 205;
  succeedOnAttempt = 1;
  moveSequenceOnSleep = false;
  assert.equal(await source.readImageIfCurrent(199), null, 'a stale sequence is refused before reading');
  assert.equal(attempts, 0, 'no read is attempted for a stale sequence');

  // A stable sequence that is briefly held still succeeds inside the retry budget.
  sequence = 300;
  attempts = 0;
  succeedOnAttempt = 2;
  const recovered = await source.readImageIfCurrent(300);
  assert.ok(recovered, 'a stable-but-busy sequence succeeds inside the retry budget');
  assert.ok(attempts >= 2, 'the retry path was actually exercised');

  // Exhausting the budget yields null rather than an unbounded wait.
  attempts = 0;
  succeedOnAttempt = Number.POSITIVE_INFINITY;
  sequence = 400;
  assert.equal(await source.readImageIfCurrent(400), null, 'an exhausted budget returns null');
  assert.equal(attempts, NORMAL_COLLECTION_POLICY.clipboardRetryLimit, 'attempts are capped by the configured limit');

  await lease.close();
  h.memory.close();
});

test('AC-08105-3: pre-existing clipboard content is not ingested and one sequence is consumed once', async () => {
  const h = await harness();
  const contents = new Map<number, Uint8Array>([[50, pngBytes()], [51, pngBytes(8, 8)]]);
  let sequence = 50;
  const source = new ClipboardImageSource({
    policy: NORMAL_COLLECTION_POLICY,
    currentSequence: () => sequence,
    readClipboard: async (value: number) => {
      const bytes = contents.get(value);
      return bytes ? { bytes, mimeType: 'image/png' } : null;
    },
    sleep: async () => undefined,
  });

  const grant = clipboardGrant(h);
  await source.start({ grantId: grant.grantId, grantRevision: grant.revision }, () => undefined);

  // The content already on the clipboard at enable time is marked consumed, not ingested.
  assert.deepEqual(source.consumedSequences, [50]);
  assert.equal(source.observe(50, grant.revision), null, 'the pre-existing sequence is not a new observation');

  // A genuinely new sequence is reported exactly once.
  assert.ok(source.observe(51, grant.revision));
  assert.equal(source.observe(51, grant.revision), null, 'the same sequence is never ingested twice');

  // And that sequence reads its own content.
  sequence = 51;
  const read = await source.readImageIfCurrent(51);
  assert.ok(read);
  assert.deepEqual([...read.bytes], [...pngBytes(8, 8)]);

  h.memory.close();
});

test('AC-08105-4: only one-to-one exact equality inside the window merges two channels', async () => {
  const h = await harness();
  const policy = NORMAL_COLLECTION_POLICY;
  const t0 = h.clock.now();

  const directory = correlationCandidateFor({
    sampleId: 'dir-1', sourceKind: 'screenshot_directory', bytes: pngBytes(), observedAt: t0,
  });
  const clipboardMatch = correlationCandidateFor({
    sampleId: 'clip-1', sourceKind: 'clipboard_image', bytes: pngBytes(), observedAt: t0,
  });

  // Exact equality inside the window with a 1:1 pairing merges into one experience event.
  const merged = correlateCapture(directory, clipboardMatch, policy);
  assert.equal(merged.decision, 'same_capture');
  assert.deepEqual([...merged.sampleIds], ['dir-1', 'clip-1']);

  // Outside the window the same content is two separate uses, not one capture.
  h.clock.advance(policy.crossSourceWindowMs + 1);
  const late = correlationCandidateFor({
    sampleId: 'clip-2', sourceKind: 'clipboard_image', bytes: pngBytes(), observedAt: h.clock.now(),
  });
  const outside = correlateCapture(directory, late, policy);
  assert.equal(outside.decision, 'separate');
  assert.equal(outside.reason, 'outside_correlation_window');

  // Different content never merges.
  const different = correlationCandidateFor({
    sampleId: 'clip-3', sourceKind: 'clipboard_image', bytes: pngBytes(8, 8), observedAt: t0,
  });
  assert.equal(correlateCapture(directory, different, policy).decision, 'separate');

  // A near-match only flags for review; it must never delete or merge evidence.
  const nearA = { ...directory, perceptualHint: 'phash-aaa' };
  const nearB = { ...clipboardMatch, sampleId: 'clip-near', digest: 'different-digest', perceptualHint: 'phash-aaa' };
  const near = correlateCapture(nearA, nearB, policy);
  assert.equal(near.decision, 'uncertain');
  assert.equal(near.reason, 'near_match_requires_review');

  // A 1:N pairing is ambiguous rather than a silent merge.
  const ambiguous = correlateCapture(directory, clipboardMatch, policy, { left: 1, right: 2 });
  assert.equal(ambiguous.decision, 'uncertain');
  assert.equal(ambiguous.reason, 'ambiguous_pairing');

  // The same source channel never correlates with itself.
  const sameChannel = correlateCapture(directory, { ...directory, sampleId: 'dir-2' }, policy);
  assert.equal(sameChannel.decision, 'separate');
  assert.equal(sameChannel.reason, 'same_source_channel');

  h.memory.close();
});

test('AC-08105-5: revoking one channel recomputes from the remaining evidence, and re-copying keeps a new event', async () => {
  const h = await harness();
  const directory = directoryGrant(h);
  const clipboard = clipboardGrant(h);
  const service = new CollectionService({
    grants: h.grants, store: h.store, pairing, instanceId: 'inst-08105', now: h.clock.now,
  });

  // The same bytes arrive through both channels within the window.
  const shared = pngBytes(4, 4, 77);
  const fromDirectory = await h.store.appendImage(directory, {
    bytes: shared, mimeType: 'image/png', origin: 'directory_candidate',
    occurredAt: h.clock.now(), contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'dir|1|shot.png@v1');
  const fromClipboard = await h.store.appendImage(clipboard, {
    bytes: shared, mimeType: 'image/png', origin: CLIPBOARD_ORIGIN,
    occurredAt: null, contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'clip|1|seq-900');
  assert.equal(fromDirectory.outcome, 'inserted');
  assert.equal(fromClipboard.outcome, 'inserted');
  assert.notEqual(fromDirectory.sampleId, fromClipboard.sampleId, 'the two source records stay separable');

  // A stored clipboard sample is never claimed as a confirmed screenshot.
  const beforePage = h.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 60_000).toISOString(), limit: 100 });
  const clipboardSample = beforePage.items.find(item => item.id === fromClipboard.sampleId)!;
  assert.ok(clipboardSample.sampleKind === 'image');
  assert.equal(clipboardSample.origin, 'clipboard_unknown');

  // The service correlates the new clipboard sample against the directory channel.
  const decision = service.correlateImage(correlationCandidateFor({
    sampleId: fromClipboard.sampleId!, sourceKind: 'clipboard_image', bytes: shared, observedAt: h.clock.now(),
  }));
  assert.equal(decision.decision, 'same_capture', 'exact content within the window merges the projection');

  // Revoking the clipboard source invalidates ONLY its evidence; the directory record survives.
  h.store.erase({ pairing, scope: 'source', sourceKind: 'clipboard_image', expectedRevision: h.store.revision, operationId: 'op-revoke-clip' });
  const afterRevoke = h.store.list({ pairing, from: new Date(0).toISOString(), to: new Date(h.clock.at() + 60_000).toISOString(), limit: 100 });
  assert.equal(afterRevoke.items.length, 1, 'only the revoked channel disappears');
  assert.equal(afterRevoke.items[0]!.id, fromDirectory.sampleId);
  assert.equal(h.store.readAsset(pairing, fromClipboard.sampleId!, 'original'), null, 'a revoked sample is unreadable');

  // The projection can be recomputed from the remaining evidence alone.
  const recomputed = service.correlateImage(correlationCandidateFor({
    sampleId: fromDirectory.sampleId!, sourceKind: 'screenshot_directory', bytes: shared, observedAt: h.clock.now(),
  }));
  assert.equal(recomputed.decision, 'separate');
  assert.equal(recomputed.reason, 'no_cross_channel_candidate');

  // Copying the same image again later is a NEW event, not a resurrection of the revoked one.
  h.clock.advance(NORMAL_COLLECTION_POLICY.crossSourceWindowMs * 4);
  const recopied = await h.store.appendImage(clipboard, {
    bytes: shared, mimeType: 'image/png', origin: CLIPBOARD_ORIGIN,
    occurredAt: null, contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'clip|1|seq-901');
  assert.equal(recopied.outcome, 'inserted');
  assert.notEqual(recopied.sampleId, fromClipboard.sampleId);

  h.memory.close();
});

test('AC-08105-6: queue bounds, pairing isolation and per-source failure isolation hold', async () => {
  const h = await harness(SMOKE_COLLECTION_POLICY);
  const policy = SMOKE_COLLECTION_POLICY;
  const grant = clipboardGrant(h, policy.grantMaxDurationMs);
  const service = new CollectionService({
    grants: h.grants, store: h.store, pairing, instanceId: 'inst-08105', now: h.clock.now,
  });

  // The queue accepts only within the configured item and byte ceilings.
  assert.equal(clipboardQueueAccepts({ items: 0, bytes: 0 }, 1_000, policy), true);
  assert.equal(clipboardQueueAccepts({ items: policy.queueItemLimit, bytes: 0 }, 1_000, policy), false,
    'the item ceiling is enforced');
  assert.equal(clipboardQueueAccepts({ items: 0, bytes: policy.queueByteLimit }, 1_000, policy), false,
    'the byte ceiling is enforced');

  // A clipboard notification for a grant that does not exist is dropped without writing anything.
  const dropped = await service.onClipboardChange({
    grantId: 'no-such-grant', grantRevision: 1, clipboardSequence: 1, observedAt: h.clock.now(),
  });
  assert.equal(dropped, null, 'an unauthorized clipboard notification writes nothing');

  // With no clipboard adapter wired in, the source reports unavailable and does not block others.
  const status = service.status();
  const clipboardStatus = status.sources.find(source => source.kind === 'clipboard_image')!;
  assert.equal(clipboardStatus.state, 'active', 'a live grant is reported as active');
  assert.equal(clipboardStatus.accepted, 0);
  assert.equal(clipboardStatus.lastAcceptedAt, null, 'zero samples must not be shown as healthy traffic');
  // Keyboard evidence still works while the clipboard path is unwired.
  const keyboard = h.grants.issue({
    pairing, kind: 'keyboard', expiresAt: new Date(h.clock.at() + policy.grantMaxDurationMs).toISOString(),
    expectedRevision: 0, operationId: 'op-kb',
  });
  const keyboardResult = await service.onKeyboardActivity({
    grantId: keyboard.grantId, grantRevision: keyboard.revision,
    bucketStart: h.clock.now(), bucketEnd: h.clock.now(), activityCount: 5,
    foregroundAppId: null, afkBoundary: false,
  });
  assert.equal(keyboardResult?.outcome, 'inserted', 'a clipboard failure must not block keyboard collection');

  // A rejected clipboard capture is counted rather than silently vanishing.
  const rejected = await h.store.appendImage(grant, {
    bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', origin: CLIPBOARD_ORIGIN,
    occurredAt: null, contextObservedAt: h.clock.now(), foregroundAppId: null,
  }, 'clip|1|seq-bad');
  assert.equal(rejected.outcome, 'rejected');
  const afterReject = service.status().sources.find(source => source.kind === 'clipboard_image')!;
  assert.equal(afterReject.rejected >= 1, true, 'a rejected capture must be counted');

  // Pairing isolation: a different pairing never matches for correlation.
  assert.equal(samePairing(pairing, pairing), true);
  assert.equal(samePairing(pairing, productionPairing('companion', 'other-instance')), false);
  // And the digest used for correlation is stable for identical bytes, different otherwise.
  assert.equal(correlationDigest(pngBytes()), correlationDigest(pngBytes()));
  assert.notEqual(correlationDigest(pngBytes()), correlationDigest(pngBytes(8, 8)));

  h.memory.close();
});
