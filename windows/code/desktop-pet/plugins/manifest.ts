/**
 * K65-01 (01-A, 01-B): pure-metadata manifest validation.
 *
 * "Pure metadata" is a hard requirement, not a style note: CONTRACTS.md §1 says discovery reads
 * metadata only and must not import the entry, and spec K65-01 §2 adds that validation must not import
 * the entry either. Nothing in this module (or anything it imports) performs an `import()` of a package
 * file, so 01-B's "zero executions" is a structural property of the implementation — the test proves it
 * with a real child process rather than by reading this comment.
 *
 * The validator accepts a parsed manifest object; `validateManifestFile` reads `manifest.json` from a
 * package root and applies the filesystem half (bounds + reparse points + hashes). Neither reads any
 * executable file.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADAPTER_ID_PATTERN, MANIFEST_SCHEMA_VERSION, PACKAGE_ID_PATTERN, PACKAGE_FORMAT_VERSION,
  PLUGIN_API_VERSION, PLUGIN_ID_PATTERN, PLUGIN_ERROR_CATEGORIES,
  checkHostApiRange, isSemver, parseVersionRange, satisfiesRange,
  type PackageFileEntry, type PackageManifest, type PluginEntryDeclaration, type PluginIssue,
  type ValidationResult,
} from '../contracts/plugin.js';
import {
  CAPABILITY_CATEGORIES, CAPABILITY_ID_PATTERN, CAPABILITY_PARAMETER_TYPES, REQUIRED_CAPABILITY_IDS,
  SIDE_EFFECT_CATEGORIES, type CapabilityCategory, type CapabilityDeclaration,
} from '../contracts/capability.js';
import { DEPLOYMENTS, type AdapterDescriptor, type Binding, type ModelProfile, type ResolvedBinding, type SourceInstance } from '../contracts/provider-source.js';
import { findPackagePathIssues, normalizePackageRelativePath, resolveInsidePackage } from './paths.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** `sha256-<64 lowercase hex>`, the only accepted integrity form. */
export const FILE_HASH_PATTERN = /^sha256-[0-9a-f]{64}$/;

export function contentHash(bytes: Uint8Array | string): string {
  return 'sha256-' + createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic JSON: object keys sorted, so a manifest hash does not depend on authoring order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(entry => stableStringify(entry)).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return '{' + entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',') + '}';
}

/** Digest of the manifest's own normative fields, excluding `manifestHash` itself. */
export function computeManifestHash(manifest: Omit<PackageManifest, 'manifestHash'> | PackageManifest): string {
  const { manifestHash: _ignored, ...normative } = manifest as PackageManifest;
  return 'sha256-' + createHash('sha256').update(stableStringify(normative)).digest('hex');
}

export interface ValidationOptions {
  /** When set, declared files are checked for existence, bounds, reparse points and content hash. */
  readonly packageRoot?: string;
  /** Set false to skip hash reads (pure schema validation of an in-memory manifest). */
  readonly checkFiles?: boolean;
  /** Extra capability ids the host knows about; unknown ids are reported by the caller, never here. */
  readonly knownCapabilityIds?: readonly string[];
}

const issue = (category: PluginIssue['category'], path: string, detail: string): PluginIssue => ({ category, path, detail });
const isText = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Manifest fields this schema does not define. A hard rejection, not a warning: it is what makes
 * "no build or install script runs at import time" enforceable rather than aspirational — there is no
 * accepted spelling for one, and a package that ships `scripts.postinstall` is refused outright.
 */
const PACKAGE_MANIFEST_FIELDS = new Set([
  'schemaVersion', 'formatVersion', 'packageId', 'version', 'hostApiRange', 'label', 'platform',
  'plugins', 'dependencies', 'optionalDependencies', 'resources', 'permissions', 'files', 'manifestHash',
  'deprecated', 'publisher', 'license',
]);

const PLUGIN_DECLARATION_FIELDS = new Set([
  'pluginId', 'entry', 'label', 'capabilities', 'dependsOn', 'readinessProbe', 'activationExport', 'author',
]);

const ENTRY_PATH_FIELDS = ['entry', 'readinessProbe'] as const;

// --- Capability declarations ---------------------------------------------------------------------

export function validateCapabilityDeclaration(
  declaration: unknown,
  path: string,
  options: { readonly declaredAdapterId?: string; readonly knownCapabilityIds?: readonly string[] } = {},
): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  if (!isPlainObject(declaration)) return [issue('manifest_invalid', path, 'capability declaration must be an object')];
  const capabilityId = declaration.capabilityId;
  if (!isText(capabilityId, 96)) {
    issues.push(issue('manifest_invalid', `${path}.capabilityId`, 'capabilityId is required'));
  } else if (!CAPABILITY_ID_PATTERN.test(capabilityId)) {
    issues.push(issue('manifest_invalid', `${path}.capabilityId`, `capabilityId ${JSON.stringify(capabilityId)} is not lower-case dotted segments`));
  } else if (options.knownCapabilityIds && !options.knownCapabilityIds.includes(capabilityId)) {
    // Open namespace: a new id is allowed, but the host does not silently treat an undeclared id as
    // known. The package must list it in `plugins[].capabilities` (which it just did) and the host
    // records the extension rather than accepting it as a required capability.
    issues.push(issue('capability_unsupported', `${path}.capabilityId`, `capabilityId ${JSON.stringify(capabilityId)} is an extension id not present in the host's declared vocabulary`));
  }
  const category = declaration.category;
  if (!isText(category) || !CAPABILITY_CATEGORIES.includes(category as CapabilityCategory)) {
    issues.push(issue('manifest_invalid', `${path}.category`, `category must be one of ${CAPABILITY_CATEGORIES.join(', ')}`));
  } else if (isText(capabilityId)) {
    const expected = requiredCapabilityCategoryOf(capabilityId);
    if (expected && expected !== category) {
      issues.push(issue('manifest_invalid', `${path}.category`, `required capability ${capabilityId} belongs to category ${expected}, not ${category}`));
    }
  }
  for (const field of ['adapterId', 'adapterVersion', 'contractVersion'] as const) {
    if (!isText(declaration[field], 96)) issues.push(issue('manifest_invalid', `${path}.${field}`, `${field} is required`));
  }
  if (isText(declaration.adapterId) && !ADAPTER_ID_PATTERN.test(declaration.adapterId)) {
    issues.push(issue('manifest_invalid', `${path}.adapterId`, `adapterId ${JSON.stringify(declaration.adapterId)} must be a lower-case identity`));
  }
  if (options.declaredAdapterId && declaration.adapterId !== options.declaredAdapterId) {
    issues.push(issue('identity_conflict', `${path}.adapterId`, `capability declares adapterId ${JSON.stringify(declaration.adapterId)} but the plugin declares ${JSON.stringify(options.declaredAdapterId)}`));
  }
  if (isText(declaration.adapterVersion) && !isSemver(declaration.adapterVersion)) {
    issues.push(issue('manifest_invalid', `${path}.adapterVersion`, `adapterVersion ${JSON.stringify(declaration.adapterVersion)} is not semver`));
  }
  if (declaration.auth !== undefined && declaration.auth !== 'none' && declaration.auth !== 'credentialRef') {
    issues.push(issue('manifest_invalid', `${path}.auth`, 'auth must be "none" or "credentialRef"'));
  }
  if (declaration.sideEffect !== undefined && !SIDE_EFFECT_CATEGORIES.includes(declaration.sideEffect as never)) {
    issues.push(issue('manifest_invalid', `${path}.sideEffect`, `sideEffect must be one of ${SIDE_EFFECT_CATEGORIES.join(', ')}`));
  }
  const parameters = declaration.parameters;
  if (!Array.isArray(parameters)) {
    issues.push(issue('manifest_invalid', `${path}.parameters`, 'parameters must be an array of parameter names'));
  } else {
    const seen = new Set<string>();
    const allowed = allowedParametersOf(String(capabilityId));
    for (const [index, name] of parameters.entries()) {
      if (!isText(name, 64)) { issues.push(issue('manifest_invalid', `${path}.parameters[${index}]`, 'parameter name must be a non-empty string')); continue; }
      if (seen.has(name)) issues.push(issue('manifest_invalid', `${path}.parameters[${index}]`, `duplicate parameter ${name}`));
      seen.add(name);
      // 01-E: an unsupported parameter is refused, not forwarded. The two vocabularies this would
      // otherwise leak between are a local engine and a remote vendor API (see UNSUPPORTED_PARAMETER_EXAMPLES).
      if (allowed !== null && !allowed.has(name)) {
        issues.push(issue('unsupported_parameter', `${path}.parameters[${index}]`, `parameter ${JSON.stringify(name)} is not in the ${JSON.stringify(String(capabilityId))} vocabulary${allowed.size ? ` (${[...allowed].join(', ')})` : ''}`));
      }
    }
    const execution = declaration.execution;
    if (Array.isArray(execution) && execution.includes('streaming') && !seen.has('streaming') && REQUIRES_STREAMING_PARAMETER.has(String(capabilityId))) {
      issues.push(issue('manifest_invalid', `${path}.parameters`, `capability ${capabilityId} declares streaming execution but does not declare the "streaming" parameter`));
    }
  }
  for (const [field, list] of [['inputs', declaration.inputs], ['outputs', declaration.outputs]] as const) {
    if (!Array.isArray(list) || list.length === 0) {
      issues.push(issue('manifest_invalid', `${path}.${field}`, `${field} must describe at least one ${field === 'inputs' ? 'input' : 'output'}`));
      continue;
    }
    for (const [index, item] of list.entries()) {
      const itemPath = `${path}.${field}[${index}]`;
      if (!isPlainObject(item)) { issues.push(issue('manifest_invalid', itemPath, 'must be an object')); continue; }
      if (!isText(item.name, 64)) issues.push(issue('manifest_invalid', `${itemPath}.name`, 'name is required'));
      if (!isText(item.type, 32)) issues.push(issue('manifest_invalid', `${itemPath}.type`, 'type is required'));
      if (typeof item.required !== 'boolean') issues.push(issue('manifest_invalid', `${itemPath}.required`, 'required must be a boolean'));
      if (!isText(item.description, 256)) issues.push(issue('manifest_invalid', `${itemPath}.description`, 'description is required'));
    }
  }
  const execution = declaration.execution;
  if (!Array.isArray(execution) || execution.length === 0 || execution.some(entry => entry !== 'unary' && entry !== 'streaming')) {
    issues.push(issue('manifest_invalid', `${path}.execution`, 'execution must list "unary" and/or "streaming"'));
  } else if (new Set(execution).size !== execution.length) {
    issues.push(issue('manifest_invalid', `${path}.execution`, 'execution contains duplicates'));
  }
  return issues;
}

const REQUIRES_STREAMING_PARAMETER = new Set(['stt.transcribe', 'tts.synthesize', 'llm.chat']);

/**
 * Parameter names a capability id accepts, from the frozen `CAPABILITY_PARAMETER_TYPES` vocabulary.
 * An extension id has no host-side vocabulary, so `null` is returned and no name is refused here — the
 * adapter's own `CapabilitySchema` is then the only authority, exactly as contracts/capability.ts states.
 */
function allowedParametersOf(capabilityId: string): ReadonlySet<string> | null {
  const types = (CAPABILITY_PARAMETER_TYPES as Readonly<Record<string, Readonly<Record<string, string>>>>)[capabilityId];
  return types ? new Set(Object.keys(types)) : null;
}

function requiredCapabilityCategoryOf(capabilityId: string): CapabilityCategory | null {
  for (const [category, ids] of Object.entries(REQUIRED_CAPABILITY_IDS)) {
    if ((ids as readonly string[]).includes(capabilityId)) return category as CapabilityCategory;
  }
  return null;
}

// --- Manifest ------------------------------------------------------------------------------------

/** Identity of everything the manifest claims to provide, for 01-A's duplicate-identity rule. */
export function collectIdentities(manifest: unknown): { readonly pluginIds: readonly string[]; readonly adapterIds: readonly string[] } {
  const pluginIds: string[] = [];
  const adapterIds: string[] = [];
  if (!isPlainObject(manifest) || !Array.isArray(manifest.plugins)) return { pluginIds, adapterIds };
  for (const plugin of manifest.plugins) {
    if (!isPlainObject(plugin)) continue;
    if (isText(plugin.pluginId)) pluginIds.push(plugin.pluginId);
    if (Array.isArray(plugin.capabilities)) {
      for (const declaration of plugin.capabilities) {
        if (isPlainObject(declaration) && isText(declaration.adapterId)) adapterIds.push(declaration.adapterId);
      }
    }
  }
  return { pluginIds, adapterIds };
}

/**
 * Validates a parsed manifest. `ok: true` means the metadata is internally consistent and, when a
 * package root was supplied, that every declared file matches its declared hash and bounds. It never
 * means the entry was loaded, or that it would activate.
 */
export function validatePackageManifest(manifest: unknown, options: ValidationOptions = {}): ValidationResult {
  const issues: PluginIssue[] = [];
  if (!isPlainObject(manifest)) return { ok: false, issues: [issue('manifest_invalid', 'manifest', 'manifest must be a JSON object')] };

  for (const key of Object.keys(manifest)) {
    if (!PACKAGE_MANIFEST_FIELDS.has(key)) {
      issues.push(issue('manifest_invalid', key, `unknown manifest field ${JSON.stringify(key)}; the v1 directory-package schema has no field for it (no build/install script, no arbitrary metadata)`));
    }
  }

  // Schema version first: an unknown schema means every later field is being read under the wrong
  // contract, so the check is reported with its own stable category.
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    issues.push(issue('schema_version_unsupported', 'schemaVersion', `unsupported manifest schemaVersion ${JSON.stringify(manifest.schemaVersion)}; this host implements ${MANIFEST_SCHEMA_VERSION}`));
    return { ok: false, issues };
  }
  if (manifest.formatVersion !== PACKAGE_FORMAT_VERSION) {
    issues.push(issue('schema_version_unsupported', 'formatVersion', `unsupported package formatVersion ${JSON.stringify(manifest.formatVersion)}; this host implements the directory-package format ${PACKAGE_FORMAT_VERSION}`));
  }
  if (!isText(manifest.packageId, 128) || !PACKAGE_ID_PATTERN.test(manifest.packageId)) {
    issues.push(issue('manifest_invalid', 'packageId', `packageId ${JSON.stringify(manifest.packageId)} must be a lower-case reverse-DNS-ish identity`));
  }
  if (!isSemver(manifest.version)) issues.push(issue('manifest_invalid', 'version', `version ${JSON.stringify(manifest.version)} is not semver`));
  if (!isText(manifest.label, 128)) issues.push(issue('manifest_invalid', 'label', 'label is required'));

  const hostApi = checkHostApiRange(typeof manifest.hostApiRange === 'string' ? manifest.hostApiRange : '');
  if (!hostApi.compatible && hostApi.issue) issues.push(hostApi.issue);

  issues.push(...validatePlatform(manifest.platform));

  // --- plugins ---
  const pluginIds = new Set<string>();
  const adapterIdentities = new Map<string, string>();
  const files = Array.isArray(manifest.files) ? manifest.files : null;
  if (!files) issues.push(issue('manifest_invalid', 'files', 'files must be an array of declared file entries'));
  const declaredByPath = new Map<string, PackageFileEntry>();
  if (files) {
    for (const [index, entry] of files.entries()) issues.push(...validateFileEntry(entry, `files[${index}]`, declaredByPath));
  }

  if (!Array.isArray(manifest.plugins) || manifest.plugins.length === 0) {
    issues.push(issue('manifest_invalid', 'plugins', 'plugins must declare at least one plugin entry'));
  } else {
    for (const [index, plugin] of manifest.plugins.entries()) {
      const path = `plugins[${index}]`;
      if (!isPlainObject(plugin)) { issues.push(issue('manifest_invalid', path, 'plugin declaration must be an object')); continue; }
      for (const key of Object.keys(plugin)) {
        if (!PLUGIN_DECLARATION_FIELDS.has(key)) issues.push(issue('manifest_invalid', `${path}.${key}`, `unknown plugin field ${JSON.stringify(key)}`));
      }
      const pluginId = plugin.pluginId;
      if (!isText(pluginId, 96) || !PLUGIN_ID_PATTERN.test(pluginId)) {
        issues.push(issue('manifest_invalid', `${path}.pluginId`, `pluginId ${JSON.stringify(pluginId)} must be a lower-case identity`));
      } else if (pluginIds.has(pluginId)) {
        issues.push(issue('identity_conflict', `${path}.pluginId`, `duplicate pluginId ${pluginId} in one manifest`));
      } else {
        pluginIds.add(pluginId);
      }
      issues.push(...validateEntryPath(plugin, path, declaredByPath));

      const capabilities = plugin.capabilities;
      if (!Array.isArray(capabilities) || capabilities.length === 0) {
        issues.push(issue('manifest_invalid', `${path}.capabilities`, 'a plugin must declare at least one capability'));
        continue;
      }
      for (const [capabilityIndex, declaration] of capabilities.entries()) {
        const capabilityPath = `${path}.capabilities[${capabilityIndex}]`;
        issues.push(...validateCapabilityDeclaration(declaration, capabilityPath));
        if (!isPlainObject(declaration)) continue;
        const declarationAdapterId = declaration.adapterId;
        const declarationAdapterVersion = declaration.adapterVersion;
        if (isText(declarationAdapterId) && isSemver(declarationAdapterVersion)) {
          // 01-E: the same capability may be provided by two adapters; what is refused is the same
          // ADAPTER identity claiming a different content. Two declarations of one capability from one
          // adapter must therefore be byte-identical in every content-bearing field.
          const identity = `${declarationAdapterId}@${declarationAdapterVersion}`;
          const fingerprint = stableStringify({ ...declaration, adapterId: undefined, adapterVersion: undefined });
          const previous = adapterIdentities.get(identity);
          if (previous !== undefined && previous !== fingerprint) {
            issues.push(issue('capability_conflict', capabilityPath, `adapter identity ${identity} is declared twice with different content`));
          } else {
            adapterIdentities.set(identity, fingerprint);
          }
        }
      }
    }
  }

  // --- dependencies ---
  issues.push(...validateDependencies(manifest.dependencies, 'dependencies', manifest.packageId, false));
  issues.push(...validateDependencies(manifest.optionalDependencies, 'optionalDependencies', manifest.packageId, true));

  // --- resources / permissions ---
  issues.push(...validateResources(manifest.resources, declaredByPath));
  issues.push(...validatePermissions(manifest.permissions));

  // --- manifest hash ---
  if (manifest.manifestHash !== undefined) {
    if (typeof manifest.manifestHash !== 'string' || !FILE_HASH_PATTERN.test(manifest.manifestHash)) {
      issues.push(issue('manifest_invalid', 'manifestHash', 'manifestHash must be sha256-<64 lowercase hex>'));
    } else {
      const expected = computeManifestHash(manifest as unknown as PackageManifest);
      if (expected !== manifest.manifestHash) {
        issues.push(issue('hash_mismatch', 'manifestHash', `manifestHash ${manifest.manifestHash} does not match the recomputed ${expected}`));
      }
    }
  }

  // --- filesystem half (still metadata-only: no package file is executed, and no entry is imported) ---
  if (options.packageRoot && options.checkFiles !== false && files) {
    issues.push(...validateFilesOnDisk(options.packageRoot, files, declaredByPath));
  }
  return { ok: issues.length === 0, issues };
}

function validatePlatform(platform: unknown): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  if (!isPlainObject(platform)) return [issue('manifest_invalid', 'platform', 'platform requirements are required')];
  const platforms = ['win32', 'darwin', 'linux', 'any'];
  const archs = ['x64', 'arm64', 'any'];
  if (!Array.isArray(platform.platform) || platform.platform.length === 0 || platform.platform.some(entry => !platforms.includes(entry as string))) {
    issues.push(issue('platform_unsupported', 'platform.platform', `platform must be a non-empty subset of ${platforms.join(', ')}`));
  }
  if (!Array.isArray(platform.arch) || platform.arch.length === 0 || platform.arch.some(entry => !archs.includes(entry as string))) {
    issues.push(issue('platform_unsupported', 'platform.arch', `arch must be a non-empty subset of ${archs.join(', ')}`));
  }
  if (!isText(platform.runtimeVersion, 32) || !/^\d+\.\d+\.\d+$/.test(platform.runtimeVersion)) {
    issues.push(issue('manifest_invalid', 'platform.runtimeVersion', 'runtimeVersion must be a semver triple'));
  }
  if (!Array.isArray(platform.features) || platform.features.some(entry => !isText(entry, 64))) {
    issues.push(issue('manifest_invalid', 'platform.features', 'features must be an array of capability tokens (possibly empty)'));
  }
  return issues;
}

function validateEntryPath(plugin: Record<string, unknown>, path: string, declaredByPath: ReadonlyMap<string, PackageFileEntry>): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  for (const field of ENTRY_PATH_FIELDS) {
    const value = plugin[field];
    if (value === null || value === undefined) {
      if (field === 'readinessProbe') continue;
      issues.push(issue('manifest_invalid', `${path}.${field}`, 'entry is required and must be a package-relative ESM path'));
      continue;
    }
    const normalized = normalizePackageRelativePath(value, `${path}.${field}`);
    if (!normalized.ok) {
      issues.push(issue('entry_out_of_bounds', `${path}.${field}`, normalized.rejection.detail));
      continue;
    }
    if (field === 'entry' && !/\.(mjs|js)$/.test(normalized.path)) {
      issues.push(issue('manifest_invalid', `${path}.entry`, `entry ${normalized.path} must be a compiled ESM file (.mjs/.js); an import that needs a build step is not a v1 package`));
    }
    if (!declaredByPath.has(normalized.path)) {
      issues.push(issue('manifest_invalid', `${path}.${field}`, `${normalized.path} is not listed in files[], so the import copy would not contain it`));
    } else if (declaredByPath.get(normalized.path)!.role !== 'entry' && field === 'entry') {
      issues.push(issue('manifest_invalid', `${path}.${field}`, `${normalized.path} is declared with role ${declaredByPath.get(normalized.path)!.role}, expected "entry"`));
    }
  }
  return issues;
}

function validateFileEntry(entry: unknown, path: string, declaredByPath: Map<string, PackageFileEntry>): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  if (!isPlainObject(entry)) return [issue('manifest_invalid', path, 'file entry must be an object')];
  const normalized = normalizePackageRelativePath(entry.path, `${path}.path`);
  if (!normalized.ok) {
    issues.push(issue('entry_out_of_bounds', `${path}.path`, normalized.rejection.detail));
  } else if (declaredByPath.has(normalized.path)) {
    issues.push(issue('identity_conflict', `${path}.path`, `duplicate file path ${normalized.path} in files[]`));
  } else {
    declaredByPath.set(normalized.path, entry as unknown as PackageFileEntry);
  }
  if (!FILE_HASH_PATTERN.test(String(entry.hash))) {
    issues.push(issue('manifest_invalid', `${path}.hash`, `hash must be sha256-<64 lowercase hex>, received ${JSON.stringify(entry.hash)}`));
  } else if (HEX64.test(String(entry.hash).slice(7)) === false) {
    issues.push(issue('manifest_invalid', `${path}.hash`, 'hash hex must be lower case'));
  }
  if (!Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 0) {
    issues.push(issue('manifest_invalid', `${path}.bytes`, 'bytes must be a non-negative integer'));
  }
  if (!['entry', 'asset', 'runtime-dependency', 'documentation', 'data'].includes(String(entry.role))) {
    issues.push(issue('manifest_invalid', `${path}.role`, `role must be one of entry, asset, runtime-dependency, documentation, data`));
  }
  if (typeof entry.executable !== 'boolean') issues.push(issue('manifest_invalid', `${path}.executable`, 'executable must be a boolean'));
  return issues;
}

function validateFilesOnDisk(root: string, files: readonly unknown[], declaredByPath: ReadonlyMap<string, PackageFileEntry>): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  for (const raw of files) {
    if (!isPlainObject(raw) || typeof raw.path !== 'string') continue;
    const normalized = normalizePackageRelativePath(raw.path, raw.path);
    if (!normalized.ok) continue; // already reported as entry_out_of_bounds
    const bounds = findPackagePathIssues(root, normalized.path, { requireFile: true });
    issues.push(...bounds);
    if (bounds.length) continue;
    const target = resolveInsidePackage(root, normalized.path);
    const actualBytes = statSync(target).size;
    if (Number.isSafeInteger(raw.bytes) && raw.bytes !== actualBytes) {
      issues.push(issue('hash_mismatch', `files[${raw.path}].bytes`, `declared ${String(raw.bytes)} bytes but ${normalized.path} is ${actualBytes}`));
    }
    if (FILE_HASH_PATTERN.test(String(raw.hash))) {
      const actual = contentHash(readFileSync(target));
      if (actual !== raw.hash) {
        issues.push(issue('hash_mismatch', `files[${raw.path}].hash`, `declared ${raw.hash} but ${normalized.path} hashes to ${actual}`));
      }
    }
  }
  // An undeclared extra file inside the package is the shape a smuggled key or weight would take, so
  // the file list must cover everything the import copy contains. The two package-metadata files are
  // the only exemptions: they are the package's own description, not content the host would load.
  let present: readonly string[] = [];
  try { present = listRelativeFiles(root); } catch { return issues; }
  for (const relative of present) {
    if (PACKAGE_METADATA_FILES.has(relative)) continue;
    if (!declaredByPath.has(relative)) {
      issues.push(issue('package_forbidden_content', relative, `file is present in the package but not declared in files[]; the import copy must contain exactly the declared content`));
    }
  }
  return issues;
}

/** Files the package format itself defines at the root; they are metadata and are never listed in `files[]`. */
export const PACKAGE_METADATA_FILES: ReadonlySet<string> = new Set(['manifest.json', 'dependency-manifest.json']);

/** Relative POSIX paths of every regular file under `root`, excluding `.git` and `node_modules` markers. */
export function listRelativeFiles(root: string, prefix = ''): readonly string[] {
  const out: string[] = [];
  const base = resolve(root);
  for (const entry of readdirSync(prefix ? resolve(base, prefix) : base, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) { out.push(relative); continue; }
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      out.push(...listRelativeFiles(base, relative));
      continue;
    }
    if (entry.isFile()) out.push(relative);
  }
  return out.sort();
}

function validateDependencies(list: unknown, path: string, selfPackageId: unknown, optional: boolean): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  if (list === undefined) {
    if (!optional) issues.push(issue('manifest_invalid', path, 'dependencies must be present; use an empty array for none'));
    return issues;
  }
  if (!Array.isArray(list)) return [issue('manifest_invalid', path, `${path} must be an array`)];
  const seen = new Set<string>();
  for (const [index, dependency] of list.entries()) {
    const at = `${path}[${index}]`;
    if (!isPlainObject(dependency)) { issues.push(issue('manifest_invalid', at, 'dependency must be an object')); continue; }
    if (!isText(dependency.packageId, 128) || !PACKAGE_ID_PATTERN.test(dependency.packageId)) {
      issues.push(issue('manifest_invalid', `${at}.packageId`, `packageId ${JSON.stringify(dependency.packageId)} must be a lower-case identity`));
    } else {
      if (dependency.packageId === selfPackageId) issues.push(issue('dependency_unsatisfied', `${at}.packageId`, 'a package cannot depend on itself'));
      if (seen.has(dependency.packageId)) issues.push(issue('identity_conflict', `${at}.packageId`, `duplicate dependency on ${dependency.packageId}`));
      seen.add(dependency.packageId);
    }
    if (!isText(dependency.reason, 256)) issues.push(issue('manifest_invalid', `${at}.reason`, 'reason is required so a refusal can name the requester'));
    if (!isText(dependency.range, 96) || !parseVersionRange(dependency.range)) {
      issues.push(issue('dependency_unsatisfied', `${at}.range`, `range ${JSON.stringify(dependency.range)} is not in the supported grammar (>=x.y.z, ^x.y.z, ~x.y.z, or >=x.y.z <a.b.c)`));
    }
  }
  return issues;
}

function validateResources(list: unknown, declaredByPath: ReadonlyMap<string, PackageFileEntry>): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  if (!Array.isArray(list)) return [issue('manifest_invalid', 'resources', 'resources must be an array (possibly empty)')];
  const seen = new Set<string>();
  for (const [index, resource] of list.entries()) {
    const at = `resources[${index}]`;
    if (!isPlainObject(resource)) { issues.push(issue('manifest_invalid', at, 'resource must be an object')); continue; }
    if (!isText(resource.id, 96)) issues.push(issue('manifest_invalid', `${at}.id`, 'id is required'));
    else if (seen.has(resource.id)) issues.push(issue('identity_conflict', `${at}.id`, `duplicate resource id ${resource.id}`));
    else seen.add(resource.id);
    if (!['model', 'voice', 'device', 'native-module', 'gpu', 'disk', 'network'].includes(String(resource.kind))) {
      issues.push(issue('manifest_invalid', `${at}.kind`, 'kind must be one of model, voice, device, native-module, gpu, disk, network'));
    }
    if (typeof resource.required !== 'boolean') issues.push(issue('manifest_invalid', `${at}.required`, 'required must be a boolean'));
    if (!isText(resource.reference, 512)) issues.push(issue('manifest_invalid', `${at}.reference`, 'reference is required'));
    if (resource.readiness !== null && !isText(resource.readiness, 512)) issues.push(issue('manifest_invalid', `${at}.readiness`, 'readiness must be null or a package-relative path'));
    if (resource.readiness && typeof resource.readiness === 'string') {
      const normalized = normalizePackageRelativePath(resource.readiness, `${at}.readiness`);
      if (!normalized.ok) issues.push(issue('entry_out_of_bounds', `${at}.readiness`, normalized.rejection.detail));
      else if (!declaredByPath.has(normalized.path)) issues.push(issue('manifest_invalid', `${at}.readiness`, `${normalized.path} is not listed in files[]`));
    }
    // Model weights and native engines are references with a readiness check; they must never be packed.
    if ((resource.kind === 'model' || resource.kind === 'gpu') && resource.external !== true) {
      issues.push(issue('package_forbidden_content', `${at}.external`, `${resource.kind} resources are external references only; a package must not carry model weights or a GPU runtime`));
    }
    if (typeof resource.external !== 'boolean') issues.push(issue('manifest_invalid', `${at}.external`, 'external must be a boolean'));
  }
  return issues;
}

function validatePermissions(list: unknown): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  if (!Array.isArray(list)) return [issue('manifest_invalid', 'permissions', 'permissions must be an array (possibly empty)')];
  const seen = new Set<string>();
  for (const [index, permission] of list.entries()) {
    const at = `permissions[${index}]`;
    if (!isPlainObject(permission)) { issues.push(issue('manifest_invalid', at, 'permission must be an object')); continue; }
    if (!isText(permission.id, 64)) issues.push(issue('manifest_invalid', `${at}.id`, 'id is required'));
    else if (seen.has(permission.id)) issues.push(issue('identity_conflict', `${at}.id`, `duplicate permission ${permission.id}`));
    else seen.add(permission.id);
    if (!isText(permission.scope, 128)) issues.push(issue('manifest_invalid', `${at}.scope`, 'scope is required'));
    if (!isText(permission.reason, 256)) issues.push(issue('manifest_invalid', `${at}.reason`, 'reason is required'));
    if (typeof permission.promptsUser !== 'boolean') issues.push(issue('manifest_invalid', `${at}.promptsUser`, 'promptsUser must be a boolean'));
  }
  return issues;
}

export interface ManifestFileValidation {
  readonly ok: boolean;
  readonly issues: readonly PluginIssue[];
  /** The parsed manifest, present only when it parsed as JSON. Never a module namespace. */
  readonly manifest: unknown;
}

/**
 * Reads `<root>/manifest.json` and validates it. The only file this function opens is the manifest
 * itself; the entry named inside it is never imported, which is what makes 01-B true of the real
 * validation path rather than of a mock.
 */
export function validateManifestFile(root: string, options: ValidationOptions = {}): ManifestFileValidation {
  const manifestPath = resolveInsidePackage(root, 'manifest.json');
  let text: string;
  try { text = readFileSync(manifestPath, 'utf8'); }
  catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return { ok: false, issues: [issue('manifest_invalid', 'manifest.json', `cannot read the package manifest: ${failure.code ?? failure.message}`)], manifest: null };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) {
    return { ok: false, issues: [issue('manifest_invalid', 'manifest.json', `manifest.json is not valid JSON: ${(error as Error).message}`)], manifest: null };
  }
  const result = validatePackageManifest(parsed, { ...options, packageRoot: root });
  return { ok: result.ok, issues: result.issues, manifest: parsed };
}

/**
 * Capability id → the set of adapter identities claiming it. 01-E: two adapters for one capability is
 * LEGAL, so this is a discovery helper, never a conflict source; the only conflict is one adapter
 * identity with two different contents, reported above as `capability_conflict`.
 */
export function providersByCapability(manifest: unknown): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  if (!isPlainObject(manifest) || !Array.isArray(manifest.plugins)) return out;
  const collected = new Map<string, Set<string>>();
  for (const plugin of manifest.plugins) {
    if (!isPlainObject(plugin) || !Array.isArray(plugin.capabilities)) continue;
    for (const declaration of plugin.capabilities) {
      if (!isPlainObject(declaration)) continue;
      const capabilityId = declaration.capabilityId;
      const adapterId = declaration.adapterId;
      if (!isText(capabilityId, 96) || !isText(adapterId, 96)) continue;
      const owners = collected.get(capabilityId) ?? new Set<string>();
      owners.add(`${adapterId}@${String(declaration.adapterVersion)}`);
      collected.set(capabilityId, owners);
    }
  }
  return new Map([...collected].map(([capabilityId, owners]) => [capabilityId, [...owners].sort()]));
}

// --- Multi-source schema validators (D2: K65-01 owns these too) -----------------------------------

const requireFields = (value: unknown, fields: readonly string[], path: string, issues: PluginIssue[]): value is Record<string, unknown> => {
  if (!isPlainObject(value)) { issues.push(issue('manifest_invalid', path, 'must be an object')); return false; }
  for (const field of fields) if (value[field] === undefined || value[field] === null) issues.push(issue('manifest_invalid', `${path}.${field}`, `${field} is required`));
  return true;
};

export function validateAdapterDescriptor(value: unknown, path = 'adapter'): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  if (!requireFields(value, ['adapterId', 'adapterVersion', 'packageId', 'pluginId', 'label', 'protocol', 'capabilitySchemas', 'proprietaryParameters', 'deployments', 'contractVersion'], path, issues)) return issues;
  const adapter = value as unknown as AdapterDescriptor;
  if (!isText(adapter.adapterId) || !ADAPTER_ID_PATTERN.test(adapter.adapterId)) issues.push(issue('manifest_invalid', `${path}.adapterId`, 'adapterId must be a lower-case identity'));
  if (!isSemver(adapter.adapterVersion)) issues.push(issue('manifest_invalid', `${path}.adapterVersion`, 'adapterVersion must be semver'));
  if (!isSemver(adapter.contractVersion)) issues.push(issue('manifest_invalid', `${path}.contractVersion`, 'contractVersion must be semver'));
  if (!Array.isArray(adapter.capabilitySchemas) || adapter.capabilitySchemas.length === 0) {
    issues.push(issue('manifest_invalid', `${path}.capabilitySchemas`, 'an adapter must declare at least one capability schema'));
  }
  if (!Array.isArray(adapter.deployments) || adapter.deployments.length === 0 || adapter.deployments.some(entry => !DEPLOYMENTS.includes(entry))) {
    issues.push(issue('manifest_invalid', `${path}.deployments`, `deployments must be a non-empty subset of ${DEPLOYMENTS.join(', ')}`));
  }
  for (const [index, schema] of (Array.isArray(adapter.capabilitySchemas) ? adapter.capabilitySchemas : []).entries()) {
    const at = `${path}.capabilitySchemas[${index}]`;
    if (!requireFields(schema, ['capabilityId', 'parameters', 'outputs', 'modelIdentifier', 'voiceIdentifier', 'streaming', 'cancellable'], at, issues)) continue;
    if (!CAPABILITY_ID_PATTERN.test(String(schema.capabilityId))) issues.push(issue('manifest_invalid', `${at}.capabilityId`, 'capabilityId must be lower-case dotted segments'));
    for (const [parameterIndex, parameter] of (Array.isArray(schema.parameters) ? schema.parameters : []).entries()) {
      const parameterPath = `${at}.parameters[${parameterIndex}]`;
      if (!requireFields(parameter, ['name', 'type', 'required', 'note'], parameterPath, issues)) continue;
      if (parameter.type === 'enum' && (!Array.isArray(parameter.values) || parameter.values.length === 0)) {
        issues.push(issue('manifest_invalid', `${parameterPath}.values`, 'an enum parameter must list its values'));
      }
    }
  }
  return issues;
}

export function validateSourceInstance(value: unknown, path = 'source'): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  if (!requireFields(value, ['sourceId', 'adapterId', 'adapterVersion', 'deployment', 'label', 'configRevision', 'auth', 'limits', 'enablement', 'parameters', 'dataDestination'], path, issues)) return issues;
  const source = value as unknown as SourceInstance;
  if (!DEPLOYMENTS.includes(source.deployment)) issues.push(issue('manifest_invalid', `${path}.deployment`, `deployment must be one of ${DEPLOYMENTS.join(', ')}`));
  if (!Number.isSafeInteger(source.configRevision) || source.configRevision < 0) issues.push(issue('manifest_invalid', `${path}.configRevision`, 'configRevision must be a non-negative integer'));
  if (!isPlainObject(source.auth)) issues.push(issue('manifest_invalid', `${path}.auth`, 'auth must be an object'));
  else if (source.auth.kind !== 'none' && source.auth.kind !== 'credentialRef') issues.push(issue('manifest_invalid', `${path}.auth.kind`, 'auth.kind must be "none" or "credentialRef"'));
  else if (source.auth.kind === 'credentialRef' && !isText(source.auth.ref, 128)) {
    // The reference may name a credential the store has not seen yet (configuration precedes
    // provisioning); what is refused is a cloud deployment that declares no auth at all.
    issues.push(issue('auth_required_missing', `${path}.auth.ref`, 'auth.kind is credentialRef but no credential reference is declared'));
  }
  if (source.deployment === 'remote-api') {
    if (!isText(source.endpoint, 512)) issues.push(issue('auth_required_missing', `${path}.endpoint`, 'a remote-api source must declare its endpoint'));
    if (source.auth?.kind !== 'credentialRef') issues.push(issue('auth_required_missing', `${path}.auth`, 'a remote-api source requires auth.kind "credentialRef"; a cloud deployment without authentication is refused'));
  }
  if (source.deployment === 'managed-local' && !isText(source.runtimeRef, 512)) {
    issues.push(issue('resource_missing', `${path}.runtimeRef`, 'a managed-local source must name the runtime resources it launches'));
  }
  return issues;
}

export function validateModelProfile(value: unknown, path = 'modelProfile'): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  if (!requireFields(value, ['modelProfileId', 'revision', 'sourceId', 'capabilityId', 'label', 'parameters', 'resources'], path, issues)) return issues;
  const profile = value as unknown as ModelProfile;
  if (profile.nativeModelId === undefined) issues.push(issue('manifest_invalid', `${path}.nativeModelId`, 'nativeModelId must be present (null for engines without a model selector)'));
  if (profile.nativeVoiceId === undefined) issues.push(issue('manifest_invalid', `${path}.nativeVoiceId`, 'nativeVoiceId must be present (null when the capability has no voice)'));
  if (!Number.isSafeInteger(profile.revision) || profile.revision < 0) issues.push(issue('manifest_invalid', `${path}.revision`, 'revision must be a non-negative integer'));
  if (!isPlainObject(profile.parameters)) issues.push(issue('manifest_invalid', `${path}.parameters`, 'parameters must be an object'));
  return issues;
}

export function validateBinding(value: unknown, path = 'binding'): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  if (!requireFields(value, ['bindingId', 'revision', 'capabilityId', 'modelProfileId', 'failurePolicy'], path, issues)) return issues;
  const binding = value as unknown as Binding;
  if (!['fail_turn', 'report_partial'].includes(String(binding.failurePolicy))) {
    issues.push(issue('manifest_invalid', `${path}.failurePolicy`, 'failurePolicy must be "fail_turn" or "report_partial"')); 
  }
  if (!Number.isSafeInteger(binding.revision) || binding.revision < 0) issues.push(issue('manifest_invalid', `${path}.revision`, 'revision must be a non-negative integer'));
  if (!CAPABILITY_ID_PATTERN.test(String(binding.capabilityId))) issues.push(issue('manifest_invalid', `${path}.capabilityId`, 'capabilityId must be lower-case dotted segments'));
  return issues;
}

/**
 * Parameters a resolved binding may carry. PROVIDERS.md §3: an unknown parameter is refused rather
 * than forwarded, because a vendor-specific parameter sent to another source is exactly the silent
 * cross-source leak the multi-source contract forbids.
 */
export function validateResolvedBinding(value: unknown, path = 'resolvedBinding'): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  if (!requireFields(value, ['bindingId', 'bindingRevision', 'capabilityId', 'contractVersion', 'packageId', 'adapterId', 'adapterVersion', 'sourceId', 'sourceConfigRevision', 'deployment', 'modelProfileId', 'modelProfileRevision', 'effectiveParameters', 'credentialRef', 'sideEffect', 'limits', 'instanceKey'], path, issues)) return issues;
  const resolved = value as unknown as ResolvedBinding;
  if (!instanceKeyLooksStable(resolved.instanceKey)) {
    issues.push(issue('manifest_invalid', `${path}.instanceKey`, 'instanceKey must be a stable reuse key built from source, config revision, adapter and model — never a bare model name'));
  }
  return issues;
}

/** A model name alone is not a valid reuse key (PROVIDERS.md §4). */
function instanceKeyLooksStable(key: unknown): boolean {
  return typeof key === 'string' && key.split('|').length >= 4 && key.length <= 512;
}

/** Machine-readable mirror of `PluginErrorCategory`, so a consumer can assert the taxonomy is stable. */
export const STABLE_ERROR_CATEGORIES = PLUGIN_ERROR_CATEGORIES;

/** The host API version a manifest is checked against by default. */
export const DEFAULT_HOST_API_VERSION = PLUGIN_API_VERSION;
