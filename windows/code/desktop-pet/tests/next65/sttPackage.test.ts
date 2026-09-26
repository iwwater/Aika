/** K65-06: STT package loading, cloud batch isolation and local streaming lifecycle. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createPackageHost } from '../../plugins/host-runtime.js';
import { importPackageHost, setPackageEnablement } from '../../plugins/host-config.js';
import { QwenAsrProvider, QWEN_ASR_MODEL } from '../../providers/qwen-asr.js';
import { SherpaStreamingAsr } from '../../providers/sherpa-streaming-asr.js';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav } from '../../media/wav.js';

const root = resolve(process.cwd());
const packageRoot = resolve(root, 'dist/next65/packages/stt');
const scope = { characterId: 'companion' as const, sessionId: 'stt-session', turnId: 'stt-turn', generation: 1 };
const secrets = () => ({ has: () => false, resolve: () => null, list: () => [] });

test('06-A/E: STT package exposes cloud batch and local streaming adapters without TTS dependencies', async () => {
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'k65-06-host-'));
  try {
    const imported = importPackageHost({ sourceRoot: packageRoot, hostRoot });
    assert.equal(imported.ok, true, JSON.stringify(imported.issues));
    assert.equal(setPackageEnablement({ hostRoot, packageId: 'com.aika.product.stt', enabled: true }).ok, true);
    const host = createPackageHost({ hostRoot, secrets: secrets() });
    const providers = await host.resolve({ pluginId: 'stt.product', capabilityId: 'stt.transcribe' });
    assert.deepEqual(providers.map(provider => provider.adapterId).sort(), ['stt.cloud.batch', 'stt.local.streaming']);
    assert.equal(JSON.stringify(imported).includes('tts'), false);
    await host.close();
  } finally { rmSync(hostRoot, { recursive: true, force: true }); }
});

test('06-A/E: cloud batch transcribes a scoped WAV while local streaming emits partial/final once and cancels cleanly', async () => {
  const wav = pcm16Wav(Float32Array.from([0, 0.1, -0.1, 0]), 16_000);
  const cloudStore = new MemoryMediaStore();
  let cloudCalls = 0;
  const cloud = new QwenAsrProvider({ endpoint: 'https://asr.example.test/v1', model: QWEN_ASR_MODEL, apiKey: () => 'mock-only-key', authorizer: { async authorize() { return { async settle() {} }; } } }, cloudStore, {
    async request(_config, actualScope, operation, body) {
      cloudCalls += 1;
      assert.deepEqual(actualScope, scope); assert.equal(operation, 'asr'); assert.equal(body.stream, false);
      return { choices: [{ finish_reason: 'stop', message: { content: '你好，世界。' } }] };
    },
  });
  const audio = await cloudStore.put(scope, wav, 'audio/wav');
  const result = await cloud.transcribe({ scope, audio }, new AbortController().signal);
  assert.equal(result.transcript, '你好，世界。'); assert.equal(cloudCalls, 1);
  await cloudStore.releaseScope(scope); assert.equal(cloudStore.count, 0);

  const workerDir = mkdtempSync(resolve(tmpdir(), 'k65-06-worker-'));
  const workerPath = resolve(workerDir, 'fixture-worker.mjs');
  await writeFile(workerPath, `import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ ready: true });
parentPort.on('message', message => {
  if (message.type === 'open') parentPort.postMessage({ id: message.id });
  else if (message.type === 'push') { parentPort.postMessage({ id: message.id }); parentPort.postMessage({ type: 'partial', streamId: message.streamId, index: 0, revision: 1, segmentId: 'seg-0', text: '你好' }); }
  else if (message.type === 'finish') { parentPort.postMessage({ type: 'final', streamId: message.streamId, index: 0, revision: 2, segmentId: 'seg-0', text: '你好世界' }); parentPort.postMessage({ id: message.id }); }
  else if (message.type === 'cancel') parentPort.postMessage({ id: message.id });
});\n`, 'utf8');
  const local = new SherpaStreamingAsr({ encoder: 'fixture.encoder', decoder: 'fixture.decoder', joiner: 'fixture.joiner', tokens: 'fixture.tokens', workerUrl: pathToFileURL(workerPath), openTimeoutMs: 2_000, callTimeoutMs: 2_000 });
  const events: string[] = [];
  local.subscribe(event => { if (event.type === 'partial' || event.type === 'final') events.push(`${event.type}:${event.segment.text}`); });
  try {
    await local.openStream(scope, 16_000);
    await local.push(scope, new Uint8Array([0, 0, 1, 0]), 16_000);
    await local.finish(scope);
    assert.deepEqual(events, ['partial:你好', 'final:你好世界']);
    await local.openStream({ ...scope, turnId: 'cancelled-turn' }, 16_000);
    await local.cancel({ ...scope, turnId: 'cancelled-turn' });
    assert.deepEqual(events, ['partial:你好', 'final:你好世界']);
  } finally { await local.close(); rmSync(workerDir, { recursive: true, force: true }); }
});
