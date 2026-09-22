/** K65-02A: provider source resolution, ownership and instance leases. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentOwnership, ProviderRuntime, ProviderRuntimeError } from '../../plugins/provider-runtime.js';
import { migrateLegacySlot } from '../../plugins/legacy-slot.js';
import type { AdapterDescriptor, Binding, ModelProfile, SourceInstance } from '../../contracts/provider-source.js';
import type { SlotBinding } from '../../providers/slot-registry.js';

const adapter: AdapterDescriptor = {
  adapterId: 'fixture.tts.adapter', adapterVersion: '1.0.0', packageId: 'com.fixture.providers',
  pluginId: 'fixture.providers', label: 'Fixture TTS', protocol: 'fixture',
  capabilitySchemas: [{
    capabilityId: 'tts.synthesize',
    parameters: [{ name: 'speed', type: 'number', required: false, note: 'Fixture playback speed' }],
    outputs: [{ name: 'audio', type: 'bytes', streaming: true, note: 'Fixture audio bytes' }],
    modelIdentifier: 'model', voiceIdentifier: 'voice', streaming: ['batch', 'streaming'], cancellable: true,
  }],
  proprietaryParameters: [], deployments: ['remote-api', 'local-service', 'managed-local'], contractVersion: '1.0.0',
};

const limits = { maxConcurrentCalls: 2, maxQueueDepth: 4, startupTimeoutMs: 1_000, callTimeoutMs: 1_000, maxMemoryMb: null, maxGpuDevices: null };

function source(sourceId: string, deployment: SourceInstance['deployment'], configRevision = 1, extra: Partial<SourceInstance> = {}): SourceInstance {
  return {
    sourceId, adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion, deployment,
    label: sourceId, configRevision,
    ...(deployment === 'managed-local' ? { runtimeRef: `runtime://${sourceId}` } : { endpoint: `http://127.0.0.1:${9_000 + configRevision}` }),
    auth: { kind: 'none' }, limits, enablement: 'enabled', parameters: {}, dataDestination: 'local-machine', ...extra,
  };
}

function profile(modelProfileId: string, sourceId: string, nativeModelId: string): ModelProfile {
  return { modelProfileId, revision: 1, sourceId, capabilityId: 'tts.synthesize', label: modelProfileId,
    nativeModelId, nativeVoiceId: 'fixture-voice', parameters: { speed: 1 }, capabilityOverrides: {}, resources: [] };
}

function binding(bindingId: string, modelProfileId: string): Binding {
  return { bindingId, revision: 1, capabilityId: 'tts.synthesize', modelProfileId, legacySlot: 'tts', scope: null, failurePolicy: 'fail_turn' };
}

function install(runtime: ProviderRuntime, sourceValue: SourceInstance, model = 'model-a', id = 'voice'): void {
  runtime.saveSource(sourceValue);
  runtime.saveModelProfile(profile(`${id}.profile`, sourceValue.sourceId, model));
  runtime.saveBinding(binding(id, `${id}.profile`));
}

function localSecrets(configured: readonly string[] = []) {
  return {
    has: (ref: string) => configured.includes(ref),
    resolve: (ref: string, provider: string) => configured.includes(ref) ? { ref, provider } : null,
    list: () => configured.map(ref => ({ ref, provider: 'fixture', status: 'configured' as const })),
  };
}

test('02A-A: same capability supports multiple adapters, sources and models without cross-instance reuse', () => {
  const runtime = new ProviderRuntime();
  const second = { ...adapter, adapterId: 'fixture.tts.second' };
  runtime.registerAdapter(adapter);
  runtime.registerAdapter(second);
  install(runtime, source('local-a', 'local-service', 1), 'model-a', 'voice-a');
  install(runtime, { ...source('local-b', 'local-service', 2), adapterId: second.adapterId }, 'model-b', 'voice-b');
  const first = runtime.resolveBinding('voice-a');
  const other = runtime.resolveBinding('voice-b');
  assert.equal(first.sourceId, 'local-a');
  assert.equal(other.sourceId, 'local-b');
  assert.notEqual(first.instanceKey, other.instanceKey);
  assert.equal(first.nativeModelId, 'model-a');
  assert.equal(other.nativeModelId, 'model-b');
  assert.equal(first.credentialRef, null);
});

test('02A-B: local no-key source resolves while cloud source requires its own credential', () => {
  const runtime = new ProviderRuntime({ secrets: localSecrets([]) });
  runtime.registerAdapter(adapter);
  install(runtime, source('local', 'local-service'), 'local-model', 'local-voice');
  const cloud = source('cloud', 'remote-api', 2, {
    endpoint: 'https://api.example.test/v1',
    auth: { kind: 'credentialRef', ref: 'cloud-key', provider: 'fixture-cloud' },
    dataDestination: 'vendor-cloud', cost: { basis: 'unknown', note: 'provider billing is not known here' },
  });
  install(runtime, cloud, 'cloud-model', 'cloud-voice');
  assert.equal(runtime.resolveBinding('local-voice').deployment, 'local-service');
  assert.throws(() => runtime.resolveBinding('cloud-voice'), (error: unknown) => error instanceof ProviderRuntimeError && error.category === 'auth_required_missing');
  assert.equal(runtime.resolveBinding('local-voice').sourceId, 'local');
});

test('02A-C: managed-local starts once for concurrent leases and stops at the final release', async () => {
  let starts = 0;
  let stops = 0;
  const runtime = new ProviderRuntime({ lifecycle: {
    'managed': {
      start: async () => { starts += 1; await new Promise(resolve => setTimeout(resolve, 5)); },
      stop: async () => { stops += 1; },
    },
  } });
  runtime.registerAdapter(adapter);
  install(runtime, source('managed', 'managed-local'), 'local-model', 'managed-voice');
  const [first, second] = await Promise.all([runtime.acquire('managed-voice'), runtime.acquire('managed-voice')]);
  assert.equal(starts, 1);
  assert.equal(runtime.getHealth(first.binding.instanceKey)?.state, 'ready');
  await first.release();
  assert.equal(stops, 0);
  await second.release();
  assert.equal(stops, 1);
  assert.equal(runtime.getHealth(first.binding.instanceKey)?.state, 'stopped');
});

test('02A-D: user-owned local-service is never stopped by host lease release', async () => {
  let starts = 0;
  let stops = 0;
  const runtime = new ProviderRuntime({ lifecycle: {
    'external': { start: async () => { starts += 1; }, stop: async () => { stops += 1; } },
  } });
  runtime.registerAdapter(adapter);
  install(runtime, source('external', 'local-service'), 'service-model', 'external-voice');
  const lease = await runtime.acquire('external-voice');
  await lease.release();
  assert.equal(starts, 0);
  assert.equal(stops, 0);
  assert.equal(deploymentOwnership('local-service'), 'user');
});

test('02A-E: unsupported parameters are refused and a binding stays pinned to its resolved source', () => {
  const runtime = new ProviderRuntime();
  runtime.registerAdapter(adapter);
  install(runtime, source('source-a', 'local-service'), 'same-name', 'fixed');
  assert.throws(() => runtime.resolveBinding('fixed', { vendorOnly: true }), (error: unknown) => error instanceof ProviderRuntimeError && error.category === 'unsupported_parameter');
  const resolved = runtime.resolveBinding('fixed');
  assert.equal(resolved.sourceId, 'source-a');
  assert.equal(resolved.effectiveParameters.speed, 1);
});

test('02A-F: managed-local startup failure is isolated and leaves no reusable instance', async () => {
  const runtime = new ProviderRuntime({ lifecycle: { broken: { start: async () => { throw new Error('worker unavailable'); } } } });
  runtime.registerAdapter(adapter);
  install(runtime, source('broken', 'managed-local'), 'broken-model', 'broken-voice');
  await assert.rejects(runtime.acquire('broken-voice'), (error: unknown) => error instanceof ProviderRuntimeError && error.category === 'resource_missing');
  assert.equal(runtime.health()[0]?.state, 'failed');
  assert.equal(runtime.health()[0]?.reason, 'worker unavailable');
});

test('02A-F: legacy seven-slot migration is deterministic and keeps credential, model and budget traceability', () => {
  const legacy: SlotBinding = {
    adapterId: 'fixture.tts.adapter', protocol: 'openai-compatible', provider: 'dashscope',
    endpoint: 'https://api.example.test/v1', model: 'fixture-tts', credentialRef: 'legacy-key',
    inputTokenLimit: 0, outputTokenLimit: 0, reservationMicros: 1200,
    inputMicrosPerToken: 0, outputMicrosPerToken: 0, voice: 'Cherry', language: 'Chinese', characterMicros: 10, audioMicrosPerSecond: 1,
  };
  const first = migrateLegacySlot('tts', legacy, adapter);
  const second = migrateLegacySlot('tts', legacy, adapter);
  assert.deepEqual(first, second);
  assert.equal(first.source.auth.kind, 'credentialRef');
  assert.equal(first.source.auth.ref, 'legacy-key');
  assert.equal(first.modelProfile.nativeModelId, 'fixture-tts');
  assert.equal(first.modelProfile.nativeVoiceId, 'Cherry');
  assert.equal(first.binding.legacySlot, 'tts');
  assert.equal(first.source.cost?.reservationMicros, 1200);
});

test('02A-D/E: calls obey the declared per-source queue bound and cancellation does not start queued work', async () => {
  const runtime = new ProviderRuntime();
  runtime.registerAdapter(adapter);
  install(runtime, source('queued', 'local-service', 1, { limits: { ...limits, maxConcurrentCalls: 1, maxQueueDepth: 1 } }), 'queued-model', 'queued-voice');
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
  let started = 0;
  const first = runtime.call('queued-voice', async (_binding, signal) => {
    started += 1;
    markFirstStarted();
    await Promise.race([firstGate, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    return 'first';
  });
  await firstStarted;
  const queuedAbort = new AbortController();
  const queued = runtime.call('queued-voice', async () => { started += 1; return 'queued'; }, { signal: queuedAbort.signal });
  await new Promise(resolve => setTimeout(resolve, 1));
  const full = runtime.call('queued-voice', async () => 'full');
  queuedAbort.abort();
  await assert.rejects(queued, (error: unknown) => error instanceof ProviderRuntimeError && error.category === 'lifecycle_violation');
  await assert.rejects(full, (error: unknown) => error instanceof ProviderRuntimeError && error.category === 'resource_missing');
  releaseFirst();
  assert.equal(await first, 'first');
  assert.equal(started, 1);
});

test('02A-E: an active call timeout is terminal for that call and never retries on another source', async () => {
  const runtime = new ProviderRuntime();
  runtime.registerAdapter(adapter);
  install(runtime, source('timeout', 'local-service'), 'timeout-model', 'timeout-voice');
  await assert.rejects(runtime.call('timeout-voice', async () => new Promise<string>(() => undefined), { timeoutMs: 5 }),
    (error: unknown) => error instanceof ProviderRuntimeError && error.category === 'lifecycle_violation');
});

test('02A-E: a released queue slot grants exactly one waiter and does not deadlock later calls', async () => {
  const runtime = new ProviderRuntime();
  runtime.registerAdapter(adapter);
  install(runtime, source('queue-regression', 'local-service', 1, { limits: { ...limits, maxConcurrentCalls: 1, maxQueueDepth: 2 } }), 'queue-model', 'queue-voice');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: number[] = [];
  const calls = [1, 2, 3].map(index => runtime.call('queue-voice', async () => {
    started.push(index);
    if (index === 1) await gate;
    return index;
  }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(started, [1]);
  release();
  assert.deepEqual(await Promise.all(calls), [1, 2, 3]);
  assert.deepEqual(started, [1, 2, 3]);
});
