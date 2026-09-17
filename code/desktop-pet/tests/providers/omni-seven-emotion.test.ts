import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav } from '../../media/wav.js';
import { QwenPerceptionProvider } from '../../providers/qwen-perception.js';
import { OMNI_SEVEN_EMOTIONS, OMNI_SEVEN_EMOTION_PROMPT, parseOmniEmotion, omniEmotionRequest } from '../../providers/omni-seven-emotion.js';
import type { CapturedInput } from '../../contracts/index.js';
const scope = { characterId: 'companion', sessionId: 'synthetic', turnId: 'one', generation: 1 };
const signal = () => new AbortController().signal;
async function fixture(frames = 3) {
  const store = new MemoryMediaStore(), bytes = pcm16Wav(Float32Array.from([0, .1, -.1, 0]), 16000);
  const audio = await store.put(scope, bytes, 'audio/wav'), images = [];
  for (let i = 0; i < frames; i++) images.push(await store.put(scope, Uint8Array.of(255, 216, i, 0, 255, 217), 'image/jpeg'));
  const input: CapturedInput = { scope: { ...scope }, audio, images, inputEndedAt: '2000-01-01T00:00:00.000Z', captureStoppedAt: '2000-01-01T00:00:00.000Z' };
  return { store, input, bytes };
}
const config = { model: 'qwen3.5-omni-flash-2026-03-15', endpoint: 'https://unit.invalid/chat', apiKey: () => 'synthetic-only',
  authorizer: { async authorize() { throw new Error('Not used by injected unit transport'); } }, cueLifetimeMs: 300000 };
test('wire parser accepts only the two fields and exact seven enum values, never old cues or aliases', () => {
  for (const emotion of OMNI_SEVEN_EMOTIONS) assert.deepEqual(parseOmniEmotion(JSON.stringify({ transcript: 'Hello.', emotion })), { transcript: 'Hello.', emotion });
  for (const value of [{ transcript: 'hi', cues: [] }, { transcript: 'hi', emotion: 'fear' }, { transcript: 'hi', emotion: 'happy', confidence: .9 },
    { emotion: 'neutral' }, { transcript: 1, emotion: 'sad' }, { transcript: 'hi', emotion: ['sad'] }, [], null])
    assert.throws(() => parseOmniEmotion(JSON.stringify(value)));
  assert.throws(() => parseOmniEmotion('not JSON')); assert.throws(() => parseOmniEmotion('{"transcript":"x","emotion":"calm"}'));
  const fence = String.fromCharCode(96).repeat(3);
  assert.deepEqual(parseOmniEmotion(fence + 'json\n{"transcript":"Hello.","emotion":"neutral"}\n' + fence), { transcript: 'Hello.', emotion: 'neutral' });
});
test('production sends complete PCM with exactly zero to three actual ordered frames', async () => {
  for (let count = 0; count <= 3; count++) {
    const f = await fixture(count);
    const body: any = await omniEmotionRequest(f.input, f.store, signal());
    const content = body.messages[0].content;
    assert.equal(body.max_tokens, undefined); assert.equal(content.length, count + 2);
    assert.deepEqual(new Uint8Array(Buffer.from(content[0].input_audio.data.split(',')[1], 'base64')), f.bytes);
    for (let i = 0; i < count; i++) assert.deepEqual(new Uint8Array(Buffer.from(content[i + 1].image_url.url.split(',')[1], 'base64')), Uint8Array.of(255, 216, i, 0, 255, 217));
    assert.equal(content.at(-1).text, OMNI_SEVEN_EMOTION_PROMPT); assert.deepEqual(body.modalities, ['text']);
    await f.store.releaseScope(scope);
  }
});
test('product adaptation maps seven labels explicitly, emits no cues and makes no strong modality-use claim', async () => {
  const f = await fixture(); let emotion: typeof OMNI_SEVEN_EMOTIONS[number] = 'neutral';
  const provider = new QwenPerceptionProvider(config, f.store, { async request(_config, actualScope, operation, body) {
    assert.deepEqual(actualScope, scope); assert.equal(operation, 'perception'); assert.equal(body.max_tokens, undefined);
    return { text: JSON.stringify({ transcript: 'Hello.', emotion }) };
  } });
  const expected = ['neutral', 'happy', 'sad', 'angry', 'fear', 'disgust', 'surprise'];
  for (let i = 0; i < OMNI_SEVEN_EMOTIONS.length; i++) {
    emotion = OMNI_SEVEN_EMOTIONS[i]!; const result = await provider.perceive(f.input, signal());
    assert.equal(result.emotion, expected[i]); assert.deepEqual(result.cues, []); assert.equal(result.transcript, 'Hello.');
    assert.match(result.modalities[0]!.detail!, /not independently verified/);
  }
  await f.store.releaseScope(scope);
});
test('zero to three frames yield normal transcription and truthful image availability; over-limit and cancelled input never call transport', async () => {
  let calls = 0;
  for (const count of [0, 1, 2, 3, 4, 9]) {
    const f = await fixture(count);
    const provider = new QwenPerceptionProvider(config, f.store, { async request() {
      calls++; return { text: '{"transcript":"下午好啊，我在这里。","emotion":"happy"}' };
    } });
    if (count <= 3) {
      const result = await provider.perceive(f.input, signal());
      assert.equal(result.transcript, '下午好啊，我在这里。'); assert.equal(result.emotion, 'happy');
      assert.equal(result.status, count ? 'complete' : 'partial');
      assert.equal(result.modalities[1]!.status, count ? 'used' : 'missing');
      assert.deepEqual(result.modalities[1]!.inputIds, f.input.images.map(i => i.id));
    } else {
      await assert.rejects(provider.perceive(f.input, signal()), /zero to three/);
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(provider.perceive(f.input, controller.signal), { name: 'AbortError' });
    await f.store.releaseScope(scope);
  }
  assert.equal(calls, 4);
});
test('late cancelled output is rejected and captured scope cannot be changed by its caller', async () => {
  const f = await fixture(0); let arrived!: () => void, finish!: (v: { text: string }) => void;
  const started = new Promise<void>(r => { arrived = r; }), pending = new Promise<{text: string}>(r => { finish = r; });
  let actualScope: unknown;
  const provider = new QwenPerceptionProvider(config, f.store, { async request(_c, s) { actualScope = s; arrived(); return pending; } });
  const controller = new AbortController(), work = provider.perceive(f.input, controller.signal);
  const rejected = assert.rejects(work, { name: 'AbortError' }); await started;
  Object.assign(f.input.scope, { turnId: 'other' }); controller.abort();
  finish({ text: '{"transcript":"Hello.","emotion":"happy"}' }); await rejected; assert.deepEqual(actualScope, scope);
  await f.store.releaseScope(scope);
});
test('malformed model output fails instead of silently emitting neutral or fabricated cues', async () => {
  const f = await fixture(0), provider = new QwenPerceptionProvider(config, f.store, { async request() { return { text: '{"transcript":"Hello.","cues":[]}' }; } });
  await assert.rejects(provider.perceive(f.input, signal()), /two-field/); await f.store.releaseScope(scope);
});
