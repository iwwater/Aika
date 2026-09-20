// FIX61-02 02-C: the selected model actually reaches a provider request after a restart, the key stays a
// file, and the discovery route is mounted on the real authenticated management server.
// The supplier is a fake fetch; the settings store, the provider factory, the transport and the HTTP
// server under test are production code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restrictPrivatePathSync } from '../../core/platform-files.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { defaultManagedSettings, effectiveTrialConfiguration, validateManagedSettings } from '../../management/settings.js';
import { createAikaDialogueProvider } from '../../providers/aika-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { AikaTimelineStore } from '../../management/aika-timeline.js';
import { AikaProfileStore } from '../../management/aika-profile.js';
import { aikaManagement, ModelDiscoveryService } from '../../management/aika-routes.js';
import { AikaDiscoveryDraftStore } from '../../management/model-discovery-draft.js';
import { credentialRegistry } from '../../management/credentials.js';
import { fixture } from '../management/helpers.js';
import { COMPANION_ID } from '../../contracts/character.js';

const OPENAI = 'https://my-llm.example.com/v1/chat/completions';
const KEY = 'sk-fix6102-secret-value';

/** A real restricted credential file outside the project root, as the production key reader requires. */
async function credentialFile(projectRoot: string, name: string): Promise<string> {
  const file = join(tmpdir(), `fix61-02-${name}-${Date.now()}.key`);
  await writeFile(file, KEY, { mode: 0o600 });
  restrictPrivatePathSync(file);
  assert.ok(!file.startsWith(projectRoot));
  return file;
}

test('02-C a saved custom model and endpoint survive a restart and are what the provider request actually uses', async t => {
  const f = await fixture(t);
  const keyFile = await credentialFile(f.c.projectRoot, 'dialogue');
  t.after(() => rm(keyFile, { force: true }));
  // The composition root reads this file on startup: trial-backend.ts opens management-settings.json.
  const settingsFile = join(f.c.projectRoot, 'management-settings.json');
  const baseline = { ...f.c, models: { ...f.c.models, dialogue: { ...f.c.models.dialogue, credentialFile: keyFile } } };

  const first = await ManagementSettingsStore.open(settingsFile, baseline);
  t.after(() => first.close());
  const draft = defaultManagedSettings(baseline);
  const credentialRef = credentialRegistry(baseline).ref(keyFile, baseline.models.dialogue.provider);
  draft.providers.dialogue.model = 'selected-model-2026';
  draft.providers.dialogue.endpoint = OPENAI;
  draft.providers.dialogue.protocol = 'openai-compatible';
  draft.providers.dialogue.credentialRef = credentialRef;
  const saved = await first.save(0, draft);
  assert.equal(saved.revision, 1);

  // Restart: a brand-new store instance, exactly like a relaunched backend.
  const restarted = await ManagementSettingsStore.open(settingsFile, baseline);
  t.after(() => restarted.close());
  const effective = effectiveTrialConfiguration(baseline, restarted.effective);
  assert.equal(effective.models.dialogue.model, 'selected-model-2026', 'the restart keeps the selected model');
  assert.equal(effective.models.dialogue.endpoint, OPENAI);
  assert.equal(effective.models.dialogue.protocol, 'openai-compatible');
  assert.equal(effective.models.dialogue.credentialFile, keyFile, 'the slot still points at its own credential file');

  // The real provider for that binding issues the request the runtime would issue.
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const transport = new ProviderTransport((async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> });
    const frames = [JSON.stringify({ choices: [{ delta: { content: '好' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { content: '。' }, finish_reason: 'stop' }] }), '[DONE]'].map(frame => `data: ${frame}\r\n\r\n`).join('');
    return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch);
  const model = effective.models.dialogue;
  const provider = createAikaDialogueProvider({ endpoint: model.endpoint, model: model.model, protocol: model.protocol ?? 'openai-compatible',
    apiKey: () => KEY, authorizer: { async authorize() { return { async settle() {} }; } } }, transport, '身份。');
  const scope = { characterId: COMPANION_ID, sessionId: 's', turnId: 'turn-1', generation: 1 };
  await provider.reply({ scope, text: '在吗', context: { scope, characterPrompt: '身份。', inputTokenBudget: 4096, summary: '', perception: null, recent: [], memories: [] } } as never, new AbortController().signal);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, OPENAI, 'the request goes to the configured endpoint');
  assert.equal(calls[0]!.body.model, 'selected-model-2026', 'the request carries the selected model');
  assert.equal(calls[0]!.headers.Authorization, `Bearer ${KEY}`, 'the request authenticates with the stored credential');
  assert.equal(JSON.stringify(calls[0]!.body).includes(KEY), false, 'the key never enters the request body');

  // The persisted configuration names the model but never the key material.
  const persisted = await readFile(settingsFile, 'utf8');
  assert.ok(persisted.includes('selected-model-2026'));
  assert.ok(!persisted.includes('sk-'), 'no key material in the settings file');
  assert.ok(!persisted.includes(KEY));
});

test('02-C the discovery route is mounted behind the existing management authentication', async t => {
  const f = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'fix61-02-http-'));
  // Windows keeps a just-closed SQLite file locked for one more scheduler tick, so the removal retries
  // briefly instead of failing the test on a teardown race that has nothing to do with the assertion.
  t.after(async () => { for (let i = 0; i < 10; i++) { try { await rm(dir, { recursive: true, force: true }); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EBUSY' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; await new Promise(done => setTimeout(done, 150)); } } });
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  t.after(() => settings.close());
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const profile = await AikaProfileStore.open(join(dir, 'aika-profile.json'));
  const timeline = await AikaTimelineStore.open(join(dir, 'timeline.sqlite'));
  t.after(() => { profile.close(); timeline.close(); });
  const draft = await AikaDiscoveryDraftStore.open(join(dir, 'discovery.json'));
  const calls: string[] = [];
  const discovery = new ModelDiscoveryService({ credentials: { key: () => KEY }, draft,
    fetch: (async (url: unknown) => { calls.push(String(url)); return Response.json({ object: 'list', data: [{ id: 'http-model' }] }); }) as unknown as typeof fetch });
  const server = await startManagementServer({ uiRoot: join(f.c.projectRoot, 'ui'), settings,
    memory: { characters: () => [], list: () => { throw new Error('not used'); }, edit: () => { throw new Error('not used'); },
      context: () => { throw new Error('not used'); }, prompt: () => { throw new Error('not used'); }, savePrompt: () => { throw new Error('not used'); } },
    aika: aikaManagement(profile, timeline, discovery),
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: [], events: [], adapters: [], credentials: [], characters: [], settings: settings.snapshot() }) });
  // server.close() drains the settings store and may still touch the stores, so the server is closed
  // FIRST and the SQLite handles are released only afterwards; otherwise the temp dir cannot be removed.
  t.after(async () => { await server.close(); });
  const headers = { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json' };

  // The unauthenticated request must be refused: discovery is behind the same management session token.
  assert.equal((await fetch(server.origin + '/api/aika/discovery')).status, 401, 'discovery is behind the same authentication');
  const empty = await fetch(server.origin + '/api/aika/discovery', { headers });
  assert.equal(empty.status, 200);
  assert.equal((await empty.json() as { items: unknown[] }).items.length, 0);

  const listed = await fetch(server.origin + '/api/aika/discovery', { method: 'POST', headers, body: JSON.stringify({ protocol: 'openai-compatible', endpoint: OPENAI, credentialRef: 'ref-a' }) });
  assert.equal(listed.status, 200);
  const page = await listed.json() as { items: { id: string }[]; note: string };
  assert.deepEqual(page.items.map(item => item.id), ['http-model']);
  assert.equal(calls.length, 1, 'the backend, not the browser, called the supplier');
  assert.match(page.note, /不代表/);

  // A discovery failure is reported through the existing error envelope, never as a 200 with an empty list.
  await draft.select(1, { protocol: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', credentialRef: null });
  const failing = new ModelDiscoveryService({ credentials: { key: () => KEY }, draft, fetch: (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch });
  const failingServer = await startManagementServer({ uiRoot: join(f.c.projectRoot, 'ui'), settings,
    memory: { characters: () => [], list: () => { throw new Error('not used'); }, edit: () => { throw new Error('not used'); },
      context: () => { throw new Error('not used'); }, prompt: () => { throw new Error('not used'); }, savePrompt: () => { throw new Error('not used'); } },
    aika: aikaManagement(profile, timeline, failing),
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: [], events: [], adapters: [], credentials: [], characters: [], settings: settings.snapshot() }) });
  t.after(() => failingServer.close());
  const failingHeaders = { Authorization: 'Bearer ' + failingServer.token, Origin: failingServer.origin, 'Content-Type': 'application/json' };
  const denied = await fetch(failingServer.origin + '/api/aika/discovery', { method: 'POST', headers: failingHeaders,
    body: JSON.stringify({ protocol: 'gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', credentialRef: 'ref-a' }) });
  assert.equal(denied.status, 403, 'a supplier refusal maps onto the existing error plane');
  const envelope = await denied.json() as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'forbidden');
  assert.ok(!JSON.stringify(envelope).includes(KEY));
  assert.match(envelope.error.message, /手工填写/, 'the message keeps manual entry viable');
});
