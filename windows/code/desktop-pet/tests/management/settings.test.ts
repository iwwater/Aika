import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { isPrivateFileSync } from '../../core/platform-files.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { defaultManagedSettings, validateManagedSettings, effectiveTrialConfiguration, availableAdapters } from '../../management/settings.js';
import { TrialAuthorizer } from '../../app/trial-authorizer.js';
import { TrialTransport, createTrialTtsProvider } from '../../app/trial-backend.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav } from '../../media/wav.js';

test('saved settings remain pending until reopen, reject stale writers and support persistent rollback', async t => {
  const f = await fixture(t), file = join(f.c.projectRoot, 'management-settings.json');
  const store = await ManagementSettingsStore.open(file, f.c), original = store.snapshot();
  const changed = structuredClone(original.saved); changed.context.maxMemories = 9; changed.providers.tts.voice = 'Serena';
  const activeBytes = await readFile(f.configFile, 'utf8');
  const outcomes = await Promise.allSettled([store.save(0, changed), store.save(0, original.saved)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(store.snapshot().pending, true); assert.deepEqual(store.snapshot().effective, original.effective);
  assert.equal(await readFile(f.configFile, 'utf8'), activeBytes);
  // FIX61-10: POSIX privacy is mode bits; Windows privacy is the SID ACL checked by isPrivateFileSync
  // (libuv reports 0o666 regardless). Assert the platform-correct invariant.
  if (process.platform==='win32') assert.equal(isPrivateFileSync(file),true);
  else assert.equal((await stat(file)).mode & 0o777, 0o600);
  const reopened = await ManagementSettingsStore.open(file, f.c);
  assert.equal(reopened.snapshot().pending, false); assert.equal(reopened.effective.context.maxMemories, 9);
  assert.equal(reopened.effective.providers.tts.voice, 'Serena');
  const rollback = await reopened.rollback(1, 0); assert.equal(rollback.revision, 2); assert.equal(rollback.pending, true);
  const afterRollback = await ManagementSettingsStore.open(file, f.c); assert.deepEqual(afterRollback.effective, validateManagedSettings(original.saved, f.c));
});

test('custom models accepted on allowed endpoints; capability and credential boundaries still enforced', async t => {
  const f = await fixture(t), original = defaultManagedSettings(f.c);
  // Semantic change (FIX61-01): a model name not present in any catalog is now accepted on a supported
  // HTTPS endpoint with a valid credential ref. The old "unknown model rejected" boundary is replaced by
  // capability + budget boundaries below.
  const custom = structuredClone(original);
  custom.providers.dialogue.model = 'my-custom-model-2026';
  custom.providers.dialogue.endpoint = 'https://my-llm.example.com/v1/chat/completions';
  validateManagedSettings(custom, f.c);
  for (const mutate of [
    (v: typeof original) => { v.providers.dialogue.credentialRef = '/etc/passwd'; },
    (v: typeof original) => { v.providers.dialogue.endpoint = 'http://attacker.invalid'; },
    (v: typeof original) => { v.providers.dialogue.inputMicrosPerToken = -1; },
    (v: typeof original) => { v.providers.summary.temperature = 1; },
    (v: typeof original) => { v.providers.tts.inputTokenLimit = -1; },
    (v: typeof original) => { v.providers.dialogue.thinking = 'high'; },
  ]) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => validateManagedSettings(value, f.c), { code: 'invalid_request' });
  }
  assert.equal(JSON.stringify(original).includes('credentialFile'), false);
  const sharedPath = { ...f.c, models: { ...f.c.models, memory_turn: { ...f.c.models.memory_turn, credentialFile: f.c.models.dialogue.credentialFile } } };
  const sharedSettings = defaultManagedSettings(sharedPath);
  assert.notEqual(sharedSettings.providers.dialogue.credentialRef, sharedSettings.providers.memory_turn.credentialRef);
  validateManagedSettings(sharedSettings, sharedPath);
});

test('pending settings do not revoke ongoing permits; effective fees and original authorization remain distinct', async t => {
  const f = await fixture(t), store = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const effective = effectiveTrialConfiguration(f.c, store.effective);
  const authorizer = new TrialAuthorizer(effective, f.configFile, f.activationFile, f.c);
  const request = { scope: { characterId: 'companion' as const, sessionId: 'test', turnId: 'turn', generation: 1 }, operation: 'dialogue' as const,
    model: effective.models.dialogue.model, endpoint: effective.models.dialogue.endpoint };
  const permit = await authorizer.authorize(request, new AbortController().signal);
  const changed = store.snapshot().saved; changed.context.maxRecentMessages = 8;
  await store.save(0, changed);
  await permit.settle({ status: 'success', usage: { prompt_tokens: 100, completion_tokens: 100 }, requestId: null });
  const second = await authorizer.authorize(request, new AbortController().signal);
  await second.settle({ status: 'success', usage: { prompt_tokens: 1, completion_tokens: 1 }, requestId: null });
  const ledger = JSON.parse(await readFile(f.c.budgetFile, 'utf8'));
  assert.deepEqual(ledger.entries[0], f.historical); assert.equal(ledger.entries[1].actualMicros, 280);
  await f.activate('stopped');
  await assert.rejects(authorizer.authorize(request, new AbortController().signal));
});

test('usable choices validate; MiniMax setup presets without registered voices and mismatched fees are rejected', async t => {
  const f = await fixture(t), original = defaultManagedSettings(f.c);
  for (const adapter of availableAdapters(f.c)) for (const slot of adapter.slots) for (const choice of adapter.choices ?? []) {
    const changed = structuredClone(original);
    changed.providers[slot] = { ...choice.configuration, credentialRef: original.providers[slot]!.credentialRef };
    if(adapter.id==='minimax-tts'&&!choice.voices?.length)assert.throws(()=>validateManagedSettings(changed,f.c),{code:'invalid_request'});
    else validateManagedSettings(changed, f.c);
  }
  const adapter = availableAdapters(f.c).find(a => a.id === 'qwen-audio-tts')!;
  const changed = structuredClone(original);
  changed.providers.tts = { ...adapter.choices![0]!.configuration, credentialRef: original.providers.tts.credentialRef };
  for (const patch of [{ voice: 'Cherry' }, { language: 'Chinese' }]) {
    const forged = structuredClone(changed); Object.assign(forged.providers.tts, patch);
    assert.throws(() => validateManagedSettings(forged, f.c), { code: 'invalid_request' });
  }
  // FIX61-10: a registered choice's per-unit tariff is a LEDGER FLOOR — declaring a higher rate is
  // allowed, but a lower one would understate reserved/actual cost, so it is rejected exactly like
  // an exceeded token bound. reservationMicros (a self-declared prepayment) stays user-controlled.
  for (const patch of [{ reservationMicros: 100000 }]) {
    const forged = structuredClone(changed); Object.assign(forged.providers.tts, patch);
    validateManagedSettings(forged, f.c);
  }
  for (const patch of [{ characterMicros: 80 }]) {
    const forged = structuredClone(changed); Object.assign(forged.providers.tts, patch);
    assert.throws(() => validateManagedSettings(forged, f.c), { code: 'invalid_request' });
  }
});

test('effective QwenAudio factory and real trial transport reserve and settle the matching character tariff', async t => {
  const f = await fixture(t), settings = defaultManagedSettings(f.c);
  settings.providers.tts = { ...availableAdapters(f.c).find(a => a.id === 'qwen-audio-tts')!.choices![0]!.configuration,
    credentialRef: settings.providers.tts.credentialRef };
  const effective = effectiveTrialConfiguration(f.c, validateManagedSettings(settings, f.c));
  const authorizer = new TrialAuthorizer(effective, f.configFile, f.activationFile, f.c), runtime = new ManagementRuntime(f.c.sourceRevision);
  const calls: { url: string; body: unknown }[] = [];
  const transport = new TrialTransport(effective, async (url, init) => {
    if (init?.method !== 'POST') return new Response(pcm16Wav(new Float32Array(8), 24000).slice().buffer);
    const body = JSON.parse(String(init.body)); calls.push({ url: String(url), body });
    const ledger = JSON.parse(await readFile(f.c.budgetFile, 'utf8'));
    assert.equal(ledger.entries.at(-1).reservedMicros, 400000);
    assert.equal(ledger.entries.at(-1).model, settings.providers.tts.model);
    return Response.json({ output: { finish_reason: 'stop', audio: { url: 'https://synthetic.invalid/audio.wav' } }, usage: { characters: 9 } });
  }, runtime);
  const store = new MemoryMediaStore(), endpoint = { ...effective.models.tts, apiKey: () => 'synthetic-key', authorizer };
  const provider = createTrialTtsProvider(settings.providers.tts, endpoint, store, transport);
  const scope = { characterId: 'companion' as const, sessionId: 'test', turnId: 'tts', generation: 1 };
  const input = { scope, text: '中A文123。', expression: { emotion: 'calm' as const, intensity: .4, delivery: '自然温和', gesture: null } };
  await provider.synthesize(input, new AbortController().signal);
  assert.deepEqual(calls, [{ url: settings.providers.tts.endpoint, body: { model: settings.providers.tts.model,
    input: { text: input.text, voice: 'longanfengyue', format: 'wav', sample_rate: 24000, instruction: '自然温和' } } }]);
  const ledger = JSON.parse(await readFile(f.c.budgetFile, 'utf8'));
  assert.equal(ledger.entries.at(-1).actualMicros, 900); assert.deepEqual(ledger.entries[0], f.historical);
  assert.equal(runtime.modules().find(m => m.id === 'tts')?.calls, 1);
  await assert.rejects(transport.request(endpoint, scope, 'tts', { input: { text: '中', instruction: '中'.repeat(534) } }, new AbortController().signal, 2), /bounds/);
  assert.equal(calls.length, 1); await store.releaseScope(scope);
});

test('Plus and Pro reservation conflict refuses before network without provider failure, stage stop or ledger reset', async t => {
  const f = await fixture(t), settings = defaultManagedSettings(f.c);
  // FIX61-10 reorder: the background memory_turn is authorized and SETTLED first (its actual cost is
  // small), so the ledger then holds only the historical entry plus that settled amount. Switching
  // perception to omni-plus afterwards makes the FOREGROUND request exceed the shared 20M ledger —
  // refused before any network call, which is exactly the pinned behavior.
  const baseEffective = effectiveTrialConfiguration(f.c, validateManagedSettings(settings, f.c));
  const authorizer = new TrialAuthorizer(baseEffective, f.configFile, f.activationFile, f.c), runtime = new ManagementRuntime(f.c.sourceRevision);
  const scope = { characterId: 'companion' as const, sessionId: 'test', turnId: 'plus', generation: 1 };
  const pending = await authorizer.authorize({ scope, operation: 'memory_turn', ...baseEffective.models.memory_turn }, new AbortController().signal);
  const choice = availableAdapters(f.c).find(a => a.id === 'qwen-perception')!.choices!.find(c => c.configuration.model.includes('omni-plus'))!;
  settings.providers.perception = { ...choice.configuration, credentialRef: settings.providers.perception.credentialRef };
  const effective = effectiveTrialConfiguration(f.c, validateManagedSettings(settings, f.c));
  // The authorizer keeps the flash configuration as its consistency guard (request vs registered
  // model), so the plus perception request must ride a NEW authorizer built on the plus-effective
  // configuration — the ledger conflict is what this test pins, not a config mismatch.
  const plusAuthorizer = new TrialAuthorizer(effective, f.configFile, f.activationFile, f.c);
  let posts = 0;
  const transport = new TrialTransport(effective, async () => { posts++; throw new Error('Must not send'); }, runtime);
  await assert.rejects(transport.request({ ...effective.models.perception, apiKey: () => 'synthetic-key', authorizer: plusAuthorizer }, scope,
    'perception', { messages: [] }, new AbortController().signal), /budget|exhausted/);
  assert.equal(posts, 0);
  const observed = runtime.modules().find(m => m.id === 'perception')!;
  assert.equal(observed.calls, 0); assert.equal(observed.status, 'unavailable'); assert.match(observed.detail, /调用未发送.*额度不足/);
  assert.ok(runtime.recentEvents().every(e => e.kind !== 'failed' && e.kind !== 'started'));
  assert.equal(JSON.parse(await readFile(f.activationFile, 'utf8')).status, 'active');
  assert.equal(JSON.parse(await readFile(f.c.budgetFile, 'utf8')).entries.length, 2);
});
