// Aika console presenter: pure UI logic for the management panel. It only consumes ports
// (profile/provider config, model discovery, TurnPort, timeline queries); it never calls models,
// never holds a key and never touches Memory.
import type { TurnScope } from '../contracts/index.js';
import type { TurnPortEvent } from '../core/turn-port.js';
import type { AikaProfile, AikaProviderConfig } from './aika-profile.js';
import type { DiscoveryItemView, DiscoveryView } from './aika-routes.js';

export interface AikaConsolePorts {
  profile: {
    load(): Promise<{ revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] }>;
    save(expectedRevision: number, profile: AikaProfile, providers: readonly AikaProviderConfig[]): Promise<{ revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] }>;
  };
  timeline: {
    list(query: { sessionId: string; cursor?: string; limit: number }): Promise<{ items: AikaChatEvent[]; nextCursor?: string }>;
  };
  /**
   * FIX61-02. The presenter only ever receives the model list and the source it came from; the model a
   * slot actually uses is edited on the settings draft, not here.
   */
  discovery: {
    load(): Promise<DiscoveryView | null>;
    saveSource(expectedRevision: number, source: { protocol: 'openai-compatible' | 'gemini'; endpoint: string; modelsEndpoint?: string | null; credentialRef?: string | null }): Promise<DiscoveryView | null>;
    discover(source: { protocol: 'openai-compatible' | 'gemini'; endpoint: string; modelsEndpoint?: string | null; credentialRef?: string | null }): Promise<readonly DiscoveryItemView[]>;
  };
  turn: {
    submit(text: string): Promise<TurnScope>;
    cancel(): void;
    subscribe(listener: (event: TurnPortEvent) => void): () => void;
  };
  voice: { available(): boolean };
}

export interface AikaChatEvent {
  readonly eventId: string;
  readonly scope: TurnScope;
  readonly kind: 'userMessage' | 'assistantTerminal';
  readonly messageId: string;
  readonly text?: string;
  readonly status?: 'completed' | 'cancelled' | 'failed';
}

export type TurnStatus = 'idle' | 'sending' | 'completed' | 'cancelled' | 'failed';

export interface AikaConsoleState {
  readonly session: string;
  readonly profile: AikaProfile | null;
  readonly providers: readonly AikaProviderConfig[];
  readonly profileRevision: number;
  readonly sending: boolean;
  readonly turnStatus: TurnStatus;
  readonly lastError: string | null;
  readonly voiceStatus: 'unavailable' | 'ready';
  readonly timeline: readonly AikaChatEvent[];
  readonly timelineCursor: string | null;
  readonly discoverySource: { protocol: 'openai-compatible' | 'gemini'; endpoint: string; modelsEndpoint: string | null; credentialRef: string | null } | null;
  readonly discoveryRevision: number;
  readonly discoveryItems: readonly DiscoveryItemView[];
  readonly discoveryCheckedAt: string | null;
  readonly discoveryTruncated: boolean;
  readonly discoveryStale: boolean;
  readonly discoveryNote: string | null;
  readonly discoveryError: string | null;
  readonly discovering: boolean;
  /** Per-slot model names typed by hand. They are ordinary form values; no discovery is required. */
  readonly manualModels: Readonly<Record<string, string>>;
}

export class AikaConsolePresenter {
  #session = 'default';
  #profileRevision = 0;
  #profile: AikaProfile | null = null;
  #providers: readonly AikaProviderConfig[] = [];
  #sending = false;
  #turnStatus: TurnStatus = 'idle';
  #lastError: string | null = null;
  #timeline: AikaChatEvent[] = [];
  #timelineCursor: string | null = null;
  #discoveryGeneration = 0;
  #discoverySource: AikaConsoleState['discoverySource'] = null;
  #discoveryRevision = 0;
  #discoveryItems: readonly DiscoveryItemView[] = [];
  #discoveryCheckedAt: string | null = null;
  #discoveryTruncated = false;
  #discoveryStale = true;
  #discoveryNote: string | null = null;
  #discoveryError: string | null = null;
  #discovering = false;
  #manualModels: Record<string, string> = {};
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  constructor(private readonly ports: AikaConsolePorts) {}

  get state(): AikaConsoleState {
    return {
      session: this.#session,
      profile: this.#profile,
      providers: this.#providers,
      profileRevision: this.#profileRevision,
      sending: this.#sending,
      turnStatus: this.#turnStatus,
      lastError: this.#lastError,
      voiceStatus: this.ports.voice.available() ? 'ready' : 'unavailable',
      timeline: [...this.#timeline],
      timelineCursor: this.#timelineCursor,
      discoverySource: this.#discoverySource,
      discoveryRevision: this.#discoveryRevision,
      discoveryItems: [...this.#discoveryItems],
      discoveryCheckedAt: this.#discoveryCheckedAt,
      discoveryTruncated: this.#discoveryTruncated,
      discoveryStale: this.#discoveryStale,
      discoveryNote: this.#discoveryNote,
      discoveryError: this.#discoveryError,
      discovering: this.#discovering,
      manualModels: { ...this.#manualModels }
    };
  }

  async load(): Promise<void> {
    const loaded = await this.ports.profile.load();
    this.#profileRevision = loaded.revision;
    this.#profile = loaded.profile;
    this.#providers = loaded.providers;
  }

  /** Invalid payloads and save failures surface in lastError; success clears it and adopts the revision. */
  async saveProfile(profile: AikaProfile, providers: readonly AikaProviderConfig[]): Promise<void> {
    try {
      const saved = await this.ports.profile.save(this.#profileRevision, profile, providers);
      this.#profileRevision = saved.revision;
      this.#profile = saved.profile;
      this.#providers = saved.providers;
      this.#lastError = null;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** Reads the cached discovery state. Failure is visible but leaves the previous list intact. */
  async loadDiscovery(): Promise<void> {
    const generation = ++this.#discoveryGeneration;
    const loaded = await this.ports.discovery.load();
    if (generation !== this.#discoveryGeneration) return;
    this.#adopt(loaded);
    this.#discoveryError = null;
  }

  /** Records the endpoint/protocol/credential the user wants to list models from. No model is chosen here. */
  async saveDiscoverySource(source: { protocol: 'openai-compatible' | 'gemini'; endpoint: string; modelsEndpoint?: string | null; credentialRef?: string | null }): Promise<void> {
    const generation = ++this.#discoveryGeneration;
    const saved = await this.ports.discovery.saveSource(this.#discoveryRevision, source);
    if (generation !== this.#discoveryGeneration) return;
    this.#adopt(saved);
    this.#discoveryError = null;
  }

  /**
   * Asks the backend to list models. A superseded or slow answer never replaces a newer one; a failure is
   * recorded for the user and the previously discovered list stays selectable.
   */
  async loadDiscoveryModels(source: { protocol: 'openai-compatible' | 'gemini'; endpoint: string; modelsEndpoint?: string | null; credentialRef?: string | null }): Promise<void> {
    const generation = ++this.#discoveryGeneration;
    this.#discovering = true;
    this.#discoveryError = null;
    try {
      const items = await this.ports.discovery.discover(source);
      if (generation !== this.#discoveryGeneration) return;
      this.#discoveryItems = objects(items);
      this.#discoverySource = { protocol: source.protocol, endpoint: source.endpoint, modelsEndpoint: source.modelsEndpoint ?? null, credentialRef: source.credentialRef ?? null };
      this.#discoveryStale = false;
      this.#discoveryCheckedAt = new Date().toISOString();
    } catch (error) {
      if (generation !== this.#discoveryGeneration) return;
      this.#discoveryError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (generation === this.#discoveryGeneration) this.#discovering = false;
    }
  }

  /** A hand-typed model name is an ordinary form value: it never depends on a successful discovery. */
  setManualModel(slot: string, model: string): void { this.#manualModels = { ...this.#manualModels, [slot]: model }; }

  /** Exactly one submit per call; concurrent sends are refused until the turn reaches a terminal state. */
  async sendText(text: string): Promise<TurnScope> {
    if (this.#sending) throw new Error('已有进行中的回复，请先等待完成或取消。');
    if (!text.trim()) throw new Error('消息不能为空。');
    this.#sending = true;
    this.#turnStatus = 'sending';
    this.#lastError = null;
    const scope = await this.ports.turn.submit(text);
    this.#session = scope.sessionId;
    return scope;
  }

  /** Idempotent cancel of the active turn. */
  cancel(): void {
    this.ports.turn.cancel();
  }

  /** Terminal states come only from production turn events; failures allow a fresh send. */
  handleTurnEvent(event: TurnPortEvent): void {
    if (this.#disposed) return;
    if (event.scope.sessionId !== this.#session) return;
    if (event.type === 'terminal') {
      this.#sending = false;
      this.#turnStatus = event.status;
      if (event.status === 'failed') this.#lastError = event.errorCode ?? '本轮失败';
    }
  }

  /** Session switch: older sessions' late results never overwrite the current view. */
  setSession(sessionId: string): void {
    if (sessionId === this.#session) return;
    this.#sending = false;
    this.#turnStatus = 'idle';
    this.#timeline = [];
    this.#timelineCursor = null;
    this.#session = sessionId;
  }

  async loadTimeline(): Promise<void> {
    const page = await this.ports.timeline.list({ sessionId: this.#session, limit: 20 });
    this.#timeline = page.items;
    this.#timelineCursor = page.nextCursor ?? null;
  }

  async loadMoreTimeline(): Promise<void> {
    if (!this.#timelineCursor) return;
    const page = await this.ports.timeline.list({ sessionId: this.#session, cursor: this.#timelineCursor, limit: 20 });
    this.#timeline = [...this.#timeline, ...page.items];
    this.#timelineCursor = page.nextCursor ?? null;
  }

  subscribe(): void {
    if (this.#disposed || this.#unsubscribe) return;
    this.#unsubscribe = this.ports.turn.subscribe(event => this.handleTurnEvent(event));
  }

  /** Unsubscribes every listener; a disposed presenter must not leak or react. */
  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #adopt(page: DiscoveryView | null): void {
    if (!page) return;
    this.#discoverySource = { protocol: page.protocol, endpoint: page.endpoint, modelsEndpoint: page.modelsEndpoint, credentialRef: page.credentialRef };
    this.#discoveryRevision = page.revision;
    this.#discoveryItems = objects(page.items);
    this.#discoveryCheckedAt = page.checkedAt;
    this.#discoveryTruncated = page.truncated;
    this.#discoveryStale = page.stale;
    this.#discoveryNote = page.note;
  }
}

/** Ids are data, not markup; anything that is not a plain identifier is dropped rather than rendered. */
function objects(items: readonly DiscoveryItemView[] | undefined): readonly DiscoveryItemView[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const result: DiscoveryItemView[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 200 || /[\u0000-\u001f\u007f]/.test(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    const methods = Array.isArray(item.capabilities?.methods) ? item.capabilities.methods.filter((method: string) => typeof method === 'string' && method.length <= 40) : [];
    result.push({ id: item.id, label: typeof item.label === 'string' && item.label ? item.label : item.id,
      capabilities: { methods, evidence: item.capabilities?.evidence === 'declared' && methods.length ? 'declared' : 'unknown' } });
  }
  return result;
}
