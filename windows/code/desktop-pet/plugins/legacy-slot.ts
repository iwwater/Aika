/**
 * K65-01: the host-side bridge between the frozen capability vocabulary and the existing seven-slot
 * provider vocabulary.
 *
 * The dual-authority risk is K65-00 §00-C C-7: `ProviderSlot` is declared once in
 * `contracts/management.ts:6` and the seven-value array is mirrored literally in
 * `management/settings.ts:9` and `management/aika-profile.ts:13`. The 0.65 capability vocabulary is a
 * new, intentionally unrelated namespace, so the host needs exactly one place that says how the two
 * line up — and that place must be able to reference the real `ProviderSlot` type, which is why it
 * lives here rather than inside the emitted SDK.
 *
 * Nothing here mutates the existing slot declarations; the arrays are compared, never rebuilt.
 */
import { createHash } from 'node:crypto';
import { PROVIDER_SLOTS } from '../management/settings.js';
import type { ProviderSlot } from '../contracts/management.js';
import { LEGACY_SLOT_BY_CAPABILITY, type CapabilityId, type LegacyProviderSlot, type RequiredCapabilityId } from '../contracts/capability.js';
import type { AdapterDescriptor, Binding, ModelProfile, SourceInstance } from '../contracts/provider-source.js';
import type { SlotBinding } from '../providers/slot-registry.js';

/** The seven values, read from the existing authoritative export rather than restated. */
export const HOST_PROVIDER_SLOTS: readonly ProviderSlot[] = PROVIDER_SLOTS;

/**
 * The capability → slot mapping, typed against BOTH vocabularies. If either side changes, this
 * assignment stops compiling instead of silently drifting.
 */
export const LEGACY_SLOT_BY_CAPABILITY_HOST: Readonly<Partial<Record<RequiredCapabilityId, ProviderSlot>>> = LEGACY_SLOT_BY_CAPABILITY;

/** Capability ids that correspond to no legacy slot; a package providing them is genuinely new. */
export const CAPABILITIES_WITHOUT_LEGACY_SLOT: readonly RequiredCapabilityId[] = [
  'audio.playback', 'presentation.render', 'background.lifecycle',
];

/** The one-way capability name used when an old seven-slot record is migrated. */
const CAPABILITY_BY_SLOT: Readonly<Partial<Record<ProviderSlot, CapabilityId>>> = Object.fromEntries(
  Object.entries(LEGACY_SLOT_BY_CAPABILITY).map(([capabilityId, slot]) => [slot, capabilityId]),
) as Partial<Record<ProviderSlot, CapabilityId>>;

export interface LegacySlotMigration {
  readonly source: SourceInstance;
  readonly modelProfile: ModelProfile;
  readonly binding: Binding;
}

/**
 * Convert one 0.61 SlotBinding into the 0.65 five-layer vocabulary.
 *
 * The IDs are derived only from the old record's stable content, so importing the same settings
 * twice returns byte-equivalent identities.  This is deliberately a pure conversion: persistence
 * and deduplication remain the caller's responsibility, and no provider is started while migrating.
 */
export function migrateLegacySlot(slot: ProviderSlot, legacy: SlotBinding, adapter: AdapterDescriptor): LegacySlotMigration {
  const capabilityId = CAPABILITY_BY_SLOT[slot];
  if (!capabilityId) throw new Error(`legacy slot ${slot} has no 0.65 capability mapping`);
  const schema = adapter.capabilitySchemas.find(candidate => candidate.capabilityId === capabilityId);
  if (!schema) throw new Error(`adapter ${adapter.adapterId} does not provide ${capabilityId}`);
  const fingerprint = createHash('sha256').update(JSON.stringify({ slot, adapter: adapter.adapterId, version: adapter.adapterVersion, endpoint: legacy.endpoint, provider: legacy.provider, model: legacy.model, credentialRef: legacy.credentialRef })).digest('hex').slice(0, 16);
  const sourceId = `legacy.${slot}.${fingerprint}`;
  const profileId = `${sourceId}.profile`;
  const declared = new Set([...schema.parameters.map(parameter => parameter.name), ...adapter.proprietaryParameters]);
  const candidates: Record<string, unknown> = {
    temperature: legacy.temperature, thinking: legacy.thinking, voice: legacy.voice, language: legacy.language,
  };
  const parameters = Object.fromEntries(Object.entries(candidates).filter(([name, value]) => value !== undefined && declared.has(name)));
  const source: SourceInstance = {
    sourceId, adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion,
    deployment: 'remote-api', label: `Legacy ${slot} · ${legacy.provider}`,
    configRevision: 1, endpoint: legacy.endpoint,
    auth: { kind: 'credentialRef', ref: legacy.credentialRef, provider: legacy.provider },
    cost: { basis: 'known', currency: 'micros', inputMicrosPerUnit: legacy.inputMicrosPerToken, outputMicrosPerUnit: legacy.outputMicrosPerToken,
      reservationMicros: legacy.reservationMicros, note: 'Migrated from 0.61 SlotBinding; billing fields retained for traceability.' },
    limits: { maxConcurrentCalls: 1, maxQueueDepth: 0, startupTimeoutMs: 60_000, callTimeoutMs: 120_000, maxMemoryMb: null, maxGpuDevices: null },
    enablement: 'enabled', parameters: { [capabilityId]: parameters }, dataDestination: 'vendor-cloud',
  };
  const modelProfile: ModelProfile = {
    modelProfileId: profileId, revision: 1, sourceId, capabilityId, label: legacy.model,
    nativeModelId: legacy.model, nativeVoiceId: legacy.voice ?? null, parameters,
    capabilityOverrides: {}, resources: [],
  };
  const binding: Binding = {
    bindingId: `legacy.${slot}`, revision: 1, capabilityId, modelProfileId: profileId,
    legacySlot: slot, scope: null, failurePolicy: 'fail_turn',
  };
  return Object.freeze({ source: Object.freeze(source), modelProfile: Object.freeze(modelProfile), binding: Object.freeze(binding) });
}

/**
 * Structural equality of the SDK's copy of the slot vocabulary and the host's. Returns the differing
 * values instead of a boolean so a failure names the drift.
 */
export function legacySlotVocabularyDrift(): { readonly sdkOnly: readonly string[]; readonly hostOnly: readonly string[] } {
  const sdk: readonly LegacyProviderSlot[] = ['asr', 'dialogue', 'memory_turn', 'summary', 'perception', 'tts', 'admission'];
  const host: readonly string[] = HOST_PROVIDER_SLOTS;
  return {
    sdkOnly: sdk.filter(slot => !host.includes(slot)),
    hostOnly: host.filter(slot => !(sdk as readonly string[]).includes(slot)),
  };
}
