import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MediaStorePort, TtsRequest } from '../../contracts/index.js';
import { MiniMaxTtsProvider, MINIMAX_TTS_MODEL, MINIMAX_HD_TTS_MODEL, MINIMAX_TTS_ENDPOINT, miniMaxCharacterUpperBound } from '../../providers/minimax-tts.js';
import { RegisteredVoiceStore, type RegisteredVoiceBinding } from '../../providers/registered-voices.js';
import { ProviderTransport, type CallOutcome, type CallRequest } from '../../providers/transport.js';
import { MemoryMediaStore } from '../../media/store.js';
import { inspectPcmWav, pcm16Wav } from '../../media/wav.js';

const input = (): TtsRequest => ({ scope: { characterId: 'companion', sessionId: 'minimax-synthetic', turnId: 'turn-a', generation: 1 },
  text: '今天不错（其实有点累），A😀。', expression: { emotion: 'happy', intensity: .4, delivery: '（微笑）温柔朗读；不属于正文', gesture: null } });
const signal = () => new AbortController().signal;
const wav = () => pcm16Wav(Float32Array.from([0, .1, -.1, 0]), 24000);
const raw = (bytes = wav()) => ({ output: { base_resp: { status_code: 0, status_msg: 'success' },
  data: { audio: Buffer.from(bytes).toString('hex'), status: 2 },
  extra_info: { audio_format: 'wav', audio_sample_rate: 24000, audio_channel: 1, audio_size: bytes.length } },
  usage: { characters: 12 }, request_id: 'synthetic-request' });
async function harness(t: TestContext, options: { model?: string; response?: () => unknown; fetcher?: typeof fetch; settle?: () => void; store?: MediaStorePort } = {}) {
  const parent = resolve('../../.local/minimax-hd-default-01/test-runs'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'minimax-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = await RegisteredVoiceStore.open(join(directory, 'registered-voices.json'));
  const voice = { voiceId: 'example-voice', label: '隔离测试', provider: 'dashscope' as const, endpoint: MINIMAX_TTS_ENDPOINT,
    targetModel: options.model ?? MINIMAX_TTS_MODEL, credentialRef: 'dashscope-123456abcdef', referenceSha256: 'b'.repeat(64), createdAt: '2026-09-11T00:00:00.000Z' };
  await registry.register(0, voice);
  const calls: { url: string; init?: RequestInit }[] = [], permits: CallRequest[] = [], outcomes: CallOutcome[] = []; let keyReads = 0;
  const media = new MemoryMediaStore(), store = options.store ?? media;
  const config = { model: voice.targetModel, endpoint: MINIMAX_TTS_ENDPOINT, voice: voice.voiceId, credentialRef: voice.credentialRef,
    registeredVoice: registry.resolve(voice), apiKey: () => { keyReads++; return 'synthetic-key'; }, authorizer: {
      async authorize(request: CallRequest) { permits.push(request); return { async settle(outcome: CallOutcome) { outcomes.push(outcome); options.settle?.(); } }; },
    } };
  const transport = new ProviderTransport(async (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (options.fetcher) return options.fetcher(url, init);
    return Response.json(options.response ? options.response() : raw());
  });
  return { provider: new MiniMaxTtsProvider(config, store, transport), config, voice, calls, permits, outcomes, media, transport, keyReads: () => keyReads };
}

test('sync Turbo emits pure text without an emotion parameter, receives WAV hex and preserves actual PCM', async t => {
  const run = await harness(t), request = input(), answer = await run.provider.synthesize(request, signal());
  assert.equal(run.calls.length, 1); assert.equal(run.calls[0]!.url, MINIMAX_TTS_ENDPOINT);
  const body = JSON.parse(String(run.calls[0]!.init?.body));
  assert.deepEqual(body, { model: MINIMAX_TTS_MODEL, input: { text: request.text,
    voice_setting: { voice_id: run.voice.voiceId, speed: 1, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 24000, format: 'wav', channel: 1 }, output_format: 'hex', language_boost: 'Chinese' } });
  assert.equal(new Headers(run.calls[0]!.init?.headers).has('X-DashScope-SSE'), false);
  assert.equal(JSON.stringify(body).includes(request.expression.delivery), false);
  assert.deepEqual(await run.media.read(request.scope, answer.audio), wav());
  assert.equal(answer.durationMs, inspectPcmWav(wav()).durationMs); assert.equal(answer.synchronization, 'amplitude');
  assert.deepEqual(answer.expression, request.expression); assert.deepEqual(answer.scope, request.scope);
  assert.equal(run.permits[0]!.textCharacters, Buffer.byteLength(request.text, 'utf8'));
  assert.deepEqual(run.outcomes[0]!.usage, { characters: 12 }, 'supplier usage is not replaced by the reservation bound');
  await run.media.releaseScope(request.scope);
});

test('long replies keep every code point, authorize each segment and join every PCM segment', async t => {
  const run = await harness(t), request = { ...input(), text: '中😀A。'.repeat(420) };
  const answer = await run.provider.synthesize(request, signal());
  const pieces = run.calls.map(call => JSON.parse(String(call.init?.body)).input.text as string);
  assert.ok(pieces.length > 1); assert.equal(pieces.join(''), request.text); assert.ok(pieces.every(p => Array.from(p).length <= 600));
  assert.equal(run.permits.reduce((n, p) => n + p.textCharacters!, 0), miniMaxCharacterUpperBound(request.text));
  assert.equal(inspectPcmWav(await run.media.read(request.scope, answer.audio)).data.length, inspectPcmWav(wav()).data.length * pieces.length);
  await run.media.releaseScope(request.scope);
});

for (const model of [MINIMAX_TTS_MODEL, MINIMAX_HD_TTS_MODEL]) test(`${model} omits every emotion while preserving visual expression`, async t => {
  const run = await harness(t, { model });
  for (const emotion of ['happy', 'sad', 'angry', 'surprised', 'fearful', 'disgusted', 'calm', 'neutral', 'warm', 'whisper', 'unknown']) {
    const request = { ...input(), expression: { ...input().expression, emotion } };
    const answer = await run.provider.synthesize(request, signal());
    const wire = JSON.parse(String(run.calls.at(-1)!.init?.body));
    assert.deepEqual(wire.input.voice_setting, { voice_id: run.voice.voiceId, speed: 1, vol: 1, pitch: 0 });
    assert.equal(wire.input.text, request.text);
    assert.equal(JSON.stringify(wire).includes(request.expression.delivery), false);
    assert.deepEqual(answer.expression, request.expression); await run.media.releaseScope(request.scope);
  }
});

test('constructor and voice override reject unregistered or mismatched bindings before key access', async t => {
  const run = await harness(t);
  for (const changed of [{ model: 'MiniMax/speech-2.8-hd' }, { endpoint: 'https://api.minimaxi.com/v1/t2a_v2' },
    { endpoint: MINIMAX_TTS_ENDPOINT + '?x=1' }, { credentialRef: 'dashscope-abcdef123456' }, { voice: 'another' },
    { registeredVoice: { ...run.config.registeredVoice } }, { registeredVoice: run.voice as RegisteredVoiceBinding }])
    assert.throws(() => new MiniMaxTtsProvider({ ...run.config, ...changed }, run.media, run.transport));
  await assert.rejects(run.provider.synthesize({ ...input(), voiceId: 'valid-looking-but-not-registered' }, signal()), /Registered voice/);
  assert.equal(run.keyReads(), 0); assert.equal(run.permits.length, 0); assert.equal(run.calls.length, 0);
  await run.provider.synthesize({ ...input(), voiceId: run.voice.voiceId }, signal()); await run.media.releaseScope(input().scope);
});

test('an HTTP200 business failure is rejected even though generic transport settles the HTTP response', async t => {
  const response = raw(); response.output.base_resp = { status_code: 1004, status_msg: 'private-synthetic-diagnostic' };
  const run = await harness(t, { response: () => response });
  await assert.rejects(run.provider.synthesize(input(), signal()), { message: 'MiniMax synthesis failed' });
  assert.equal(run.media.count, 0); assert.equal(run.calls.length, 1);
  assert.equal(run.outcomes[0]!.status, 'success'); assert.deepEqual(run.outcomes[0]!.usage, response.usage);
  t.diagnostic('Transport settlement is HTTP/JSON-level; no audio published and no automatic retry. I owns billing/business-outcome handling.');
});

for (const [name, response] of [
  ['missing base status', { output: { data: { audio: '00', status: 2 } } }],
  ['string base status', { output: { base_resp: { status_code: '0' }, data: { audio: '00', status: 2 } } }],
  ['null data', { output: { base_resp: { status_code: 0 }, data: null } }],
  ['unfinished', { output: { base_resp: { status_code: 0 }, data: { audio: '00', status: 1 } } }],
  ['string completion', { output: { base_resp: { status_code: 0 }, data: { audio: '00', status: '2' } } }],
] as const) test(`${name} never produces playable audio`, async t => {
  const run = await harness(t, { response: () => response }); await assert.rejects(run.provider.synthesize(input(), signal()));
  assert.equal(run.calls.length, 1); assert.equal(run.media.count, 0);
});

test('empty, odd, non-hex and URL audio cannot be silently truncated by hex decoding', async t => {
  let audio = ''; const run = await harness(t, { response: () => { const response = raw(); response.output.data.audio = audio; return response; } });
  for (audio of ['', '0', 'zz', '0x1234', '00 00', Buffer.from(wav()).toString('hex') + 'zz', 'https://synthetic.invalid/audio.wav']) {
    const before = run.calls.length; await assert.rejects(run.provider.synthesize(input(), signal()), /audio hex/);
    assert.equal(run.calls.length, before + 1); assert.equal(run.media.count, 0);
  }
});

test('uppercase hex is accepted but MP3, truncated WAV, wrong rate/channels/depth and placeholder RIFF are not', async t => {
  let response = raw(); response.output.data.audio = response.output.data.audio.toUpperCase();
  const run = await harness(t, { response: () => response }); await run.provider.synthesize(input(), signal()); await run.media.releaseScope(input().scope);
  for (const kind of ['mp3', 'truncated', 'rate', 'channels', 'depth', 'riff_length']) {
    const bytes = kind === 'mp3' ? new TextEncoder().encode('ID3-not-a-WAV') : kind === 'truncated' ? wav().slice(0, -2) : wav();
    if (bytes.length >= 44) {
      const v = new DataView(bytes.buffer); if (kind === 'rate') v.setUint32(24, 16000, true);
      if (kind === 'channels') v.setUint16(22, 2, true); if (kind === 'depth') v.setUint16(34, 32, true);
      if (kind === 'riff_length') v.setUint32(4, 0x7fffffbf, true);
    }
    response = raw(bytes); await assert.rejects(run.provider.synthesize(input(), signal()), /WAV/); assert.equal(run.media.count, 0);
  }
});

test('reported audio format metadata cannot contradict the actual WAV', async t => {
  let extra: Record<string, unknown> = {}; const run = await harness(t, { response: () => ({ ...raw(), output: { ...raw().output, extra_info: extra } }) });
  for (extra of [{ audio_format: 'mp3' }, { audio_sample_rate: 16000 }, { audio_channel: 2 }, { audio_size: 1 }])
    await assert.rejects(run.provider.synthesize(input(), signal()), /metadata/);
  assert.equal(run.media.count, 0); assert.equal(run.calls.length, 4);
});

test('empty text, pre-cancellation and denied budget never make a provider request', async t => {
  const run = await harness(t); await assert.rejects(run.provider.synthesize({ ...input(), text: ' ' }, signal()), /empty/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(run.provider.synthesize(input(), controller.signal), { name: 'AbortError' });
  assert.equal(run.keyReads(), 0);
  const denied = new MiniMaxTtsProvider({ ...run.config, authorizer: { async authorize() { throw new Error('controlled budget denied'); } } }, run.media, run.transport);
  await assert.rejects(denied.synthesize(input(), signal()), /budget denied/); assert.equal(run.calls.length, 0); assert.equal(run.media.count, 0);
});

test('failure in a later segment discards partial speech without publishing or retrying', async t => {
  let n = 0; const run = await harness(t, { response: () => { n++; const response = raw(); if (n === 2) response.output.data.status = 1; return response; } });
  await assert.rejects(run.provider.synthesize({ ...input(), text: '中'.repeat(1600) }, signal()), /complete/);
  assert.equal(run.calls.length, 2); assert.equal(run.media.count, 0);
});

test('cancel after settlement prevents publication and all later segments', async t => {
  const controller = new AbortController(), run = await harness(t, { settle: () => controller.abort() });
  await assert.rejects(run.provider.synthesize({ ...input(), text: '中'.repeat(700) }, controller.signal), { name: 'AbortError' });
  assert.equal(run.calls.length, 1); assert.equal(run.outcomes[0]!.status, 'success'); assert.equal(run.media.count, 0);
});

test('late cancelled output cannot enter a newer turn, and in-flight caller mutations cannot change its snapshot', async t => {
  let arrived!: () => void, finish!: (response: Response) => void; const started = new Promise<void>(r => { arrived = r; });
  const pending = new Promise<Response>(r => { finish = r; }); let count = 0;
  const run = await harness(t, { fetcher: async () => { count++; if (count === 1) { arrived(); return pending; } return Response.json(raw()); } });
  const old = input(), controller = new AbortController(), work = run.provider.synthesize(old, controller.signal);
  const rejected = assert.rejects(work, { name: 'AbortError' }); await started; controller.abort();
  Object.assign(old.scope, { turnId: 'mutated' }); Object.assign(old.expression, { delivery: 'mutated' });
  const current = { ...input(), scope: { ...input().scope, turnId: 'turn-b', generation: 2 } }, answer = await run.provider.synthesize(current, signal());
  finish(Response.json(raw())); await rejected;
  assert.deepEqual(answer.scope, current.scope); assert.equal(run.media.count, 1);
  await assert.rejects(run.media.read(input().scope, answer.audio), /unavailable/); await run.media.releaseScope(current.scope);
});

test('successful in-flight request keeps original text/scope/expression and captured configuration', async t => {
  let arrived!: () => void, finish!: (response: Response) => void; const started = new Promise<void>(r => { arrived = r; });
  const pending = new Promise<Response>(r => { finish = r; });
  const run = await harness(t, { fetcher: async () => { arrived(); return pending; } }), request = input(), original = structuredClone(request);
  Object.assign(run.config, { endpoint: 'https://other.invalid/tts', voice: 'other', credentialRef: 'dashscope-abcdef123456' });
  const work = run.provider.synthesize(request, signal()); await started;
  Object.assign(request.scope, { turnId: 'changed' }); Object.assign(request.expression, { emotion: 'sad', delivery: 'changed' }); Object.assign(request, { text: 'changed' });
  finish(Response.json(raw())); const answer = await work;
  assert.deepEqual(answer.scope, original.scope); assert.deepEqual(answer.expression, original.expression);
  assert.equal(run.calls[0]!.url, MINIMAX_TTS_ENDPOINT); assert.equal(JSON.parse(String(run.calls[0]!.init?.body)).input.text, original.text);
  await run.media.releaseScope(original.scope);
});

test('cancel or failed store publication releases only its own turn and clears local joined bytes', async t => {
  for (const failure of ['cancel', 'io']) {
    const memory = new MemoryMediaStore(), controller = new AbortController(); let buffer: Uint8Array | undefined;
    const otherScope = { ...input().scope, turnId: 'other' }; const other = await memory.put(otherScope, wav(), 'audio/wav');
    const store: MediaStorePort = { read: memory.read.bind(memory), releaseScope: memory.releaseScope.bind(memory),
      async put(scope, bytes, mime) { buffer = bytes; const asset = await memory.put(scope, bytes, mime);
        if (failure === 'cancel') controller.abort(); else throw new Error('controlled publication failure'); return asset; } };
    const run = await harness(t, { store }); await assert.rejects(run.provider.synthesize(input(), controller.signal));
    assert.equal(memory.count, 1); assert.ok(buffer?.every(value => value === 0)); assert.deepEqual(await memory.read(otherScope, other), wav());
    await memory.releaseScope(otherScope);
  }
});

test('HD registered synthesis uses the HD wire and reservations while keeping every text and PCM segment', async t => {
  const run = await harness(t, { model: MINIMAX_HD_TTS_MODEL }), request = { ...input(), text: '中😀A。'.repeat(180) };
  const answer = await run.provider.synthesize(request, signal());
  const bodies = run.calls.map(call => JSON.parse(String(call.init?.body)));
  assert.ok(bodies.length > 1); assert.equal(bodies.map(body => body.input.text).join(''), request.text);
  for (const [index, body] of bodies.entries()) {
    assert.equal(body.model, 'MiniMax/speech-2.8-hd'); assert.equal(run.calls[index]!.url, MINIMAX_TTS_ENDPOINT);
    assert.equal(body.input.voice_setting.voice_id, run.voice.voiceId); assert.equal(Object.hasOwn(body.input.voice_setting, 'emotion'), false);
    assert.equal(JSON.stringify(body).includes(request.expression.delivery), false);
    assert.deepEqual(body.input.audio_setting, { sample_rate: 24000, format: 'wav', channel: 1 });
    assert.equal(body.input.output_format, 'hex'); assert.equal(new Headers(run.calls[index]!.init?.headers).has('X-DashScope-SSE'), false);
    assert.equal(run.permits[index]!.model, 'MiniMax/speech-2.8-hd');
    assert.equal(run.permits[index]!.textCharacters, miniMaxCharacterUpperBound(body.input.text));
    assert.deepEqual(run.outcomes[index]!.usage, { characters: 12 });
  }
  const actual = inspectPcmWav(await run.media.read(request.scope, answer.audio)), expected = inspectPcmWav(wav());
  assert.deepEqual(actual.data, new Uint8Array(Buffer.concat(bodies.map(() => expected.data))));
  assert.equal(answer.durationMs, actual.durationMs); assert.equal(answer.synchronization, 'amplitude');
  assert.deepEqual(answer.scope, request.scope); assert.deepEqual(answer.expression, request.expression);
  assert.equal(MINIMAX_TTS_MODEL, 'MiniMax/speech-2.8-turbo'); await run.media.releaseScope(request.scope);
});

test('HD cannot borrow a Turbo binding or lend its binding to Turbo, another voice or another credential', async t => {
  const hd = await harness(t, { model: MINIMAX_HD_TTS_MODEL }), turbo = await harness(t);
  for (const config of [
    { ...hd.config, registeredVoice: turbo.config.registeredVoice }, { ...turbo.config, registeredVoice: hd.config.registeredVoice },
    { ...hd.config, voice: 'another' }, { ...hd.config, credentialRef: 'dashscope-abcdef123456' },
    { ...hd.config, registeredVoice: { ...hd.config.registeredVoice } },
    { ...hd.config, model: 'MiniMax/speech-02-hd' }, { ...hd.config, model: 'MiniMax/speech-2.8-hd-extra' },
    { ...hd.config, endpoint: 'https://api.minimaxi.com/v1/t2a_v2' },
  ]) assert.throws(() => new MiniMaxTtsProvider(config, hd.media, hd.transport));
  await assert.rejects(hd.provider.synthesize({ ...input(), voiceId: 'another' }, signal()), /Registered voice/);
  assert.equal(hd.keyReads() + turbo.keyReads(), 0); assert.equal(hd.calls.length + turbo.calls.length, 0);
});

test('HD business failures, unfinished replies, invalid hex and nonconforming WAV never enter the media store', async t => {
  let response = raw(); const run = await harness(t, { model: MINIMAX_HD_TTS_MODEL, response: () => response });
  for (const kind of ['business', 'unfinished', 'hex', 'sample_rate', 'riff_length', 'metadata']) {
    response = raw();
    if (kind === 'business') response.output.base_resp.status_code = 1004;
    if (kind === 'unfinished') response.output.data.status = 1;
    if (kind === 'hex') response.output.data.audio += 'zz';
    if (kind === 'sample_rate' || kind === 'riff_length') {
      const bytes = wav(), view = new DataView(bytes.buffer);
      if (kind === 'sample_rate') view.setUint32(24, 16000, true); else view.setUint32(4, 0x7fffffbf, true);
      response = raw(bytes);
    }
    if (kind === 'metadata') response.output.extra_info.audio_size = 1;
    const before = run.calls.length; await assert.rejects(run.provider.synthesize(input(), signal()));
    assert.equal(run.calls.length, before + 1); assert.equal(run.media.count, 0);
    assert.equal(run.outcomes.at(-1)!.status, 'success', 'HTTP settlement remains separate from audio success');
  }
});

test('HD cancelled late output cannot contaminate a newer turn even if the caller mutates the old input', async t => {
  let arrived!: () => void, finish!: (response: Response) => void; const started = new Promise<void>(r => { arrived = r; });
  const pending = new Promise<Response>(r => { finish = r; }); let count = 0;
  const run = await harness(t, { model: MINIMAX_HD_TTS_MODEL, fetcher: async () => {
    if (++count === 1) { arrived(); return pending; } return Response.json(raw());
  } });
  const old = { ...input(), text: '中'.repeat(700) }, controller = new AbortController();
  const rejected = assert.rejects(run.provider.synthesize(old, controller.signal), { name: 'AbortError' });
  await started; controller.abort(); Object.assign(old.scope, { turnId: 'mutated' }); Object.assign(old.expression, { emotion: 'sad' });
  const current = { ...input(), scope: { ...input().scope, turnId: 'hd-next', generation: 2 } };
  const answer = await run.provider.synthesize(current, signal()); finish(Response.json(raw())); await rejected;
  assert.equal(run.calls.length, 2); assert.equal(run.media.count, 1); assert.deepEqual(answer.scope, current.scope);
  assert.deepEqual(answer.expression, current.expression); await assert.rejects(run.media.read(input().scope, answer.audio), /unavailable/);
  await run.media.releaseScope(current.scope);
});

test('HD cancelled or failed publication clears local PCM and releases only its own scope', async t => {
  for (const failure of ['cancel', 'io']) {
    const memory = new MemoryMediaStore(), controller = new AbortController(); let buffer: Uint8Array | undefined;
    const otherScope = { ...input().scope, turnId: 'hd-other' }, other = await memory.put(otherScope, wav(), 'audio/wav');
    const store: MediaStorePort = { read: memory.read.bind(memory), releaseScope: memory.releaseScope.bind(memory),
      async put(scope, bytes, mime) { buffer = bytes; const asset = await memory.put(scope, bytes, mime);
        if (failure === 'cancel') controller.abort(); else throw new Error('controlled HD publication failure'); return asset; } };
    const run = await harness(t, { model: MINIMAX_HD_TTS_MODEL, store });
    await assert.rejects(run.provider.synthesize(input(), controller.signal));
    assert.equal(memory.count, 1); assert.ok(buffer?.every(value => value === 0));
    assert.deepEqual(await memory.read(otherScope, other), wav()); await memory.releaseScope(otherScope);
  }
});
