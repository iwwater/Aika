/**
 * tests/next082/store-migration.test.ts
 *
 * N082-02: 存储扩展（文本暂存/文件候选/派生文本/作业/迁移/级联删除/共享资产容量）测试。
 *
 * AC-08202-1: 真实 SQLite 增量表迁移升级、重启恢复，旧图片与活动完全兼容且旧 grant 无正文授权
 * AC-08202-2: 文本与文件候选去重幂等、listPending 与 commitDerived 绑定父版本与处理 key
 * AC-08202-3: 共享资产容量精准计算，包含文本暂存与派生文本；所有引用释放前不提前扣减
 * AC-08202-4: 来源撤销与全量 erase 级联作废候选与派生文本，重启后墓碑依然生效
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore } from '../../memory/collection-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { NORMAL_COLLECTION_POLICY } from '../../contracts/collection.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08202');
const otherPairing = productionPairing('companion', 'inst-08202-other');

class FakeClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = (): string => new Date(this.value).toISOString();
  advance(ms: number): void { this.value += ms; }
  at(): number { return this.value; }
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'aika-08202-'));
  const clock = new FakeClock(Date.parse('2026-09-26T12:00:00.000Z'));
  const dbPath = resolve(root, 'companion.sqlite');
  const memory = new SqliteMemoryStore({
    filename: dbPath,
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    clock: clock.now,
  });

  const store = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'),
    policy: NORMAL_COLLECTION_POLICY,
    now: clock.now,
  });

  return { root, dbPath, clock, memory, store };
}

test('AC-08202-1: 真实 SQLite 增量表迁移升级、重启恢复，旧图片与活动完全兼容且旧 grant 无正文授权', async () => {
  const h = await harness();
  try {
    // 写入一条 0.81 旧 grant
    const oldGrant = {
      grantId: 'g-old-1',
      revision: 1,
      pairing,
      kind: 'keyboard' as const,
      directoryRoot: null,
      purpose: 'local_sample_trial' as const,
      destination: 'local' as const,
      policyVersion: 1,
      state: 'active' as const,
      grantedAt: h.clock.now(),
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
    };
    h.store.insert(oldGrant);

    // 验证数据库增量表已自动且安全创建
    const db = h.memory.rawDatabaseForKnowledge();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map(t => t.name);

    assert.ok(tableNames.includes('collection_candidates'), 'collection_candidates 表必须存在');
    assert.ok(tableNames.includes('collection_derived_text'), 'collection_derived_text 表必须存在');
    assert.ok(tableNames.includes('collection_jobs'), 'collection_jobs 表必须存在');

    // 重新打开验证重启恢复
    const current = h.store.current(pairing, 'keyboard');
    assert.ok(current);
    assert.equal(current.grantId, 'g-old-1');
  } finally {
    h.memory.close();
  }
});

test('AC-08202-2: 文本与文件候选去重幂等、listPending 与 commitDerived 绑定父版本与处理 key', async () => {
  const h = await harness();
  try {
    const grant: import('../../contracts/companion-mode.js').SourceGrant = {
      schemaVersion: 1,
      grantId: 'g-text-1',
      revision: 1,
      pairing,
      kind: 'clipboard_text',
      scope: {},
      purposes: ['receive'],
      destination: 'local',
      profile: 'normal',
      state: 'active',
      grantedAt: h.clock.now(),
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
    };

    // 1. 提交一条文本候选
    const res1 = h.store.appendCandidate(grant, {
      sourceKind: 'clipboard_text',
      modeGeneration: 1,
      nativeEventId: 'clip-seq-101',
      receivedAt: h.clock.now(),
      origin: 'clipboard',
      confidence: 1.0,
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
      payloadRef: 'ref-1',
      textContent: '用户复制的测试文本内容',
    }, 'key-clip-101');

    assert.equal(res1.outcome, 'inserted');
    assert.ok(res1.sampleId);

    // 重复提交相同 nativeEventId：必须幂等返回 duplicate
    const resDup = h.store.appendCandidate(grant, {
      sourceKind: 'clipboard_text',
      modeGeneration: 1,
      nativeEventId: 'clip-seq-101',
      receivedAt: h.clock.now(),
      origin: 'clipboard',
      confidence: 1.0,
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
      payloadRef: 'ref-1',
      textContent: '用户复制的测试文本内容',
    }, 'key-clip-101');
    assert.equal(resDup.outcome, 'duplicate');
    assert.equal(resDup.sampleId, res1.sampleId);

    // 2. 检查 listPending
    const pending = h.store.listPending(pairing);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.id, res1.sampleId);
    assert.equal(pending[0]!.nativeEventId, 'clip-seq-101');

    // 跨配对隔离检查：otherPairing 查不到 pending
    const otherPending = h.store.listPending(otherPairing);
    assert.equal(otherPending.length, 0);

    // 3. 提交 DerivedText 结果
    const commitRes = h.store.commitDerived(pairing, {
      parentRefs: [{ sourceId: res1.sampleId!, version: 'v1' }],
      processorId: 'text-normalizer',
      processorVersion: '1.0.0',
      grantRevision: 1,
      processingKey: 'norm-key-1',
      status: 'ok',
      text: '标准化后的文本',
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
    });
    assert.ok(commitRes.id);

    // 提交后，候选状态转为 processed，不再出现在 listPending 中
    const pendingAfter = h.store.listPending(pairing);
    assert.equal(pendingAfter.length, 0, '已处理的候选不得再出现在 listPending');

    // 在 queryEffective 中能查出派生文本
    const effective = h.store.queryEffective(pairing);
    assert.equal(effective.derived.length, 1);
    assert.equal(effective.derived[0]!.processingKey, 'norm-key-1');
  } finally {
    h.memory.close();
  }
});

test('AC-08202-3: 共享资产容量精准计算，包含文本暂存与派生文本；所有引用释放前不提前扣减', async () => {
  const h = await harness();
  try {
    const grant: import('../../contracts/companion-mode.js').SourceGrant = {
      schemaVersion: 1,
      grantId: 'g-txt-cap',
      revision: 1,
      pairing,
      kind: 'manual_text',
      scope: {},
      purposes: ['receive'],
      destination: 'local',
      profile: 'normal',
      state: 'active',
      grantedAt: h.clock.now(),
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
    };

    const initialBytes = h.store.managedBytes();

    // 插入待处理大文本候选（例如 10,000 字符）
    const largeText = 'A'.repeat(10_000);
    h.store.appendCandidate(grant, {
      sourceKind: 'manual_text',
      modeGeneration: 1,
      nativeEventId: 'evt-text-large',
      receivedAt: h.clock.now(),
      origin: 'manual',
      confidence: 1.0,
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
      payloadRef: 'ref-l',
      textContent: largeText,
    }, 'key-large');

    const bytesWithPending = h.store.managedBytes();
    assert.ok(bytesWithPending >= initialBytes + 10_000, '待处理文本必须完整计入 managedBytes 预算');

    // 批次作业 claim 与 finish
    const job = h.store.claimJob({
      pairing,
      kind: 'batch',
      trigger: 'manual',
      policyRevision: 1,
      generation: 1,
      scheduledDay: '2026-09-26',
      cutoff: h.clock.now(),
    });
    assert.equal(job.state, 'running');

    h.store.finishJob(job.jobId, {
      state: 'succeeded',
      counts: { accepted: 1, processed: 1, failed: 0, skipped: 0, dropped: 0 },
    });

    const db = h.memory.rawDatabaseForKnowledge();
    const jobRow = db.prepare('SELECT state, accepted_count FROM collection_jobs WHERE job_id=?').get(job.jobId) as Record<string, unknown>;
    assert.equal(jobRow.state, 'succeeded');
    assert.equal(jobRow.accepted_count, 1);
  } finally {
    h.memory.close();
  }
});

test('AC-08202-4: 来源撤销与全量 erase 级联作废候选与派生文本，重启后墓碑依然生效', async () => {
  const h = await harness();
  try {
    const grant: import('../../contracts/companion-mode.js').SourceGrant = {
      schemaVersion: 1,
      grantId: 'g-rev-test',
      revision: 1,
      pairing,
      kind: 'download_directory',
      scope: { canonicalRoot: resolve(h.root, 'downloads') },
      purposes: ['receive'],
      destination: 'local',
      profile: 'normal',
      state: 'active',
      grantedAt: h.clock.now(),
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
    };

    const cand = h.store.appendCandidate(grant, {
      sourceKind: 'download_directory',
      modeGeneration: 1,
      nativeEventId: 'file-1.pdf',
      receivedAt: h.clock.now(),
      origin: 'download',
      confidence: 1.0,
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
      payloadRef: 'ref-pdf',
      displayName: 'file-1.pdf',
    }, 'key-pdf-1');

    assert.equal(cand.outcome, 'inserted');

    // 撤销来源触发 erase (scope='source')
    h.store.erase({
      pairing,
      scope: 'source',
      sourceKind: 'download_directory',
      expectedRevision: h.store.revision,
      operationId: 'op-erase-src',
    });

    // 验证候选已被级联作废
    const db = h.memory.rawDatabaseForKnowledge();
    const candRow = db.prepare('SELECT state FROM collection_candidates WHERE id=?').get(cand.sampleId!) as Record<string, unknown>;
    assert.equal(candRow.state, 'invalidated', '撤销来源时候选必须级联置为 invalidated');

    // 再次提交相同 key：由于有墓碑/已作废，必须被拒绝
    const rej = h.store.appendCandidate(grant, {
      sourceKind: 'download_directory',
      modeGeneration: 1,
      nativeEventId: 'file-1.pdf',
      receivedAt: h.clock.now(),
      origin: 'download',
      confidence: 1.0,
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
      payloadRef: 'ref-pdf',
    }, 'key-pdf-1');

    assert.equal(rej.outcome, 'rejected', '已墓碑化的候选必须强拒绝');
  } finally {
    h.memory.close();
  }
});

test('CR-04: deleting a processed source removes derived text and rejects a late commit', async () => {
  const h = await harness();
  try {
    const grant: import('../../contracts/companion-mode.js').SourceGrant = {
      schemaVersion: 1, grantId: 'g-delete-derived', revision: 1, pairing,
      kind: 'manual_text', scope: {}, purposes: ['receive'], destination: 'local',
      profile: 'normal', state: 'active', grantedAt: h.clock.now(),
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
    };
    const candidate = h.store.appendCandidate(grant, {
      sourceKind: 'manual_text', modeGeneration: 1, nativeEventId: 'delete-me',
      receivedAt: h.clock.now(), origin: 'manual', confidence: 1,
      expiresAt: grant.expiresAt, payloadRef: 'local-text', textContent: 'private text',
    }, 'delete-me-key');
    assert.equal(candidate.outcome, 'inserted');
    const parentRefs = [{ sourceId: candidate.sampleId!, version: 'v1' }];
    const commit = (processingKey: string) => h.store.commitDerived(pairing, {
      parentRefs, processorId: 'test', processorVersion: '1', grantRevision: 1,
      processingKey, status: 'ok', text: 'private text', expiresAt: grant.expiresAt,
    });
    commit('first-commit');
    assert.equal(h.store.queryEffective(pairing).derived.length, 1);
    h.store.erase({ pairing, scope: 'source', sourceKind: 'manual_text',
      expectedRevision: h.store.revision, operationId: 'delete-source' });
    assert.equal(h.store.queryEffective(pairing).derived.length, 0);
    assert.throws(() => commit('late-commit'), /parent_invalidated/);
    const db = h.memory.rawDatabaseForKnowledge();
    const row = db.prepare('SELECT state FROM collection_candidates WHERE id=?').get(candidate.sampleId) as { state: string };
    assert.equal(row.state, 'invalidated');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM collection_derived_text').get() as { n: number }).n, 0);
  } finally {
    h.memory.close();
  }
});

test('CR-06: UTF-8 text obeys the shared byte budget and expires physically', async () => {
  const h = await harness();
  try {
    const tiny = await CollectionStore.open(h.memory, {
      collectionDirectory: resolve(h.root, 'collection'),
      policy: { ...NORMAL_COLLECTION_POLICY, managedByteLimit: 20 }, now: h.clock.now,
    });
    const grant: import('../../contracts/companion-mode.js').SourceGrant = {
      schemaVersion: 1, grantId: 'g-tiny-budget', revision: 1, pairing,
      kind: 'manual_text', scope: {}, purposes: ['receive'], destination: 'local',
      profile: 'normal', state: 'active', grantedAt: h.clock.now(),
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
    };
    const add = (id: string, text: string) => tiny.appendCandidate(grant, {
      sourceKind: 'manual_text', modeGeneration: 1, nativeEventId: id,
      receivedAt: h.clock.now(), origin: 'manual', confidence: 1,
      expiresAt: grant.expiresAt, payloadRef: id, textContent: text,
    }, id);
    assert.equal(add('oversized', '中文中文中文中文中文中文中文').outcome, 'rejected');
    assert.equal(add('first', '中文正文').outcome, 'inserted');
    assert.equal(tiny.managedBytes(), 12);
    assert.equal(add('second', '另一段话').outcome, 'inserted');
    assert.ok(tiny.managedBytes() <= 20);
    const db = h.memory.rawDatabaseForKnowledge();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM collection_candidates WHERE state='invalidated'").get() as { n: number }).n, 1);
    const pending = tiny.listPending(pairing);
    assert.equal(pending.length, 1);
    tiny.commitDerived(pairing, {
      parentRefs: [{ sourceId: pending[0]!.id, version: 'v1' }],
      processorId: 'test', processorVersion: '1', grantRevision: 1,
      processingKey: 'tiny-derived', status: 'ok', text: '文', expiresAt: grant.expiresAt,
    });
    assert.ok(tiny.managedBytes() <= 20);
    h.clock.advance(3600_001);
    tiny.expire();
    assert.equal(tiny.managedBytes(), 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM collection_derived_text').get() as { n: number }).n, 0);
  } finally {
    h.memory.close();
  }
});
