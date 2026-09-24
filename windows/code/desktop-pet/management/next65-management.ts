import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateFlowProfile, type FlowProfile } from '../contracts/flow-profile.js';
import { FlowRuntime, type FlowStageHandler } from '../kernel/flow-runtime.js';
import { discoverInstalledPackages } from '../plugins/host-runtime.js';
import { PackageLifecycleManager, type LifecycleImpact, type LifecycleUpdate } from '../plugins/package-lifecycle.js';
import { readHostConfig } from '../plugins/host-config.js';

export interface Next65PackageView extends LifecycleImpact {
  readonly ready: boolean | null;
  readonly loaded: boolean;
  readonly active?: boolean;
  readonly manifestLabels: readonly string[];
}
export interface Next65Diagnostic { readonly at: string; readonly scopeId: string; readonly profileId: string; readonly profileRevision: number; readonly packageVersions: Readonly<Record<string, string>>; readonly stageId: string; readonly status: 'completed' | 'failed' | 'skipped' | 'partial'; readonly detail: string; }
export interface Next65ProfileRecord { readonly profile: FlowProfile; readonly updatedAt: string; }

export interface Next65ManagementOptions {
  readonly hostRoot: string;
  readonly host?: import('../plugins/host-runtime.js').PackageHost | undefined;
  readonly flow?: FlowRuntime | undefined;
  readonly providerRuntime?: import('../plugins/provider-runtime.js').ProviderRuntime | undefined;
}

/** Read-only management projection plus guarded mutations for the 0.65 host. */
export class Next65Management {
  readonly #hostRoot: string;
  readonly #lifecycle: PackageLifecycleManager;
  readonly #flow?: FlowRuntime | undefined;
  readonly #host?: import('../plugins/host-runtime.js').PackageHost | undefined;
  readonly #providerRuntime?: import('../plugins/provider-runtime.js').ProviderRuntime | undefined;
  readonly #profilesPath: string;
  readonly #activeProfilePath: string;
  readonly #diagnostics: Next65Diagnostic[] = [];

  constructor(
    hostRootOrOptions: string | Next65ManagementOptions,
    flow?: FlowRuntime,
    host?: import('../plugins/host-runtime.js').PackageHost,
    providerRuntime?: import('../plugins/provider-runtime.js').ProviderRuntime,
  ) {
    if (typeof hostRootOrOptions === 'string') {
      this.#hostRoot = resolve(hostRootOrOptions);
      this.#flow = flow;
      this.#host = host;
      this.#providerRuntime = providerRuntime;
    } else {
      this.#hostRoot = resolve(hostRootOrOptions.hostRoot);
    this.#host = hostRootOrOptions.host ?? host;
    this.#flow = hostRootOrOptions.flow ?? flow;
    this.#providerRuntime = hostRootOrOptions.providerRuntime ?? providerRuntime;
    }
    this.#lifecycle = new PackageLifecycleManager(this.#hostRoot);
    this.#profilesPath = resolve(this.#hostRoot, 'next65-profiles.json');
    this.#activeProfilePath = resolve(this.#hostRoot, 'next65-active-profile.json');
  }

  packages(): readonly Next65PackageView[] {
    const discovered = discoverInstalledPackages(this.#hostRoot);
    const config = readHostConfig(this.#hostRoot);
    return discovered.packages.map(item => {
      const impact = this.#lifecycle.impact(item.record.packageId);
      const enabled = config.ok && config.config.packages.some(entry => entry.packageId === item.record.packageId && entry.enabled);
      const labels = item.manifest.plugins.map(plugin => plugin.label);
      const loaded = this.#host?.isLoaded ? this.#host.isLoaded(item.record.packageId) : false;
      const active = this.#host?.activePackages ? this.#host.activePackages().includes(item.record.packageId) : false;
      return {
        ...impact,
        enabled,
        ready: config.ok ? config.config.packages.find(entry => entry.packageId === item.record.packageId)?.ready ?? null : null,
        loaded,
        active,
        manifestLabels: labels,
      };
    });
  }

  runtimeTruth(): {
    readonly hostAvailable: boolean;
    readonly flowAvailable: boolean;
    readonly installedCount: number;
    readonly loadedPackages: readonly string[];
    readonly activePackages: readonly string[];
    readonly registeredCapabilities: readonly string[];
  } {
    const pkgs = this.packages();
    const loadedPackages = pkgs.filter(p => p.loaded).map(p => p.packageId);
    const activePackages = pkgs.filter(p => p.active).map(p => p.packageId);
    const registeredCapabilities = [...new Set([
      ...(this.#providerRuntime ? ['llm.chat', 'context.source', 'background.lifecycle', 'tts.synthesize', 'stt.transcribe'] : []),
      ...(this.#host ? discoverInstalledPackages(this.#hostRoot).packages.flatMap(item => item.manifest.plugins.flatMap(plugin => plugin.capabilities.map(capability => capability.capabilityId))) : []),
    ])].sort();
    return Object.freeze({
      hostAvailable: !!this.#host,
      flowAvailable: !!this.#flowRuntime(),
      installedCount: pkgs.length,
      loadedPackages: Object.freeze(loadedPackages),
      activePackages: Object.freeze(activePackages),
      registeredCapabilities: Object.freeze(registeredCapabilities),
    });
  }

  liveHost(): import('../plugins/host-runtime.js').PackageHost | null { return this.#host ?? null; }
  liveFlow(): FlowRuntime | null { return this.#flowRuntime() ?? null; }
  liveProviderRuntime(): import('../plugins/provider-runtime.js').ProviderRuntime | null { return this.#providerRuntime ?? null; }
  importPackage(sourceRoot: string): Next65PackageView { const update = this.#lifecycle.stageUpdate(sourceRoot); return this.packages().find(item => item.packageId === update.packageId)!; }
  disable(packageId: string): LifecycleImpact { return this.#lifecycle.disable(packageId); }
  stageUpdate(sourceRoot: string): LifecycleUpdate { return this.#lifecycle.stageUpdate(sourceRoot); }
  applyRestart(packageId: string): LifecycleImpact { return this.#lifecycle.applyPendingOnRestart(packageId); }
  uninstall(packageId: string): void { this.#lifecycle.uninstall(packageId); }
  validateProfile(profile: FlowProfile): readonly { readonly path: string; readonly detail: string }[] {
    const flow = this.#flowRuntime();
    return flow ? flow.validate(profile) : validateFlowProfile(profile);
  }
  previewProfile(profile: FlowProfile): readonly { readonly nodeId: string; readonly capabilityId: string | null; readonly dependsOn: readonly string[] }[] {
    const flow = this.#flowRuntime();
    if (!flow) throw new Error('Flow runtime is not available in this backend session');
    return flow.preview(profile);
  }
  saveProfile(profile: FlowProfile, expectedRevision: number): Next65ProfileRecord {
    const profiles = this.#readProfiles(); const prior = profiles[profile.profileId]; if (prior && prior.profile.revision !== expectedRevision) throw new Error(`profile revision conflict: expected ${expectedRevision}, current ${prior.profile.revision}`);
    const issues = this.validateProfile(profile); if (issues.length) throw new Error(`profile refused: ${issues[0]!.detail}`);
    const saved = { profile: structuredClone(profile), updatedAt: new Date().toISOString() }; this.#writeProfiles({ ...profiles, [profile.profileId]: saved });
    if (this.activeProfile()?.profileId === profile.profileId) this.#writeActiveProfile(null);
    return saved;
  }
  profiles(): readonly Next65ProfileRecord[] { return Object.values(this.#readProfiles()); }
  activeProfile(): { readonly profileId: string; readonly revision: number; readonly activatedAt: string } | null {
    if (!existsSync(this.#activeProfilePath)) return null;
    const value = JSON.parse(readFileSync(this.#activeProfilePath, 'utf8')) as { profileId?: unknown; revision?: unknown; activatedAt?: unknown } | null;
    if (!value) return null;
    if (typeof value.profileId !== 'string' || !Number.isSafeInteger(value.revision) || typeof value.activatedAt !== 'string') throw new Error('active flow profile state is invalid');
    return Object.freeze({ profileId: value.profileId, revision: value.revision as number, activatedAt: value.activatedAt });
  }
  activateProfile(profileId: string, expectedRevision: number): { readonly profileId: string; readonly revision: number; readonly activatedAt: string } {
    const saved = this.#readProfiles()[profileId];
    if (!saved) throw new Error('flow profile not found');
    if (saved.profile.revision !== expectedRevision) throw new Error(`profile revision conflict: expected ${expectedRevision}, current ${saved.profile.revision}`);
    this.#assertConversationProfile(saved.profile);
    const issues = this.validateProfile(saved.profile);
    if (issues.length) throw new Error(`profile refused: ${issues[0]!.detail}`);
    this.#assertEnabledBindings(saved.profile);
    const active = Object.freeze({ profileId, revision: saved.profile.revision, activatedAt: new Date().toISOString() });
    this.#writeActiveProfile(active);
    return active;
  }
  async runActiveConversationFlow(scope: { readonly characterId: string; readonly sessionId: string; readonly turnId: string }, query: string, signal: AbortSignal): Promise<{ readonly profileId: string; readonly text: string } | null> {
    const active = this.activeProfile();
    if (!active) return null;
    const saved = this.#readProfiles()[active.profileId];
    if (!saved || saved.profile.revision !== active.revision) throw new Error('active flow profile revision is stale; activate the saved profile again');
    this.#assertConversationProfile(saved.profile);
    this.#assertEnabledBindings(saved.profile);
    const flow = this.#flowRuntime();
    if (!flow) throw new Error('Flow runtime is not available in this backend session');
    const result = await flow.run(saved.profile, { values: { query, text: query, scope }, signal });
    const chunks = Object.values(result.outputs).map(output => output.text).filter((value): value is string => typeof value === 'string' && !!value.trim());
    const joined = chunks.join('\n').slice(0, 4_000);
    return joined ? Object.freeze({ profileId: saved.profile.profileId, text: joined }) : null;
  }
  recordDiagnostic(input: Omit<Next65Diagnostic, 'at' | 'detail'> & { readonly detail?: string }): void {
    const detail = sanitizeDetail(input.detail ?? ''); this.#diagnostics.push({ ...input, at: new Date().toISOString(), detail }); while (this.#diagnostics.length > 200) this.#diagnostics.shift();
  }
  diagnostics(): readonly Next65Diagnostic[] { return this.#diagnostics.map(item => ({ ...item })); }
  #flowRuntime(): FlowRuntime | undefined {
    if (this.#flow) return this.#flow;
    if (!this.#host) return undefined;
    const discovered = discoverInstalledPackages(this.#hostRoot);
    const handlers: FlowStageHandler[] = [];
    for (const item of discovered.packages) for (const plugin of item.manifest.plugins) for (const declaration of plugin.capabilities) {
      handlers.push({
        capabilityId: declaration.capabilityId,
        bindingId: declaration.adapterId,
        execute: async (context, signal) => {
          const providers = await this.#host!.resolve({ pluginId: plugin.pluginId, capabilityId: declaration.capabilityId, bindingId: declaration.adapterId, signal });
          const provider = providers.find(candidate => candidate.adapterId === declaration.adapterId && candidate.execute);
          if (!provider?.execute) throw new Error(`host provider cannot execute ${declaration.capabilityId}/${declaration.adapterId}`);
          const output = await provider.execute(context.inputs, signal);
          if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error(`host provider returned an invalid output for ${declaration.adapterId}`);
          return output as Readonly<Record<string, unknown>>;
        },
      });
    }
    return new FlowRuntime(handlers);
  }
  #assertConversationProfile(profile: FlowProfile): void {
    const issues = profile.nodes.flatMap((node, index) => node.kind === 'capability'
      && (node.capabilityId !== 'context.source' || !['none', 'local_read'].includes(node.sideEffect))
      ? [{ path: `nodes[${index}]`, detail: 'conversation Flow only allows context.source capabilities with none/local_read side effects' }]
      : []);
    if (issues.length) throw new Error(`conversation flow refused: ${issues[0]!.detail}`);
  }
  #assertEnabledBindings(profile: FlowProfile): void {
    const config = readHostConfig(this.#hostRoot);
    if (!config.ok) throw new Error(config.issue.detail);
    const installed = discoverInstalledPackages(this.#hostRoot).packages;
    for (const node of profile.nodes) {
      if (node.kind !== 'capability' || !node.capabilityId) continue;
      const matches = installed.flatMap(item => item.manifest.plugins.flatMap(plugin => plugin.capabilities
        .filter(capability => capability.capabilityId === node.capabilityId && capability.adapterId === node.bindingId)
        .map(capability => ({ item, capability }))));
      if (matches.length !== 1) throw new Error(`flow binding is not a unique installed host capability: ${node.capabilityId}/${node.bindingId}`);
      const match = matches[0]!;
      if (!config.config.packages.some(entry => entry.packageId === match.item.record.packageId && entry.enabled)) throw new Error(`flow package is disabled: ${match.item.record.packageId}`);
      if (node.capabilityId === 'context.source' && (!['none', 'local_read'].includes(match.capability.sideEffect) || node.sideEffect !== match.capability.sideEffect)) {
        throw new Error(`conversation Flow binding is not declared as a matching local-read capability: ${node.bindingId}`);
      }
    }
  }
  #writeActiveProfile(value: { readonly profileId: string; readonly revision: number; readonly activatedAt: string } | null): void {
    const temp = `${this.#activeProfilePath}.next`;
    writeFileSync(temp, value ? JSON.stringify(value, null, 2) + '\n' : 'null\n', 'utf8');
    renameSync(temp, this.#activeProfilePath);
  }
  #readProfiles(): Record<string, Next65ProfileRecord> { if (!existsSync(this.#profilesPath)) return {}; const value = JSON.parse(readFileSync(this.#profilesPath, 'utf8')) as Record<string, Next65ProfileRecord>; return value && typeof value === 'object' ? value : {}; }
  #writeProfiles(value: Record<string, Next65ProfileRecord>): void { const temp = `${this.#profilesPath}.next`; writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8'); renameSync(temp, this.#profilesPath); }
}

function sanitizeDetail(value: string): string { return value.replace(/(?:api[_-]?key|authorization|credential(?:Ref|Id)?|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').slice(0, 500); }
