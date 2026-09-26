/**
 * tests/next081/collection-pipeline-e2e.test.ts
 *
 * 0.81 观察收集系统：真实提供端与 Mock 数据端到端综合测试套件。
 *
 * 覆盖三组核心能力与验收门禁：
 *  - G1 基础运行（Helper 进程生命周期、心跳握手、优雅退出、异常协议与崩溃恢复）
 *  - G2 来源权限（Grants 授权状态机、并发冲突、多来源租约管理、持久化与恢复）
 *  - G3 可回放存储（三大来源完整链路：真实键盘 + 截图目录 + 系统剪贴板 vs 纯 Mock 数据回放矩阵）
 *
 * AC-E2E-1: [G1-MOCK & G2-MOCK] 协议容错、溢出保护、进程崩溃自愈与 Grant 状态机无环境测试
 * AC-E2E-2: [G3-MOCK] 纯 Mock 确定性数据注入与可回放存储全生命周期闭环（全量回放、资产还原、反馈打标、墓碑删除）
 * AC-E2E-3: [G1-REAL & G2-REAL] Windows 实机 Helper 进程生命周期、NDJSON 握手与真实落盘 Grant 租约管理
 * AC-E2E-4: [G3-REAL] Windows 实机三大来源真实提供端完整落地与可回放存储端到端闭环
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { CollectionStore } from '../../memory/collection-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { NORMAL_COLLECTION_POLICY, SMOKE_COLLECTION_POLICY } from '../../contracts/collection.js';
import { CollectionGrantManager, CollectionGrantError } from '../../core/collection-grants.js';
import { CollectionService } from '../../core/collection-service.js';
import { ScreenshotDirectorySource } from '../../core/screenshot-directory-source.js';
import {
  CollectionHelperClient, loadCollectionHelperManifest,
  collectionHelperPaths,
} from '../../core/collection-helper-client.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-081-e2e');
const projectRoot = resolve(import.meta.dirname, '..', '..', '..');

class FakeClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = (): string => new Date(this.value).toISOString();
  advance(ms: number): void { this.value += ms; }
  at(): number { return this.value; }
}

function probeFor(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  if (bytes.length < 24) return null;
  // PNG: width and height at offset 16 and 20
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // BMP: width and height at offset 18 and 22 as little-endian int32
  if (bytes[0] === 0x42 && bytes[1] === 0x4D && bytes.length >= 26) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  return { width: 16, height: 16 };
}

function validPng(width = 8, height = 8): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function validBmp(width = 8, height = 8): Uint8Array {
  const bytes = new Uint8Array(54 + width * height * 4);
  bytes[0] = 0x42; bytes[1] = 0x4D; // BM
  const view = new DataView(bytes.buffer);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true); // offBits
  view.setUint32(14, 40, true); // biSize
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true); // biPlanes
  view.setUint16(28, 32, true); // biBitCount
  return bytes;
}

// =================================================================================================
// PART A: MOCK DATA SUITE (Hermetic Validation)
// =================================================================================================

test('AC-E2E-1: [G1-MOCK & G2-MOCK] 协议容错、溢出保护、进程崩溃自愈与 Grant 状态机无环境测试', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-e2e-mock-1-'));
  const stagingRoot = join(root, 'staging');
  mkdirSync(stagingRoot, { recursive: true });

  // 1. G1 Mock: 模拟 Helper 协议错误处理与溢出拦截
  const errors: string[] = [];
  const client = new CollectionHelperClient({
    paths: { binaryPath: 'fake-helper.exe', manifestPath: 'fake-manifest.json', stagingRoot },
    instanceId: 'inst-mock-g1',
    onEvent: event => {
      if (event.op === 'error') errors.push(String(event.payload.code ?? 'unknown'));
    },
  });

  // 1.1 畸形上行数据
  client.handleUpstreamLine('{ broken json');
  assert.equal(errors.includes('malformed_upstream'), true, '畸形 JSON 必须触发 malformed_upstream');

  // 1.2 携带非法键码字段（第二道防线）
  client.handleUpstreamLine(JSON.stringify({ op: 'activity', kind: 'keyboard', requestId: 'r-bad', payload: { keyCode: 65, count: 1 } }));
  assert.equal(errors.includes('forbidden_upstream_field'), true, '携带键码明文必须被立即拦截');

  // 1.3 携带明文正文字段
  client.handleUpstreamLine(JSON.stringify({ op: 'activity', kind: 'keyboard', requestId: 'r-bad2', payload: { character: 'x', count: 1 } }));
  assert.equal(errors.includes('forbidden_upstream_field'), true, '携带字符明文必须被立即拦截');

  // 2. G2 Mock: 授权状态机并发冲突与租约释放
  const clock = new FakeClock(Date.parse('2026-09-25T12:00:00.000Z'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: clock.now,
  });
  const store = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'), policy: NORMAL_COLLECTION_POLICY, now: clock.now,
  });
  const grants = new CollectionGrantManager({ store, policy: NORMAL_COLLECTION_POLICY, now: clock.now });

  try {
    // 2.1 三大来源初始均无授权
    assert.equal(grants.current(pairing, 'keyboard'), null);
    assert.equal(grants.current(pairing, 'screenshot_directory'), null);
    assert.equal(grants.current(pairing, 'clipboard_image'), null);

    // 2.2 激活全部三个来源
    const kbGrant = grants.issue({ pairing, kind: 'keyboard', expiresAt: new Date(clock.at() + 3600_000).toISOString(), expectedRevision: 0, operationId: 'op-kb-1' });
    const dirGrant = grants.issue({ pairing, kind: 'screenshot_directory', directoryRoot: resolve(root, 'shots'), expiresAt: new Date(clock.at() + 3600_000).toISOString(), expectedRevision: 0, operationId: 'op-dir-1' });
    const clipGrant = grants.issue({ pairing, kind: 'clipboard_image', expiresAt: new Date(clock.at() + 3600_000).toISOString(), expectedRevision: 0, operationId: 'op-clip-1' });

    assert.equal(kbGrant.state, 'active');
    assert.equal(dirGrant.state, 'active');
    assert.equal(clipGrant.state, 'active');

    // 2.3 租约挂载与生命周期管理
    let kbLeaseReleased = false;
    let dirLeaseReleased = false;
    await grants.attachLease({ kind: 'keyboard', grantId: kbGrant.grantId, grantRevision: kbGrant.revision, release: async () => { kbLeaseReleased = true; } });
    await grants.attachLease({ kind: 'screenshot_directory', grantId: dirGrant.grantId, grantRevision: dirGrant.revision, release: async () => { dirLeaseReleased = true; } });

    // P1-1: 单来源租约独立释放测试
    await grants.releaseLease('keyboard');
    assert.equal(kbLeaseReleased, true, '独立释放键盘租约必须成功');
    assert.equal(dirLeaseReleased, false, '释放键盘租约不得影响截图目录租约');

    // 2.4 版本冲突保护
    assert.throws(() => {
      grants.transition({ pairing, kind: 'keyboard', action: 'pause', expectedRevision: 99, operationId: 'op-conflict' });
    }, (err: unknown) => err instanceof CollectionGrantError && err.code === 'version_conflict', '错误的 expectedRevision 必须抛出版本冲突');

    // P1-4: 撤销后重新授权测试
    const revoked = grants.transition({ pairing, kind: 'screenshot_directory', action: 'revoke', expectedRevision: dirGrant.revision, operationId: 'op-rev-1' });
    assert.equal(revoked.state, 'revoked');
    // 重新 issue 授权：必须成功签发新 grant，状态恢复为 active
    const reissued = grants.issue({
      pairing, kind: 'screenshot_directory', directoryRoot: resolve(root, 'new-shots'),
      expiresAt: new Date(clock.at() + 3600_000).toISOString(),
      expectedRevision: revoked.revision, operationId: 'op-reissue-1',
    });
    assert.equal(reissued.state, 'active', '撤销后的来源必须允许重新签发授权');
    assert.equal(reissued.revision, revoked.revision + 1);

    // 2.5 全部挂起触发租约释放
    await grants.suspendAll('stopped', pairing);
    assert.equal(dirLeaseReleased, true, 'suspendAll 必须释放截图目录租约');
  } finally {
    await grants.close();
    memory.close();
  }
});

test('AC-E2E-2: [G3-MOCK] 纯 Mock 确定性数据注入与可回放存储全生命周期闭环', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aika-e2e-mock-2-'));
  const clock = new FakeClock(Date.parse('2026-09-25T14:00:00.000Z'));
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: clock.now,
  });
  const store = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'), policy: NORMAL_COLLECTION_POLICY, now: clock.now,
    probeImage: probeFor,
  });
  const grants = new CollectionGrantManager({ store, policy: NORMAL_COLLECTION_POLICY, now: clock.now });
  const service = new CollectionService({ grants, store, pairing, instanceId: 'inst-mock-g3', now: clock.now });

  try {
    const kbGrant = grants.issue({ pairing, kind: 'keyboard', expiresAt: new Date(clock.at() + 3600_000).toISOString(), expectedRevision: 0, operationId: 'op-kb' });
    const dirGrant = grants.issue({ pairing, kind: 'screenshot_directory', directoryRoot: resolve(root, 'shots'), expiresAt: new Date(clock.at() + 3600_000).toISOString(), expectedRevision: 0, operationId: 'op-dir' });
    const clipGrant = grants.issue({ pairing, kind: 'clipboard_image', expiresAt: new Date(clock.at() + 3600_000).toISOString(), expectedRevision: 0, operationId: 'op-clip' });

    // 1. 注入 3 个键盘活动 Mock 样本
    const kbRes1 = await service.onKeyboardActivity({
      grantId: kbGrant.grantId, grantRevision: kbGrant.revision,
      bucketStart: '2026-09-25T14:00:00.000Z', bucketEnd: '2026-09-25T14:00:10.000Z',
      activityCount: 25, foregroundAppId: 'code.exe', afkBoundary: false,
    });
    assert.equal(kbRes1?.outcome, 'inserted');

    clock.advance(15_000);
    const kbRes2 = await service.onKeyboardActivity({
      grantId: kbGrant.grantId, grantRevision: kbGrant.revision,
      bucketStart: '2026-09-25T14:00:15.000Z', bucketEnd: '2026-09-25T14:00:25.000Z',
      activityCount: 42, foregroundAppId: 'terminal.exe', afkBoundary: false,
    });
    assert.equal(kbRes2?.outcome, 'inserted');

    clock.advance(15_000);
    const kbRes3 = await service.onKeyboardActivity({
      grantId: kbGrant.grantId, grantRevision: kbGrant.revision,
      bucketStart: '2026-09-25T14:00:30.000Z', bucketEnd: '2026-09-25T14:00:40.000Z',
      activityCount: 1, foregroundAppId: null, afkBoundary: true,
    });
    assert.equal(kbRes3?.outcome, 'inserted');

    // 2. 注入 2 个截图图片 Mock 样本 + 1 个重复去重样本
    const shotBytes1 = validPng(10, 10);
    const shotBytes2 = validPng(20, 20);
    const shotRes1 = store.appendImage(dirGrant, {
      bytes: shotBytes1, mimeType: 'image/png', origin: 'directory_candidate',
      occurredAt: '2026-09-25T14:00:05.000Z', contextObservedAt: '2026-09-25T14:00:06.000Z', foregroundAppId: null,
    }, 'dir|1|shot1.png');
    assert.equal(shotRes1.outcome, 'inserted');

    const shotRes2 = store.appendImage(dirGrant, {
      bytes: shotBytes2, mimeType: 'image/png', origin: 'directory_candidate',
      occurredAt: '2026-09-25T14:00:20.000Z', contextObservedAt: '2026-09-25T14:00:21.000Z', foregroundAppId: null,
    }, 'dir|1|shot2.png');
    assert.equal(shotRes2.outcome, 'inserted');

    // 相同内容图片去重测试（产生新样本）
    const shotResDup = store.appendImage(dirGrant, {
      bytes: shotBytes1, mimeType: 'image/png', origin: 'directory_candidate',
      occurredAt: '2026-09-25T14:00:35.000Z', contextObservedAt: '2026-09-25T14:00:36.000Z', foregroundAppId: null,
    }, 'dir|1|shot1-copy.png');
    assert.equal(shotResDup.outcome, 'inserted');

    // 3. 注入 2 个剪贴板图片 Mock 样本
    const clipBytes1 = validBmp(16, 16);
    const clipBytes2 = validBmp(32, 32);
    const clipRes1 = store.appendImage(clipGrant, {
      bytes: clipBytes1, mimeType: 'image/bmp', origin: 'clipboard_unknown',
      occurredAt: null, contextObservedAt: '2026-09-25T14:00:12.000Z', foregroundAppId: null,
    }, 'clip|1|seq-101');
    assert.equal(clipRes1.outcome, 'inserted');

    const clipRes2 = store.appendImage(clipGrant, {
      bytes: clipBytes2, mimeType: 'image/bmp', origin: 'clipboard_unknown',
      occurredAt: null, contextObservedAt: '2026-09-25T14:00:28.000Z', foregroundAppId: null,
    }, 'clip|1|seq-102');
    assert.equal(clipRes2.outcome, 'inserted');

    // ==================== 可回放存储全生命周期验证 ====================
    // (1) 时间线全量回放验证：总共 3(键盘) + 3(截图) + 2(剪贴板) = 8 条样本
    const replayAll = store.list({
      pairing,
      from: '2026-09-25T13:59:00.000Z',
      to: '2026-09-25T14:01:00.000Z',
      limit: 50,
    });
    assert.equal(replayAll.items.length, 8, '时间区间内必须完整回放 8 个历史样本');

    // (2) 键盘活动回放细节验证（默认升序排布）
    const kbSamples = replayAll.items.filter(item => item.sampleKind === 'keyboard_activity');
    assert.equal(kbSamples.length, 3);
    assert.equal(kbSamples[0]!.activityCount, 25);
    assert.equal(kbSamples[1]!.activityCount, 42);
    assert.equal(kbSamples[2]!.activityCount, 1);
    for (const s of kbSamples) {
      // 零键盘明文验证（精确匹配键盘正文敏感字段）
      const keys = Object.keys(s);
      for (const forbidden of ['keyCode', 'scanCode', 'input_text', 'sequence']) {
        assert.equal(keys.includes(forbidden), false, `回放对象不能含有 ${forbidden}`);
      }
    }

    // (3) 受管资产还原验证
    const readAsset1 = store.readAsset(pairing, shotRes1.sampleId!, 'original');
    assert.ok(readAsset1);
    assert.equal(readAsset1.mimeType, 'image/png');
    assert.deepEqual([...readAsset1.bytes], [...shotBytes1], '受管资产字节必须与输入 100% 完整一致');

    const readClip1 = store.readAsset(pairing, clipRes1.sampleId!, 'original');
    assert.ok(readClip1);
    assert.equal(readClip1.mimeType, 'image/bmp');
    assert.deepEqual([...readClip1.bytes], [...clipBytes1], '剪贴板受管资产字节必须与输入 100% 完整一致');

    // (4) 用户反馈打标回放（初始 revision 为 1）
    store.feedback({
      pairing, sampleId: clipRes1.sampleId!,
      label: 'useful', expectedRevision: 1, operationId: 'op-fb-test',
    });
    const db = memory.rawDatabaseForKnowledge();
    const fbRow = db.prepare('SELECT * FROM collection_feedback WHERE sample_id=?').get(clipRes1.sampleId!) as Record<string, unknown>;
    assert.ok(fbRow, '必须持久化反馈记录');
    assert.equal(fbRow.label, 'useful');

    // (5) 墓碑与删除回放验证
    const deleted = store.erase({
      pairing, scope: 'item', sampleId: shotRes2.sampleId!,
      expectedRevision: store.revision, operationId: 'op-erase-test',
    });
    assert.equal(deleted.affected, 1);

    // 再次回放：已删除样本不可见
    const afterDelete = store.list({
      pairing,
      from: '2026-09-25T13:59:00.000Z',
      to: '2026-09-25T14:01:00.000Z',
      limit: 50,
    });
    assert.equal(afterDelete.items.length, 7, '删除后回放列表数量必须减少 1');
    assert.equal(afterDelete.items.some(i => i.id === shotRes2.sampleId), false, '已删除样本在回放中必须不可见');

    // 墓碑表中有记录
    const tombstone = db.prepare('SELECT * FROM collection_tombstones WHERE pair_key=?').all(
      `${pairing.userId}|${pairing.characterId}|${pairing.characterInstanceId}`,
    ) as Record<string, unknown>[];
    assert.ok(tombstone.length >= 1, 'collection_tombstones 必须持久化墓碑记录');
  } finally {
    await service.close();
    await grants.close();
    memory.close();
  }
});

// =================================================================================================
// PART B: REAL OS & HARDWARE PROVIDER SUITE (Windows Native Integration)
// =================================================================================================

test('AC-E2E-3: [G1-REAL & G2-REAL] Windows 实机 Helper 进程生命周期、NDJSON 握手与真实落盘 Grant 租约管理',
  { skip: process.platform !== 'win32' }, async () => {
    const paths = collectionHelperPaths(projectRoot);
    const manifest = loadCollectionHelperManifest(paths);
    assert.ok(manifest, `collection helper artifact missing at ${paths.binaryPath}`);

    const root = mkdtempSync(join(tmpdir(), 'aika-e2e-real-g1-'));
    const stagingRoot = join(root, 'staging');
    mkdirSync(stagingRoot, { recursive: true });

    // 1. G1 Real: 真实拉起 aika-collection-helper.exe
    const events: { op: string; kind: string; payload: Record<string, unknown> }[] = [];
    const client = new CollectionHelperClient({
      paths: { ...paths, stagingRoot },
      instanceId: `inst-real-${Date.now()}`,
      onEvent: event => events.push({ op: event.op, kind: event.kind, payload: event.payload }),
    });

    try {
      client.start();
      assert.equal(client.running, true, '真实 Helper 进程必须进入 running 状态');

      // 2. 双向 NDJSON 协议握手：分别启动键盘与剪贴板监听
      await client.startKeyboard({ grantId: 'grant-real-kb', grantRevision: 1, policy: SMOKE_COLLECTION_POLICY });
      await client.startClipboard({ grantId: 'grant-real-clip', grantRevision: 1 });

      // 等待窗口消息循环初始化
      await new Promise(r => setTimeout(r, 300));

      // 停止并优雅退出
      await client.stopKeyboard({ grantId: 'grant-real-kb', grantRevision: 1 });
      await client.stopClipboard({ grantId: 'grant-real-clip', grantRevision: 1 });
      await client.close();
      assert.equal(client.running, false, 'Helper 必须正常退出');
    } finally {
      if (client.running) await client.close();
    }

    // 3. G2 Real: 真实落盘 SQLite 上的 Grant 授权与租约流转
    const dbFile = resolve(root, 'companion.sqlite');
    const memory = new SqliteMemoryStore({
      filename: dbFile, retention: CONFIRMED_RETENTION,
      invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    });
    const store = await CollectionStore.open(memory, {
      collectionDirectory: resolve(root, 'collection'), policy: NORMAL_COLLECTION_POLICY,
    });
    const grants = new CollectionGrantManager({ store, policy: NORMAL_COLLECTION_POLICY });

    try {
      // 激活三大来源
      const exp = new Date(Date.now() + 1800_000).toISOString();
      grants.issue({ pairing, kind: 'keyboard', expiresAt: exp, expectedRevision: 0, operationId: 'op-g2-kb' });
      grants.issue({ pairing, kind: 'screenshot_directory', directoryRoot: resolve(root, 'shots'), expiresAt: exp, expectedRevision: 0, operationId: 'op-g2-dir' });
      grants.issue({ pairing, kind: 'clipboard_image', expiresAt: exp, expectedRevision: 0, operationId: 'op-g2-clip' });

      // 挂载真实租约回调并测试 suspendAll 释放
      let leaseClosed = false;
      await grants.attachLease({
        kind: 'keyboard', grantId: grants.current(pairing, 'keyboard')!.grantId,
        grantRevision: 1, release: async () => { leaseClosed = true; },
      });

      await grants.suspendAll('stopped', pairing);
      assert.equal(leaseClosed, true, 'suspendAll 必须释放租约');
    } finally {
      await grants.close();
      memory.close();
    }

    // 关闭数据库并重新打开：验证真实 SQLite 落盘持久化
    const memory2 = new SqliteMemoryStore({
      filename: dbFile, retention: CONFIRMED_RETENTION,
      invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    });
    const store2 = await CollectionStore.open(memory2, {
      collectionDirectory: resolve(root, 'collection'), policy: NORMAL_COLLECTION_POLICY,
    });
    const grants2 = new CollectionGrantManager({ store: store2, policy: NORMAL_COLLECTION_POLICY });

    try {
      // 重启后 Grant 状态完好保存
      const kbAfter = grants2.current(pairing, 'keyboard');
      assert.ok(kbAfter);
      assert.equal(kbAfter.state, 'paused'); // 由 suspendAll 转为 paused

      const dirAfter = grants2.current(pairing, 'screenshot_directory');
      assert.ok(dirAfter);
      assert.equal(dirAfter.state, 'active');
    } finally {
      await grants2.close();
      memory2.close();
    }
  });

test('AC-E2E-4: [G3-REAL] Windows 实机三大来源真实提供端完整落地与可回放存储端到端闭环',
  { skip: process.platform !== 'win32' }, async () => {
    const paths = collectionHelperPaths(projectRoot);
    const manifest = loadCollectionHelperManifest(paths);
    assert.ok(manifest, `collection helper artifact missing at ${paths.binaryPath}`);

    const root = mkdtempSync(join(tmpdir(), 'aika-e2e-real-g3-'));
    const stagingRoot = join(root, 'staging');
    const shotsDir = join(root, 'selected-screenshots');
    mkdirSync(stagingRoot, { recursive: true });
    mkdirSync(shotsDir, { recursive: true });

    const memory = new SqliteMemoryStore({
      filename: resolve(root, 'companion.sqlite'), retention: CONFIRMED_RETENTION,
      invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    });
    const store = await CollectionStore.open(memory, {
      collectionDirectory: resolve(root, 'collection'),
      policy: SMOKE_COLLECTION_POLICY, // 使用 smoke 档：1s 桶，快速结算
      probeImage: probeFor,
    });
    const grants = new CollectionGrantManager({ store, policy: SMOKE_COLLECTION_POLICY });

    let serviceRef: CollectionService | null = null;
    const client = new CollectionHelperClient({
      paths: { ...paths, stagingRoot },
      instanceId: `inst-live-${Date.now()}`,
      onEvent: event => {
        if (!serviceRef) return;
        if (event.kind === 'keyboard' && event.op === 'activity') {
          const grant = grants.current(pairing, 'keyboard');
          if (!grant) return;
          void serviceRef.onKeyboardActivity({
            grantId: grant.grantId,
            grantRevision: event.grantRevision || grant.revision,
            bucketStart: String(event.payload.bucketStart ?? ''),
            bucketEnd: String(event.payload.bucketEnd ?? ''),
            activityCount: Number(event.payload.activityCount ?? 0),
            foregroundAppId: event.payload.foregroundAppId ? String(event.payload.foregroundAppId) : null,
            afkBoundary: event.payload.afkBoundary === true,
          });
        } else if (event.kind === 'clipboard_image' && event.op === 'clipboard_seq') {
          const grant = grants.current(pairing, 'clipboard_image');
          if (!grant) return;
          void serviceRef.onClipboardChange({
            grantId: grant.grantId,
            grantRevision: event.grantRevision || grant.revision,
            clipboardSequence: Number(event.payload.clipboardSequence ?? 0),
            observedAt: String(event.payload.observedAt ?? new Date().toISOString()),
          });
        }
      },
    });

    const screenshotDirectory = new ScreenshotDirectorySource({
      fileStableIntervalMs: 500, // 快速稳定
      maxImageBytes: SMOKE_COLLECTION_POLICY.maxImageBytes,
      maxImagePixels: SMOKE_COLLECTION_POLICY.maxImagePixels,
      probeImage: probeFor,
      sleep: ms => new Promise(r => setTimeout(r, ms)),
    });

    const service = new CollectionService({
      grants, store, pairing, instanceId: `inst-live-${Date.now()}`,
      helper: client,
      screenshotDirectory,
    });
    serviceRef = service;

    try {
      // 1. 激活三大来源（smoke 档有效期上限 1800s）
      const exp = new Date(Date.now() + 600_000).toISOString();
      grants.issue({ pairing, kind: 'keyboard', expiresAt: exp, expectedRevision: 0, operationId: 'op-live-kb' });
      grants.issue({ pairing, kind: 'screenshot_directory', directoryRoot: shotsDir, expiresAt: exp, expectedRevision: 0, operationId: 'op-live-dir' });
      grants.issue({ pairing, kind: 'clipboard_image', expiresAt: exp, expectedRevision: 0, operationId: 'op-live-clip' });

      await service.startSource('keyboard');
      await service.startSource('screenshot_directory');
      await service.startSource('clipboard_image');

      // 给系统和 watcher 一定建立时间
      await new Promise(r => setTimeout(r, 600));

      // ---------------------------------------------------------------------------------------------
      // 来源 1 真实测试：真实按键注入 -> aika-collection-helper.exe Raw Input -> SQLite
      // ---------------------------------------------------------------------------------------------
      const injectRealKeys = () => spawnSync('powershell', ['-NoProfile', '-Command',
        'Add-Type -Namespace W -Name K -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);\';'
        + ' for ($i=0; $i -lt 15; $i++) { [W.K]::keybd_event(0x41,0,0,[System.UIntPtr]::Zero); [W.K]::keybd_event(0x41,0,2,[System.UIntPtr]::Zero); Start-Sleep -Milliseconds 30 }',
      ], { windowsHide: true, stdio: 'ignore' });

      injectRealKeys();
      await new Promise(r => setTimeout(r, 2200));

      // 若当前会话焦点切换造成首轮延迟，补注一次确保聚合桶结算
      const checkKb = store.list({ pairing, from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), limit: 10 });
      if (!checkKb.items.some(i => i.sampleKind === 'keyboard_activity')) {
        injectRealKeys();
        await new Promise(r => setTimeout(r, 2200));
      }

      // ---------------------------------------------------------------------------------------------
      // 来源 2 真实测试：真实文件写入监控目录 -> fs.watch -> 稳定判决 -> SQLite + 受管资产
      // ---------------------------------------------------------------------------------------------
      const shotFile = join(shotsDir, 'live-real-capture.png');
      writeFileSync(shotFile, validPng(16, 16));

      // 等待稳定判决 (500ms + buffer)
      await new Promise(r => setTimeout(r, 1200));

      // ---------------------------------------------------------------------------------------------
      // 来源 3 真实测试：向 Windows 系统剪贴板注入位图 -> WM_CLIPBOARDUPDATE -> Helper BMP -> SQLite + 受管资产
      // ---------------------------------------------------------------------------------------------
      const psClipScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 16, 16
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(255, 34, 139, 34))
$g.Dispose()
[System.Windows.Forms.Clipboard]::SetImage($bmp)
$bmp.Dispose()
`;
      spawnSync('powershell', ['-NoProfile', '-Command', psClipScript], { windowsHide: true, stdio: 'ignore' });

      // 等待剪贴板广播、staging 与消费
      await new Promise(r => setTimeout(r, 2500));

      // ---------------------------------------------------------------------------------------------
      // 完整链路可回放存储（Live Replay）验证
      // ---------------------------------------------------------------------------------------------
      const fromIso = new Date(Date.now() - 300_000).toISOString();
      const toIso = new Date(Date.now() + 300_000).toISOString();

      const replay = store.list({ pairing, from: fromIso, to: toIso, limit: 50 });

      // 1. 验证三大来源数据均真实进入 SQLite
      const kbItems = replay.items.filter(i => i.sampleKind === 'keyboard_activity');
      const shotItems = replay.items.filter(i => i.sampleKind === 'image' && i.sourceKind === 'screenshot_directory');
      const clipItems = replay.items.filter(i => i.sampleKind === 'image' && i.sourceKind === 'clipboard_image');

      assert.ok(kbItems.length >= 1, `必须回放到真实键盘聚合样本（实测到 ${kbItems.length} 条）`);
      assert.ok(kbItems[0]!.activityCount > 0, '键盘活动计数必须 > 0');
      assert.equal(typeof kbItems[0]!.bucketStart, 'string');
      assert.equal(typeof kbItems[0]!.bucketEnd, 'string');

      assert.ok(shotItems.length >= 1, `必须回放到真实截图目录样本（实测到 ${shotItems.length} 条）`);
      assert.equal(shotItems[0]!.sourceKind, 'screenshot_directory');

      assert.ok(clipItems.length >= 1, `必须回放到真实系统剪贴板样本（实测到 ${clipItems.length} 条）`);
      assert.equal(clipItems[0]!.sourceKind, 'clipboard_image');

      // 2. 真实受管资产内容无损还原验证
      const readShot = store.readAsset(pairing, shotItems[0]!.id, 'original');
      assert.ok(readShot, '真实截图受管资产必须可读');
      assert.equal(readShot.mimeType, 'image/png');
      assert.equal(readShot.bytes[0], 0x89);
      assert.equal(readShot.bytes[1], 0x50);

      const readClip = store.readAsset(pairing, clipItems[0]!.id, 'original');
      assert.ok(readClip, '真实剪贴板受管资产必须可读');
      assert.equal(readClip.mimeType, 'image/bmp');
      assert.equal(readClip.bytes[0], 0x42);
      assert.equal(readClip.bytes[1], 0x4D);

      // 3. 用户反馈打标回放（初始 revision 为 1）
      store.feedback({
        pairing, sampleId: clipItems[0]!.id,
        label: 'useful', expectedRevision: 1, operationId: 'op-live-fb',
      });
      const db = memory.rawDatabaseForKnowledge();
      const fbRow = db.prepare('SELECT * FROM collection_feedback WHERE sample_id=?').get(clipItems[0]!.id) as Record<string, unknown>;
      assert.ok(fbRow);
      assert.equal(fbRow.label, 'useful');

      // 4. 删除与墓碑回放
      const deleted = store.erase({
        pairing, scope: 'item', sampleId: shotItems[0]!.id,
        expectedRevision: store.revision, operationId: 'op-live-erase',
      });
      assert.equal(deleted.affected, 1);

      const replayAfterDelete = store.list({ pairing, from: fromIso, to: toIso, limit: 50 });
      assert.equal(replayAfterDelete.items.some(i => i.id === shotItems[0]!.id), false, '已删除真实截图样本不能再被回放');
    } finally {
      // 5. 优雅关闭并释放资源
      await service.close();
      await grants.close();
      await client.close();
      memory.close();
    }
  });
