/**
 * tests/next082/batch-and-observation-schedulers.test.ts
 *
 * N082-06: 手动/每日批次与周期观察调度器测试。
 *
 * AC-08206-1: 每日计划账本持久化：同日不重复执行，手动触发不消耗每日额度
 * AC-08206-2: 候选批次流转：读取 pending 候选 -> 调用解析器 -> 提交 DerivedText 闭环
 * AC-08206-3: 周期观察调度器：在途并发严格为 1，错过 tick 绝不补抓历史帧
 * AC-08206-4: 观察无实质文字时不产生 Observation 候选，取消与未授权安全退出
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
import { CollectionBatchRunner } from '../../core/collection-batch-runner.js';
import { ObservationScheduler, type ObservationItem } from '../../core/observation-scheduler.js';
import { ScreenCaptureSource, type ScreenTarget } from '../../core/screen-capture-source.js';
import { createLocalOcrEngine } from '../../core/local-ocr-engine.js';
import { DocumentParser } from '../../core/document-parser.js';
import type { ContinuousPerceptionGrant, SourceGrant } from '../../contracts/companion-mode.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08206');

class FakeClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = (): string => new Date(this.value).toISOString();
  advance(ms: number): void { this.value += ms; }
  at(): number { return this.value; }
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'aika-08206-'));
  const clock = new FakeClock(Date.parse('2026-09-26T20:00:00.000Z'));
  const dbPath = resolve(root, 'companion.sqlite');
  const memory = new SqliteMemoryStore({
    filename: dbPath,
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    clock: clock.now,
  });
  const db = memory.rawDatabaseForKnowledge();

  const store = await CollectionStore.open(memory, {
    collectionDirectory: resolve(root, 'collection'),
    policy: NORMAL_COLLECTION_POLICY,
    now: clock.now,
  });

  const parser = new DocumentParser();
  const runner = new CollectionBatchRunner({
    db,
    store,
    pairing,
    parser,
    now: clock.now,
  });

  return { root, clock, memory, db, store, parser, runner };
}

test('AC-08206-1: 每日计划账本持久化：同日不重复执行，手动触发不消耗每日额度', async () => {
  const h = await harness();
  try {
    assert.equal(h.runner.isDayCompleted('2026-09-26'), false);

    // 1. 触发 2026-09-26 的 daily 批次
    const job1 = await h.runner.request({
      trigger: 'daily',
      operationId: 'op-daily-1',
      expectedPolicyRevision: 1,
      generation: 1,
      scheduledDay: '2026-09-26',
    });
    assert.equal(job1.state, 'running');

    // 等待异步批次完成
    await new Promise(r => setTimeout(r, 50));
    assert.equal(h.runner.isDayCompleted('2026-09-26'), true);

    // 2. 再次请求同日的 daily 批次：必须被跳过 (already_completed_today)
    const jobDup = await h.runner.request({
      trigger: 'daily',
      operationId: 'op-daily-2',
      expectedPolicyRevision: 1,
      generation: 1,
      scheduledDay: '2026-09-26',
    });
    assert.equal(jobDup.reasonCode, 'already_completed_today');
    assert.equal(jobDup.counts.skipped, 1);

    // 3. 手动批次不受每日账本限制：依然可以运行
    const manualJob = await h.runner.request({
      trigger: 'manual',
      operationId: 'op-man-1',
      expectedPolicyRevision: 1,
      generation: 1,
    });
    assert.equal(manualJob.trigger, 'manual');
  } finally {
    h.memory.close();
  }
});

test('AC-08206-2: 候选批次流转：读取 pending 候选 -> 调用解析器 -> 提交 DerivedText 闭环', async () => {
  const h = await harness();
  try {
    const grant: SourceGrant = {
      schemaVersion: 1,
      grantId: 'g-b2',
      revision: 1,
      pairing,
      kind: 'download_directory',
      scope: { canonicalRoot: 'D:/Downloads' },
      purposes: ['receive', 'parse'],
      destination: 'local',
      profile: 'normal',
      state: 'active',
      grantedAt: h.clock.now(),
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
    };

    // 写入一个待处理的文本文件候选
    const cand = h.store.appendCandidate(grant, {
      sourceKind: 'download_directory',
      modeGeneration: 1,
      nativeEventId: 'doc-1.txt',
      receivedAt: h.clock.now(),
      origin: 'download',
      confidence: 1.0,
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
      payloadRef: 'ref-doc-1',
      displayName: 'doc-1.txt',
    }, 'key-b2-1');
    assert.ok(cand.sampleId);

    // 运行批次
    await h.runner.request({
      trigger: 'manual',
      operationId: 'op-exec',
      expectedPolicyRevision: 1,
      generation: 1,
      readFileBytes: async () => Buffer.from('这是通过批次解析提取出的正文内容。', 'utf8'),
    });

    await new Promise(r => setTimeout(r, 60));

    // 验证 DerivedText 已入库
    const effective = h.store.queryEffective(pairing);
    assert.equal(effective.derived.length, 1);
    assert.equal(effective.derived[0]!.status, 'ok');
    assert.ok(effective.derived[0]!.textRef);

    // 验证原候选状态已转为 processed
    const pending = h.store.listPending(pairing);
    assert.equal(pending.length, 0);
  } finally {
    h.memory.close();
  }
});

test('CR-05: a manual text batch preserves the actual candidate body', async () => {
  const h = await harness();
  try {
    const grant: SourceGrant = {
      schemaVersion: 1, grantId: 'g-manual-body', revision: 1, pairing,
      kind: 'manual_text', scope: {}, purposes: ['receive'], destination: 'local',
      profile: 'normal', state: 'active', grantedAt: h.clock.now(),
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString(),
    };
    h.store.appendCandidate(grant, {
      sourceKind: 'manual_text', modeGeneration: 1, nativeEventId: 'manual-body',
      receivedAt: h.clock.now(), origin: 'manual', confidence: 1,
      expiresAt: grant.expiresAt, payloadRef: 'manual-ref', textContent: '真正的正文内容',
    }, 'manual-body-key');
    await h.runner.request({ trigger: 'manual', operationId: 'manual-body-job',
      expectedPolicyRevision: 1, generation: 1 });
    await new Promise(resolve => setTimeout(resolve, 30));
    const row = h.db.prepare('SELECT text_content, status FROM collection_derived_text').get() as
      { text_content: string; status: string };
    assert.equal(row.text_content, '真正的正文内容');
    assert.equal(row.status, 'ok');
  } finally {
    h.memory.close();
  }
});

test('CR-09/10: manual work does not close the daily ledger and a daily batch scans past 50 items', async () => {
  const h = await harness();
  try {
    const grant: SourceGrant = { schemaVersion: 1, grantId: 'g-many', revision: 1, pairing,
      kind: 'manual_text', scope: {}, purposes: ['receive'], destination: 'local',
      profile: 'normal', state: 'active', grantedAt: h.clock.now(),
      expiresAt: new Date(h.clock.at() + 3600_000).toISOString() };
    h.store.appendCandidate(grant, { sourceKind: 'manual_text', modeGeneration: 1,
      nativeEventId: 'manual-first', receivedAt: h.clock.now(), origin: 'manual',
      confidence: 1, expiresAt: grant.expiresAt, payloadRef: 'manual-first',
      textContent: '手动先处理' }, 'manual-first');
    await h.runner.request({ trigger: 'manual', operationId: 'manual-before-daily',
      expectedPolicyRevision: 1, generation: 1 });
    assert.equal(h.runner.isDayCompleted(h.clock.now().slice(0, 10)), false);

    for (let i = 0; i < 51; i++) {
      h.store.appendCandidate(grant, { sourceKind: 'manual_text', modeGeneration: 1,
        nativeEventId: `daily-${i}`, receivedAt: h.clock.now(), origin: 'manual',
        confidence: 1, expiresAt: grant.expiresAt, payloadRef: `daily-${i}`,
        textContent: `正文-${i}` }, `daily-${i}`);
    }
    await h.runner.request({ trigger: 'daily', operationId: 'daily-after-manual',
      expectedPolicyRevision: 1, generation: 1, scheduledDay: h.clock.now().slice(0, 10) });
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM collection_derived_text').get() as { n: number }).n, 52);
    assert.equal(h.runner.isDayCompleted(h.clock.now().slice(0, 10)), true);
  } finally {
    h.memory.close();
  }
});

test('CR-10: unsupported first page cannot starve later text or close the daily ledger', async () => {
  const h = await harness();
  try {
    const expiresAt = new Date(h.clock.at() + 3600_000).toISOString();
    const grantBase = { schemaVersion: 1 as const, revision: 1, pairing,
      scope: {}, purposes: ['receive'] as const, destination: 'local' as const,
      profile: 'normal' as const, state: 'active' as const,
      grantedAt: h.clock.now(), expiresAt };
    const unsupportedGrant: SourceGrant = { ...grantBase, grantId: 'g-history',
      kind: 'history_reference' };
    const textGrant: SourceGrant = { ...grantBase, grantId: 'g-later',
      kind: 'manual_text' };
    for (let i = 0; i < 50; i++) {
      h.store.appendCandidate(unsupportedGrant, { sourceKind: 'history_reference',
        modeGeneration: 1, nativeEventId: `history-${i}`, receivedAt: h.clock.now(),
        origin: 'manual', confidence: 1, expiresAt, payloadRef: `history-${i}` },
      `history-${i}`);
    }
    h.store.appendCandidate(textGrant, { sourceKind: 'manual_text',
      modeGeneration: 1, nativeEventId: 'later-text', receivedAt: h.clock.now(),
      origin: 'manual', confidence: 1, expiresAt, payloadRef: 'later-text',
      textContent: '后页正文' }, 'later-text');
    await h.runner.request({ trigger: 'daily', operationId: 'unsupported-first-page',
      expectedPolicyRevision: 1, generation: 1, scheduledDay: h.clock.now().slice(0, 10) });
    const row = h.db.prepare('SELECT text_content FROM collection_derived_text').get() as
      { text_content: string };
    assert.equal(row.text_content, '后页正文');
    assert.equal(h.runner.isDayCompleted(h.clock.now().slice(0, 10)), false);
  } finally {
    h.memory.close();
  }
});

test('AC-08206-3: 周期观察调度器：在途并发严格为 1，错过 tick 绝不补抓历史帧', async () => {
  const captureSource = new ScreenCaptureSource({
    captureHook: async (target) => {
      // 模拟 100ms 捕获耗时
      await new Promise(r => setTimeout(r, 100));
      return {
        targetId: target.targetId,
        targetRevision: target.targetRevision,
        capturedAt: new Date().toISOString(),
        mimeType: 'image/png',
        dimensions: { width: 800, height: 600 },
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]),
      };
    },
  });

  const ocrEngine = createLocalOcrEngine({
    engineName: 'mock-ocr-scheduler',
    recognizePixelHook: async () => [
      { text: '当前屏幕正在运行代码编辑器', confidence: 0.98, bounds: { x: 10, y: 10, width: 200, height: 20 } },
    ],
  });

  const capturedObservations: ObservationItem[] = [];
  const scheduler = new ObservationScheduler({
    pairing,
    captureSource,
    ocrEngine,
    onObservation: obs => capturedObservations.push(obs),
  });

  const grant: ContinuousPerceptionGrant = {
    schemaVersion: 1,
    grantId: 'g-cont-sched',
    revision: 1,
    pairing,
    targetId: 'screen-1',
    targetRevision: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    runtimeSessionId: 'sess-s',
    minPollIntervalMs: 5000,
    expiry: new Date(Date.now() + 3600_000).toISOString(),
    destination: 'local',
    state: 'active',
  };
  const target: ScreenTarget = {
    targetId: 'screen-1',
    targetRevision: 1,
    kind: 'screen',
    displayName: '主屏',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    isValid: true,
  };

  await captureSource.attachContinuousGrant(grant);
  scheduler.setContext(grant, target);

  // 1. 启动第一个观察任务
  const task1 = scheduler.tick();
  assert.equal(scheduler.inFlight, true, '运行中 inFlight 必须为 true');

  // 2. 在第一个任务未完成时，触发第二个 tick：必须直接丢弃返回 null，绝不并发！
  const skippedTick = await scheduler.tick();
  assert.equal(skippedTick, null, '在途观察未完成时，新 tick 必须静默跳过');

  const res1 = await task1;
  assert.ok(res1);
  assert.equal(res1.text, '当前屏幕正在运行代码编辑器');
  assert.equal(capturedObservations.length, 1);
  assert.equal(scheduler.inFlight, false);
});

test('AC-08206-4: 观察无实质文字时不产生 Observation 候选，取消与未授权安全退出', async () => {
  const captureSource = new ScreenCaptureSource({
    captureHook: async target => ({
      targetId: target.targetId,
      targetRevision: target.targetRevision,
      capturedAt: new Date().toISOString(),
      mimeType: 'image/png',
      dimensions: { width: 800, height: 600 },
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]),
    }),
  });

  // 空白无字 OCR
  const blankOcrEngine = createLocalOcrEngine({
    engineName: 'blank-engine',
    recognizePixelHook: async () => [], // 空白无字
  });

  const captured: ObservationItem[] = [];
  const scheduler = new ObservationScheduler({
    pairing,
    captureSource,
    ocrEngine: blankOcrEngine,
    onObservation: obs => captured.push(obs),
  });

  const grant: ContinuousPerceptionGrant = {
    schemaVersion: 1,
    grantId: 'g-blank',
    revision: 1,
    pairing,
    targetId: 'screen-b',
    targetRevision: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    runtimeSessionId: 'sess-b',
    minPollIntervalMs: 5000,
    expiry: new Date(Date.now() + 3600_000).toISOString(),
    destination: 'local',
    state: 'active',
  };
  const target: ScreenTarget = {
    targetId: 'screen-b',
    targetRevision: 1,
    kind: 'screen',
    displayName: '空白屏',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    isValid: true,
  };

  await captureSource.attachContinuousGrant(grant);
  scheduler.setContext(grant, target);

  // 画面空白无字：绝不产生 Observation 候选
  const blankRes = await scheduler.tick();
  assert.equal(blankRes, null);
  assert.equal(captured.length, 0, '画面空白无字不得触发任何事件推送');

  // 取消测试
  const controller = new AbortController();
  controller.abort();
  const cancelRes = await scheduler.tick(controller.signal);
  assert.equal(cancelRes, null);
});

test('CR-07: cancelling a delayed capture prevents late observation and overlapping jobs', async () => {
  let releaseCapture!: () => void;
  const captureWait = new Promise<void>(resolve => { releaseCapture = resolve; });
  const captureSource = new ScreenCaptureSource({ captureHook: async target => {
    await captureWait; // Deliberately ignores AbortSignal to exercise the scheduler's own fence.
    return { targetId: target.targetId, targetRevision: target.targetRevision,
      capturedAt: new Date().toISOString(), mimeType: 'image/png' as const,
      dimensions: { width: 1, height: 1 }, bytes: new Uint8Array([1]) };
  } });
  const observed: ObservationItem[] = [];
  const scheduler = new ObservationScheduler({ pairing, captureSource,
    ocrEngine: createLocalOcrEngine({ recognizePixelHook: async () => [
      { text: 'late', bounds: { x: 0, y: 0, width: 1, height: 1 }, confidence: 1 },
    ] }), onObservation: item => observed.push(item) });
  const target: ScreenTarget = { targetId: 'screen-cancel', targetRevision: 1,
    kind: 'screen', displayName: 'test', bounds: { x: 0, y: 0, width: 1, height: 1 }, isValid: true };
  const grant: ContinuousPerceptionGrant = { schemaVersion: 1, grantId: 'g-cancel', revision: 1,
    pairing, targetId: target.targetId, targetRevision: 1, bounds: target.bounds,
    runtimeSessionId: 'session', minPollIntervalMs: 5000,
    expiry: new Date(Date.now() + 3600_000).toISOString(), destination: 'local', state: 'active' };
  await captureSource.attachContinuousGrant(grant);
  scheduler.setContext(grant, target);
  const pending = scheduler.tick();
  scheduler.cancel();
  assert.equal(scheduler.inFlight, true, 'a cancelled but unresolved capture still occupies the slot');
  assert.equal(await scheduler.tick(), null);
  releaseCapture();
  assert.equal(await pending, null);
  assert.equal(observed.length, 0);
  assert.equal(scheduler.inFlight, false);
});
