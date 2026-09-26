import test from 'node:test';
import assert from 'node:assert/strict';
import type { AsrProvider, AsrResult, CapturedInput, VisualPerceptionProvider, VisualPerceptionResult } from '../../contracts/index.js';
import { SplitPerceptionProvider } from '../../providers/split-perception.js';
const scope = { characterId: 'companion', sessionId: 'synthetic', turnId: 'one', generation: 1 };
const fixture = (count = 1): CapturedInput => ({ scope: { ...scope }, audio: { id: 'audio', uri: 'pet-media:audio', mimeType: 'audio/wav', temporary: true },
  images: Array.from({ length: count }, (_, i) => ({ id: 'image' + i, uri: 'pet-media:image' + i, mimeType: 'image/jpeg', temporary: true as const })), inputEndedAt: '', captureStoppedAt: '' });
const visualResult = (): VisualPerceptionResult => ({ scope, emotion: 'happy', status: 'complete', modalities: [{ modality: 'image', status: 'used', inputIds: ['image0'] }] });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
const opts = { visualTimeoutMs: 1500 };

test('ASR and visual start concurrently with separate payloads; original ASR text and both emotion sources survive conflict', async () => {
  const a = deferred<AsrResult>(), v = deferred<VisualPerceptionResult>(), ready = deferred<void>(); let starts = 0;
  const started = () => { if (++starts === 2) ready.resolve(); };
  const input = fixture();
  const asr: AsrProvider = { transcribe(value) { assert.deepEqual(Object.keys(value).sort(), ['audio', 'scope']); assert.deepEqual(value.scope, scope); started(); return a.promise; } };
  const visual: VisualPerceptionProvider = { perceive(value) { assert.deepEqual(Object.keys(value).sort(), ['images', 'scope']); assert.deepEqual(value.scope, scope); started(); return v.promise; } };
  const pending = new SplitPerceptionProvider(asr, visual, opts).perceive(input, new AbortController().signal);
  Object.assign(input.scope, { turnId: 'mutated' }); (input.images as any[]).length = 0;
  await ready.promise;
  a.resolve({ scope, transcript: '  Hello, 我在Hengqin。\n', audioEmotion: 'sad', language: 'en' });
  v.resolve({ ...visualResult(), transcript: '禁止覆盖ASR' } as VisualPerceptionResult);
  const result = await pending;
  assert.equal(result.transcript, '  Hello, 我在Hengqin。\n'); assert.deepEqual(result.scope, scope);
  assert.equal(result.audioEmotion, 'sad'); assert.equal(result.visualEmotion, 'happy'); assert.equal(result.emotion, 'sad');
  assert.deepEqual(result.cues, []); assert.equal(result.status, 'complete');
});
test('audio-only skips visual entirely and never invents neutral when ASR has no annotation', async () => {
  let visualCalls = 0;
  const result = await new SplitPerceptionProvider({ async transcribe({ scope }) { return { scope, transcript: 'Good afternoon.' }; } },
    { async perceive() { visualCalls++; throw Error('must not run'); } }, opts).perceive(fixture(0), new AbortController().signal);
  assert.equal(visualCalls, 0); assert.equal(result.transcript, 'Good afternoon.');
  assert.equal(result.emotion, undefined); assert.equal(result.audioEmotion, undefined); assert.equal(result.visualEmotion, undefined);
  assert.equal(result.modalities[1]!.status, 'missing'); assert.equal(result.status, 'partial');
});
test('visual failure, foreign turn, or unavailable face degrades only image while ASR remains complete', async () => {
  for (const mode of ['reject', 'foreign', 'failed', 'no-face']) {
    const result = await new SplitPerceptionProvider({ async transcribe({ scope }) { return { scope, transcript: 'Hello, 下午好。', audioEmotion: 'sad' }; } },
      { async perceive() {
        if (mode === 'reject') throw Error('synthetic camera/model error');
        if (mode === 'foreign') return { ...visualResult(), scope: { ...scope, turnId: 'other' } };
        if (mode === 'failed') return { ...visualResult(), status: 'failed' };
        const { emotion, ...unclassified } = visualResult();
        return { ...unclassified, status: 'partial' };
      } }, opts).perceive(fixture(), new AbortController().signal);
    assert.equal(result.transcript, 'Hello, 下午好。'); assert.equal(result.emotion, 'sad'); assert.equal(result.visualEmotion, undefined);
    assert.equal(result.status, 'partial'); assert.equal(result.modalities[1]!.status, mode === 'no-face' ? 'used' : 'failed');
  }
});
test('when audio emotion is absent, only a real valid visual emotion supplies the compatibility class', async () => {
  const result = await new SplitPerceptionProvider({ async transcribe({ scope }) { return { scope, transcript: 'hello' }; } }, { async perceive() { return visualResult(); } }, opts)
    .perceive(fixture(), new AbortController().signal);
  assert.equal(result.emotion, 'happy'); assert.equal(result.visualEmotion, 'happy'); assert.equal(result.audioEmotion, undefined);
});
test('visual deadline aborts hanging work without dropping ASR and late emotion cannot enter result', { timeout: 1000 }, async () => {
  const late = deferred<VisualPerceptionResult>(); let visualSignal!: AbortSignal;
  const result = await new SplitPerceptionProvider({ async transcribe({ scope }) { return { scope, transcript: 'complete ASR' }; } },
    { perceive(_input, signal) { visualSignal = signal; return late.promise; } }, { visualTimeoutMs: 5 }).perceive(fixture(), new AbortController().signal);
  assert.equal(visualSignal.aborted, true); assert.equal(result.transcript, 'complete ASR'); assert.equal(result.modalities[1]!.status, 'failed');
  assert.equal(result.emotion, undefined); late.resolve(visualResult()); await Promise.resolve(); assert.equal(result.emotion, undefined);
});
test('ASR failure aborts visual immediately instead of awaiting its deadline', async () => {
  const failed = deferred<AsrResult>(), ready = deferred<void>(); let visualSignal!: AbortSignal;
  const pending = new SplitPerceptionProvider({ transcribe() { return failed.promise; } },
    { perceive(_i, signal) { visualSignal = signal; ready.resolve(); return new Promise(() => {}); } }, opts).perceive(fixture(), new AbortController().signal);
  const rejected = assert.rejects(pending, /ASR failed/); await ready.promise; failed.reject(Error('ASR failed')); await rejected; assert.equal(visualSignal.aborted, true);
});
test('cancellation releases ignored child work; foreign ASR is rejected and a later turn stays isolated', async () => {
  const a = deferred<AsrResult>(), v = deferred<VisualPerceptionResult>(), ready = deferred<void>(); let starts = 0; const signals: AbortSignal[] = [];
  const note = (s: AbortSignal) => { signals.push(s); if (++starts === 2) ready.resolve(); };
  const provider = new SplitPerceptionProvider({ transcribe(_i, s) { note(s); return a.promise; } }, { perceive(_i, s) { note(s); return v.promise; } }, opts);
  const controller = new AbortController(), old = provider.perceive(fixture(), controller.signal), rejected = assert.rejects(old, { name: 'AbortError' });
  await ready.promise; controller.abort(); await rejected; assert.ok(signals.every(s => s.aborted));
  a.resolve({ scope, transcript: 'OLD' }); v.resolve(visualResult());
  const next = fixture(0); Object.assign(next.scope, { turnId: 'two', generation: 2 });
  const nextResult = await new SplitPerceptionProvider({ async transcribe({ scope }) { return { scope, transcript: 'NEW' }; } }, { async perceive() { throw Error('no frame'); } }, opts)
    .perceive(next, new AbortController().signal);
  assert.equal(nextResult.transcript, 'NEW'); assert.equal(nextResult.scope.turnId, 'two');
  await assert.rejects(new SplitPerceptionProvider({ async transcribe() { return { scope: { ...scope, turnId: 'foreign' }, transcript: 'bad' }; } },
    { async perceive() { return visualResult(); } }, opts).perceive(fixture(0), new AbortController().signal), /different turn/);
});
