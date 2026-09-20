// Aika console presenter: pure UI logic for the management panel. It only consumes ports
// (profile/provider config, TurnPort, timeline queries); it never calls models or touches Memory.
import type { TurnScope } from '../contracts/index.js';
import type { TurnPortEvent } from '../core/turn-port.js';
import type { AikaProfile, AikaProviderConfig } from './aika-profile.js';

export interface AikaConsolePorts {
  profile: {
    load(): Promise<{ revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] }>;
    save(expectedRevision: number, profile: AikaProfile, providers: readonly AikaProviderConfig[]): Promise<{ revision: number; profile: AikaProfile; providers: readonly AikaProviderConfig[] }>;
  };
  timeline: {
    list(query: { sessionId: string; cursor?: string; limit: number }): Promise<{ items: AikaChatEvent[]; nextCursor?: string }>;
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
      timelineCursor: this.#timelineCursor
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
}
