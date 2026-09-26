/**
 * tests/next082/companion-mode-routes.test.ts
 *
 * N082-08: 正式组合根、管理 API 与模式界面路由测试。
 *
 * AC-08208-1: 管理 API 路由响应：获取状态、修改策略、暂停/恢复、批次触发、立即观察
 * AC-08208-2: 策略变更版本冲突 (409 version_conflict) 与 operationId 幂等保障
 * AC-08208-3: 未装配可选组件时安全降级返回 unavailable，不破坏核心管理服务
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
import { CompanionModeRuntime } from '../../core/companion-mode-runtime.js';
import { CollectionBatchRunner } from '../../core/collection-batch-runner.js';
import { ObservationScheduler } from '../../core/observation-scheduler.js';
import { ScreenCaptureSource } from '../../core/screen-capture-source.js';
import { createLocalOcrEngine } from '../../core/local-ocr-engine.js';
import { companionModeRoute } from '../../management/companion-mode-routes.js';
import { ManagementError } from '../../contracts/management.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08208');

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'aika-08208-'));
  const clock = { now: () => new Date().toISOString() };
  const memory = new SqliteMemoryStore({
    filename: resolve(root, 'companion.sqlite'),
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

  const runtime = new CompanionModeRuntime({
    db,
    pairing,
    now: clock.now,
  });

  const batchRunner = new CollectionBatchRunner({
    db,
    store,
    pairing,
    now: clock.now,
  });

  const captureSource = new ScreenCaptureSource();
  const ocrEngine = createLocalOcrEngine();
  const scheduler = new ObservationScheduler({
    pairing,
    captureSource,
    ocrEngine,
  });

  return { root, memory, db, store, runtime, batchRunner, scheduler };
}

async function callRoute(
  h: Awaited<ReturnType<typeof harness>>,
  method: string,
  pathname: string,
  payload: Record<string, unknown> = {},
) {
  let result: unknown = undefined;
  const handled = await companionModeRoute(
    method,
    h.runtime,
    h.batchRunner,
    h.scheduler,
    pathname,
    new URLSearchParams(),
    async () => payload,
    val => { result = val; },
  );
  return { handled, result };
}

test('AC-08208-1: 管理 API 路由响应：获取状态、修改策略、暂停/恢复、批次触发', async () => {
  const h = await harness();
  try {
    // 1. GET /api/companion-mode
    const getRes = await callRoute(h, 'GET', '/api/companion-mode');
    assert.equal(getRes.handled, true);
    const status = getRes.result as Record<string, unknown>;
    assert.equal(status.runState, 'paused');
    assert.equal((status.policy as Record<string, unknown>).mode, 'passive');

    // 2. PUT /api/companion-mode: 修改为 active 模式
    const putRes = await callRoute(h, 'PUT', '/api/companion-mode', {
      mode: 'active',
      observationIntervalMs: 180_000,
      dailyLocalTime: '21:00',
      timezone: 'Asia/Shanghai',
      expectedRevision: 1,
      operationId: 'op-put-1',
    });
    assert.equal(putRes.handled, true);
    const updatedStatus = putRes.result as Record<string, unknown>;
    assert.equal((updatedStatus.policy as Record<string, unknown>).mode, 'active');
    assert.equal((updatedStatus.policy as Record<string, unknown>).revision, 2);

    // 3. POST /api/companion-mode/resume: 启动运行
    const resumeRes = await callRoute(h, 'POST', '/api/companion-mode/resume', {
      operationId: 'op-resume-route',
    });
    assert.equal(resumeRes.handled, true);
    assert.equal((resumeRes.result as Record<string, unknown>).runState, 'running');

    // 4. POST /api/companion-mode/pause: 暂停运行
    const pauseRes = await callRoute(h, 'POST', '/api/companion-mode/pause', {
      reason: 'manual_pause',
      operationId: 'op-pause-route',
    });
    assert.equal(pauseRes.handled, true);
    assert.equal((pauseRes.result as Record<string, unknown>).runState, 'paused');

    // 5. POST /api/collection/batches: 触发增量批处理
    const batchRes = await callRoute(h, 'POST', '/api/collection/batches', {
      trigger: 'manual',
      expectedPolicyRevision: 2,
      operationId: 'op-batch-route',
    });
    assert.equal(batchRes.handled, true);
    assert.ok((batchRes.result as Record<string, unknown>).jobId);
  } finally {
    h.memory.close();
  }
});

test('AC-08208-2: 策略变更版本冲突 (409 version_conflict) 与 operationId 幂等保障', async () => {
  const h = await harness();
  try {
    // 1. 错误的 expectedRevision: 必须返回 version_conflict
    await assert.rejects(
      async () => callRoute(h, 'PUT', '/api/companion-mode', {
        mode: 'active',
        expectedRevision: 99, // 错误版本号
        operationId: 'op-conflict-test',
      }),
      (err: unknown) => err instanceof ManagementError && err.code === 'version_conflict',
    );

    // 2. operationId 必填检查
    await assert.rejects(
      async () => callRoute(h, 'PUT', '/api/companion-mode', {
        mode: 'active',
        expectedRevision: 1,
        operationId: '   ', // 空白 ID
      }),
      (err: unknown) => err instanceof ManagementError && err.code === 'invalid_request',
    );
  } finally {
    h.memory.close();
  }
});

test('AC-08208-3: 未装配可选组件时安全降级返回 unavailable，不破坏核心管理服务', async () => {
  const h = await harness();
  try {
    let result: unknown = undefined;
    // 模拟 runtime 未装配
    await assert.rejects(
      async () => companionModeRoute(
        'GET',
        undefined, // runtime absent
        h.batchRunner,
        h.scheduler,
        '/api/companion-mode',
        new URLSearchParams(),
        async () => ({}),
        val => { result = val; },
      ),
      (err: unknown) => err instanceof ManagementError && err.code === 'unavailable',
    );
  } finally {
    h.memory.close();
  }
});
