/**
 * K65-01 (D1/D2/D4/D6/D7): the frozen plugin / package / manifest contract of 0.65 API v1.
 *
 * Ownership (K65-00 D2): K65-01 owns every type declaration, the versioned schema and the validators
 * for `AdapterDescriptor`, `SourceInstance`, `ModelProfile`, `Binding` and `ResolvedBinding`. K65-02A
 * CONSUMES these; it delivers resolution functions, the mutable-config -> immutable `ResolvedBinding`
 * conversion, leases and health. 02A must not re-declare or rewrite any of them.
 *
 * This module is pure description: declaring a manifest never imports an entry, and no schema here
 * contains an executable form. Discovery and validation are metadata-only operations
 * (CONTRACTS.md §1 "发现只读元数据，不 import 入口").
 */
import type { CapabilityDeclaration } from './capability.js';

/** API surface version of the host/plugin boundary. Independent of `CONTRACT_VERSION`. */
export const PLUGIN_API_VERSION = '1.0.0' as const;
/** Version of the on-disk `manifest.json` schema. A directory package ships exactly one. */
export const MANIFEST_SCHEMA_VERSION = 1 as const;
/** Version of the package-build output description (`build-manifest.json`). */
export const PACKAGE_BUILD_SCHEMA_VERSION = 1 as const;
/** Directory-package import format version. There is no archive format in this version. */
export const PACKAGE_FORMAT_VERSION = 1 as const;

/**
 * Explicitly NOT `ProviderCapabilities` from contracts/index.ts. K65-00 D6 measured that declaration
 * at zero consumers and left it frozen and unreferenced; the new capability vocabulary lives in
 * `contracts/capability.ts` and has no semantic relationship to it. 0.65 adds no consumer of
 * `ProviderCapabilities`; if it is still unconsumed at K65-10, separation is a cleanup task.
 */
export const PROVIDER_CAPABILITIES_RELATION = 'unrelated-legacy-declaration' as const;

// --- Identity ------------------------------------------------------------------------------------

/** Package id: reverse-DNS-ish, lower case, dot/dash separated. Immutable once published. */
export const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
/** Plugin id: package-scoped, lower case, dash/underscore separated. */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
/** Adapter id: provider-neutral protocol/engine identity, shared by many source instances. */
export const ADAPTER_ID_PATTERN = PLUGIN_ID_PATTERN;
export const isPackageId = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && PACKAGE_ID_PATTERN.test(value);
export const isPluginId = (value: unknown): value is string => typeof value === 'string' && value.length <= 96 && PLUGIN_ID_PATTERN.test(value);
export const isAdapterId = isPluginId;

/** `1.2.3`, optionally with a prerelease/build suffix. No range syntax here. */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export type Semver = string;
export const isSemver = (value: unknown): value is Semver => typeof value === 'string' && value.length <= 64 && SEMVER_PATTERN.test(value);

/**
 * Lower bound only, which is all a host compatibility declaration needs: `>=1.0.0 <2.0.0`,
 * `>=1.0.0`, or `^1.2.0` / `~1.2.0` normalised at parse time. Deliberately smaller than npm's range
 * grammar so that dependency resolution is checkable without a resolver.
 */
export const VERSION_RANGE_PATTERN = /^(?:\^|~|>=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s+<\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?$/;

export interface VersionRange {
  /** Inclusive lower bound. */
  readonly min: string;
  /** Exclusive upper bound; `null` means unbounded above. */
  readonly maxExclusive: string | null;
}

/** Parses the small range grammar above. Returns `null` for anything unsupported rather than guessing. */
export function parseVersionRange(text: string): VersionRange | null {
  if (typeof text !== 'string' || text.length > 96) return null;
  const trimmed = text.trim();
  if (!VERSION_RANGE_PATTERN.test(trimmed)) return null;
  let min: string | null = null;
  let maxExclusive: string | null = null;
  for (const part of trimmed.split(/\s+/)) {
    const caret = /^\^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(part);
    if (caret) { min = caret[1]!; maxExclusive = caretMajor(caret[1]!); continue; }
    const tilde = /^~(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(part);
    if (tilde) { min = tilde[1]!; maxExclusive = tildeMinor(tilde[1]!); continue; }
    const lower = /^>=(.+)$/.exec(part);
    if (lower) { min = lower[1]!; continue; }
    const upper = /^<(.+)$/.exec(part);
    if (upper) { if (maxExclusive !== null) return null; maxExclusive = upper[1]!; continue; }
    if (/^\d+\.\d+\.\d+/.test(part)) { if (min !== null) return null; min = part; maxExclusive = caretMajor(part); continue; }
    return null;
  }
  return min === null ? null : { min, maxExclusive };
}
const caretMajor = (version: string): string => `${Number(version.split('.')[0]) + 1}.0.0`;
const tildeMinor = (version: string): string => `${version.split('.')[0]}.${Number(version.split('.')[1]) + 1}.0`;

/** Numeric comparison over the numeric core; prerelease ordering is compared textually. */
export function compareVersions(left: string, right: string): number {
  const split = (value: string) => {
    const [core = '0.0.0', rest = ''] = value.split('-', 2);
    return { core: core.split('.').map(part => Number(part) || 0), pre: rest };
  };
  const a = split(left), b = split(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  // A prerelease sorts before its release; two prereleases compare textually, which is enough for the
  // host-compatibility check this exists for.
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

export function satisfiesRange(version: string, range: VersionRange | string): boolean {
  const parsed = typeof range === 'string' ? parseVersionRange(range) : range;
  if (!parsed || !isSemver(version)) return false;
  if (compareVersions(version, parsed.min) < 0) return false;
  return parsed.maxExclusive === null || compareVersions(version, parsed.maxExclusive) < 0;
}

// --- Manifest ------------------------------------------------------------------------------------

/** Host platform requirement. `any` is allowed only for genuinely portable packages. */
export type ManifestPlatform = 'win32' | 'darwin' | 'linux' | 'any';
export type ManifestArch = 'x64' | 'arm64' | 'any';
export type ManifestRuntimeKind = 'node' | 'electron-renderer' | 'worker' | 'browser' | 'external-process';

export interface PlatformRequirement {
  readonly platform: readonly ManifestPlatform[];
  readonly arch: readonly ManifestArch[];
  /** Minimum Node/Electron major the entry was compiled against. */
  readonly runtimeVersion: string;
  /** Extra runtime capability tokens, e.g. `node:worker_threads`. Declarative only. */
  readonly features: readonly string[];
}

/**
 * A resource the package needs. Model weights are registered as references with a readiness check;
 * they are never packed or downloaded (CONTRACTS.md §1, PROVIDERS.md §2).
 */
export interface ResourceRequirement {
  readonly id: string;
  readonly kind: 'model' | 'voice' | 'device' | 'native-module' | 'gpu' | 'disk' | 'network';
  /** Package-relative path or an external locator; never an embedded blob. */
  readonly reference: string;
  readonly required: boolean;
  /** Relative path of a probe script inside the package, or `null` for presence-only checks. */
  readonly readiness: string | null;
  /** True for anything that must not be embedded in the package (weights, devices, GPU runtimes). */
  readonly external: boolean;
}

/**
 * A permission declaration. CONTRACTS.md §2: permissions gate product enablement and device/external
 * actions; they never let configuration text execute a script.
 */
export interface PermissionDeclaration {
  readonly id: 'network' | 'microphone' | 'speaker' | 'screen' | 'filesystem' | 'spawn-process' | 'clipboard' | (string & {});
  readonly scope: string;
  readonly reason: string;
  /** True when the host must ask the user before the permission takes effect. */
  readonly promptsUser: boolean;
}

export interface PackageDependency {
  readonly packageId: string;
  /** Range in the grammar of `parseVersionRange`; an unparsable range is rejected, never ignored. */
  readonly range: string;
  /** Why the dependency exists; recorded so a refusal can name the requester. */
  readonly reason: string;
}

/**
 * One declared file. `hash` is the integrity proof of the import copy and covers exactly the content
 * the host will load. It proves content consistency; it is NOT a signature and NOT a sandbox
 * (CONTRACTS.md §1).
 */
export interface PackageFileEntry {
  /** POSIX-separated path relative to the package root. Absolute paths and `..` are refused. */
  readonly path: string;
  readonly bytes: number;
  /** `sha256-<lowercase hex>`. */
  readonly hash: string;
  readonly role: 'entry' | 'asset' | 'runtime-dependency' | 'documentation' | 'data';
  readonly executable: boolean;
}

export interface PluginEntryDeclaration {
  readonly pluginId: string;
  /** Package-relative POSIX path of the pre-compiled ESM entry. Must appear in `files`. */
  readonly entry: string;
  readonly label: string;
  readonly capabilities: readonly CapabilityDeclaration[];
  /** Plugin ids that must activate first; resolved within the same package. */
  readonly dependsOn: readonly string[];
  /** Metadata-only readiness probe. Never executed during discovery or validation. */
  readonly readinessProbe: string | null;
  /**
   * Named export the loader reads for `PluginActivation`. Defaults to `activation`
   * (`PluginModule.activation`); declared explicitly so a compiled bundle that renames exports does
   * not silently fail to activate.
   */
  readonly activationExport?: string;
  readonly author?: string;
}

/**
 * `manifest.json`, the first-version directory-package format. Root manifest + pre-compiled ESM entry
 * + static assets + in-package runtime dependencies. No build or install script runs at import time:
 * there is no field for one, and an unknown field is a hard rejection.
 */
export interface PackageManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly formatVersion: typeof PACKAGE_FORMAT_VERSION;
  readonly packageId: string;
  readonly version: Semver;
  /** Host API range this package was built against, e.g. `>=1.0.0 <2.0.0`. */
  readonly hostApiRange: string;
  readonly label: string;
  readonly platform: PlatformRequirement;
  readonly plugins: readonly PluginEntryDeclaration[];
  readonly dependencies: readonly PackageDependency[];
  readonly optionalDependencies: readonly PackageDependency[];
  readonly resources: readonly ResourceRequirement[];
  readonly permissions: readonly PermissionDeclaration[];
  readonly files: readonly PackageFileEntry[];
  /** Content digest over the manifest's own normative fields, excluding this field. */
  readonly manifestHash: string;
  readonly publisher?: string;
  readonly license?: string;
  /** Recorded when the package replaces an earlier one; the version stays immutable. */
  readonly deprecated?: string;
}

// --- Validation result ---------------------------------------------------------------------------

/**
 * Stable error categories for package/plugin handling. Deliberately a SEPARATE taxonomy from
 * `ManagementErrorCode` (contracts/management.ts): that union has 38 direct production importers and
 * K65-01 must not add cases to it.
 */
export type PluginErrorCategory =
  | 'schema_version_unsupported'
  | 'manifest_invalid'
  | 'identity_conflict'
  | 'dependency_unsatisfied'
  | 'entry_out_of_bounds'
  | 'reparse_point_rejected'
  | 'hash_mismatch'
  | 'capability_conflict'
  | 'capability_unsupported'
  | 'auth_required_missing'
  | 'unsupported_parameter'
  | 'platform_unsupported'
  | 'lifecycle_violation'
  | 'resource_missing'
  | 'package_forbidden_content'
  | 'boundary_violation';

export const PLUGIN_ERROR_CATEGORIES: readonly PluginErrorCategory[] = [
  'schema_version_unsupported', 'manifest_invalid', 'identity_conflict', 'dependency_unsatisfied',
  'entry_out_of_bounds', 'reparse_point_rejected', 'hash_mismatch', 'capability_conflict',
  'capability_unsupported', 'auth_required_missing', 'unsupported_parameter', 'platform_unsupported',
  'lifecycle_violation', 'resource_missing', 'package_forbidden_content', 'boundary_violation',
];

/** One refusal. `path` locates it in the manifest; `detail` is safe to log and never holds a secret. */
export interface PluginIssue {
  readonly category: PluginErrorCategory;
  readonly path: string;
  readonly detail: string;
}

export class PluginError extends Error {
  readonly category: PluginErrorCategory;
  readonly issues: readonly PluginIssue[];
  constructor(category: PluginErrorCategory, message: string, issues: readonly PluginIssue[] = []) {
    super(message);
    this.name = 'PluginError';
    this.category = category;
    this.issues = issues;
  }
  static from(issues: readonly PluginIssue[], summary: string): PluginError {
    return new PluginError(issues[0]?.category ?? 'manifest_invalid', `${summary}: ${issues.map(issue => `${issue.category} at ${issue.path}`).join('; ')}`, issues);
  }
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly PluginIssue[];
}

export const validationResult = (issues: readonly PluginIssue[]): ValidationResult => ({ ok: issues.length === 0, issues });

// --- Lifecycle -----------------------------------------------------------------------------------

export type PackageLifecycleState =
  | 'not_installed'
  | 'installed_disabled'
  | 'enabled_pending_load'
  | 'loaded'
  | 'failed'
  | 'disabled_pending_restart';

export interface DeactivationReason {
  readonly kind: 'user' | 'dependency' | 'failure' | 'shutdown' | 'update';
  readonly detail: string;
}

/** A handle returned by activation. Dropping it without deactivating is a host-visible leak. */
export interface PluginHandle {
  readonly pluginId: string;
  readonly packageId: string;
  readonly packageVersion: Semver;
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly state: 'active' | 'deactivating' | 'deactivated';
  readonly capabilityIds: readonly string[];
}

/**
 * The scope-limited view a plugin receives. CONTRACTS.md §2: it must not expose core instance private
 * fields, and it must not copy secrets — credentials are reachable only as `credentialRef` strings
 * resolved through `SecretStore`.
 */
export interface HostContext {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly packageId: string;
  readonly pluginId: string;
  /** Package-private data namespace. Nothing outside the package can address it. */
  readonly data: PackageDataNamespace;
  readonly capabilities: HostCapabilityRegistry;
  readonly events: HostEventChannel;
  readonly resources: HostResourceRegistrar;
  readonly config: HostConfigReader;
  readonly secrets: SecretStore;
  readonly log: HostLogger;
  /** The turn this activation belongs to, when activation happens inside one. */
  readonly turn: ExistingTurn | null;
}

export interface PackageDataNamespace {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  list(): Promise<readonly string[]>;
  remove(key: string): Promise<void>;
}

export interface HostCapabilityRegistry {
  /** Registers a declared capability for one adapter. A duplicate identity with different content is refused. */
  register(declaration: CapabilityDeclaration & { readonly provide: CapabilityProviderRef }): void;
  /** Resolves a capability to its candidates. An undeclared dependency is refused, never defaulted. */
  resolve(capabilityId: string, request: CapabilityResolutionRequest): readonly CapabilityProviderRef[];
  readonly registered: readonly CapabilityProviderRef[];
}

export interface CapabilityProviderRef {
  readonly capabilityId: string;
  readonly adapterId: string;
  readonly adapterVersion: Semver;
  readonly pluginId: string;
  readonly packageId: string;
}

export interface CapabilityResolutionRequest {
  /** The declaring plugin must have listed this capability in its own manifest. */
  readonly declaredBy: string;
  /** Explicit binding within the caller's scope; the host never picks by import order. */
  readonly bindingId?: string;
}

/** Scope-limited event channel: a plugin sees only events it declared interest in for its own scope. */
export interface HostEventChannel {
  subscribe(topics: readonly string[], scope: EventScope, handler: (topic: string, payload: unknown) => void): () => void;
  publish(topic: string, payload: unknown, scope: EventScope): void;
}

/** A turn is identified by the whole four-field `TurnScope`, not a 3-field subset (0.6 regression). */
export interface ExistingTurn {
  readonly scope: TurnScopeRef;
  readonly signal: AbortSignal;
}
/** Structural copy of `TurnScope`; the authority stays `contracts/index.ts` and 0.6's 3-field Scope is not repeated. */
export interface TurnScopeRef {
  readonly characterId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly generation: number;
}

export interface EventScope {
  readonly packageId: string;
  readonly turnId: string | null;
  readonly sessionId: string | null;
}

export interface HostResourceRegistrar {
  register(kind: 'timer' | 'listener' | 'process' | 'socket' | 'device' | 'worker' | 'file-handle', id: string, release: () => void | Promise<void>): void;
  release(id: string): Promise<void>;
  readonly outstanding: readonly string[];
}

export interface HostConfigReader {
  /** Package-scoped configuration. Reading config never returns credential contents. */
  get(key: string): unknown;
  keys(): readonly string[];
}

/**
 * D3: `SecretStore` formalises the existing `credentialRegistry()` (management/credentials.ts L10) and
 * `ManagedCredentialStore` (management/credential-store.ts). It exposes existence and resolution only;
 * there is no plaintext read path across the plugin boundary and no secret is ever copied into a
 * manifest, a log line or a `HostContext`.
 */
export interface SecretStore {
  has(ref: string, provider: string): boolean;
  /** `none` sources need no credential at all; this is not an error path. */
  resolve(ref: string, provider: string): { readonly ref: string; readonly provider: string } | null;
  list(): readonly { readonly ref: string; readonly provider: string; readonly status: 'configured' | 'missing' | 'unavailable' }[];
}

export type HostLogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface HostLogger {
  log(level: HostLogLevel, message: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}

/** The object a plugin entry exports. Names are K65-01's; semantics are CONTRACTS.md §2's. */
export interface PluginActivation {
  activate(host: HostContext): PluginHandle | Promise<PluginHandle>;
  deactivate(reason: DeactivationReason): void | Promise<void>;
}

/** The shape the loader looks for on a loaded entry module. */
export interface PluginModule {
  readonly activation: PluginActivation;
}

// --- Host API compatibility ----------------------------------------------------------------------

export interface HostApiCompatibility {
  readonly compatible: boolean;
  readonly required: VersionRange | null;
  readonly issue: PluginIssue | null;
}

/** The host-side check a manifest's `hostApiRange` must pass before anything is loaded. */
export function checkHostApiRange(range: string, hostApiVersion: string = PLUGIN_API_VERSION): HostApiCompatibility {
  const parsed = parseVersionRange(range);
  if (!parsed) {
    return { compatible: false, required: null, issue: { category: 'manifest_invalid', path: 'hostApiRange', detail: `unparsable host API range: ${JSON.stringify(range)}` } };
  }
  if (!satisfiesRange(hostApiVersion, parsed)) {
    return { compatible: false, required: parsed, issue: { category: 'dependency_unsatisfied', path: 'hostApiRange', detail: `host API ${hostApiVersion} does not satisfy ${range}` } };
  }
  return { compatible: true, required: parsed, issue: null };
}

/** Minimum capability categories a package must cover to be a capability package. Empty set = product package. */
export function missingRequiredCategoryCoverage(declarations: readonly CapabilityDeclaration[]): readonly string[] {
  const present = new Set(declarations.map(declaration => declaration.category));
  // Only enforced when the package declares at least one capability: a pure product package may
  // legitimately declare none (K65-01 §1 / RPD-06 §6 "内核 + 普通包").
  if (!present.size) return [];
  return present.has('background_lifecycle') ? [] : ['background_lifecycle'];
}

/** Public SDK surface list, frozen with API v1 and mirrored by the emitted SDK artifact. */
export const PLUGIN_SDK_SURFACE = [
  'AdapterDescriptor', 'SourceInstance', 'ModelProfile', 'Binding', 'ResolvedBinding',
  'CapabilityDeclaration', 'CapabilityId', 'SideEffectCategory',
  'PackageManifest', 'PluginEntryDeclaration', 'PluginHandle', 'PluginActivation', 'HostContext', 'SecretStore',
  'PluginError', 'PluginErrorCategory', 'PluginIssue', 'ValidationResult',
  'validatePackageManifest', 'validateManifestFile', 'validateAdapterDescriptor', 'validateSourceInstance',
  'validateModelProfile', 'validateBinding', 'validateResolvedBinding',
  'buildPackage', 'packageDigest', 'checkImportBoundary', 'emitSdkArtifact',
  'PLUGIN_TIMEOUT_DEFAULTS', 'withTimeout',
] as const;
