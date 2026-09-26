import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginIssue } from '../contracts/plugin.js';
import { importPackageHost, packageRegistryPath, readHostConfig, setPackageEnablement, writeHostConfig, type HostConfig } from './host-config.js';
import { readPackageRegistry, type InstalledPackageRecord, type PackageRegistry } from './package-import.js';
import { validateManifestFile } from './manifest.js';

export interface LifecycleConsumer { readonly consumerId: string; readonly kind: 'flow' | 'binding' | 'source'; readonly detail?: string; }
export interface LifecycleImpact { readonly packageId: string; readonly installed: readonly InstalledPackageRecord[]; readonly enabled: boolean; readonly activeVersion: string | null; readonly consumers: readonly LifecycleConsumer[]; readonly pendingVersion: string | null; }
export interface LifecycleUpdate { readonly packageId: string; readonly previousVersion: string | null; readonly pendingVersion: string; readonly stagedDirectory: string; }

export class LifecycleError extends Error {
  constructor(readonly category: PluginIssue['category'], message: string) { super(message); this.name = 'LifecycleError'; }
}

interface PendingUpdate { readonly previousVersion: string | null; readonly version: string; readonly stagedDirectory: string; readonly record: InstalledPackageRecord; }
interface LifecycleState { readonly schemaVersion: 2; readonly active: Record<string, string>; readonly pending: Record<string, PendingUpdate>; readonly consumers: Record<string, LifecycleConsumer[]>; }
const emptyState = (): LifecycleState => ({ schemaVersion: 2, active: {}, pending: {}, consumers: {} });

/**
 * K65-08 package transaction coordinator. Runtime code remains the owner of activation; this class
 * only changes the durable intent/registry at restart boundaries and keeps old directories for rollback.
 */
export class PackageLifecycleManager {
  readonly #hostRoot: string;
  readonly #statePath: string;
  constructor(hostRoot: string) { this.#hostRoot = resolve(hostRoot); this.#statePath = resolve(this.#hostRoot, 'lifecycle-state.json'); mkdirSync(this.#hostRoot, { recursive: true }); }

  impact(packageId: string): LifecycleImpact {
    const registry = readPackageRegistry(this.#hostRoot); if (!registry.ok) throw new LifecycleError(registry.issue.category, registry.issue.detail);
    const config = readHostConfig(this.#hostRoot); if (!config.ok) throw new LifecycleError(config.issue.category, config.issue.detail);
    const state = this.#readState();
    return { packageId, installed: registry.registry.packages.filter(item => item.packageId === packageId), enabled: config.config.packages.some(item => item.packageId === packageId && item.enabled), activeVersion: state.active[packageId] ?? null, consumers: [...(state.consumers[packageId] ?? [])], pendingVersion: state.pending[packageId]?.version ?? null };
  }

  registerConsumer(packageId: string, consumer: LifecycleConsumer): void {
    const state = this.#readState(); const list = state.consumers[packageId] ?? [];
    if (list.some(item => item.consumerId === consumer.consumerId)) throw new LifecycleError('identity_conflict', `consumer ${consumer.consumerId} is already registered for ${packageId}`);
    this.#writeState({ ...state, consumers: { ...state.consumers, [packageId]: [...list, { ...consumer }] } });
  }

  releaseConsumer(packageId: string, consumerId: string): void {
    const state = this.#readState(); this.#writeState({ ...state, consumers: { ...state.consumers, [packageId]: (state.consumers[packageId] ?? []).filter(item => item.consumerId !== consumerId) } });
  }

  disable(packageId: string): LifecycleImpact {
    const impact = this.impact(packageId);
    if (!impact.installed.length) throw new LifecycleError('dependency_unsatisfied', `package ${packageId} is not installed`);
    if (impact.consumers.length) throw new LifecycleError('lifecycle_violation', `package ${packageId} has active consumers: ${impact.consumers.map(item => item.consumerId).join(', ')}`);
    const result = setPackageEnablement({ hostRoot: this.#hostRoot, packageId, enabled: false });
    if (!result.ok) throw new LifecycleError(result.issue.category, result.issue.detail);
    return this.impact(packageId);
  }

  stageUpdate(sourceRoot: string): LifecycleUpdate {
    // Import into an isolated temporary host so validation/copying is reused without touching the
    // active registry. A staged update must remain invisible until the restart transaction commits.
    const temporaryHost = resolve(this.#hostRoot, `.lifecycle-import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    let imported: ReturnType<typeof importPackageHost>;
    try { imported = importPackageHost({ sourceRoot: resolve(sourceRoot), hostRoot: temporaryHost }); }
    finally { /* the temporary tree is removed after the copy below */ }
    if (!imported.ok || !imported.record) { rmSync(temporaryHost, { recursive: true, force: true }); throw new LifecycleError(imported.issues[0]?.category ?? 'manifest_invalid', imported.issues[0]?.detail ?? 'package update was refused'); }
    const packageId = imported.record.packageId;
    const impact = this.impact(packageId);
    const sameVersion = impact.installed.find(item => item.version === imported.record!.version);
    if (sameVersion) {
      rmSync(temporaryHost, { recursive: true, force: true });
      throw new LifecycleError('identity_conflict', `package ${packageId}@${imported.record.version} is already installed; package versions are immutable`);
    }
    const previousVersion = impact.installed.filter(item => item.version !== imported.record!.version).sort((a, b) => b.version.localeCompare(a.version))[0]?.version ?? null;
    const stagingRelative = `.staging/${packageId.replace(/[^a-z0-9.-]/gi, '_')}-${imported.record.version}-${imported.record.sourceDigest.slice(7, 15)}`;
    const stagedDirectory = resolve(this.#hostRoot, stagingRelative);
    const importedDirectory = resolve(temporaryHost, ...imported.record.installedDirectory.split('/'));
    try {
      mkdirSync(resolve(this.#hostRoot, '.staging'), { recursive: true });
      rmSync(stagedDirectory, { recursive: true, force: true });
      cpSync(importedDirectory, stagedDirectory, { recursive: true });
    } finally { rmSync(temporaryHost, { recursive: true, force: true }); }
    const installDirectory = `packages/${packageId}-${imported.record.version}-${imported.record.sourceDigest.slice(7, 15)}`;
    const record: InstalledPackageRecord = { ...imported.record, installedDirectory: installDirectory };
    const state = this.#readState();
    this.#writeState({ ...state, pending: { ...state.pending, [packageId]: { previousVersion, version: imported.record.version, stagedDirectory: stagingRelative, record } } });
    return { packageId, previousVersion, pendingVersion: imported.record.version, stagedDirectory };
  }

  applyPendingOnRestart(packageId: string): LifecycleImpact {
    const state = this.#readState(); const pending = state.pending[packageId]; if (!pending) throw new LifecycleError('dependency_unsatisfied', `no pending update for ${packageId}`);
    const registryRead = readPackageRegistry(this.#hostRoot); if (!registryRead.ok) throw new LifecycleError(registryRead.issue.category, registryRead.issue.detail);
    const stagedDirectory = resolve(this.#hostRoot, pending.stagedDirectory);
    if (!existsSync(stagedDirectory)) throw new LifecycleError('dependency_unsatisfied', `staged version ${pending.version} is missing`);
    const checked = validateManifestFile(stagedDirectory);
    const stagedManifestHash = checked.manifest ? (checked.manifest as { manifestHash?: string }).manifestHash : undefined;
    if (!checked.ok || !checked.manifest || stagedManifestHash !== pending.record.manifestHash) throw new LifecycleError(checked.issues[0]?.category ?? 'hash_mismatch', checked.issues[0]?.detail ?? `staged version ${pending.version} changed after staging`);
    const next = pending.record;
    const destination = resolve(this.#hostRoot, ...next.installedDirectory.split('/'));
    if (existsSync(destination)) throw new LifecycleError('identity_conflict', `install directory ${next.installedDirectory} already exists`);
    mkdirSync(resolve(this.#hostRoot, 'packages'), { recursive: true });
    cpSync(stagedDirectory, destination, { recursive: true });
    const backup = resolve(this.#hostRoot, `.lifecycle-${packageId.replace(/[^a-z0-9.-]/gi, '_')}.bak.json`);
    const configRead = readHostConfig(this.#hostRoot); if (!configRead.ok) throw new LifecycleError(configRead.issue.category, configRead.issue.detail);
    writeFileSync(backup, JSON.stringify({ registry: registryRead.registry, config: configRead.config }, null, 2) + '\n', 'utf8');
    this.#atomicRegistry({ schemaVersion: registryRead.registry.schemaVersion, packages: [...registryRead.registry.packages.filter(item => item.packageId !== packageId), next] });
    const nextConfig: HostConfig = { schemaVersion: 1, packages: [...configRead.config.packages.filter(item => item.packageId !== packageId), { packageId, version: next.version, enabled: true, ready: null, updatedAtEpochSeconds: null }] };
    writeHostConfig(this.#hostRoot, nextConfig);
    this.#writeState({ ...state, active: { ...state.active, [packageId]: next.version }, pending: Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== packageId)) });
    rmSync(stagedDirectory, { recursive: true, force: true });
    return this.impact(packageId);
  }

  rollback(packageId: string): LifecycleImpact {
    const backup = resolve(this.#hostRoot, `.lifecycle-${packageId.replace(/[^a-z0-9.-]/gi, '_')}.bak.json`); if (!existsSync(backup)) throw new LifecycleError('resource_missing', `no rollback record for ${packageId}`);
    const saved = JSON.parse(readFileSync(backup, 'utf8')) as { registry: PackageRegistry; config: HostConfig };
    const priorVersion = saved.config.packages.find(item => item.packageId === packageId)?.version;
    const prior = saved.registry.packages.find(item => item.packageId === packageId && item.version === priorVersion)
      ?? saved.registry.packages.filter(item => item.packageId === packageId).sort((a, b) => b.version.localeCompare(a.version))[0];
    this.#atomicRegistry({ schemaVersion: saved.registry.schemaVersion, packages: [...saved.registry.packages.filter(item => item.packageId !== packageId), ...(prior ? [prior] : [])] });
    writeHostConfig(this.#hostRoot, saved.config); rmSync(backup, { force: true });
    const state = this.#readState();
    this.#writeState({ ...state, active: prior ? { ...state.active, [packageId]: prior.version } : Object.fromEntries(Object.entries(state.active).filter(([id]) => id !== packageId)), pending: Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== packageId)) });
    return this.impact(packageId);
  }

  uninstall(packageId: string): void {
    const impact = this.impact(packageId); if (impact.consumers.length) throw new LifecycleError('lifecycle_violation', `package ${packageId} has active consumers`);
    const registryRead = readPackageRegistry(this.#hostRoot); if (!registryRead.ok) throw new LifecycleError(registryRead.issue.category, registryRead.issue.detail);
    const target = registryRead.registry.packages.find(item => item.packageId === packageId); if (!target) throw new LifecycleError('dependency_unsatisfied', `package ${packageId} is not installed`);
    this.#atomicRegistry({ schemaVersion: registryRead.registry.schemaVersion, packages: registryRead.registry.packages.filter(item => item.packageId !== packageId) });
    rmSync(resolve(this.#hostRoot, ...target.installedDirectory.split('/')), { recursive: true, force: true });
    const config = readHostConfig(this.#hostRoot); if (config.ok) writeHostConfig(this.#hostRoot, { schemaVersion: 1, packages: config.config.packages.filter(item => item.packageId !== packageId) });
    const state = this.#readState(); this.#writeState({ ...state, active: Object.fromEntries(Object.entries(state.active).filter(([id]) => id !== packageId)), consumers: Object.fromEntries(Object.entries(state.consumers).filter(([id]) => id !== packageId)), pending: Object.fromEntries(Object.entries(state.pending).filter(([id]) => id !== packageId)) });
  }

  #readState(): LifecycleState {
    if (!existsSync(this.#statePath)) return emptyState();
    const parsed = JSON.parse(readFileSync(this.#statePath, 'utf8')) as Partial<LifecycleState>;
    const schemaVersion = (parsed as { schemaVersion?: number }).schemaVersion;
    // v1 pending records pointed at the live registry and therefore cannot be replayed safely. Keep
    // durable active/consumer information, discard only that stale intent, and require a fresh stage.
    if (schemaVersion === 1) return { schemaVersion: 2, active: parsed.active ?? {}, pending: {}, consumers: parsed.consumers ?? {} };
    if (schemaVersion !== 2) throw new LifecycleError('manifest_invalid', 'lifecycle-state.json schema is unsupported; restage the update');
    return { ...emptyState(), ...parsed, active: parsed.active ?? {}, pending: parsed.pending ?? {}, consumers: parsed.consumers ?? {} };
  }
  #writeState(state: LifecycleState): void { const temp = `${this.#statePath}.next`; writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8'); renameSync(temp, this.#statePath); }
  #atomicRegistry(registry: PackageRegistry): void { const path = packageRegistryPath(this.#hostRoot); mkdirSync(resolve(this.#hostRoot, 'packages'), { recursive: true }); const temp = `${path}.next`; writeFileSync(temp, JSON.stringify(registry, null, 2) + '\n', 'utf8'); renameSync(temp, path); }
}
