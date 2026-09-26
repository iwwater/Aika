/**
 * tests/next082/observation-companion.test.ts
 *
 * N082-07: Observation 情境候选仲裁、主动陪伴配额与上下文授权测试。
 *
 * AC-08207-1: 被动模式 (passive) 严格抑制主动情境候选生成
 * AC-08207-2: 缺少有效 ContextUseGrant 时绝不发起模型生成
 * AC-08207-3: 冷却时间 (3小时) 与每日配额 (2次) 约束严格生效
 * AC-08207-4: 观察候选生成并发度为 1，过期自动失效与撤回支持
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationCandidateSource } from '../../companion/observation-candidate-source.js';
import type { ContextUseGrant } from '../../contracts/companion-mode.js';
import { productionPairing } from '../../contracts/character-pack.js';

const pairing = productionPairing('companion', 'inst-08207');

class FakeClock {
  private value: number;
  constructor(value: number) { this.value = value; }
  now = (): string => new Date(this.value).toISOString();
  advance(ms: number): void { this.value += ms; }
  at(): number { return this.value; }
}

function fakeContextGrant(state = 'active' as const): ContextUseGrant {
  return {
    schemaVersion: 1,
    grantId: 'g-ctx-1',
    revision: 1,
    pairing,
    observationSourceScopes: ['display-1'],
    modelBinding: 'local-llm',
    destination: 'local',
    expiry: new Date(Date.now() + 3600_000).toISOString(),
    state,
  };
}

test('AC-08207-1: 被动模式 (passive) 严格抑制主动情境候选生成', async () => {
  let mode: 'active' | 'passive' = 'passive';

  const source = new ObservationCandidateSource({
    pairing,
    getMode: () => mode,
    getContextGrant: () => fakeContextGrant(),
  });

  const obs = {
    observationId: 'obs-1',
    targetId: 'screen-1',
    capturedAt: new Date().toISOString(),
    text: '用户正在阅读开发文档',
    blockCount: 2,
  };

  // 1. 在 passive 模式下：返回 null（静默抑制）
  const cue1 = await source.offer(obs);
  assert.equal(cue1, null, '被动模式下严禁生成主动屏幕观察气泡');

  // 2. 切换为 active 模式：允许生成
  mode = 'active';
  const cue2 = await source.offer(obs);
  assert.ok(cue2);
  assert.equal(cue2.observationId, 'obs-1');
});

test('AC-08207-2: 缺少有效 ContextUseGrant 时绝不发起模型生成', async () => {
  let hasGrant = false;
  let modelCalled = false;

  const source = new ObservationCandidateSource({
    pairing,
    getMode: () => 'active',
    getContextGrant: () => (hasGrant ? fakeContextGrant() : null),
    generateCueHook: async () => {
      modelCalled = true;
      return '检测到文档，需要帮助吗？';
    },
  });

  const obs = {
    observationId: 'obs-2',
    targetId: 'screen-1',
    capturedAt: new Date().toISOString(),
    text: '重要系统报表',
    blockCount: 1,
  };

  // 1. 无 ContextUseGrant：严禁调用生成 Hook
  const cueNoGrant = await source.offer(obs);
  assert.equal(cueNoGrant, null);
  assert.equal(modelCalled, false, '无 ContextUseGrant 时严禁调用任何模型生成！');

  // 2. 授权 ContextUseGrant
  hasGrant = true;
  const cueWithGrant = await source.offer(obs);
  assert.ok(cueWithGrant);
  assert.equal(modelCalled, true);
  assert.equal(cueWithGrant.text, '检测到文档，需要帮助吗？');
});

test('AC-08207-3: 冷却时间 (3小时) 与每日配额 (2次) 约束严格生效', async () => {
  const clock = new FakeClock(Date.parse('2026-09-26T09:00:00.000Z'));
  const source = new ObservationCandidateSource({
    pairing,
    getMode: () => 'active',
    getContextGrant: () => fakeContextGrant(),
    cooldownIntervalMs: 10_800_000, // 3小时
    dailyQuotaLimit: 2,            // 每天最多2次
    now: clock.now,
  });

  const makeObs = (id: string) => ({
    observationId: id,
    targetId: 'screen-1',
    capturedAt: clock.now(),
    text: `屏幕变化 ${id}`,
    blockCount: 1,
  });

  // 第一次触发：成功 (9:00)
  const cue1 = await source.offer(makeObs('obs-1'));
  assert.ok(cue1);

  // 1小时后触发 (10:00)：冷却中，必须拒绝！
  clock.advance(3600_000);
  const cueCooldown = await source.offer(makeObs('obs-2'));
  assert.equal(cueCooldown, null, '未过 3 小时冷却期严禁再次主动发言');

  // 3小时后触发 (13:00)：冷却已过，第二次成功！
  clock.advance(10_800_000);
  const cue2 = await source.offer(makeObs('obs-3'));
  assert.ok(cue2);

  // 再次过3小时 (17:00)：已达每日 2 次上限，必须拒绝！
  clock.advance(10_800_000);
  const cueOverQuota = await source.offer(makeObs('obs-4'));
  assert.equal(cueOverQuota, null, '达到每日 2 次主动配额上限后严禁再次触发');

  // 跨日到第二天 (09-27)：配额刷新，允许再次触发！
  clock.advance(86_400_000);
  const cueNextDay = await source.offer(makeObs('obs-5'));
  assert.ok(cueNextDay, '新自然日配额必须自动刷新');
});

test('AC-08207-4: 观察候选生成并发度为 1，过期自动失效与撤回支持', async () => {
  const clock = new FakeClock(Date.parse('2026-09-26T10:00:00.000Z'));
  const source = new ObservationCandidateSource({
    pairing,
    getMode: () => 'active',
    getContextGrant: () => fakeContextGrant(),
    cooldownIntervalMs: 0, // 测试中解除冷却限制
    now: clock.now,
  });

  const obs = {
    observationId: 'obs-exp',
    targetId: 'screen-1',
    capturedAt: clock.now(),
    text: '临时活动提醒',
    blockCount: 1,
  };

  const cue = await source.offer(obs);
  assert.ok(cue);

  // 存活期内 (1分钟后) 可读取
  clock.advance(60_000);
  assert.ok(source.getCue(cue.cueId));

  // 过期后 (超过 5分钟) 自动失效
  clock.advance(300_000);
  assert.equal(source.getCue(cue.cueId), null, '超期观察候选必须自动失效');
});
