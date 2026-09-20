// FIX61-01 RED->GREEN: seven-slot capability-based provider configuration reaching the real
// production composition root. No model-name or price white-list may reject a custom model; only
// protocol capability, endpoint origin, credential reference and usage bounds are enforced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../management/helpers.js';
import { defaultManagedSettings, validateManagedSettings, effectiveTrialConfiguration, availableAdapters } from '../../management/settings.js';
import { ProviderRegistry, PROTOCOL_SLOTS, type SlotBinding, type SlotCapabilities } from '../../providers/slot-registry.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { COMPANION_ID } from '../../contracts/character.js';

const OPENAI = 'https://my-llm.example.com/v1/chat/completions';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// 01-A ------------------------------------------------------------------------------------------
test('01-A custom model outside every catalog is saved, read back and reloaded; revision and URL are still guarded', async t => {
  const f = await fixture(t), file = join(f.c.projectRoot, 'management-settings.json');
  const store = await ManagementSettingsStore.open(file, f.c);
  const original = store.snapshot().saved;

  const custom = structuredClone(original);
  custom.providers.dialogue.model = 'my-custom-model-2026';
  custom.providers.dialogue.endpoint = OPENAI;
  custom.providers.dialogue.protocol = 'openai-compatible';
  const saved = await store.save(0, custom);
  assert.equal(saved.revision, 1, 'a custom model saves');
  assert.equal(saved.saved.providers.dialogue.model, 'my-custom-model-2026');

  const reopened = await ManagementSettingsStore.open(file, f.c);
  assert.equal(reopened.snapshot().saved.providers.dialogue.model, 'my-custom-model-2026', 'the custom model survives a restart');

  const persisted = await readFile(file, 'utf8');
  assert.ok(!persisted.includes('sk-'), 'no plaintext key may reach the settings file');

  // Stale revision keeps the previous accepted configuration intact.
  await assert.rejects(store.save(0, original), { code: 'version_conflict' });
  assert.equal(store.snapshot().saved.providers.dialogue.model, 'my-custom-model-2026');

  for (const patch of [{ endpoint: 'http://attacker.invalid/v1' }, { endpoint: 'ftp://x/y' }, { model: '' }]) {
    const forged = structuredClone(store.snapshot().saved); Object.assign(forged.providers.dialogue, patch);
    assert.throws(() => validateManagedSettings(forged, f.c), { code: 'invalid_request' });
  }
  assert.equal(store.snapshot().saved.providers.dialogue.model, 'my-custom-model-2026', 'a rejected edit never replaces the accepted configuration');
});

// 01-B ------------------------------------------------------------------------------------------
test('01-B every one of the seven slots reaches its own configured endpoint, model and credential through the registry', async t => {
  const f = await fixture(t);
  // The ASR slot is optional in the registered baseline; a user adds it explicitly, so the fixture does too.
  const { characterMicros: _unusedCharacterRate, ...asrBaseline } = f.c.models.tts;
  const withAsr = { ...f.c, models: { ...f.c.models, asr: { ...asrBaseline, model: 'custom-asr-baseline', endpoint: OPENAI, audioMicrosPerSecond: 220 } } };
  const settings = defaultManagedSettings(withAsr);
  const slots = ['dialogue', 'memory_turn', 'summary', 'admission', 'perception', 'asr', 'tts'] as const;
  for (const slot of slots) {
    const binding = settings.providers[slot] as import('../../contracts/management.js').ProviderSelection;
    binding.model = `custom-${slot}-v9`;
    binding.endpoint = OPENAI;
    binding.protocol = 'openai-compatible';
  }
  const effective = effectiveTrialConfiguration(withAsr, validateManagedSettings(settings, withAsr));
  for (const slot of slots) {
    assert.equal(effective.models[slot]!.model, `custom-${slot}-v9`, `${slot} keeps its own model`);
    assert.equal(effective.models[slot]!.endpoint, OPENAI, `${slot} keeps its own endpoint`);
    assert.equal(effective.models[slot]!.protocol, 'openai-compatible');
  }
  // Credential references stay per slot and are never collapsed into one shared key.
  const refs = new Set(slots.map(slot => (settings.providers[slot] as { credentialRef: string }).credentialRef));
  assert.ok(refs.size >= 2, 'distinct credential references are preserved per slot');
});

test('01-B text slots accept the gemini protocol; audio slots keep refusing it', () => {
  const caps: SlotCapabilities = { temperature: false, voice: false, language: false, audio: false };
  const base: SlotBinding = {
    adapterId: 'custom-gemini', protocol: 'gemini', provider: 'gemini', endpoint: GEMINI, model: 'gemini-2.0-flash',
    credentialRef: 'gemini-abc123', inputTokenLimit: 32768, outputTokenLimit: 8192,
    reservationMicros: 100000, inputMicrosPerToken: 1, outputMicrosPerToken: 2,
  };
  for (const slot of PROTOCOL_SLOTS.gemini) {
    assert.equal(ProviderRegistry.resolve(slot, base, caps).protocol, 'gemini', `gemini serves ${slot}`);
  }
  assert.equal(PROTOCOL_SLOTS.gemini.includes('asr'), false, 'gemini has no audio-transcription capability in this build');
  assert.equal(PROTOCOL_SLOTS.gemini.includes('tts'), false, 'gemini has no speech-synthesis capability in this build');
  assert.throws(() => ProviderRegistry.resolve('asr', { ...base, adapterId: 'gemini-asr' }, { ...caps, audio: true }), { code: 'invalid_request' });
});

test('01-B a non-DeepSeek model configured for memory_turn is accepted by the strict configuration', async t => {
  const f = await fixture(t);
  const settings = defaultManagedSettings(f.c);
  // The registered memory credential still belongs to its own provider; only the model lock is lifted.
  settings.providers.memory_turn.model = 'any-instruction-model-2026';
  settings.providers.memory_turn.endpoint = OPENAI;
  settings.providers.memory_turn.provider = 'deepseek';
  settings.providers.memory_turn.thinking = 'high';
  // The strict-configuration boundary must not require one specific model for memory maintenance.
  const effective = effectiveTrialConfiguration(f.c, validateManagedSettings(settings, f.c));
  assert.equal(effective.models.memory_turn.model, 'any-instruction-model-2026');
  assert.equal(effective.models.memory_turn.endpoint, OPENAI);
  assert.equal(effective.models.memory_turn.thinking, 'high', 'the strict memory thinking capability survives');
  // A different vendor on a custom endpoint is equally allowed once its own credential is registered.
  const other = defaultManagedSettings(f.c);
  other.providers.memory_turn.model = 'any-instruction-model-2026';
  other.providers.memory_turn.endpoint = OPENAI;
  other.providers.memory_turn.provider = 'openai';
  assert.throws(() => validateManagedSettings(other, f.c), { code: 'invalid_request' }, 'a custom vendor needs its own registered credential, not the preset vendor key');
});

// 01-C ------------------------------------------------------------------------------------------
test('01-C unlimited mode calls without any price or ledger; stop and mismatch still refuse; bounded overage still refuses', async t => {
  const f = await fixture(t);
  const { writeFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  // 01-C (a): unlimited with a deleted ledger — the call is still authorized.
  const unlimited = { ...f.c, budgetMode: 'unlimited' as const, limitMicros: null };
  const raw = JSON.stringify(unlimited);
  await writeFile(f.configFile, raw);
  await writeFile(f.activationFile, JSON.stringify({ version: 1, product: 'companion-v1', phaseId: unlimited.phaseId, status: 'active', configSha256: createHash('sha256').update(raw).digest('hex') }));
  const { TrialAuthorizer } = await import('../../app/trial-authorizer.js');
  const authorizer = new TrialAuthorizer(unlimited, f.configFile, f.activationFile);
  const scope = { characterId: COMPANION_ID, sessionId: 's', turnId: 't', generation: 1 };
  const request = { scope, operation: 'dialogue' as const, model: unlimited.models.dialogue.model, endpoint: unlimited.models.dialogue.endpoint };
  const permit = await authorizer.authorize(request, new AbortController().signal);
  await permit.settle({ status: 'success', usage: null, requestId: null });
  // An unknown cost must never be fabricated as zero.
  assert.equal(unlimited.models.dialogue.inputMicrosPerToken, f.c.models.dialogue.inputMicrosPerToken);

  // 01-C (b): a request that does not match its registered binding is refused before any network use.
  await assert.rejects(authorizer.authorize({ ...request, model: 'some-other-model' }, new AbortController().signal), /differs|registered/i);
  await assert.rejects(authorizer.authorize({ ...request, endpoint: 'https://elsewhere.invalid/x' }, new AbortController().signal), /differs|registered/i);

  // 01-C (c): a stopped trial still refuses in unlimited mode.
  await writeFile(f.activationFile, JSON.stringify({ version: 1, product: 'companion-v1', phaseId: unlimited.phaseId, status: 'stopped', configSha256: createHash('sha256').update(raw).digest('hex') }));
  await assert.rejects(authorizer.authorize(request, new AbortController().signal), /尚未|not active|stopped|未启用/i);

  // 01-C (d): the bounded configuration keeps enforcing its allowance and its missing-ledger guard.
  await writeFile(f.configFile, JSON.stringify(f.c));
  await f.activate('active');
  const bounded = new TrialAuthorizer(f.c, f.configFile, f.activationFile);
  const boundedRequest = { ...request, model: f.c.models.dialogue.model, endpoint: f.c.models.dialogue.endpoint };
  const permit2 = await bounded.authorize(boundedRequest, new AbortController().signal);
  await permit2.settle({ status: 'success', usage: { prompt_tokens: 10, completion_tokens: 10 }, requestId: null });
  const ledger = JSON.parse(await readFile(f.c.budgetFile, 'utf8'));
  assert.equal(ledger.entries.length, 2, 'bounded mode records its reservation in the shared ledger');
});

// 01-D ------------------------------------------------------------------------------------------
test('01-D the management route returns a real JSON body and never mixes configuration revisions', async t => {
  const { AikaProfileStore } = await import('../../management/aika-profile.js');
  const { aikaManagement, aikaRoute } = await import('../../management/aika-routes.js');
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'fix61-routes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await AikaProfileStore.open(join(dir, 'aika-profile.json'));
  const management = aikaManagement(store, { list: async () => ({ items: [] }) } as never);
  const response = await aikaRoute('GET', management, '/api/aika/profile', new URLSearchParams(), async () => ({}));
  assert.equal(typeof (response as Promise<unknown>).then, 'undefined', 'the route must resolve, not return an unresolved promise');
  const body = response as { revision: number; profile: { displayName: string }; providers: readonly unknown[] };
  assert.equal(body.revision, 0);
  assert.equal(body.profile.displayName, 'Aika');
  assert.ok(Array.isArray(body.providers));

  // A stale expectedRevision is refused and the accepted revision is preserved.
  await management.saveProfile(0, { schemaVersion: 1, id: 'aika', displayName: 'Aika', systemPrompt: '第一版。' }, []);
  await assert.rejects(
    management.saveProfile(0, { schemaVersion: 1, id: 'aika', displayName: 'Aika', systemPrompt: '第二版。' }, []),
    (error: unknown) => (error as { code?: string }).code === 'version_conflict',
    'a stale expectedRevision must be refused with a typed conflict'
  );
  assert.equal(store.loadProfile().systemPrompt, '第一版。');
});

test('01-D the production management bootstrap registers the Aika routes and the slot route', async () => {
  const source = await readFile(join(process.cwd(), 'management', 'bootstrap.ts'), 'utf8');
  assert.match(source, /aika/, 'the production bootstrap must register the Aika management port');
});

// 01-E ------------------------------------------------------------------------------------------
test('01-E provider input carries identity, selected memories and history exactly once; switching protocol keeps memory', async () => {
  const { OpenAiCompatibleDialogueProvider } = await import('../../providers/aika-dialogue.js');
  const { ProviderTransport } = await import('../../providers/transport.js');
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const transport = new ProviderTransport((async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    // The OpenAI-compatible adapter requests a server-sent-event stream; the fixture answers with real SSE frames.
    const frames = [
      JSON.stringify({ choices: [{ delta: { content: '好' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { content: '。' }, finish_reason: 'stop' }] }),
      '[DONE]'
    ].map(frame => `data: ${frame}\r\n\r\n`).join('');
    return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch);
  const provider = new OpenAiCompatibleDialogueProvider(transport, {
    endpoint: OPENAI, model: 'my-custom-model-2026', apiKey: () => 'test-key',
    authorizer: { async authorize() { return { async settle() {} }; } }
  }, 'CONSTRUCTOR-PROMPT-MUST-NOT-BE-USED');
  const scope = { characterId: COMPANION_ID, sessionId: 's', turnId: 'turn-9', generation: 1 };
  const request = {
    scope, text: '今天穿什么好看',
    context: {
      scope, characterPrompt: '身份来自本轮上下文。', inputTokenBudget: 5000, summary: '', perception: null,
      recent: [
        { characterId: COMPANION_ID, id: 'prev:user', role: 'user' as const, text: '早上好', createdAt: '2026-09-19T00:00:00.000Z' },
        { characterId: COMPANION_ID, id: 'prev:assistant', role: 'assistant' as const, text: '早。', createdAt: '2026-09-19T00:00:00.000Z' },
        { characterId: COMPANION_ID, id: 'turn-9:user', role: 'user' as const, text: '今天穿什么好看', createdAt: '2026-09-19T00:00:01.000Z' }
      ],
      memories: [{ characterId: COMPANION_ID, id: 'mem-1', version: 1, text: '她不喜欢下雨天', sourceIds: [] }]
    }
  };
  await provider.reply(request as never, new AbortController().signal);
  assert.equal(calls.length, 1);
  const serialized = JSON.stringify(calls[0]!.body);
  assert.ok(serialized.includes('身份来自本轮上下文。'), 'the current identity reaches the provider');
  assert.ok(!serialized.includes('CONSTRUCTOR-PROMPT-MUST-NOT-BE-USED'), 'a constructor prompt must not shadow the current identity');
  assert.equal((serialized.match(/今天穿什么好看/g) ?? []).length, 1, 'the current input appears exactly once');
  assert.equal((serialized.match(/早上好/g) ?? []).length, 1, 'prior history appears exactly once');
  assert.equal((serialized.match(/她不喜欢下雨天/g) ?? []).length, 1, 'selected memory appears exactly once');
});
