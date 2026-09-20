// NEXT-06: SapiTtsProvider orchestration with the OS synthesizer replaced by an injected job
// runner; the real PowerShell synthesis path is proven separately in tests/next/real (06-F).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pcm16Wav } from '../../media/wav.js';
import { renderSapiScript, SapiTtsProvider, type SapiSynthesisJob } from '../../providers/sapi-tts.js';
import type { MediaStorePort, MediaAsset, TtsRequest } from '../../contracts/index.js';
import { nextScope } from './harness.js';

const NEUTRAL = { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } as const;
const HALF_SECOND = pcm16Wav(new Float32Array(8000).fill(0.1), 16000);

interface PutRecord { scope: unknown; bytes: Uint8Array; mimeType: string }

function fakeStore() {
  const puts: PutRecord[] = [];
  const store: MediaStorePort = {
    async put(scope, bytes, mimeType) {
      puts.push({ scope, bytes, mimeType });
      const asset: MediaAsset = { id: `asset-${puts.length}`, uri: `mem://asset-${puts.length}`, mimeType, temporary: true };
      return asset;
    },
    async read() { return new Uint8Array(); },
    async releaseScope() {}
  };
  return { store, puts };
}

function request(text: string, scope = nextScope('tts-1')): TtsRequest {
  return { scope, text, expression: { ...NEUTRAL } };
}

test('06-F contract: empty reply is refused before any synthesis job runs', async () => {
  const { store, puts } = fakeStore();
  let jobs = 0;
  const provider = new SapiTtsProvider(store, { execute: async () => { jobs++; } });
  await assert.rejects(provider.synthesize(request('   '), new AbortController().signal), /empty/);
  assert.equal(jobs, 0);
  assert.equal(puts.length, 0);
});

test('06-F contract: synthesized WAV is validated, stored and returned with its duration', async () => {
  const { store, puts } = fakeStore();
  const jobs: SapiSynthesisJob[] = [];
  const provider = new SapiTtsProvider(store, {
    voiceName: 'Microsoft Huihui Desktop',
    execute: async job => {
      jobs.push(job);
      await writeFile(job.outPath, HALF_SECOND);
    }
  });
  const result = await provider.synthesize(request('你好。'), new AbortController().signal);
  assert.equal(jobs.length, 1);
  assert.equal(result.audio.mimeType, 'audio/wav');
  assert.equal(result.durationMs, 500);
  assert.equal(result.synchronization, 'none');
  assert.deepEqual(result.expression, { ...NEUTRAL });
  assert.equal(puts.length, 1);
  assert.equal(puts[0]!.mimeType, 'audio/wav');
  assert.deepEqual([...puts[0]!.bytes], [...HALF_SECOND]);
});

test('06-F contract: a failed synthesis job surfaces its error and stores nothing', async () => {
  const { store, puts } = fakeStore();
  const provider = new SapiTtsProvider(store, { execute: async () => { throw new Error('SAPI synthesis failed (exit 1): voice not installed'); } });
  await assert.rejects(provider.synthesize(request('你好。'), new AbortController().signal), /voice not installed/);
  assert.equal(puts.length, 0);
});

test('06-F contract: an already-aborted signal refuses before the job runs', async () => {
  const { store, puts } = fakeStore();
  let jobs = 0;
  const provider = new SapiTtsProvider(store, { execute: async () => { jobs++; } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.synthesize(request('你好。'), controller.signal));
  assert.equal(jobs, 0);
  assert.equal(puts.length, 0);
});

test('06-F contract: the rendered script quotes paths, pins the voice and never embeds the text', async () => {
  const job: SapiSynthesisJob = { textPath: 'C:\\temp\\n ext\\text.txt', outPath: 'C:\\temp\\n ext\\speech.wav', voiceName: 'Microsoft Huihui Desktop' };
  const script = renderSapiScript(job);
  assert.match(script, /-LiteralPath 'C:\\temp\\n ext\\text\.txt'/);
  assert.match(script, /SetOutputToWaveFile\('C:\\temp\\n ext\\speech\.wav'/);
  assert.match(script, /SelectVoice\('Microsoft Huihui Desktop'\)/);
  assert.match(script, /SpeechAudioFormatInfo\(16000, \[System\.Speech\.AudioFormat\.AudioBitsPerSample\]::Sixteen/);
  assert.doesNotMatch(script, /Speak\('/);
  const unnamed = renderSapiScript({ textPath: job.textPath, outPath: job.outPath });
  assert.doesNotMatch(unnamed, /SelectVoice/);
});
