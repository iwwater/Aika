// K65-00 00-C: the renderer artifact smoke test. TESTING.md forbids proving "this code is not loaded"
// with a source-string assertion, so this loads the REAL built bundle as an ES module in a VM realm and
// records what it actually links and what it actually touches at evaluation time.
//
// Why a VM realm instead of Electron: the bundle is a browser artifact whose evaluation needs a DOM and
// the Live2D Cubism Core global, which Electron supplies. Linking it, however, needs no DOM at all — and
// the link step is exactly what answers the question at issue: does the bundle still have unresolved
// module specifiers, i.e. did esbuild leave the wake controller's dynamic import() as a real dynamic
// import, or did it inline it into the bundle? A source search cannot answer that; link() can.
//
// The dynamic import case matters because `desktop/wake-controller.mjs` has no top-level import and
// reaches `../media/wake/browser-capture.ts` only through `import()`. If esbuild had preserved that call,
// linking would surface a specifier that must be resolved at runtime by the browser — and a missing
// relative URL in the packaged artifact would then be a real 0.65 packaging defect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walks up to the package root so the suite works from both tests/next65/ and dist/tests/next65/. */
const packageRoot = (() => {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolvePath(directory, 'package.json'))) return directory + '/';
    directory = dirname(directory);
  }
  throw new Error('could not locate the desktop-pet package root from ' + import.meta.url);
})();
const bundlePath = packageRoot + 'desktop/build/renderer.js';
const workletPath = packageRoot + 'desktop/build/recorder-worklet.js';
const wakeWorkletPath = packageRoot + 'desktop/build/wake-recorder-worklet.js';

/** Runs the link probe in a child process so --experimental-vm-modules cannot leak into the parent run. */
function linkProbe() {
  const script = `
    import { readFile } from 'node:fs/promises';
    import vm from 'node:vm';
    const src = await readFile(process.env.K65_BUNDLE_PATH, 'utf8');
    const globals = { console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL,
      TextEncoder, TextDecoder, AbortController, AbortSignal, performance, crypto, structuredClone, fetch: async () => { throw new Error('network blocked by the probe'); },
      Promise, Math, JSON, Object, Array, Error, TypeError, RangeError, Map, Set, WeakMap, WeakSet, Symbol, Reflect, Proxy,
      Number, String, Boolean, Date, RegExp, Function, BigInt, ArrayBuffer, SharedArrayBuffer, Uint8Array, Uint8ClampedArray,
      Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, DataView,
      isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, atob, btoa };
    const ctx = vm.createContext(globals);
    const specifiers = [];
    let mod;
    try { mod = new vm.SourceTextModule(src, { context: ctx, identifier: 'renderer.js' }); }
    catch (error) { console.log(JSON.stringify({ linked: false, specifiers, error: 'construct: ' + error.message, evaluated: false })); process.exit(0); }
    try {
      await mod.link(async (specifier) => { specifiers.push(specifier); throw new Error('unresolvable specifier: ' + specifier); });
    } catch (error) { console.log(JSON.stringify({ linked: false, specifiers, error: 'link: ' + error.message, evaluated: false })); process.exit(0); }
    let evaluated = false, error = null;
    try { await mod.evaluate(); evaluated = true; }
    catch (evaluateError) { error = evaluateError.constructor.name + ': ' + evaluateError.message; }
    console.log(JSON.stringify({ linked: true, specifiers, error, evaluated }));
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '--eval', script],
    { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, K65_BUNDLE_PATH: bundlePath } });
  const line = (result.stdout ?? '').split(/\r?\n/).filter(value => value.trim().startsWith('{')).pop();
  assert.ok(line, `the link probe produced no result (status=${result.status}): ${result.stderr ?? ''}`);
  return JSON.parse(line);
}

test('the built renderer bundle links with zero unresolved module specifiers', () => {
  assert.ok(existsSync(bundlePath), `the renderer bundle must exist: ${bundlePath} — run npm run build:desktop`);
  const probe = linkProbe();
  assert.deepEqual(probe.specifiers, [],
    'every module the bundle needs must already be inside it; an unresolved specifier means esbuild left a real dynamic import() for the browser to fetch at runtime, which a packaged artifact cannot guarantee');
  assert.ok(probe.linked, `the bundle must link as an ES module: ${probe.error}`);
});

test('the renderer bundle evaluates far enough to reach its real DOM boundary, not a module-resolution error', () => {
  const probe = linkProbe();
  // Evaluation cannot fully succeed outside Electron: the bundle legitimately needs the DOM and the
  // Live2D Cubism Core global the shell injects. That is the point — the failure must be a missing
  // browser/Electron global, never a missing module. Any module-resolution error here is a packaging bug.
  if (probe.evaluated) return;
  assert.ok(probe.error, 'a failed evaluation must report its error');
  assert.ok(!/Cannot find module|ERR_MODULE_NOT_FOUND|Failed to resolve module|Unresolvable|is not a constructor for module/i.test(probe.error),
    `evaluation must not fail on module resolution: ${probe.error}`);
  assert.match(probe.error, /ReferenceError|TypeError/, `unexpected evaluation failure shape: ${probe.error}`);
});

test('esbuild inlined the wake controller dynamic import instead of leaving it dynamic', () => {
  // The concrete answer to the open question recorded in SOURCE_AUDIT: desktop/wake-controller.mjs
  // reaches ../media/wake/browser-capture.ts only via import(). The built artifact must therefore contain
  // the emitted wake init helper and no import() call site at all.
  assert.ok(existsSync(bundlePath), `the renderer bundle must exist: ${bundlePath}`);
  const bundle = readFileSync(bundlePath, 'utf8');
  assert.ok(bundle.includes('init_browser_capture'),
    'the wake capture module must be present in the bundle as an inlined init helper');
  assert.ok(!/\bimport\s*\(/.test(bundle),
    'the built bundle must contain no dynamic import() call — esbuild must have inlined it');
  assert.match(bundle, /Promise\.resolve\(\)\.then\(\(\) => \(init_browser_capture\(\), browser_capture_exports\)\)/,
    'the dynamic import must have been rewritten to a synchronous init, which is what makes the artifact self-contained');
});

test('the worklet side-cars the bundle references by URL are actually copied next to it', () => {
  // The bundle resolves its worklets by relative URL at runtime, so their presence is a real packaging
  // requirement rather than a build convenience.
  assert.ok(existsSync(workletPath), `missing worklet side-car: ${workletPath}`);
  assert.ok(existsSync(wakeWorkletPath), `missing wake worklet side-car: ${wakeWorkletPath}`);
  const bundle = readFileSync(bundlePath, 'utf8');
  assert.match(bundle, /new URL\("\.\/recorder-worklet\.js", import\.meta\.url\)|new URL\('\.\/recorder-worklet\.js', import\.meta\.url\)/);
  assert.match(bundle, /new URL\("\.\/wake-recorder-worklet\.js", import\.meta\.url\)|new URL\('\.\/wake-recorder-worklet\.js', import\.meta\.url\)/);
});
