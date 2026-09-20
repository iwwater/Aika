// Next TurnPort: a thin adapter over the upstream turn authority (TurnController + DialoguePipeline).
// No second turn state machine: submit() accepts and resolves immediately, a newer submission cancels
// the older turn (upstream begin() rule), cancel() is idempotent, and terminal is synthesized exactly
// once per turn from the pipeline's own outcome. Delta events do not exist at this layer: upstream
// aggregates provider SSE internally (see CONTRACT_MAP).
import type { DesktopEvent, TurnScope } from '../contracts/index.js';
import { DialoguePipeline, type DialoguePorts } from './dialogue-pipeline.js';
import { TurnController } from './turn-controller.js';

export type TurnEnd = 'completed' | 'cancelled' | 'failed';
export type TurnPortEvent =
  | { readonly scope: TurnScope; readonly sequence: number; readonly type: 'accepted'; readonly text: string }
  | { readonly scope: TurnScope; readonly sequence: number; readonly type: 'reply'; readonly text: string }
  | { readonly type: 'terminal'; readonly scope: TurnScope; readonly sequence: number; readonly status: TurnEnd; readonly replyText?: string; readonly errorCode?: string };

type DistributeEventBody<T> = T extends unknown ? Omit<T, 'scope' | 'sequence'> : never;
type TurnPortEventBody = DistributeEventBody<TurnPortEvent>;

export interface TurnPortSubmission {
  readonly text: string;
  readonly clientRequestId?: string;
}

export class NextTurnPort {
  private readonly controller = new TurnController();
  private readonly pipeline: DialoguePipeline;
  private readonly listeners = new Set<(event: TurnPortEvent) => void>();
  private readonly sequences = new Map<string, number>();
  private readonly terminalSent = new Set<string>();
  private readonly lastReply = new Map<string, string>();

  constructor(ports: DialoguePorts) {
    this.pipeline = new DialoguePipeline(ports, this.controller, event => this.#dispatch(event));
  }

  identity(): { characterId: string; sessionId: string } { return this.controller.identity(); }

  /** Resolves when the turn is accepted (not completed); a newer submission has already cancelled this one by then. */
  async submit(submission: TurnPortSubmission): Promise<TurnScope> {
    if (!submission.text.trim()) throw new Error('Text must not be empty');
    const turn = this.controller.begin('text', submission.text);
    const scope = turn.input.scope;
    this.#emit(scope, { type: 'accepted', text: submission.text });
    void this.pipeline.run(turn.input, turn.signal).then(outcome => {
      if (outcome.status === 'replied' || outcome.status === 'played') {
        const replyText = this.lastReply.get(scope.turnId);
        this.#terminal(scope, replyText === undefined ? { type: 'terminal', status: 'completed' } : { type: 'terminal', status: 'completed', replyText });
      }
      else if (outcome.status === 'cancelled') this.#terminal(scope, { type: 'terminal', status: 'cancelled' });
      else this.#terminal(scope, { type: 'terminal', status: 'failed', errorCode: outcome.error ?? 'turn_failed' });
    }, () => this.#terminal(scope, { type: 'terminal', status: 'failed', errorCode: 'turn_failed' }));
    return scope;
  }

  /** Idempotent: cancelling without an active turn, or with a stale scope, is a no-op. */
  cancel(scope?: TurnScope): void {
    if (scope && !this.controller.accepts(scope)) return;
    this.controller.cancel();
  }

  /** Must be registered before submit() so no accepted-turn event is lost. Returns an unsubscribe. */
  subscribe(listener: (event: TurnPortEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  #dispatch(event: DesktopEvent): void {
    if (event.type !== 'reply') return;
    this.lastReply.set(event.reply.scope.turnId, event.reply.text);
    this.#emit(event.reply.scope, { type: 'reply', text: event.reply.text });
  }

  #terminal(scope: TurnScope, event: Extract<TurnPortEventBody, { type: 'terminal' }>): void {
    if (this.terminalSent.has(scope.turnId)) return;
    this.terminalSent.add(scope.turnId);
    this.#emit(scope, event);
  }

  #emit(scope: TurnScope, event: TurnPortEventBody): void {
    const sequence = (this.sequences.get(scope.turnId) ?? 0) + 1;
    this.sequences.set(scope.turnId, sequence);
    for (const listener of [...this.listeners]) listener({ scope, sequence, ...event } as TurnPortEvent);
  }
}
