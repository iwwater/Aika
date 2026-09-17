import test from 'node:test';
import assert from 'node:assert/strict';
import type { CapturedInput, DialogueRequest, MemoryMaintenanceInput, TurnScope, TtsRequest } from '../../contracts/index.js';
import { QwenPerceptionProvider } from '../../providers/qwen-perception.js';
import { QwenDialogueProvider, QwenMemoryMaintenanceProvider } from '../../providers/qwen-dialogue.js';
import { QwenTtsProvider, billedCharacters, splitSpeech } from '../../providers/qwen-tts.js';
import { CallOutcome, CallAuthorizer, EndpointConfig, ProviderTransport, denyPaidCalls } from '../../providers/transport.js';
import { MemoryMediaStore } from '../../media/store.js';
import { inspectPcmWav, pcm16Wav } from '../../media/wav.js';

const scope: TurnScope = { characterId: 'friend', sessionId: 's', turnId: 't', generation: 1 };
const signal = () => new AbortController().signal;
const config = (authorizer: CallAuthorizer, model = 'qwen-plus-2025-12-01'): EndpointConfig => ({ endpoint: 'https://unit.invalid/chat/completions', model, apiKey: () => 'test-only-key', authorizer });
function permits() { const outcomes: CallOutcome[] = [], requests: unknown[] = []; const authorizer: CallAuthorizer = { async authorize(request) { requests.push(request); return { async settle(outcome) { outcomes.push(outcome); } }; } }; return { authorizer, outcomes, requests }; }
const waveform = () => pcm16Wav(Float32Array.from({ length: 240 }, (_, i) => Math.sin(i * .1) * .1), 24000);
function completion(data: unknown, finish = 'stop'): Response { return Response.json({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: finish }], usage: { prompt_tokens: 11, completion_tokens: 7 } }); }
function stream(data: unknown, split = false): Response {
  const text = JSON.stringify(data);
  const frames = [JSON.stringify({ choices: [{ delta: { content: text.slice(0, 4) }, finish_reason: null }] }), JSON.stringify({ choices: [{ delta: { content: text.slice(4) }, finish_reason: 'stop' }] }), JSON.stringify({ choices: [], usage: { prompt_tokens: 22, completion_tokens: 10 }, id: 'synthetic-request' }), '[DONE]'];
  const encoded = new TextEncoder().encode(frames.map(frame => `data: ${frame}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { if (split) for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); else controller.enqueue(encoded); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
async function captured(store: MemoryMediaStore, withImage = true): Promise<CapturedInput> {
  const audio = await store.put(scope, waveform(), 'audio/wav');
  const image = await store.put(scope, Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2QmcAAAAASUVORK5CYII=', 'base64')), 'image/png');
  return { scope, audio, images: withImage ? Array.from({length:3},()=>({...image})) : [], inputEndedAt: new Date().toISOString(), captureStoppedAt: new Date().toISOString() };
}
const perception = (emotion = 'neutral') => ({ transcript: '我没事。', emotion });
function dialogue(): DialogueRequest { return { scope, text: '你好', context: { scope, characterPrompt: '朋友角色', recent: [{ id: 't:user', characterId: 'friend', role: 'user', text: '你好', createdAt: '2026-09-06T00:00:00Z' }], summary: '', memories: [], perception: null, inputTokenBudget: 5000 } }; }
const reply = { text: '我在。', expression: { emotion: 'calm', intensity: .4, delivery: '温和自然', gesture: null } };
const memoryInput = (): MemoryMaintenanceInput => ({ scope, messages: [{ id: 'source', characterId: 'friend', role: 'user', text: '我换工作了', createdAt: new Date().toISOString() }], relevantMemories: [{ characterId: 'friend', id: 'm1', version: 2, text: '旧工作', sourceIds: ['source-old'] }, { characterId: 'friend', id: 'm2', version: 1, text: '重复工作', sourceIds: ['source-old'] }] });

test('unapproved D09 and missing configuration never invoke network', async () => {
  let calls = 0; const transport = new ProviderTransport(async () => { calls++; throw new Error('unexpected network'); });
  await assert.rejects(transport.request(config(denyPaidCalls), scope, 'dialogue', {}, signal()), /D09/);
  await assert.rejects(transport.request({ ...config(denyPaidCalls), apiKey: () => '' }, scope, 'dialogue', {}, signal()), /not configured/);
  assert.equal(calls, 0);
});
test('real audio/image bytes and their IDs reach the perception boundary; split SSE remains valid', async () => {
  const store = new MemoryMediaStore(), input = await captured(store), permit = permits(); let payload: any;
  const transport = new ProviderTransport(async (_url, init) => { payload = JSON.parse(String(init?.body)); return stream(perception(), true); });
  const provider = new QwenPerceptionProvider({ ...config(permit.authorizer, 'qwen3.5-omni-flash-2026-03-15'), cueLifetimeMs: 60000 }, store, transport);
  const result = await provider.perceive(input, signal());
  const content = payload.messages[0].content;
  assert.deepEqual(Buffer.from(content[0].input_audio.data.split(',')[1], 'base64'), Buffer.from(await store.read(scope, input.audio)));
  assert.deepEqual(Buffer.from(content[1].image_url.url.split(',')[1], 'base64'), Buffer.from(await store.read(scope, input.images[0]!)));
  assert.deepEqual(result.modalities[0]?.inputIds, [input.audio.id]); assert.equal(result.status, 'complete');
  assert.equal(content.filter((part:any)=>part.type==='image_url').length,3);
  assert.deepEqual(result.cues,[]);assert.equal(result.emotion,'neutral');
  assert.deepEqual(permit.outcomes[0]?.usage, { prompt_tokens: 22, completion_tokens: 10 });
});
test('missing frame is partial and cannot be used as invented visual evidence', async () => {
  const store = new MemoryMediaStore(), input = await captured(store, false), permit = permits();
  const options = { ...config(permit.authorizer, 'qwen3.5-omni-flash'), cueLifetimeMs: 60000 };
  const missing = await new QwenPerceptionProvider(options, store, new ProviderTransport(async () => stream(perception()))).perceive(input, signal());
  assert.equal(missing.status, 'partial'); assert.equal(missing.modalities[1]?.status, 'missing');
  await assert.rejects(new QwenPerceptionProvider(options, store, new ProviderTransport(async () => stream(perception('image')))).perceive(input, signal()), /two-field/);
});
test('single-modality Omni model and non-enum emotion are refused by combined adapter', async () => {
  const store = new MemoryMediaStore(), permit = permits();
  assert.throws(() => new QwenPerceptionProvider({ ...config(permit.authorizer, 'qwen3-omni-flash'), cueLifetimeMs: 1 }, store), /Qwen3.5/);
  const provider = new QwenPerceptionProvider({ ...config(permit.authorizer, 'qwen3.5-omni-flash'), cueLifetimeMs: 1 }, store, new ProviderTransport(async () => stream(perception('text'))));
  await assert.rejects(provider.perceive(await captured(store), signal()), /two-field/);
});
test('provider HTTP failure settles ledger without leaking body or authorization', async () => {
  const permit = permits(); const transport = new ProviderTransport(async () => new Response('test-only-key private detail', { status: 401 }));
  await assert.rejects(transport.request(config(permit.authorizer), scope, 'dialogue', {}, signal()), error => error instanceof Error && error.message === 'Provider HTTP 401');
  assert.equal(permit.outcomes[0]?.status, 'failed');
});
test('cancelled SSE does not hang waiting for a chunk or publish a partial reply', async () => {
  const permit = permits(), controller = new AbortController(); let started!: () => void;
  const opened = new Promise<void>(resolve => { started = resolve; });
  const transport = new ProviderTransport(async () => new Response(new ReadableStream({ start() { started(); } })));
  const request = transport.request(config(permit.authorizer), scope, 'perception', { stream: true }, controller.signal);
  const rejected = assert.rejects(request, { name: 'AbortError' }); await opened; controller.abort(); await rejected;
  assert.equal(permit.outcomes[0]?.status, 'cancelled');
});
test('incomplete stream is an error, never a successful short answer', async () => {
  const permit = permits(), transport = new ProviderTransport(async () => new Response('data: {"choices":[{"delta":{"content":"half"}}]}\n\n'));
  await assert.rejects(transport.request(config(permit.authorizer), scope, 'dialogue', { stream: true }, signal()), /Incomplete/);
});
test('dialogue reuses saved current user input, validates role, and does not cap reply length', async () => {
  const permit = permits(); let payload: any;
  const provider = new QwenDialogueProvider(config(permit.authorizer), new ProviderTransport(async (_url, init) => { payload = JSON.parse(String(init?.body)); return completion(reply); }));
  assert.equal((await provider.reply(dialogue(), signal())).text, reply.text);
  assert.equal(payload.messages.filter((message: any) => message.role === 'user').length, 1);
  assert.equal('max_tokens' in payload, false); assert.equal(payload.enable_thinking, false);
  const original = dialogue(); const bad: DialogueRequest = { ...original, context: { ...original.context, recent: [{ ...original.context.recent[0]!, characterId: 'sweetheart' }] } };
  await assert.rejects(provider.reply(bad, signal()), /Cross-character/); assert.equal(permit.requests.length, 1);
});
test('malformed expression or truncated dialogue is rejected', async () => {
  const permit = permits();
  await assert.rejects(new QwenDialogueProvider(config(permit.authorizer), new ProviderTransport(async () => completion({ ...reply, expression: { ...reply.expression, intensity: 8 } }))).reply(dialogue(), signal()), /intensity/);
  await assert.rejects(new QwenDialogueProvider(config(permit.authorizer), new ProviderTransport(async () => completion(reply, 'length'))).reply(dialogue(), signal()), /not completed/);
});
test('long TTS preserves all text including Unicode and stitches a single audio result', async () => {
  const text = '你😀好。'.repeat(400); const parts = splitSpeech(text); assert.equal(parts.join(''), text); assert(parts.every(part => Array.from(part).length <= 600));
  assert.equal(billedCharacters('中A文123'), 8);
  const store = new MemoryMediaStore(), permit = permits(), texts: string[] = []; let authOnDownload: unknown;
  const transport = new ProviderTransport(async (_url, init) => {
    if (init?.method === 'POST') { const payload = JSON.parse(String(init.body)); texts.push(payload.input.text); assert.equal(payload.input.instructions, '温和自然'); return Response.json({ output: { audio: { url: 'https://unit.invalid/audio.wav' } }, usage: { characters: billedCharacters(payload.input.text) } }); }
    authOnDownload = init?.headers; return new Response(waveform().slice().buffer);
  });
  const input: TtsRequest = { scope, ...reply, text };
  const result = await new QwenTtsProvider({ ...config(permit.authorizer, 'qwen3-tts-instruct-flash-2026-01-26'), voice: 'Cherry', language: 'Chinese' }, store, transport).synthesize(input, signal());
  assert.equal(texts.join(''), text); assert.equal(result.durationMs, 10 * texts.length); assert.equal(authOnDownload, undefined);
  assert.equal(inspectPcmWav(await store.read(scope, result.audio)).durationMs, result.durationMs); assert.equal(permit.requests.length, texts.length);
});
test('TTS cancellation after response cannot store or play late audio', async () => {
  const store = new MemoryMediaStore(), permit = permits(), controller = new AbortController();
  const transport = new ProviderTransport(async (_url, init) => {
    if (init?.method === 'POST') return Response.json({ output: { audio: { url: 'https://unit.invalid/audio.wav' } } });
    controller.abort(); return new Response(waveform().slice().buffer);
  });
  const provider = new QwenTtsProvider({ ...config(permit.authorizer, 'qwen3-tts-instruct-flash'), voice: 'Cherry', language: 'Chinese' }, store, transport);
  await assert.rejects(provider.synthesize({ scope, ...reply }, controller.signal), { name: 'AbortError' }); assert.equal(store.count, 0);
});
test('all memory operations remain proposals bound to original role with checked sources and versions', async () => {
  const permit = permits();
  const changes = [{ reason: '新事实', operation: { type: 'add', id: 'm3', text: '新工作', sourceIds: ['source'] } }, { reason: '变化', operation: { type: 'update', id: 'm1', expectedVersion: 2, text: '换工作', sourceIds: ['source'] } }, { reason: '重复', operation: { type: 'merge', targets: [{ id: 'm1', expectedVersion: 2 }, { id: 'm2', expectedVersion: 1 }], replacement: { id: 'm4', text: '合并', sourceIds: ['source'] } } }, { reason: '失效', operation: { type: 'soft_delete', id: 'm2', expectedVersion: 1 } }, { reason: '恢复', operation: { type: 'restore', id: 'm1', expectedVersion: 2 } }];
  const provider = new QwenMemoryMaintenanceProvider(config(permit.authorizer), new ProviderTransport(async () => completion({ changes })));
  const result = await provider.propose(memoryInput(), signal()); assert.equal(result.length, 5); assert(result.every(change => change.scope.characterId === 'friend')); assert.equal(result[0]?.operationId, 't:memory:0');
});
test('memory hallucinated source, stale version and other character are refused', async () => {
  const permit = permits();
  const provider = (operation: unknown) => new QwenMemoryMaintenanceProvider(config(permit.authorizer), new ProviderTransport(async () => completion({ changes: [{ reason: 'test', operation }] })));
  await assert.rejects(provider({ type: 'add', id: 'm3', text: 'fact', sourceIds: ['not-provided'] }).propose(memoryInput(), signal()), /unavailable source/);
  await assert.rejects(provider({ type: 'soft_delete', id: 'm1', expectedVersion: 1 }).propose(memoryInput(), signal()), /version/);
  const original = memoryInput(); const bad: MemoryMaintenanceInput = { ...original, messages: [{ ...original.messages[0]!, characterId: 'sweetheart' }] };
  await assert.rejects(provider({}).propose(bad, signal()), /Cross-character/);
});


test('memory provenance uses surviving memory IDs after source transcript expires', async () => {
  const permit = permits();
  const resultFor = (sourceIds: string[]) => new QwenMemoryMaintenanceProvider(config(permit.authorizer), new ProviderTransport(async () => completion({ changes: [{ reason: '合并有效记忆', operation: { type: 'update', id: 'm1', expectedVersion: 2, text: '有效新内容', sourceIds } }] })));
  const result = await resultFor(['m1']).propose(memoryInput(), signal());
  assert.equal(result.length, 1);
  await assert.rejects(resultFor(['source-old']).propose(memoryInput(), signal()), /unavailable source/);
});


test('dialogue receives only transcript and seven-category emotion from perception',async()=>{
 const permit=permits();let payload:any;
 const provider=new QwenDialogueProvider(config(permit.authorizer),new ProviderTransport(async(_url,init)=>{payload=JSON.parse(String(init?.body));return completion(reply);}));
 const request=dialogue();
 await provider.reply({...request,context:{...request.context,perception:{scope,transcript:'我没事',emotion:'sad',status:'complete',modalities:[],cues:[]}}},signal());
 const data=JSON.parse(payload.messages.at(-1).content);
 assert.deepEqual(data.perception,{transcript:'我没事',emotion:'sad'});
});
