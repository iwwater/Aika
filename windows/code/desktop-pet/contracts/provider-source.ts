/**
 * K65-01 (D2/D3/D5): the frozen multi-source schema of 0.65 API v1.
 *
 * Five-layer separation (PROVIDERS.md §1): Capability -> Provider Adapter -> Source Instance ->
 * Model Profile -> Binding, resolved into an immutable `ResolvedBinding`.
 *
 * Ownership: these five declarations are K65-01's delivery and 02A only consumes them. K65-02A
 * implements source registration, resolution and instance lifecycle (leases, health, single-flight
 * load); if the frozen types turn out to be insufficient, the change goes through the SPEC.md §3
 * process — affected consumers, compatibility migration, regression — instead of a local re-declaration.
 */
import type { CapabilityId, SideEffectCategory } from './capability.js';

export const PROVIDER_SOURCE_SCHEMA_VERSION = 1 as const;

/**
 * Deployment is orthogonal to protocol (PROVIDERS.md §2). It is never inferred from a model name or a
 * URL shape, and a local deployment is never assumed to be one single engine.
 */
export type Deployment = 'remote-api' | 'local-service' | 'managed-local';
export const DEPLOYMENTS: readonly Deployment[] = ['remote-api', 'local-service', 'managed-local'];

/**
 * Process ownership by deployment. `local-service` is user-owned: the host closes its own connection
 * and must never terminate the process (PROVIDERS.md §2, §5).
 */
export const DEPLOYMENT_OWNERSHIP: Readonly<Record<Deployment, 'host' | 'user' | 'package-adapter'>> = {
  'remote-api': 'host',
  'local-service': 'user',
  'managed-local': 'package-adapter',
};

/** Authentication is a declaration, never a value. `none` is legitimate for local sources. */
export interface AuthDeclaration {
  readonly kind: 'none' | 'credentialRef';
  /** Present only for `credentialRef`; a stable reference into the `SecretStore`, never a key. */
  readonly ref?: string;
  readonly provider?: string;
}

/** Cloud rate fields. A local source without cloud billing omits these entirely — they are optional. */
export interface CostDeclaration {
  readonly basis: 'known' | 'unknown' | 'local_unmetered';
  readonly currency?: string;
  readonly inputMicrosPerUnit?: number;
  readonly outputMicrosPerUnit?: number;
  readonly reservationMicros?: number;
  readonly note: string;
}

/**
 * One parameter of a capability schema. PROVIDERS.md §3 forbids one universal parameter bag: each
 * capability carries its own declaration, and an undeclared parameter name is refused.
 */
export interface ParameterSchema {
  readonly name: string;
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'string[]';
  readonly required: boolean;
  readonly values?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly note: string;
}

/** Per-capability parameter vocabulary + output constraint. */
export interface CapabilitySchema {
  readonly capabilityId: CapabilityId;
  readonly parameters: readonly ParameterSchema[];
  readonly outputs: readonly { readonly name: string; readonly type: string; readonly streaming: boolean; readonly note: string }[];
  /** `null` means the capability does not accept caller-supplied models. */
  readonly modelIdentifier: string | null;
  /** `null` means the capability has no voice; a cloud voice id is not portable to a local engine. */
  readonly voiceIdentifier: string | null;
  readonly streaming: readonly ('streaming' | 'batch')[];
  readonly cancellable: boolean;
}

/** What a package/plugin is installed and enabled as; distinct from readiness and from load state. */
export type SourceEnablement = 'enabled' | 'disabled';

export interface ResourceLimits {
  /** Bounded concurrency per source; never a global engine limit. */
  readonly maxConcurrentCalls: number;
  readonly maxQueueDepth: number;
  readonly startupTimeoutMs: number;
  readonly callTimeoutMs: number;
  readonly maxMemoryMb: number | null;
  readonly maxGpuDevices: number | null;
}

// --- Layer 2: Provider Adapter -------------------------------------------------------------------

/**
 * How one protocol or local engine is called. Adapter identity is provider-neutral and is what a
 * plugin registers; many source instances share one adapter (PROVIDERS.md §1, §6).
 */
export interface AdapterDescriptor {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly packageId: string;
  readonly pluginId: string;
  readonly label: string;
  /** Protocol/engine token this adapter implements, e.g. `openai-compatible`, `sherpa-onnx`, `sapi`. */
  readonly protocol: string;
  readonly capabilitySchemas: readonly CapabilitySchema[];
  /** Parameters the adapter forwards verbatim to its own engine. Never passed to another source. */
  readonly proprietaryParameters: readonly string[];
  /** Deployment modes this adapter can run under. */
  readonly deployments: readonly Deployment[];
  readonly contractVersion: string;
}

// --- Layer 3: Source Instance --------------------------------------------------------------------

/**
 * A concrete service or engine instance: what endpoint or runtime is connected, with what auth.
 * `configRevision` participates in connection reuse; the model name alone is never the cache key.
 */
export interface SourceInstance {
  readonly sourceId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly deployment: Deployment;
  readonly label: string;
  readonly configRevision: number;
  /** Present for `remote-api` and `local-service`; absent for `managed-local`. */
  readonly endpoint?: string;
  /** Present for `managed-local`: a reference to launchable resources. */
  readonly runtimeRef?: string;
  readonly auth: AuthDeclaration;
  /** Optional: a local source with no cloud billing declares `local_unmetered` or omits it. */
  readonly cost?: CostDeclaration;
  readonly limits: ResourceLimits;
  readonly enablement: SourceEnablement;
  /** Adapter-validated parameters for this source instance, scoped per capability. */
  readonly parameters: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Data destination declared for the user; required when the source leaves the machine. */
  readonly dataDestination: 'local-machine' | 'vendor-cloud' | 'user-network-service' | 'unknown';
}

// --- Layer 4: Model Profile ----------------------------------------------------------------------

/**
 * Which model, voice and parameters are used on one source. A model name appearing on two sources is
 * still two independent profiles (PROVIDERS.md §3).
 */
export interface ModelProfile {
  readonly modelProfileId: string;
  readonly revision: number;
  readonly sourceId: string;
  readonly capabilityId: CapabilityId;
  readonly label: string;
  /** Native model id on that source; `null` for engines without a model selector. */
  readonly nativeModelId: string | null;
  /** Native voice id owned by THIS source; never a cloud voice id handed to a local engine. */
  readonly nativeVoiceId: string | null;
  /** Parameters verified by the adapter for this profile, validated against the capability schema. */
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Capability overrides relative to the adapter declaration; intersection decides the effective set. */
  readonly capabilityOverrides: { readonly streaming?: boolean; readonly cancellable?: boolean };
  readonly resources: readonly string[];
}

// --- Layer 5: Binding ----------------------------------------------------------------------------

/** Which model profile a slot/stage selects. A binding is a reference; it carries no credentials. */
export interface Binding {
  readonly bindingId: string;
  readonly revision: number;
  readonly capabilityId: CapabilityId;
  readonly modelProfileId: string;
  /** Legacy seven-slot name this binding replaces during migration; no second settings authority. */
  readonly legacySlot: string | null;
  /** Optional narrowing: character, flow profile or stage this binding applies to. */
  readonly scope: BindingScope | null;
  readonly failurePolicy: 'fail_turn' | 'report_partial';
}

export interface BindingScope {
  readonly characterId: string | null;
  readonly flowProfileId: string | null;
  readonly stageId: string | null;
}

/**
 * The immutable result of resolving a binding at call time. Everything a caller needs to attribute a
 * call and everything the host needs to reuse a connection or instance is pinned here, so that a
 * mid-stream source switch is impossible (PROVIDERS.md §5).
 */
export interface ResolvedBinding {
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly capabilityId: CapabilityId;
  readonly contractVersion: string;
  readonly packageId: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sourceId: string;
  readonly sourceConfigRevision: number;
  readonly deployment: Deployment;
  readonly modelProfileId: string;
  readonly modelProfileRevision: number;
  readonly nativeModelId: string | null;
  readonly nativeVoiceId: string | null;
  /** Effective parameters = adapter schema ∩ model profile ∩ binding-time overrides. */
  readonly effectiveParameters: Readonly<Record<string, unknown>>;
  /** Credential reference only; resolving it is the `SecretStore`'s job and never copies a key. */
  readonly credentialRef: string | null;
  readonly sideEffect: SideEffectCategory;
  readonly limits: ResourceLimits;
  /** Sortable, stable cache key for instance reuse. Never the model name alone. */
  readonly instanceKey: string;
}

/** Effective capability is the intersection; `unknown` never counts as supported (PROVIDERS.md §3). */
export function effectiveFeatures(
  adapter: { readonly streaming: readonly ('streaming' | 'batch')[]; readonly cancellable: boolean },
  overrides: { readonly streaming?: boolean; readonly cancellable?: boolean } | undefined,
): { readonly streaming: boolean; readonly cancellable: boolean } {
  const adapterStreaming = adapter.streaming.includes('streaming');
  return {
    streaming: overrides?.streaming === undefined ? adapterStreaming : adapterStreaming && overrides.streaming,
    cancellable: overrides?.cancellable === undefined ? adapter.cancellable : adapter.cancellable && overrides.cancellable,
  };
}

/** Instance reuse key: source + config revision + adapter + model + device class. */
export function instanceKey(input: {
  readonly sourceId: string; readonly sourceConfigRevision: number; readonly adapterId: string;
  readonly adapterVersion: string; readonly nativeModelId: string | null; readonly nativeVoiceId: string | null;
}): string {
  return [input.sourceId, String(input.sourceConfigRevision), input.adapterId, input.adapterVersion,
    input.nativeModelId ?? '-', input.nativeVoiceId ?? '-'].join('|');
}

/**
 * D5: the timeout defaults measured by K65-00 (BASELINE.md §4) and frozen here as a capped policy.
 * CONTRACTS.md §3: a side-effecting operation is never retried automatically after a timeout.
 */
export const PLUGIN_TIMEOUT_DEFAULTS = {
  /** EOF -> SIGKILL shutdown ceiling; `desktop/electron/transport.mjs:148`. */
  shutdownMs: 10_000,
  /** Backend startup readiness window and no-progress window; `transport.mjs:18-24`. */
  startupReadyMs: 60_000,
  startupNoProgressMs: 60_000,
  /** Total startup ceiling. */
  startupMaxMs: 600_000,
  /** Streaming ASR open / single call; `providers/sherpa-streaming-asr.ts`. */
  asrOpenMs: 30_000,
  asrCallMs: 15_000,
  /** Voice finish; `media/voice-input-session.ts`. */
  voiceFinishMs: 10_000,
  /** Single utterance ceiling. */
  utteranceMaxMs: 120_000,
  /** Desktop frame pull retry / timeout; `app/desktop-device-bridge.ts:12,14`. */
  frameRetryMs: 10,
  frameTimeoutMs: 2_000,
  /** Wake watchdog poll interval; `app/wake-manager.ts:84`. */
  wakeWatchdogPollMs: 1_000,
  wakeWatchdogConnectingMs: 60_000,
  wakeWatchdogStalledMs: 15_000,
  /** Memory maintenance timer; `app/backend.ts:54`. */
  memoryMaintenanceMs: 60_000,
  /** Management context session; `management/settings.ts` default settings. */
  managementContextMs: 300_000,
} as const;

export type TimeoutPolicyName = keyof typeof PLUGIN_TIMEOUT_DEFAULTS;

/**
 * Applies a default timeout with an abort signal instead of an unbounded wait. Explicitly NOT retried
 * for a side-effecting operation; callers decide that, and `SIDE_EFFECT_RETRY_ALLOWED` is the only
 * sanctioned predicate for it.
 */
export async function withTimeout<T>(
  policy: TimeoutPolicyName,
  operation: (signal: AbortSignal) => Promise<T>,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly now?: () => number } = {},
): Promise<T> {
  const limit = options.timeoutMs ?? PLUGIN_TIMEOUT_DEFAULTS[policy];
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError(`Invalid timeout for ${policy}: ${String(limit)}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout:${policy}:${limit}ms`)), limit);
  if (timer.unref) timer.unref();
  const relay = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) relay();
    else options.signal.addEventListener('abort', relay, { once: true });
  }
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', relay);
  }
}
