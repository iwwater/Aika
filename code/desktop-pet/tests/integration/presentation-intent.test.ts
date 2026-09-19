import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePresentationIntent } from '../../contracts/presentation.js';

test('frozen actual smoke02 expression reaches supported visual intent without changing delivery', () => {
  // Actual retained response, local-trial-smoke-20260909-02; this replay makes no model call.
  const expression = { emotion: '欣赏', intensity: .7, delivery: '语调轻快带笑意，略带一点小崇拜', gesture: null };
  const result = normalizePresentationIntent(expression);
  assert.deepEqual(result, { ...expression, emotion: 'happy' });
  assert.equal(expression.emotion, '欣赏');
});

test('safe gestures and multilingual faces normalize while unsupported labels stay neutral', () => {
  for (const [gesture, expected] of [['比心','heart'],['hand_on_chest','comfort'],['手捧星','hold_star'],['nod','lean']] as const) {
    assert.deepEqual(normalizePresentationIntent({ emotion: 'tender', intensity: .5, delivery: '温柔', gesture }),
      { emotion: 'warm', intensity: .5, delivery: '温柔', gesture: expected });
  }
  for (const value of ['飞头', '__proto__', 'constructor', 'toString']) {
    assert.deepEqual(normalizePresentationIntent({ emotion: value, intensity: NaN, delivery: '完整发声要求', gesture: value }),
      { emotion: 'neutral', intensity: 0, delivery: '完整发声要求', gesture: null });
  }
});
