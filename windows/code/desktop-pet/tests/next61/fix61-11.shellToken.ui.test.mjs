import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSessionOrigin } from './fix61-11.shellToken.ui-fixture.mjs';

// FIX61-11 shell token: 外观 / 换肤 must arrive AUTHORIZED.
//
// The REAL host (`desktop/electron/main.mjs`) runs in a real Electron process, and the REAL function-panel
// buttons the production renderer publishes are clicked. Only `shell.openExternal` is replaced, by a
// recorder — the host calls it unmodified, and the URL recorded is the exact string the browser would be
// asked to open. That URL is then loaded in a real Chromium window against the real console page, so "the
// user lands on the right page while logged in" is asserted on the console's own DOM.
//
// Why a source-text check was not enough: the old `new URL(value.path, url)` had `/#page=skins` in its
// source and still dropped `#token=…`, so a regex over the file passes while the window is locked. The
// red/green difference only exists at this boundary.
//
// The entry ids below are the production ids from `desktop/pointer-router.ts`; the renderer names each
// button `function-<id>`, so a renamed or removed entry fails here instead of silently shrinking the test.
const ENTRIES = [
  { id: 'skin', page: '外观 / 换肤', tab: 'nav-skins', marker: '.skin-page', route: '/api/skins', page_: 'skins' },
  { id: 'memory', page: '记忆与对话', tab: 'nav-memory', marker: null, route: '/api/records', section: 'records' },
];
const TOKEN = 'a'.repeat(64);
const INSTANCE = 'shell-token-instance', REVISION = 'e'.repeat(40);
const project = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Run the production host, click the panel entries, and return one result per entry.
 *
 * The session descriptor is deliberately NOT written here. The host's opener is the thing that proves a
 * session usable, so this runner only supplies where the descriptor belongs; `/api/snapshot` reads it back
 * and refuses to confirm an identity the opener never accepted.
 */
async function runHost(t, entries) {
  const temp = await mkdtemp(join(tmpdir(), 'w61-shell-token-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configDir = join(temp, 'config');
  await mkdir(configDir, { recursive: true });
  const sessionFile = join(configDir, 'management-session.json');
  // The origin must exist before the session URL is written, because the opener validates it: a session
  // that names no reachable loopback origin is rejected before anything is opened.
  const fixture = await startSessionOrigin({
    descriptorFile: sessionFile, token: TOKEN, scenarioFile: './fix61-11.deeplink.ui-scenario.mjs',
  });
  t.after(() => fixture.close());
  const request = {
    temp, instanceId: INSTANCE, sourceRevision: REVISION, token: TOKEN, origin: fixture.origin,
    configFile: join(configDir, 'config.json'),
    sessionFile,
    desktopRoot: join(project, 'desktop'),
    previewBackend: join(project, 'dist', 'app', 'preview-backend.js'),
    entries: entries.map(entry => ({ id: entry.id })),
  };
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PET_TRIAL_CONFIG;
  delete env.PET_TRIAL_ACTIVATION;
  const child = spawn(createRequire(import.meta.url)('electron'), [
    fileURLToPath(new URL('./fix61-11.shellToken.ui-electron.mjs', import.meta.url)),
    Buffer.from(JSON.stringify(request), 'utf8').toString('base64url'),
  ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => t.diagnostic(bytes.toString()));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Electron exited ' + code + ': ' + output.slice(-800))));
  });
  const prefix = 'SHELL_TOKEN_RESULT=';
  const line = output.split(/\r?\n/).find(value => value.startsWith(prefix));
  assert.ok(line, 'the host must report the panel results: ' + output.slice(-800));
  const payload = JSON.parse(line.slice(prefix.length));
  assert.equal(payload.error, undefined, 'the host scenario must complete: ' + JSON.stringify(payload));
  assert.equal(payload.length, entries.length, 'every panel entry must produce exactly one opened URL');
  return { payload, fixture, origin: fixture.origin };
}

test('FIX61-11 the function panel opens the console page with the session token intact', { timeout: 300_000 }, async t => {
  const { payload, fixture, origin } = await runHost(t, ENTRIES);

  // The real session check ran, and it authenticated with the session token: a composition that lost the
  // token cannot get this far, because the opener would have rejected the session before opening anything.
  assert.ok(fixture.probes.length >= ENTRIES.length, 'the real session check must run for every entry');
  assert.deepEqual([...new Set(fixture.probes)], ['Bearer ' + TOKEN], 'the session check authenticates with the session token');

  for (const [index, entry] of ENTRIES.entries()) {
    const result = payload[index];
    assert.equal(result.entry, entry.id, 'results must stay in panel order');
    assert.equal(result.error, undefined, entry.id + ' must reach the console: ' + JSON.stringify(result));

    // 1. THE regression, at the boundary the browser receives: the URL must carry BOTH parts. This is the
    //    assertion that fails when `new URL(value.path, url)` replaces the fragment and drops the token.
    const opened = new URL(result.url);
    assert.equal(opened.origin, origin, entry.id + ' must stay on the local management origin');
    const fragment = new URLSearchParams(opened.hash.slice(1));
    assert.equal(fragment.get('token'), TOKEN, entry.id + ' must carry the session token: ' + result.url);
    assert.ok(opened.hash.slice(1).startsWith('token=' + TOKEN),
      'the token must be the first fragment key — the one management/ui/app.mjs reads: ' + result.url);

    // 2. …and the route survived the merge as well.
    if (entry.page_) assert.equal(fragment.get('page'), entry.page_, entry.id + ' must keep #page=' + entry.page_);
    if (entry.section) assert.equal(fragment.get('section'), entry.section, entry.id + ' must keep #section=' + entry.section);

    // 3. The console the browser would open really is on that page AND really is authorized.
    assert.deepEqual(result.failures, [], entry.id + ' must load without a script error');
    assert.equal(result.entryHash, opened.hash, 'the console must boot from the composed fragment');
    assert.equal(result.renderedShell, true, entry.id + ' must render the console shell');
    assert.equal(result.heading, entry.page, entry.id + ' must land on ' + entry.page + ', got ' + result.heading);
    assert.equal(result.activeTabs.join(','), entry.tab, entry.id + ' must select the ' + entry.page + ' tab');
    assert.equal(result.loginFormPresent, false, entry.id + ' must NOT show the "connect a local session" form');
    assert.ok(result.authorizedRequests > 0, entry.id + ' must send authorized requests, not anonymous ones');
    assert.ok(result.routeCalls.includes('/api/snapshot'), entry.id + ' must boot the console normally');
    if (entry.marker) assert.equal(result.skinPagePresent, true, entry.id + ' must render the real page body');
    if (entry.route) assert.ok(result.routeCalls.includes(entry.route),
      entry.id + ' must read ' + entry.route + ': ' + JSON.stringify(result.routeCalls));
    assert.equal(result.hashAfterBoot, '', entry.id + ' must still clear the token out of the address bar');
  }
});

test('FIX61-11 a route-less entry still opens the session URL unchanged', { timeout: 300_000 }, async t => {
  // The control case for the same composition: the 配置 entry (`openConsole('/')`) must be handed over
  // byte-identical. Without this, "always append the route" could pass the test above while breaking it.
  const { payload, origin } = await runHost(t, [{ id: 'settings' }]);
  const [result] = payload;
  assert.equal(result.error, undefined, 'the 配置 entry must reach the console: ' + JSON.stringify(result));
  assert.equal(result.url, origin + '/#token=' + TOKEN, 'a route-less entry must open the session URL unchanged');
  assert.equal(result.heading, '运行总览', 'the bare session URL opens the default page');
  assert.equal(result.loginFormPresent, false, 'and that page is authorized');
  assert.ok(result.authorizedRequests > 0, 'the default page sends authorized requests');
  assert.deepEqual(result.failures, [], 'the default page must load without a script error');
});
