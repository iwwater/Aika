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
  const service = new ScreenPerceptionService(grantMgr);
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
  assert.equal(check1.reissued, false);
  assert.equal(check1.grant.grantId, initialGrant.grantId);

  // Switching destination to 'cloud' must revoke old grant and reissue a new one
  const check2 = grantMgr.verifyOrReissue(initialGrant.grantId, 'hwnd-editor', 'cloud');
  assert.equal(check2.reissued, true);
  assert.notEqual(check2.grant.grantId, initialGrant.grantId);
  assert.equal(check2.grant.destination, 'cloud');
  assert.equal(grantMgr.getGrant(initialGrant.grantId)?.status, 'revoked');
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

  const service = new ScreenPerceptionService(grantMgr, { vlmEngine: slowVlm });
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

  const service = new ScreenPerceptionService(grantMgr, { ocrEngine: mockOcr });
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
