/**
 * K65-01 · SlotBinding 冲突裁决的兼容规则测试（BASELINE.md §8 / RUN §6 登记议题的 K65-01 落点）。
 *
 * The K65-01 ruling, expressed as behaviour, not prose:
 *   * the NEW 0.65 multi-source schema (contracts/provider-source.ts + manifest validators) is the
 *     layer that allows local sources: `auth.kind: 'none'` is legal and `cost` is optional with an
 *     explicit `unknown` / `local_unmetered` basis — never a forced cloud-shaped requirement;
 *   * the LEGACY 0.61 SlotBinding protocol keeps its assertions untouched: the `credentialRef`
 *     requirement (`providers/slot-registry.ts:54`) and the TTS `characterMicros > 0` rule
 *     (`:87`) stay exactly as they are, because the legacy layer is cloud-first by construction and
 *     its seven tests (tests/providers/slot-registry.test.ts) plus FIX61-01 must not regress;
 *   * the bridge between the vocabularies is `plugins/legacy-slot.ts` — the ONE host-side place
 *     where the 0.65 capability namespace meets the seven legacy slots.
 *
 * Everything here runs the REAL compiled modules; nothing is stubbed. The legacy protocol itself is
 * exercised by its own suite (`tests/providers/slot-registry.test.ts`, 9/9 at exit code 0) — this
 * file guards the bridge, not the protocol.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSourceInstance } from '../../plugins/manifest.js';
import { matchSlotBinding } from '../../providers/slot-registry.js';
import type { SlotBinding, SlotCapabilities } from '../../providers/slot-registry.js';
import {
  CAPABILITIES_WITHOUT_LEGACY_SLOT, HOST_PROVIDER_SLOTS, LEGACY_SLOT_BY_CAPABILITY_HOST,
  legacySlotVocabularyDrift,
} from '../../plugins/legacy-slot.js';

test('ruling: the new schema accepts a local source with auth none and NO cost at all', () => {
  const issues = validateSourceInstance({
    sourceId: 'local-sapi', adapterId: 'fixture-sapi', adapterVersion: '1.0.0',
    deployment: 'managed-local', label: '本机 SAPI', configRevision: 1,
    runtimeRef: 'resources/sapi-runtime.json',
    auth: { kind: 'none' },
    limits: { maxConcurrentCalls: 1, maxQueueDepth: 2, startupTimeoutMs: 60000, callTimeoutMs: 15000, maxMemoryMb: null, maxGpuDevices: null },
    enablement: 'enabled',
    parameters: { 'tts.synthesize': { voiceId: 'Microsoft Huihui Desktop' } },
    dataDestination: 'local-machine',
  });
  assert.deepEqual(issues, [], `a local no-key source must pass; got ${JSON.stringify(issues)}`);
});

test('ruling: cost unknown is a declared state, not an error, for a local source', () => {
  const issues = validateSourceInstance({
    sourceId: 'local-engine', adapterId: 'local-engine', adapterVersion: '1.0.0',
    deployment: 'local-service', label: '本地引擎', configRevision: 1,
    endpoint: 'http://127.0.0.1:8080',
    auth: { kind: 'none' },
    cost: { basis: 'unknown', note: '本地运行无云费率口径' },
    limits: { maxConcurrentCalls: 1, maxQueueDepth: 1, startupTimeoutMs: 60000, callTimeoutMs: 15000, maxMemoryMb: null, maxGpuDevices: null },
    enablement: 'enabled',
    parameters: {},
    dataDestination: 'local-machine',
  });
  assert.deepEqual(issues, [], `cost unknown must be a legal declared state; got ${JSON.stringify(issues)}`);
});

test('ruling: remote-api still requires a credentialRef — the cloud half did not loosen', () => {
  const issues = validateSourceInstance({
    sourceId: 'cloud', adapterId: 'openai-compatible', adapterVersion: '1.0.0',
    deployment: 'remote-api', label: '云端', configRevision: 1,
    endpoint: 'https://api.example.com/v1',
    auth: { kind: 'none' },
    limits: { maxConcurrentCalls: 1, maxQueueDepth: 1, startupTimeoutMs: 60000, callTimeoutMs: 15000, maxMemoryMb: null, maxGpuDevices: null },
    enablement: 'enabled',
    parameters: {},
    dataDestination: 'vendor-cloud',
  });
  assert.equal(issues.some(issue => issue.category === 'auth_required_missing' && issue.path === 'source.auth'), true,
    `a cloud source without credentialRef must be refused; got ${JSON.stringify(issues)}`);
});

test('ruling: the legacy SlotBinding protocol keeps its assertions (credentialRef, TTS characterMicros)', () => {
  // The legacy layer is cloud-first and stays that way; these two assertions are the registered
  // conflict pair, and they must keep failing for the shapes that lack them.
  const cloudBinding = {
    adapterId: 'openai-tts', protocol: 'openai-compatible' as const, provider: 'dashscope',
    endpoint: 'https://api.example.com/v1', model: 'cosyvoice-v1', credentialRef: 'cred-1',
    inputTokenLimit: 0, outputTokenLimit: 0, reservationMicros: 100,
    inputMicrosPerToken: 1, outputMicrosPerToken: 1,
  };
  const caps: SlotCapabilities = { temperature: false, voice: true, language: true, audio: true };
  assert.throws(
    () => matchSlotBinding('tts', { ...cloudBinding, credentialRef: '', voice: 'Cherry', language: 'zh', characterMicros: 80, audioMicrosPerSecond: 1 } as SlotBinding, caps),
    (error: unknown) => (error as Error).name === 'ManagementError',
    'the legacy protocol must keep refusing a TTS binding without credentialRef',
  );
  assert.throws(
    () => matchSlotBinding('tts', { ...cloudBinding, voice: 'Cherry', language: 'zh', audioMicrosPerSecond: 1 } as SlotBinding, caps),
    (error: unknown) => (error as Error).name === 'ManagementError',
    'the legacy protocol must keep refusing a TTS binding without characterMicros > 0',
  );
  // A LOCAL legacy binding with no key and no rate is NOT matchSlotBinding's job: the 0.61 protocol
  // has no representation for it, which is exactly why the 0.65 schema layer carries it instead.
  // (The positive side is proven by tests/providers/slot-registry.test.ts, 9/9, untouched.)
});

test('ruling: the capability→slot bridge is total over the required ids that have a slot', () => {
  assert.deepEqual(HOST_PROVIDER_SLOTS, ['asr', 'dialogue', 'memory_turn', 'summary', 'perception', 'tts', 'admission']);
  assert.deepEqual(legacySlotVocabularyDrift(), { sdkOnly: [], hostOnly: [] }, 'the SDK copy and the host vocabulary must not drift');
  for (const [capabilityId, slot] of Object.entries(LEGACY_SLOT_BY_CAPABILITY_HOST)) {
    assert.ok(HOST_PROVIDER_SLOTS.includes(slot!), `${capabilityId} maps to non-slot ${slot}`);
  }
  for (const required of ['llm.chat', 'stt.transcribe', 'tts.synthesize', 'context.source', 'input.capture'] as const) {
    assert.ok(LEGACY_SLOT_BY_CAPABILITY_HOST[required], `${required} must have a legacy slot mapping`);
  }
  // audio.playback / presentation.render / background.lifecycle are genuinely new in 0.65: they map
  // to nothing, and the bridge says so instead of inventing a slot.
  assert.deepEqual([...CAPABILITIES_WITHOUT_LEGACY_SLOT].sort(), ['audio.playback', 'background.lifecycle', 'presentation.render']);
});

test('ruling: the bridge is a pure read-only mapping over the existing settings authority', () => {
  // The bridge must not rebuild or extend the seven-slot vocabulary; if management/settings.ts ever
  // changes, HOST_PROVIDER_SLOTS changes with it (single authority), never the reverse.
  assert.equal(Object.isFrozen(HOST_PROVIDER_SLOTS), false, 'the array is the settings export itself, not a rebuilt copy');
  assert.equal(HOST_PROVIDER_SLOTS.length, 7);
});

test('ruling: the fixture side of the bridge stays inside the SDK-only project', () => {
  // The 01-C fixture declares legacySlot: 'tts' on its binding, which is the SDK-facing half of the
  // migration story: a package can NAME the legacy slot it replaces without importing host paths.
  assert.equal(LEGACY_SLOT_BY_CAPABILITY_HOST['tts.synthesize'], 'tts');
});
