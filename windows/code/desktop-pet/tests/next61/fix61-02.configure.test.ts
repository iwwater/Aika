// FIX61-02 RED->GREEN: the discovery route, its cache and the console presenter semantics.
// The supplier is a fake fetch; the routes, stores and presenter under test are production code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AikaTimelineStore } from '../../management/aika-timeline.js';
import { AikaProfileStore, defaultAikaProfile } from '../../management/aika-profile.js';
import { aikaManagement, aikaRoute, ModelDiscoveryService, type AikaManagement } from '../../management/aika-routes.js';
import { AikaDiscoveryDraftStore } from '../../management/model-discovery-draft.js';
import { AikaConsolePresenter, type AikaConsolePorts } from '../../management/aika-console.js';
import type { DiscoveryItemView } from '../../management/aika-routes.js';

const KEY = 'sk-fix6102-secret-value';
const ENDPOINT = 'https://gw.example.com/v1/chat/completions';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const reply = (ids: readonly string[]) => new Response(JSON.stringify({ object: 'list', data: ids.map(id => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } });
// The Gemini models.list shape; the supplier fake must answer each protocol in its own wire format.
const geminiReply = (ids: readonly string[]) => new Response(JSON.stringify({ models: ids.map(id => ({ name: 'models/' + id })) }), { status: 200, headers: { 'content-type': 'application/json' } });
const body = (value: Record<string, unknown>) => async () => value;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

interface Route { url: string; init: RequestInit }
async function harness(t: { after(fn: () => Promise<void>): void }, options: { credentials?: readonly string[]; respond: (route: Route) => Promise<Response> | Response }) {
  const dir = await mkdtemp(join(tmpdir(), 'fix61-02-'));
  const draftFile = join(dir, 'model-discovery.json');
  const profile = await AikaProfileStore.open(join(dir, 'aika-profile.json'));
  const timeline = await AikaTimelineStore.open(join(dir, 'timeline.sqlite'));
  t.after(async () => { profile.close(); timeline.close(); await rm(dir, { recursive: true, force: true }); });
  const draft = await AikaDiscoveryDraftStore.open(draftFile);
  const calls: Route[] = [];
  let keyReads = 0;
  const service = new ModelDiscoveryService({
    credentials: { key: ref => { keyReads++; if (!(options.credentials ?? ['ref-a']).includes(ref)) throw new Error('unknown credential reference'); return KEY; } },
    fetch: ((url: unknown, init: RequestInit) => { const route = { url: String(url), init }; calls.push(route); return options.respond(route); }) as unknown as typeof fetch,
    draft
  });
  return { management: aikaManagement(profile, timeline, service), service, draftFile, calls, dir, keyReads: () => keyReads };
}

// 02-B ---------------------------------------------------------------------------------------------
test('02-B a slow endpoint that is replaced by another one cannot publish over the newer result', async t => {
  const slow = deferred<Response>();
  const h = await harness(t, { respond: route => route.url.startsWith('https://gw.example.com') ? slow.promise : geminiReply(['new-endpoint-model']) });
  const older = h.management.discoverModels({ protocol: 'openai-compatible', endpoint: ENDPOINT, credentialRef: 'ref-a' });
  await settle();
  assert.equal(h.calls.length, 1, 'the first discovery is in flight against the old endpoint');

  const newer = await h.management.discoverModels({ protocol: 'gemini', endpoint: GEMINI_ENDPOINT, credentialRef: 'ref-a' });
  assert.equal(newer.endpoint, GEMINI_ENDPOINT);
  assert.deepEqual(newer.items.map(item => item.id), ['new-endpoint-model']);

  // The first (slow) request now finally answers. It must not publish over the newer result.
  slow.resolve(reply(['old-endpoint-model']));
  const late = await older;
  // The route answers with the *current* discovery state, never with a superseded one: the late caller is
  // told what is actually in effect instead of being handed a list that was already replaced.
  assert.equal(late.endpoint, GEMINI_ENDPOINT);
  assert.deepEqual(late.items.map(item => item.id), ['new-endpoint-model'], 'a superseded answer is never handed back as current state');
  assert.equal(h.calls.at(-1)!.url, 'https://generativelanguage.googleapis.com/v1beta/models', 'the slow endpoint is not asked again');
  const draft = await h.management.discoveryDraft();
  assert.equal(draft.endpoint, GEMINI_ENDPOINT);
  assert.deepEqual(draft.items.map(item => item.id), ['new-endpoint-model'], 'a superseded answer must never be published');
});

test('02-B a manual model name needs no successful discovery and is accepted by the settings plane', async t => {
  const h = await harness(t, { respond: () => reply(['gateway-model-a']) });
  const draft = await h.management.discoveryDraft();
  assert.equal(draft.stale, true);
  assert.deepEqual(draft.items, []);
  // The console only records which source was asked; the model name itself belongs to /api/settings,
  // which ManagementSettingsStore validates. This plane must not keep a second slot binding.
  const saved = await aikaRoute('PUT', h.management, '/api/aika/discovery/source', new URLSearchParams(), body({ expectedRevision: 0, protocol: 'openai-compatible', endpoint: ENDPOINT, modelsEndpoint: 'https://gw.example.com/models', credentialRef: 'ref-a' }));
  assert.equal((saved as { revision: number }).revision, 1, 'the signed-in user selection is a revisioned write');
  assert.equal(h.calls.length, 0, 'recording a source never triggers a supplier request');
  assert.equal(Object.hasOwn(saved as object, 'slots'), false, 'this plane must not hold a slot binding of its own');
  const persisted = JSON.parse(await readFile(h.draftFile, 'utf8'));
  assert.equal(persisted.endpoint, ENDPOINT);
  assert.equal(persisted.observedAt, null, 'a source selection is not a discovery result');
  assert.equal(Object.hasOwn(persisted, 'models'), false);
  assert.equal(Object.hasOwn(persisted, 'slots'), false);

  // The settings plane still accepts a hand-typed model with no discovery behind it.
  const { defaultManagedSettings, validateManagedSettings } = await import('../../management/settings.js');
  const { fixture } = await import('../management/helpers.js');
  const f = await fixture(t);
  const settings = defaultManagedSettings(f.c);
  settings.providers.dialogue.model = 'hand-typed-model-2026';
  settings.providers.dialogue.endpoint = 'https://gw.example.com/custom/infer';
  assert.equal(validateManagedSettings(settings, f.c).providers.dialogue.model, 'hand-typed-model-2026');
});

test('02-B a failed discovery keeps the previously discovered list', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fix61-02-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const draft = await AikaDiscoveryDraftStore.open(join(dir, 'draft.json'));
  let round = 0;
  const service = new ModelDiscoveryService({ credentials: { key: () => KEY }, draft,
    fetch: (async () => (++round === 1 ? reply(['kept-model']) : new Response('busy', { status: 429 }))) as unknown as typeof fetch });
  await service.discover({ protocol: 'openai-compatible', endpoint: ENDPOINT, credentialRef: 'ref-a' });
  await assert.rejects(service.discover({ protocol: 'openai-compatible', endpoint: ENDPOINT, credentialRef: 'ref-a' }), (error: unknown) => (error as { code?: string }).code === 'invalid_request');
  assert.deepEqual((await service.draft()).objects.map(item => item.value), ['kept-model'], 'a failed refresh must not clear the list the user can still pick from');
  // A 404 on the same source behaves the same way: the list survives, manual entry is never blocked.
  const missing = new ModelDiscoveryService({ credentials: { key: () => KEY }, fetch: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch, draft });
  await assert.rejects(missing.discover({ protocol: 'openai-compatible', endpoint: ENDPOINT, credentialRef: 'ref-a' }), (error: unknown) => (error as { code?: string }).code === 'not_found');
  assert.deepEqual((await service.draft()).objects.map(item => item.value), ['kept-model']);
});

test('02-B the route keeps the management error plane, refuses raw keys and never leaks the credential', async t => {
  const h = await harness(t, { credentials: [], respond: () => reply(['should-not-be-reached']) });
  const rawKey = await aikaRoute('POST', h.management, '/api/aika/discovery', new URLSearchParams(), body({ protocol: 'openai-compatible', endpoint: ENDPOINT, credentialRef: 'ref-a', apiKey: KEY }))
    .then(() => null, (error: unknown) => error as { code: string; message: string });
  assert.equal(rawKey?.code, 'invalid_request', 'the discovery API accepts a reference, never a key body');
  assert.ok(!rawKey!.message.includes(KEY));
  assert.equal(h.keyReads(), 0, 'a rejected payload never reaches a credential read');
  assert.equal(h.calls.length, 0);

  const rejected = await aikaRoute('POST', h.management, '/api/aika/discovery', new URLSearchParams(), body({ protocol: 'openai-compatible', endpoint: ENDPOINT, credentialRef: 'ref-missing' }))
    .then(() => null, (error: unknown) => error as { code: string; message: string });
  assert.equal(rejected?.code, 'invalid_request');
  assert.ok(!rejected!.message.includes(KEY));
  assert.equal(h.calls.length, 0, 'an unresolvable credential never reaches the network');

  assert.equal((await aikaRoute('GET', h.management, '/api/aika/discovery/nope', new URLSearchParams(), body({})).then(() => null, (error: unknown) => error as { code: string }))?.code, 'not_found');
  assert.equal((await aikaRoute('GET', h.management, '/api/aika/discovery/source', new URLSearchParams(), body({})).then(() => null, (error: unknown) => error as { code: string }))?.code, 'not_found');
  assert.equal((await aikaRoute('PUT', h.management, '/api/aika/discovery/source', new URLSearchParams(), body({ expectedRevision: 0, protocol: 'anthropic', endpoint: ENDPOINT })).then(() => null, (error: unknown) => error as { code: string }))?.code, 'invalid_request');
});

test('02-B the cache holds no secret and the page never claims a model is usable', async t => {
  const h = await harness(t, { respond: () => reply(['gateway-model-a']) });
  const view = await h.management.discoverModels({ protocol: 'openai-compatible', endpoint: ENDPOINT, credentialRef: 'ref-a' });
  const saved = await aikaRoute('PUT', h.management, '/api/aika/discovery/source', new URLSearchParams(), body({ expectedRevision: view.revision, protocol: 'openai-compatible', endpoint: ENDPOINT, credentialRef: 'ref-a' }));
  const raw = await readFile(h.draftFile, 'utf8');
  assert.ok(!raw.includes('sk-'), 'only the credential reference may be cached, never the key');
  assert.ok(raw.includes('ref-a'));
  assert.equal(view.items[0]!.capabilities.evidence, 'unknown', 'an id alone proves nothing about capabilities');
  assert.match(view.note, /不代表|不证明/, 'the page must state that a list is not a usability proof');
  assert.equal(view.stale, false);
  assert.equal((saved as { items: { id: string }[] }).items[0]!.id, 'gateway-model-a', 're-selecting the same source keeps its list');
});

// 02-C (presenter half) ---------------------------------------------------------------------------
test('02-C the presenter applies a late answer only while it is still the current request', async () => {
  const ports = presenterPorts();
  const presenter = new AikaConsolePresenter(ports);
  const first = deferred<readonly DiscoveryItemView[]>();
  const second = deferred<readonly DiscoveryItemView[]>();
  ports.discovery.queue = [() => first.promise, () => second.promise];
  const source = { protocol: 'openai-compatible' as const, endpoint: ENDPOINT, credentialRef: 'ref-a' };
  const older = presenter.loadDiscoveryModels(source);
  const newer = presenter.loadDiscoveryModels(source);
  second.resolve([{ id: 'newer-model', label: 'newer-model', capabilities: { methods: [], evidence: 'unknown' } }]);
  await newer;
  assert.deepEqual(presenter.state.discoveryItems.map(item => item.id), ['newer-model']);
  first.resolve([{ id: 'older-model', label: 'older-model', capabilities: { methods: [], evidence: 'unknown' } }]);
  await older;
  assert.deepEqual(presenter.state.discoveryItems.map(item => item.id), ['newer-model'], 'a late answer must not replace a newer list');
  assert.equal(presenter.state.discoveryItems[0]!.capabilities.evidence, 'unknown');
  assert.equal(presenter.state.discoveryError, null, 'a superseded answer is not an error either');
  assert.equal(presenter.state.discovering, false);
});

test('02-C a discovery failure is visible, keeps the old list and never blocks a manual model', async () => {
  const ports = presenterPorts();
  const presenter = new AikaConsolePresenter(ports);
  ports.discovery.queue = [() => Promise.resolve([{ id: 'kept-model', label: 'kept-model', capabilities: { methods: [], evidence: 'unknown' } } as DiscoveryItemView])];
  const source = { protocol: 'openai-compatible' as const, endpoint: ENDPOINT, credentialRef: 'ref-a' };
  await presenter.loadDiscoveryModels(source);
  assert.deepEqual(presenter.state.discoveryItems.map(item => item.id), ['kept-model']);
  ports.discovery.failure = new Error('该服务限流（429）：请稍后重试，或直接手工填写型号名。');
  await assert.rejects(presenter.loadDiscoveryModels(source), /手工填写/);
  assert.deepEqual(presenter.state.discoveryItems.map(item => item.id), ['kept-model'], 'a failed refresh keeps the list');
  assert.match(presenter.state.discoveryError ?? '', /手工填写/, 'the failure tells the user manual entry still works');
  assert.equal(presenter.state.discovering, false, 'a failure still ends the in-flight state');
  // Manual typing is a plain form edit; the presenter must not require a discovered id.
  presenter.setManualModel('dialogue', 'hand-typed-model-2026');
  assert.equal(presenter.state.manualModels.dialogue, 'hand-typed-model-2026');
});

export function presenterPorts() {
  const discovery = {
    queue: [] as (() => Promise<readonly DiscoveryItemView[]>)[],
    failure: null as Error | null,
    saves: 0,
    async load() { return null; },
    async saveSource() { discovery.saves++; return null; },
    discover() { const next = discovery.queue.shift(); if (next) return next(); if (discovery.failure) return Promise.reject(discovery.failure); throw new Error('no discovery was queued'); }
  };
  const ports = {
    profile: {
      load: async () => ({ revision: 0, profile: defaultAikaProfile(), providers: [] }),
      save: async (expectedRevision: number, profile: import('../../management/aika-profile.js').AikaProfile, providers: readonly import('../../management/aika-profile.js').AikaProviderConfig[]) => ({ revision: expectedRevision + 1, profile, providers })
    },
    timeline: { list: async () => ({ items: [] }) },
    discovery,
    turn: { subscribe: () => () => {}, async submit() { throw new Error('not used'); }, cancel() {} },
    voice: { available: () => false }
  };
  return ports as unknown as AikaConsolePorts & { discovery: typeof discovery };
}
