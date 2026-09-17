import test from 'node:test';
import assert from 'node:assert/strict';
import type { TtsRequest } from '../../contracts/index.js';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav } from '../../media/wav.js';
import { QwenTtsProvider } from '../../providers/qwen-tts.js';
import { type CallOutcome, ProviderTransport } from '../../providers/transport.js';

const input: TtsRequest = { scope: { characterId: 'friend', sessionId: 's', turnId: 'tts-url', generation: 1 }, text: '我在。', expression: { emotion: 'calm', intensity: .4, delivery: '温和自然', gesture: null } };
// Deliberately synthetic signature: escaping, duplicate keys and order must survive normalization.
const suffix = '/output/fixture%20audio.wav?Expires=0&OSSAccessKeyId=fixture&Signature=a%2Bb%2fc%3D&x=a+b&x=%2f';
function harness(uri: string, options: { afterSettle?: () => void; downloadStatus?: number } = {}) {
  const store = new MemoryMediaStore(), outcomes: CallOutcome[] = [], calls: { uri: string; init: RequestInit | undefined }[] = [];
  const transport = new ProviderTransport(async (url, init) => {
    calls.push({ uri: String(url), init });
    if (init?.method === 'POST') return Response.json({ output: { audio: { url: uri } }, usage: { characters: 5 }, request_id: 'synthetic' });
    if (options.downloadStatus) return new Response('synthetic download failure', { status: options.downloadStatus });
    return new Response(pcm16Wav(Float32Array.from([0, .2, -.2]), 24000).slice().buffer);
  });
  const provider = new QwenTtsProvider({ endpoint: 'https://unit.invalid/tts', model: 'qwen3-tts-instruct-flash-2026-01-26', voice: 'Cherry', language: 'Chinese', apiKey: () => 'test-only-key', authorizer: { async authorize() { return { async settle(outcome) { outcomes.push(outcome); options.afterSettle?.(); } }; } } }, store, transport);
  return { provider, store, outcomes, calls };
}

test('Qwen official OSS HTTP results use HTTPS while preserving the signed path and query', async () => {
  for (const host of ['dashscope-a717.oss-cn-beijing.aliyuncs.com', 'dashscope-result-bj.oss-cn-beijing.aliyuncs.com', 'dashscope-result-wlcb.oss-cn-wulanchabu.aliyuncs.com']) {
    for (const port of ['', ':80']) {
      const run = harness(`http://${host}${port}${suffix}`);
      const result = await run.provider.synthesize(input, new AbortController().signal);
      assert.equal(result.audio.mimeType, 'audio/wav');
      assert.equal(run.calls.length, 2);
      assert.equal(run.calls[1]?.uri, `https://${host}${suffix}`);
      assert.equal(new Headers(run.calls[0]?.init?.headers).get('Authorization'), 'Bearer test-only-key');
      assert.equal(run.calls[1]?.init?.headers, undefined);
      assert.equal(run.calls[1]?.init?.body, undefined);
      assert.equal(run.calls[1]?.init?.redirect, 'error');
      assert.deepEqual(run.outcomes, [{ status: 'success', usage: { characters: 5 }, requestId: 'synthetic' }]);
      await run.store.releaseScope(input.scope);
    }
  }
});

test('already HTTPS TTS result is passed byte-for-byte to unauthenticated download', async () => {
  const uri = `https://unit.invalid${suffix}`, run = harness(uri);
  await run.provider.synthesize(input, new AbortController().signal);
  assert.equal(run.calls[1]?.uri, uri); assert.equal(run.calls[1]?.init?.headers, undefined);
  await run.store.releaseScope(input.scope);
});

test('unsupported HTTP URLs cannot trigger download or an automatic paid retry', async () => {
  const host = 'dashscope-a717.oss-cn-beijing.aliyuncs.com';
  for (const uri of [
    `http://unit.invalid${suffix}`, `http://${host}.unit.invalid${suffix}`,
    `http://other.oss-cn-beijing.aliyuncs.com${suffix}`, `http://dashscope-a717.oss-us-west-1.aliyuncs.com${suffix}`,
    `http://user@${host}${suffix}`, `http://${host}:443${suffix}`, `http://${host}:8080${suffix}`,
    `http://${host}${suffix}#fragment`, `http://${host}\\unit.invalid/audio.wav`,
    `http://${host}\n${suffix}`, `ftp://${host}${suffix}`, 'malformed synthetic signed URL',
  ]) {
    const run = harness(uri);
    await assert.rejects(run.provider.synthesize(input, new AbortController().signal), { message: 'Invalid provider audio URL' });
    assert.equal(run.calls.length, 1); assert.equal(run.store.count, 0);
    // Generation succeeded before validation failed; its usage must stay in the common ledger.
    assert.equal(run.outcomes.length, 1); assert.equal(run.outcomes[0]?.status, 'success');
    assert.deepEqual(run.outcomes[0]?.usage, { characters: 5 });
  }
});

test('generic audio transport keeps its HTTPS-only contract', async () => {
  let calls = 0;
  const transport = new ProviderTransport(async () => { calls++; throw new Error('Unexpected download'); });
  await assert.rejects(transport.downloadAudio(`http://dashscope-a717.oss-cn-beijing.aliyuncs.com${suffix}`, new AbortController().signal), /Invalid provider audio URL/);
  assert.equal(calls, 0);
});

test('cancellation after billed generation prevents normalized audio download', async () => {
  const controller = new AbortController();
  const run = harness(`http://dashscope-a717.oss-cn-beijing.aliyuncs.com${suffix}`, { afterSettle: () => controller.abort() });
  await assert.rejects(run.provider.synthesize(input, controller.signal), { name: 'AbortError' });
  assert.equal(run.calls.length, 1); assert.equal(run.store.count, 0);
  assert.equal(run.outcomes[0]?.status, 'success');
});

test('HTTPS download failure retains generation usage and performs no HTTP fallback or retry', async () => {
  const run = harness(`http://dashscope-a717.oss-cn-beijing.aliyuncs.com${suffix}`, { downloadStatus: 403 });
  await assert.rejects(run.provider.synthesize(input, new AbortController().signal), /Audio download HTTP 403/);
  assert.equal(run.calls.length, 2); assert.equal(run.store.count, 0);
  assert.equal(run.outcomes[0]?.status, 'success'); assert.deepEqual(run.outcomes[0]?.usage, { characters: 5 });
});
