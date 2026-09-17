import test from 'node:test';
import assert from 'node:assert/strict';
import type { MediaAsset } from '../../contracts/index.js';
import { MemoryMediaStore } from '../../media/store.js';
import { QwenVisualEmotionProvider, VISUAL_EMOTION_PROMPT, parseVisualEmotion } from '../../providers/qwen-visual-emotion.js';
const scope = { characterId: 'companion', sessionId: 'synthetic', turnId: 'visual', generation: 1 };
const config = { model: 'qwen3.5-omni-flash-2026-03-15', endpoint: 'https://unit.invalid', apiKey: () => 'synthetic', authorizer: { async authorize() { throw Error('unused'); } } };
test('visual sends only actual zero to three images, no audio/transcript; zero images avoids transport', async () => {
  for (let count = 0; count <= 4; count++) {
    const store = new MemoryMediaStore(), images: MediaAsset[] = [];
    for (let i = 0; i < count; i++) images.push(await store.put(scope, Uint8Array.of(255, 216, i, 255, 217), 'image/jpeg'));
    let calls = 0;
    const provider = new QwenVisualEmotionProvider(config, store, { async request(_c, actualScope, operation, body) {
      calls++; assert.equal(operation, 'perception'); assert.deepEqual(actualScope, scope);
      const content = (body.messages as any[])[0].content;
      assert.deepEqual(content.map((c: any) => c.type), [...images.map(() => 'image_url'), 'text']);
      for (let i = 0; i < count; i++) assert.deepEqual(Uint8Array.from(Buffer.from(content[i].image_url.url.split(',')[1], 'base64')), Uint8Array.of(255, 216, i, 255, 217));
      assert.equal(content.at(-1).text, VISUAL_EMOTION_PROMPT); assert.ok(!JSON.stringify(body).includes('SECRET_TRANSCRIPT'));
      return { text: '{"emotion":"happy"}' };
    } });
    // Even extraneous runtime properties are not spread into the request.
    const input = { scope, images, audio: { uri: 'SECRET_AUDIO' }, transcript: 'SECRET_TRANSCRIPT' };
    if (count > 3) await assert.rejects(provider.perceive(input, new AbortController().signal), /three/);
    else {
      const result = await provider.perceive(input, new AbortController().signal);
      assert.equal(result.emotion, count ? 'happy' : undefined); assert.equal(result.status, count ? 'complete' : 'partial');
      assert.equal(result.modalities[0]!.status, count ? 'used' : 'missing'); assert.deepEqual(result.modalities[0]!.inputIds, images.map(i => i.id));
    }
    assert.equal(calls, count > 0 && count <= 3 ? 1 : 0); await store.releaseScope(scope);
  }
});
test('visual strict emotion-only parser allows unknown visibility without invented neutral', () => {
  assert.equal(parseVisualEmotion('{"emotion":null}'), undefined);
  assert.equal(parseVisualEmotion('{"emotion":"fearful"}'), 'fear');
  for (const value of ['{"transcript":"translated","emotion":"happy"}', '{"emotion":"calm"}', '{}', '{"emotion":0}']) assert.throws(() => parseVisualEmotion(value));
});
test('visual cancellation ignores late response and preserves input scope snapshot', async () => {
  const store = new MemoryMediaStore(), image = await store.put(scope, Uint8Array.of(255, 216, 255, 217), 'image/jpeg');
  let resolve!: (v: any) => void, started!: () => void; const ready = new Promise<void>(r => { started = r; });
  const input = { scope: { ...scope }, images: [image] };
  const provider = new QwenVisualEmotionProvider(config, store, { request(_c, actualScope) { assert.deepEqual(actualScope, scope); started(); return new Promise(r => { resolve = r; }); } });
  const controller = new AbortController(), pending = provider.perceive(input, controller.signal), rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready; input.scope.turnId = 'next'; controller.abort(); await rejected; resolve({ text: '{"emotion":"happy"}' }); await store.releaseScope(scope);
});
