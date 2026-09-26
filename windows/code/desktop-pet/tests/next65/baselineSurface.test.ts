// K65-00 00-C/00-D: the frozen 0.61 baseline surface the 0.65 migration must not silently move.
//
// The tests here characterize the real production symbols the dependency matrix in
// docs/next/0.65/reports/K65-00.md pins: the composition root, the single credential read point, the
// turn/cancel authority, the provider slot vocabulary and the two IPC contract versions. They are
// characterization (0.61 behaviour re-pinned), not new behaviour, so they are written as
// "reuse the feature test" per AGENTS.md §6 rather than as a fresh design.
//
// Deliberately NOT asserted here: that a plugin loader exists. It does not exist yet, and asserting a
// placeholder would be exactly the fake evidence TESTING.md forbids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurnController, sameScope } from '../../core/turn-controller.js';
import { ProviderRegistry, PROTOCOL_SLOTS, isAllowedEndpoint, matchSlotBinding, type SlotBinding } from '../../providers/slot-registry.js';
import { PROVIDER_SLOTS } from '../../management/settings.js';
import { DESKTOP_BRIDGE_VERSION } from '../../contracts/desktop-bridge.js';
import { COMPANION_ID } from '../../contracts/character.js';

/**
 * The package root, resolved from this file's own location. The suite runs from two places — the compiled
 * copy under dist/tests/next65 and the .mjs sources under tests/next65 — so a single hardcoded relative
 * depth would silently read dist/ instead of the real source tree. Walk up until package.json is found.
 */
const packageRoot = (() => {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolvePath(directory, 'package.json'))) return directory + '/';
    directory = dirname(directory);
  }
  throw new Error('could not locate the desktop-pet package root from ' + import.meta.url);
})();
const read = (relative: string): string => readFileSync(packageRoot + relative, 'utf8');

test('the composition root is a real module exposing a launcher and the strict memory provider', async () => {
  const module = await import('../../app/trial-backend.js');
  assert.equal(typeof module.startTrialBackend, 'function', 'app/trial-backend.ts is the production composition root');
  // Migration risk recorded in the dependency matrix: StrictTrialMemoryProvider is DEFINED INSIDE the
  // composition root, so moving it to the memory capability package must update its test consumers.
  assert.equal(typeof module.StrictTrialMemoryProvider, 'function');
  assert.equal(typeof module.keyReader, 'function', 'the single credential read point must stay reachable');
  assert.equal(typeof module.createTrialTtsProvider, 'function');
});

test('keyReader enforces project-external, active-trial credentials with the sk- shape', () => {
  const source = read('app/trial-backend.ts');
  // The whole credential policy lives in one synchronous reader; a local source without a key can never
  // satisfy it, which is why the multi-source matrix records it as part of the credential chain.
  assert.match(source, /export function keyReader\(/);
  assert.match(source, /Trial is not active/);
  assert.match(source, /Restricted external trial credential file required/);
  assert.match(source, /\^sk-\[A-Za-z0-9_-\]\+\$/);
});

test('the turn controller stays the single turn/cancel authority with its 0.61 semantics', () => {
  const controller = new TurnController();
  const first = controller.begin('text', '第一条');
  assert.ok(controller.accepts(first.input.scope));
  const second = controller.begin('text', '第二条');
  assert.ok(first.signal.aborted, 'a new submission still aborts the previous turn');
  assert.equal(second.input.scope.generation, first.input.scope.generation + 1);
  assert.ok(!controller.accepts(first.input.scope));
  controller.cancel();
  assert.ok(second.signal.aborted);
  assert.ok(!sameScope(second.input.scope, first.input.scope));
  assert.equal(controller.identity().characterId, COMPANION_ID);
});

test('the seven provider slots keep exactly one declaration of the slot vocabulary per module', () => {
  assert.deepEqual([...PROVIDER_SLOTS], ['asr', 'dialogue', 'memory_turn', 'summary', 'perception', 'tts', 'admission']);
  const aikaProfile = read('management/aika-profile.ts');
  // Divergence hazard recorded in the report: a second literal array mirrors this list, so a migration
  // that edits one and not the other diverges silently.
  assert.match(aikaProfile, /const PROVIDER_SLOTS: readonly ProviderSlot\[\] = \['asr', 'dialogue', 'memory_turn', 'summary', 'perception', 'tts', 'admission'\]/);
});

test('openai-compatible still serves all seven slots and gemini still serves five', () => {
  assert.equal(PROTOCOL_SLOTS['openai-compatible'].length, 7);
  assert.deepEqual([...PROTOCOL_SLOTS['openai-compatible']].sort(), [...PROVIDER_SLOTS].sort());
  assert.deepEqual([...PROTOCOL_SLOTS.gemini].sort(), ['admission', 'dialogue', 'memory_turn', 'perception', 'summary']);
  assert.ok(ProviderRegistry.canServe('tts', 'openai-compatible'));
  assert.ok(!ProviderRegistry.canServe('tts', 'gemini'));
});

test('isAllowedEndpoint admits loopback http while the transport still demands https', () => {
  // The two layers genuinely disagree today; the report records the transport as the binding wall.
  for (const endpoint of ['http://127.0.0.1:1234/v1', 'http://localhost:8080/x', 'http://[::1]:9000/y', 'https://api.example.com/v1']) {
    assert.ok(isAllowedEndpoint(endpoint), `${endpoint} is admitted by the slot registry`);
  }
  assert.ok(!isAllowedEndpoint('http://192.168.1.5:1234/v1'), 'a non-loopback http origin is still refused');
  const transport = read('providers/transport.ts');
  assert.match(transport, /if \(endpoint\.protocol !== 'https:' \|\| endpoint\.username \|\| endpoint\.password \|\| endpoint\.search \|\| endpoint\.hash \|\| !config\.model\) throw new Error\('Explicit HTTPS provider endpoint and model required'\)/);
  assert.match(transport, /if \(!apiKey\) throw new Error\('Provider API key is not configured'\)/);
  // The downloadAudio leg has its own independent https-only guard.
  assert.match(transport, /if \(parsed\.protocol !== 'https:' \|\| parsed\.username \|\| parsed\.password\) throw new Error\('Invalid provider audio URL'\)/);
});

test('a loopback binding passes slot validation but is refused by the real production transport', async () => {
  const binding: SlotBinding = {
    adapterId: 'openai-compatible-text', protocol: 'openai-compatible', provider: 'openai',
    endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'local-model',
    credentialRef: 'local-none', inputTokenLimit: 4096, outputTokenLimit: 4096,
    reservationMicros: 0, inputMicrosPerToken: 0, outputMicrosPerToken: 0,
  };
  const capabilities = { temperature: true, voice: false, language: false, audio: false };
  assert.doesNotThrow(() => matchSlotBinding('dialogue', binding, capabilities), 'config validation admits the local endpoint');
  assert.equal(binding.credentialRef, 'local-none', 'even a placeholder credential ref passes this layer alone');

  const { ProviderTransport } = await import('../../providers/transport.js');
  const transport = new ProviderTransport();
  await assert.rejects(
    () => transport.request(
      { endpoint: binding.endpoint, model: binding.model, apiKey: () => 'unused', authorizer: { async authorize() { return { async settle() {} }; } } },
      { characterId: COMPANION_ID, sessionId: 's', turnId: 't', generation: 1 },
      'dialogue', { messages: [] }, new AbortController().signal),
    /Explicit HTTPS provider endpoint and model required/,
    'the production transport overrules the registry allowance — every local OpenAI-compatible path fails here',
  );
});

test('the two IPC contract versions are distinct and frozen', async () => {
  assert.equal(DESKTOP_BRIDGE_VERSION, '0.7.0');
  const { CONTRACT_VERSION } = await import('../../contracts/index.js');
  assert.equal(CONTRACT_VERSION, '0.9.0');
  const preload = read('desktop/electron/preload.cjs');
  assert.match(preload, /const channels = new Set\(\['desktop', 'shell', 'diagnostic'\]\)/);
  const main = read('desktop/electron/main.mjs');
  assert.match(main, /contextIsolation: true, nodeIntegration: false, sandbox: true/);
  assert.match(main, /pet:\/\/app\/index\.html/);
  assert.match(main, /RIGHT_CLICK_MESSAGES/);
  assert.match(main, /hookWindowMessage/);
});

test('the desktop surface exposes a real size control and a right-click restore bridge', () => {
  const index = read('desktop/index.html');
  const controls = read('desktop/display-controls.mjs');
  const preload = read('desktop/electron/preload.cjs');
  const helper = read('desktop/electron/right-click-hook.ps1');
  assert.match(index, /id="model-size" type="range"/);
  assert.match(index, /id="model-size-value"/);
  assert.match(controls, /phase: 'commit', width/);
  assert.match(controls, /sizeSlider\.oninput/);
  assert.match(preload, /rightClickRestore/);
  assert.match(helper, /WH_MOUSE_LL/);
  assert.match(helper, /WM_RBUTTONDOWN/);
});

test('the built renderer is a self-contained browser artifact with no node or native reference', () => {
  const bundle = read('desktop/build/renderer.js');
  assert.equal(bundle.match(/node:/g), null, 'the renderer bundle must contain no node: specifier');
  assert.equal(bundle.match(/require\(/g), null, 'the renderer bundle must contain no require() call');
  assert.ok(bundle.length > 100000, `unexpectedly small renderer bundle: ${bundle.length} bytes`);
});
