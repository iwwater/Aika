// FIX61-05 RED->GREEN: the renderer side of the model-pack lifecycle.
// 05-B instance-level loading: the candidate rig is verified and built BEFORE the active binding is
// switched, and a failing candidate keeps the previous skin rendered. A late finish of a superseded
// switch can never overwrite the final choice.
// 05-C release accounting: every switch releases the old model/renderer and the counters balance.
// 05-D two real, licensed Cubism rigs load and switch over the same instance.
//
// The rigs used here are real, licensed Cubism models, loaded through the production Cubism
// Framework + Core in a headless canvas-free mode (the WebGL renderer step is skipped), which is
// exactly the "silent rig" path the production renderer already shares for tests. The renderer is
// browser code that imports Framework TypeScript with enums and extensionless specifiers, so it is
// bundled once with the same esbuild the desktop build uses before Node can import it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '../../..', 'desktop');
const projectRoot = resolve(here, '../../..');
const builtinPack = join(desktop, 'assets/local-model');
/** The second real licensed rig: the Cubism 4 sample model Hiyori, kept outside this repository. */
const secondModelPack = process.env.AIKA_FIX61_05_SECOND_MODEL ?? 'F:/AIVoice/pet-shell/probe/live2d/assets/Hiyori';

/**
 * Browser surface the production renderer needs. The Core is the Emscripten bundle the app ships,
 * and `fetch` serves the pack through the same `pet://` asset base paths the desktop app uses.
 */
function installBrowserSurface() {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.window ??= scope;
  scope.self ??= scope;
  scope.location ??= { href: 'pet://app/desktop/' };
  scope.performance ??= { now: () => Date.now() };
  scope.document ??= {
    currentScript: { src: 'live2dcubismcore.js' },
    createElement: () => ({ getContext: () => null, style: {}, setAttribute() {} }),
    getElementById: () => null, addEventListener() {}, removeEventListener() {},
    documentElement: { style: {} }, head: { appendChild() {} },
  };
  // Node ships its own global fetch, which refuses the `pet://` scheme the desktop app serves, so the
  // shim is installed unconditionally rather than only when fetch is missing.
  scope.fetch = async (url: unknown) => {
    const path = new URL(String(url)).pathname.replace(/^\/+/, '');
    try {
      const body = await readFile(join(projectRoot, path));
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer };
    } catch { return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }; }
  };
}

async function loadCubismCore() {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope.Live2DCubismCore) return scope.Live2DCubismCore;
  const source = await readFile(join(desktop, 'vendor/cubism/Core/live2dcubismcore.js'), 'utf8');
  const evaluate = new Function('window', 'globalThis', 'document', 'navigator', 'self', 'exports', 'module', 'define',
    source + '\n;return typeof Live2DCubismCore !== "undefined" ? Live2DCubismCore : null;');
  const instance = evaluate(scope.window, globalThis, scope.document, scope.navigator, scope.self, undefined, undefined, undefined);
  if (!instance?.Version) throw new Error('Cubism Core 未能初始化。');
  scope.Live2DCubismCore = instance;
  for (let attempt = 0; ; attempt++) {
    try { instance.Version.csmGetVersion(); break; }
    catch (error) { if (attempt >= 400) throw error; await new Promise(done => setTimeout(done, 10)); }
  }
  return instance;
}

/** Bundle the renderer once, exactly as `desktop/build-web.mjs` does, so Node can import it. */
async function bundledRendererPath(): Promise<string> {
  const { build } = await import('esbuild');
  const out = join(await mkdtemp(join(tmpdir(), 'fix61-05-bundle-')), 'renderer.js');
  await mkdir(dirname(out), { recursive: true });
  await build({ entryPoints: [join(desktop, 'cubism-renderer.mjs')], bundle: true, format: 'esm',
    platform: 'browser', target: ['chrome130'], outfile: out, legalComments: 'eof' });
  return out;
}

const surface = (async () => {
  installBrowserSurface();
  await loadCubismCore();
  const file = await bundledRendererPath();
  return import('file://' + file) as Promise<{ JellyfishRenderer: new (canvas: unknown, report?: (e: unknown) => void, options?: object) => any; SkinBinding: new (manifest: unknown) => any }>;
})();

const rendererModule = () => surface;

const sha256 = async (buffer: Buffer | Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)), byte => byte.toString(16).padStart(2, '0')).join('');

async function smokeTest(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'fix61-05-renderer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Copy the shipped real rig into a second pack, optionally corrupting its moc bytes. */
async function clonePack(root: string, name: string, corruptMoc = false) {
  const target = join(root, name);
  await cp(builtinPack, target, { recursive: true });
  if (corruptMoc) {
    const moc = join(target, 'natori_pro_t06.moc3');
    const bytes = await readFile(moc);
    bytes[64] = bytes[64]! ^ 0xff;
    await writeFile(moc, bytes);
  }
  return target;
}

function readAssetFor(base: string) {
  return async (path: string) => readFile(join(base, path));
}

/** Rebind one manifest onto new bytes: the catalog fingerprint must always agree with those bytes. */
async function rebind(source: string, base: object, overrides: Record<string, unknown>) {
  const raw = new TextDecoder().decode(await readFile(join(source, 'pet.model3.json')));
  const refs = JSON.parse(raw).FileReferences;
  const paths = [...new Set(['pet.model3.json', refs.Moc, refs.Physics, ...refs.Expressions.map((e: { File: string }) => e.File), ...(Object.values(refs.Motions) as { File: string }[][]).flat().map(m => m.File)].filter(Boolean))].sort();
  let digestInput = '';
  for (const path of paths) digestInput += path + '\0' + await sha256(await readFile(join(source, path))) + '\n';
  const fingerprint = await sha256(Buffer.from(new TextEncoder().encode(digestInput)));
  const { JellyfishRenderer: _unused, SkinBinding } = await rendererModule();
  const manifest = JSON.parse(JSON.stringify(base)) as Record<string, any>;
  Object.assign(manifest, overrides);
  manifest.modelFingerprint = fingerprint;
  manifest.assetFingerprint = fingerprint;
  manifest.revision = (manifest.revision ?? 0) + 1;
  manifest.catalog.modelId = manifest.skinId;
  manifest.catalog.modelFingerprint = fingerprint;
  return new SkinBinding(manifest);
}

test('05-B instance-level loading verifies the candidate before switching, and a failing candidate keeps the old skin', async t => {
  const { JellyfishRenderer } = await rendererModule();
  const root = await smokeTest(t);
  const renderer = new JellyfishRenderer(null, () => {});
  t.after(() => renderer.dispose());

  // Bind the built-in pack from the real shipped catalog and silently load the real rig.
  const manifest = await renderer.builtInManifest();
  renderer.bindSkin(manifest);
  await renderer.loadRig(readAssetFor(builtinPack));
  const activeSkinId = renderer.skin.skinId;
  const activeRevision = renderer.activeRevision;
  assert.equal(activeSkinId, 'local-model');
  assert.ok(renderer._model, 'the real rig built a model');
  const oldModel = renderer._model;

  // A candidate whose bytes cannot be built by the Core is refused BEFORE the active binding moves,
  // so the previously loaded skin survives untouched and nothing was released.
  const candidate = await clonePack(root, 'corrupt-candidate', true);
  const before = { ...renderer.releaseCounts };
  await assert.rejects(renderer.loadRig(readAssetFor(candidate), await rebind(candidate, manifest, { skinId: 'corrupt-candidate', label: 'corrupt-candidate', modelId: 'corrupt-candidate' })),
    (error: Error) => /未能解析模型|moc|模型/.test(error.message));
  assert.deepEqual(renderer.releaseCounts, before, 'a refused candidate released nothing');
  assert.equal(renderer.skin.skinId, activeSkinId, 'the active skin was never switched to the failed candidate');
  assert.equal(renderer.activeRevision, activeRevision);
  assert.equal(renderer._model, oldModel, 'the previous model is still alive');
});

test('05-B a successful candidate commits atomically; a late finish of a superseded switch cannot overwrite the final choice', async t => {
  const { JellyfishRenderer } = await rendererModule();
  const root = await smokeTest(t);
  const renderer = new JellyfishRenderer(null, () => {});
  t.after(() => renderer.dispose());

  const original = await renderer.builtInManifest();
  renderer.bindSkin(original);
  await renderer.loadRig(readAssetFor(builtinPack));

  // Second real pack: byte-identical copy under its own id and own fingerprint.
  const second = await clonePack(root, 'second-real-pack');
  const secondBinding = await rebind(second, original, { skinId: 'second-real-pack', label: 'second-real-pack', modelId: 'second-real-pack' });
  await renderer.loadRig(readAssetFor(second), secondBinding);
  assert.equal(renderer.skin.skinId, 'second-real-pack', 'a verified candidate becomes the active skin');
  assert.ok(renderer._model, 'the new rig built a live model');

  // Late-arriving loser: start a switch back to local-model and hold it mid-load, then start a newer
  // switch and let THAT one finish first. When the loser is finally released it is already superseded,
  // so it must discard its own work instead of resurrecting the binding it was loading.
  let releaseLoser: (() => void) | null = null;
  const held = new Promise<void>(done => { releaseLoser = done; });
  const readSlowly = async (path: string) => { await held; return readFile(join(builtinPack, path)); };
  const loser = renderer.loadRig(readSlowly, await rebind(builtinPack, original, { skinId: 'late-pack', label: 'late-pack', modelId: 'late-pack' }));
  const winner = await renderer.loadRig(readAssetFor(second), await rebind(second, original, { skinId: 'final-pack', label: 'final-pack', modelId: 'final-pack' }));
  assert.equal(winner, undefined);
  assert.equal(renderer.skin.skinId, 'final-pack', 'the newer switch committed');
  const beforeLoserSettles = renderer.skin.skinId;
  releaseLoser!();
  await assert.rejects(loser, /已被更新的选择取代/, 'the superseded switch reports itself instead of writing back');
  assert.equal(renderer.skin.skinId, beforeLoserSettles, 'the final choice stands after the loser settles');
  assert.equal(renderer.skin.skinId, 'final-pack');
  assert.ok(renderer._model, 'the winning model is still live');
});

test('05-C switching releases the old model and renderer exactly once and keeps the counters balanced', async t => {
  const { JellyfishRenderer } = await rendererModule();
  const root = await smokeTest(t);
  const renderer = new JellyfishRenderer(null, () => {});
  t.after(() => renderer.dispose());

  const original = await renderer.builtInManifest();
  renderer.bindSkin(original);
  await renderer.loadRig(readAssetFor(builtinPack));

  const second = await clonePack(root, 'release-pack');
  const oldModel = renderer._model;
  await renderer.loadRig(readAssetFor(second), await rebind(second, original, { skinId: 'release-pack', label: 'release-pack', modelId: 'release-pack' }));
  const counts = renderer.releaseCounts;
  assert.equal(counts.models, 1, 'exactly one old model released per switch');
  assert.notEqual(renderer._model, oldModel, 'a fresh model instance owns the new skin');
  assert.ok(renderer._model.getParameterCount() > 0, 'the new model is usable');

  // Three more switches; each must release exactly once more, never accumulating.
  for (const name of ['release-pack-2', 'release-pack-3', 'release-pack-4']) {
    const pack = await clonePack(root, name);
    await renderer.loadRig(readAssetFor(pack), await rebind(pack, original, { skinId: name, label: name, modelId: name }));
  }
  assert.equal(renderer.releaseCounts.models, 4, 'four switches released four models, no leaks and no double-free');
  assert.equal(renderer.skin.skinId, 'release-pack-4');
  // The instance stays animatable after every release, which is what "released resources, not the
  // renderer object" means.
  assert.ok(renderer._motionManager && renderer._expressionManager, 'the animation managers survive a switch');
  assert.doesNotThrow(() => renderer.reset(), 'reset still works after repeated switches');
});

test('05-D two real licensed Cubism rigs load and switch over one instance', async t => {
  const { JellyfishRenderer } = await rendererModule();
  let available = true;
  try { await readFile(join(secondModelPack, 'Hiyori.model3.json')); } catch { available = false; }
  if (!available) return t.skip('the second licensed rig is not present: set AIKA_FIX61_05_SECOND_MODEL to its directory');

  const renderer = new JellyfishRenderer(null, () => {});
  t.after(() => renderer.dispose());

  const first = await renderer.builtInManifest();
  renderer.bindSkin(first);
  await renderer.loadRig(readAssetFor(builtinPack));
  const firstParameters = renderer._model.getParameterCount();
  const firstDrawables = renderer._model.getDrawableCount();
  assert.ok(firstParameters > 0 && firstDrawables > 0, 'the built-in rig really built');
  assert.equal(renderer.skin.skinId, 'local-model');

  // Hiyori is a genuinely different rig: another moc3, another entry file, its own parameter table.
  const { SkinBinding } = await rendererModule();
  // A binding validates identity and catalog in its constructor, so the manifest must be complete
  // before one is built: there is deliberately no "construct then mutate into validity" path.
  const raw = new TextDecoder().decode(await readFile(join(secondModelPack, 'Hiyori.model3.json')));
  const refs = JSON.parse(raw).FileReferences;
  const paths = [...new Set(['Hiyori.model3.json', refs.Moc, refs.Physics, ...(Object.values(refs.Motions) as { File: string }[][]).flat().map(m => m.File)].filter(Boolean))].sort();
  let digestInput = '';
  for (const path of paths) digestInput += path + '\0' + await sha256(await readFile(join(secondModelPack, path))) + '\n';
  const hiyoriFingerprint = await sha256(Buffer.from(new TextEncoder().encode(digestInput)));
  const secondManifest = JSON.parse(JSON.stringify(first)) as Record<string, any>;
  Object.assign(secondManifest, { skinId: 'hiyori', label: 'Hiyori', modelId: 'hiyori', modelEntry: 'Hiyori.model3.json',
    modelFingerprint: hiyoriFingerprint, assetFingerprint: hiyoriFingerprint, revision: (first.revision ?? 0) + 1 });
  secondManifest.catalog.modelId = 'hiyori';
  secondManifest.catalog.modelFingerprint = hiyoriFingerprint;
  const secondBinding = new SkinBinding(secondManifest);

  await renderer.loadRig(readAssetFor(secondModelPack), secondBinding);
  assert.equal(renderer.skin.skinId, 'hiyori', 'the second real rig became the active skin');
  const secondParameters = renderer._model.getParameterCount();
  assert.ok(secondParameters > 0, 'the second rig really built through the same Core');
  assert.notEqual(secondParameters, firstParameters, 'the two rigs have genuinely different parameter tables');

  // Switching back must load the first rig again, not keep the second one on screen.
  await renderer.loadRig(readAssetFor(builtinPack), await rebind(builtinPack, first, { skinId: 'local-model', label: '内建模型', modelId: 'local-model' }));
  assert.equal(renderer.skin.skinId, 'local-model', 'switching back restores the first rig');
  assert.equal(renderer._model.getParameterCount(), firstParameters, 'the first rig rebuilt with its own parameters');
  assert.equal(renderer.releaseCounts.models, 2, 'both real switches released their predecessor exactly once');
});
