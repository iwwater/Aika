import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FlowProfile } from '../contracts/flow-profile.js';
import { FlowRuntime } from '../kernel/flow-runtime.js';
import { discoverInstalledPackages } from '../plugins/host-runtime.js';
import { PackageLifecycleManager, type LifecycleImpact, type LifecycleUpdate } from '../plugins/package-lifecycle.js';
import { readHostConfig } from '../plugins/host-config.js';

export interface Next65PackageView extends LifecycleImpact { readonly ready: boolean | null; readonly loaded: false; readonly manifestLabels: readonly string[]; }
export interface Next65Diagnostic { readonly at: string; readonly scopeId: string; readonly profileId: string; readonly profileRevision: number; readonly packageVersions: Readonly<Record<string, string>>; readonly stageId: string; readonly status: 'completed' | 'failed' | 'skipped' | 'partial'; readonly detail: string; }
export interface Next65ProfileRecord { readonly profile: FlowProfile; readonly updatedAt: string; }

/** Read-only management projection plus guarded mutations for the 0.65 host. */
export class Next65Management {
  readonly #hostRoot: string;
  readonly #lifecycle: PackageLifecycleManager;
  readonly #flow: FlowRuntime;
  readonly #profilesPath: string;
  readonly #diagnostics: Next65Diagnostic[] = [];
  constructor(hostRoot: string, flow: FlowRuntime = new FlowRuntime([])) { this.#hostRoot = resolve(hostRoot); this.#lifecycle = new PackageLifecycleManager(this.#hostRoot); this.#flow = flow; this.#profilesPath = resolve(this.#hostRoot, 'next65-profiles.json'); }

  packages(): readonly Next65PackageView[] {
    const discovered = discoverInstalledPackages(this.#hostRoot); const config = readHostConfig(this.#hostRoot);
    return discovered.packages.map(item => { const impact = this.#lifecycle.impact(item.record.packageId); const enabled = config.ok && config.config.packages.some(entry => entry.packageId === item.record.packageId && entry.enabled); const labels = item.manifest.plugins.map(plugin => plugin.label); return { ...impact, enabled, ready: config.ok ? config.config.packages.find(entry => entry.packageId === item.record.packageId)?.ready ?? null : null, loaded: false as const, manifestLabels: labels }; });
  }
  importPackage(sourceRoot: string): Next65PackageView { const update = this.#lifecycle.stageUpdate(sourceRoot); return this.packages().find(item => item.packageId === update.packageId)!; }
  disable(packageId: string): LifecycleImpact { return this.#lifecycle.disable(packageId); }
  stageUpdate(sourceRoot: string): LifecycleUpdate { return this.#lifecycle.stageUpdate(sourceRoot); }
  applyRestart(packageId: string): LifecycleImpact { return this.#lifecycle.applyPendingOnRestart(packageId); }
  uninstall(packageId: string): void { this.#lifecycle.uninstall(packageId); }
  validateProfile(profile: FlowProfile): readonly { readonly path: string; readonly detail: string }[] { return this.#flow.validate(profile); }
  previewProfile(profile: FlowProfile): readonly { readonly nodeId: string; readonly capabilityId: string | null; readonly dependsOn: readonly string[] }[] { return this.#flow.preview(profile); }
  saveProfile(profile: FlowProfile, expectedRevision: number): Next65ProfileRecord {
    const profiles = this.#readProfiles(); const prior = profiles[profile.profileId]; if (prior && prior.profile.revision !== expectedRevision) throw new Error(`profile revision conflict: expected ${expectedRevision}, current ${prior.profile.revision}`);
    const issues = this.validateProfile(profile); if (issues.length) throw new Error(`profile refused: ${issues[0]!.detail}`);
    const saved = { profile: structuredClone(profile), updatedAt: new Date().toISOString() }; this.#writeProfiles({ ...profiles, [profile.profileId]: saved }); return saved;
  }
  profiles(): readonly Next65ProfileRecord[] { return Object.values(this.#readProfiles()); }
  recordDiagnostic(input: Omit<Next65Diagnostic, 'at' | 'detail'> & { readonly detail?: string }): void {
    const detail = sanitizeDetail(input.detail ?? ''); this.#diagnostics.push({ ...input, at: new Date().toISOString(), detail }); while (this.#diagnostics.length > 200) this.#diagnostics.shift();
  }
  diagnostics(): readonly Next65Diagnostic[] { return this.#diagnostics.map(item => ({ ...item })); }
  #readProfiles(): Record<string, Next65ProfileRecord> { if (!existsSync(this.#profilesPath)) return {}; const value = JSON.parse(readFileSync(this.#profilesPath, 'utf8')) as Record<string, Next65ProfileRecord>; return value && typeof value === 'object' ? value : {}; }
  #writeProfiles(value: Record<string, Next65ProfileRecord>): void { const temp = `${this.#profilesPath}.next`; writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8'); renameSync(temp, this.#profilesPath); }
}

function sanitizeDetail(value: string): string { return value.replace(/(?:api[_-]?key|authorization|credential(?:Ref|Id)?|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').slice(0, 500); }
