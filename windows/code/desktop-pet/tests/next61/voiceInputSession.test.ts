// FIX61-08 08-B: the production framing primitive shared by the recorder worklet, the shell and the
// ASR session. 100 ms PCM16 mono frames, tail flush, stateful resampling, duplicate/gap handling, the
// in-flight ceiling, the 120 s limit and a bounded finish must all have deterministic outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_FRAME_MAX_SAMPLES, VOICE_FRAME_SAMPLES, VOICE_MAX_FRAMES_IN_FLIGHT, PcmFrameAggregator,
  StatefulResampler, VoiceFrameReorder, VoiceInputSession, decodeVoiceChunkFrame,
} from '../../media/voice-input-session.js';

const ramp = (length: number, from = 0) => Float32Array.from({ length }, (_v, i) => ((from + i) % 100) / 100);
const hop = () => new Promise<void>(done => setImmediate(done));

test('08-B 100 ms framing keeps every sample and flushes the tail exactly once', () => {
  const aggregator = new PcmFrameAggregator();
  const frames: Uint8Array[] = [];
  // The worklet flushes 2048 samples at a time; 2048 is not a multiple of 1600, so every block
  // straddles a frame boundary and the leftover must be carried, not dropped or duplicated.
  for (let block = 0; block < 3; block++) frames.push(...aggregator.push(ramp(2048, block * 2048)));
  assert.equal(frames.length, 3, '6144 samples produce three complete 100 ms frames');
  assert.ok(frames.every(frame => frame.length === VOICE_FRAME_SAMPLES * 2));
  assert.equal(aggregator.capturedSamples, 6144);

  assert.deepEqual(aggregator.push(ramp(37, 6144)), [], 'a partial frame is not emitted early');
  const flushed = aggregator.takeTail();
  // 6144 - 3*1600 = 1344 samples were still buffered; the 37 new samples extend that tail.
  assert.equal(flushed?.length, (1344 + 37) * 2, 'the tail keeps the exact remaining sample count');
  assert.equal(aggregator.takeTail(), undefined, 'the tail is flushed once');

  const total = 6144 + 37;
  const joined = new Uint8Array(total * 2);
  let offset = 0;
  for (const frame of [...frames, flushed!]) { joined.set(frame, offset); offset += frame.length; }
  assert.equal(offset, total * 2, 'no sample is lost or duplicated across frame boundaries');
  const view = new DataView(joined.buffer);
  assert.equal(view.getInt16(0, true), 0);
  assert.equal(view.getInt16(2, true), Math.round(0.01 * 32767));
  assert.equal(view.getInt16(2048 * 2, true), Math.round(0.48 * 32767), 'block boundaries do not shift samples');
  assert.equal(view.getInt16((total - 1) * 2, true), Math.round(0.8 * 32767));
});

test('08-B framing rejects non-finite PCM instead of writing silence', () => {
  assert.throws(() => new PcmFrameAggregator().push(Float32Array.of(0.5, Number.NaN)), /Non-finite/);
});

test('08-B the stateful resampler reports the real rate and carries phase across chunks', () => {
  const resampler = new StatefulResampler(48000, 16000);
  assert.equal(resampler.passthrough, false);
  const input = Float32Array.from({ length: 4800 }, (_v, i) => Math.sin(i / 10));
  const first = resampler.push(input.subarray(0, 2400));
  const second = resampler.push(input.subarray(2400));
  assert.equal(first.length + second.length, 1600, '48 kHz to 16 kHz keeps the 3:1 ratio across chunks');
  const together = Float32Array.from([...first, ...second]);
  // A fresh one-shot resample of the same signal must match: the phase is carried, not restarted.
  const whole = new StatefulResampler(48000, 16000).push(input);
  assert.equal(whole.length, 1600);
  assert.deepEqual(Array.from(together.map(v => Math.round(v * 1e4))), Array.from(whole.map(v => Math.round(v * 1e4))));
  assert.equal(new StatefulResampler(16000, 16000).push(Float32Array.of(1, 2)).length, 2);
});

test('08-B frame index accounting separates repeats from gaps', () => {
  const reorder = new VoiceFrameReorder();
  assert.equal(reorder.accept(0), true);
  assert.equal(reorder.accept(0), false, 'a repeated index is ignored, not applied twice');
  assert.equal(reorder.accept(1), true);
  assert.throws(() => reorder.accept(5), /gap/i);
  assert.equal(reorder.nextIndex, 2, 'a gap does not advance the expected index');
  assert.throws(() => reorder.accept(-1), /Invalid voice frame index/);
  reorder.reset();
  assert.equal(reorder.nextIndex, 0);
  assert.equal(reorder.accept(0), true);
});

test('08-B the bridge payload is validated field by field', () => {
  const pcm = Buffer.from(new Uint8Array([0, 0, 1, 0])).toString('base64');
  const base = { inputSessionId: 'in-1', generation: 3, index: 0, sampleRate: 16000, sampleCount: 2, pcm };
  assert.equal(decodeVoiceChunkFrame(base).sampleCount, 2);
  assert.deepEqual(Array.from(decodeVoiceChunkFrame({ ...base, index: 7 }).pcm), [0, 0, 1, 0]);
  for (const broken of [
    { ...base, inputSessionId: '' },
    { ...base, generation: -1 },
    { ...base, index: 1.5 },
    { ...base, sampleRate: 4000 },
    { ...base, sampleCount: VOICE_FRAME_MAX_SAMPLES + 1 },
    { ...base, pcm: 'not-base64!!' },
    { ...base, pcm: Buffer.from(new Uint8Array([0, 0])).toString('base64') },
    null, [], 'voice_chunk',
  ]) assert.throws(() => decodeVoiceChunkFrame(broken), Error, `must reject ${JSON.stringify(broken)}`);
});

test('08-B the in-flight ceiling bounds memory and reports backpressure instead of dropping audio', async () => {
  const pushed: number[] = [];
  const listeners: (() => void)[] = [];
  let backpressure = 0;
  const session = new VoiceInputSession({
    inputSessionId: 'in-1', generation: 1, sampleRate: 16000,
    sink: { push: async header => { pushed.push(header.index); await new Promise<void>(done => listeners.push(done)); }, finish: async () => {} },
    onBackpressure: () => { backpressure++; },
  });
  const blocks = VOICE_MAX_FRAMES_IN_FLIGHT + 4;
  const feeding = session.push(ramp(VOICE_FRAME_SAMPLES * blocks));
  for (let i = 0; i < 50; i++) await hop();
  assert.equal(pushed.length, VOICE_MAX_FRAMES_IN_FLIGHT, 'production stops emitting at the in-flight ceiling');
  assert.ok(backpressure > 0, 'the producer observed backpressure');
  for (let i = 0; i < 4000 && pushed.length < blocks; i++) { for (const done of listeners.splice(0)) done(); await hop(); }
  await feeding;
  assert.equal(pushed.length, blocks, 'every framed sample is delivered once acks resume');
  for (let i = 0; i < 200 && session.framesInFlight; i++) { for (const done of listeners.splice(0)) done(); await hop(); }
  assert.equal(session.framesInFlight, 0, 'the session drains to zero in-flight frames');
});

test('08-B captures beyond 120 seconds fail loudly; cancel drops queued audio', async () => {
  const session = new VoiceInputSession({ inputSessionId: 'in-2', generation: 1, sampleRate: 16000, sink: { push: async () => {}, finish: async () => {} } });
  await assert.rejects(session.push(ramp(16000 * 121)), /120 second/);

  let released = 0, finishCalls = 0;
  const stuck = new VoiceInputSession({
    inputSessionId: 'in-3', generation: 1, sampleRate: 16000, finishTimeoutMs: 60,
    sink: { push: async () => { released++; await new Promise<void>(() => {}); }, finish: async () => { finishCalls++; } },
  });
  const pushing = stuck.push(ramp(3200));
  await hop();
  stuck.cancel();
  await stuck.finish();
  assert.equal(finishCalls, 0, 'a cancelled session never asks the recognizer to finish');
  // 3200 samples already framed into two 100 ms frames; both left the session before cancel.
  assert.equal(released, 2, 'only frames already handed to the sink left the session');
  await pushing;
  // Nothing more is emitted after cancel, whatever the caller pushes next.
  await stuck.push(ramp(2 * VOICE_FRAME_SAMPLES + 10));
  assert.equal(released, 2, 'cancel stops framing as well as forwarding');
});

test('08-B finish flushes the tail, waits for in-flight acks and is bounded by the configured timeout', async () => {
  const order: string[] = [];
  const listeners: (() => void)[] = [];
  const session = new VoiceInputSession({
    inputSessionId: 'in-4', generation: 1, sampleRate: 16000,
    sink: {
      push: async header => { order.push(`push:${header.index}:${header.sampleCount}`); await new Promise<void>(done => listeners.push(done)); },
      finish: async () => { order.push('finish'); },
    },
  });
  const pushing = session.push(ramp(100));
  await hop();
  const finishing = session.finish();
  await hop();
  assert.deepEqual(order, ['push:0:100'], 'the sink finish waits for the in-flight acknowledgement');
  for (const done of listeners.splice(0)) done();
  await pushing;
  await finishing;
  assert.deepEqual(order, ['push:0:100', 'finish'], 'the tail frame is flushed before the finish signal');
  await session.finish();

  const gated = new VoiceInputSession({
    inputSessionId: 'in-5', generation: 1, sampleRate: 16000, finishTimeoutMs: 40,
    sink: { push: async () => {}, finish: async () => { await new Promise<void>(() => {}); } },
  });
  await assert.rejects(gated.finish(), /timed out/);
});
