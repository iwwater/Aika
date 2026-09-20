import type {BalanceSnapshot} from './balances.js';
import type { CharacterId } from './index.js';

/** Local management HTTP API v1. No credential contents or private filesystem paths. */
export const MANAGEMENT_API_VERSION = 1 as const;
export type ProviderSlot = 'asr' | 'dialogue' | 'memory_turn' | 'summary' | 'perception' | 'tts' | 'admission';
/** Wire protocol actually implemented for a slot. A custom model on a supported protocol is accepted. */
export type ProviderProtocol = 'openai-compatible' | 'gemini';
/** Free-form provider identity. Presets are 'dashscope' and 'deepseek'; custom endpoints may use any id. */
export type ProviderId = string;
/** Provider identity accepted by the credential registry and the settings boundary. */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const isProviderId = (value: unknown): value is ProviderId => typeof value === 'string' && PROVIDER_ID.test(value);
export interface ProviderSelection {
  adapterId: string;
  /**
   * The configured wire protocol; the adapter is instantiated from this, not from the model name.
   * Optional only so a settings file written before FIX61-01 still loads: validateManagedSettings
   * normalizes an absent value to the adapter's declared protocol before the value is used anywhere.
   */
  protocol?: ProviderProtocol;
  provider: ProviderId;
  model: string;
  endpoint: string;
  credentialRef: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  reservationMicros: number;
  inputMicrosPerToken: number;
  outputMicrosPerToken: number;
  characterMicros?: number;
  audioMicrosPerSecond?: number;
  thinking?: 'high';
  voice?: string;
  language?: string;
  temperature?: number;
}
export interface ContextSettings {
  maxRecentMessages: number;
  maxMemories: number;
  summaryLimit: number;
  summaryMinMessages: number;
  summaryMaxMessages: number;
  timeoutMs: number;
}
export interface ManagedSettings {
  providers: Record<Exclude<ProviderSlot, 'asr'>, ProviderSelection> & Partial<Record<'asr', ProviderSelection>>;
  context: ContextSettings;
}
export interface SettingsSnapshot {
  revision: number;
  effectiveRevision: number;
  savedAt: string | null;
  pending: boolean;
  applyOn: 'restart';
  effective: ManagedSettings;
  saved: ManagedSettings;
  history: readonly { revision: number; savedAt: string }[];
}
export interface ProviderAdapterInfo {
  id: string;
  label: string;
  slots: readonly ProviderSlot[];
  provider: ProviderSelection['provider'];
  endpoints: readonly string[];
  modelHint: string;
  models: readonly string[];
  /** Reviewed model-specific defaults and tariffs; credential contents never belong here. */
  choices?: readonly { label: string; configuration: Omit<ProviderSelection, 'credentialRef'>; voices?: readonly { id: string; label: string }[] }[];
  capabilities: { instructions: boolean; cloning: boolean; voice: boolean; language: boolean; temperature: boolean };
  status: 'available' | 'not_integrated';
  note: string;
  /**
   * True for the capability-only adapters that serve any model on their protocol. An open adapter
   * declares no model white-list and accepts any registered provider id; reviewed adapters keep
   * their exact preset and provider binding.
   */
  open?: true;
}
export interface CredentialInfo {
  readonly provider?: ProviderId;
  readonly managed?: boolean; id: string; label: string; status: 'configured' | 'missing' | 'unavailable'; masked: string }
export interface RuntimeModule {
  id: string;
  label: string;
  status: 'ready' | 'busy' | 'error' | 'unavailable' | 'unknown';
  detail: string;
  providerSlot?: ProviderSlot;
  sharedWith?: string;
  activeJobs: number;
  calls: number;
  lastElapsedMs: number | null;
  lastError: string | null;
  lastObservedAt: string | null;
}
export interface RuntimeEvent {
  id: number;
  at: string;
  moduleId: string;
  kind: 'started' | 'completed' | 'failed' | 'cancelled' | 'state';
  characterId: CharacterId | null;
  elapsedMs: number | null;
  message: string;
}
export interface ManagementSnapshot {
  readonly balances?: BalanceSnapshot;
  readonly accounting?: {readonly mode:'bounded'|'unlimited';readonly limitMicros:number|null;readonly knownMicros:number;readonly unknownReservedMicros:number;readonly pendingReservedMicros:number};
  apiVersion: 1;
  runtime: { instanceId: string; pid: number; sourceRevision: string; startedAt: string; observedAt: string; characterId: CharacterId; sessionId: string; online: true };
  modules: readonly RuntimeModule[];
  events: readonly RuntimeEvent[];
  settings: SettingsSnapshot;
  adapters: readonly ProviderAdapterInfo[];
  credentials: readonly CredentialInfo[];
  characters: readonly { id: CharacterId; label: string; revision: number }[];
}
export type ManagedRecordKind = 'memory' | 'transcript' | 'summary' | 'keyword_index' | 'vector_index' | 'context_cache';
export interface ManagedRecord {
  characterId: CharacterId;
  id: string;
  kind: ManagedRecordKind;
  version: number;
  state: 'active' | 'invalidated' | 'deleted' | 'expired' | 'purged';
  text: string;
  createdAt: string;
  role: 'user' | 'assistant' | null;
  sources: readonly { id: string; version: number }[];
  editable: boolean;
  origin: 'conversation' | 'automatic' | 'manual';
}
export interface RecordQuery { characterId: CharacterId; kind: ManagedRecordKind; query: string; offset: number; limit: number; state: 'active' | 'all' }
export interface RecordPage { characterId: CharacterId; revision: number; records: readonly ManagedRecord[]; total: number; offset: number; limit: number }
export interface RecordEdit { characterId: CharacterId; id: string; expectedVersion: number; operationId: string; text: string; reason: string }
export interface RecordEditResult {
  status: 'applied'; characterId: CharacterId; operationId: string; revision: number; record: ManagedRecord; invalidatedIds: readonly string[];
}
export interface ManagedContext {
  characterId: CharacterId;
  revision: number;
  query: string;
  prompt: string;
  recent: readonly ManagedRecord[];
  summaries: readonly ManagedRecord[];
  memories: readonly ManagedRecord[];
  note: string;
}
/** Implemented by memory owner against the same live business store, never direct HTTP SQL. */
export interface ManagementMemoryPort {
  readonly dynamics?: import('./memory-dynamics.js').MemoryDynamicsManagementPort;
  characters(): readonly { id: CharacterId; label: string; revision: number }[];
  list(query: RecordQuery): RecordPage;
  edit(input: RecordEdit): RecordEditResult;
  context(characterId: CharacterId, query: string): ManagedContext | Promise<ManagedContext>;
  prompt(characterId: CharacterId): { characterId: CharacterId; revision: number; text: string };
  savePrompt(input: { characterId: CharacterId; expectedRevision: number; text: string; operationId: string }): { characterId: CharacterId; revision: number; text: string };
}
export type ManagementErrorCode = 'unauthorized' | 'forbidden' | 'invalid_request' | 'not_found' | 'version_conflict' | 'unavailable' | 'internal_error';
export class ManagementError extends Error {
  constructor(readonly code: ManagementErrorCode, message: string) { super(message); this.name = 'ManagementError'; }
}

/* Same-origin HTTP routes, all require Authorization: Bearer <local session token>:
 GET  /api/snapshot -> ManagementSnapshot
 GET  /api/records?characterId=&kind=&query=&offset=&limit=&state= -> RecordPage
 POST /api/records/edit (RecordEdit) -> RecordEditResult
 GET  /api/context?characterId=&query= -> ManagedContext
 GET  /api/prompt?characterId= -> {characterId,revision,text}
 PUT  /api/prompt {characterId,expectedRevision,text,operationId} -> same
 PUT  /api/settings {expectedRevision,settings:ManagedSettings} -> SettingsSnapshot
 POST /api/settings/rollback {expectedRevision,targetRevision} -> SettingsSnapshot
 Error: {error:{code,message}} with 409 for conflict, 400 validation, 401/403 access.
 Settings are persisted immediately; only a fresh backend instance applies them.
 Editing records/prompt invalidates affected retrieval/context in the live store.
 There is no arbitrary SQL, file path, URL proxy, device or model-call endpoint.
 */
