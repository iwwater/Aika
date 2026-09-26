/**
 * tests/next082/screen-capture-ocr.test.ts
 *
 * N082-05: 真实可信屏幕目标捕获与本地原生像素 OCR 引擎测试。
 *
 * AC-08205-1: 真实像素 OCR 引擎：空白无字图真实返回空文本、严禁伪造尺寸描述占位符
 * AC-08205-2: 屏幕捕获目标边界校验、像素上限防御、持续感知授权绑定与解绑
 * AC-08205-3: 识别结果按空间几何坐标稳定排布阅读顺序，缓存按内容摘要命中
 * AC-08205-4: 取消信号 (signal) 中止 OCR 处理，损坏字节安全返回 failed
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenCaptureSource, type ScreenTarget } from '../../core/screen-capture-source.js';
import { createLocalOcrEngine } from '../../core/local-ocr-engine.js';
import type { ContinuousPerceptionGrant } from '../../contracts/companion-mode.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08205');

function fakeContinuousGrant(): ContinuousPerceptionGrant {
  return {
    schemaVersion: 1,
    grantId: 'grant-cont-ocr',
    revision: 1,
    pairing,
    targetId: 'screen-primary',
    targetRevision: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    runtimeSessionId: 'sess-ocr',
    minPollIntervalMs: 5000,
    expiry: new Date(Date.now() + 3600_000).toISOString(),
    destination: 'local',
    state: 'active',
  };
}

test('CR-02: without a pixel OCR adapter, image metadata cannot be reported as recognized text', async () => {
  const engine = createLocalOcrEngine('test-native-engine');

  // 1. 构造一个标准的纯白色位图（无任何 tEXt / iTXt 元数据）
  const blankPng = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR len & tag
    0x00, 0x00, 0x01, 0x90, 0x00, 0x00, 0x00, 0xc8, // 400 x 200
    0x08, 0x02, 0x00, 0x00, 0x00, 0x4b, 0x6d, 0x29, 0xdc,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  const res = await engine(blankPng);
  assert.equal(res.status, 'failed');
  assert.equal(res.blocks.length, 0, '空白图片不得识别出伪造文本块');
  assert.equal(res.readingOrderText, '', '空白图片的阅读文本必须为空');
  assert.equal(res.readingOrderText.includes('本地屏幕图像'), false, '绝对严禁输出尺寸占位符！');
});

test('CR-02: screen capture requires a real adapter and a matching continuous grant', async () => {
  const source = new ScreenCaptureSource({
    maxPixels: 2_073_600, // 1920x1080 上限
  });

  const validTarget: ScreenTarget = {
    targetId: 'screen-primary',
    targetRevision: 1,
    kind: 'screen',
    displayName: '主显示器',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    isValid: true,
  };

  // 1. 未绑定持续感知授权前：禁止捕获
  await assert.rejects(
    async () => source.capture(validTarget),
    /capture_source_not_active/,
  );

  // 2. 绑定持续授权
  await source.attachContinuousGrant(fakeContinuousGrant());

  // A production source without a capture adapter must fail closed.
  await assert.rejects(source.capture(validTarget), /capture_unavailable/);
  await assert.rejects(source.capture({ ...validTarget, targetRevision: 2 }), /target_invalid/);

  // 4. 目标无效（已关闭的窗口或超出最大像素的区域）：必须拒绝
  const invalidTarget: ScreenTarget = {
    ...validTarget,
    isValid: false, // 目标窗口已关闭
  };
  await assert.rejects(
    async () => source.capture(invalidTarget),
    /target_invalid/,
  );

  const oversizedTarget: ScreenTarget = {
    ...validTarget,
    bounds: { x: 0, y: 0, width: 3840, height: 2160 }, // 4K 超过 2073600 限制
  };
  await assert.rejects(
    async () => source.capture(oversizedTarget),
    /target_invalid/,
  );

  // 5. 解绑授权后：立即停止
  source.detachGrant();
  await assert.rejects(
    async () => source.capture(validTarget),
    /capture_source_not_active/,
  );
});

test('AC-08205-3: 识别结果按空间几何坐标稳定排布阅读顺序，缓存按内容摘要命中', async () => {
  const engine = createLocalOcrEngine({
    engineName: 'pixel-sorter-engine',
    recognizePixelHook: async () => {
      // 故意返回乱序坐标的文本块
      return [
        { text: '第二行内容', confidence: 0.96, bounds: { x: 10, y: 50, width: 100, height: 20 } },
        { text: '第一行右侧', confidence: 0.95, bounds: { x: 150, y: 10, width: 80, height: 20 } },
        { text: '第一行左侧', confidence: 0.98, bounds: { x: 10, y: 10, width: 80, height: 20 } },
      ];
    },
  });

  const dummyImage = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const res = await engine(dummyImage);

  assert.equal(res.status, 'ok');
  assert.equal(res.blocks.length, 3);
  // 阅读顺序：第一行左侧 -> 第一行右侧 -> 第二行内容
  assert.equal(res.blocks[0]!.text, '第一行左侧');
  assert.equal(res.blocks[1]!.text, '第一行右侧');
  assert.equal(res.blocks[2]!.text, '第二行内容');
  assert.equal(res.readingOrderText, '第一行左侧\n第一行右侧\n第二行内容');

  // 二次调用：从缓存直接返回
  const cached = await engine(dummyImage);
  assert.equal(cached, res, '完全相同图片必须命中内存缓存');
});

test('AC-08205-4: 取消信号 (signal) 中止 OCR 处理，损坏字节安全返回 failed', async () => {
  const engine = createLocalOcrEngine();

  // 1. 取消信号测试
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    async () => engine(new Uint8Array([1, 2, 3]), controller.signal),
    (err: unknown) => (err as Error).name === 'AbortError',
  );

  // 2. 空字节流测试
  const emptyRes = await engine(new Uint8Array(0));
  assert.equal(emptyRes.status, 'failed');
});
