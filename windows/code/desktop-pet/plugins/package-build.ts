/**
 * K65-01 (01-D): the directory-package build helper.
 *
 * Produces exactly the shape CONTRACTS.md §1 describes: root `manifest.json` + pre-compiled ESM
 * entries + static assets + in-package runtime dependencies + a dependency manifest. The helper is a
 * build-time tool for the package author; the HOST never runs it, and importing a built package never
 * runs anything (01-B).
 *
 * Two properties are enforced rather than documented:
 *   * determinism — the same input content produces the same `manifestHash` and the same per-file
 *     hashes, so "同内容可验证" is checkable by rebuilding;
 *   * refusal of forbidden content — a private key or a model weight inside the source tree is a hard
 *     build failure, not a warning, whichever directory it sits in.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  MANIFEST_SCHEMA_VERSION, PACKAGE_BUILD_SCHEMA_VERSION, PACKAGE_FORMAT_VERSION, PLUGIN_API_VERSION,
  type PackageFileEntry, type PackageManifest, type PluginIssue, type PluginEntryDeclaration,
} from '../contracts/plugin.js';
import { computeManifestHash, contentHash, listRelativeFiles, validatePackageManifest } from './manifest.js';
import { normalizePackageRelativePath } from './paths.js';
import { collectIdentities } from './manifest.js';

/** File extensions that must never enter a package, because they are keys or weights. */
export const FORBIDDEN_EXTENSIONS: readonly string[] = [
  '.onnx', '.pt', '.pth', '.safetensors', '.gguf', '.bin', '.h5', '.tflite', '.mlmodel', '.mpk',
  '.key', '.pem', '.p12', '.pfx', '.keystore', '.jks',
];

/** File-name shapes that must never enter a package even without a telling extension. */
export const FORBIDDEN_NAME_PATTERNS: readonly RegExp[] = [
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.env(\.|$)/i,
  /credentials?\.json$/i,
  /^(secrets?|tokens?)\./i,
];

export interface PackageBuildPlugin {
  readonly pluginId: string;
  /** Package-relative ESM entry, already compiled. The build helper does not compile anything. */
  readonly entry: string;
  readonly label: string;
  readonly capabilities: readonly unknown[];
  readonly dependsOn?: readonly string[];
  readonly readinessProbe?: string | null;
  readonly activationExport?: string;
  readonly author?: string;
}

export interface PackageBuildRequest {
  /** Source directory holding the pre-compiled entries and assets. Nothing here is executed. */
  readonly sourceRoot: string;
  /** New output directory. Must not exist unless `overwrite` is set. */
  readonly outputRoot: string;
  readonly packageId: string;
  readonly version: string;
  readonly label: string;
  readonly hostApiRange?: string;
  readonly publisher?: string;
  readonly license?: string;
  /** Seconds since the epoch, injected so a build is reproducible. Any other value is non-deterministic. */
  readonly epochSeconds?: number;
  readonly plugins: readonly PackageBuildPlugin[];
  readonly dependencies?: readonly { readonly packageId: string; readonly range: string; readonly reason: string }[];
  readonly optionalDependencies?: readonly { readonly packageId: string; readonly range: string; readonly reason: string }[];
  readonly resources?: readonly {
    readonly id: string; readonly kind: string; readonly reference: string; readonly required: boolean;
    readonly readiness?: string | null; readonly external: boolean;
  }[];
  readonly permissions?: readonly { readonly id: string; readonly scope: string; readonly reason: string; readonly promptsUser: boolean }[];
  readonly platform?: { readonly platform: readonly string[]; readonly arch: readonly string[]; readonly runtimeVersion: string; readonly features: readonly string[] };
  /** Package-relative prefixes copied verbatim; default `['']` copies everything in `sourceRoot`. */
  readonly include?: readonly string[];
  readonly overwrite?: boolean;
}

export interface PackageBuildResult {
  readonly ok: boolean;
  readonly outputRoot: string;
  readonly manifestPath: string;
  readonly dependencyManifestPath: string;
  readonly manifestHash: string;
  readonly files: readonly PackageFileEntry[];
  readonly issues: readonly PluginIssue[];
}

/** `dependency-manifest.json`: what the package was built from and what it is allowed to depend on. */
export interface PackageDependencyManifest {
  readonly schemaVersion: typeof PACKAGE_BUILD_SCHEMA_VERSION;
  readonly packageId: string;
  readonly version: string;
  readonly hostApiVersion: typeof PLUGIN_API_VERSION;
  readonly required: readonly { readonly packageId: string; readonly range: string; readonly reason: string }[];
  readonly optional: readonly { readonly packageId: string; readonly range: string; readonly reason: string }[];
  readonly entries: readonly string[];
  readonly manifestHash: string;
  readonly builtAtEpochSeconds: number | null;
  readonly fileCount: number;
  readonly totalBytes: number;
}

const ALLOWED_EXTENSIONS_HINT = new Set(['.mjs', '.js', '.cjs', '.json', '.css', '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2', '.ttf', '.wasm', '.txt', '.md', '.jsonc', '.map']);

/**
 * Builds a directory package. Fails loudly on forbidden content instead of copying it: 01-D requires
 * that keys and model weights do not enter the package, and a post-hoc assertion on the output would
 * be weaker than refusing to write it.
 */
export function buildPackage(request: PackageBuildRequest): PackageBuildResult {
  const issues: PluginIssue[] = [];
  const sourceRoot = resolve(request.sourceRoot);
  const outputRoot = resolve(request.outputRoot);
  const epochSeconds = request.epochSeconds ?? null;
  if (!Number.isInteger(epochSeconds) || (epochSeconds as number) < 0) {
    issues.push({ category: 'manifest_invalid', path: 'epochSeconds', detail: 'buildPackage requires an explicit non-negative integer epochSeconds so that a rebuild is byte-identical' });
    return emptyResult(outputRoot, issues);
  }
  if (!existsSync(sourceRoot)) {
    issues.push({ category: 'manifest_invalid', path: 'sourceRoot', detail: `source directory ${sourceRoot} does not exist` });
    return emptyResult(outputRoot, issues);
  }
  if (existsSync(outputRoot) && !request.overwrite) {
    if (readdirSync(outputRoot).length) {
      issues.push({ category: 'manifest_invalid', path: 'outputRoot', detail: `output directory ${outputRoot} is not empty; refusing to overwrite an existing package build` });
      return emptyResult(outputRoot, issues);
    }
  }

  const include = request.include ?? [''];
  const sources = listSources(sourceRoot, include);
  const forbidden = sources.filter(entry => isForbiddenContent(entry.path));
  if (forbidden.length) {
    for (const entry of forbidden) {
      issues.push({
        category: 'package_forbidden_content',
        path: entry.path,
        detail: `refusing to package ${entry.path}: a private key or a model weight must never enter a package (it is a resource reference, declared in manifest.resources with external: true)`,
      });
    }
    return emptyResult(outputRoot, issues);
  }
  const unknownExtensions = sources.filter(entry => !ALLOWED_EXTENSIONS_HINT.has(extensionOf(entry.path)));
  // Not fatal: a package may legitimately carry an unusual data file. Recorded so a reviewer sees it.
  const notes = unknownExtensions.map(entry => ({ category: 'manifest_invalid' as const, path: entry.path, detail: 'file has an unusual extension for a package; it is copied as an asset' }));

  const files: PackageFileEntry[] = [];
  const entryPaths = new Set(request.plugins.map(plugin => normalizePath(plugin.entry)));
  for (const source of sources) {
    const normalized = normalizePackageRelativePath(source.path);
    if (!normalized.ok) {
      issues.push({ category: 'entry_out_of_bounds', path: source.path, detail: normalized.rejection.detail });
      continue;
    }
    const bytes = readFileSync(source.absolute);
    files.push({
      path: normalized.path,
      bytes: bytes.byteLength,
      hash: contentHash(bytes),
      role: entryPaths.has(normalized.path) ? 'entry' : classifyRole(normalized.path),
      executable: false,
    });
  }
  if (issues.length) return emptyResult(outputRoot, issues);

  for (const plugin of request.plugins) {
    if (!entryPaths.has(normalizePath(plugin.entry))) continue;
    if (!files.some(file => file.path === normalizePath(plugin.entry))) {
      issues.push({ category: 'manifest_invalid', path: `plugins.${plugin.pluginId}.entry`, detail: `entry ${plugin.entry} is not part of the built file set` });
    }
  }
  if (issues.length) return emptyResult(outputRoot, issues);

  const manifest: PackageManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    formatVersion: PACKAGE_FORMAT_VERSION,
    packageId: request.packageId,
    version: request.version,
    hostApiRange: request.hostApiRange ?? `>=${PLUGIN_API_VERSION} <2.0.0`,
    label: request.label,
    ...(request.publisher === undefined ? {} : { publisher: request.publisher }),
    ...(request.license === undefined ? {} : { license: request.license }),
    platform: {
      platform: (request.platform?.platform ?? ['any']) as never,
      arch: (request.platform?.arch ?? ['any']) as never,
      runtimeVersion: request.platform?.runtimeVersion ?? '22.0.0',
      features: request.platform?.features ?? [],
    },
    plugins: request.plugins.map(plugin => ({
      pluginId: plugin.pluginId,
      entry: normalizePath(plugin.entry),
      label: plugin.label,
      capabilities: plugin.capabilities as PluginEntryDeclaration['capabilities'],
      dependsOn: plugin.dependsOn ?? [],
      readinessProbe: plugin.readinessProbe ?? null,
      ...(plugin.activationExport === undefined ? {} : { activationExport: plugin.activationExport }),
      ...(plugin.author === undefined ? {} : { author: plugin.author }),
    } as PluginEntryDeclaration)),
    dependencies: request.dependencies ?? [],
    optionalDependencies: request.optionalDependencies ?? [],
    resources: (request.resources ?? []).map(resource => ({
      id: resource.id, kind: resource.kind as never, reference: resource.reference,
      required: resource.required, readiness: resource.readiness ?? null, external: resource.external,
    })),
    permissions: (request.permissions ?? []).map(permission => ({ ...permission, id: permission.id as never })),
    files: files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    manifestHash: 'sha256-' + '0'.repeat(64),
  };
  const manifestHash = computeManifestHash(manifest);
  const finalManifest: PackageManifest = { ...manifest, manifestHash };

  // The build writes, then validates its own output through the SAME validator the host import path
  // uses. A build that produced a manifest the host would reject is a build failure.
  mkdirSync(outputRoot, { recursive: true });
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  for (const source of sources) {
    const destination = resolve(outputRoot, source.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(source.absolute));
  }
  writeFileSync(resolve(outputRoot, 'manifest.json'), JSON.stringify(finalManifest, null, 2) + '\n', 'utf8');

  const dependencyManifest: PackageDependencyManifest = {
    schemaVersion: PACKAGE_BUILD_SCHEMA_VERSION,
    packageId: request.packageId,
    version: request.version,
    hostApiVersion: PLUGIN_API_VERSION,
    required: request.dependencies ?? [],
    optional: request.optionalDependencies ?? [],
    entries: request.plugins.map(plugin => normalizePath(plugin.entry)).sort(),
    manifestHash,
    builtAtEpochSeconds: epochSeconds,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  const dependencyManifestPath = resolve(outputRoot, 'dependency-manifest.json');
  writeFileSync(dependencyManifestPath, JSON.stringify(dependencyManifest, null, 2) + '\n', 'utf8');

  const validation = validatePackageManifest(finalManifest, { packageRoot: outputRoot, checkFiles: true });
  if (!validation.ok) {
    return { ok: false, outputRoot, manifestPath: resolve(outputRoot, 'manifest.json'), dependencyManifestPath, manifestHash, files, issues: validation.issues };
  }
  const identities = collectIdentities(finalManifest);
  if (new Set(identities.pluginIds).size !== identities.pluginIds.length) {
    return { ok: false, outputRoot, manifestPath: resolve(outputRoot, 'manifest.json'), dependencyManifestPath, manifestHash, files, issues: [{ category: 'identity_conflict', path: 'plugins', detail: 'duplicate plugin id in the build request' }] };
  }
  return { ok: true, outputRoot, manifestPath: resolve(outputRoot, 'manifest.json'), dependencyManifestPath, manifestHash, files, issues: notes };
}

const emptyResult = (outputRoot: string, issues: readonly PluginIssue[]): PackageBuildResult =>
  ({ ok: false, outputRoot, manifestPath: resolve(outputRoot, 'manifest.json'), dependencyManifestPath: resolve(outputRoot, 'dependency-manifest.json'), manifestHash: '', files: [], issues });

const normalizePath = (value: string): string => value.split('\\').join('/').replace(/^\.\//, '');
const extensionOf = (path: string): string => {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
};

/** A key or a weight is refused by extension or by name, wherever it sits in the source tree. */
export function isForbiddenContent(relativePath: string): boolean {
  const base = relativePath.split('/').pop() ?? relativePath;
  if (FORBIDDEN_EXTENSIONS.includes(extensionOf(relativePath))) return true;
  return FORBIDDEN_NAME_PATTERNS.some(pattern => pattern.test(base));
}

function classifyRole(relativePath: string): PackageFileEntry['role'] {
  if (/\.(md|txt)$/i.test(relativePath) && /(^|\/)(readme|license|changelog)/i.test(relativePath)) return 'documentation';
  if (/(^|\/)node_modules\//.test(relativePath)) return 'runtime-dependency';
  if (relativePath.startsWith('data/')) return 'data';
  return 'asset';
}

function listSources(root: string, include: readonly string[]): readonly { readonly path: string; readonly absolute: string }[] {
  const seen = new Map<string, string>();
  for (const prefix of include) {
    const absolutePrefix = prefix ? resolve(root, prefix) : root;
    if (!existsSync(absolutePrefix)) continue;
    if (statSync(absolutePrefix).isFile()) {
      const relative = absolutePrefix.slice(resolve(root).length + 1).split('\\').join('/');
      seen.set(relative, absolutePrefix);
      continue;
    }
    for (const relative of listRelativeFiles(root, prefix)) seen.set(relative, resolve(root, relative));
  }
  return [...seen].map(([path, absolute]) => ({ path, absolute })).sort((left, right) => (left.path < right.path ? -1 : 1));
}

/** Content digest of a built package: the manifest hash plus every per-file hash, order-independent. */
export function packageDigest(root: string): string {
  const manifestText = readFileSync(resolve(root, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as PackageManifest;
  const digest = createHash('sha256');
  digest.update(manifest.manifestHash);
  for (const file of [...manifest.files].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    digest.update(`${file.path}\0${file.hash}\0${file.bytes}\n`);
  }
  return 'sha256-' + digest.digest('hex');
}
