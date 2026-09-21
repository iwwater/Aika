/**
 * K65-01 · D3: adapts the EXISTING credential registry to the frozen `SecretStore` plugin interface.
 *
 * This module does not build a credential store and does not relax or replace the existing policy:
 * `credentialRegistry()` (management/credentials.ts) and `ManagedCredentialStore`
 * (management/credential-store.ts) remain the single authority over where a key file lives and how it is
 * created. This file only projects that authority onto the three-method shape a plugin may see.
 *
 * It is deliberately NOT part of the emitted plugin SDK (plugins/sdk-emit.ts SDK_MODULES): it imports the
 * management layer, so including it would drag a host private tree into every package project, which is
 * exactly what 01-C refuses. The SDK ships the `SecretStore` TYPE; the host supplies this object.
 *
 * The refs-only rule is structural, not a convention: the adapter never returns the plaintext FILE PATH,
 * never reads the file, and never returns key material. `resolve` returns the same `{ref, provider}` pair
 * the caller already had — enough for a plugin to say "use credential X" and nothing else. The one
 * internal `file()` lookup resolves strict
 * existence through realpath/stat without ever surfacing the path.
 */
import type { SecretStore } from '../contracts/plugin.js';
import { credentialRegistry } from '../management/credentials.js';
import type { TrialConfiguration } from '../app/trial-config.js';

/** The status vocabulary `SecretStore.list()` reports; identical to management's `CredentialInfo.status`. */
export type SecretStatus = 'configured' | 'missing' | 'unavailable';
export interface SecretRef {
  readonly ref: string;
  readonly provider: string;
  readonly status: SecretStatus;
}

/**
 * The registry projection. `has` and `list` read the registry's own realpath/stat classification, so a
 * plugin asking "do I have a credential" gets the host's answer rather than its own guess.
 */
export interface SecretStoreAdapter extends SecretStore {
  /** Refs only, never file paths: everything the registry knows, without any secret content. */
  refs(): readonly SecretRef[];
}

/**
 * Wraps an existing credential registry as a `SecretStore`. `credentialRegistry()` is the production
 * factory; passing the registry itself (instead of a configuration) keeps the adapter usable with a
 * registry the caller already built, e.g. one bound to a specific `ManagedCredentialStore` directory.
 */
export function secretStoreFromRegistry(registry: ReturnType<typeof credentialRegistry>): SecretStoreAdapter {
  const known = (): readonly SecretRef[] => registry.list().map(entry => ({
    ref: entry.id, provider: entry.provider ?? '', status: entry.status,
  }));
  return {
    refs: known,
    has(ref: string, provider: string): boolean {
      return known().some(entry => entry.ref === ref && entry.provider === provider);
    },
    /**
     * Resolution is a reference echo, never a plaintext read. A ref the registry has never seen resolves
     * to `null`, which for a `credentialRef` auth is a provisioning state, not an error the validator owns.
     */
    resolve(ref: string, provider: string): { readonly ref: string; readonly provider: string } | null {
      const entry = known().find(candidate => candidate.ref === ref && candidate.provider === provider);
      return entry ? { ref: entry.ref, provider: entry.provider } : null;
    },
    list(): readonly SecretRef[] { return known(); },
  };
}

/** Convenience host-side constructor: the registry for `configuration`, adapted to `SecretStore`. */
export function secretStore(configuration: TrialConfiguration): SecretStoreAdapter {
  return secretStoreFromRegistry(credentialRegistry(configuration));
}

/**
 * The adapter surface must not leak a filesystem path. Every string the three methods can return is one
 * of these keys or the caller's own input, so asserting the key set makes the refs-only rule checkable.
 */
export const SECRET_STORE_REF_KEYS: readonly string[] = ['ref', 'provider', 'status'];
