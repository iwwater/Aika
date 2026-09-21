// FIX61-11 wiring RED->GREEN: the FIX61-05 model-pack registry is reachable by a real user.
//
// Before this change `SkinStore` was imported by nothing in production and `FUNCTION_CAPABILITIES` disabled
// the panel entry, so 换肤 was unreachable. These assertions drive the REAL `SkinStore` through the REAL
// authenticated management server, so they fail if the route is unmounted or the store is not wired.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkinStore } from '../../management/skin-store.js';
import { SKIN_API_VERSION } from '../../management/skin-routes.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { fixture } from '../management/helpers.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const desktop = join(projectRoot, 'code/desktop-pet/desktop');

/** A real management server with the real skin route, over the real built-in rig directory. */
async function server(t: { after(fn: () => Promise<void>): void }) {
  const f = await fixture(t);
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../.local/fix61-11/tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'skin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await SkinStore.open(join(root, 'skins.json'), join(root, 'packs'), desktop);
  const settings = await ManagementSettingsStore.open(join(root, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const instance = await startManagementServer({ uiRoot: join(f.c.projectRoot, 'ui'), settings, skins: store,
    memory: { characters: () => [], list: () => { throw new Error('not used'); }, edit: () => { throw new Error('not used'); },
      context: () => { throw new Error('not used'); }, prompt: () => { throw new Error('not used'); }, savePrompt: () => { throw new Error('not used'); } },
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: [], events: [], adapters: [], credentials: [], characters: [], settings: settings.snapshot() }) });
  t.after(() => instance.close());
  const headers = { Authorization: 'Bearer ' + instance.token, Origin: instance.origin, 'Content-Type': 'application/json' };
  return { store, root, url: instance.origin, headers, settings };
}

test('11-A the skin registry is mounted behind the existing management authentication', async t => {
  const s = await server(t);

  // An unauthenticated read must be refused exactly like every other management route.
  assert.equal((await fetch(s.url + '/api/skins')).status, 401, 'the skin route is behind the session token');

  const listed = await fetch(s.url + '/api/skins', { headers: s.headers });
  assert.equal(listed.status, 200);
  const body = await listed.json() as { apiVersion: number; state: { schemaVersion: number; revision: number; activeSkinId: string; skins: { skinId: string; origin: string }[] } };
  // The published capability version is what lets the renderer detect the feature instead of guessing.
  assert.equal(body.apiVersion, SKIN_API_VERSION, 'the response names the skin API version');
  assert.equal(body.state.schemaVersion, 1);
  assert.equal(body.state.activeSkinId, 'local-model');
  assert.deepEqual(body.state.skins.map(skin => skin.skinId), ['local-model'], 'the built-in rig is registered without an import');
  assert.equal(body.state.skins[0]!.origin, 'builtin');
});

test('11-A a real pack imports, activates and is served through its own registry route', async t => {
  const s = await server(t);
  const pack = join(s.root, 'second-pack');
  await cp(join(desktop, 'assets/local-model'), pack, { recursive: true });

  const imported = await fetch(s.url + '/api/skins/import', { method: 'POST', headers: s.headers,
    body: JSON.stringify({ source: pack, skinId: 'second-pack', label: '第二套外观' }) });
  assert.equal(imported.status, 200, 'the import is accepted');
  const afterImport = await imported.json() as { state: { revision: number; skins: { skinId: string; label: string }[] } };
  assert.equal(afterImport.state.revision, 1, 'an accepted import bumps the registry revision once');
  assert.deepEqual(afterImport.state.skins.map(skin => skin.skinId), ['local-model', 'second-pack']);
  assert.equal(afterImport.state.skins[1]!.label, '第二套外观');

  // A stale revision is refused through the existing error envelope, never silently applied.
  const stale = await fetch(s.url + '/api/skins/local-model/activate', { method: 'POST', headers: s.headers, body: JSON.stringify({ expectedRevision: 0 }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { error: { code: string } }).error.code, 'version_conflict');

  const activated = await fetch(s.url + '/api/skins/second-pack/activate', { method: 'POST', headers: s.headers, body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(activated.status, 200);
  const state = await activated.json() as { state: { revision: number; activeSkinId: string } };
  assert.equal(state.state.activeSkinId, 'second-pack');
  assert.equal(state.state.revision, 2);
  // The switch is durable: the store on disk now says the same thing.
  const reopened = await SkinStore.open(join(s.root, 'skins.json'), join(s.root, 'packs'), desktop);
  assert.equal(reopened.active().skinId, 'second-pack');

  // A real registered asset is served as bytes, resolved by the registry (not by the request path).
  const asset = await fetch(s.url + '/api/skins/second-pack/asset/' + encodeURIComponent('pet.model3.json'), { headers: s.headers });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') ?? '', /application\/json/);
  const manifest = JSON.parse(await asset.text()) as { FileReferences: { Moc: string } };
  assert.equal(typeof manifest.FileReferences.Moc, 'string', 'the served entry really is the pack manifest');
  // The two packs serve their own copy of the same relative path.
  const builtinAsset = await fetch(s.url + '/api/skins/local-model/asset/' + encodeURIComponent('pet.model3.json'), { headers: s.headers });
  assert.equal(builtinAsset.status, 200);
  assert.equal(await builtinAsset.text(), await readFile(join(desktop, 'assets/local-model/pet.model3.json'), 'utf8'),
    'the built-in skin still serves bytes from its own bound directory');

  // An unused pack is removable; the built-in one never is.
  const builtinRemove = await fetch(s.url + '/api/skins/local-model/remove', { method: 'POST', headers: s.headers, body: JSON.stringify({ expectedRevision: 2 }) });
  assert.equal(builtinRemove.status, 400, 'the built-in model pack cannot be deleted');
});

test('11-B asset path containment: traversal, drive letters and unknown ids never reach disk', async t => {
  const s = await server(t);

  // Every one of these is refused, and none of them may ever return file content. A malformed path is an
  // invalid request (400) and a well-formed but unregistered path is simply not there (404); both refuse.
  for (const path of ['..%2Fconfig%2Fparameter-map.json', '..%2f..%2fpackage.json', '%2e%2e%2fpresets.json',
    'C%3A%5Cwindows%5Cwin.ini', 'a%2F..%2F..%2Fb', '%2Fetc%2Fpasswd']) {
    const response = await fetch(s.url + '/api/skins/local-model/asset/' + path, { headers: s.headers });
    assert.ok([400, 404].includes(response.status), 'unregistrable asset path ' + path + ' was not refused (got ' + response.status + ')');
    const body = await response.text();
    assert.ok(!body.includes('ParamAngleX'), 'a refused path must not leak configuration content: ' + path);
    assert.ok(!body.includes('[extensions]') && !body.includes('root'), 'a refused path must not leak host files: ' + path);
  }
  for (const id of ['nope', '../x', 'x'.repeat(60)]) {
    const response = await fetch(s.url + '/api/skins/' + encodeURIComponent(id) + '/asset/pet.model3.json', { headers: s.headers });
    assert.equal(response.status, 404, 'unknown skin: ' + id);
  }
  // A path that IS registered but belongs to another pack is not servable under this skin.
  const crossPack = await fetch(s.url + '/api/skins/local-model/asset/' + encodeURIComponent('../second-pack/pet.model3.json'), { headers: s.headers });
  assert.ok([400, 404].includes(crossPack.status), 'a cross-pack asset is refused');
  // The registry itself is the authority: the store resolves nothing for these either.
  assert.equal(s.store.asset('local-model', '../config/parameter-map.json'), null);
  assert.equal(s.store.asset('nope', 'pet.model3.json'), null);

  // A rejected asset operation never becomes a second configuration authority: nothing was written.
  const rejected = await fetch(s.url + '/api/skins/import', { method: 'POST', headers: s.headers, body: JSON.stringify({ source: join(s.root, 'does-not-exist') }) });
  assert.equal(rejected.status, 404);
  assert.equal((await s.store.state()).revision, 0, 'a refused import leaves the registry untouched');
  assert.deepEqual((await s.store.state()).skins.map(skin => skin.skinId), ['local-model']);
});

test('11-B the skin route rejects an unsafe reference inside the pack and keeps the current appearance', async t => {
  const s = await server(t);
  const escaping = join(s.root, 'escaping');
  await cp(join(desktop, 'assets/local-model'), escaping, { recursive: true });
  const manifest = JSON.parse(await readFile(join(escaping, 'pet.model3.json'), 'utf8'));
  manifest.FileReferences.Moc = '../../outside.moc3';
  await writeFile(join(escaping, 'pet.model3.json'), JSON.stringify(manifest));

  const response = await fetch(s.url + '/api/skins/import', { method: 'POST', headers: s.headers, body: JSON.stringify({ source: escaping, skinId: 'escaping' }) });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: { message: string } }).error.message, /路径|引用/);
  assert.equal((await s.store.state()).activeSkinId, 'local-model', 'the active appearance is unchanged');
  assert.equal((await s.store.state()).revision, 0);
});

test('11-C a skin is appearance only: the route never carries identity, voice, knowledge or memory', async t => {
  const s = await server(t);
  const response = await fetch(s.url + '/api/skins', { headers: s.headers });
  const text = await response.text();
  // The management plane may not grow a skin-shaped path to identity or Memory.
  for (const forbidden of ['characterId', 'knowledgeLibrary', 'memory', 'voice', 'credential']) {
    assert.ok(!text.includes('"' + forbidden + '"'), 'the skin response must not carry ' + forbidden);
  }
  const body = JSON.parse(text) as { state: { skins: Record<string, unknown>[] } };
  for (const skin of body.state.skins) {
    assert.ok(!('characterId' in skin), 'a skin descriptor carries no character identity');
    assert.notEqual(skin.skinId, 'companion', 'a skinId is deliberately not a characterId');
  }
  // configure-model.mjs keeps exactly one binding authority for the built-in rig.
  const configure = await readFile(join(projectRoot, 'code/desktop-pet/tools/configure-model.mjs'), 'utf8');
  assert.match(configure, /validateModelDirectory/, 'the model validator is extracted and exported');
  assert.match(configure, /desktop\/assets\/local-model/, 'the built-in rig keeps its single bound directory');
  const route = await readFile(join(projectRoot, 'code/desktop-pet/management/skin-routes.ts'), 'utf8');
  assert.ok(!/presets\.json/.test(route.replace(/^\s*\/\/.*$/gm, '')), 'the skin route never writes a preset catalog');
});
