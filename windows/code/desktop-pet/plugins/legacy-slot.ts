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
import { PROVIDER_SLOTS } from '../management/settings.js';
import type { ProviderSlot } from '../contracts/management.js';
import { LEGACY_SLOT_BY_CAPABILITY, type LegacyProviderSlot, type RequiredCapabilityId } from '../contracts/capability.js';

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
