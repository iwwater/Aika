/** K65-05: TTS package loading, cloud/local adapter isolation and normalized audio delivery. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createPackageHost } from '../../plugins/host-runtime.js';
import { importPackageHost, setPackageEnablement } from '../../plugins/host-config.js';
import { QwenTtsProvider } from '../../providers/qwen-tts.js';
import { SapiTtsProvider } from '../../providers/sapi-tts.js';
import { ProviderTransport } from '../../providers/transport.js';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav } from '../../media/wav.js';
import type { TtsRequest } from '../../contracts/index.js';

const root = resolve(process.cwd());
const packageRoot = resolve(root, 'dist/next65/packages/tts');
const secrets = () => ({ has: () => false, resolve: () => null, list: () => [] });
const input: TtsRequest = { scope: { characterId: 'companion', sessionId: 'tts-session', turnId: 'tts-turn', generation: 1 }, text: '你好，世界。', expression: { emotion: 'neutral', intensity: 0, delivery: '自然', gesture: null } };

test('05-A/B: TTS package is independently loaded and exposes cloud/local adapters without STT dependencies', async () => {
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'k65-05-host-'));
  try {
    const imported = importPackageHost({ sourceRoot: packageRoot, hostRoot });
    assert.equal(imported.ok, true, JSON.stringify(imported.issues));
    assert.equal(setPackageEnablement({ hostRoot, packageId: 'com.aika.product.tts', enabled: true }).ok, true);
    const host = createPackageHost({ hostRoot, secrets: secrets() });
    const providers = await host.resolve({ pluginId: 'tts.product', capabilityId: 'tts.synthesize' });
    assert.deepEqual(providers.map(provider => provider.adapterId).sort(), ['tts.cloud', 'tts.sapi']);
    assert.equal(JSON.stringify(imported).includes('stt'), false);
    await host.close();
  } finally { rmSync(hostRoot, { recursive: true, force: true }); }
});

test('05-D/E: cloud and local TTS adapters produce scoped decodable WAV output with source-owned voices', async () => {
  const wav = pcm16Wav(Float32Array.from([0, 0.1, -0.1, 0]), 24_000);
  const cloudCalls: string[] = [];
  const transport = new ProviderTransport(async (url, init) => {
    cloudCalls.push(String(url));
    if (init?.method === 'POST') return Response.json({ output: { audio: { url: 'https://audio.example.test/fixture.wav' } }, usage: { characters: 6 }, request_id: 'tts-mock' });
    return new Response(wav.slice().buffer, { headers: { 'content-type': 'audio/wav' } });
  });
  const cloudStore = new MemoryMediaStore();
  const cloud = new QwenTtsProvider({ endpoint: 'https://tts.example.test/v1', model: 'qwen3-tts-instruct-flash', voice: 'CloudVoice', language: 'Chinese', apiKey: () => 'mock-only-key', authorizer: { async authorize() { return { async settle() {} }; } } }, cloudStore, transport);
  const cloudResult = await cloud.synthesize({ ...input, voiceId: 'CloudVoice' }, new AbortController().signal);
  assert.equal(cloudResult.audio.mimeType, 'audio/wav');
  assert.ok((cloudResult.durationMs ?? 0) > 0);
  assert.deepEqual(cloudCalls, ['https://tts.example.test/v1', 'https://audio.example.test/fixture.wav']);
  const localStore = new MemoryMediaStore();
  const local = new SapiTtsProvider(localStore, { voiceName: 'LocalVoice', execute: async job => { await writeFile(job.outPath, wav); } });
  const localResult = await local.synthesize({ ...input, voiceId: 'LocalVoice' }, new AbortController().signal);
  assert.equal(localResult.audio.mimeType, 'audio/wav');
  assert.ok((localResult.durationMs ?? 0) > 0);
  assert.equal(cloudStore.count, 1); assert.equal(localStore.count, 1);
  await cloudStore.releaseScope(input.scope); await localStore.releaseScope(input.scope);
  assert.equal(cloudStore.count, 0); assert.equal(localStore.count, 0);
});
