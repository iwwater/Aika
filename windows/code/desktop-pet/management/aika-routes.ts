// Aika console routes for the upstream management server: profile, provider configs, model discovery and the chat timeline.
// Provider payloads never carry credential material; the discovery plane resolves the key server-side and only
// ever caches a credential reference. Timeline queries are read-only and session-scoped.
//
// FIX61-02 design boundary: this plane holds NO slot->model binding. "Which model serves which slot" has exactly
// one source of truth, ManagedSettings.providers in management-settings.json (ManagementSettingsStore), and the
// discovery plane only remembers which endpoint was queried and what its models resource answered.
import { ManagementError } from '../contracts/management.js';
import { validateAikaProfile, validateAikaProviderConfigs, type AikaProfile, type AikaProfileStore, type AikaProviderConfig } from './aika-profile.js';
import type { AikaTimelineStore } from './aika-timeline.js';
import { ModelDiscovery, managementFailure, type ModelDiscoveryResult } from './model-discovery.js';
import { AikaDiscoveryDraftStore, validateSelection, type DiscoverySelection, type StoredDiscoveryDraft } from './model-discovery-draft.js';

export interface AikaProfilePort {
  revision(): number;
  loadProfile(): AikaProfile;
  save(expectedRevision: number, profile: unknown, providers: unknown): Promise<{ revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] }>;
}

/** What the page shows for one discovered model. Capability evidence is never upgraded by guessing. */
export interface DiscoveryItemView { readonly id: string; readonly label: string; readonly capabilities: { readonly methods: readonly string[]; readonly evidence: 'declared' | 'unknown' } }
export interface DiscoveryView {
  readonly protocol: 'openai-compatible' | 'gemini';
  readonly endpoint: string;
  readonly modelsEndpoint: string | null;
  readonly credentialRef: string | null;
  readonly revision: number;
  readonly items: readonly DiscoveryItemView[];
  readonly checkedAt: string | null;
  readonly truncated: boolean;
  /** True while the current source has no successful discovery behind it; a manual model name is always allowed. */
  readonly stale: boolean;
  readonly note: string;
}
export interface AikaDiscoveryPort {
  draft(): Promise<StoredDiscoveryDraft>;
  select(expectedRevision: number, selection: DiscoverySelection): Promise<StoredDiscoveryDraft>;
  discover(selection: DiscoverySelection): Promise<ModelDiscoveryResult>;
}
export interface AikaManagement {
  profile(): { revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] };
  saveProfile(expectedRevision: number, profile: unknown, providers: unknown): Promise<{ revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] }>;
  timeline(query: { sessionId: string; cursor?: string; limit: number }): Promise<{ items: unknown[]; nextCursor?: string }>;
  discoveryDraft(): Promise<DiscoveryView>;
  selectDiscovery(expectedRevision: number, selection: DiscoverySelection): Promise<DiscoveryView>;
  discoverModels(selection: DiscoverySelection): Promise<DiscoveryView>;
}

const DISCOVERY_NOTE = '模型列表只证明该列表可以访问，不代表指定型号能完成推理，也不代表任何语音或图像能力。';

export function discoveryView(draft: StoredDiscoveryDraft): DiscoveryView {
  return { protocol: draft.protocol, endpoint: draft.endpoint, modelsEndpoint: draft.modelsEndpoint, credentialRef: draft.credentialRef,
    revision: draft.revision, items: draft.objects.map(entry => ({ id: entry.value, label: entry.label, capabilities: { methods: entry.methods, evidence: entry.evidence } })),
    checkedAt: draft.observedAt, truncated: draft.truncated, stale: draft.observedAt === null, note: DISCOVERY_NOTE };
}

/**
 * The discovery plane the console talks to. It wraps the transport-level ModelDiscovery with the durable
 * draft cache and with the in-flight isolation the SPEC requires: a request that is no longer the newest one
 * for this management plane can never publish its (possibly slower) answer over a newer one.
 */
export class ModelDiscoveryService implements AikaDiscoveryPort {
  private generation = 0;
  private readonly listeners = new Set<(draft: StoredDiscoveryDraft) => void>();
  constructor(private readonly options: { credentials: import('./model-discovery.js').DiscoveryCredentials; fetch?: typeof fetch; draft: AikaDiscoveryDraftStore; timeoutMs?: number }) {}
  draft(): Promise<StoredDiscoveryDraft> { return Promise.resolve(this.options.draft.snapshot()); }
  select(expectedRevision: number, selection: DiscoverySelection): Promise<StoredDiscoveryDraft> { return this.options.draft.select(expectedRevision, selection); }
  /** Lets the production composition root republish the cache to whoever is serving the console. */
  onChange(listener: (draft: StoredDiscoveryDraft) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async discover(selection: DiscoverySelection): Promise<ModelDiscoveryResult> {
    if (!selection.credentialRef) throw new ManagementError('invalid_request', '请先在本机保存该服务的 API Key，再获取模型列表；也可以直接手工填写型号名。');
    const generation = ++this.generation;
    const result = await new ModelDiscovery({ credentials: this.options.credentials, ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }) })
      .list({ protocol: selection.protocol, endpoint: selection.endpoint, credentialRef: selection.credentialRef,
        ...(selection.modelsEndpoint ? { modelsEndpoint: selection.modelsEndpoint } : {}) }).catch(error => { throw managementFailure(error); });
    // A superseded request must not publish: the newer one already owns the cache and every subscriber.
    if (generation !== this.generation) return result;
    const draft = await this.options.draft.observe({ ...selection, items: result.items, checkedAt: result.checkedAt, truncated: result.truncated });
    for (const listener of [...this.listeners]) listener(draft);
    return result;
  }
}

function emptyDraft(): StoredDiscoveryDraft {
  return { version: 1, revision: 0, protocol: 'openai-compatible', endpoint: '', modelsEndpoint: null, credentialRef: null, objects: [], observedAt: null, truncated: false };
}

export function aikaManagement(profileStore: AikaProfileStore, timelineStore: AikaTimelineStore, discovery?: AikaDiscoveryPort): AikaManagement {
  const draft = () => discovery ? discovery.draft().then(discoveryView) : Promise.resolve(discoveryView(emptyDraft()));
  return {
    profile: () => ({ revision: profileStore.revision(), profile: profileStore.loadProfile(), providers: profileStore.providers() }),
    saveProfile: (expectedRevision, profile, providers) => profileStore.save(expectedRevision, profile, providers),
    timeline: query => timelineStore.list(query),
    discoveryDraft: draft,
    async selectDiscovery(expectedRevision, selection) {
      if (!discovery) throw new ManagementError('unavailable', '当前实例尚未接入模型发现。');
      return discoveryView(await discovery.select(expectedRevision, selection));
    },
    async discoverModels(selection) {
      if (!discovery) throw new ManagementError('unavailable', '当前实例尚未接入模型发现。');
      await discovery.discover(selection);
      return draft();
    }
  };
}

export async function aikaRoute(method: string | undefined, port: AikaManagement, pathname: string, query: URLSearchParams, body: () => Promise<Record<string, unknown>>): Promise<unknown> {
  if (pathname === '/api/aika/profile') {
    if (method === 'GET') return port.profile();
    if (method === 'PUT') {
      const payload = await body();
      return port.saveProfile(Number(payload.expectedRevision), payload.profile, payload.providers ?? []);
    }
    throw new ManagementError('not_found', '没有这个 Aika 配置操作。');
  }
  if (pathname === '/api/aika/timeline') {
    if (method !== 'GET') throw new ManagementError('not_found', 'Timeline 只读。');
    const sessionId = query.get('sessionId') ?? '';
    if (!sessionId.trim()) throw new ManagementError('invalid_request', 'sessionId 不能为空。');
    const limitRaw = query.get('limit') === null ? 20 : Number(query.get('limit'));
    if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) throw new ManagementError('invalid_request', 'limit 取 1～100。');
    const cursor = query.get('cursor') ?? undefined;
    return port.timeline({ sessionId, limit: limitRaw, ...(cursor === undefined ? {} : { cursor }) });
  }
  if (pathname === '/api/aika/discovery') {
    if (method === 'GET') return port.discoveryDraft();
    // Discovery is a read of the supplier; it never changes a saved slot binding on its own.
    if (method === 'POST') return port.discoverModels(validateSelection(await body()));
    throw new ManagementError('not_found', '没有这个模型发现操作。');
  }
  if (pathname === '/api/aika/discovery/source') {
    if (method !== 'PUT') throw new ManagementError('not_found', '没有这个模型发现操作。');
    const payload = await body();
    const selection = validateSelection(payload);
    const expectedRevision = payload.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) throw new ManagementError('invalid_request', 'expectedRevision 无效。');
    return port.selectDiscovery(expectedRevision as number, selection);
  }
  throw new ManagementError('not_found', '没有这个 Aika 接口。');
}

// Validation helpers are re-exported so the console presenter and routes share one boundary.
export { validateAikaProfile, validateAikaProviderConfigs };
