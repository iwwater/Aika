// FIX61-08 08-D/08-E: the production live voice bridge. One composition root connects the authorized
// input session to the streaming recognizer and, on release, submits exactly one voice turn through
// the existing authoritative TurnController — no second turn state machine, no batch ASR call, and
// interim text is display-only (never Memory or Timeline).
import type { AsrSegment } from './speech-bridge.js';
import type { NextSpeechInput } from './speech-bridge.js';
import type { SherpaStreamingAsr, StreamingAsrEvent } from '../providers/sherpa-streaming-asr.js';
import type { TurnScope } from '../contracts/index.js';
import { VOICE_FINISH_TIMEOUT_MS } from '../media/voice-input-session.js';

export interface LiveVoiceBridgeOptions {
  readonly asr: Pick<SherpaStreamingAsr, 'openStream' | 'push' | 'finish' | 'cancel' | 'subscribe'>;
  readonly input: NextSpeechInput;
  /** Live partial text and the current live utterance: display only. */
  readonly onInterim?: (scope: TurnScope, text: string) => void;
  readonly onError?: (scope: TurnScope, error: unknown) => void;
  readonly finishTimeoutMs?: number;
  readonly now?: () => number;
}

export type LiveVoiceFinish = { readonly type: 'finished'; readonly transcript: string } | { readonly type: 'cancelled' };

/**
 * One input session at a time. push() forwards captured PCM16 frames; finish() flushes the tail and
 * waits for the bounded final result; cancel() drops the uncommitted text. finish() never submits —
 * the callers own turn submission so there is exactly one place that starts a turn.
 */
export class LiveVoiceBridge {
  #active: { scope: TurnScope; cancelled: boolean } | undefined;
  #unsubscribe: (() => void) | undefined;
  #stats = { firstPartialMs: null as number | null, lastFinalMs: null as number | null, partials: 0, finals: 0, startedAtMs: 0 };

  constructor(private readonly options: LiveVoiceBridgeOptions) {}

  /** Latency instrumentation of the current/last input session, measured against the injected clock. */
  stats(): { firstPartialMs: number | null; lastFinalMs: number | null; partials: number; finals: number } {
    const { firstPartialMs, lastFinalMs, partials, finals } = this.#stats;
    return { firstPartialMs, lastFinalMs, partials, finals };
  }

  /** Opens a recognizer stream for one already-authorized input session. */
  async start(scope: TurnScope, sampleRate: number): Promise<void> {
    if (this.#active) await this.cancel();
    this.#stats = { firstPartialMs: null, lastFinalMs: null, partials: 0, finals: 0, startedAtMs: this.#now() };
    this.#active = { scope, cancelled: false };
    this.#unsubscribe = this.options.asr.subscribe(event => this.#event(event));
    try { await this.options.asr.openStream(scope, sampleRate); }
    catch (error) { this.#teardown(); throw error; }
  }

  /** One captured PCM16 mono frame. */
  async push(pcm: Uint8Array, sampleRate: number): Promise<void> {
    const active = this.#active;
    if (!active || active.cancelled) return;
    await this.options.asr.push(active.scope, pcm, sampleRate);
  }

  /** Key released: flush the recognizer and wait for the bounded final result. */
  async finish(scope: TurnScope, signal: AbortSignal): Promise<LiveVoiceFinish> {
    const active = this.#active;
    if (!active || active.cancelled || active.scope.turnId !== scope.turnId) return { type: 'cancelled' };
    try {
      await this.#withDeadline(this.options.asr.finish(scope), signal);
    } catch (error) {
      this.options.onError?.(scope, error);
      throw error;
    } finally { this.#teardown(); }
    return { type: 'finished', transcript: this.options.input.liveText() };
  }

  /** Cancels the stream and drops the uncommitted text; a new input session stays usable. */
  async cancel(): Promise<void> {
    const active = this.#active;
    if (!active || active.cancelled) return;
    active.cancelled = true;
    this.#teardown();
    this.options.input.cancel();
    try { await this.options.asr.cancel(active.scope); } catch { /* The stream is being dropped anyway. */ }
  }

  #teardown(): void { this.#unsubscribe?.(); this.#unsubscribe = undefined; this.#active = undefined; }

  #event(event: StreamingAsrEvent): void {
    const active = this.#active;
    if (!active || active.cancelled) return;
    if (event.type === 'error') { this.options.onError?.(event.scope, event.error); return; }
    if (event.scope.turnId !== active.scope.turnId || event.scope.generation !== active.scope.generation) return;
    this.segment(event.scope, event.segment, event.type);
  }

  /** Applies one recognizer event to the production speech input. */
  segment(scope: TurnScope, segment: AsrSegment, type: 'partial' | 'final'): void {
    const active = this.#active;
    if (!active || active.cancelled || active.scope.turnId !== scope.turnId) return;
    if (type === 'partial') {
      // Empty partials are not user-visible text; they must not clear the current display either.
      if (!segment.text) return;
      this.#stats.partials += 1;
      this.#stats.firstPartialMs ??= this.#now() - this.#stats.startedAtMs;
      this.options.input.interim(segment);
      this.options.onInterim?.(scope, this.options.input.liveText());
      return;
    }
    this.#stats.finals += 1;
    this.#stats.lastFinalMs = this.#now() - this.#stats.startedAtMs;
    this.options.input.final(segment);
  }

  #now(): number { return this.options.now?.() ?? Date.now(); }

  async #withDeadline(pending: Promise<void>, signal: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      signal.throwIfAborted();
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Voice recognition finish timed out')), this.options.finishTimeoutMs ?? VOICE_FINISH_TIMEOUT_MS); }),
        new Promise<never>((_, reject) => { signal.addEventListener('abort', () => reject(new DOMException('Voice finish cancelled', 'AbortError')), { once: true }); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
