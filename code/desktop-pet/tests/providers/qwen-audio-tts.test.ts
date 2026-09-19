import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TtsRequest } from '../../contracts/index.js';
import { QwenAudioTtsProvider, QWEN_AUDIO_TTS_ENDPOINT, QWEN_AUDIO_TTS_MODEL, QWEN_AUDIO_TTS_PLUS_MODEL, normalizeQwenAudioWav } from '../../providers/qwen-audio-tts.js';
import { ProviderTransport, type CallOutcome, type CallRequest } from '../../providers/transport.js';
import { billedCharacters } from '../../providers/qwen-tts.js';
import { MemoryMediaStore } from '../../media/store.js';
import { inspectPcmWav, pcm16Wav } from '../../media/wav.js';
import { RegisteredVoiceStore, type RegisteredVoice, type RegisteredVoiceBinding } from '../../providers/registered-voices.js';

const input = (): TtsRequest => ({ scope: { characterId: 'friend', sessionId: 'synthetic-session', turnId: 'audio-a', generation: 1 },
  text: '中A文123。', expression: { emotion: 'calm', intensity: .4, delivery: '自然温和', gesture: null } });
const signal = () => new AbortController().signal;
const wav = () => pcm16Wav(Float32Array.from([0, .1, -.1, 0]), 24000);
function harness(options: { fetcher?: typeof fetch; settle?: () => void; voice?: string } = {}) {
  const store = new MemoryMediaStore(), permits: CallRequest[] = [], outcomes: CallOutcome[] = [];
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const config = { model: QWEN_AUDIO_TTS_MODEL, endpoint: QWEN_AUDIO_TTS_ENDPOINT,
    voice: options.voice ?? 'longanfengyue', apiKey: () => 'synthetic-key', authorizer: {
      async authorize(request: CallRequest) { permits.push(request); return {
        async settle(outcome: CallOutcome) { outcomes.push(outcome); options.settle?.(); },
      }; },
    } };
  const transport = new ProviderTransport(async (url, init) => {
    calls.push({ url: String(url), init });
    if (options.fetcher) return options.fetcher(url, init);
    if (init?.method === 'POST') return Response.json({ output: { finish_reason: 'stop',
      audio: { url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/synthetic%20clip.wav?Signature=a%2Bb%3D' } },
      usage: { characters: billedCharacters(JSON.parse(String(init.body)).input.text) } });
    return new Response(wav().slice().buffer);
  });
  return { provider: new QwenAudioTtsProvider(config, store, transport), store, calls, permits, outcomes, config, transport };
}

test('new HTTP protocol uses bound system voice, singular instruction, WAV and supplier usage', async () => {
  const run = harness({ voice: 'longanlingxi' }), request = input();
  const result = await run.provider.synthesize(request, signal());
  const first = run.calls[0]!; assert.equal(first.url, QWEN_AUDIO_TTS_ENDPOINT);
  assert.deepEqual(JSON.parse(String(first.init?.body)), { model: QWEN_AUDIO_TTS_MODEL,
    input: { text: request.text, voice: 'longanlingxi', format: 'wav', sample_rate: 24000, instruction: '自然温和' } });
  assert.equal(run.permits[0]?.textCharacters, 9); assert.deepEqual(run.outcomes[0]?.usage, { characters: 9 });
  assert.equal(run.calls[1]?.url, 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/synthetic%20clip.wav?Signature=a%2Bb%3D');
  assert.equal(run.calls[1]?.init?.headers, undefined); assert.equal(run.calls[1]?.init?.redirect, 'error');
  assert.equal(inspectPcmWav(await run.store.read(request.scope, result.audio)).sampleRate, 24000);
  await run.store.releaseScope(request.scope);
});

test('long mixed Unicode replies preserve every character, bill each segment and join every PCM clip', async () => {
  const run = harness(), request = { ...input(), text: '中😀A。'.repeat(420) };
  const result = await run.provider.synthesize(request, signal());
  const pieces = run.calls.filter(call => call.init?.method === 'POST').map(call => JSON.parse(String(call.init?.body)).input.text as string);
  assert.ok(pieces.length > 1); assert.equal(pieces.join(''), request.text);
  assert.ok(pieces.every(piece => [...piece].length <= 600));
  assert.equal(run.permits.reduce((total, permit) => total + permit.textCharacters!, 0), billedCharacters(request.text));
  const pcm = inspectPcmWav(await run.store.read(request.scope, result.audio));
  assert.equal(pcm.data.length, inspectPcmWav(wav()).data.length * pieces.length);
  await run.store.releaseScope(request.scope);
});

test('unregistered model, endpoint and cross-series/cloned voices are refused without network', async () => {
  const run = harness();
  for (const overrides of [{ model: 'qwen-audio-3.0-tts-plus' }, { endpoint: 'https://synthetic.invalid/tts' },
    { voice: 'Cherry' }, { voice: 'unregistered-clone' }]) {
    assert.throws(() => new QwenAudioTtsProvider({ ...run.config, ...overrides }, run.store, run.transport), /reviewed/);
  }
  await assert.rejects(run.provider.synthesize({ ...input(), voiceId: 'Cherry' }, signal()), /Unreviewed/);
  assert.equal(run.calls.length, 0);
});

test('Plus uses its own reviewed voice and rejects Flash overrides before network', async () => {
  const run = harness();
  const plus = new QwenAudioTtsProvider({ ...run.config, model: QWEN_AUDIO_TTS_PLUS_MODEL, voice: 'longanlingxin' }, run.store, run.transport);
  await assert.rejects(plus.synthesize({ ...input(), voiceId: 'longanlingxi' }, signal()), /Unreviewed/);
  assert.equal(run.calls.length, 0);
  const result = await plus.synthesize(input(), signal());
  const body = JSON.parse(String(run.calls[0]!.init?.body));
  assert.equal(body.model, QWEN_AUDIO_TTS_PLUS_MODEL); assert.equal(body.input.voice, 'longanlingxin');
  assert.equal(body.input.instruction, input().expression.delivery);
  assert.equal(body.input.instructions, undefined);
  assert.equal(inspectPcmWav(await run.store.read(input().scope, result.audio)).sampleRate, 24000);
  await run.store.releaseScope(input().scope);
});

test('completed QwenAudio placeholder WAV retains all PCM bytes while ordinary truncation is rejected', async () => {
  const original = wav(), streaming = original.slice(), header = new DataView(streaming.buffer);
  header.setUint32(4, 0x7fffffbf, true); header.setUint32(40, 0x7fffff9b, true);
  const before = streaming.slice(), normalized = normalizeQwenAudioWav(streaming);
  assert.deepEqual(normalized, original); assert.deepEqual(streaming, before);
  assert.equal(normalizeQwenAudioWav(original), original);
  for (const mutation of ['unknown_pair', 'odd_payload', 'ordinary_truncated', 'wrong_format'] as const) {
    const invalid = mutation === 'odd_payload' ? streaming.slice(0, -1) : streaming.slice();
    const v = new DataView(invalid.buffer);
    if (mutation === 'unknown_pair') v.setUint32(40, 0x7fffffff, true);
    if (mutation === 'ordinary_truncated') { v.setUint32(4, 100, true); v.setUint32(40, 64, true); }
    if (mutation === 'wrong_format') v.setUint16(20, 3, true);
    assert.throws(() => inspectPcmWav(normalizeQwenAudioWav(invalid)), /WAV/);
  }
  const run = harness({ fetcher: async (_url, init) => init?.method === 'POST'
    ? Response.json({ output: { finish_reason: 'stop', audio: { url: 'https://synthetic.invalid/stream-header.wav' } }, usage: { characters: 9 } })
    : new Response(before.slice().buffer) });
  const result = await run.provider.synthesize(input(), signal());
  assert.deepEqual(await run.store.read(input().scope, result.audio), original);
  assert.equal(run.calls.filter(c => c.init?.method === 'POST').length, 1);
  await run.store.releaseScope(input().scope);
});

test('Buffer subarray normalization owns its bytes and survives clearing the original backing storage', () => {
  const original = wav(), backing = Buffer.alloc(original.length + 12), slice = backing.subarray(5, 5 + original.length);
  slice.set(original); slice.writeUInt32LE(0x7fffffbf, 4); slice.writeUInt32LE(0x7fffff9b, 40);
  const before = Buffer.from(backing), normalized = normalizeQwenAudioWav(slice);
  assert.deepEqual(backing, before); assert.notEqual(normalized.buffer, slice.buffer);
  backing.fill(0); assert.deepEqual(normalized, original);
  assert.equal(inspectPcmWav(normalized).sampleRate, 24000);
});

test('empty text and an oversized instruction fail before authorization without truncation', async () => {
  const run = harness(), request = input();
  await assert.rejects(run.provider.synthesize({ ...request, text: '  ' }, signal()), /empty/);
  await assert.rejects(run.provider.synthesize({ ...request, expression: { ...request.expression, delivery: '中'.repeat(534) } }, signal()), /bound/);
  assert.equal(run.calls.length, 0); assert.equal(run.permits.length, 0);
});

test('uncompleted generation and invalid WAV never publish audio or retry a paid request', async () => {
  for (const failure of ['unfinished', 'invalid_wav', 'wrong_rate'] as const) {
    const run = harness({ fetcher: async (_url, init) => init?.method === 'POST'
      ? Response.json({ output: { finish_reason: failure === 'unfinished' ? null : 'stop', audio: { url: 'https://synthetic.invalid/audio.wav' } }, usage: { characters: 9 } })
      : new Response(failure === 'invalid_wav' ? 'invalid synthetic WAV' : pcm16Wav(new Float32Array(8), 16000).slice().buffer) });
    await assert.rejects(run.provider.synthesize(input(), signal()), /complete|WAV/);
    assert.equal(run.store.count, 0); assert.equal(run.calls.filter(call => call.init?.method === 'POST').length, 1);
    assert.deepEqual(run.outcomes[0]?.usage, { characters: 9 });
  }
});

test('cancel after generation settles usage but prevents download and later speech segments', async () => {
  const controller = new AbortController(), run = harness({ settle: () => controller.abort() });
  await assert.rejects(run.provider.synthesize({ ...input(), text: '中'.repeat(700) }, controller.signal), { name: 'AbortError' });
  assert.equal(run.calls.length, 1); assert.equal(run.outcomes[0]?.status, 'success'); assert.equal(run.store.count, 0);
});

test('late download from cancelled turn cannot enter another role and scope is fixed at creation', async () => {
  let started!: () => void, finish!: (response: Response) => void;
  const opened = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const run = harness({ fetcher: async (_url, init) => {
    if (init?.method === 'POST') return Response.json({ output: { finish_reason: 'stop',
      audio: { url: JSON.parse(String(init.body)).input.voice === 'longanfengyue' ? 'https://synthetic.invalid/late.wav' : 'https://synthetic.invalid/new.wav' } }, usage: { characters: 9 } });
    if (String(_url).endsWith('/late.wav')) { started(); return pending; }
    return new Response(wav().slice().buffer);
  } });
  const controller = new AbortController(), original = input();
  const first = run.provider.synthesize(original, controller.signal);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await opened; controller.abort();
  const next = { ...input(), voiceId: 'longanlingxi', scope: { ...input().scope, characterId: 'sweetheart' as const, turnId: 'audio-b', generation: 2 } };
  const second = await run.provider.synthesize(next, signal());
  finish(new Response(wav().slice().buffer)); await rejected;
  assert.deepEqual(second.scope, next.scope); assert.equal(run.store.count, 1);
  await assert.rejects(run.store.read(original.scope, second.audio), { message: 'Media unavailable for this turn' });
  await run.store.releaseScope(next.scope);
});

test('caller mutation while awaiting audio cannot rewrite the captured turn or expression', async () => {
  let complete!: (response: Response) => void, started!: () => void;
  const opened = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<Response>(resolve => { complete = resolve; });
  const run = harness({ fetcher: async (_url, init) => {
    if (init?.method === 'POST') return Response.json({ output: { finish_reason: 'stop', audio: { url: 'https://synthetic.invalid/audio.wav' } }, usage: { characters: 9 } });
    started(); return pending;
  } });
  const request = input(), captured = structuredClone(request), work = run.provider.synthesize(request, signal());
  await opened; Object.assign(request.scope, { turnId: 'mutated' }); Object.assign(request.expression, { delivery: 'mutated' });
  complete(new Response(wav().slice().buffer)); const result = await work;
  assert.deepEqual(result.scope, captured.scope); assert.deepEqual(result.expression, captured.expression);
  await run.store.releaseScope(captured.scope);
});

async function registered(t: TestContext) {
  const parent = resolve('../../.local/dania-voice-clone-01/test-runs'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'tts-binding-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'registered-voices.json'), registry = await RegisteredVoiceStore.open(file);
  const record: RegisteredVoice = { voiceId: 'dania-synthetic-001', label: 'example-voice 合成记录', provider: 'dashscope',
    endpoint: QWEN_AUDIO_TTS_ENDPOINT, targetModel: QWEN_AUDIO_TTS_PLUS_MODEL, credentialRef: 'dashscope-123456abcdef',
    referenceSha256: 'a'.repeat(64), createdAt: '2026-09-11T00:00:00.000Z' };
  await registry.register(0, record);
  const reopened = await RegisteredVoiceStore.open(file);
  return { record, binding: reopened.resolve(record) };
}

test('a restored exact registration can synthesize with Plus without sending registry metadata', async t => {
  const { record, binding } = await registered(t), run = harness();
  const provider = new QwenAudioTtsProvider({ ...run.config, model: record.targetModel, voice: record.voiceId,
    credentialRef: record.credentialRef, registeredVoice: binding }, run.store, run.transport);
  const request = { ...input(), scope: { ...input().scope, characterId: 'companion' } };
  const result = await provider.synthesize(request, signal());
  const body = JSON.parse(String(run.calls[0]!.init?.body));
  assert.deepEqual(body, { model: QWEN_AUDIO_TTS_PLUS_MODEL, input: { text: request.text, voice: record.voiceId,
    format: 'wav', sample_rate: 24000, instruction: request.expression.delivery } });
  assert.deepEqual(await run.store.read(request.scope, result.audio), wav());
  assert.deepEqual(result.scope, request.scope); assert.deepEqual(result.expression, request.expression);
  assert.equal(run.permits.length, 1); assert.equal(run.permits[0]!.textCharacters, billedCharacters(request.text));
  await run.store.releaseScope(request.scope);
});

test('voice overrides require the exact issued ID while system voices remain usable', async t => {
  const { record, binding } = await registered(t), run = harness();
  const provider = new QwenAudioTtsProvider({ ...run.config, model: record.targetModel, voice: 'longanlingxin',
    credentialRef: record.credentialRef, registeredVoice: binding }, run.store, run.transport);
  for (const voiceId of ['dania-synthetic-002', 'qwen-audio-tts-clone-valid-looking-id', 'longanlingxi'])
    await assert.rejects(provider.synthesize({ ...input(), voiceId }, signal()), /Unreviewed/);
  assert.equal(run.calls.length, 0); assert.equal(run.permits.length, 0);
  await provider.synthesize({ ...input(), voiceId: record.voiceId }, signal());
  await provider.synthesize(input(), signal());
  assert.deepEqual(run.calls.filter(c => c.init?.method === 'POST').map(c => JSON.parse(String(c.init?.body)).input.voice), [record.voiceId, 'longanlingxin']);
  await run.store.releaseScope(input().scope);
});

test('forged shape, copied binding and mismatched endpoint/model/credential are refused before key access', async t => {
  const { record, binding } = await registered(t), run = harness(); let keyReads = 0;
  const valid = { ...run.config, model: record.targetModel, voice: record.voiceId, credentialRef: record.credentialRef,
    registeredVoice: binding, apiKey: () => { keyReads++; return 'synthetic'; } };
  for (const change of [{ registeredVoice: record as RegisteredVoiceBinding }, { registeredVoice: { ...binding } },
    { credentialRef: 'dashscope-abcdef123456' }, { model: QWEN_AUDIO_TTS_MODEL }, { endpoint: 'https://other.invalid/tts' }])
    assert.throws(() => new QwenAudioTtsProvider({ ...valid, ...change }, run.store, run.transport));
  const { credentialRef: _unused, ...missingCredential } = valid;
  assert.throws(() => new QwenAudioTtsProvider(missingCredential, run.store, run.transport), /binding_mismatch/);
  const { registeredVoice: _omitted, ...missingBinding } = valid;
  assert.throws(() => new QwenAudioTtsProvider(missingBinding, run.store, run.transport), /reviewed/);
  assert.equal(keyReads, 0); assert.equal(run.calls.length, 0); assert.equal(run.permits.length, 0);
});

test('provider captures its configuration so caller mutation cannot redirect a registered voice', async t => {
  const { record, binding } = await registered(t), run = harness();
  const config = { ...run.config, model: record.targetModel, voice: record.voiceId, credentialRef: record.credentialRef, registeredVoice: binding };
  const provider = new QwenAudioTtsProvider(config, run.store, run.transport);
  Object.assign(config, { endpoint: 'https://other.invalid/tts', model: QWEN_AUDIO_TTS_MODEL, credentialRef: 'dashscope-abcdef123456', voice: 'unregistered' });
  await provider.synthesize(input(), signal());
  const call = run.calls[0]!; assert.equal(call.url, record.endpoint);
  assert.equal(JSON.parse(String(call.init?.body)).model, record.targetModel); assert.equal(JSON.parse(String(call.init?.body)).input.voice, record.voiceId);
  await run.store.releaseScope(input().scope);
});

test('cancelling registered-voice synthesis after generation prevents download and remaining segments', async t => {
  const { record, binding } = await registered(t), controller = new AbortController(), run = harness({ settle: () => controller.abort() });
  const provider = new QwenAudioTtsProvider({ ...run.config, model: record.targetModel, voice: record.voiceId,
    credentialRef: record.credentialRef, registeredVoice: binding }, run.store, run.transport);
  await assert.rejects(provider.synthesize({ ...input(), text: '中'.repeat(700) }, controller.signal), { name: 'AbortError' });
  assert.equal(run.calls.length, 1); assert.equal(run.outcomes[0]?.status, 'success'); assert.equal(run.store.count, 0);
});

test('explicit zh hint is captured for registered voice only; system override keeps the original request shape', async t => {
  const { record, binding } = await registered(t), run = harness(), hints: ['zh'] = ['zh'];
  const provider = new QwenAudioTtsProvider({ ...run.config, model: record.targetModel, voice: record.voiceId,
    credentialRef: record.credentialRef, registeredVoice: binding, languageHints: hints }, run.store, run.transport);
  Object.assign(hints, { 0: 'ja' });
  await provider.synthesize(input(), signal()); await provider.synthesize({ ...input(), voiceId: 'longanlingxin' }, signal());
  const bodies = run.calls.filter(c => c.init?.method === 'POST').map(c => JSON.parse(String(c.init?.body)));
  assert.deepEqual(bodies[0].input.language_hints, ['zh']); assert.equal(bodies[1].input.language_hints, undefined);
  await run.store.releaseScope(input().scope);
});

test('unsupported language hints and hints without registration fail before network', async t => {
  const { record, binding } = await registered(t), run = harness();
  const config = { ...run.config, model: record.targetModel, voice: record.voiceId, credentialRef: record.credentialRef, registeredVoice: binding };
  for (const languageHints of [['ja'], [], ['zh', 'en'], 'zh', null])
    assert.throws(() => new QwenAudioTtsProvider({ ...config, languageHints: languageHints as unknown as readonly ['zh'] }, run.store, run.transport), /language hint/);
  assert.throws(() => new QwenAudioTtsProvider({ ...run.config, languageHints: ['zh'] }, run.store, run.transport), /language hint/);
  assert.equal(run.calls.length, 0); assert.equal(run.permits.length, 0);
});
