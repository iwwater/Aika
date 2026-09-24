/**
 * tests/next08/integration-closure.test.ts
 *
 * 08-06 module regression suite:
 * Exercises in-process package fixtures (08-I), Console Routing & Deep-links (08-J),
 * Cross-domain Trace & Source Attribution (08-M, 08-K), and System-wide Invariants.
 *
 * AC-0806-1: Minimum package combinations and graceful degradation (08-I)
 * AC-0806-2: Route parsing, token desensitization, and legacy deep-link mapping (08-J)
 * AC-0806-3: Cross-domain trace and source attribution in an in-process fixture (08-M, 08-K)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CompanionEventHub } from '../../core/companion-event-hub.js';
import { UnifiedTimelineService } from '../../memory/unified-timeline.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { CaptureGrantManager } from '../../core/perception-grant.js';
import { ScreenPerceptionService } from '../../core/screen-perception.js';
import { ProactiveCompanionService } from '../../core/proactive-companion.js';
import { WorkDispatchManager, AcpProtocolAdapter, McpToolProtocolAdapter } from '../../core/work-protocol-adapter.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { CompanionEventEnvelope } from '../../contracts/perception.js';

async function loadRoutesModule() {
  const here = fileURLToPath(import.meta.url);
  // Try relative from dist/tests/next08 or tests/next08
  const candidates = [
    resolve(here, '../../../../management/ui/routes.mjs'),
    resolve(here, '../../../management/ui/routes.mjs'),
    resolve(here, '../../management/ui/routes.mjs'),
  ];
  const target = candidates.find(c => existsSync(c));
  if (!target) throw new Error('routes.mjs not found in candidates');
  return import(pathToFileURL(target).href);
}

test('AC-0806-1: In-process package fixture fails closed when optional executors are unavailable (08-I)', async () => {
  const pairing = productionPairing('companion', 'inst-alpha');
  const hub = new CompanionEventHub();

  // 1. Pure Core (No Perception, No Proactive, No Work)
  // Dialogue and events still operate without missing module exceptions
  let coreEventCount = 0;
  hub.subscribeDomain(['companion', 'canon'], () => {
    coreEventCount++;
  });

  hub.publishEnvelope({
    schemaVersion: 1,
    eventId: 'core-evt-1',
    domain: 'companion',
    type: 'companion.turn.finished',
    pairing,
    sourceRef: { id: 'turn-1', version: 1 },
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    payload: { text: '你好呀！' },
    summary: 'Core turn event',
  });
  assert.equal(coreEventCount, 1, 'Pure core must operate independently');

  // 2. Core + Perception only (No Proactive, No Work)
  const grantMgr = new CaptureGrantManager();
  const perception = new ScreenPerceptionService(grantMgr);
  const grant = grantMgr.issueGrant({
    sessionId: 'sess-1',
    scopeType: 'window',
    targetId: 'hwnd-1',
    purpose: 'Test',
    destination: 'local',
    duration: 'single',
  });
  await assert.rejects(
    () => perception.processCapture(
      { grantId: grant.grantId, imageBytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
      pairing,
    ),
    /local_perception_engine_unavailable/,
  );

  // 3. Core + Proactive only (No Perception, No Work)
  const proactive = new ProactiveCompanionService(hub, {
    enabled: true,
    dailyMax: 2,
    minIntervalMs: 0,
    timezone: 'Asia/Shanghai',
  }, undefined, () => true);
  proactive.registerCandidate({
    id: 'cand-solo',
    pairing,
    reasonCode: 'schedule',
    sourceRef: { kind: 'schedule', id: 'schedule-solo', version: 1 },
    text: '该喝水了~',
    actionKind: 'text',
    quotaDomain: 'greeting',
    createdAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 3600000).toISOString(),
    status: 'pending',
  });
  const presented = proactive.presentNext(pairing);
  assert.equal(presented?.id, 'cand-solo');

  // 4. Core + Work only (No Perception, No Proactive)
  const workMgr = new WorkDispatchManager(hub, new AcpProtocolAdapter(), new McpToolProtocolAdapter());
  const workRequest = workMgr.prepareRequest({
    operationId: 'op-solo',
    protocol: 'internal_harness',
    executorId: 'codex',
    target: { title: 'Solo Work' },
    instruction: 'build',
    permissionGrant: [],
  });
  const receipt = await workMgr.dispatch('op-solo', pairing, workRequest.revision);
  assert.equal(receipt.status, 'failed', 'A package fixture without a real executor must not claim successful work');
  assert.match(receipt.error?.message ?? '', /executor is not configured/i);
});

test('AC-0806-2: Route parsing, token desensitization, and legacy deep-link mapping (08-J)', async () => {
  const { parseConsoleRoute, CONSOLE_PAGES } = await loadRoutesModule();

  // 1. Token desensitization from URL bar
  const routeWithToken = parseConsoleRoute('#page=overview&token=secret-token-abcdef123456');
  assert.equal(routeWithToken.page, 'overview');
  assert.equal(routeWithToken.token, 'secret-token-abcdef123456');
  assert.equal(routeWithToken.hasTokenInUrl, true);
  // Address bar targetHash must NOT leak the token!
  assert.ok(!routeWithToken.targetHash.includes('secret-token'), 'targetHash must strip sensitive session token');
  assert.ok(!routeWithToken.targetHash.includes('token='));

  // 2. Legacy section deep-link: #section=timeline -> page 'timeline'
  const timelineRoute = parseConsoleRoute('#section=timeline');
  assert.equal(timelineRoute.page, 'timeline');
  assert.equal(timelineRoute.section, null);

  // 3. Legacy section deep-link: #section=diagnostics -> page 'events'
  const diagRoute = parseConsoleRoute('#section=diagnostics');
  assert.equal(diagRoute.page, 'events');
  assert.equal(diagRoute.section, null);

  // 4. Legacy section deep-link: #section=runtime -> page 'health'
  const runtimeRoute = parseConsoleRoute('#section=runtime');
  assert.equal(runtimeRoute.page, 'health');
  assert.equal(runtimeRoute.section, null);

  // 5. Legacy memory sub-sections: #section=records -> page 'memory', section 'records'
  const memoryRoute = parseConsoleRoute('#section=records');
  assert.equal(memoryRoute.page, 'memory');
  assert.equal(memoryRoute.section, 'records');

  // 6. Verify full console page registry
  assert.ok(CONSOLE_PAGES.includes('overview'));
  assert.ok(CONSOLE_PAGES.includes('timeline'));
  assert.ok(CONSOLE_PAGES.includes('knowledge'));
  assert.ok(CONSOLE_PAGES.includes('tasks'));
  assert.ok(CONSOLE_PAGES.includes('events'));
});

test('AC-0806-3: Cross-domain trace and source attribution in an in-process fixture (08-M, 08-K)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'timeline-0806-test-'));
  const dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  t.after(() => {
    try { db.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const characterPacks = await CharacterPackStore.open(db);
  const timeline = new UnifiedTimelineService(db, characterPacks);
  const pairing = productionPairing('companion', 'inst-alpha');

  // 1. Record Companion Interaction Event
  const compEnv: CompanionEventEnvelope = {
    schemaVersion: 1,
    eventId: 'evt-comp-201',
    domain: 'companion',
    type: 'companion.turn.saved',
    pairing,
    turnId: 'turn-999',
    sourceRef: { id: 'turn-999', version: 1 },
    occurredAt: '2026-09-24T09:00:00.000Z',
    receivedAt: '2026-09-24T09:00:01.000Z',
    payload: { userText: '今天天气真好', assistantText: '是呀，微风很舒服呢~' },
    summary: '日常对话',
  };
  await timeline.recordEvent(compEnv);

  // 2. Record Work Event (Engineering task receipt)
  const workEnv: CompanionEventEnvelope = {
    schemaVersion: 1,
    eventId: 'evt-work-301',
    domain: 'work',
    type: 'work.task.receipt',
    pairing,
    sourceRef: { id: 'op-compile-88', version: 1 },
    occurredAt: '2026-09-24T10:00:00.000Z',
    receivedAt: '2026-09-24T10:00:01.000Z',
    payload: { executorId: 'codex', taskId: 'task-88', status: 'succeeded', title: 'TypeScript 编译', instruction: 'npm run build' },
    summary: '代码编译任务已完成',
  };
  await timeline.recordEvent(workEnv);

  // 3. Query Unified Timeline View
  const compResult = await timeline.queryTimeline({ pairing, domains: ['companion'] });
  assert.equal(compResult.items.length, 1);
  assert.equal(compResult.items[0]?.domain, 'companion');
  assert.equal(compResult.items[0]?.sourceRef.id, 'turn-999');

  const workResult = await timeline.queryTimeline({ pairing, domains: ['work'] });
  assert.equal(workResult.items.length, 1);
  assert.equal(workResult.items[0]?.domain, 'work');
  assert.equal(workResult.items[0]?.sourceRef.id, 'op-compile-88');

  const fullResult = await timeline.queryTimeline({ pairing });
  assert.ok(fullResult.items.length >= 2);
  assert.ok(fullResult.items.some(item => item.domain === 'companion'));
  assert.ok(fullResult.items.some(item => item.domain === 'work'));
});
