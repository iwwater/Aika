import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../management/helpers.js';
import { RegisteredVoiceStore } from '../../providers/registered-voices.js';
import { MINIMAX_TTS_MODEL, MINIMAX_TTS_ENDPOINT } from '../../providers/minimax-tts.js';
import { defaultManagedSettings, availableAdapters, validateManagedSettings, effectiveTrialConfiguration } from '../../management/settings.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { TrialTransport, createTrialTtsProvider } from '../../app/trial-backend.js';
import { TrialAuthorizer } from '../../app/trial-authorizer.js';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav } from '../../media/wav.js';

for (const [model, label, rate] of [[MINIMAX_TTS_MODEL, 'Turbo', 200], ['MiniMax/speech-2.8-hd', 'HD', 350]] as const) {
test(`registered ${label} survives settings restart and production factory/guard/ledger use correct voice and character price`, async t => {
  const f = await fixture(t), defaults = defaultManagedSettings(f.c);
  assert.equal(availableAdapters(f.c).some(a => a.id === 'minimax-tts'), false);
  const voices = await RegisteredVoiceStore.open(join(f.c.projectRoot, 'voices.json'));
  const voice = { voiceId: `Synthetic${label}Voice`, label: '测试音色', provider: 'dashscope' as const, endpoint: MINIMAX_TTS_ENDPOINT,
    targetModel: model, credentialRef: defaults.providers.tts.credentialRef, referenceSha256: 'a'.repeat(64), createdAt: '2026-09-11T00:00:00.000Z' };
  await voices.register(0, voice);
  const adapter = availableAdapters(f.c, voices).find(a => a.id === 'minimax-tts')!;
  assert.equal(adapter.capabilities.instructions, false);
  const changed = structuredClone(defaults);
  changed.providers.tts = { ...adapter.choices![0]!.configuration, credentialRef: voice.credentialRef };
  validateManagedSettings(changed, f.c, voices);
  for (const patch of [{ voice: 'forged' }, { model: model === MINIMAX_TTS_MODEL ? 'MiniMax/speech-2.8-hd' : MINIMAX_TTS_MODEL }, { language: 'Chinese' }, { characterMicros: 80 }]) {
    assert.throws(() => validateManagedSettings({ ...changed, providers: { ...changed.providers, tts: { ...changed.providers.tts, ...patch } } }, f.c, voices));
  }
  const filename = join(f.c.projectRoot, 'settings.json'), settings = await ManagementSettingsStore.open(filename, f.c, voices);
  await settings.save(0, changed);
  const reopened = await ManagementSettingsStore.open(filename, f.c, voices);
  assert.deepEqual(reopened.effective, changed); assert.equal(reopened.snapshot().pending, false);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).history[0].settings, defaults);
  const effective = effectiveTrialConfiguration(f.c, reopened.effective);
  for (const slot of ['dialogue', 'memory_turn', 'summary', 'admission', 'perception'] as const) assert.deepEqual(effective.models[slot], f.c.models[slot]);
  const authorizer = new TrialAuthorizer(effective, f.configFile, f.activationFile, f.c);
  const media = new MemoryMediaStore(), wav = pcm16Wav(new Float32Array(24), 24000); let posts = 0, keys = 0;
  const transport = new TrialTransport(effective, async (_url, init) => {
    posts++; assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, model);
    assert.equal(body.input.text, '你好A🙂'); assert.equal(body.input.voice_setting.voice_id, voice.voiceId);
    assert.equal(body.input.voice_setting.emotion, undefined); assert.equal(body.input.instructions, undefined);
    assert.equal(JSON.parse(await readFile(f.c.budgetFile, 'utf8')).entries.at(-1).reservedMicros, 2400 * rate);
    return Response.json({ output: { base_resp: { status_code: 0 }, data: { status: 2, audio: Buffer.from(wav).toString('hex') } }, usage: { characters: 4 } });
  });
  const endpoint = { ...effective.models.tts, apiKey: () => { keys++; return 'synthetic-key'; }, authorizer };
  const provider = createTrialTtsProvider(changed.providers.tts, endpoint, media, transport, voices);
  const scope = { characterId: 'companion' as const, sessionId: 'synthetic', turnId: 'tts', generation: 1 };
  const expression = { emotion: 'warm' as const, intensity: .4, delivery: '（微笑）轻轻说', gesture: 'wave' };
  const result = await provider.synthesize({ scope, text: '你好A🙂', expression }, new AbortController().signal);
  assert.deepEqual(result.expression, expression); assert.equal(result.synchronization, 'amplitude');
  assert.deepEqual(await media.read(scope, result.audio), wav); await media.releaseScope(scope); assert.equal(media.count, 0);
  const ledger = JSON.parse(await readFile(f.c.budgetFile, 'utf8'));
  assert.equal(ledger.entries.at(-1).actualMicros, 4 * rate); assert.deepEqual(ledger.entries[0], f.historical);
  assert.deepEqual([posts, keys], [1, 1]);
  const body = { input: { text: '中', voice_setting: { voice_id: voice.voiceId, speed: 1, vol: 1, pitch: 0 }, audio_setting: { sample_rate: 24000, format: 'wav', channel: 1 }, output_format: 'hex', language_boost: 'Chinese' } };
  await assert.rejects(transport.request(endpoint, scope, 'tts', body, new AbortController().signal, 2), /bounds/);
  await assert.rejects(transport.request(endpoint, scope, 'tts', { input: { ...body.input, action: 'voice_clone' } }, new AbortController().signal, 3), /bounds/);
  await assert.rejects(transport.request(endpoint, scope, 'tts', { input: { ...body.input, output_format: 'url' } }, new AbortController().signal, 3), /bounds/);
  assert.deepEqual([posts, keys], [1, 1]);
});

}
