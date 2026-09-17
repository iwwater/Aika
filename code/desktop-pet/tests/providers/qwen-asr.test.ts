import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav } from '../../media/wav.js';
import { ProviderTransport, type CallRequest } from '../../providers/transport.js';
import { QwenAsrProvider, QWEN_ASR_MODEL, parseAsrResponse } from '../../providers/qwen-asr.js';
const scope = { characterId: 'companion', sessionId: 'synthetic', turnId: 'asr', generation: 1 };
const completion = (content: unknown, annotations: unknown = []) => ({ choices: [{ finish_reason: 'stop', message: { content, annotations } }], usage: { seconds: .1 } });
async function fixture() {
  const store = new MemoryMediaStore(), bytes = pcm16Wav(new Float32Array(1600).fill(.2), 16000);
  return { store, bytes, input: { scope: { ...scope }, audio: await store.put(scope, bytes, 'audio/wav') } };
}
const config = { model: QWEN_ASR_MODEL, endpoint: 'https://unit.invalid/chat', apiKey: () => 'synthetic', authorizer: { async authorize() { throw Error('unused'); } } };
test('dedicated ASR sends full audio only, auto language and duration budget; original English/Chinese/mixed text survives unchanged', async () => {
  const f = await fixture(); let expected = '', calls = 0, budget: CallRequest | undefined;
  const transport = new ProviderTransport(async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    assert.equal(body.model, QWEN_ASR_MODEL); assert.equal(body.stream, false); assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user'); assert.equal(body.messages[0].content.length, 1);
    assert.equal(body.messages[0].content[0].type, 'input_audio'); assert.deepEqual(body.asr_options, { enable_itn: false });
    assert.deepEqual(Uint8Array.from(Buffer.from(body.messages[0].content[0].input_audio.data.split(',')[1], 'base64')), f.bytes);
    return Response.json(completion(expected));
  });
  const provider = new QwenAsrProvider({ ...config, authorizer: { async authorize(request) { budget = request; return { async settle() {} }; } } }, f.store, transport);
  for (const text of ['Good afternoon, I am here.', '下午好啊，我在这里。', 'Hello, 我在Hengqin口岸。', '  (I mean tomorrow) one hundred.\n', '']) {
    expected = text; const result = await provider.transcribe(f.input, new AbortController().signal);
    assert.equal(result.transcript, text); assert.equal(result.audioEmotion, undefined); assert.deepEqual(result.scope, scope);
    assert.equal(budget!.operation, 'asr'); assert.equal(budget!.audioSeconds, .1); assert.equal(budget!.textCharacters, undefined);
  }
  assert.equal(calls, 5); assert.deepEqual(await f.store.read(scope, f.input.audio), f.bytes); await f.store.releaseScope(scope);
});
test('ASR annotations preserve only actual valid audio emotion and language, never default or reconcile conflicting classes', () => {
  for (const [wire, product] of [['neutral','neutral'],['happy','happy'],['sad','sad'],['angry','angry'],['fearful','fear'],['disgusted','disgust'],['surprised','surprise']]) {
    assert.deepEqual(parseAsrResponse(completion('Hello', [{ type: 'audio_info', language: 'en', emotion: wire }])), { transcript: 'Hello', audioEmotion: product, language: 'en' });
  }
  for (const annotations of [undefined, {}, [null], [{ type: 'other', emotion: 'happy' }], [{ type: 'audio_info', emotion: 'calm', language: 'ENGLISH TEXT' }],
    [{ type: 'audio_info', emotion: 'sad' }, { type: 'audio_info', emotion: 'happy' }]]) {
    assert.deepEqual(parseAsrResponse(completion('Hello', annotations)), { transcript: 'Hello' });
  }
  assert.deepEqual(parseAsrResponse(completion('Hello', [{ type: 'audio_info', emotion: 'sad' }, { type: 'audio_info', emotion: 'sad' }])), { transcript: 'Hello', audioEmotion: 'sad' });
});
test('malformed or truncated ASR fails; no translation or silent fallback text is generated', () => {
  for (const value of [{}, completion(null), { choices: [{ finish_reason: 'length', message: { content: 'half' } }] }, { choices: [] }]) assert.throws(() => parseAsrResponse(value));
});
test('ASR cancellation returns before ignored late transport and cannot mutate captured turn', async () => {
  const f = await fixture(); let resolve!: (v: any) => void, started!: () => void; const ready = new Promise<void>(r => { started = r; });
  const provider = new QwenAsrProvider(config, f.store, { request(_c, actualScope) { assert.deepEqual(actualScope, scope); started(); return new Promise(r => { resolve = r; }); } });
  const controller = new AbortController(), pending = provider.transcribe(f.input, controller.signal), rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready; f.input.scope.turnId = 'new'; controller.abort(); await rejected; resolve(completion('old')); await f.store.releaseScope(scope);
});
test('ASR rejects invalid audio and pre-cancellation without transport', async () => {
  const f = await fixture(); let calls = 0;
  const provider = new QwenAsrProvider(config, f.store, { async request() { calls++; return completion('bad'); } });
  const bad = await f.store.put(scope, Uint8Array.of(1, 2), 'audio/wav');
  await assert.rejects(provider.transcribe({ scope, audio: bad }, new AbortController().signal), /WAV/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(provider.transcribe(f.input, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0); await f.store.releaseScope(scope);
});
