import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from '../management/helpers.js';
import { RegisteredVoiceStore, type RegisteredVoice } from '../../providers/registered-voices.js';
import { availableAdapters, defaultManagedSettings, validateManagedSettings, effectiveTrialConfiguration } from '../../management/settings.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { createTrialTtsProvider } from '../../app/trial-backend.js';
import { ProviderTransport } from '../../providers/transport.js';
import { MemoryMediaStore } from '../../media/store.js';
import { inspectPcmWav } from '../../media/wav.js';

async function setup(t: Parameters<typeof fixture>[0]) {
  const { c } = await fixture(t), defaults = defaultManagedSettings(c);
  const voices = await RegisteredVoiceStore.open(resolve(c.projectRoot, 'registered-voices.json'));
  const voice: RegisteredVoice = { voiceId: 'qwen-audio-3.0-tts-plus-dania-synthetic', label: '达妮娅（复刻）',
    provider: 'dashscope', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    targetModel: 'qwen-audio-3.0-tts-plus', credentialRef: defaults.providers.tts.credentialRef,
    referenceSha256: 'a'.repeat(64), createdAt: '2026-09-11T00:00:00.000Z' };
  await voices.register(0, voice);
  const choice = availableAdapters(c, voices).find(a => a.id === 'qwen-audio-tts')!.choices!.find(v => v.configuration.model === voice.targetModel)!;
  const settings = structuredClone(defaults); settings.providers.tts = { ...choice.configuration, credentialRef: voice.credentialRef, voice: voice.voiceId };
  return { c, defaults, voices, voice, settings };
}

test('registered example-voice appears only for its model and survives settings save/restart with old settings retained', async t => {
  const { c, defaults, voices, voice, settings } = await setup(t);
  const choices = availableAdapters(c, voices).find(a => a.id === 'qwen-audio-tts')!.choices!;
  assert.ok(choices.find(v => v.configuration.model === voice.targetModel)!.voices!.some(v => v.id === voice.voiceId));
  assert.ok(!choices.find(v => v.configuration.model.endsWith('flash'))!.voices!.some(v => v.id === voice.voiceId));
  const file = resolve(c.projectRoot, 'settings.json'), store = await ManagementSettingsStore.open(file, c, voices);
  const saved = await store.save(0, settings); assert.equal(saved.pending, true); assert.deepEqual(saved.effective, defaults);
  const reopened = await ManagementSettingsStore.open(file, c, await RegisteredVoiceStore.open(voices.file));
  assert.equal(reopened.snapshot().pending, false); assert.equal(reopened.effective.providers.tts.voice, voice.voiceId);
  assert.deepEqual(reopened.effective.context, defaults.context);
  const effective = effectiveTrialConfiguration(c, reopened.effective);
  for (const slot of ['dialogue', 'memory_turn', 'summary', 'perception', 'admission'] as const) assert.deepEqual(effective.models[slot], c.models[slot]);
  assert.equal(effective.models.tts.characterMicros, 140); assert.equal(effective.models.tts.reservationMicros, 400000);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).history[0].settings, defaults);
});

test('settings reject unknown IDs and a registered voice used with another existing credential, model or endpoint', async t => {
  const { c, voices, settings } = await setup(t);
  const alternate = { ...c, models: { ...c.models, dialogue: { ...c.models.dialogue, credentialFile: '/nonexistent-other-dashscope-key' } } };
  const alternateRef = defaultManagedSettings(alternate).providers.dialogue.credentialRef;
  for (const override of [{ voice: 'qwen-audio-3.0-tts-plus-dania-forged' }, { model: 'qwen-audio-3.0-tts-flash' },
    { endpoint: 'https://wrong.invalid/tts' }, { credentialRef: alternateRef }]) {
    assert.throws(() => validateManagedSettings({ ...settings, providers: { ...settings.providers, tts: { ...settings.providers.tts, ...override } } }, alternate, voices));
  }
  assert.throws(() => validateManagedSettings(settings, c));
});

test('real retained example-voice sample traverses production factory with exact voice/zh binding and unchanged PCM, without network', async t => {
  const directory = process.env.DANIA_RETAINED_SAMPLE;
  if (!directory) { t.skip('Explicit retained provider evidence directory required'); return; }
  const { c, voices, settings } = await setup(t);
  const evidence = JSON.parse(await readFile(resolve(directory, 'execution.json'), 'utf8'));
  const original = await readFile(resolve(directory, 'sample-original.bin'));
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(original), evidence.rawAudio.sha256);
  // Actual receipt metadata is copied into a synthetic registry; actual user state is never opened.
  const registration = { ...evidence.registration, credentialRef: settings.providers.tts.credentialRef } as RegisteredVoice;
  await voices.register(1, registration); settings.providers.tts.voice = registration.voiceId;
  validateManagedSettings(settings, c, voices);
  const media = new MemoryMediaStore(); let posts = 0, downloads = 0, settlements = 0;
  const selection = settings.providers.tts;
  const provider = createTrialTtsProvider(selection, { model: selection.model, endpoint: selection.endpoint,
    apiKey: () => 'synthetic-only', authorizer: { async authorize() { return { async settle(outcome) { settlements++; assert.deepEqual(outcome.usage, { characters: 51 }); } }; } } }, media,
  new ProviderTransport(async (url, init) => {
    if (init?.method === 'POST') {
      posts++; assert.equal(url, registration.endpoint);
      assert.deepEqual(JSON.parse(String(init.body)), { model: registration.targetModel, input: { text: evidence.sample.text,
        voice: registration.voiceId, format: 'wav', sample_rate: 24000, instruction: '自然温和，像日常聊天一样说话。', language_hints: ['zh'] } });
      return Response.json({ output: { finish_reason: 'stop', audio: { url: 'https://synthetic.invalid/retained.wav' } }, usage: { characters: 51 } });
    }
    downloads++; assert.equal(init?.headers, undefined); return new Response(new Uint8Array(original));
  }), voices);
  const scope = { characterId: 'companion' as const, sessionId: 'synthetic', turnId: 'dania', generation: 1 };
  const input = { scope, text: evidence.sample.text as string, expression: { emotion: 'calm' as const, intensity: .4,
    delivery: '自然温和，像日常聊天一样说话。', gesture: null } };
  await assert.rejects(provider.synthesize({ ...input, voiceId: 'qwen-audio-3.0-tts-plus-dania-forged' }, new AbortController().signal));
  assert.equal(posts, 0);
  const result = await provider.synthesize(input, new AbortController().signal), audio = await media.read(scope, result.audio);
  assert.equal(digest(audio), evidence.sample.sha256); assert.equal(digest(inspectPcmWav(audio).data), evidence.sample.pcmSha256);
  assert.equal(digest(original), evidence.rawAudio.sha256); assert.equal(result.durationMs, 6400);
  assert.deepEqual([posts, downloads, settlements], [1, 1, 1]); await media.releaseScope(scope); assert.equal(media.count, 0);
});
