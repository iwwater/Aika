import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startConsoleFixture } from './fix61-11.deeplink.ui-fixture.mjs';

// FIX61-11 deep link: the desktop function panel opens the console at a ROUTE (`/#page=skins`), so a real
// Windows Chromium window must load that exact URL — with the real `app.mjs`, `views.mjs` and `skin-view.mjs`
// — and show the page the hash names. This is asserted on the DOM the window produced (heading, selected
// sidebar tab, rendered page, the routes that page called), never on the console's source text: the entry
// string existing in the source is exactly what the old tests checked while the navigation was inert.
const URLS = {
  // The real session URL the backend publishes (`management/server.ts`): token only, default page.
  session: '/#token=synthetic-session-token',
  // The desktop function panel's 外观 / 换肤 entry, with and without a session in the hash.
  skinsNoToken: '/#page=skins',
  skinsTokenFirst: '/#token=synthetic-session-token&page=skins',
  skinsTokenLast: '/#page=skins&token=synthetic-session-token',
  // The pre-existing panel entries that were equally inert (`desktop/pointer-router.ts`).
  recordsSection: '/#token=synthetic-session-token&section=records',
  recordsSectionNoToken: '/#section=records',
  memoryRecords: '/#token=synthetic-session-token&page=memory&section=records',
  memoryPrompt: '/#token=synthetic-session-token&section=prompt',
  // Ids that must not select anything: an unregistered page and a path-traversal attempt.
  unknownPage: '/#page=nonexistent',
  hostilePage: '/#page=../../etc/passwd&page[]=skins'
};

test('Windows Chromium: the console selects the page named by its URL hash', { timeout: 180_000 }, async t => {
  const fixture = await startConsoleFixture('./fix61-11.deeplink.ui-scenario.mjs');
  t.after(() => fixture.close());
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const request = Buffer.from(JSON.stringify({ origin: fixture.origin, hashes: Object.values(URLS) }), 'utf8').toString('base64url');
  const child = spawn(createRequire(import.meta.url)('electron'), [
    fileURLToPath(new URL('./fix61-11.deeplink.ui-electron.mjs', import.meta.url)), request,
  ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => t.diagnostic(bytes.toString()));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Electron exited ' + code)));
  });
  const prefix = 'CONSOLE_DEEPLINK_RESULT=';
  const line = output.split(/\r?\n/).find(value => value.startsWith(prefix));
  assert.ok(line, 'Electron must return its deep-link scenario results');
  const results = JSON.parse(line.slice(prefix.length));
  assert.equal(results.length, Object.values(URLS).length, 'every deep link must be loaded: ' + line.slice(0, 400));
  const seen = new Map(results.map(result => [result.url.split('/#')[1] ?? '', result]));
  const facts = key => {
    const result = seen.get(URLS[key].slice(2));
    assert.ok(result, 'the scenario must report the ' + key + ' window');
    assert.equal(result.error, undefined, key + ' must complete: ' + JSON.stringify(result));
    assert.deepEqual(result.failures, [], key + ' must not raise a script error');
    assert.equal(result.renderedShell, true, key + ' must render the console shell');
    assert.equal(result.tabCount, 10, key + ' must render every sidebar entry');
    return result;
  };

  // 1. The real session URL (`/#token=…`) keeps both of its old behaviours: the session is connected and
  //    the page is the default one.
  const session = facts('session');
  assert.equal(session.heading, '运行总览', 'a token-only URL opens the default page');
  assert.equal(session.activeTabs.join(','), 'nav-overview', 'exactly the default tab is selected');
  assert.ok(session.authorizedRequests > 0, 'the URL token still authenticates the console');
  assert.equal(session.hashAfterBoot, '', 'the session token is still cleared out of the address bar');
  assert.equal(session.loginFormPresent, false, 'a valid token never shows the manual login form');

  // 2. THE regression: `/#page=skins` is what `desktop/main.mjs` opens for 外观 / 换肤. The DOM must show
  //    that page — the skin view, its heading and its own route call — not the overview.
  for (const key of ['skinsNoToken', 'skinsTokenFirst', 'skinsTokenLast']) {
    const skins = facts(key);
    assert.equal(skins.heading, '外观 / 换肤', key + ' must select 外观 / 换肤, not 运行总览');
    assert.equal(skins.activeTabs.join(','), 'nav-skins', key + ' must select the 外观 / 换肤 sidebar tab');
    assert.equal(skins.healthPagePresent, false, key + ' must not render another page');
  }
  // A deep link without a session still selects the page and asks for authorization instead of silently
  // falling back to 运行总览; a deep link that carries the token renders the real page over its real route.
  const skinsNoToken = facts('skinsNoToken');
  assert.equal(skinsNoToken.skinPagePresent, false, 'without a session the page content waits for authorization');
  assert.equal(skinsNoToken.loginFormPresent, true, 'without a session the console still offers the local session form');
  for (const key of ['skinsTokenFirst', 'skinsTokenLast']) {
    const skins = facts(key);
    assert.equal(skins.skinPagePresent, true, key + ' must render the real skin page');
    assert.ok(skins.routeCalls.includes('/api/skins'), key + ' must read the skins route: ' + JSON.stringify(skins.routeCalls));
    assert.ok(skins.authorizedRequests > 0, key + ' must stay authenticated');
    assert.equal(skins.loginFormPresent, false, key + ' must not show the session form');
    assert.ok(skins.routeCalls.includes('/api/snapshot'), key + ' must still boot the console normally');
  }

  // 3. The pre-existing `#section=` entries become reachable too: 记忆 (records) and 角色设定 Prompt.
  //    The sub-tab only exists once the page has a session, so the token-bearing URL asserts the sub-tab
  //    and the token-less one asserts the page-level selection.
  const records = facts('recordsSection');
  assert.equal(records.heading, '记忆与对话', '#section=records must open the memory page');
  assert.equal(records.activeTabs.join(','), 'nav-memory', '#section=records must select 记忆与对话');
  assert.deepEqual(records.memoryTabPressed, ['memory-records'], '#section=records must select the records sub-tab');
  assert.ok(records.routeCalls.includes('/api/records'), 'the records sub-tab must read its own route: ' + JSON.stringify(records.routeCalls));
  assert.equal(records.skinPagePresent, false, '#section=records must not land on an unrelated page');
  const recordsNoToken = facts('recordsSectionNoToken');
  assert.equal(recordsNoToken.heading, '记忆与对话', 'a token-less #section=records still selects the page');
  assert.equal(recordsNoToken.activeTabs.join(','), 'nav-memory', 'a token-less #section=records still selects the tab');
  const prompt = facts('memoryPrompt');
  assert.deepEqual(prompt.memoryTabPressed, ['memory-prompt'], '#section=prompt must select the prompt sub-tab');
  const combined = facts('memoryRecords');
  assert.equal(combined.heading, '记忆与对话', 'a page+section deep link must use both parts');
  assert.deepEqual(combined.memoryTabPressed, ['memory-records'], '#page=memory&section=records must select the sub-tab');

  // 4. An unusable id falls back to the default page: never a crash, never a blank shell.
  for (const key of ['unknownPage', 'hostilePage']) {
    const fallback = facts(key);
    assert.equal(fallback.heading, '运行总览', key + ' must fall back to the default page');
    assert.equal(fallback.activeTabs.join(','), 'nav-overview', key + ' must fall back to the default tab');
    assert.equal(fallback.skinPagePresent, false, key + ' must not open a page it did not ask for');
  }

  // 5. None of the deep links may smuggle the token back into the address bar.
  for (const result of results) assert.equal(result.hashAfterBoot, '', 'every URL is normalized after boot');
});
