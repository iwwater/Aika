import test from 'node:test';
import assert from 'node:assert/strict';
import type { CapturedInput, PlaybackEvent, TurnScope, TtsResult } from '../../contracts/index.js';
import { TurnCapture, type CaptureSession, type CapturedBytes } from '../../media/capture.js';
import { TurnPlayback, type PlaybackSample, type PlaybackSession } from '../../media/playback.js';
import { MemoryMediaStore } from '../../media/store.js';
import { inspectPcmWav, joinPcmWav, pcm16Wav } from '../../media/wav.js';
import { TurnTiming } from '../../media/timing.js';

const scope: TurnScope = { characterId: 'friend', sessionId: 's', turnId: 't', generation: 1 };
const next: TurnScope = { characterId: 'sweetheart', sessionId: 's2', turnId: 't2', generation: 2 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const wav = () => pcm16Wav(new Float32Array([0, .2, -.1, 0]), 24000);
const captureBytes = (): CapturedBytes => ({ audio: wav(), images: [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }], captureStoppedAt: '2026-09-06T14:00:00.001Z' });
async function speech(store: MemoryMediaStore, owner = scope): Promise<TtsResult> {
  return { scope: owner, audio: await store.put(owner, wav(), 'audio/wav'), expression: { emotion: 'calm', intensity: .5, delivery: '自然', gesture: null }, durationMs: 100, synchronization: 'amplitude' };
}

test('media bytes cannot cross characters, be forged, or survive release', async () => {
  const store = new MemoryMediaStore(), bytes = wav(), asset = await store.put(scope, bytes, 'audio/wav'); bytes.fill(0);
  assert.equal(inspectPcmWav(await store.read(scope, asset)).sampleRate, 24000);
  await assert.rejects(store.read(next, asset), /unavailable/);
  await assert.rejects(store.read(scope, { ...asset, uri: 'pet-media:other' }), /unavailable/);
  await store.releaseScope(scope); await assert.rejects(store.read(scope, asset), /unavailable/); assert.equal(store.count, 0);
});
test('WAV segments retain every sample and reject incompatible or corrupt audio', () => {
  assert.equal(inspectPcmWav(joinPcmWav([wav(), wav()])).data.length, 16);
  assert.throws(() => joinPcmWav([wav(), pcm16Wav(new Float32Array([.1]), 48000)]), /inconsistent/);
  assert.throws(() => inspectPcmWav(wav().subarray(0, 45)), /Truncated/);
  assert.throws(() => pcm16Wav(new Float32Array([NaN]), 24000), /Non-finite/);
});
test('construction and text-only work never open capture', async () => {
  let calls = 0; const store = new MemoryMediaStore();
  new TurnCapture({ async open() { calls++; throw new Error('unexpected capture'); } }, store);
  await speech(store); assert.equal(calls, 0);
});
test('capture finish stops devices before awaiting serialization and preserves input end time', async () => {
  const store = new MemoryMediaStore(), encoded = deferred<CapturedBytes>(); let stopped = false;
  const capture = new TurnCapture({ async open() { return { finish: () => { stopped = true; return encoded.promise; }, stop: () => { stopped = true; } }; } }, store, () => '2026-09-06T14:00:00.000Z');
  await capture.start(scope, new AbortController().signal); const result = capture.finish(scope);
  assert.equal(stopped, true); encoded.resolve(captureBytes());
  const input: CapturedInput = await result;
  assert.equal(input.inputEndedAt, '2026-09-06T14:00:00.000Z'); assert.equal(input.images.length, 1);
  assert.equal(store.count, 2); await store.releaseScope(scope);
});
test('cancel during permission acquisition rejects immediately and stops late devices', async () => {
  const opening = deferred<CaptureSession>(), store = new MemoryMediaStore(); let stopped = 0;
  const capture = new TurnCapture({ open: () => opening.promise }, store), controller = new AbortController();
  const result = capture.start(scope, controller.signal); const rejected = assert.rejects(result, { name: 'AbortError' });
  await tick(); controller.abort(); await rejected;
  opening.resolve({ stop() { stopped++; }, async finish() { return captureBytes(); } }); await tick();
  assert.equal(stopped, 1); assert.equal(store.count, 0);
});
test('old capture cancellation cannot stop a new character', async () => {
  const owners: number[] = [], store = new MemoryMediaStore(); let id = 0;
  const capture = new TurnCapture({ async open() { const mine = ++id; return { stop() { owners.push(mine); }, async finish() { return captureBytes(); } }; } }, store);
  await capture.start(scope, new AbortController().signal); await capture.start(next, new AbortController().signal);
  await capture.stop(scope); assert.deepEqual(owners, [1]);
  assert.equal((await capture.finish(next)).scope.characterId, 'sweetheart');
});
test('rapid starts while previous cleanup is pending only acquire the newest turn', async () => {
  const cleanup = deferred<void>(); let delay = false, opened = 0;
  class SlowStore extends MemoryMediaStore { override async releaseScope(owner: TurnScope) { if (delay) await cleanup.promise; return super.releaseScope(owner); } }
  const store = new SlowStore();
  const capture = new TurnCapture({ async open() { opened++; return { stop() {}, async finish() { return captureBytes(); } }; } }, store);
  await capture.start(scope, new AbortController().signal); delay = true;
  const middle = capture.start({ ...next, turnId: 'middle' }, new AbortController().signal); const rejected = assert.rejects(middle, { name: 'AbortError' });
  const latest = capture.start(next, new AbortController().signal);
  cleanup.resolve(); await rejected; await latest;
  assert.equal(opened, 2); await capture.stop(next);
});
test('abort before capture acquisition prevents any device request', async () => {
  let opened = 0; const controller = new AbortController();
  const capture = new TurnCapture({ async open() { opened++; throw new Error('unexpected'); } }, new MemoryMediaStore());
  const pending = capture.start(scope, controller.signal); const rejected = assert.rejects(pending, { name: 'AbortError' }); controller.abort(); await rejected;
  assert.equal(opened, 0);
});
test('cancel during encoding discards late recorded bytes', async () => {
  const encoded = deferred<CapturedBytes>(), store = new MemoryMediaStore(), controller = new AbortController();
  const capture = new TurnCapture({ async open() { return { stop() {}, finish: () => encoded.promise }; } }, store);
  await capture.start(scope, controller.signal); const result = capture.finish(scope); const rejected = assert.rejects(result, { name: 'AbortError' });
  controller.abort(); await rejected; encoded.resolve(captureBytes()); await tick(); assert.equal(store.count, 0);
});
test('capture failure releases resources and permits another turn', async () => {
  let calls = 0, stops = 0; const store = new MemoryMediaStore();
  const capture = new TurnCapture({ async open() { if (++calls === 1) throw new Error('camera denied'); return { stop() { stops++; }, async finish() { return captureBytes(); } }; } }, store);
  await assert.rejects(capture.start(scope, new AbortController().signal), /denied/);
  await capture.start(next, new AbortController().signal); await capture.stop(next); assert.equal(stops, 1);
});
test('play request does not count as started; actual event drives timing and terminal rejects late events', async () => {
  const store = new MemoryMediaStore(), events: PlaybackEvent[] = [], finished = deferred<void>(); let deliver!: (event: PlaybackSample) => void;
  const playback = new TurnPlayback({ async open(_bytes, _id, emit) { deliver = emit; return { stop() {}, done: finished.promise }; } }, store);
  const result = playback.play(await speech(store), event => events.push(event), new AbortController().signal); await tick();
  assert.equal(events.length, 0);
  deliver({ type: 'started', audioId: 'a', at: '2026-09-06T14:00:03.000Z', timingBasis: 'audio_output_timestamp' });
  deliver({ type: 'ended', at: '2026-09-06T14:00:04.000Z' });
  deliver({ type: 'amplitude', value: 1, at: '2026-09-06T14:00:04.100Z' }); finished.resolve(); await result;
  assert.deepEqual(events.map(event => event.type), ['started', 'amplitude', 'ended']); assert.equal(store.count, 0);
});
test('cancel during playback decode disposes late audio and zeroes mouth', async () => {
  const store = new MemoryMediaStore(), events: PlaybackEvent[] = [], opening = deferred<PlaybackSession>(), controller = new AbortController(); let stopped = 0;
  const playback = new TurnPlayback({ open: () => opening.promise }, store);
  const result = playback.play(await speech(store), event => events.push(event), controller.signal); const rejected = assert.rejects(result, { name: 'AbortError' });
  await tick(); controller.abort(); await rejected;
  opening.resolve({ done: Promise.resolve(), stop() { stopped++; } }); await tick();
  assert.equal(stopped, 1); assert.deepEqual(events.map(e => e.type), ['amplitude', 'stopped']); assert.equal(store.count, 0);
});
test('old playback stop cannot affect next character and signals cannot leak after abort', async () => {
  const store = new MemoryMediaStore(), deliveries: ((event: PlaybackSample) => void)[] = [], finishers: (() => void)[] = [], events: PlaybackEvent[] = [];
  const playback = new TurnPlayback({ async open(_bytes, _id, emit) { deliveries.push(emit); const done = deferred<void>(); finishers.push(() => done.resolve()); return { done: done.promise, stop() { done.resolve(); } }; } }, store);
  const first = playback.play(await speech(store), event => events.push(event), new AbortController().signal); const rejected = assert.rejects(first, { name: 'AbortError' }); await tick();
  const second = playback.play(await speech(store, next), event => events.push(event), new AbortController().signal); await rejected; await tick();
  const count = events.length; deliveries[0]!({ type: 'started', audioId: 'old', at: new Date().toISOString() }); await playback.stop(scope); assert.equal(events.length, count);
  deliveries[1]!({ type: 'started', audioId: 'new', at: new Date().toISOString() }); finishers[1]!(); await second;
  assert.equal(events.filter(e => e.type === 'started').length, 1); assert.equal(store.count, 0);
});
test('playback errors are explicit, release audio and reset amplitude', async () => {
  const store = new MemoryMediaStore(), events: PlaybackEvent[] = [];
  const playback = new TurnPlayback({ async open() { throw new Error('speaker unavailable'); } }, store);
  await assert.rejects(playback.play(await speech(store), event => events.push(event), new AbortController().signal), /speaker/);
  assert.deepEqual(events.map(e => e.type), ['amplitude', 'error']); assert.equal(store.count, 0);
});
test('timing has no latency result before output and preserves overlapping spans', async () => {
  let monotonic = 0; const timing = new TurnTiming(scope, '2026-09-06T14:00:00.000Z', () => monotonic);
  assert.equal(timing.report().endToOutputMs, null);
  const asr = deferred<void>(), vision = deferred<void>();
  const one = timing.measure('asr', () => asr.promise), two = timing.measure('perception', () => vision.promise);
  monotonic = 20; asr.resolve(); vision.resolve(); await Promise.all([one, two]);
  timing.playback({ scope, type: 'started', audioId: 'a', at: '2026-09-06T14:00:03.250Z', timingBasis: 'audio_output_timestamp' });
  assert.equal(timing.report().endToOutputMs, 3250); assert.deepEqual(timing.report().spans.map(span => span.durationMs), [20, 20]);
  assert.throws(() => timing.playback({ scope: next, type: 'ended', at: new Date().toISOString() }), /different/);
});
