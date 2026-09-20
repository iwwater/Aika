// FIX61-08 08-A/08-C/08-E: the production live voice path over real PCM. A long WAV is fed to the
// speech-input session at its true sampling cadence; the recognizer is the production adapter with a
// scripted decoding double *inside the same worker boundary*, and the release submits exactly one
// turn through the existing authoritative NextTurnPort. The last test runs the real local streaming
// model end to end (BLOCKED when the model package is absent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NextSpeechInput } from '../../core/speech-bridge.js';
import { LiveVoiceBridge } from '../../core/live-voice-bridge.js';
import { VoiceInputSession } from '../../media/voice-input-session.js';
import { inspectPcmWav } from '../../media/wav.js';
import { NextTurnPort } from '../../core/turn-port.js';
import { offlinePorts } from '../next/harness.js';
import { deferred } from '../next/harness.js';
import type { StreamingAsrEvent } from '../../providers/sherpa-streaming-asr.js';
import type { TurnScope } from '../../contracts/index.js';

/**
 * A recognizer double with the production adapter's exact event contract. Like the real worker it
 * publishes its final segment from inside finish(), which is exactly the ordering the bridge must
 * tolerate: the release flush produces the last final before finish() resolves.
 */
function recognizerDouble(script: (pushed: number) => string[], finalText: (pushed: number) => string = () => '') {
  const listeners = new Set<(event: StreamingAsrEvent) => void>();
  let scope: TurnScope | undefined;
  let pushed = 0, opened = 0, finished = 0, cancelled = 0;
  let revision = 0, lastPartial = '';
  const publish = (text: string, type: 'partial' | 'final', index: number) => {
    if (!scope) return;
    revision += 1;
    const segment = { inputSessionId: scope.turnId, segmentId: `s${index}`, index, text, audioEndMs: 0, timeSource: 'audio' as const, revision };
    for (const listener of [...listeners]) listener({ scope, type, segment });
  };
  return {
    openStream: async (next: TurnScope) => { scope = next; opened++; },
    push: async (_scope: TurnScope, pcm: Uint8Array) => {
      pushed += pcm.length / 2;
      // The real recognizer emits text only when the live hypothesis changed; the double matches that
      // so a repeated identical partial cannot be mistaken for appended text.
      for (const text of script(pushed)) if (text !== lastPartial) { lastPartial = text; publish(text, 'partial', 0); }
    },
    // A final closes the same segment the partials belonged to, which is what the adapter does.
    finish: async () => { finished++; publish(finalText(pushed), 'final', 0); },
    cancel: async () => { cancelled++; },
    subscribe: (listener: (event: StreamingAsrEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get counters() { return { opened, finished, cancelled, pushed }; },
  };
}

function chain() {
  const submissions: string[] = [];
  const turnPort = new NextTurnPort(offlinePorts(async request => ({ scope: request.scope, text: `回复：${request.text}`,
    expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } })));
  return { turnPort, submissions };
}

test('08-A a long utterance produces a non-empty partial before finish, then exactly one turn', async () => {
  const { turnPort, submissions } = chain();
  const interimLog: { atMs: number; text: string }[] = [];
  let clock = 0;
  const asr = recognizerDouble(pushed => pushed >= 16000 ? ['你好'] : [], () => '你好，世界。');
  const input = new NextSpeechInput(async text => { submissions.push(text); return turnPort.submit({ text }); });
  const bridge = new LiveVoiceBridge({ asr, input, now: () => clock,
    onInterim: (_scope, text) => interimLog.push({ atMs: clock, text }) });
  const scope = { characterId: 'companion' as const, sessionId: 'session-a', turnId: 'turn-live', generation: 1 };
  const frames: { index: number; sampleCount: number }[] = [];
  let outcome: Awaited<ReturnType<LiveVoiceBridge['finish']>> | undefined;
  const session = new VoiceInputSession({ inputSessionId: scope.turnId, generation: 1, sampleRate: 16000,
    sink: { push: async (header, pcm) => { frames.push({ index: header.index, sampleCount: header.sampleCount }); await bridge.push(pcm, header.sampleRate); },
      finish: async header => { void header; outcome = await bridge.finish(scope, new AbortController().signal); } } });

  await bridge.start(scope, 16000);
  // 2.0 s of "speech" fed at the true 2048-sample worklet cadence (~128 ms per flush).
  clock = 0;
  for (let block = 0; block < 16; block++) { await session.push(new Float32Array(2048).fill(0.2)); clock += 128; }
  assert.ok(interimLog.length >= 1, 'a partial arrived while the user was still speaking');
  assert.equal(interimLog[0]!.text, '你好');
  assert.ok(interimLog[0]!.atMs < 2000, 'the first partial is not produced after the utterance ended');
  assert.deepEqual(frames.slice(0, 3).map(frame => frame.index), [0, 1, 2], 'frames are numbered in capture order');
  assert.ok(frames.every(frame => frame.sampleCount === 1600), 'every wire frame is 100 ms');

  // Release flushes the tail; the recognizer publishes its final from inside finish().
  await session.finish();
  assert.deepEqual(outcome, { type: 'finished', transcript: '你好，世界。' }, 'the release yields the verified transcript');
  await input.stop();
  await input.stop();
  assert.deepEqual(submissions, ['你好，世界。'], 'the release submits exactly one turn');
  assert.equal(asr.counters.opened, 1);
  assert.equal(asr.counters.finished, 1);
});

test('08-C cancel drops the partial text and a new input session is independent', async () => {
  const { turnPort, submissions } = chain();
  const asr = recognizerDouble(pushed => pushed >= 1600 ? ['丢弃我'] : []);
  const input = new NextSpeechInput(async text => { submissions.push(text); return turnPort.submit({ text }); });
  const bridge = new LiveVoiceBridge({ asr, input });
  const scope: TurnScope = { characterId: 'companion', sessionId: 'session-a', turnId: 'turn-cancel', generation: 1 };
  await bridge.start(scope, 16000);
  await bridge.push(new Uint8Array(3200), 16000);
  assert.equal(input.liveText(), '丢弃我');
  await bridge.cancel();
  assert.equal(input.liveText(), '', 'cancelled text is discarded');
  assert.equal(asr.counters.cancelled, 1);
  await input.stop();
  assert.deepEqual(submissions, [], 'a cancelled input never submits');
});

test('08-C a stale turn scope is filtered out of the live bridge', async () => {
  const { turnPort, submissions } = chain();
  const asr = recognizerDouble(() => ['迟到的']);
  const input = new NextSpeechInput(async text => { submissions.push(text); return turnPort.submit({ text }); });
  const bridge = new LiveVoiceBridge({ asr, input });
  const scope: TurnScope = { characterId: 'companion', sessionId: 'session-a', turnId: 'turn-old', generation: 1 };
  await bridge.start(scope, 16000);
  bridge.segment({ ...scope, turnId: 'turn-other' }, { inputSessionId: 'turn-other', segmentId: 's', index: 0, text: '旧轮', audioEndMs: 0, timeSource: 'audio', revision: 1 }, 'final');
  assert.equal(input.liveText(), '', 'an event from another turn never enters this input');
  await bridge.cancel();
  await input.stop();
  assert.deepEqual(submissions, []);
});

test('08-D/08-E real local streaming model: partials arrive during the utterance and the release submits once', { timeout: 300000 }, async t => {
  const directory = process.env.NEXT_REAL_SHERPA_DIR ?? 'F:/AIVoice/toolchains/sherpa-streaming-asr/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';
  let wav: Uint8Array;
  try { wav = await readFile(`${directory}/test_wavs/0.wav`); }
  catch { return t.skip(`local streaming model package missing: ${directory}`); }
  const { SherpaStreamingAsr } = await import('../../providers/sherpa-streaming-asr.js');
  const parsed = inspectPcmWav(wav);
  assert.equal(parsed.sampleRate, 16000, 'the fixture is 16 kHz mono PCM16');
  const samples = new Int16Array(parsed.data.buffer, parsed.data.byteOffset, parsed.data.length / 2);

  const { turnPort, submissions } = chain();
  const finals: string[] = [];
  const partialTimes: number[] = [];
  const input = new NextSpeechInput(async text => { submissions.push(text); return turnPort.submit({ text }); }, {
    onSegmentFinal: segment => finals.push(segment.text),
  });
  const startedAt = Date.now();
  const bridge = new LiveVoiceBridge({ asr: new SherpaStreamingAsr({ encoder: `${directory}/encoder-epoch-99-avg-1.int8.onnx`,
      decoder: `${directory}/decoder-epoch-99-avg-1.onnx`, joiner: `${directory}/joiner-epoch-99-avg-1.int8.onnx`,
      tokens: `${directory}/tokens.txt` }),
    input, onInterim: () => partialTimes.push(Date.now() - startedAt) });
  const scope: TurnScope = { characterId: 'companion', sessionId: 'session-real', turnId: 'turn-real', generation: 1 };
  try {
    await bridge.start(scope, parsed.sampleRate);
    // Real sampling cadence: 100 ms of audio every 100 ms, straight from the fixture.
    const frame = 1600;
    for (let offset = 0; offset < samples.length; offset += frame) {
      const slice = Buffer.from(samples.buffer, samples.byteOffset + offset * 2, Math.min(frame, samples.length - offset) * 2);
      await bridge.push(new Uint8Array(slice), parsed.sampleRate);
    }
    assert.ok(partialTimes.length > 0, 'the live model produced partials before the key was released');
    const finishing = Date.now();
    await bridge.finish(scope, new AbortController().signal);
    const finishedAt = Date.now();
    await input.stop();
    console.log(`[real-streaming] partials=${partialTimes.length} firstPartialMs=${partialTimes[0]} finalMs=${finishedAt - finishing} finals=${finals.length} text=${JSON.stringify(finals.join(''))}`);
    assert.ok(finals.length >= 1, 'the release produced a final segment');
    assert.deepEqual(submissions, [finals.join('').trim()], 'exactly one turn from the real transcript');
  } finally {
    await bridge.cancel();
    const asr = (bridge as unknown as { options: { asr: { close(): Promise<void> } } }).options.asr;
    await asr.close().catch(() => {});
  }
});
