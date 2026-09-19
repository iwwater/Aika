import type { MediaStorePort, PlaybackEvent, PlaybackPort, TtsResult, TurnScope } from '../contracts/index.js';
import { abortable, abortError, checkAbort, scopeKey } from './scope.js';

export type PlaybackSample = PlaybackEvent extends infer E ? E extends PlaybackEvent ? Omit<E, 'scope'> : never : never;
export interface PlaybackSession { done: Promise<void>; stop(): void }
export interface PlaybackDriver { open(bytes: Uint8Array, audioId: string, emit: (event: PlaybackSample) => void, signal: AbortSignal): Promise<PlaybackSession> }
type Active = { input: TtsResult; controller: AbortController; session?: PlaybackSession; emit: (event: PlaybackEvent) => void; detach: () => void; terminal: boolean };

export class TurnPlayback implements PlaybackPort {
  private active: Active | undefined;
  constructor(private readonly driver: PlaybackDriver, private readonly store: MediaStorePort) {}
  async play(input: TtsResult, emit: (event: PlaybackEvent) => void, signal: AbortSignal): Promise<void> {
    checkAbort(signal);
    const cleanup = this.active ? this.stop(this.active.input.scope) : Promise.resolve();
    const cancel = () => { void this.stop(input.scope); };
    const active: Active = { input, emit, controller: new AbortController(), detach: () => signal.removeEventListener('abort', cancel), terminal: false };
    this.active = active; signal.addEventListener('abort', cancel, { once: true });
    try {
      await cleanup; checkAbort(active.controller.signal);
      const bytes = await this.store.read(input.scope, input.audio); checkAbort(active.controller.signal);
      const deliver = (event: PlaybackSample) => {
        if (this.active !== active || active.terminal || active.controller.signal.aborted) return;
        if (event.type === 'ended' || event.type === 'error' || event.type === 'stopped') {
          active.terminal = true;
          emit({ scope: input.scope, at: event.at, type: 'amplitude', value: 0 });
        }
        emit({ ...event, scope: input.scope } as PlaybackEvent);
      };
      const opening = this.driver.open(bytes, input.audio.id, deliver, active.controller.signal).then(session => {
        if (this.active !== active || active.controller.signal.aborted) { session.stop(); throw abortError(); }
        active.session = session; return session;
      });
      const session = await abortable(opening, active.controller.signal);
      await abortable(session.done, active.controller.signal);
      if (!active.terminal) deliver({ type: 'ended', at: new Date().toISOString() });
    } catch (error) {
      if (!active.controller.signal.aborted && this.active === active && !active.terminal) {
        active.terminal = true;
        emit({ scope: input.scope, type: 'amplitude', value: 0, at: new Date().toISOString() });
        emit({ scope: input.scope, type: 'error', message: error instanceof Error ? error.message : 'Playback failed', at: new Date().toISOString() });
      }
      throw error;
    } finally {
      active.session?.stop(); active.detach();
      if (this.active === active) this.active = undefined;
      await this.store.releaseScope(input.scope);
    }
  }
  async stop(scope: TurnScope): Promise<void> {
    const active = this.active;
    if (active && scopeKey(active.input.scope) !== scopeKey(scope)) return;
    if (active) {
      this.active = undefined; active.controller.abort(); active.session?.stop(); active.detach();
      if (!active.terminal) {
        active.terminal = true;
        active.emit({ scope, type: 'amplitude', value: 0, at: new Date().toISOString() });
        active.emit({ scope, type: 'stopped', at: new Date().toISOString() });
      }
    }
    await this.store.releaseScope(scope);
  }
}
