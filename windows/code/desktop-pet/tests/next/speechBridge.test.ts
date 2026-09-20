// NEXT-06: speech input/output thin adapters and the voice turn bridge over production ports.
// Providers and playback are fakes; the bridge, ordering, interruption and bounded retry are the subject.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { MediaAsset, PlaybackPort, TtsProvider, TtsResult, TurnScope } from '../../contracts/index.js';
import { deferred, tick, nextScope, offlinePorts } from './harness.js';
import { NextTurnPort } from '../../core/turn-port.js';
import { NextSpeechInput, NextSpeechOutput, VoiceTurnBridge, splitSentences } from '../../core/speech-bridge.js';
import { AikaTimelineRecorder, AikaTimelineStore } from '../../management/aika-timeline.js';

const NOW = '2026-09-19T00:00:00.000Z';

function segment(index: number, text: string, segmentId = `seg-${index}`) {
  return { inputSessionId: 'asr-1', segmentId, index, text, audioEndMs: (index + 1) * 1000, timeSource: 'audio' as const };
}

function ttsDouble(delays: Map<string, ReturnType<typeof deferred<void>>> = new Map(), failures: Set<string> = new Set()) {
  const calls: string[] = [];
  const provider: TtsProvider = {
    synthesize: async input => {
      calls.push(input.text);
      const gate = delays.get(input.text);
      if (gate) await gate.promise;
      if (failures.has(input.text)) throw new Error('tts unavailable');
      const audio: MediaAsset = { id: `a-${calls.length}`, uri: 'mem://audio', mimeType: 'audio/wav', temporary: true };
      const result: TtsResult = { scope: input.scope, audio, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null }, durationMs: 100, synchronization: 'none' };
      return result;
    }
  };
  return { provider };
}

function playbackDouble(hangUntilStop = false) {
  const started: number[] = [];
  const stopped: TurnScope[] = [];
  const emits: ((event: import('../../contracts/index.js').PlaybackEvent) => void)[] = [];
  const hung: (() => void)[] = [];
  let failNext = false;
  const playback: PlaybackPort = {
    play: async (input, emit) => {
      emits.push(emit);
      started.push(started.length + 1);
      emit({ scope: input.scope, at: NOW, type: 'started', audioId: input.audio.id });
      if (failNext) { failNext = false; emit({ scope: input.scope, at: NOW, type: 'error', message: 'device gone' }); throw new Error('playback failed'); }
      if (hangUntilStop) await new Promise<void>(done => { hung.push(done); });
      emit({ scope: input.scope, at: NOW, type: 'ended' });
    },
    stop: async scope => {
      stopped.push(scope);
      for (const done of hung.splice(0)) done();
    }
  };
  return { playback, started, stopped, emits, setFailNext: () => { failNext = true; } };
}

test('06-A input segments merge by index, dedup by id, skip empties; turnReady submits exactly once', async () => {
  const submissions: string[] = [];
  const readies: string[] = [];
  const input = new NextSpeechInput(async text => { submissions.push(text); return nextScope('t1'); }, { onTurnReady: (_scope, text) => readies.push(text) });

  input.feed(segment(2, '世界'));
  input.feed(segment(0, '你好，'));
  input.feed(segment(1, '', 'seg-1-empty'));
  input.feed(segment(0, '你好，', 'seg-0')); // identical segmentId → dedup keeps the first
  input.feed(segment(1, '，', 'seg-1-comma'));
  await input.stop();
  await input.stop();

  assert.deepEqual(submissions, ['你好，，世界'], 'merged in audio order, empties skipped, stop is idempotent');
  assert.equal(readies.length, 1, 'turnReady fires exactly once');
});

test('06-A late segments after stop do not resubmit; a new input session can submit again', async () => {
  const submissions: string[] = [];
  const input = new NextSpeechInput(async text => { submissions.push(text); return nextScope('t1'); });
  input.feed(segment(0, '第一句'));
  await input.stop();
  input.feed(segment(1, '迟到'));
  await input.stop();
  assert.deepEqual(submissions, ['第一句']);

  input.startNewInput();
  input.feed(segment(0, '第二句'));
  await input.stop();
  assert.deepEqual(submissions, ['第一句', '第二句']);
});

test('06-A an all-empty input never submits', async () => {
  const submissions: string[] = [];
  const input = new NextSpeechInput(async text => { submissions.push(text); return nextScope('t1'); });
  input.feed(segment(0, '  '));
  input.feed(segment(1, ''));
  await input.stop();
  assert.deepEqual(submissions, []);
});

test('06-B sentences play in order despite out-of-order synthesis; tail is kept; endTurn drains once', async () => {
  const firstGate = deferred<void>();
  const delays = new Map([['第一句。', firstGate]]);
  const { provider } = ttsDouble(delays);
  const { playback } = playbackDouble();
  const startedSentences: string[] = [];
  const drained: { delivered: number; failed: number }[] = [];
  const output = new NextSpeechOutput(provider, playback, {
    onStarted: (_scope, sentenceId) => startedSentences.push(sentenceId),
    onDrained: (_scope, summary) => drained.push(summary)
  });
  const scope = nextScope('t1');

  output.enqueue({ scope, sentenceId: 's1', text: '第一句。' });
  output.enqueue({ scope, sentenceId: 's2', text: '第二句。' });
  await tick();
  // s2 synthesized while s1 is still gated; playback must still start with s1.
  firstGate.resolve();
  await tick();
  await tick();
  output.endTurn(scope);
  await output.drain();
  assert.deepEqual(startedSentences, ['s1', 's2'], 'sentence order preserved');
  assert.deepEqual(drained, [{ delivered: 2, failed: 0 }], 'drained exactly once with delivery counts');
});

test('06-B endTurn without pending speech drains immediately and only once', async () => {
  const { provider } = ttsDouble();
  const { playback } = playbackDouble();
  const drained: unknown[] = [];
  const output = new NextSpeechOutput(provider, playback, { onDrained: (_scope, summary) => drained.push(summary) });
  const scope = nextScope('t1');
  output.endTurn(scope);
  await output.drain();
  assert.equal(drained.length, 1);
  output.endTurn(scope);
  await output.drain();
  assert.equal(drained.length, 1, 'endTurn is idempotent');
});

test('06-C interrupt cancels the in-flight turn and stops audio; late callbacks revive nothing; new input survives', async () => {
  const { provider } = ttsDouble();
  const pb = playbackDouble(true); // playback hangs until stop()
  const gate = deferred<void>();
  let firstReply = true;
  const turnPort = new NextTurnPort(offlinePorts(async request => {
    if (firstReply) { firstReply = false; await gate.promise; }
    return { scope: request.scope, text: '第一句。第二句。', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
  }));
  const cancelled: unknown[] = [];
  turnPort.subscribe(event => { if (event.type === 'terminal' && event.status === 'cancelled') cancelled.push(event); });
  const stoppedScopes: TurnScope[] = [];
  const output = new NextSpeechOutput(provider, pb.playback, {
    onStopped: scope => stoppedScopes.push(scope)
  });
  const bridge = new VoiceTurnBridge(turnPort, output, { dialogueSentences: true });

  const firstScope = await bridge.submitText('第一轮');
  await tick();
  // The turn is still generating (reply gated): interrupting aborts it, so the late reply
  // ends as cancelled instead of speaking.
  bridge.interrupt();
  gate.resolve();
  for (let i = 0; i < 10 && cancelled.length === 0; i++) await tick();
  assert.equal(cancelled.length, 1, 'the in-flight turn is cancelled');
  for (let i = 0; i < 10 && pb.started.length > 0; i++) await tick();
  assert.equal(pb.started.length, 0, 'the cancelled turn produced no audio');

  // The second turn completes; its audio plays (hung) and the next interrupt stops it.
  const secondScope = await bridge.submitText('第二轮');
  for (let i = 0; i < 10 && pb.started.length < 1; i++) await tick();
  assert.equal(pb.started.length, 1, 'first sentence plays; the queued one waits behind the hung playback');
  bridge.interrupt();
  assert.equal(stoppedScopes.length, 1, 'output stopped for the second scope');
  assert.equal(cancelled.length, 1, 'the second turn was already terminal; cancel stayed a no-op');

  // Late audio events for the old scope revive nothing.
  const startedBefore = pb.started.length;
  const stopBefore = stoppedScopes.length;
  pb.emits[0]?.({ scope: firstScope, at: NOW, type: 'ended' });
  await output.drain();
  assert.equal(pb.started.length, startedBefore, 'no playback restarts from stale callbacks');
  assert.equal(stoppedScopes.length, stopBefore, 'no second stop event from stale callbacks');

  // A new input is not cleared by the interruption.
  const thirdScope = await bridge.submitText('第三轮');
  assert.notEqual(thirdScope.turnId, secondScope.turnId);
  for (let i = 0; i < 10 && pb.started.length < 4; i++) await tick();
  bridge.interrupt();
  assert.equal(stoppedScopes.length, 2);
});
test('06-D synthesis failure is visible per sentence; drained reports failures, never claims full delivery', async () => {
  const failures = new Set(['第二句。']);
  const { provider } = ttsDouble(new Map(), failures);
  const { playback } = playbackDouble();
  const scope = nextScope('t1');
  const errors: string[] = [];
  const drained: { delivered: number; failed: number }[] = [];
  const output = new NextSpeechOutput(provider, playback, {
    onError: (_scope, sentenceId, error) => errors.push(`${sentenceId}:${String(error)}`),
    onDrained: (_scope, summary) => drained.push(summary)
  });
  output.enqueue({ scope, sentenceId: 's1', text: '第一句。' });
  output.enqueue({ scope, sentenceId: 's2', text: '第二句。' });
  output.endTurn(scope);
  await output.drain();
  assert.equal(errors.length, 1, 'synthesis failure surfaced');
  assert.deepEqual(drained, [{ delivered: 1, failed: 1 }], 'drained distinguishes delivered from failed');
});

test('06-D playback failure surfaces as an error and the sentence counts as failed', async () => {
  const { provider } = ttsDouble();
  const pb = playbackDouble();
  pb.setFailNext();
  const scope = nextScope('t1');
  const errors: string[] = [];
  const drained: { delivered: number; failed: number }[] = [];
  const output = new NextSpeechOutput(provider, pb.playback, {
    onError: (_scope, sentenceId, error) => errors.push(`${sentenceId ?? ''}:${String(error)}`),
    onDrained: (_scope, summary) => drained.push(summary)
  });
  output.enqueue({ scope, sentenceId: 's1', text: '只有一句。' });
  output.endTurn(scope);
  await output.drain();
  assert.equal(errors.length, 1);
  assert.deepEqual(drained, [{ delivered: 0, failed: 1 }]);
});

test('06-G voice bridge end-to-end: text → turn → sentences → audio → timeline, generation vs delivery separated', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-voice-'));
  const store = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  const turnPort = new NextTurnPort(offlinePorts(async request => ({ scope: request.scope, text: `关于${request.text}的回答。第二句。`, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } })));
  const recorder = new AikaTimelineRecorder(turnPort, store);
  const stopRecording = recorder.start();
  t.after(async () => { stopRecording(); store.close(); await rm(dir, { recursive: true, force: true }); });

  const { provider } = ttsDouble();
  const pb = playbackDouble();
  const sequence: string[] = [];
  turnPort.subscribe(event => { if (event.type === 'terminal') sequence.push(`terminal:${event.status}`); });
  const output = new NextSpeechOutput(provider, pb.playback, {
    onDrained: (_scope, summary) => sequence.push(`drained:${summary.delivered}`)
  });
  const bridge = new VoiceTurnBridge(turnPort, output, { dialogueSentences: true });

  const scope = await bridge.submitText('天气');
  await new Promise<void>(done => {
    const unsubscribe = turnPort.subscribe(event => { if (event.type === 'terminal') { unsubscribe(); done(); } });
  });
  for (let i = 0; i < 20 && !sequence.some(item => item.startsWith('drained:')); i++) await tick();
  await output.drain();
  const terminalAt = sequence.indexOf('terminal:completed');
  const drainedAt = sequence.findIndex(item => item.startsWith('drained:'));
  assert.ok(terminalAt >= 0 && drainedAt > terminalAt, `generation terminal precedes delivery drained: ${JSON.stringify(sequence)}`);
  assert.equal(pb.started.length, 2, 'two sentences audibly started');

  const page = await store.list({ sessionId: scope.sessionId, limit: 10 });
  assert.deepEqual(page.items.map(item => item.kind), ['userMessage', 'assistantTerminal'], 'voice turn recorded in the timeline');
  assert.equal(page.items[0]!.text, '天气');
});

test('splitSentences keeps the tail and drops nothing', () => {
  assert.deepEqual(splitSentences('第一句。第二句！第三句没有标点'), ['第一句。', '第二句！', '第三句没有标点']);
  assert.deepEqual(splitSentences(''), []);
});
