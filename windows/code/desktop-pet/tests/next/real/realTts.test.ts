// NEXT-06 06-F real replay: fixed text synthesized by the real Windows SAPI voice through the
// production SapiTtsProvider + MemoryMediaStore; the WAV must decode (RIFF/PCM) with positive
// duration. Interface-only fakes cannot substitute this evidence (TESTING §4). Voice and text are
// frozen; the chosen voice name is printed as evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryMediaStore } from '../../../media/store.js';
import { inspectPcmWav } from '../../../media/wav.js';
import { SapiTtsProvider } from '../../../providers/sapi-tts.js';
import { nextScope } from '../harness.js';

const TEXT = '你好，我是Aika，今天天气不错。';
const VOICE = process.env.NEXT_REAL_TTS_VOICE ?? 'Microsoft Huihui Desktop';
const NEUTRAL = { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } as const;

test('06-F real: SAPI synthesizes the frozen text into decodable audio with positive duration', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-real-tts-'));
  try {
    const store = new MemoryMediaStore();
    const provider = new SapiTtsProvider(store, { voiceName: VOICE });
    const result = await provider.synthesize({ scope: nextScope('real-tts-1'), text: TEXT, expression: { ...NEUTRAL } }, new AbortController().signal);
    assert.equal(result.audio.mimeType, 'audio/wav');
    assert.ok(result.durationMs !== null && result.durationMs > 0, `durationMs=${result.durationMs}`);
    const bytes = await store.read(result.scope, result.audio);
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
    const wav = inspectPcmWav(bytes);
    assert.ok(wav.durationMs > 0);
    assert.equal(wav.bits, 16);
    assert.ok(wav.sampleRate >= 8000);
    console.log(`[real-tts] voice=${VOICE} bytes=${bytes.length} sampleRate=${wav.sampleRate} durationMs=${result.durationMs}`);
  } catch (error) {
    if (error instanceof Error && /voice not installed/.test(error.message)) t.skip(`voice missing on this machine: ${VOICE}`);
    else throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
