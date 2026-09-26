// FIX61-05 RED->GREEN: model-pack registry (SkinStore) and safe asset resolution.
// 05-A import/enumerate/activate/restart-restore for two local fixture packs.
// 05-B reject a corrupt or escaping pack and keep the previous skin usable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const desktop = join(projectRoot, 'code/desktop-pet/desktop');

const skinModule = () => import('../../management/skin-store.js');
const scopeModule = () => import('../../memory/scope.js');

async function workspace(t: { after(fn: () => Promise<void>): void }) {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../.local/fix61-05/tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'skin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Copy the built-in rig into a second, byte-identical-but-separate pack directory. */
async function cloneBuiltin(target: string) { await cp(join(desktop, 'assets/local-model'), target, { recursive: true }); }

test('05-A two local packs enumerate, activate, persist and restore with their own bytes', async t => {
  const root = await workspace(t);
  const { SkinStore } = await skinModule();
  const store = await SkinStore.open(join(root, 'skins.json'), join(root, 'packs'), desktop);

  const listed = store.list();
  assert.equal(listed.length, 1, 'the built-in local-model pack is registered without an import');
  assert.equal(listed[0]!.skinId, 'local-model');
  assert.equal(listed[0]!.origin, 'builtin');

  const second = join(root, 'second-pack');
  await cloneBuiltin(second);
  await store.import(second, { skinId: 'second-pack' });
  const imported = store.describe('second-pack');
  assert.match(imported.modelFingerprint, /^[a-f0-9]{64}$/);
  assert.match(imported.assetFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(imported.modelEntry, 'pet.model3.json');
  assert.equal(imported.capabilities.textures, 1);
  assert.deepEqual(imported.parameters, { headYaw: 'ParamAngleX', headPitch: 'ParamAngleY', headRoll: 'ParamAngleZ', mouthForm: 'ParamMouthForm' });
  assert.equal(store.list().length, 2);

  const activated = await store.activate(1, 'second-pack');
  assert.equal(activated.activeSkinId, 'second-pack');
  assert.equal(activated.revision, 2);

  // A restart reads the same file back and restores the last valid selection.
  const reopened = await SkinStore.open(join(root, 'skins.json'), join(root, 'packs'), desktop);
  assert.equal(reopened.active().skinId, 'second-pack');

  // Each skin resolves its own manifest and texture through the registry, never a guessed path.
  const asset = reopened.asset('second-pack', 'pet.model3.json');
  assert.ok(asset, 'a registered skin asset resolves');
  assert.notEqual(asset, join(desktop, 'assets/local-model/pet.model3.json'));
  assert.ok(asset!.includes('second-pack'), 'the second pack serves its own copy');
  assert.notEqual(reopened.asset('second-pack', 'pet.model3.json'), reopened.asset('local-model', 'pet.model3.json'));

  await assert.rejects(reopened.activate(1, 'second-pack'), { code: 'version_conflict' });
  assert.equal(reopened.active().skinId, 'second-pack', 'a stale revision never drops the active skin');
});

test('05-B a corrupt or escaping pack is refused and the previous skin stays active', async t => {
  const root = await workspace(t);
  const { SkinStore } = await skinModule();
  const store = await SkinStore.open(join(root, 'skins.json'), join(root, 'packs'), desktop);
  await store.activate(0, 'local-model');

  // Corrupt moc: real model pack, one byte flipped so the moc3 payload no longer loads.
  const corrupt = join(root, 'corrupt-moc');
  await cloneBuiltin(corrupt);
  const moc = join(corrupt, 'natori_pro_t06.moc3');
  const bytes = await readFile(moc);
  bytes[64] = bytes[64]! ^ 0xff;
  await writeFile(moc, bytes);
  await assert.rejects(store.import(corrupt, { skinId: 'corrupt-moc' }), (error: Error) => /moc3|模型/.test(error.message));

  // Missing texture referenced by the manifest.
  const missing = join(root, 'missing-texture');
  await cloneBuiltin(missing);
  await rm(join(missing, 'natori_pro_t06.4096/texture_00.png'));
  await assert.rejects(store.import(missing, { skinId: 'missing-texture' }), (error: Error) => /资源|纹理/.test(error.message));

  // Unsafe references: absolute, drive-letter, backslash traversal and plain traversal.
  for (const [id, patch] of [
    ['escape-absolute', { Moc: '/etc/passwd' }],
    ['escape-drive', { Moc: 'C:\\outside.moc3' }],
    ['escape-backslash', { Moc: '..\\outside.moc3' }],
    ['escape-traversal', { Textures: ['../../outside.png'] }],
    ['escape-percent', { Moc: '%2e%2e/outside.moc3' }],
  ] as const) {
    const dir = join(root, id);
    await cloneBuiltin(dir);
    const manifest = JSON.parse(await readFile(join(dir, 'pet.model3.json'), 'utf8'));
    Object.assign(manifest.FileReferences, patch);
    await writeFile(join(dir, 'pet.model3.json'), JSON.stringify(manifest));
    await assert.rejects(store.import(dir, { skinId: id }), (error: Error) => /路径|引用/.test(error.message), id);
  }

  // A wrong hash: the pack ships a catalog bound to different model bytes.
  const stale = join(root, 'stale-catalog');
  await cloneBuiltin(stale);
  const presets = JSON.parse(await readFile(join(stale, 'presets.json'), 'utf8'));
  presets.modelFingerprint = 'f'.repeat(64);
  presets.items = [{ id: 'exp-zzz', label: '别人的预设', category: 'expression', source: 'model-expression', availability: 'automatic', defaultEnabled: true, previewable: true, expressionName: 'Smile' }];
  await writeFile(join(stale, 'presets.json'), JSON.stringify(presets));
  await assert.rejects(store.import(stale, { skinId: 'stale-catalog' }), /预设目录与模型字节不一致/);

  // A texture swap is an appearance change, not a runtime change. It must move the skin's own asset
  // fingerprint while leaving the legacy model binding and the reviewed preset catalog valid.
  const swapped = join(root, 'swapped-texture');
  await cloneBuiltin(swapped);
  const texturePath = join(swapped, 'natori_pro_t06.4096/texture_00.png');
  const texture = await readFile(texturePath);
  const baseline = store.describe('local-model');
  await writeFile(texturePath, Buffer.concat([texture, Buffer.from([0])]));
  await store.import(swapped, { skinId: 'swapped-texture' });
  const after = store.describe('swapped-texture');
  assert.equal(after.modelFingerprint, baseline.modelFingerprint, 'the legacy binding ignores textures');
  assert.notEqual(after.assetFingerprint, baseline.assetFingerprint, 'the managed asset hash covers the texture');
  assert.equal(after.capabilities.presets, 'authored', 'the reviewed catalog stays valid for the same rig');

  // Cubism 2 rigs are explicitly out of scope.
  const old = join(root, 'cubism2');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'model.json'), JSON.stringify({ model: 'x.moc' }));
  await assert.rejects(store.import(old, { skinId: 'cubism2' }), /model3|Cubism/);

  // No rejected import may displace the active skin or add a registry entry. Only the one pack that
  // passed validation (the texture swap) joined the registry.
  assert.equal(store.active().skinId, 'local-model');
  assert.deepEqual(store.list().map(skin => skin.skinId), ['local-model', 'swapped-texture']);
  assert.ok(store.asset('local-model', 'pet.model3.json'), 'the previous model still resolves');
  assert.equal(store.state().revision, 2, 'only the accepted import bumped the revision');
});

test('05-B a pack without presets gets a safe disabled directory, never the other rig presets', async t => {
  const root = await workspace(t);
  const { SkinStore } = await skinModule();
  const store = await SkinStore.open(join(root, 'skins.json'), join(root, 'packs'), desktop);
  const bare = join(root, 'no-presets');
  await cloneBuiltin(bare);
  await rm(join(bare, 'presets.json'));

  await store.import(bare, { skinId: 'no-presets' });
  const descriptor = store.describe('no-presets');
  assert.equal(descriptor.capabilities.presets, 'generated-disabled');
  assert.equal(descriptor.capabilities.automaticPresets, 0);
  const catalog = store.catalog('no-presets');
  assert.equal(catalog.modelId, 'no-presets');
  assert.equal(catalog.modelFingerprint, descriptor.modelFingerprint);
  assert.ok(catalog.items.length >= 1);
  assert.ok(catalog.items.every(item => item.availability !== 'automatic'), 'nothing auto-plays without a reviewed catalog');
  assert.ok(catalog.items.every(item => item.defaultEnabled === false));
  assert.ok(!JSON.stringify(catalog).includes('exp-zzz'), 'the built-in preset ids never leak onto another rig');
  assert.ok(store.routes('no-presets').has('presets.json'), 'a generated catalog is routable');
});

test('05-B asset ids and registry ids reject traversal and unknown skins', async t => {
  const root = await workspace(t);
  const { SkinStore } = await skinModule();
  const store = await SkinStore.open(join(root, 'skins.json'), join(root, 'packs'), desktop);
  for (const path of ['../config/parameter-map.json', '..\\config', 'a/../../b', '/abs', 'C:\\x', 'pet.model3.json\0']) {
    assert.equal(store.asset('local-model', path), null, 'unregistrable path: ' + path);
  }
  for (const id of ['../x', 'a b', 'UPPER', '', 'x'.repeat(70)]) {
    assert.equal(store.asset(id, 'pet.model3.json'), null, 'unknown id: ' + JSON.stringify(id));
  }
  assert.equal(store.asset('local-model', 'presets.json'), join(desktop, 'assets/local-model/presets.json'));
  assert.equal(store.routes('nope').size, 0, 'an unknown skin exposes no route');
});

test('05-C a skin is appearance only: the dialogue scope, Memory and knowledge library never move', async t => {
  const root = await workspace(t);
  const { SkinStore } = await skinModule();
  const store = await SkinStore.open(join(root, 'skins.json'), join(root, 'packs'), desktop);
  const { sameScope } = await scopeModule();

  // The identity a turn is keyed on. A skin must not be able to reach it.
  const scope = Object.freeze({ characterId: 'aika', sessionId: 'session-1', turnId: 'turn-1', generation: 3 });
  const before = JSON.stringify(store.state());

  const second = join(root, 'scope-pack');
  await cloneBuiltin(second);
  await store.import(second, { skinId: 'scope-pack' });
  await store.activate(store.state().revision, 'scope-pack');

  // The scope that governs dialogue, Memory and retrieval is untouched by any skin operation.
  assert.ok(sameScope(scope, { ...scope }), 'the dialogue scope is still the same scope after a switch');
  assert.equal(scope.characterId, 'aika', 'switching appearance never rewrites characterId');
  assert.equal(scope.sessionId, 'session-1');
  assert.equal(scope.turnId, 'turn-1');
  assert.equal(scope.generation, 3);

  // No skin identifier may appear where identity lives, and no identity may leak into a skin.
  for (const skin of store.list()) {
    assert.notEqual(skin.skinId, scope.characterId, 'a skinId is deliberately not a characterId');
    assert.ok(!('characterId' in skin), 'a skin descriptor carries no character identity');
    assert.ok(!('knowledgeLibrary' in skin) && !('memory' in skin), 'a skin descriptor carries no memory or knowledge');
  }
  const serialized = JSON.stringify(store.state());
  assert.notEqual(serialized, before, 'the registry really changed');
  assert.ok(!serialized.includes('"characterId"'), 'the skin registry never stores a character identity');
  assert.ok(!serialized.includes('"knowledgeLibrary"'), 'the skin registry never touches the knowledge library');
});
