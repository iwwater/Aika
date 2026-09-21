// FIX61-11 11-E scenario: drives the REAL console page in Windows Chromium.
//
// It replaces only the network transport (`globalThis.fetch`), so `app.mjs`, `skin-view.mjs`,
// `health-view.mjs` and `dom.mjs` all run as production code. Every response is shaped exactly like the
// real backend's, and the scenario asserts that each page called the route it is responsible for.
const checks = [];
const check = (name, condition, detail) => { checks.push({ name, ok: !!condition, detail }); };

function finish() {
  const result = document.createElement('script');
  result.type = 'application/json';
  result.id = 'console-result';
  result.dataset.complete = 'true';
  result.textContent = JSON.stringify({ passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, checks });
  document.body.append(result);
}

const requested = [];

const SKIN_STATE = { apiVersion: 1, state: { schemaVersion: 1, revision: 3, activeSkinId: 'local-model', skins: [
  { skinId: 'local-model', label: '内建模型', origin: 'builtin', modelEntry: 'pet.model3.json',
    modelFingerprint: 'a'.repeat(64), assetFingerprint: 'b'.repeat(64),
    parameters: { headYaw: 'ParamAngleX', headPitch: 'ParamAngleY', headRoll: 'ParamAngleZ', mouthForm: 'ParamMouthForm' },
    capabilities: { textures: 1, expressions: 10, motions: 12, presets: 'authored', automaticPresets: 4, mocVersion: 1 },
    importedAt: '', bytes: 771072 },
  { skinId: 'second-pack', label: '第二套外观', origin: 'imported', modelEntry: 'pet.model3.json',
    modelFingerprint: 'c'.repeat(64), assetFingerprint: 'd'.repeat(64),
    parameters: { headYaw: 'ParamAngleX', headPitch: 'ParamAngleY', headRoll: 'ParamAngleZ', mouthForm: 'ParamMouthForm' },
    capabilities: { textures: 2, expressions: 4, motions: 10, presets: 'generated-disabled', automaticPresets: 0, mocVersion: 4 },
    importedAt: '2026-09-21T00:00:00.000Z', bytes: 443648 }
] } };

// A snapshot with zero operational evidence: before the first conversation the lights are honestly amber.
const HEALTH = { configRevision: 12, observedAt: '2026-09-21T00:00:00.000Z', modules: {
  dialogue: { module: 'dialogue', label: '对话大模型', state: 'unknown', checkedAt: '2026-09-21T00:00:00.000Z', configRevision: 12, stale: false,
    evidence: { configured: false, reachable: false, operational: false }, reasonCode: 'not_configured',
    repairAction: '请在配置页为此模块保存服务地址、模型与凭据。' },
  asr: { module: 'asr', label: '语音转写', state: 'degraded', checkedAt: '2026-09-21T00:00:00.000Z', configRevision: 12, stale: false,
    evidence: { configured: true, reachable: true, operational: false }, reasonCode: 'inference_unverified',
    repairAction: '端点可访问，但尚未确认该模型能完成实际推理；请发起一次真实请求。' }
} };

const SNAPSHOT = { apiVersion: 1, runtime: { instanceId: 'ui-instance', online: true, characterId: 'companion', sourceRevision: 'a'.repeat(40),
  pid: 1, startedAt: '2026-09-21T00:00:00.000Z', observedAt: '2026-09-21T00:00:00.000Z', sessionId: 'ui-session' },
  characters: [{ id: 'companion', label: '青梅竹马' }], modules: [], events: [], adapters: [], credentials: [],
  balances: { items: [], total: null }, accounting: { entries: [], totalMicros: 0 },
  settings: { revision: 0, effectiveRevision: 0, pending: false, saved: { context: {} }, effective: { providers: {}, context: {} } } };

window.fetch = async (input, init) => {
  const url = String(input);
  requested.push({ url, method: init?.method ?? 'GET' });
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/api/skins') && url.includes('/activate')) return json(SKIN_STATE);
  if (url.includes('/api/skins')) return json(SKIN_STATE);
  if (/\/api\/health\/[A-Za-z0-9_]+$/.test(url)) return json(HEALTH.modules.dialogue);
  if (url.includes('/api/health')) return json(HEALTH);
  if (url.includes('/api/snapshot')) return json(SNAPSHOT);
  // Every other page route returns an empty, well-formed answer so the shell finishes booting.
  if (url.includes('/api/self-setup')) return json({ mode: 'runtime' });
  if (url.includes('/api/balances')) return json({ items: [], total: null });
  return json({});
};
window.addEventListener('error', event => check('no script error', false, String(event.message)));
window.addEventListener('unhandledrejection', event => check('no promise rejection', false, String(event.reason)));

const wait = ms => new Promise(done => setTimeout(done, ms));

async function clickTab(label) {
  const tab = [...document.querySelectorAll('nav.nav button')].find(node => node.textContent.trim() === label);
  if (!tab) return false;
  tab.click();
  await wait(180);
  return true;
}

async function scenario() {
  // 1. The console boots against the recording transport and shows the new navigation entries.
  for (let attempt = 0; attempt < 120 && !document.querySelector('nav.nav'); attempt++) await wait(50);
  const nav = document.querySelector('nav.nav');
  check('the console shell rendered its navigation', !!nav, nav ? nav.textContent : 'missing');
  const skinTab = [...(nav?.querySelectorAll('button') ?? [])].find(node => node.textContent.includes('外观'));
  const healthTab = [...(nav?.querySelectorAll('button') ?? [])].find(node => node.textContent.includes('模块状态'));
  check('the sidebar offers 外观 / 换肤', !!skinTab, nav?.textContent);
  check('the sidebar offers 模块状态', !!healthTab, nav?.textContent);

  // 2. 外观 / 换肤 renders both skins and offers a switch that is not for the active one.
  check('the skin page opened', await clickTab('外观 / 换肤'));
  const skinPage = document.querySelector('.skin-page');
  check('the skin page rendered', !!skinPage, document.body.textContent?.slice(0, 200));
  check('the skin page called GET /api/skins', requested.some(r => /\/api\/skins(\?|$)/.test(r.url) && r.method === 'GET'), JSON.stringify(requested.slice(0, 6)));
  const text = skinPage?.textContent ?? '';
  check('both registered skins are listed', text.includes('内建模型') && text.includes('第二套外观'), text.slice(0, 200));
  check('the active appearance is named', /当前外观：内建模型/.test(text), text.slice(0, 200));
  check('the appearance-only boundary is stated', /不会改变 characterId|不会改变.*身份/.test(text), text.slice(0, 300));
  check('a pack with no reviewed catalog says so', /不会自动播放任何动作/.test(text), text);
  const activate = document.getElementById('skin-activate-second-pack');
  check('a non-active skin can be switched to', !!activate && activate.disabled === false, activate ? 'disabled=' + activate.disabled : 'missing');
  const alreadyActive = document.getElementById('skin-activate-local-model');
  check('the active skin offers no pointless switch', !!alreadyActive && alreadyActive.disabled === true, alreadyActive ? 'disabled=' + alreadyActive.disabled : 'missing');
  const removeBuiltin = document.getElementById('skin-remove-local-model');
  check('the built-in skin offers no delete', !removeBuiltin, removeBuiltin ? 'present' : 'absent');
  const removeImported = document.getElementById('skin-remove-second-pack');
  check('an unused imported pack offers delete', !!removeImported, removeImported ? 'present' : 'missing');
  // The import entry is how a user actually adds a pack.
  check('the import form is present', !!document.getElementById('skin-import') && !!document.getElementById('skin-source'), 'import form');

  // 3. 模块状态 reads the health snapshot and shows the honest pre-conversation state.
  check('the health page opened', await clickTab('模块状态'));
  const healthPage = document.querySelector('.health-page');
  check('the health page rendered', !!healthPage, document.body.textContent?.slice(0, 200));
  check('the health page called GET /api/health', requested.some(r => /\/api\/health(\?|$)/.test(r.url)), JSON.stringify(requested.slice(-4)));
  const healthText = healthPage?.textContent ?? '';
  check('the pre-conversation amber state is shown as 尚未确认', healthText.includes('尚未确认'), healthText.slice(0, 300));
  check('a reachable-but-unproven module is not shown as ready', !/对话大模型[^]{0,80}就绪/.test(healthText), healthText.slice(0, 300));
  check('the no-paid-probe design is explained', /不会主动探测任何端点/.test(healthText), healthText.slice(0, 400));
  check('each non-green module names a repair action', /发起一次真实请求|保存服务地址/.test(healthText), healthText.slice(0, 400));
  const inspect = document.getElementById('health-inspect-dialogue');
  check('a module offers its repair entry', !!inspect, inspect ? 'present' : 'missing');
  inspect?.click();
  await wait(180);
  check('the repair entry called the per-module route', requested.some(r => /\/api\/health\/dialogue$/.test(r.url)), JSON.stringify(requested.slice(-3)));
  check('the repair entry is displayed', !!document.getElementById('health-detail-close'), document.body.textContent?.slice(0, 200));

  finish();
}
window.addEventListener('load', () => { void scenario(); });
