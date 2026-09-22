// N075-01/R7: Legacy ProviderRuntime Adapter.
// Adapts the legacy TrialConfiguration / endpoint(operation) scattered model configuration onto
// the frozen 0.65 ProviderRuntime without creating a parallel ProviderRegistryV2 or BindingStoreV2.
// The migration path:
//   TrialConfiguration -> LegacyProviderRuntimeAdapter -> ProviderRuntime -> ResolvedBinding -> EndpointConfig

import type { TrialConfiguration, TrialOperation } from '../app/trial-config.js';
import type { CallAuthorizer, EndpointConfig } from '../providers/transport.js';
import type { AdapterDescriptor, CapabilitySchema, ResolvedBinding } from '../contracts/provider-source.js';
import { ProviderRuntime } from './provider-runtime.js';
import { migrateLegacySlot } from './legacy-slot.js';
import type { SlotBinding } from '../providers/slot-registry.js';
import type { ProviderSlot } from '../contracts/management.js';

function createOpenAiAdapterDescriptor(): AdapterDescriptor {
  const llmChat: CapabilitySchema = {
    capabilityId: 'llm.chat',
    parameters: [
      { name: 'temperature', type: 'number', required: false, note: 'Sampling temperature' },
      { name: 'thinking', type: 'string', required: false, note: 'Thinking mode' },
    ],
    outputs: [{ name: 'text', type: 'string', streaming: false, note: 'Text reply' }],
    modelIdentifier: 'model',
    voiceIdentifier: 'none',
    streaming: ['batch'],
    cancellable: true,
  };

  const backgroundLifecycle: CapabilitySchema = {
    capabilityId: 'background.lifecycle',
    parameters: [{ name: 'thinking', type: 'string', required: false, note: 'Thinking mode' }],
    outputs: [{ name: 'plan', type: 'string', streaming: false, note: 'Memory turn plan' }],
    modelIdentifier: 'model',
    voiceIdentifier: 'none',
    streaming: ['batch'],
    cancellable: true,
  };

  const contextSource: CapabilitySchema = {
    capabilityId: 'context.source',
    parameters: [],
    outputs: [{ name: 'summary', type: 'string', streaming: false, note: 'Summary proposal' }],
    modelIdentifier: 'model',
    voiceIdentifier: 'none',
    streaming: ['batch'],
    cancellable: true,
  };

  const inputCapture: CapabilitySchema = {
    capabilityId: 'input.capture',
    parameters: [],
    outputs: [{ name: 'perception', type: 'string', streaming: false, note: 'Perception result' }],
    modelIdentifier: 'model',
    voiceIdentifier: 'none',
    streaming: ['batch'],
    cancellable: true,
  };

  return Object.freeze({
    adapterId: 'legacy.openai.adapter',
    adapterVersion: '1.0.0',
    packageId: 'com.aika.legacy.providers',
    pluginId: 'legacy.providers',
    label: 'Legacy OpenAI Compatible',
    protocol: 'openai-compatible',
    capabilitySchemas: Object.freeze([llmChat, backgroundLifecycle, contextSource, inputCapture]),
    proprietaryParameters: Object.freeze(['temperature', 'thinking']),
    deployments: Object.freeze(['remote-api'] as const),
    contractVersion: '1.0.0',
  });
}

function createAudioAdapterDescriptor(): AdapterDescriptor {
  const ttsSchema: CapabilitySchema = {
    capabilityId: 'tts.synthesize',
    parameters: [
      { name: 'voice', type: 'string', required: false, note: 'Voice identifier' },
      { name: 'language', type: 'string', required: false, note: 'Language code' },
    ],
    outputs: [{ name: 'audio', type: 'string', streaming: false, note: 'Audio binary' }],
    modelIdentifier: 'model',
    voiceIdentifier: 'voice',
    streaming: ['batch'],
    cancellable: true,
  };

  const asrSchema: CapabilitySchema = {
    capabilityId: 'stt.transcribe',
    parameters: [],
    outputs: [{ name: 'transcript', type: 'string', streaming: false, note: 'Transcript string' }],
    modelIdentifier: 'model',
    voiceIdentifier: 'none',
    streaming: ['batch'],
    cancellable: true,
  };

  return Object.freeze({
    adapterId: 'legacy.audio.adapter',
    adapterVersion: '1.0.0',
    packageId: 'com.aika.legacy.audio',
    pluginId: 'legacy.audio',
    label: 'Legacy Audio Providers',
    protocol: 'audio-protocol',
    capabilitySchemas: Object.freeze([ttsSchema, asrSchema]),
    proprietaryParameters: Object.freeze(['voice', 'language']),
    deployments: Object.freeze(['remote-api'] as const),
    contractVersion: '1.0.0',
  });
}

export class LegacyProviderRuntimeAdapter {
  readonly runtime: ProviderRuntime;

  constructor(
    private readonly configuration: TrialConfiguration,
    private readonly authorizer: CallAuthorizer,
    private readonly keyResolver: (credentialRef: string | null) => () => string,
  ) {
    this.runtime = new ProviderRuntime({
      secrets: {
        has: (ref: string, provider: string) => {
          try { return Boolean(keyResolver(ref)()); } catch { return false; }
        },
        resolve: (ref: string, provider: string) => {
          try {
            const val = keyResolver(ref)();
            return val ? { ref, provider } : null;
          } catch { return null; }
        },
        list: () => [],
      },
    });

    this.registerLegacyAdapters();
    this.migrateConfiguration();
  }

  private registerLegacyAdapters(): void {
    this.runtime.registerAdapter(createOpenAiAdapterDescriptor());
    this.runtime.registerAdapter(createAudioAdapterDescriptor());
  }

  private migrateConfiguration(): void {
    const textAdapter = this.runtime.getAdapter('legacy.openai.adapter')!;
    const audioAdapter = this.runtime.getAdapter('legacy.audio.adapter')!;

    const operations: readonly TrialOperation[] = [
      'dialogue', 'memory_turn', 'summary', 'admission', 'perception', 'tts', 'asr',
    ];

    for (const op of operations) {
      const model = this.configuration.models[op];
      if (!model) continue;

      const slot = op as ProviderSlot;
      const isAudio = slot === 'tts' || slot === 'asr';
      const adapter = isAudio ? audioAdapter : textAdapter;

      const slotBinding: SlotBinding = {
        adapterId: adapter.adapterId,
        protocol: (model.protocol ?? 'openai-compatible') as any,
        provider: model.provider,
        endpoint: model.endpoint,
        model: model.model,
        credentialRef: model.credentialFile,
        inputTokenLimit: model.inputTokenLimit,
        outputTokenLimit: model.outputTokenLimit,
        inputMicrosPerToken: model.inputMicrosPerToken,
        outputMicrosPerToken: model.outputMicrosPerToken,
        reservationMicros: model.reservationMicros,
        ...(model.thinking ? { thinking: model.thinking } : {}),
        ...(slot === 'tts' ? { voice: 'Cherry', language: 'Chinese' } : {}),
      };

      try {
        const migrated = migrateLegacySlot(slot, slotBinding, adapter);
        this.runtime.saveSource(migrated.source);
        this.runtime.saveModelProfile(migrated.modelProfile);
        this.runtime.saveBinding(migrated.binding);
      } catch (err) {
        // If an operation cannot be migrated (e.g. absent capability), keep remaining slots
      }
    }
  }

  resolveOperationBinding(operation: TrialOperation): ResolvedBinding {
    return this.runtime.resolveBinding(`legacy.${operation}`);
  }

  getEndpointConfig(operation: TrialOperation): EndpointConfig {
    const resolved = this.resolveOperationBinding(operation);
    const source = this.runtime.getSource(resolved.sourceId);
    if (!source || !source.endpoint) {
      throw new Error(`Endpoint not configured for operation ${operation}`);
    }

    return {
      model: resolved.nativeModelId ?? '',
      endpoint: source.endpoint,
      apiKey: this.keyResolver(resolved.credentialRef),
      authorizer: this.authorizer,
    };
  }
}
