/**
 * K65-01 01-C: the fixture package's own build output.
 *
 * This project is a third-party capability package. Everything it uses comes from the emitted plugin
 * SDK artifact (`aika-plugin-sdk`, emitted by `npm run sdk:next65`); it never imports the host's
 * `contracts/`, `providers/`, `app/` or `plugins/` trees, does not extend the host `tsconfig.json`, and
 * does not resolve through the host `node_modules`.
 *
 * It is also the package the host validator is pointed at in the 01-A/01-B cases: the entry here is a
 * real compiled ESM module with a real top-level side effect, so "validation executes the entry zero
 * times" is observable rather than asserted from a source string.
 */
import type {
  AdapterDescriptor, Binding, CapabilityDeclaration, HostContext, ModelProfile, PackageManifest,
  PluginActivation, PluginHandle, ResolvedBinding, SecretStore, SourceInstance,
} from 'aika-plugin-sdk';
import { CAPABILITY_CONTRACT_VERSION, PLUGIN_API_VERSION, validateAdapterDescriptor } from 'aika-plugin-sdk';

/** A local engine with no credential and no cloud rate: the 01-E "本地无 Key/无云费率" shape. */
export const LOCAL_SAPI_DEPLOYMENT = 'managed-local' as const;

export function localSapiCapability(): CapabilityDeclaration {
  return {
    capabilityId: 'tts.synthesize',
    category: 'output',
    adapterId: 'fixture-sapi',
    adapterVersion: '1.0.0',
    contractVersion: CAPABILITY_CONTRACT_VERSION,
    parameters: ['voiceId', 'sampleRate', 'encoding'],
    execution: ['unary'],
    inputs: [{ name: 'text', type: 'string', required: true, description: '已确认的助手口语文本' }],
    outputs: [{ name: 'audio', type: 'bytes', required: true, description: '可解码的 PCM/WAV 字节' }],
    sideEffect: 'user_visible_output',
    auth: 'none',
  };
}

/** A source instance with `auth: none` and no `cost`: a local engine is not forced to carry cloud fields. */
export function localSapiSource(): SourceInstance {
  return {
    sourceId: 'fixture-sapi-local',
    adapterId: 'fixture-sapi',
    adapterVersion: '1.0.0',
    deployment: LOCAL_SAPI_DEPLOYMENT,
    label: '本机 SAPI 合成（fixture）',
    configRevision: 1,
    runtimeRef: 'resources/sapi-runtime.json',
    auth: { kind: 'none' },
    limits: { maxConcurrentCalls: 1, maxQueueDepth: 2, startupTimeoutMs: 60000, callTimeoutMs: 15000, maxMemoryMb: null, maxGpuDevices: null },
    enablement: 'enabled',
    parameters: { 'tts.synthesize': { voiceId: 'Microsoft Huihui Desktop' } },
    dataDestination: 'local-machine',
  };
}

export function localSapiAdapter(): AdapterDescriptor {
  return {
    adapterId: 'fixture-sapi',
    adapterVersion: '1.0.0',
    packageId: 'dev.aika.fixture.sapi',
    pluginId: 'sapi-tts',
    label: 'Fixture SAPI adapter',
    protocol: 'sapi',
    capabilitySchemas: [{
      capabilityId: 'tts.synthesize',
      parameters: [
        { name: 'voiceId', type: 'string', required: true, note: '本机音色标识' },
        { name: 'sampleRate', type: 'integer', required: false, minimum: 8000, maximum: 48000, note: '输出采样率' },
      ],
      outputs: [{ name: 'audio', type: 'bytes', streaming: false, note: '整段音频' }],
      modelIdentifier: null,
      voiceIdentifier: 'voiceId',
      streaming: ['batch'],
      cancellable: true,
    }],
    proprietaryParameters: [],
    deployments: [LOCAL_SAPI_DEPLOYMENT],
    contractVersion: CAPABILITY_CONTRACT_VERSION,
  };
}

export function localSapiProfile(): ModelProfile {
  return {
    modelProfileId: 'fixture-sapi-hui-hui',
    revision: 1,
    sourceId: 'fixture-sapi-local',
    capabilityId: 'tts.synthesize',
    label: 'Huihui Desktop（本机）',
    nativeModelId: null,
    nativeVoiceId: 'Microsoft Huihui Desktop',
    parameters: { voiceId: 'Microsoft Huihui Desktop', sampleRate: 16000 },
    capabilityOverrides: {},
    resources: [],
  };
}

export function localSapiBinding(): Binding {
  return {
    bindingId: 'fixture-binding-tts',
    revision: 1,
    capabilityId: 'tts.synthesize',
    modelProfileId: 'fixture-sapi-hui-hui',
    legacySlot: 'tts',
    scope: { characterId: null, flowProfileId: null, stageId: null },
    failurePolicy: 'fail_turn',
  };
}

/** A resolved binding is what a caller receives: every revision pinned, no key anywhere. */
export function localSapiResolved(adapter: AdapterDescriptor, source: SourceInstance, profile: ModelProfile, binding: Binding): ResolvedBinding {
  return {
    bindingId: binding.bindingId,
    bindingRevision: binding.revision,
    capabilityId: binding.capabilityId,
    contractVersion: adapter.contractVersion,
    packageId: adapter.packageId,
    adapterId: adapter.adapterId,
    adapterVersion: adapter.adapterVersion,
    sourceId: source.sourceId,
    sourceConfigRevision: source.configRevision,
    deployment: source.deployment,
    modelProfileId: profile.modelProfileId,
    modelProfileRevision: profile.revision,
    nativeModelId: profile.nativeModelId,
    nativeVoiceId: profile.nativeVoiceId,
    effectiveParameters: profile.parameters,
    credentialRef: null,
    sideEffect: 'user_visible_output',
    limits: source.limits,
    instanceKey: [source.sourceId, String(source.configRevision), adapter.adapterId, adapter.adapterVersion, profile.nativeModelId ?? '-', profile.nativeVoiceId ?? '-'].join('|'),
  };
}

export function fixtureManifest(): PackageManifest['packageId'] {
  return 'dev.aika.fixture.sapi';
}

/** Reads nothing and starts nothing: activation returns a handle and declares one resource. */
export const activation: PluginActivation = {
  activate(host: HostContext): PluginHandle {
    host.log.log('info', 'fixture sapi plugin activated');
    host.resources.register('timer', 'health', () => undefined);
    return {
      pluginId: host.pluginId,
      packageId: host.packageId,
      packageVersion: '1.0.0',
      apiVersion: PLUGIN_API_VERSION,
      state: 'active',
      capabilityIds: ['tts.synthesize'],
    };
  },
  deactivate(): void { /* no process, no device, nothing to release */ },
};

/** A `SecretStore` consumer must only ever see references; the fixture asserts that shape compiles. */
export function describeCredential(secrets: SecretStore, ref: string): string {
  return secrets.has(ref, 'fixture') ? ref : 'none';
}

/** Compile-time proof the SDK's validators are usable from a package project without the host tree. */
export function adapterIsValid(adapter: AdapterDescriptor): boolean {
  return validateAdapterDescriptor(adapter).length === 0;
}

export const CAPABILITY_COVERAGE_NOTE = 'fixture covers output/tts.synthesize only; the host covers the other five categories';
