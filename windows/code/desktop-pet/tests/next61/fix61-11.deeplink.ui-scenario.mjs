// FIX61-11 deep-link scenario: what page does the REAL console select from the URL hash it was opened with?
//
// The scenario never clicks a tab and never calls the shell's internals. It replaces only the network
// transport (`globalThis.fetch`), waits for the production `app.mjs` to boot, and reports what the DOM
// actually contains: the page heading, which sidebar tab is selected, which view is rendered, and which
// routes that page read. The Node test then asserts one expectation per URL — so a console that silently
// ignores `#page=`/`#section=` fails here even though its source still contains the entry strings.
const entryHash = location.hash;
const requests = [];
const failures = [];

window.addEventListener('error', event => failures.push('script error: ' + String(event.message)));
window.addEventListener('unhandledrejection', event => failures.push('promise rejection: ' + String(event.reason)));

const SKIN_STATE = { apiVersion: 1, state: { schemaVersion: 1, revision: 3, activeSkinId: 'local-model', skins: [
  { skinId: 'local-model', label: '内建模型', origin: 'builtin', modelEntry: 'pet.model3.json',
    modelFingerprint: 'a'.repeat(64), assetFingerprint: 'b'.repeat(64),
    parameters: { headYaw: 'ParamAngleX', headPitch: 'ParamAngleY', headRoll: 'ParamAngleZ', mouthForm: 'ParamMouthForm' },
    capabilities: { textures: 1, expressions: 10, motions: 12, presets: 'authored', automaticPresets: 4, mocVersion: 1 },
    importedAt: '', bytes: 771072 }
] } };

const SNAPSHOT = { apiVersion: 1, runtime: { instanceId: 'deeplink-instance', online: true, characterId: 'companion', sourceRevision: 'a'.repeat(40),
  pid: 1, startedAt: '2026-09-21T00:00:00.000Z', observedAt: '2026-09-21T00:00:00.000Z', sessionId: 'deeplink-session' },
  characters: [{ id: 'companion', label: '青梅竹马' }], modules: [], events: [], adapters: [], credentials: [],
  balances: { items: [], total: null }, accounting: { entries: [], totalMicros: 0 },
  settings: { revision: 0, effectiveRevision: 0, pending: false, saved: { context: {} }, effective: { providers: {}, context: {} } } };

window.fetch = async (input, init) => {
  const url = String(input);
  const authorization = new Headers(init?.headers ?? {}).get('authorization');
  requests.push({ url, method: init?.method ?? 'GET', authorized: !!authorization });
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/api/skins')) return json(SKIN_STATE);
  if (url.includes('/api/snapshot')) return json(SNAPSHOT);
  if (url.includes('/api/self-setup')) return json({ mode: 'runtime' });
  if (url.includes('/api/records')) return json({ characterId: 'companion', kind: 'memory', state: 'active', offset: 0, total: 0, records: [] });
  if (url.includes('/api/balances')) return json({ items: [], total: null });
  return json({});
};

const wait = ms => new Promise(done => setTimeout(done, ms));
const activeTabs = () => [...document.querySelectorAll('nav.nav [role=tab]')].filter(node => node.getAttribute('aria-selected') === 'true').map(node => node.id);

async function facts() {
  // Wait for the shell to reach a stable state: either a page is rendered, or the session is still locked
  // (an unauthenticated deep link must still select its page, so both outcomes are recorded, not hidden).
  for (let attempt = 0; attempt < 160; attempt++) {
    if (document.querySelector('.page-content') || document.querySelector('form.login')) break;
    await wait(50);
  }
  await wait(250);
  const heading = document.querySelector('.topbar h1');
  const pressedTabs = [...document.querySelectorAll('[id^="memory-"][aria-pressed]')].filter(node => node.getAttribute('aria-pressed') === 'true').map(node => node.id);
  return {
    entryHash,
    hashAfterBoot: location.hash,
    heading: heading?.textContent ?? null,
    renderedShell: !!document.querySelector('nav.nav'),
    tabCount: document.querySelectorAll('nav.nav [role=tab]').length,
    activeTabs: activeTabs(),
    skinPagePresent: !!document.querySelector('.skin-page'),
    healthPagePresent: !!document.querySelector('.health-page'),
    loginFormPresent: !!document.querySelector('form.login'),
    memoryTabPressed: pressedTabs,
    routeCalls: requests.map(r => (r.method === 'GET' ? '' : r.method + ' ') + new URL(r.url, location.origin).pathname),
    authorizedRequests: requests.filter(r => r.authorized).length,
    failures
  };
}

window.addEventListener('load', async () => {
  const collected = await facts();
  const result = document.createElement('script');
  result.type = 'application/json';
  result.id = 'console-result';
  result.dataset.complete = 'true';
  result.textContent = JSON.stringify(collected);
  document.body.append(result);
});
