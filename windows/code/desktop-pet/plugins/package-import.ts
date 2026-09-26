/**
 * K65-01 · spec §1「导入复制到宿主管理目录、校验后原子登记」and 01-F: the host-side directory-package
 * import. The registry data structure (PackageRegistry / InstalledPackageRecord) is K65-01's delivery;
 * discovery of installed packages and load execution belong to K65-02, so this module NEVER imports a
 * package entry and never runs anything — it validates metadata and copies files only.
 *
 * Ordering is the safety property: validate first, copy second, register third. A refused import
 * performs zero writes into the host tree; an accepted import lands as a fully validated directory
 * that is registered with one atomic rename of its registry file, so a crash can leave the host with
 * an unregistered copy (harmless, re-importable) but never a registry entry without content.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PackageManifest, PluginIssue } from '../contracts/plugin.js';
import { validateManifestFile } from './manifest.js';
import { isForbiddenContent } from './package-build.js';
import { normalizePackageRelativePath } from './paths.js';

/** Schema of `registry.json`, the host-managed record of installed directory packages. */
export const PACKAGE_REGISTRY_SCHEMA_VERSION = 1 as const;

export interface InstalledPackageRecord {
  readonly packageId: string;
  readonly version: string;
  readonly manifestHash: string;
  /** Host-root-relative POSIX directory of the installed copy, e.g. `packages/com.a.b-1.0.0-<8hex>`. */
  readonly installedDirectory: string;
  readonly installedAtEpochSeconds: number | null;
  /** Identity of the source directory at import time: content address, not a timestamp. */
  readonly sourceDigest: string;
}

export interface PackageRegistry {
  readonly schemaVersion: typeof PACKAGE_REGISTRY_SCHEMA_VERSION;
  readonly packages: InstalledPackageRecord[];
}

export interface ImportPackageRequest {
  /** Absolute directory of the source package (must contain its own manifest.json). */
  readonly sourceRoot: string;
  /** Absolute host-managed root; `packages/` and `packages/registry.json` live under it. */
  readonly hostRoot: string;
  /** Injected seconds since the epoch; defaults to null, which keeps the record deterministic. */
  readonly nowEpochSeconds?: number;
}

export interface ImportPackageResult {
  readonly ok: boolean;
  readonly issues: readonly PluginIssue[];
  readonly record: InstalledPackageRecord | null;
}

const issue = (category: PluginIssue['category'], path: string, detail: string): PluginIssue => ({ category, path, detail });
const invalid = (path: string, detail: string): PluginIssue => issue('manifest_invalid', path, detail);

/** The registry file inside the host-managed tree. */
export function packageRegistryPath(hostRoot: string): string {
  return resolve(hostRoot, 'packages', 'registry.json');
}

/**
 * Reads the host registry. A missing file is an empty registry; an unparsable or wrong-schema file is
 * an error the caller must surface — an unreadable registry is never silently replaced, because that
 * would launder a lost record behind the operator's back.
 */
export function readPackageRegistry(hostRoot: string): { ok: true; registry: PackageRegistry } | { ok: false; issue: PluginIssue } {
  const path = packageRegistryPath(hostRoot);
  if (!existsSync(path)) return { ok: true, registry: { schemaVersion: PACKAGE_REGISTRY_SCHEMA_VERSION, packages: [] } };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { return { ok: false, issue: invalid('packages/registry.json', `registry.json is not valid JSON: ${(error as Error).message}`) }; }
  const registry = parsed as PackageRegistry;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) || registry.schemaVersion !== PACKAGE_REGISTRY_SCHEMA_VERSION || !Array.isArray(registry.packages)) {
    return { ok: false, issue: invalid('packages/registry.json', `registry.json is not a v${PACKAGE_REGISTRY_SCHEMA_VERSION} package registry`) };
  }
  return { ok: true, registry };
}

/**
 * Imports one directory package: validate → copy → register. The source directory is never mutated.
 */
export function importPackage(request: ImportPackageRequest): ImportPackageResult {
  const sourceRoot = resolve(request.sourceRoot);
  const hostRoot = resolve(request.hostRoot);

  // --- 1. validate (metadata only; nothing has been written yet) ------------------------------------
  const validation = validateManifestFile(sourceRoot);
  if (!validation.ok) return { ok: false, issues: validation.issues, record: null };
  const manifest = validation.manifest as PackageManifest;

  // Forbidden content gets a second, independent gate here: an authored manifest may have declared
  // the file honestly, and the import copy is the host's own responsibility.
  const forbidden = manifest.files.filter(file => isForbiddenContent(file.path));
  if (forbidden.length) {
    return {
      ok: false,
      issues: forbidden.map(file => issue('package_forbidden_content', `files[${file.path}].path`, `refusing to import ${file.path}: a private key or a model weight must never enter the host-managed tree`)),
      record: null,
    };
  }

  const registryRead = readPackageRegistry(hostRoot);
  if (!registryRead.ok) return { ok: false, issues: [registryRead.issue], record: null };
  const registry = registryRead.registry;

  const manifestBytes = readFileSync(resolve(sourceRoot, 'manifest.json'));
  const digest = createHash('sha256');
  digest.update(manifest.manifestHash);
  for (const file of manifest.files) digest.update(`${file.path}\0${file.hash}\0${file.bytes}\n`);
  const sourceDigest = 'sha256-' + digest.digest('hex');

  const existing = registry.packages.find(entry => entry.packageId === manifest.packageId && entry.version === manifest.version);
  if (existing) {
    // Same identity already registered: identical content is an idempotent no-op, different content
    // is refused — a published version is immutable.
    if (existing.sourceDigest === sourceDigest) {
      return { ok: true, issues: [], record: existing };
    }
    return {
      ok: false,
      issues: [issue('identity_conflict', 'packageId', `${manifest.packageId}@${manifest.version} is already installed with different content (${existing.manifestHash}); a version is immutable, publish a new version instead`)],
      record: null,
    };
  }

  // --- 2. copy into staging, then move into place -----------------------------------------------------
  const packagesRoot = resolve(hostRoot, 'packages');
  const staging = resolve(packagesRoot, `.staging-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const installDirectory = `packages/${manifest.packageId}-${manifest.version}-${sourceDigest.slice(7, 15)}`;
  const destination = resolve(hostRoot, ...installDirectory.split('/'));
  const collisions = collisionIssues(sourceRoot, manifest);
  if (collisions.length) return { ok: false, issues: collisions, record: null };

  try {
    mkdirSync(packagesRoot, { recursive: true });
    if (existsSync(destination)) {
      return { ok: false, issues: [issue('identity_conflict', 'installedDirectory', `install directory ${installDirectory} already exists`)], record: null };
    }
    mkdirSync(staging, { recursive: true });
    // Files first (only declared content), then the manifest: an interrupted copy inside staging is
    // caught by the finally-cleanup, never half-landed in the install directory.
    for (const file of manifest.files) {
      copyFileSync(resolve(sourceRoot, ...file.path.split('/')), resolve(staging, ...file.path.split('/')));
    }
    copyFileSync(resolve(sourceRoot, 'manifest.json'), resolve(staging, 'manifest.json'));

    // --- 3. atomic registration: move the validated copy in, then swap the registry file -------------
    cpSync(staging, destination, { recursive: true });
    const record: InstalledPackageRecord = {
      packageId: manifest.packageId,
      version: manifest.version,
      manifestHash: manifest.manifestHash,
      installedDirectory: installDirectory,
      installedAtEpochSeconds: request.nowEpochSeconds ?? null,
      sourceDigest,
    };
    const nextRegistry: PackageRegistry = { schemaVersion: PACKAGE_REGISTRY_SCHEMA_VERSION, packages: [...registry.packages, record] };
    const registryTemp = resolve(packagesRoot, `.registry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    writeFileSync(registryTemp, JSON.stringify(nextRegistry, null, 2) + '\n', 'utf8');
    renameSync(registryTemp, packageRegistryPath(hostRoot));
    return { ok: true, issues: [], record };
  } catch (error) {
    return { ok: false, issues: [invalid('packages', `import failed while copying: ${(error as Error).message}`)], record: null };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Verifies the SOURCE tree contains exactly the declared content before anything is copied: a
 * source that gained an undeclared file between authoring and import must not smuggle it in.
 */
function collisionIssues(sourceRoot: string, manifest: PackageManifest): readonly PluginIssue[] {
  const issues: PluginIssue[] = [];
  const declared = new Set([...manifest.files.map(file => file.path), 'manifest.json']);
  const walk = (prefix: string): void => {
    for (const entry of readdirSync(prefix ? resolve(sourceRoot, prefix) : sourceRoot, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { issues.push(issue('reparse_point_rejected', relative, 'the source tree contains a reparse point; import is refused')); continue; }
      if (entry.isDirectory()) { walk(relative); continue; }
      if (entry.isFile() && !declared.has(relative)) {
        issues.push(invalid(relative, 'file is present in the source package but not declared in files[]; the import copy must contain exactly the declared content'));
      }
    }
  };
  walk('');
  return issues;
}

/** List helper used by tests and by 02's discovery; never loads anything. */
export function listInstalledPackageDirectories(hostRoot: string): readonly string[] {
  const packagesRoot = resolve(hostRoot, 'packages');
  if (!existsSync(packagesRoot)) return [];
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => `packages/${entry.name}`);
}

/** Kept intentionally tiny: statSync re-export for callers that want sizes without another import. */
export const installedPackageBytes = (hostRoot: string, record: InstalledPackageRecord): number => statSync(resolve(hostRoot, ...record.installedDirectory.split('/'))).size;
