// Next speech bridge: SpeechInputPort/SpeechOutputPort as thin adapters over the upstream turn
// authority. FIX61-08 adds the live leg: interim partials replace each other in the UI and are never
// written to memory, final segments only accumulate, and stop() submits exactly one voice turn.
// Reply sentences synth and play in strict sentence order regardless of completion order;
// interruption cancels turn and audio in one entry; synthesis/playback failures are observable and
// never claimed as delivered audio.
import { sameScope } from './turn-controller.js';
import type { PlaybackEvent, PlaybackPort, TtsProvider, TtsRequest, TtsResult, TurnScope } from '../contracts/index.js';
import type { NextTurnPort } from './turn-port.js';

export interface AsrSegment {
  readonly inputSessionId: string;
  readonly segmentId: string;
  readonly index: number;
  readonly text: string;
  readonly audioEndMs: number;
  readonly timeSource: 'audio' | 'estimated';
  /** Monotonic revision of this segment's live text. Partial text is a replacement, never a concat. */
  readonly revision?: number;
}

export interface SpeechInputHandlers {
  /** Live partial text for the current segment; display only, never persisted. */
  onInterim?(segment: AsrSegment): void;
  onSegmentFinal?(segment: AsrSegment): void;
  onTurnReady?(scope: TurnScope, text: string): void;
  onError?(error: unknown): void;
}

/** Aggregates ASR segments of one utterance; stop() submits at most once per input session. */
export class NextSpeechInput {
  readonly #segments = new Map<string, AsrSegment>();
  readonly #revisions = new Map<string, number>();
  /** The live partial per segment; replaced by newer revisions and dropped by finals. */
  readonly #partials = new Map<string, AsrSegment>();
  #inputSessionId: string | undefined;
  #submitted = false;

  constructor(private readonly submit: (text: string) => Promise<TurnScope>, private readonly handlers: SpeechInputHandlers = {}) {}

  /** Live partial text. Revisions are monotonic; an older revision is ignored, never merged. */
  interim(segment: AsrSegment): void {
    if (this.#submitted || !this.#accept(segment)) return;
    const revision = segment.revision ?? (this.#revisions.get(segment.segmentId) ?? 0) + 1;
    if (revision <= (this.#revisions.get(segment.segmentId) ?? 0)) return;
    this.#revisions.set(segment.segmentId, revision);
    if (this.#segments.has(segment.segmentId)) return; // a final segment is immutable
    this.#partials.set(segment.segmentId, segment);
    this.handlers.onInterim?.(segment);
  }

  /** Accumulates the final text of one segment. It never triggers the dialogue by itself. */
  final(segment: AsrSegment): void {
    if (this.#submitted || !this.#accept(segment)) return;
    if (this.#segments.has(segment.segmentId)) return;
    const revision = segment.revision ?? (this.#revisions.get(segment.segmentId) ?? 0) + 1;
    this.#revisions.set(segment.segmentId, revision);
    this.#partials.delete(segment.segmentId);
    this.#segments.set(segment.segmentId, segment);
    this.handlers.onSegmentFinal?.(segment);
  }

  /** Historical single-shot entry: an explicit final segment. */
  feed(segment: AsrSegment): void { this.final(segment); }

  /** The live text of the whole utterance: finals in audio order plus the current partial tail. */
  liveText(): string {
    const ordered = [...this.#segments.values(), ...this.#partials.values()].sort((a, b) => a.index - b.index);
    return ordered.map(segment => segment.text.trim()).filter(Boolean).join('');
  }

  /** Ends the utterance: merge by audio order and submit once. Empty inputs never submit. */
  async stop(): Promise<void> {
    if (this.#submitted) return;
    this.#submitted = true;
    const ordered = [...this.#segments.values()].filter(segment => segment.text.trim().length > 0).sort((a, b) => a.index - b.index);
    this.#segments.clear(); this.#partials.clear();
    const text = ordered.map(segment => segment.text.trim()).join('');
    if (!text) return;
    try {
      const scope = await this.submit(text);
      this.handlers.onTurnReady?.(scope, text);
    } catch (error) {
      this.handlers.onError?.(error);
    }
  }

  /** Opens the next utterance; late segments of the previous one are dropped. */
  startNewInput(): void {
    this.#submitted = false;
    this.#segments.clear(); this.#partials.clear(); this.#revisions.clear();
  }

  /** Discards pending input without submitting. */
  cancel(): void {
    this.#segments.clear(); this.#partials.clear(); this.#revisions.clear();
    this.#submitted = true;
  }

  /** One recognizer session owns the input; a different session invalidates the previous one. */
  #accept(segment: AsrSegment): boolean {
    if (this.#inputSessionId === undefined) { this.#inputSessionId = segment.inputSessionId; return true; }
    if (this.#inputSessionId === segment.inputSessionId) return true;
    this.startNewInput();
    this.#inputSessionId = segment.inputSessionId;
    return true;
  }
}

export interface SpeakRequest {
  readonly scope: TurnScope;
  readonly sentenceId: string;
  readonly text: string;
  readonly language?: string;
}

export interface SpeechOutputHandlers {
  onStarted?(scope: TurnScope, sentenceId: string): void;
  onSentenceCompleted?(scope: TurnScope, sentenceId: string): void;
  onDrained?(scope: TurnScope, summary: { delivered: number; failed: number }): void;
  onStopped?(scope: TurnScope): void;
  onError?(scope: TurnScope, sentenceId: string | null, error: unknown): void;
}

const NEUTRAL_EXPRESSION = { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } as const;

interface OutputSession {
  readonly scope: TurnScope;
  readonly sentenceIds: Map<number, string>;
  readonly controllers: Map<number, AbortController>;
  readonly settled: Set<number>;
  readonly failedEarly: Set<number>;
  readonly ready: Map<number, TtsResult>;
  ordinal: number;
  nextToPlay: number;
  pending: number;
  delivered: number;
  failed: number;
  ended: boolean;
  stopped: boolean;
  drained: boolean;
}

function sessionKey(scope: TurnScope): string {
  return `${scope.characterId}:${scope.sessionId}:${scope.turnId}:${scope.generation}`;
}

export class NextSpeechOutput {
  readonly #sessions = new Map<string, OutputSession>();
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly tts: TtsProvider, private readonly playback: PlaybackPort, private readonly handlers: SpeechOutputHandlers = {}) {}

  enqueue(request: SpeakRequest): void {
    const session = this.#session(request.scope);
    if (session.stopped || session.drained) return;
    const ordinal = session.ordinal++;
    session.sentenceIds.set(ordinal, request.sentenceId);
    session.pending++;
    const controller = new AbortController();
    session.controllers.set(ordinal, controller);
    this.#chain(async () => {
      const request2: TtsRequest = { scope: request.scope, text: request.text, expression: { ...NEUTRAL_EXPRESSION } };
      try {
        const result = await this.tts.synthesize(request2, controller.signal);
        if (session.stopped) return;
        session.ready.set(ordinal, result);
        this.#tryPlay(session);
        this.#tryDrain(session);
      } catch (error) {
        if (session.stopped) return;
        this.#settleFailed(session, ordinal, error);
      }
    });
  }

  /** No further sentences for this turn; drained fires once the queue and in-flight audio settle. */
  endTurn(scope: TurnScope): void {
    const session = this.#session(scope);
    session.ended = true;
    this.#tryDrain(session);
  }

  /** Interruption: abort in-flight work, discard the queue, surface stopped. Drained is never emitted. */
  stop(scope: TurnScope): void {
    const session = this.#sessions.get(sessionKey(scope));
    if (!session || session.stopped) return;
    session.stopped = true;
    for (const controller of session.controllers.values()) controller.abort();
    session.ready.clear();
    void this.playback.stop(scope);
    this.handlers.onStopped?.(scope);
  }

  /** Resolves when every enqueued sentence reached a terminal state (the tail stops growing). */
  async drain(): Promise<void> {
    let current = this.#tail;
    for (;;) {
      await current;
      if (this.#tail === current) return;
      current = this.#tail;
    }
  }

  #session(scope: TurnScope): OutputSession {
    const key = sessionKey(scope);
    let session = this.#sessions.get(key);
    if (!session) {
      session = { scope, sentenceIds: new Map(), controllers: new Map(), settled: new Set(), failedEarly: new Set(), ready: new Map(), ordinal: 0, nextToPlay: 0, pending: 0, delivered: 0, failed: 0, ended: false, stopped: false, drained: false };
      this.#sessions.set(key, session);
    }
    return session;
  }

  #chain(task: () => Promise<void>): void {
    this.#tail = this.#tail.then(task, task);
  }

  #tryPlay(session: OutputSession): void {
    for (;;) {
      if (session.failedEarly.has(session.nextToPlay)) { session.nextToPlay++; continue; }
      const result = session.ready.get(session.nextToPlay);
      if (!result) break;
      session.ready.delete(session.nextToPlay);
      const ordinal = session.nextToPlay;
      const sentenceId = session.sentenceIds.get(ordinal) ?? `sentence-${ordinal}`;
      const signal = session.controllers.get(ordinal)?.signal ?? new AbortController().signal;
      this.#chain(() => this.playback.play(result, event => this.#forward(session, ordinal, sentenceId, event), signal)
        .then(() => this.#settleDone(session, ordinal, sentenceId))
        .catch(error => this.#settleFailed(session, ordinal, error, sentenceId)));
      break; // strict sentence order: one playback at a time
    }
  }

  #forward(session: OutputSession, ordinal: number, sentenceId: string, event: PlaybackEvent): void {
    if (session.stopped || !sameScope(event.scope, session.scope)) return;
    if (event.type === 'started') this.handlers.onStarted?.(session.scope, sentenceId);
    // Playback failures are reported through the play() promise rejection, which owns the settle path.
    void ordinal;
  }

  #settleDone(session: OutputSession, ordinal: number, sentenceId: string): void {
    if (session.stopped || session.settled.has(ordinal)) return;
    session.settled.add(ordinal);
    session.delivered++;
    session.pending--;
    if (ordinal === session.nextToPlay) session.nextToPlay++;
    this.handlers.onSentenceCompleted?.(session.scope, sentenceId);
    this.#tryPlay(session);
    this.#tryDrain(session);
  }

  #settleFailed(session: OutputSession, ordinal: number, error: unknown, sentenceId?: string): void {
    if (session.stopped || session.settled.has(ordinal)) return;
    session.settled.add(ordinal);
    session.failed++;
    session.pending--;
    this.handlers.onError?.(session.scope, sentenceId ?? session.sentenceIds.get(ordinal) ?? null, error);
    if (ordinal === session.nextToPlay) session.nextToPlay++;
    else session.failedEarly.add(ordinal);
    this.#tryPlay(session);
    this.#tryDrain(session);
  }

  #tryDrain(session: OutputSession): void {
    if (session.ended && !session.stopped && !session.drained && session.pending === 0) {
      session.drained = true;
      this.handlers.onDrained?.(session.scope, { delivered: session.delivered, failed: session.failed });
    }
  }
}

/** Single interruption entry: cancels the active turn and stops its audio; new inputs stay usable. */
export class VoiceTurnBridge {
  #currentScope: TurnScope | undefined;

  constructor(private readonly turnPort: NextTurnPort, private readonly output: NextSpeechOutput, private readonly options: { dialogueSentences?: boolean } = {}) {
    this.turnPort.subscribe(event => {
      if (event.type === 'accepted') this.#currentScope = event.scope;
      if (event.type === 'reply' && this.options.dialogueSentences) {
        const sentences = splitSentences(event.text);
        sentences.forEach((text, index) => {
          this.output.enqueue({ scope: event.scope, sentenceId: `${event.scope.turnId}-s${index + 1}`, text });
        });
      }
      if (event.type === 'terminal' && this.options.dialogueSentences) {
        this.output.endTurn(event.scope);
      }
    });
  }

  async submitText(text: string): Promise<TurnScope> {
    return this.turnPort.submit({ text });
  }

  interrupt(): void {
    this.turnPort.cancel();
    if (this.#currentScope) this.output.stop(this.#currentScope);
  }
}

/** Sentence-level split for speech; the tail without punctuation is kept. */
export function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const char of text) {
    current += char;
    if (/[。！？!?…\n]/u.test(char)) {
      if (current.trim()) parts.push(current);
      current = '';
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}
