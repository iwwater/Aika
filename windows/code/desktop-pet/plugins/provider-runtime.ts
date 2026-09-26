/** K65-02A: multi-source adapter registry, binding resolution and instance leases. */
import {
  DEPLOYMENT_OWNERSHIP, effectiveFeatures, instanceKey,
  type AdapterDescriptor, type Binding, type Deployment, type ModelProfile,
  type ResolvedBinding, type SourceInstance,
} from '../contracts/provider-source.js';
import type { CapabilitySchema } from '../contracts/provider-source.js';
import type { PluginErrorCategory, PluginIssue } from '../contracts/plugin.js';
import type { SecretStore } from '../contracts/plugin.js';
import { validateAdapterDescriptor, validateBinding, validateModelProfile, validateSourceInstance } from './manifest.js';

export interface SourceLifecycle {
  readonly start?: (source: SourceInstance, profile: ModelProfile, binding: ResolvedBinding) => void | Promise<void>;
  readonly stop?: (source: SourceInstance, profile: ModelProfile, binding: ResolvedBinding) => void | Promise<void>;
}

export interface ProviderRuntimeOptions {
  readonly secrets?: SecretStore;
  readonly lifecycle?: Readonly<Record<string, SourceLifecycle>>;
}

export interface ProviderHealth {
  readonly instanceKey: string;
  readonly state: 'ready' | 'starting' | 'failed' | 'stopped';
  readonly reason?: string;
  readonly checkedAt: number;
}

export interface ProviderLease {
  readonly binding: ResolvedBinding;
  readonly release: () => Promise<void>;
}

export interface ProviderCallOptions {
  /** Cancels queued work immediately and aborts an active adapter call. */
  readonly signal?: AbortSignal;
  /** Per-call ceiling; the source declaration remains the hard upper bound. */
  readonly timeoutMs?: number;
}

export type ProviderOperation<T> = (binding: ResolvedBinding, signal: AbortSignal) => T | Promise<T>;

export class ProviderRuntimeError extends Error {
  readonly category: PluginErrorCategory;
  readonly issue: PluginIssue;
  constructor(category: PluginErrorCategory, path: string, detail: string) { super(detail); this.name = 'ProviderRuntimeError'; this.category = category; this.issue = { category, path, detail }; }
}

interface InstanceState { readonly binding: ResolvedBinding; readonly source: SourceInstance; readonly profile: ModelProfile; readonly lifecycle: SourceLifecycle | undefined; references: number; start?: Promise<void>; state: 'starting' | 'ready' | 'failed' | 'stopped'; reason?: string; }
interface CallWaiter { readonly signal: AbortSignal | undefined; readonly grant: () => void; readonly refuse: (error: ProviderRuntimeError) => void; readonly isSettled: () => boolean; readonly onAbort?: () => void; }
interface SourceCallQueue { active: number; pending: CallWaiter[]; }

const fail = (category: PluginErrorCategory, path: string, detail: string): never => { throw new ProviderRuntimeError(category, path, detail); };
const shape = (value: unknown): string => JSON.stringify(value);

export class ProviderRuntime {
  private readonly adapters = new Map<string, AdapterDescriptor>();
  private readonly sources = new Map<string, SourceInstance>();
  private readonly profiles = new Map<string, ModelProfile>();
  private readonly bindings = new Map<string, Binding>();
  private readonly instances = new Map<string, InstanceState>();
  private readonly healthStates = new Map<string, ProviderHealth>();
  private readonly callQueues = new Map<string, SourceCallQueue>();
  private readonly secrets: SecretStore;
  private readonly lifecycles: Readonly<Record<string, SourceLifecycle>>;

  constructor(options: ProviderRuntimeOptions = {}) {
    this.secrets = options.secrets ?? { has: () => false, resolve: () => null, list: () => [] };
    this.lifecycles = options.lifecycle ?? {};
  }

  registerAdapter(adapter: AdapterDescriptor): void {
    const issues = validateAdapterDescriptor(adapter);
    if (issues.length) fail(issues[0]!.category, issues[0]!.path, issues[0]!.detail);
    const prior = this.adapters.get(adapter.adapterId);
    if (prior && shape(prior) !== shape(adapter)) fail('capability_conflict', `adapter.${adapter.adapterId}`, 'adapter identity is already registered with different content');
    if (!prior) this.adapters.set(adapter.adapterId, structuredClone(adapter));
  }

  saveSource(source: SourceInstance): void {
    const issues = validateSourceInstance(source);
    if (issues.length) fail(issues[0]!.category, issues[0]!.path, issues[0]!.detail);
    const adapter = this.adapters.get(source.adapterId);
    if (!adapter || adapter.adapterVersion !== source.adapterVersion) fail('dependency_unsatisfied', 'source.adapterId', `adapter ${source.adapterId}@${source.adapterVersion} is not registered`);
    if (!adapter!.deployments.includes(source.deployment)) fail('capability_unsupported', 'source.deployment', `adapter ${source.adapterId} does not support ${source.deployment}`);
    this.sources.set(source.sourceId, structuredClone(source));
  }

  saveModelProfile(profile: ModelProfile): void {
    const issues = validateModelProfile(profile);
    if (issues.length) fail(issues[0]!.category, issues[0]!.path, issues[0]!.detail);
    const source = this.sources.get(profile.sourceId);
    if (!source) fail('dependency_unsatisfied', 'modelProfile.sourceId', `source ${profile.sourceId} is not registered`);
    if (!this.adapterSchema(source!, profile.capabilityId)) fail('capability_unsupported', 'modelProfile.capabilityId', `adapter ${source!.adapterId} does not provide ${profile.capabilityId}`);
    this.profiles.set(profile.modelProfileId, structuredClone(profile));
  }

  saveBinding(binding: Binding): void {
    const issues = validateBinding(binding);
    if (issues.length) fail(issues[0]!.category, issues[0]!.path, issues[0]!.detail);
    const profile = this.profiles.get(binding.modelProfileId);
    if (!profile) fail('dependency_unsatisfied', 'binding.modelProfileId', `model profile ${binding.modelProfileId} is not registered`);
    if (profile!.capabilityId !== binding.capabilityId) fail('capability_conflict', 'binding.capabilityId', 'binding capability differs from model profile capability');
    this.bindings.set(binding.bindingId, structuredClone(binding));
  }

  removeBinding(bindingId: string): void { this.bindings.delete(bindingId); }
  getAdapter(adapterId: string): AdapterDescriptor | null { return this.adapters.get(adapterId) ?? null; }
  getSource(sourceId: string): SourceInstance | null { return this.sources.get(sourceId) ?? null; }
  getHealth(instanceKeyValue: string): ProviderHealth | null { return this.healthStates.get(instanceKeyValue) ?? null; }

  resolveBinding(bindingId: string, overrides: Readonly<Record<string, unknown>> = {}): ResolvedBinding {
    const binding = this.bindings.get(bindingId);
    if (!binding) fail('dependency_unsatisfied', 'bindingId', `binding ${bindingId} is not registered`);
    const profile = this.profiles.get(binding!.modelProfileId);
    if (!profile) fail('dependency_unsatisfied', 'modelProfileId', `model profile ${binding!.modelProfileId} is not registered`);
    const source = this.sources.get(profile!.sourceId);
    if (!source) fail('dependency_unsatisfied', 'sourceId', `source ${profile!.sourceId} is not registered`);
    const adapter = this.adapters.get(source!.adapterId);
    if (!adapter) fail('dependency_unsatisfied', 'adapterId', `adapter ${source!.adapterId} is not registered`);
    const schema = this.adapterSchema(source!, binding!.capabilityId);
    if (!schema) fail('capability_unsupported', 'capabilityId', `adapter ${adapter!.adapterId} does not provide ${binding!.capabilityId}`);
    if (source!.enablement !== 'enabled') fail('lifecycle_violation', 'source.enablement', `source ${source!.sourceId} is disabled`);
    const credentialRef = source!.auth.kind === 'credentialRef' ? source!.auth.ref ?? null : null;
    if (source!.deployment === 'remote-api' && (!credentialRef || !this.secrets.has(credentialRef, source!.auth.provider ?? adapter!.protocol))) fail('auth_required_missing', 'source.auth', `credential for ${source!.sourceId} is not configured`);
    const effectiveParameters = { ...(source!.parameters[binding!.capabilityId] ?? {}), ...profile!.parameters, ...overrides };
    const allowed = new Set([...schema!.parameters.map(parameter => parameter.name), ...adapter!.proprietaryParameters]);
    for (const parameter of Object.keys(effectiveParameters)) if (!allowed.has(parameter)) fail('unsupported_parameter', `parameters.${parameter}`, `parameter ${parameter} is not declared by ${binding!.capabilityId}`);
    const features = effectiveFeatures(schema!, profile!.capabilityOverrides);
    if (profile!.capabilityOverrides.streaming === true && !features.streaming) fail('capability_unsupported', 'capabilityOverrides.streaming', 'streaming is not supported by this adapter');
    const result: ResolvedBinding = {
      bindingId: binding!.bindingId, bindingRevision: binding!.revision, capabilityId: binding!.capabilityId,
      contractVersion: adapter!.contractVersion, packageId: adapter!.packageId, adapterId: adapter!.adapterId, adapterVersion: adapter!.adapterVersion,
      sourceId: source!.sourceId, sourceConfigRevision: source!.configRevision, deployment: source!.deployment,
      modelProfileId: profile!.modelProfileId, modelProfileRevision: profile!.revision, nativeModelId: profile!.nativeModelId, nativeVoiceId: profile!.nativeVoiceId,
      effectiveParameters: Object.freeze({ ...effectiveParameters, streaming: features.streaming, cancellable: features.cancellable }),
      credentialRef, sideEffect: source!.deployment === 'remote-api' ? 'network_egress' : source!.deployment === 'managed-local' ? 'process_lifecycle' : 'none',
      limits: source!.limits,
      instanceKey: instanceKey({ sourceId: source!.sourceId, sourceConfigRevision: source!.configRevision, adapterId: adapter!.adapterId, adapterVersion: adapter!.adapterVersion, nativeModelId: profile!.nativeModelId, nativeVoiceId: profile!.nativeVoiceId }),
    };
    return Object.freeze(result);
  }

  async acquire(bindingId: string, overrides: Readonly<Record<string, unknown>> = {}): Promise<ProviderLease> {
    const binding = this.resolveBinding(bindingId, overrides);
    let state = this.instances.get(binding.instanceKey);
    const source = this.sources.get(binding.sourceId)!;
    const profile = this.profiles.get(binding.modelProfileId)!;
    if (!state) {
      state = { binding, source, profile, lifecycle: this.lifecycles[source.sourceId], references: 0, state: 'starting' };
      this.instances.set(binding.instanceKey, state);
      this.healthStates.set(binding.instanceKey, { instanceKey: binding.instanceKey, state: 'starting', checkedAt: Date.now() });
      if (source.deployment === 'managed-local') {
        if (!state.lifecycle?.start) return this.failStart(state, 'managed-local source has no start lifecycle');
        state.start = Promise.resolve(state.lifecycle.start(source, profile, binding));
        try { await state.start; } catch (error) { return this.failStart(state, (error as Error).message); }
      }
      state.state = 'ready';
      this.healthStates.set(binding.instanceKey, { instanceKey: binding.instanceKey, state: 'ready', checkedAt: Date.now() });
    } else if (state.start) await state.start;
    state.references += 1;
    let released = false;
    return { binding, release: async () => { if (released) return; released = true; await this.releaseState(state!); } };
  }

  /** Execute one selected binding with bounded per-source concurrency and explicit cancellation. */
  async call<T>(bindingId: string, operation: ProviderOperation<T>, options: ProviderCallOptions = {}): Promise<T> {
    if (options.signal?.aborted) fail('lifecycle_violation', 'call.signal', 'provider call was cancelled before it was queued');
    const lease = await this.acquire(bindingId);
    let queue: SourceCallQueue;
    try { queue = await this.enterCall(lease.binding.sourceId, lease.binding.limits, options.signal, options.timeoutMs); }
    catch (error) { await lease.release(); throw error; }
    const controller = new AbortController();
    const relay = () => controller.abort(options.signal?.reason ?? new Error('provider call cancelled'));
    const timer = setTimeout(() => controller.abort(new Error('provider call timed out')), Math.max(1, Math.min(options.timeoutMs ?? lease.binding.limits.callTimeoutMs, lease.binding.limits.callTimeoutMs)));
    const late = Promise.resolve().then(() => operation(lease.binding, controller.signal));
    try {
      options.signal?.addEventListener('abort', relay, { once: true });
      if (options.signal?.aborted) relay();
      const result = await Promise.race([late, new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new ProviderRuntimeError('lifecycle_violation', 'call', controller.signal.reason instanceof Error ? controller.signal.reason.message : 'provider call cancelled')), { once: true });
      })]);
      if (controller.signal.aborted) fail('lifecycle_violation', 'call', 'provider call was cancelled or timed out');
      return result as T;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', relay);
      late.catch(() => undefined);
      this.leaveCall(lease.binding.sourceId, queue);
      await lease.release();
    }
  }

  health(): readonly ProviderHealth[] { return [...this.healthStates.values()].sort((a, b) => a.instanceKey.localeCompare(b.instanceKey)); }

  private async enterCall(sourceId: string, limits: ResolvedBinding['limits'], signal: AbortSignal | undefined, timeoutMs: number | undefined): Promise<SourceCallQueue> {
    const queue = this.callQueues.get(sourceId) ?? { active: 0, pending: [] };
    this.callQueues.set(sourceId, queue);
    if (signal?.aborted) fail('lifecycle_violation', 'call.signal', 'provider call was cancelled while it was queued');
    if (queue.active < limits.maxConcurrentCalls) { queue.active += 1; return queue; }
    if (queue.pending.length >= limits.maxQueueDepth) fail('resource_missing', `source.${sourceId}.queue`, 'provider call queue is full');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refuse = (error: ProviderRuntimeError) => {
        if (!settled) {
          settled = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          // A timed-out waiter no longer occupies queue capacity. Cancellation keeps its tombstone
          // until the active call releases so a concurrent caller cannot leapfrog a settled request.
          if (error.issue.path === 'call' && error.issue.detail.includes('timed out')) {
            const index = queue.pending.indexOf(waiter);
            if (index >= 0) queue.pending.splice(index, 1);
          }
          reject(error);
        }
      };
      const onAbort = () => refuse(new ProviderRuntimeError('lifecycle_violation', 'call.signal', 'provider call was cancelled while it was queued'));
      const grant = () => { if (!settled) { settled = true; if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(); } };
      const boundedTimeout = Math.max(1, Math.min(timeoutMs ?? limits.callTimeoutMs, limits.callTimeoutMs));
      const waiter: CallWaiter = { signal, grant, refuse, isSettled: () => settled, onAbort };
      queue.pending.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => refuse(new ProviderRuntimeError('lifecycle_violation', 'call', 'provider call timed out while queued')), boundedTimeout);
    });
    queue.active += 1;
    return queue;
  }

  private leaveCall(sourceId: string, queue: SourceCallQueue): void {
    queue.active = Math.max(0, queue.active - 1);
    while (queue.pending.length && queue.active < Number.MAX_SAFE_INTEGER) {
      const waiter = queue.pending.shift()!;
      if (waiter.signal?.aborted || waiter.isSettled()) { waiter.refuse(new ProviderRuntimeError('lifecycle_violation', 'call.signal', 'provider call was cancelled while it was queued')); continue; }
      waiter.grant();
      break;
    }
    if (!queue.active && !queue.pending.length) this.callQueues.delete(sourceId);
  }

  private async releaseState(state: InstanceState): Promise<void> {
    state.references -= 1;
    if (state.references > 0) return;
    if (state.source.deployment === 'managed-local' && state.lifecycle?.stop) await state.lifecycle.stop(state.source, state.profile, state.binding);
    state.state = 'stopped';
    this.healthStates.set(state.binding.instanceKey, { instanceKey: state.binding.instanceKey, state: 'stopped', checkedAt: Date.now() });
    this.instances.delete(state.binding.instanceKey);
  }

  private failStart(state: InstanceState, reason: string): never { state.state = 'failed'; state.reason = reason; this.healthStates.set(state.binding.instanceKey, { instanceKey: state.binding.instanceKey, state: 'failed', reason, checkedAt: Date.now() }); this.instances.delete(state.binding.instanceKey); return fail('resource_missing', `source.${state.source.sourceId}`, `source startup failed: ${reason}`); }
  private adapterSchema(source: SourceInstance, capabilityId: string): CapabilitySchema | null { return this.adapters.get(source.adapterId)?.capabilitySchemas.find(schema => schema.capabilityId === capabilityId) ?? null; }
}

export const deploymentOwnership = (deployment: Deployment): 'host' | 'user' | 'package-adapter' => DEPLOYMENT_OWNERSHIP[deployment];

async function listData(_root: string): Promise<readonly string[]> { return []; }
