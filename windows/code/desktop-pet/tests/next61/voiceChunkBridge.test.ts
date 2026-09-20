// FIX61-08 08-C bridge leg: the production voice_chunk protocol between the shell and the backend.
// The renderer is replaced by a scripted peer that answers voice_frame with the recorded PCM; the
// backend side (DesktopDeviceBridge + VoiceInputSession) is production code.
//
// Frame failures latch: a refused frame never reaches the recognizer and the error surfaces on the
// next push() or on finish(), so the recorder cannot keep feeding audio into a broken stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopDeviceBridge } from '../../app/desktop-device-bridge.js';
import { VoiceInputSession, VOICE_FRAME_SAMPLES, VOICE_MAX_FRAMES_IN_FLIGHT } from '../../media/voice-input-session.js';
import { pcm16Wav } from '../../media/wav.js';
import { nextScope } from '../next/harness.js';

const ramp = (length: number, from = 0) => Float32Array.from({ length }, (_v, i) => (((from + i) % 100) - 50) / 100);
const hop = () => new Promise<void>(done => setImmediate(done));

interface FrameRequest { channel: 'voice_frame'; requestId: string; inputSessionId: string; generation: number; index: number; sampleRate: number; sampleCount: number }

/** Scripted renderer: holds one recording and answers voice_frame with the matching PCM slice. */
function peer() {
  const sent: { channel: string; index?: number; inputSessionId?: string; generation?: number; sampleCount?: number }[] = [];
  const acks: { index?: number; inputSessionId?: string; generation?: number }[] = [];
  const answered = new Set<string>();
  let recorded: Uint8Array = new Uint8Array(0);
  const device = new DesktopDeviceBridge(
    { put: async () => { throw new Error('unused'); }, read: async () => { throw new Error('unused'); }, releaseScope: async () => {} },
    message => { sent.push(message as never); }, 5000);
  device.onVoiceChunkAck = message => { acks.push(message as never); };
  const frames = () => sent.filter(message => message.channel === 'voice_frame' && !answered.has((message as unknown as FrameRequest).requestId)) as unknown as FrameRequest[];
  const answer = (frame: FrameRequest, mutate?: (pcm: Uint8Array) => Uint8Array) => {
    answered.add(frame.requestId);
    const start = frame.index * VOICE_FRAME_SAMPLES * 2;
    const slice = recorded.slice(start, start + frame.sampleCount * 2);
    const pcm = mutate ? mutate(slice) : slice;
    return device.receive({ channel: 'voice_chunk', requestId: frame.requestId, inputSessionId: frame.inputSessionId,
      generation: frame.generation, index: frame.index, sampleRate: frame.sampleRate, sampleCount: frame.sampleCount,
      pcm: Buffer.from(pcm).toString('base64') });
  };
  return { device, sent, acks, frames, answer, setRecording: (bytes: Uint8Array) => { recorded = bytes; } };
}

/** Runs the real ping-pong until the acknowledgement count is reached. */
async function pump(p: ReturnType<typeof peer>, expected: number, limit = 4000): Promise<void> {
  for (let i = 0; i < limit && p.acks.length < expected; i++) {
    for (const frame of p.frames()) p.answer(frame);
    await hop();
  }
  for (const frame of p.frames()) p.answer(frame);
}

test('08-C the backend requests voice_chunk frames in order and acknowledges each one', async () => {
  const p = peer();
  const scope = nextScope('turn-voice');
  p.setRecording(pcm16Wav(ramp(VOICE_FRAME_SAMPLES * 3 + 25), 16000).subarray(44));

  const session = new VoiceInputSession({ inputSessionId: scope.turnId, generation: scope.generation, sampleRate: 16000, sink: p.device.captureChunks });
  p.device.openVoiceCapture(scope.turnId, scope);
  const feeding = session.push(ramp(VOICE_FRAME_SAMPLES * 3 + 25));
  await pump(p, 3);
  await feeding;

  const requests = p.sent.filter(message => message.channel === 'voice_frame');
  assert.deepEqual(requests.map(message => message.index), [0, 1, 2], 'only complete 100 ms frames leave the device');
  assert.ok(requests.every(message => message.sampleCount === VOICE_FRAME_SAMPLES));
  assert.deepEqual(p.acks.map(message => message.index), [0, 1, 2], 'each accepted frame is acknowledged once');
  assert.ok(p.acks.every(message => message.inputSessionId === scope.turnId && message.generation === scope.generation));
  // The 25-sample tail is the finish flush, not a partial frame on the wire.
  const finishing = session.finish();
  for (let i = 0; i < 200 && p.frames().length === 0; i++) { for (const frame of p.frames()) p.answer(frame); await hop(); }
  for (const frame of p.frames()) p.answer(frame);
  await finishing;
  const tail = p.sent.filter(message => message.channel === 'voice_frame').at(-1)!;
  assert.equal(tail.sampleCount, 25, 'the unfinished tail is flushed as its own final frame');
  assert.deepEqual(p.acks.map(message => message.index), [0, 1, 2, 3]);
});

test('08-C a frame from another generation is refused and never acknowledged', async () => {
  const p = peer();
  const scope = nextScope('turn-voice', 2);
  p.setRecording(pcm16Wav(ramp(VOICE_FRAME_SAMPLES), 16000).subarray(44));
  const session = new VoiceInputSession({ inputSessionId: scope.turnId, generation: scope.generation, sampleRate: 16000, sink: p.device.captureChunks });
  p.device.openVoiceCapture(scope.turnId, scope);
  const feeding = session.push(ramp(VOICE_FRAME_SAMPLES));
  for (let i = 0; i < 200 && p.frames().length === 0; i++) await hop();
  const frame = p.frames()[0]!;
  p.device.receive({ channel: 'voice_chunk', requestId: frame.requestId, inputSessionId: frame.inputSessionId,
    generation: frame.generation + 1, index: frame.index, sampleRate: frame.sampleRate, sampleCount: frame.sampleCount,
    pcm: Buffer.from(new Uint8Array(frame.sampleCount * 2)).toString('base64') });
  await feeding;
  for (let i = 0; i < 5; i++) await hop();
  assert.equal(p.acks.length, 0, 'a stale generation never produces an acknowledgement');
  // The latched failure surfaces on the next frame and cannot reach the recognizer.
  await assert.rejects(session.push(ramp(VOICE_FRAME_SAMPLES)), /does not match the requested frame/);
  await assert.rejects(session.finish(), /does not match the requested frame/);
  session.cancel();
});

test('08-C a frame whose payload was altered is refused instead of being transcribed', async () => {
  const p = peer();
  const scope = nextScope('turn-voice');
  p.setRecording(pcm16Wav(ramp(VOICE_FRAME_SAMPLES), 16000).subarray(44));
  const session = new VoiceInputSession({ inputSessionId: scope.turnId, generation: scope.generation, sampleRate: 16000, sink: p.device.captureChunks });
  p.device.openVoiceCapture(scope.turnId, scope);
  const feeding = session.push(ramp(VOICE_FRAME_SAMPLES));
  for (let i = 0; i < 200 && p.frames().length === 0; i++) await hop();
  p.answer(p.frames()[0]!, pcm => { const copy = Uint8Array.from(pcm); copy[0] = (copy[0]! + 1) % 256; return copy; });
  await feeding;
  for (let i = 0; i < 5; i++) await hop();
  assert.equal(p.acks.length, 0, 'an altered payload is never acknowledged');
  await assert.rejects(session.push(ramp(VOICE_FRAME_SAMPLES)), /does not match the captured frame/);
  session.cancel();
});

test('08-C a voice frame request without an active capture session is refused', async () => {
  const p = peer();
  const scope = nextScope('turn-voice');
  await assert.rejects(p.device.captureChunks.push({ inputSessionId: scope.turnId, generation: scope.generation, index: 0, sampleRate: 16000, sampleCount: VOICE_FRAME_SAMPLES },
    new Uint8Array(VOICE_FRAME_SAMPLES * 2)), /not active/);
  assert.equal(p.sent.length, 0, 'no bridge write happens for an unauthorized session');
});

test('08-C backpressure stops the capture instead of buffering beyond the in-flight ceiling', async () => {
  const p = peer();
  const scope = nextScope('turn-voice');
  const total = 30;
  p.setRecording(pcm16Wav(ramp(VOICE_FRAME_SAMPLES * total), 16000).subarray(44));
  let backpressure = 0;
  const session = new VoiceInputSession({ inputSessionId: scope.turnId, generation: scope.generation, sampleRate: 16000,
    sink: p.device.captureChunks, onBackpressure: () => { backpressure++; } });
  p.device.openVoiceCapture(scope.turnId, scope);
  const feeding = session.push(ramp(VOICE_FRAME_SAMPLES * total));
  for (let i = 0; i < 40; i++) await hop();
  const inFlight = p.sent.filter(message => message.channel === 'voice_frame').length;
  assert.ok(inFlight <= VOICE_MAX_FRAMES_IN_FLIGHT + 1, `never more than the in-flight ceiling is requested (got ${inFlight})`);
  assert.ok(backpressure > 0, 'the producer reported backpressure instead of dropping audio');
  await pump(p, total);
  await feeding;
  assert.equal(p.acks.length, total, 'every frame is delivered once the acknowledgements resume');
  assert.equal(p.sent.filter(message => message.channel === 'voice_frame').length, total);
  session.cancel();
});
