// Characterization of upstream DialoguePipeline against fake dependency ports: terminal states, stale-turn isolation, cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CapturedInput, TurnScope } from '../../contracts/index.js';
import { DialoguePipeline } from '../../core/dialogue-pipeline.js';
import { TurnController } from '../../core/turn-controller.js';
import { baseContext, deferred, fakePorts, okPerception, tick } from './harness.js';
import type { ReplyPlan } from './harness.js';

const capturedFor = (scope: TurnScope): CapturedInput =>
  ({ scope, audio: { id: 'a', uri: 'mem://a', mimeType: 'audio/wav', temporary: true }, images: [], inputEndedAt: '2026-09-19T00:00:00.000Z', captureStoppedAt: '2026-09-19T00:00:00.000Z' });

test('text turn reaches replied with both sides persisted and media released', async () => {
  const controller = new TurnController();
  const fake = fakePorts({ outputMode: 'text' });
  const pipeline = new DialoguePipeline(fake.ports, controller, event => fake.events.push(event));
  const { input } = controller.begin('text', '今天好吗');

  const outcome = await pipeline.run(input, new AbortController().signal);
  assert.deepEqual(outcome, { status: 'replied' });
  assert.equal(fake.appended.length, 2, 'user and assistant messages are appended exactly once each');
  assert.deepEqual(fake.appended[0]!.roles, ['user']);
  assert.equal(fake.appended[0]!.texts[0], '今天好吗');
  assert.deepEqual(fake.appended[1]!.roles, ['assistant']);
  assert.equal(fake.appended[1]!.texts[0], '我在。');
  assert.equal(fake.appended[0]!.scope.turnId, fake.appended[1]!.scope.turnId, 'both records share the turn scope');
  assert.equal(fake.replyCalls.length, 1);
  assert.equal(fake.contextCalls.length, 1, 'context is requested exactly once per turn');
  assert.equal(fake.replyCalls[0]!.context, fake.contexts[0], 'the provider receives exactly the context object the memory port produced');
  assert.deepEqual(fake.callOrder, ['append:user', 'context', 'append:assistant'], 'user is persisted before the provider call; assistant is persisted after the reply');
  assert.deepEqual(fake.released, [input.scope.turnId], 'releaseScope runs even on success');
  assert.ok(fake.events.some(e => e.type === 'reply'));
});

test('a newer submission cancels the older in-flight turn: late provider reply cannot write or reply', async () => {
  const controller = new TurnController();
  const plans = new Map<string, ReplyPlan>();
  const gate = deferred<void>();
  const fake = fakePorts({ outputMode: 'text', plans });
  const pipeline = new DialoguePipeline(fake.ports, controller, event => fake.events.push(event));

  const first = controller.begin('text', '第一条');
  const oldTurnId = first.input.scope.turnId;
  plans.set(oldTurnId, { gate, text: '迟到的回复' });
  const running = pipeline.run(first.input, first.signal);
  await tick();

  const second = controller.begin('text', '第二条');
  const newTurnId = second.input.scope.turnId;
  const secondOutcome = await pipeline.run(second.input, second.signal);
  assert.equal(secondOutcome.status, 'replied');

  gate.resolve();
  const firstOutcome = await running;
  assert.equal(firstOutcome.status, 'cancelled', 'stale turn must end as cancelled, not failed or replied');
  const oldAppends = fake.appended.filter(a => a.scope.turnId === oldTurnId);
  assert.deepEqual(oldAppends.map(a => a.roles), [['user']], 'cancelled old turn must not write its assistant reply');
  const lateReply = fake.events.some(e => e.type === 'reply' && (e as { reply: { scope: TurnScope } }).reply.scope.turnId === oldTurnId);
  assert.ok(!lateReply, 'no reply event escapes for the cancelled turn');
  assert.deepEqual(fake.released.sort(), [oldTurnId, newTurnId].sort(), 'every turn releases its media scope');
});

test('provider failure surfaces as failed with a visible error and still releases media', async () => {
  const controller = new TurnController();
  const plans = new Map<string, ReplyPlan>();
  const fake = fakePorts({ outputMode: 'text', plans });
  const pipeline = new DialoguePipeline(fake.ports, controller, event => fake.events.push(event));
  const { input } = controller.begin('text', '触发故障');
  plans.set(input.scope.turnId, { failure: new Error('provider unreachable') });

  const outcome = await pipeline.run(input, new AbortController().signal);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error ?? '', /provider unreachable/);
  assert.ok(fake.events.some(e => e.type === 'error'), 'error is emitted for the UI');
  assert.deepEqual(fake.released, [input.scope.turnId]);
  assert.deepEqual(fake.appended.map(a => a.roles), [['user']], 'assistant side is not written when the provider fails');
});

test('voice turn without captured audio is rejected; text turn must not carry capture', async () => {
  const controller = new TurnController();
  const fake = fakePorts({ outputMode: 'voice' });
  const pipeline = new DialoguePipeline(fake.ports, controller, event => fake.events.push(event));

  const voice = controller.begin('voice');
  const voiceOutcome = await pipeline.run(voice.input, voice.signal);
  assert.equal(voiceOutcome.status, 'failed');
  assert.match(voiceOutcome.error ?? '', /requires captured audio/);

  const text = controller.begin('text', '文字却带了录音');
  const textOutcome = await pipeline.run(text.input, text.signal, capturedFor(text.input.scope));
  assert.equal(textOutcome.status, 'failed');
  assert.match(textOutcome.error ?? '', /must not receive/);
});

test('perception failure fails the voice turn with a user-facing message', async () => {
  const controller = new TurnController();
  const fake = fakePorts({ outputMode: 'voice', perception: async input => ({ ...okPerception(input.scope, ''), status: 'failed' }) });
  const pipeline = new DialoguePipeline(fake.ports, controller, event => fake.events.push(event));
  const { input } = controller.begin('voice');

  const outcome = await pipeline.run(input, new AbortController().signal, capturedFor(input.scope));
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error ?? '', /Perception failed/);
});

test('playback events from a foreign scope are ignored; a stop event cancels the turn', async () => {
  const controller = new TurnController();
  const fake = fakePorts({ outputMode: 'voice' });
  const pipeline = new DialoguePipeline(fake.ports, controller, event => fake.events.push(event));
  const { input, signal } = controller.begin('voice');
  const running = pipeline.run(input, signal, capturedFor(input.scope));
  while (fake.playbackHandles.length === 0) await tick();
  const emit = fake.playbackHandles[0]!.emit;
  const foreign: TurnScope = { ...input.scope, turnId: 'foreign' };

  emit({ scope: foreign, at: '2026-09-19T00:00:00.000Z', type: 'started', audioId: 'a' });
  emit({ scope: foreign, at: '2026-09-19T00:00:00.000Z', type: 'ended' });
  emit({ scope: input.scope, at: '2026-09-19T00:00:00.000Z', type: 'started', audioId: 'a' });
  emit({ scope: input.scope, at: '2026-09-19T00:00:00.000Z', type: 'amplitude', value: 0.4 });
  emit({ scope: input.scope, at: '2026-09-19T00:00:00.000Z', type: 'stopped' });
  fake.playbackGate.resolve();

  const outcome = await running;
  assert.equal(outcome.status, 'cancelled', 'explicit stop is a cancellation, not a failure');
  const playbackEvents = fake.events.filter(e => e.type === 'playback');
  assert.ok(playbackEvents.length > 0);
  for (const event of playbackEvents) assert.notEqual((event as { playback: { scope: TurnScope } }).playback.scope.turnId, 'foreign', 'foreign-scope playback must never reach the UI stream');
  assert.deepEqual(fake.released, [input.scope.turnId], 'media release still runs after cancellation');
});

test('context containing another character is refused before the provider sees it', async () => {
  const controller = new TurnController();
  const fake = fakePorts({
    outputMode: 'text',
    context: scope => {
      const context = baseContext(scope, [{ id: 'm1', role: 'user', text: '外来消息' }]);
      const recent = context.recent.map(m => ({ ...m, characterId: 'intruder' }));
      return { ...context, recent };
    }
  });
  const pipeline = new DialoguePipeline(fake.ports, controller, event => fake.events.push(event));
  const { input } = controller.begin('text', '上下文污染');

  const outcome = await pipeline.run(input, new AbortController().signal);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error ?? '', /another character/);
  assert.equal(fake.replyCalls.length, 0, 'provider never receives a cross-character context');
  assert.deepEqual(fake.released, [input.scope.turnId]);
});
