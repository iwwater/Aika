/**
 * management/companion-mode-routes.ts
 *
 * N082-08: HTTP Management API routes for Companion Mode & Batch Runner.
 * Provides authenticated control endpoints for mode switching, pause/resume,
 * manual batch triggers, immediate observation, and content inspection.
 */

import { ManagementError } from '../contracts/management.js';
import type { CompanionModeRuntime } from '../core/companion-mode-runtime.js';
import type { CollectionBatchRunner } from '../core/collection-batch-runner.js';
import type { ObservationScheduler } from '../core/observation-scheduler.js';
import type { CompanionMode } from '../contracts/companion-mode.js';

export async function companionModeRoute(
  method: string | undefined,
  runtime: CompanionModeRuntime | undefined,
  batchRunner: CollectionBatchRunner | undefined,
  scheduler: ObservationScheduler | undefined,
  pathname: string,
  _query: URLSearchParams,
  body: () => Promise<Record<string, unknown>>,
  send: (value: unknown) => void,
): Promise<boolean> {
  if (!pathname.startsWith('/api/companion-mode') && !pathname.startsWith('/api/collection/batches')) {
    return false;
  }

  if (!runtime) {
    throw new ManagementError('unavailable', '当前实例未装配陪伴模式运行时。');
  }

  // 1. GET /api/companion-mode
  if (method === 'GET' && pathname === '/api/companion-mode') {
    send(runtime.getStatus());
    return true;
  }

  // 2. PUT /api/companion-mode
  if (method === 'PUT' && pathname === '/api/companion-mode') {
    const val = await body();
    const mode = String(val.mode ?? 'passive') as CompanionMode;
    const observationIntervalMs = Number(val.observationIntervalMs ?? 300_000);
    const dailyLocalTime = String(val.dailyLocalTime ?? '20:00');
    const timezone = String(val.timezone ?? 'Asia/Shanghai');
    const expectedRevision = Number(val.expectedRevision ?? 1);
    const operationId = String(val.operationId ?? '');

    if (!operationId.trim()) throw new ManagementError('invalid_request', 'operationId 必填');

    try {
      const nextPolicy = await runtime.setPolicy({
        mode,
        observationIntervalMs,
        dailyLocalTime,
        timezone,
        expectedRevision,
        operationId,
      });
      send(runtime.getStatus());
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'version_conflict') throw new ManagementError('version_conflict', '策略已被更新，请刷新重试。');
      throw new ManagementError('invalid_request', (err as Error).message);
    }
    return true;
  }

  // 3. POST /api/companion-mode/pause
  if (method === 'POST' && pathname === '/api/companion-mode/pause') {
    const val = await body();
    const reason = String(val.reason ?? 'user_paused');
    const operationId = String(val.operationId ?? '');
    if (!operationId.trim()) throw new ManagementError('invalid_request', 'operationId 必填');

    const status = await runtime.pauseAll(reason, operationId);
    send(status);
    return true;
  }

  // 4. POST /api/companion-mode/resume
  if (method === 'POST' && pathname === '/api/companion-mode/resume') {
    const val = await body();
    const operationId = String(val.operationId ?? '');
    if (!operationId.trim()) throw new ManagementError('invalid_request', 'operationId 必填');

    const status = await runtime.resume(operationId);
    send(status);
    return true;
  }

  // 5. POST /api/companion-mode/observe-now
  if (method === 'POST' && pathname === '/api/companion-mode/observe-now') {
    if (!scheduler) throw new ManagementError('unavailable', '观察调度器未装配。');
    const val = await body();
    const operationId = String(val.operationId ?? '');
    if (!operationId.trim()) throw new ManagementError('invalid_request', 'operationId 必填');

    try {
      const obs = await scheduler.observeNow(operationId);
      send({ outcome: obs ? 'captured' : 'no_text_detected', observation: obs });
    } catch (err: unknown) {
      const msg = (err as Error).message;
      if (msg === 'observation_busy') throw new ManagementError('version_conflict', '当前观察任务正在执行中。');
      if (msg === 'observation_not_authorized') throw new ManagementError('forbidden', '持续屏幕感知未授权。');
      throw new ManagementError('unavailable', msg);
    }
    return true;
  }

  // 6. POST /api/collection/batches
  if (method === 'POST' && pathname === '/api/collection/batches') {
    if (!batchRunner) throw new ManagementError('unavailable', '批处理调度器未装配。');
    const val = await body();
    const trigger = String(val.trigger ?? 'manual') as 'manual' | 'daily' | 'catchup';
    const expectedPolicyRevision = Number(val.expectedPolicyRevision ?? 1);
    const operationId = String(val.operationId ?? '');
    if (!operationId.trim()) throw new ManagementError('invalid_request', 'operationId 必填');

    const job = await batchRunner.request({
      trigger,
      operationId,
      expectedPolicyRevision,
      generation: runtime.currentGeneration,
    });
    send(job);
    return true;
  }

  return false;
}
