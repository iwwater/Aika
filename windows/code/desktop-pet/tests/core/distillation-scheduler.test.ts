import test from 'node:test';
import assert from 'node:assert/strict';
import { DistillationScheduler } from '../../core/distillation-scheduler.js';

test('N075-01 R4: DistillationScheduler enforces raw transcript immediate write', () => {
  const scheduler = new DistillationScheduler();
  const decision = scheduler.evaluateTranscript();
  assert.equal(decision.urgency, 'immediate_transcript');
  assert.equal(decision.immediateActionRequired, true);
  assert.equal(decision.shouldQueueBackgroundWork, false);
});

test('N075-01 R4: DistillationScheduler enforces privacy requests ALWAYS immediate, even in batched mode', () => {
  // Test in both per-turn and batched mode
  const perTurnScheduler = new DistillationScheduler({ mode: 'per_turn' });
  const batchedScheduler = new DistillationScheduler({ mode: 'batched', batchThreshold: 10 });

  for (const s of [perTurnScheduler, batchedScheduler]) {
    for (const req of ['correction', 'forget', 'uncertain'] as const) {
      const decision = s.evaluateForegroundRequest(req);
      assert.equal(decision.urgency, 'immediate_privacy', `${req} must have immediate_privacy urgency`);
      assert.equal(decision.immediateActionRequired, true, `${req} must require immediate action`);
      assert.equal(decision.shouldQueueBackgroundWork, true, `${req} must queue background work`);
    }
  }
});

test('N075-01 R4: DistillationScheduler handles ordinary additive memory per-turn by default', () => {
  const scheduler = new DistillationScheduler(); // default per_turn
  for (let i = 0; i < 3; i++) {
    const decision = scheduler.evaluateForegroundRequest('none');
    assert.equal(decision.urgency, 'background_distillation');
    assert.equal(decision.immediateActionRequired, false, 'Ordinary memory must not block foreground');
    assert.equal(decision.shouldQueueBackgroundWork, true, 'Default per-turn queues each turn');
  }
});

test('N075-01 R4: DistillationScheduler supports batching mode for ordinary additive memory', () => {
  const scheduler = new DistillationScheduler({ mode: 'batched', batchThreshold: 3 });

  // Turns 1 and 2: accumulating, should not queue
  const d1 = scheduler.evaluateForegroundRequest('none');
  assert.equal(d1.shouldQueueBackgroundWork, false);
  const d2 = scheduler.evaluateForegroundRequest('none');
  assert.equal(d2.shouldQueueBackgroundWork, false);

  // Turn 3: reaches threshold 3, queues background work
  const d3 = scheduler.evaluateForegroundRequest('none');
  assert.equal(d3.shouldQueueBackgroundWork, true);

  // Interleaved forget request: IMMMEDIATELY triggers privacy action regardless of counter!
  const dForget = scheduler.evaluateForegroundRequest('forget');
  assert.equal(dForget.urgency, 'immediate_privacy');
  assert.equal(dForget.immediateActionRequired, true);
});

test('N075-01 R4: DistillationScheduler evaluates summary threshold', () => {
  const scheduler = new DistillationScheduler();
  const belowThreshold = scheduler.evaluateSummary(5, 10);
  assert.equal(belowThreshold.urgency, 'threshold_summary');
  assert.equal(belowThreshold.shouldQueueBackgroundWork, false);

  const atThreshold = scheduler.evaluateSummary(10, 10);
  assert.equal(atThreshold.shouldQueueBackgroundWork, true);

  const aboveThreshold = scheduler.evaluateSummary(15, 10);
  assert.equal(aboveThreshold.shouldQueueBackgroundWork, true);
});
