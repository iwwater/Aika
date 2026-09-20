// Aika console routes for the upstream management server: profile, provider configs and the chat timeline.
// Provider payloads never carry credential material; timeline queries are read-only and session-scoped.
import { ManagementError } from '../contracts/management.js';
import { validateAikaProfile, validateAikaProviderConfigs, type AikaProfile, type AikaProfileStore, type AikaProviderConfig } from './aika-profile.js';
import type { AikaTimelineStore } from './aika-timeline.js';

export interface AikaProfilePort {
  revision(): number;
  loadProfile(): AikaProfile;
  save(expectedRevision: number, profile: unknown, providers: unknown): Promise<{ revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] }>;
}

export interface AikaManagement {
  profile(): { revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] };
  saveProfile(expectedRevision: number, profile: unknown, providers: unknown): Promise<{ revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] }>;
  timeline(query: { sessionId: string; cursor?: string; limit: number }): Promise<{ items: unknown[]; nextCursor?: string }>;
}

export function aikaManagement(profileStore: AikaProfileStore, timelineStore: AikaTimelineStore): AikaManagement {
  return {
    profile: () => ({ revision: profileStore.revision(), profile: profileStore.loadProfile(), providers: profileStore.providers() }),
    saveProfile: (expectedRevision, profile, providers) => profileStore.save(expectedRevision, profile, providers),
    timeline: query => timelineStore.list(query)
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
  throw new ManagementError('not_found', '没有这个 Aika 接口。');
}

// Validation helpers are re-exported so the console presenter and routes share one boundary.
export { validateAikaProfile, validateAikaProviderConfigs };
