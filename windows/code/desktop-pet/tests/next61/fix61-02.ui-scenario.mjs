// FIX61-02 02-C scenario. Runs inside the real page, before the production view module boots.
// The management transport is fake; the page, its modules and its markup are the production ones.
const KEY_ONLY_ON_SERVER = 'sk-fix6102-secret-value';
const SLOTS = ['dialogue', 'memory_turn', 'summary', 'admission', 'perception', 'tts'];
let settings = { providers: Object.fromEntries(SLOTS.map(slot => [slot, {
    adapterId: 'openai-compatible-text', protocol: 'openai-compatible', provider: 'custom-gw',
    model: 'baseline-' + slot, endpoint: 'https://gw.example.com/v1/chat/completions',
    credentialRef: 'ref-a', inputTokenLimit: 32768, outputTokenLimit: 32768, reservationMicros: 100000,
    inputMicrosPerToken: 1, outputMicrosPerToken: 2 }])), context: { maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, summaryMinMessages: 12, summaryMaxMessages: 24, timeoutMs: 30000 } };
let settingsRevision = 3;
let discovery = { protocol: 'openai-compatible', endpoint: '', modelsEndpoint: null, credentialRef: null, revision: 0, items: [], checkedAt: null, truncated: false, stale: true, note: '模型列表只证明该列表可以访问，不代表指定型号能完成推理。' };
const calls = [];
const errors = [];
let held = null;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const snapshot = () => ({ apiVersion: 1, runtime: { instanceId: 'synthetic', pid: 1, sourceRevision: 'a'.repeat(40), startedAt: new Date().toISOString(), observedAt: new Date().toISOString(), characterId: 'companion', sessionId: 'default', online: true },
  modules: [], events: [], adapters: [], characters: [{ id: 'companion', label: 'Aika', revision: 1 }],
  credentials: [{ id: 'ref-a', provider: 'custom-gw', label: '自定义端点凭据 · ef12ab', status: 'configured', masked: '••••••••' }],
  settings: { revision: settingsRevision, effectiveRevision: settingsRevision, savedAt: new Date().toISOString(), pending: false, applyOn: 'restart', effective: structuredClone(settings), saved: structuredClone(settings), history: [] } });
const responded = async (path, init) => {
  calls.push({ path, init });
  if (init.headers.Authorization !== 'Bearer synthetic-session-token') throw Error('the page must authorize with the session token only');
  if (path.startsWith('/api/aika/profile')) return init.method === 'PUT' ? json({ revision: 1, profile: JSON.parse(init.body).profile, providers: [] }) : json({ revision: 0, profile: { schemaVersion: 1, id: 'aika', displayName: 'Aika', systemPrompt: '设定。' }, providers: [{ id: 'legacy', protocol: 'gemini', endpoint: 'https://x.example.com', model: 'kept', credentialRef: 'ref-b', credentialConfigured: false }] });
  if (path.startsWith('/api/aika/timeline')) return json({ items: [], nextCursor: null });
  if (path === '/api/aika/discovery' && init.method === 'POST') {
    const source = JSON.parse(init.body);
    if (source.endpoint.includes('slow')) return new Promise(resolve => { held = { resolve, items: [{ id: 'slow-endpoint-model', label: 'slow-endpoint-model', capabilities: { methods: [], evidence: 'unknown' } }] }; });
    if (source.endpoint.includes('failing')) return json({ error: { code: 'invalid_request', message: '该服务限流（429）：请稍后重试，或直接手工填写型号名。' } }, 400);
    const items = [{ id: 'target-model-2026', label: 'target-model-2026', capabilities: { methods: [], evidence: 'unknown' } },
      { id: 'other-model', label: 'other-model', capabilities: { methods: ['generateContent'], evidence: 'declared' } },
      { id: '<img src=x onerror=alert(1)>', label: '<img src=x onerror=alert(1)>', capabilities: { methods: [], evidence: 'unknown' } }];
    discovery = { ...discovery, protocol: source.protocol, endpoint: source.endpoint, modelsEndpoint: source.modelsEndpoint ?? null, credentialRef: source.credentialRef, revision: discovery.revision + 1, items, checkedAt: new Date().toISOString(), truncated: false, stale: false };
    return json(discovery);
  }
  if (path === '/api/aika/discovery/source' && init.method === 'PUT') {
    const source = JSON.parse(init.body);
    const same = source.endpoint === discovery.endpoint && source.protocol === discovery.protocol;
    discovery = { ...discovery, protocol: source.protocol, endpoint: source.endpoint, modelsEndpoint: source.modelsEndpoint ?? null, credentialRef: source.credentialRef, revision: discovery.revision + 1, items: same ? discovery.items : [], stale: same ? discovery.stale : true };
    return json(discovery);
  }
  if (path === '/api/aika/discovery') return json(discovery);
  if (path === '/api/settings' && init.method === 'PUT') {
    const payload = JSON.parse(init.body);
    if (String(init.body).includes(KEY_ONLY_ON_SERVER)) throw Error('the page must never send the key itself');
    if (payload.expectedRevision !== settingsRevision) return json({ error: { code: 'version_conflict', message: '配置已被更新。' } }, 409);
    settings = payload.settings; settingsRevision += 1;
    return json(snapshot().settings);
  }
  if (path === '/api/snapshot') return json(snapshot());
  errors.push(path);
  return json({ error: { code: 'not_found', message: '没有这个接口。' } }, 404);
};
window.fetch = async (path, init = {}) => { try { return await responded(String(path), { method: 'GET', ...init }); } catch (error) { errors.push(String(error.message)); return json({ error: { code: 'invalid_request', message: String(error.message) } }, 400); } };

const checks = [];
const failures = [];
const $ = id => document.getElementById(id);
const text = selector => document.querySelector(selector)?.textContent ?? '';
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (test, label) => { for (let i = 0; i < 200; i++) { if (test()) return; await wait(20); } throw Error('timeout waiting for ' + label); };
const assert = (value, reason) => { if (!value) throw Error(reason); };
const check = async (name, fn) => { try { await fn(); checks.push(name); } catch (error) { failures.push({ name, error: String(error.message) }); } };
const setValue = (id, value) => { const node = $(id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); };
const click = id => $(id).click();

const diagnostics = [];
window.addEventListener('error', event => diagnostics.push('error: ' + String(event.message)));
window.addEventListener('unhandledrejection', event => diagnostics.push('rejection: ' + String(event.reason && event.reason.message || event.reason)));

try {
  await until(() => $('aika-model-dialogue'), 'the production view to render its slot form');
  await until(() => text('#aika-profile-revision').includes('0') || text('#aika-status').length > 0, 'the page to finish its first read');

  await check('endpoint, key reference and protocol are ordinary form fields', async () => {
    assert($('aika-endpoint') && $('aika-protocol') && $('aika-credential') && $('aika-models-endpoint') && $('aika-fetch-models'), 'the source form must exist');
    assert($('aika-protocol').tagName === 'SELECT' && $('aika-credential').tagName === 'SELECT', 'protocol and credential are explicit choices');
    assert($('aika-credential').options.length >= 2, 'saved credential references are offered');
    assert(!document.documentElement.outerHTML.includes(KEY_ONLY_ON_SERVER), 'the key is not in the document');
    assert(!text('body').includes(KEY_ONLY_ON_SERVER), 'the key is not in the visible text');
  });

  await check('a slow endpoint that is replaced cannot overwrite the newer model list', async () => {
    setValue('aika-endpoint', 'https://slow.example.com/v1/chat/completions');
    click('aika-fetch-models');
    await until(() => held, 'the slow request to be held by the fake supplier');
    setValue('aika-endpoint', 'https://gw.example.com/v1/chat/completions');
    click('aika-fetch-models');
    await until(() => text('#aika-discovery-list').includes('target-model-2026'), 'the newer list');
    held.resolve(json({ ...discovery, items: held.items, endpoint: 'https://slow.example.com/v1/chat/completions' }));
    await wait(80);
    assert(!text('#aika-discovery-list').includes('slow-endpoint-model'), 'a late answer from the replaced endpoint must not be displayed');
    assert(text('#aika-discovery-list').includes('target-model-2026'), 'the newer list stays');
    assert(!document.documentElement.outerHTML.includes('<img'), 'a model id is text, never markup');
  });

  await check('the list is searchable and never invents a capability', async () => {
    assert(text('#aika-discovery-list').includes('other-model'), 'all discovered models are listed');
    setValue('aika-model-search', 'target');
    await wait(20);
    assert(text('#aika-discovery-list').includes('target-model-2026') && !text('#aika-discovery-list').includes('other-model'), 'search filters the list');
    setValue('aika-model-search', '');
    await wait(20);
    const declared = [...document.querySelectorAll('#aika-discovery-list li')].find(node => node.dataset.model === 'other-model');
    assert(declared.textContent.includes('generateContent'), 'declared methods are shown verbatim');
    const unknown = [...document.querySelectorAll('#aika-discovery-list li')].find(node => node.dataset.model === 'target-model-2026');
    assert(/未声明|unknown/.test(unknown.textContent), 'an undeclared capability stays explicitly unknown');
  });

  await check('a discovered model is bound to one slot and saved through /api/settings', async () => {
    const row = [...document.querySelectorAll('#aika-discovery-list li')].find(node => node.dataset.model === 'target-model-2026');
    assert(row, 'the discovered model must be listed before it can be bound');
    row.querySelector('select').value = 'dialogue';
    row.querySelector('button').click();
    await wait(20);
    assert($('aika-model-dialogue').value === 'target-model-2026', 'the picked model lands in the slot field');
    assert($('aika-model-summary').value === 'baseline-summary', 'other slots are untouched');
    click('aika-save-models');
    await until(() => calls.some(call => call.path === '/api/settings'), 'the settings save');
    await wait(40);
    const save = calls.filter(call => call.path === '/api/settings').at(-1);
    const payload = JSON.parse(save.init.body);
    assert(payload.settings.providers.dialogue.model === 'target-model-2026', 'the selected model is what gets saved');
    assert(payload.settings.providers.dialogue.endpoint === 'https://gw.example.com/v1/chat/completions', 'the endpoint travels with the model');
    assert(payload.expectedRevision === 3, 'the save carries the revision it was based on');
    assert(!String(save.init.body).includes(KEY_ONLY_ON_SERVER), 'the key itself never reaches the configuration plane');
    assert(Object.keys(payload.settings.providers).length === SLOTS.length, 'no slot is dropped or duplicated');
  });

  await check('a failed discovery keeps the selection and a hand-typed model stays possible', async () => {
    const before = $('aika-model-dialogue').value;
    setValue('aika-endpoint', 'https://failing.example.com/v1/chat/completions');
    click('aika-fetch-models');
    await until(() => text('#aika-error').includes('手工填写'), 'the failure to be reported');
    assert($('aika-model-dialogue').value === before, 'a failed discovery must not clear the chosen model');
    setValue('aika-model-dialogue', 'hand-typed-model-2026');
    await wait(20);
    assert($('aika-model-dialogue').value === 'hand-typed-model-2026', 'the model field stays editable without any discovery');
    click('aika-save-models');
    await until(() => calls.filter(call => call.path === '/api/settings').length >= 2, 'the manual save');
    const payload = JSON.parse(calls.filter(call => call.path === '/api/settings').at(-1).init.body);
    assert(payload.settings.providers.dialogue.model === 'hand-typed-model-2026', 'a hand-typed model saves without a successful list');
  });

  await check('identity saving keeps the existing provider compatibility array untouched', async () => {
    setValue('aika-display-name', 'Aika·改');
    click('aika-save');
    await until(() => calls.some(call => call.path === '/api/aika/profile' && call.init.method === 'PUT'), 'the identity save');
    const payload = JSON.parse(calls.filter(call => call.path === '/api/aika/profile' && call.init.method === 'PUT').at(-1).init.body);
    assert(payload.profile.displayName === 'Aika·改');
    assert(payload.providers.length === 1 && payload.providers[0].model === 'kept', 'the legacy provider array is round-tripped, not wiped');
  });
} catch (error) { failures.push({ name: 'scenario', error: String(error.message) }); }

document.getElementById('result').textContent = JSON.stringify({ passed: checks.length, checks, errors, failures, diagnostics, lastCalls: calls.slice(-4).map(call => ({ path: call.path, body: String(call.init.body ?? '').slice(0, 400) })),
  page: { error: $('aika-error')?.textContent ?? null, message: $('aika-message')?.textContent ?? null, revision: $('aika-settings-revision')?.textContent ?? null, slots: $('aika-slots')?.children.length ?? null, calls: calls.map(call => call.path) } });
document.getElementById('result').dataset.complete = 'true';
