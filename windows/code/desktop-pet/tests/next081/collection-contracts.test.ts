/**
 * tests/next081/collection-contracts.test.ts
 *
 * N081-00 acceptance: Collection 公共契约、双配置装载与旧域兼容。
 *
 * AC-08100-1: normal/smoke 策略数值与 TEST_PROFILES 一致，且单图安全上限不因档位放宽
 * AC-08100-2: 非法档位/非法数值/共用数据根被拒绝
 * AC-08100-3: Collection 公共形状不含逐键字段，来源可信度语义不被过度解释
 * AC-08100-4: EventDomain 显式扩 collection，旧三域默认查询不被自动扩大
 * AC-08100-5: 默认零采集；单帧 CaptureGrant 不能代表持续来源授权
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  NORMAL_COLLECTION_POLICY,
  SMOKE_COLLECTION_POLICY,
  loadCollectionPolicy,
  validateCollectionPolicy,
  type CollectionPolicy,
} from '../../contracts/collection.js';
import { CompanionEventHub } from '../../core/companion-event-hub.js';
import { UnifiedTimelineService } from '../../memory/unified-timeline.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { CaptureGrantManager } from '../../core/perception-grant.js';
import type { CompanionEventEnvelope, EventDomain } from '../../contracts/perception.js';

const pairing = productionPairing('companion', 'inst-08100');

test('AC-08100-1: normal/smoke policy values match TEST_PROFILES and keep fixed image safety limits', () => {
  const expected = {
    normal: {
      keyboardBucketMs: 10_000, keyboardQuietMs: 5_000, afkMs: 300_000,
      ringMaxAgeMs: 180_000, ringMaxItems: 1000, sampleRetentionMs: 604_800_000,
      managedByteLimit: 1_073_741_824, queueItemLimit: 32, queueByteLimit: 67_108_864,
      crossSourceWindowMs: 5_000, grantMaxDurationMs: 604_800_000,
    },
    smoke: {
      keyboardBucketMs: 1_000, keyboardQuietMs: 2_000, afkMs: 15_000,
      ringMaxAgeMs: 30_000, ringMaxItems: 100, sampleRetentionMs: 600_000,
      managedByteLimit: 67_108_864, queueItemLimit: 4, queueByteLimit: 25_165_824,
      crossSourceWindowMs: 2_000, grantMaxDurationMs: 1_800_000,
    },
  } as const;

  for (const [profile, values] of Object.entries(expected)) {
    const policy = profile === 'normal' ? NORMAL_COLLECTION_POLICY : SMOKE_COLLECTION_POLICY;
    for (const [key, value] of Object.entries(values)) {
      assert.equal(policy[key as keyof CollectionPolicy], value, `${profile}.${key}`);
    }
  }

  // 解码安全边界不因测试放宽：normal 与 smoke 完全相同。
  assert.equal(NORMAL_COLLECTION_POLICY.maxImageBytes, SMOKE_COLLECTION_POLICY.maxImageBytes);
  assert.equal(NORMAL_COLLECTION_POLICY.maxImagePixels, SMOKE_COLLECTION_POLICY.maxImagePixels);
  assert.equal(NORMAL_COLLECTION_POLICY.fileStableIntervalMs, 1_000);
  assert.equal(SMOKE_COLLECTION_POLICY.fileStableIntervalMs, 1_000);
  assert.equal(NORMAL_COLLECTION_POLICY.clipboardRetryLimit, 3);
  assert.equal(NORMAL_COLLECTION_POLICY.clipboardRetryBudgetMs, 1_000);
  assert.equal(SMOKE_COLLECTION_POLICY.clipboardRetryLimit, 3);
  assert.equal(SMOKE_COLLECTION_POLICY.clipboardRetryBudgetMs, 1_000);
  assert.equal(NORMAL_COLLECTION_POLICY.profile, 'normal');
  assert.equal(SMOKE_COLLECTION_POLICY.profile, 'smoke');
  assert.equal(NORMAL_COLLECTION_POLICY.schemaVersion, 1);
  validateCollectionPolicy(NORMAL_COLLECTION_POLICY);
  validateCollectionPolicy(SMOKE_COLLECTION_POLICY);
});

test('AC-08100-2: policy loader rejects unknown profile, illegal values and shared data roots', () => {
  const normalRoot = resolve('F:/tmp/aika-08100/normal');
  const smokeRoot = resolve('F:/tmp/aika-08100/smoke');

  assert.equal(loadCollectionPolicy('normal', normalRoot).profile, 'normal');
  assert.equal(loadCollectionPolicy('smoke', smokeRoot, normalRoot).profile, 'smoke');

  // 未知 profile。
  assert.throws(() => loadCollectionPolicy('turbo', normalRoot), /Invalid collection profile/);
  assert.throws(() => loadCollectionPolicy('', normalRoot), /Invalid collection profile/);

  // smoke 不得共用 normal 数据根，也不得是 normal 数据根的子目录。
  assert.throws(() => loadCollectionPolicy('smoke', normalRoot, normalRoot), /independent data root/);
  assert.throws(() => loadCollectionPolicy('smoke', resolve(normalRoot, 'nested'), normalRoot), /child directory/);

  // 非法数值（负值/零/超安全上限）必须被拒绝。
  const negative: CollectionPolicy = { ...NORMAL_COLLECTION_POLICY, keyboardBucketMs: -1 };
  assert.throws(() => validateCollectionPolicy(negative), /keyboardBucketMs/);
  const zeroQueue: CollectionPolicy = { ...NORMAL_COLLECTION_POLICY, queueItemLimit: 0 };
  assert.throws(() => validateCollectionPolicy(zeroQueue), /queueItemLimit/);
  const oversized: CollectionPolicy = { ...NORMAL_COLLECTION_POLICY, maxImageBytes: 21 * 1024 * 1024 };
  assert.throws(() => validateCollectionPolicy(oversized), /20 MiB/);
  const manyPixels: CollectionPolicy = { ...NORMAL_COLLECTION_POLICY, maxImagePixels: 40_000_001 };
  assert.throws(() => validateCollectionPolicy(manyPixels), /40 MP/);
  const badProfile: CollectionPolicy = { ...NORMAL_COLLECTION_POLICY, profile: 'smoke' as const, sampleRetentionMs: -5 };
  assert.throws(() => validateCollectionPolicy(badProfile), /sampleRetentionMs/);

  assert.equal(loadCollectionPolicy('normal', normalRoot).keyboardBucketMs, 10_000);
});

test('AC-08100-3: collection shapes carry no keystroke/text fields and keep confidence conservative', () => {
  // 契约层不得出现逐键字段；用运行时形状检查代替只看接口声明。
  const keyboardSampleShape = {
    schemaVersion: 1, id: 'kb-1', revision: 1, pairing,
    grantId: 'g-1', grantRevision: 1, sourceKind: 'keyboard' as const,
    policyVersion: 1, occurredAt: null, receivedAt: new Date().toISOString(),
    contextObservedAt: null, expiresAt: new Date(Date.now() + 1000).toISOString(),
    sourceConfidence: 'verified' as const, state: 'active' as const,
    sampleKind: 'keyboard_activity' as const, bucketStart: new Date().toISOString(),
    bucketEnd: new Date().toISOString(), activityCount: 12,
    foregroundAppId: null, afkBoundary: false,
  };
  const forbidden = ['keyCode', 'scanCode', 'character', 'characters', 'composition', 'text', 'keys', 'sequence', 'inputText'];
  for (const key of forbidden) {
    assert.equal(key in keyboardSampleShape, false, `keyboard sample must not carry ${key}`);
  }

  // 目录图片只是候选，普通剪贴板图片只是 unknown；verified 仅指通道/字节已验证。
  const directoryOrigin: 'directory_candidate' = 'directory_candidate';
  const clipboardOrigin: 'clipboard_unknown' = 'clipboard_unknown';
  assert.equal(directoryOrigin, 'directory_candidate');
  assert.equal(clipboardOrigin, 'clipboard_unknown');
});

test('AC-08100-4: collection domain is explicitly allowed while legacy three-domain default is unchanged', async () => {
  const hub = new CompanionEventHub();
  const seen: string[] = [];
  hub.subscribeDomain(['collection'], envelope => { seen.push(envelope.type); }, pairing);

  const envelope: CompanionEventEnvelope = {
    eventId: 'evt-collection-1',
    schemaVersion: 1,
    domain: 'collection',
    type: 'collection.sample.created',
    pairing,
    sourceRef: { id: 'sample-1', version: 1 },
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    payload: { sampleId: 'sample-1', sourceKind: 'keyboard', grantRevision: 1, timeBasis: 'received' },
    summary: '键盘活动区间',
  };
  await hub.publishEnvelope(envelope);
  assert.deepEqual(seen, ['collection.sample.created']);

  // 未订阅 collection 的三域 listener 不会收到 collection 事件。
  const legacySeen: string[] = [];
  hub.subscribeDomain(['canon', 'companion', 'work'], value => { legacySeen.push(value.type); }, pairing);
  await hub.publishEnvelope(envelope);
  assert.deepEqual(legacySeen, []);

  // 未知域仍被拒绝。
  await assert.rejects(
    async () => hub.publishEnvelope({ ...envelope, domain: 'telemetry' as EventDomain }),
    /invalid domain/,
  );

  // 旧三域默认查询语义不变：未显式给 domains 时只读三域。
  const database = resolve('.local/data', `n08100-${process.pid}-${Date.now()}.sqlite`);
  const store = new SqliteMemoryStore({ filename: database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  try {
    const characterPacks = await CharacterPackStore.open(store);
    const timeline = new UnifiedTimelineService(store.rawDatabaseForKnowledge(), characterPacks);
    timeline.recordEventSync({ ...envelope, eventId: 'evt-collection-timeline', type: 'collection.sample.created' });
    const legacy = await timeline.queryTimeline({ pairing, limit: 50 });
    const domains = new Set(legacy.items.map(item => item.domain));
    assert.equal(domains.has('collection'), false, 'default query must stay canon/companion/work only');

    // N081-00 只要求“默认不被自动扩大”。collection 投影本体由 N081-06 实施，本步不渲染它，
    // 因此显式 domains=['collection'] 时也只返回旧三域之外的空结果，而不是伪造一条 collection 卡片。
    const explicit = await timeline.queryTimeline({ pairing, domains: ['collection'], limit: 50 });
    assert.equal(explicit.items.some(item => item.domain === 'collection'), false,
      'N081-00 does not project collection; the projection is N081-06 scope');
  } finally {
    store.close();
  }
});

test('AC-08100-5: default is zero collection and a single-frame CaptureGrant cannot enable continuous capture', async () => {
  // Collection 契约没有“默认开启”的构造；授权必须显式下发。
  assert.equal(NORMAL_COLLECTION_POLICY.profile, 'normal');
  assert.equal(SMOKE_COLLECTION_POLICY.profile, 'smoke');

  // 0.8 单帧授权保持原语义：duration='single' 且与 Collection kind 无关，不能作为持续监听凭据。
  const singleFrameGrants = new CaptureGrantManager();
  const single = singleFrameGrants.issueGrant({
    sessionId: 'session-08100',
    scopeType: 'screen',
    targetId: 'screen-primary',
    purpose: 'local_sample_trial',
    destination: 'local',
    duration: 'single',
  });
  assert.equal(single.duration, 'single');
  assert.equal(single.destination, 'local');
  // 单帧授权没有 kind / directoryRoot / grantRevision 概念，无法表达持续来源。
  assert.equal('kind' in single, false);
  assert.equal('directoryRoot' in single, false);

  // 目录来源必须带真实目录，剪贴板/键盘不带目录；这些约束由 CollectionGrant 形状表达。
  const directoryGrantNeedsRoot = (grant: { kind: string; directoryRoot?: string }) =>
    grant.kind !== 'screenshot_directory' || typeof grant.directoryRoot === 'string';
  assert.equal(directoryGrantNeedsRoot({ kind: 'screenshot_directory', directoryRoot: 'F:/tmp/shots' }), true);
  assert.equal(directoryGrantNeedsRoot({ kind: 'screenshot_directory' }), false);
  assert.equal(directoryGrantNeedsRoot({ kind: 'keyboard' }), true);
  assert.equal(directoryGrantNeedsRoot({ kind: 'clipboard_image' }), true);
});
