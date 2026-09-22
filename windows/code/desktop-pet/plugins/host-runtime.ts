/** K65-02: metadata discovery, enablement-aware lazy activation and resource cleanup. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PLUGIN_API_VERSION, compareVersions, satisfiesRange,
  type CapabilityProviderRef, type DeactivationReason, type EventScope,
  type HostContext, type HostLogger, type PluginHandle, type PluginIssue,
  type PluginModule, type PluginActivation, type SecretStore, type PackageManifest, type PluginEntryDeclaration,
  type ExistingTurn,
} from '../contracts/plugin.js';
import type { CapabilityDeclaration } from '../contracts/capability.js';
import { validateManifestFile } from './manifest.js';
import { normalizePackageRelativePath, resolveInsidePackage } from './paths.js';
import { readPackageRegistry, type InstalledPackageRecord } from './package-import.js';
import { readHostConfig } from './host-config.js';

type ResourceKind = Parameters<HostContext['resources']['register']>[0];
const RESOURCE_KINDS: readonly ResourceKind[] = ['timer', 'listener', 'process', 'socket', 'device', 'worker', 'file-handle'];

export interface CachedManifest { readonly manifest: PackageManifest; readonly record: InstalledPackageRecord; }
export interface DiscoveryIssue extends PluginIssue { readonly packageId: string | null; }
export interface PluginRequest { readonly pluginId: string; readonly capabilityId: string; readonly bindingId?: string; readonly signal?: AbortSignal; }

export class PluginRequestError extends Error {
  readonly category: PluginIssue['category'];
  readonly issue: PluginIssue;
  constructor(category: PluginIssue['category'], path: string, detail: string) { super(detail); this.name = 'PluginRequestError'; this.category = category; this.issue = { category, path, detail }; }
}
export class CancellationRequested extends Error { override name = 'CancellationRequested'; }

export interface PackageHostOptions { readonly hostRoot: string; readonly secrets: SecretStore; readonly turn?: ExistingTurn | null; readonly logger?: HostLogger; readonly nowEpochSeconds?: () => number; }
export interface HostCloseReport {
  readonly plugins: readonly { readonly pluginId: string; readonly packageId: string; readonly releasedResources: number }[];
  readonly resources: readonly { readonly id: string; readonly error: string }[];
  readonly errors: readonly string[];
}
export interface PackageHost {
  readonly hostRoot: string;
  readonly close: (reason?: DeactivationReason) => Promise<HostCloseReport>;
  readonly outstanding: () => readonly string[];
  readonly assertCleanState: () => readonly string[];
  readonly resolve: (request: PluginRequest) => Promise<readonly CapabilityProviderRef[]>;
  readonly hostContextForTest: (request: PluginRequest, manifest: PackageManifest) => HostContext;
  readonly loadManifestForTest: (request: PluginRequest) => Promise<PackageManifest>;
}

interface LoadedEntry { readonly manifest: PackageManifest; readonly record: InstalledPackageRecord; readonly plugin: PluginEntryDeclaration; readonly root: string; }
interface ResourceEntry { readonly kind: ResourceKind; readonly release: () => void | Promise<void>; }
interface ActivationRecord { readonly packageId: string; readonly packageVersion: string; readonly pluginId: string; readonly resources: Map<string, ResourceEntry>; readonly dataRoot: string; handle: PluginHandle | null; module: PluginModule | null; failed: boolean; }
interface ActiveModule { readonly entry: LoadedEntry; readonly record: ActivationRecord; readonly module: PluginModule; }

const keyOf = (packageId: string, pluginId: string): string => `${packageId}/${pluginId}`;
const issue = (category: PluginIssue['category'], path: string, detail: string): PluginIssue => ({ category, path, detail });

/** Metadata-only scan. It validates installed content but never imports a package entry. */
export function discoverInstalledPackages(hostRoot: string): { readonly issues: readonly DiscoveryIssue[]; readonly packages: readonly CachedManifest[]; readonly hostConfigReadMs: number | null } {
  const started = Date.now();
  const issues: DiscoveryIssue[] = [];
  const packages: CachedManifest[] = [];
  const registry = readPackageRegistry(hostRoot);
  if (!registry.ok) return { issues: [{ ...registry.issue, packageId: null }], packages, hostConfigReadMs: null };
  for (const record of registry.registry.packages) {
    const root = resolve(hostRoot, ...record.installedDirectory.split('/'));
    const result = validateManifestFile(root);
    if (!result.ok) { issues.push(...result.issues.map(item => ({ ...item, path: `${record.installedDirectory}/${item.path}`, packageId: record.packageId }))); continue; }
    const manifest = result.manifest as PackageManifest;
    if (manifest.packageId !== record.packageId || manifest.version !== record.version || manifest.manifestHash !== record.manifestHash) {
      issues.push({ category: 'identity_conflict', path: `${record.installedDirectory}/manifest.json`, detail: 'installed manifest does not match registry identity', packageId: record.packageId });
      continue;
    }
    packages.push({ manifest, record });
  }
  const config = readHostConfig(hostRoot);
  return { issues, packages, hostConfigReadMs: config.ok ? Date.now() - started : null };
}

export function createPackageHost(options: PackageHostOptions): PackageHost {
  const hostRoot = resolve(options.hostRoot);
  const logger = options.logger ?? { log() {} };
  const active = new Map<string, ActivationRecord>();
  const modules = new Map<string, ActiveModule>();
  const inFlight = new Map<string, Promise<readonly CapabilityProviderRef[]>>();
  const providers: CapabilityProviderRef[] = [];
  const providerShapes = new Map<string, string>();
  const listeners: { readonly topics: readonly string[]; readonly scope: EventScope; readonly handler: (topic: string, payload: unknown) => void }[] = [];
  let closed = false;
  let closeReason: DeactivationReason | null = null;

  const fail = (category: PluginIssue['category'], path: string, detail: string): never => { throw new PluginRequestError(category, path, detail); };
  const assertOpen = (): void => { if (closed) fail('lifecycle_violation', 'host', `package host is closed${closeReason ? ` (${closeReason.kind})` : ''}`); };
  const checkAbort = (signal: AbortSignal | undefined, stage: string): void => { if (signal?.aborted) throw new CancellationRequested(`request cancelled during ${stage}`); };

  function scan(): readonly CachedManifest[] {
    const result = discoverInstalledPackages(hostRoot);
    if (result.issues.length) { const first = result.issues[0]!; fail(first.category, first.path, first.detail); }
    const versions = new Map<string, number>();
    for (const item of result.packages) versions.set(item.record.packageId, (versions.get(item.record.packageId) ?? 0) + 1);
    for (const [packageId, count] of versions) if (count > 1) fail('identity_conflict', 'packageId', `${packageId} has multiple installed versions`);
    return result.packages;
  }

  function isEnabled(packageId: string): boolean {
    const config = readHostConfig(hostRoot);
    return config.ok && config.config.packages.some(entry => entry.packageId === packageId && entry.enabled);
  }

  function findRequest(request: PluginRequest): LoadedEntry {
    const matches: LoadedEntry[] = [];
    for (const item of scan()) for (const plugin of item.manifest.plugins) if (plugin.pluginId === request.pluginId) matches.push({ ...item, plugin, root: resolve(hostRoot, ...item.record.installedDirectory.split('/')) });
    if (!matches.length) fail('manifest_invalid', 'pluginId', `no installed package declares plugin ${JSON.stringify(request.pluginId)}`);
    if (matches.length > 1) fail('identity_conflict', 'pluginId', `plugin ${request.pluginId} is declared more than once`);
    const found = matches[0]!;
    if (!found.plugin.capabilities.some(item => item.capabilityId === request.capabilityId)) fail('capability_unsupported', 'capabilityId', `plugin ${request.pluginId} does not declare ${request.capabilityId}`);
    return found!;
  }

  function dependencyEntry(packageId: string, range: string): CachedManifest {
    const candidates = scan().filter(item => item.record.packageId === packageId && satisfiesRange(item.record.version, range));
    candidates.sort((a, b) => compareVersions(b.record.version, a.record.version));
    const found = candidates[0];
    if (!found) fail('dependency_unsatisfied', `dependencies.${packageId}`, `required dependency ${packageId}@${range} is unavailable`);
    return found!;
  }

  function closure(root: LoadedEntry): readonly LoadedEntry[] {
    const installed = new Map(scan().map(item => [item.record.packageId, item]));
    const result: LoadedEntry[] = [];
    const seen = new Set<string>();
    const visiting = new Set<string>();
    const visit = (entry: LoadedEntry): void => {
      const key = keyOf(entry.record.packageId, entry.plugin.pluginId);
      if (seen.has(key)) return;
      if (visiting.has(key)) fail('dependency_unsatisfied', 'dependencies', `dependency cycle at ${key}`);
      visiting.add(key);
      for (const dependency of entry.manifest.dependencies) {
        const installedTarget = installed.get(dependency.packageId);
        const target = installedTarget && satisfiesRange(installedTarget.record.version, dependency.range)
          ? installedTarget
          : dependencyEntry(dependency.packageId, dependency.range);
        const plugin = target.manifest.plugins[0];
        if (!plugin) fail('dependency_unsatisfied', dependency.packageId, 'dependency has no plugin entry');
        visit({ ...target, plugin: plugin!, root: resolve(hostRoot, ...target.record.installedDirectory.split('/')) });
      }
      for (const dependencyId of entry.plugin.dependsOn ?? []) {
        const plugin = entry.manifest.plugins.find(item => item.pluginId === dependencyId);
        if (!plugin) fail('dependency_unsatisfied', `plugins.${entry.plugin.pluginId}.dependsOn`, `plugin ${dependencyId} is not declared`);
        visit({ ...entry, plugin: plugin! });
      }
      visiting.delete(key); seen.add(key); result.push(entry);
    };
    visit(root);
    return result;
  }

  async function loadEntry(entry: LoadedEntry): Promise<ActiveModule> {
    const key = keyOf(entry.record.packageId, entry.plugin.pluginId);
    const cached = modules.get(key); if (cached) return cached;
    const normalized = normalizePackageRelativePath(entry.plugin.entry, 'entry');
    if (!normalized.ok) throw new PluginRequestError('entry_out_of_bounds', 'entry', normalized.rejection.detail);
    const entryPath = resolveInsidePackage(entry.root, normalized.path);
    if (!existsSync(entryPath)) fail('manifest_invalid', 'entry', `entry ${entry.plugin.entry} is missing`);
    const namespace = await import(pathToFileURL(entryPath).href) as Record<string, unknown>;
    const exportName = entry.plugin.activationExport ?? 'activation';
    const activation = namespace[exportName] as PluginActivation | undefined;
    if (!activation || typeof activation.activate !== 'function' || typeof activation.deactivate !== 'function') fail('manifest_invalid', `entry.${exportName}`, `entry must export ${exportName} with activate/deactivate`);
    const module: PluginModule = { activation: activation! };
    const record: ActivationRecord = { packageId: entry.record.packageId, packageVersion: entry.record.version, pluginId: entry.plugin.pluginId, resources: new Map(), dataRoot: resolve(hostRoot, 'data', entry.record.packageId, entry.plugin.pluginId), handle: null, module, failed: false };
    const loaded: ActiveModule = { entry, record, module };
    modules.set(key, loaded);
    return loaded;
  }

  function context(request: PluginRequest, entry: LoadedEntry, record: ActivationRecord): HostContext {
    const declarations = new Map(entry.plugin.capabilities.map(item => [declarationKey(item), item]));
    const ensureLive = (): void => { if (record.failed) fail('lifecycle_violation', 'activation', 'activation is no longer live'); };
    const scopedProviders = (): readonly CapabilityProviderRef[] => providers.filter(item => item.packageId === record.packageId && item.pluginId === record.pluginId);
    return {
      apiVersion: PLUGIN_API_VERSION, packageId: record.packageId, pluginId: record.pluginId,
      data: {
        read: async key => { ensureLive(); try { return new Uint8Array(await readFile(dataPath(record.dataRoot, key))); } catch { return null; } },
        write: async (key, bytes) => { ensureLive(); const path = dataPath(record.dataRoot, key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); },
        list: async () => listData(record.dataRoot),
        remove: async key => { ensureLive(); await rm(dataPath(record.dataRoot, key), { force: true }); },
      },
      capabilities: {
        register: declaration => {
          ensureLive();
          const { provide: provider, ...declaredValue } = declaration;
          const expected = declarations.get(declarationKey(declaredValue));
          if (!expected || JSON.stringify(expected) !== JSON.stringify(declaredValue)) fail('capability_conflict', declaration.capabilityId, 'registered capability differs from manifest');
          const id = `${provider.packageId}:${provider.pluginId}:${provider.adapterId}`;
          const shape = JSON.stringify(declaration);
          if (providerShapes.has(id) && providerShapes.get(id) !== shape) fail('capability_conflict', id, 'provider identity has different content');
          if (!providerShapes.has(id)) { providerShapes.set(id, shape); providers.push(provider); }
        },
        resolve: (capabilityId, requestScope) => { ensureLive(); if (requestScope.declaredBy !== record.pluginId || !entry.plugin.capabilities.some(item => item.capabilityId === capabilityId)) fail('capability_unsupported', 'declaredBy', `capability ${capabilityId} is not declared by this plugin`); return scopedProviders().filter(item => item.capabilityId === capabilityId); },
        get registered() { return scopedProviders(); },
      },
      events: {
        subscribe: (topics, scope, handler) => { ensureLive(); const listener = { topics: [...topics], scope, handler }; listeners.push(listener); return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); }; },
        publish: (topic, payload, scope) => { ensureLive(); for (const listener of [...listeners]) if (listener.topics.includes(topic) && listener.scope.packageId === scope.packageId && (!listener.scope.sessionId || listener.scope.sessionId === scope.sessionId)) listener.handler(topic, payload); },
      },
      resources: {
        register: (kind, id, release) => { ensureLive(); if (!RESOURCE_KINDS.includes(kind)) fail('unsupported_parameter', 'resources.kind', `unsupported resource kind ${kind}`); if (record.resources.has(id)) fail('identity_conflict', 'resources', `resource ${id} is already registered`); record.resources.set(id, { kind, release }); },
        release: async id => { const resource = record.resources.get(id); if (!resource) fail('resource_missing', 'resources', `resource ${id} is not registered`); record.resources.delete(id); await resource!.release(); },
        get outstanding() { return [...record.resources.keys()].sort(); },
      },
      config: { get: () => undefined, keys: () => [] }, secrets: options.secrets,
      log: { log: (level, message, fields) => { if (fields === undefined) logger.log(level, `[${record.packageId}/${record.pluginId}] ${message}`); else logger.log(level, `[${record.packageId}/${record.pluginId}] ${message}`, fields); } },
      turn: options.turn ?? null,
    };
  }

  async function activate(entry: LoadedEntry, request: PluginRequest): Promise<ActivationRecord> {
    const key = keyOf(entry.record.packageId, entry.plugin.pluginId);
    const existing = active.get(key); if (existing) return existing;
    const loaded = await loadEntry(entry);
    checkAbort(request.signal, key);
    try {
      const handle = await loaded.module.activation.activate(context(request, entry, loaded.record));
      if (!handle || handle.pluginId !== loaded.record.pluginId || handle.packageId !== loaded.record.packageId || handle.packageVersion !== loaded.record.packageVersion || handle.apiVersion !== PLUGIN_API_VERSION || handle.state !== 'active') fail('lifecycle_violation', key, 'activation returned an invalid handle');
      if (handle.capabilityIds.some(id => !entry.plugin.capabilities.some(item => item.capabilityId === id))) fail('capability_conflict', key, 'activation returned an undeclared capability');
      loaded.record.handle = handle; active.set(key, loaded.record); return loaded.record;
    } catch (error) {
      loaded.record.failed = true; await releaseResources(loaded.record); removeProviders(loaded.record); modules.delete(key);
      throw error;
    }
  }

  async function resolveRequest(request: PluginRequest): Promise<readonly CapabilityProviderRef[]> {
    assertOpen(); checkAbort(request.signal, 'request');
    const flightKey = `${request.pluginId}::${request.capabilityId}`;
    const existing = inFlight.get(flightKey); if (existing) return existing;
    const operation = (async () => {
      const root = findRequest(request);
      if (!isEnabled(root.record.packageId)) fail('lifecycle_violation', 'enablement', `package ${root.record.packageId} is installed but disabled`);
      const before = new Set(active.keys());
      const activated: ActivationRecord[] = [];
      try {
        for (const entry of closure(root)) { if (!isEnabled(entry.record.packageId)) fail('lifecycle_violation', 'enablement', `dependency package ${entry.record.packageId} is disabled`); const record = await activate(entry, request); if (!before.has(keyOf(record.packageId, record.pluginId))) activated.push(record); }
        return providers.filter(item => item.packageId === root.record.packageId && item.pluginId === root.plugin.pluginId && item.capabilityId === request.capabilityId);
      } catch (error) {
        for (const record of activated.reverse()) await deactivate(record, { kind: 'failure', detail: 'activation transaction rolled back' });
        throw error;
      }
    })();
    inFlight.set(flightKey, operation); try { return await operation; } finally { inFlight.delete(flightKey); }
  }

  async function releaseResources(record: ActivationRecord): Promise<void> { for (const [id, resource] of [...record.resources.entries()].reverse()) { record.resources.delete(id); try { await resource.release(); } catch (error) { logger.log('warn', `resource release failed: ${id}`, { pluginId: record.pluginId, error: (error as Error).message }); } } }
  function removeProviders(record: ActivationRecord): void { for (let i = providers.length - 1; i >= 0; i -= 1) if (providers[i]!.packageId === record.packageId && providers[i]!.pluginId === record.pluginId) providers.splice(i, 1); for (const [id, shape] of providerShapes) if (id.startsWith(`${record.packageId}:${record.pluginId}:`)) providerShapes.delete(id); }
  async function deactivate(record: ActivationRecord, reason: DeactivationReason): Promise<void> { record.failed = true; try { if (record.module && record.handle) await record.module.activation.deactivate(reason); } finally { await releaseResources(record); removeProviders(record); active.delete(keyOf(record.packageId, record.pluginId)); } }

  return {
    hostRoot,
    resolve: resolveRequest,
    outstanding: () => [...active.values()].flatMap(record => [...record.resources.keys()].map(id => `${record.packageId}/${record.pluginId}:${id}`)).sort(),
    assertCleanState: () => [...active.values()].flatMap(record => [...record.resources.keys()].map(id => `${record.pluginId}:${id}`)),
    close: async reason => {
      if (closed) return { plugins: [], resources: [], errors: [] };
      closed = true; closeReason = reason ?? { kind: 'shutdown', detail: 'package host shutdown' };
      const report: { plugins: { pluginId: string; packageId: string; releasedResources: number }[]; resources: { id: string; error: string }[]; errors: string[] } = { plugins: [], resources: [], errors: [] };
      for (const record of [...active.values()].reverse()) { const count = record.resources.size; try { await deactivate(record, closeReason); report.plugins.push({ pluginId: record.pluginId, packageId: record.packageId, releasedResources: count }); } catch (error) { report.errors.push(`${record.pluginId}: ${(error as Error).message}`); } }
      return report;
    },
    hostContextForTest: (request, manifest) => { const plugin = manifest.plugins.find(item => item.pluginId === request.pluginId); if (!plugin) fail('manifest_invalid', 'pluginId', `plugin ${request.pluginId} is not declared`); const entry: LoadedEntry = { manifest, record: { packageId: manifest.packageId, version: manifest.version, manifestHash: manifest.manifestHash, installedDirectory: '', installedAtEpochSeconds: null, sourceDigest: '' }, plugin: plugin!, root: hostRoot }; return context(request, entry, { packageId: entry.record.packageId, packageVersion: entry.record.version, pluginId: plugin!.pluginId, resources: new Map(), dataRoot: resolve(hostRoot, 'data', entry.record.packageId, plugin!.pluginId), handle: null, module: null, failed: false }); },
    loadManifestForTest: async request => findRequest(request).manifest,
  };
}

function dataPath(root: string, key: string): string { const normalized = normalizePackageRelativePath(key, 'data.key'); if (!normalized.ok) throw new PluginRequestError('entry_out_of_bounds', 'data.key', normalized.rejection.detail); return resolveInsidePackage(root, normalized.path); }
function declarationKey(declaration: Pick<CapabilityDeclaration, 'capabilityId' | 'adapterId' | 'adapterVersion'>): string {
  return `${declaration.capabilityId}::${declaration.adapterId}::${declaration.adapterVersion}`;
}
async function listData(root: string): Promise<readonly string[]> { const output: string[] = []; const visit = async (prefix: string): Promise<void> => { let entries; try { entries = await readdir(resolve(root, prefix), { withFileTypes: true }); } catch { return; } for (const entry of entries) { const path = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) await visit(path); else output.push(path); } }; await visit(''); return output.sort(); }
