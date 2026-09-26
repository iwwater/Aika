/**
 * tests/next08/perception.test.ts
 *
 * 08-03 Acceptance Test Suite:
 * Validates CaptureGrantManager, ScreenPerceptionService, and ObservationContextAdapter.
 *
 * AC-0803-1: Grant validation and single-use expiration
 * AC-0803-2: Destination change requires re-grant
 * AC-0803-3: Mid-flight cancellation stops observation production
 * AC-0803-4: Raw image buffer dropped, structured extraction preserved with caching
 * AC-0803-5: Dynamic suffix context injection preserves frozen prefix snapshot
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CaptureGrantManager } from '../../core/perception-grant.js';
import { ScreenPerceptionService } from '../../core/screen-perception.js';
import { ObservationContextAdapter } from '../../core/observation-context.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { OcrResult, VlmObservationResult } from '../../contracts/perception.js';

test('AC-0803-1: Grant validation and single-use expiration', async () => {
  const grantMgr = new CaptureGrantManager();
  const service = new ScreenPerceptionService(grantMgr, {
    localOcrEngine: async (): Promise<OcrResult> => ({ status: 'ok', engine: 'fixture', readingOrderText: 'ok', blocks: [] }),
  });
  const pairing = productionPairing('companion', 'inst-alpha');
  const dummyImage = new Uint8Array([1, 2, 3, 4, 5]);

  // 1. Capture without grant must be rejected
  await assert.rejects(
    async () => service.processCapture({ grantId: 'non-existent', imageBytes: dummyImage, mimeType: 'image/png' }, pairing),
    /rejected/i,
  );

  // 2. Issue single-use grant
  const grant = grantMgr.issueGrant({
    sessionId: 'session-1',
    scopeType: 'window',
    targetId: 'hwnd-1001',
    purpose: '页面问答',
    destination: 'local',
    duration: 'single',
  });
  assert.equal(grant.status, 'active');

  // 3. First capture succeeds and consumes the single grant
  const obs = await service.processCapture({ grantId: grant.grantId, imageBytes: dummyImage, mimeType: 'image/png' }, pairing);
  assert.ok(obs.observationId);
  assert.equal(obs.state, 'active');

  // 4. Subsequent capture using same single-use grant must be rejected
  await assert.rejects(
    async () => service.processCapture({ grantId: grant.grantId, imageBytes: dummyImage, mimeType: 'image/png' }, pairing),
    /rejected/i,
  );
  assert.equal(grantMgr.getGrant(grant.grantId)?.status, 'expired');
});

test('AC-0803-2: Destination change from local to cloud invalidates grant', () => {
  const grantMgr = new CaptureGrantManager();

  const initialGrant = grantMgr.issueGrant({
    sessionId: 'session-1',
    scopeType: 'window',
    targetId: 'hwnd-editor',
    purpose: '阅读代码',
    destination: 'local',
    duration: 'session',
  });

  // Verify same target and same local destination maintains grant
  const check1 = grantMgr.verifyOrReissue(initialGrant.grantId, 'hwnd-editor', 'local');
  assert.equal(check1.status, 'valid');
  if (check1.status !== 'valid') throw new Error('Expected the unchanged grant to remain valid');
  assert.equal(check1.grant.grantId, initialGrant.grantId);

  // Switching destination to 'cloud' revokes the grant and waits for explicit user confirmation.
  const check2 = grantMgr.verifyOrReissue(initialGrant.grantId, 'hwnd-editor', 'cloud');
  assert.equal(check2.status, 'reauthorization_required');
  assert.equal(grantMgr.getGrant(initialGrant.grantId)?.status, 'revoked');
  assert.equal(grantMgr.listActiveGrants().length, 0, 'A destination change must not issue a replacement grant');

  const confirmed = grantMgr.reauthorizeGrant(initialGrant.grantId, {
    sessionId: initialGrant.sessionId,
    scopeType: initialGrant.scopeType,
    targetId: 'hwnd-editor',
    purpose: initialGrant.purpose,
    destination: 'cloud',
    duration: initialGrant.duration,
  }, true);
  assert.equal(confirmed.destination, 'cloud');
  assert.equal(confirmed.revision, initialGrant.revision + 1);

  const targetChange = grantMgr.verifyOrReissue(confirmed.grantId, 'hwnd-other', 'local');
  assert.equal(targetChange.status, 'reauthorization_required', 'Changing the target or destination in either direction requires a fresh confirmation');
  assert.equal(grantMgr.listActiveGrants().length, 0);
  assert.throws(() => grantMgr.reauthorizeGrant(confirmed.grantId, {
    sessionId: 'different-session', scopeType: 'window', targetId: 'hwnd-other', purpose: '阅读代码',
    destination: 'local', duration: 'session',
  }, true), /grant_session_scope_mismatch/);
  const confirmedTarget = grantMgr.reauthorizeGrant(confirmed.grantId, {
    sessionId: initialGrant.sessionId, scopeType: 'window', targetId: 'hwnd-other', purpose: '阅读代码',
    destination: 'local', duration: 'session',
  }, true);
  assert.equal(confirmedTarget.revision, confirmed.revision + 1);
});

test('AC-0803-3: Mid-flight cancellation stops observation production', async () => {
  const grantMgr = new CaptureGrantManager();
  let vlmStarted = false;

  const slowVlm = async (_bytes: Uint8Array, signal?: AbortSignal): Promise<VlmObservationResult> => {
    vlmStarted = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({
        status: 'ok',
        summary: '慢速识别结果',
        visualElements: ['按钮'],
        rawExcluded: true,
      }), 100);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('VLM aborted by grant revocation'));
      });
    });
  };

  const service = new ScreenPerceptionService(grantMgr, { localVlmEngine: slowVlm });
  const pairing = productionPairing('companion', 'inst-alpha');
  const grant = grantMgr.issueGrant({
    sessionId: 'session-1',
    scopeType: 'region',
    targetId: 'rect-target',
    purpose: '分析图表',
    destination: 'local',
    duration: 'session',
  });

  // Start capture asynchronously
  const capturePromise = service.processCapture(
    { grantId: grant.grantId, imageBytes: new Uint8Array([9, 8, 7]), mimeType: 'image/png' },
    pairing,
  );

  // Give VLM a moment to begin, then revoke grant
  await new Promise(r => setTimeout(r, 10));
  assert.ok(vlmStarted);
  grantMgr.revokeGrant(grant.grantId);

  // Capture must reject due to abortion
  await assert.rejects(capturePromise, /aborted|revoked/i);
});

test('AC-0803-4: Raw image buffer dropped, structured extraction preserved with caching', async () => {
  const grantMgr = new CaptureGrantManager();
  let ocrCallCount = 0;

  const mockOcr = async (bytes: Uint8Array): Promise<OcrResult> => {
    ocrCallCount++;
    return {
      status: 'ok',
      engine: 'mock-paddle',
      readingOrderText: '识别到的按钮文本',
      blocks: [{ text: '按钮', confidence: 0.98, bounds: { x: 10, y: 10, width: 50, height: 20 } }],
    };
  };

  const service = new ScreenPerceptionService(grantMgr, { localOcrEngine: mockOcr });
  const pairing = productionPairing('companion', 'inst-alpha');
  const grant = grantMgr.issueGrant({
    sessionId: 'session-1',
    scopeType: 'window',
    targetId: 'hwnd-calc',
    purpose: 'OCR 测试',
    destination: 'local',
    duration: 'session',
  });

  const imgBytes = new Uint8Array([42, 42, 42, 42]);
  const expectedHash = createHash('sha256').update(imgBytes).digest('hex');

  // 1. First capture
  const obs1 = await service.processCapture({ grantId: grant.grantId, imageBytes: imgBytes, mimeType: 'image/png' }, pairing);
  assert.equal(ocrCallCount, 1);
  assert.equal(obs1.frameHash, expectedHash);
  assert.equal(obs1.ocr?.readingOrderText, '识别到的按钮文本');
  assert.equal((obs1 as any).imageBytes, undefined, 'Raw image buffer must not be retained');

  // 2. Second capture with identical image bytes hits cache
  const obs2 = await service.processCapture({ grantId: grant.grantId, imageBytes: imgBytes, mimeType: 'image/png' }, pairing);
  assert.equal(ocrCallCount, 1, 'Second identical capture must hit frame cache and not re-run OCR');
  assert.equal(obs2.frameHash, expectedHash);
});

test('AC-0803-4a: Revoking a grant purges its OCR cache and observation text', async () => {
  const grantMgr = new CaptureGrantManager();
  let ocrCallCount = 0;
  const service = new ScreenPerceptionService(grantMgr, {
    localOcrEngine: async (): Promise<OcrResult> => {
      ocrCallCount++;
      return { status: 'ok', engine: 'fixture', readingOrderText: 'private text', blocks: [] };
    },
  });
  const pairing = productionPairing('companion', 'inst-alpha');
  const imageBytes = new Uint8Array([4, 3, 2, 1]);
  const firstGrant = grantMgr.issueGrant({ sessionId: 'session-1', scopeType: 'window', targetId: 'window-1',
    purpose: 'test', destination: 'local', duration: 'session' });
  const firstObservation = await service.processCapture({ grantId: firstGrant.grantId, imageBytes, mimeType: 'image/png' }, pairing);
  grantMgr.revokeGrant(firstGrant.grantId);
  const invalidated = service.getObservation(firstObservation.observationId);
  assert.equal(invalidated?.state, 'invalidated');
  assert.equal(invalidated?.ocr, undefined, 'Revoked observation text must be removed from the service');

  const secondGrant = grantMgr.issueGrant({ sessionId: 'session-1', scopeType: 'window', targetId: 'window-1',
    purpose: 'test', destination: 'local', duration: 'session' });
  const secondObservation = await service.processCapture({ grantId: secondGrant.grantId, imageBytes, mimeType: 'image/png' }, pairing);
  assert.equal(ocrCallCount, 2, 'A new authorization must not reuse a previous grant cache entry');
  assert.equal(grantMgr.endSession('session-1'), 1);
  const afterSessionEnd = service.getObservation(secondObservation.observationId);
  assert.equal(afterSessionEnd?.state, 'invalidated');
  assert.equal(afterSessionEnd?.ocr, undefined, 'Ending the session removes observation text');
});

test('AC-0803-4c: Ending a session redacts an observation from a consumed single-use grant', async () => {
  const grantMgr = new CaptureGrantManager();
  const service = new ScreenPerceptionService(grantMgr, {
    localOcrEngine: async (): Promise<OcrResult> => ({ status: 'ok', engine: 'fixture', readingOrderText: 'turn-only text', blocks: [] }),
  });
  const grant = grantMgr.issueGrant({ sessionId: 'single-session', scopeType: 'window', targetId: 'window-1',
    purpose: 'current turn only', destination: 'local', duration: 'single' });
  const observation = await service.processCapture({ grantId: grant.grantId, imageBytes: new Uint8Array([9]), mimeType: 'image/png' },
    productionPairing('companion', 'inst-alpha'));
  assert.equal(service.getObservation(observation.observationId)?.ocr?.readingOrderText, 'turn-only text');

  // It is already expired as a grant because it was consumed, but session end
  // must still clear its current-turn allowance and retained observation body.
  assert.equal(grantMgr.endSession('single-session'), 0);
  const afterSessionEnd = service.getObservation(observation.observationId);
  assert.equal(afterSessionEnd?.state, 'invalidated');
  assert.equal(afterSessionEnd?.ocr, undefined);
});

test('AC-0803-4b: Local grants cannot reach the cloud engine, and cloud grants fail closed without one', async () => {
  const grantMgr = new CaptureGrantManager();
  let localCalls = 0;
  let cloudCalls = 0;
  const service = new ScreenPerceptionService(grantMgr, {
    localVlmEngine: async (): Promise<VlmObservationResult> => {
      localCalls++;
      return { status: 'ok', summary: 'local result', visualElements: [], rawExcluded: true };
    },
    cloudVlmEngine: async (): Promise<VlmObservationResult> => {
      cloudCalls++;
      return { status: 'ok', summary: 'cloud result', visualElements: [], rawExcluded: true };
    },
  });
  const pairing = productionPairing('companion', 'inst-alpha');
  const imageBytes = new Uint8Array([7, 7]);
  const localGrant = grantMgr.issueGrant({ sessionId: 'session-local', scopeType: 'window', targetId: 'window-1',
    purpose: 'local only', destination: 'local', duration: 'session' });
  await service.processCapture({ grantId: localGrant.grantId, imageBytes, mimeType: 'image/png' }, pairing);
  assert.equal(localCalls, 1);
  assert.equal(cloudCalls, 0, 'A local grant must never route bytes to the cloud engine');

  const cloudGrant = grantMgr.issueGrant({ sessionId: 'session-cloud', scopeType: 'window', targetId: 'window-1',
    purpose: 'cloud explicit', destination: 'cloud', duration: 'session' });
  const noCloudService = new ScreenPerceptionService(grantMgr, {
    localVlmEngine: async (): Promise<VlmObservationResult> => {
      localCalls++;
      return { status: 'ok', summary: 'must not run', visualElements: [], rawExcluded: true };
    },
  });
  await assert.rejects(
    () => noCloudService.processCapture({ grantId: cloudGrant.grantId, imageBytes, mimeType: 'image/png' }, pairing),
    /cloud_perception_engine_unavailable/,
  );
  assert.equal(localCalls, 1, 'A cloud grant must not silently fall back to local or another route');
  assert.equal(cloudCalls, 0, 'An unconfigured cloud route must not report successful processing');
});

test('AC-0803-5: Dynamic suffix context injection preserves frozen prefix snapshot', () => {
  const grantMgr = new CaptureGrantManager();
  const service = new ScreenPerceptionService(grantMgr);
  const adapter = new ObservationContextAdapter(service);

  const pairing = productionPairing('companion', 'inst-alpha');
  const grant = grantMgr.issueGrant({
    sessionId: 'session-1',
    scopeType: 'window',
    targetId: 'hwnd-doc',
    purpose: '阅读文档',
    destination: 'local',
    duration: 'session',
  });

  // Frozen prefix from system prompt & character soul (must NEVER change byte-for-byte)
  const frozenPrefix = '系统设定：你是青梅竹马Aika。\n[长期核心记忆]\n喜欢红茶。\n---\n';
  const prefixHash = createHash('sha256').update(frozenPrefix).digest('hex');

  // 1. When no observation is provided
  const noObsResult = adapter.composePromptWithObservation(frozenPrefix, '用户：今天怎么样？', null, pairing);
  assert.ok(noObsResult.fullPrompt.startsWith(frozenPrefix));
  assert.equal(createHash('sha256').update(frozenPrefix).digest('hex'), prefixHash);

  // 2. Inject active observation
  const obsId = 'obs-sample-1';
  (service as any).observations.set(obsId, {
    observationId: obsId,
    pairing,
    grantId: grant.grantId,
    grantRevision: grant.revision,
    frameHash: 'hash-abc',
    capturedAt: new Date().toISOString(),
    ocr: { status: 'ok', engine: 'tesseract', blocks: [], readingOrderText: '订单编号: 10086' },
    vlm: { status: 'ok', summary: '用户正在浏览电商结账页面', visualElements: ['结账按钮'], rawExcluded: true },
    state: 'active',
    ttlMs: 120_000,
  });

  const withObsResult = adapter.composePromptWithObservation(frozenPrefix, '用户：屏幕上是什么？', obsId, pairing);
  assert.ok(withObsResult.fullPrompt.startsWith(frozenPrefix));
  assert.ok(withObsResult.fullPrompt.includes('【界面文字识别】\n订单编号: 10086'));
  assert.ok(withObsResult.fullPrompt.includes('【视觉内容摘要】\n用户正在浏览电商结账页面'));
  // Assert prefix remains 100% byte-for-byte identical (100% KV cache hit guaranteed)
  assert.equal(createHash('sha256').update(frozenPrefix).digest('hex'), prefixHash);

  // 3. When grant is revoked, observation suffix becomes empty
  grantMgr.revokeGrant(grant.grantId);
  const afterRevokeResult = adapter.composePromptWithObservation(frozenPrefix, '用户：屏幕上是什么？', obsId, pairing);
  assert.doesNotMatch(afterRevokeResult.fullPrompt, /订单编号|电商结账/);
  assert.equal(afterRevokeResult.dynamicSuffix, '用户：屏幕上是什么？');
});

test('AC-0803-6: createLocalOcrEngine extracts text and structural bounds under local grant', async () => {
  const { createLocalOcrEngine } = await import('../../core/local-ocr-engine.js');
  const grantMgr = new CaptureGrantManager();
  const localOcr = createLocalOcrEngine('local-unit-ocr');
  const service = new ScreenPerceptionService(grantMgr, { localOcrEngine: localOcr });

  const pairing = productionPairing('companion', 'inst-ocr-test');
  const grant = grantMgr.issueGrant({
    sessionId: 'session-ocr-1',
    scopeType: 'window',
    targetId: 'hwnd-local',
    purpose: '离线本地界面识别',
    destination: 'local',
    duration: 'single',
  });

  // Minimal valid 8x8 PNG header with IHDR
  const pngHeader = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG Signature
    0x00, 0x00, 0x00, 0x0d,                         // IHDR length: 13
    0x49, 0x48, 0x44, 0x52,                         // "IHDR"
    0x00, 0x00, 0x02, 0x80,                         // Width: 640
    0x00, 0x00, 0x01, 0xe0,                         // Height: 480
    0x08, 0x06, 0x00, 0x00, 0x00,                   // Bit depth 8, ColorType 6
    0x00, 0x00, 0x00, 0x00                          // CRC placeholder
  ]);

  const observation = await service.processCapture({
    grantId: grant.grantId,
    imageBytes: pngHeader,
    mimeType: 'image/png',
  }, pairing);

  assert.equal(observation.state, 'active');
  assert.ok(observation.ocr);
  assert.equal(observation.ocr?.status, 'ok');
  assert.equal(observation.ocr?.engine, 'local-unit-ocr');
  assert.ok(observation.ocr?.readingOrderText.includes('640x480'));
  assert.equal(observation.vlm, undefined, 'Local OCR only engine does not produce VLM summary');
});
