import { COMPANION_ID } from '../contracts/character.js';
import { randomUUID } from 'node:crypto';
import type { CharacterId, ExpressionIntent, InputKind, PetPresentation, PlaybackEvent, TurnInput, TurnScope } from '../contracts/index.js';

export function sameScope(a: TurnScope, b: TurnScope): boolean {
  return a.characterId === b.characterId && a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;
}
export class TurnController {
  private generation = 0;
  private sessionId = randomUUID();
  private readonly characterId: CharacterId = COMPANION_ID;
  private active: {input: TurnInput; controller: AbortController} | null = null;
  private presentation: PetPresentation | null = null;
  private playbackStarted = false;
  identity(): { characterId: CharacterId; sessionId: string } { return { characterId: this.characterId, sessionId: this.sessionId }; }
  begin(kind: InputKind, text?: string): {input: TurnInput; signal: AbortSignal} {
    this.cancel();
    const scope = Object.freeze({characterId: this.characterId, sessionId: this.sessionId, turnId: randomUUID(), generation: this.generation});
    const input: TurnInput = Object.freeze({scope, kind, startedAt: new Date().toISOString(), ...(text === undefined ? {} : {text})});
    const controller = new AbortController();
    this.active = {input, controller};
    this.presentation = {scope, state: kind === 'voice' ? 'listening' : 'thinking', expression: {emotion: 'neutral', intensity: 0, delivery: '', gesture: null}, mouth: 0};
    return {input, signal: controller.signal};
  }
  cancel(): void {
    this.active?.controller.abort();
    this.active = null;
    this.playbackStarted = false;
    this.generation += 1;
    if (this.presentation) this.presentation = {...this.presentation, state: 'idle', mouth: 0};
  }
  resetSession(): void {
    this.cancel();
    this.sessionId = randomUUID();
    this.presentation = null;
  }
  accepts(scope: TurnScope): boolean {
    return this.active !== null && !this.active.controller.signal.aborted && sameScope(scope, this.active.input.scope);
  }
  /** Complete a non-speaking routed input without inventing playback evidence. */
  finish(scope: TurnScope): boolean {
    if (!this.accepts(scope) || !this.presentation) return false;
    this.presentation = { ...this.presentation, state: 'idle', mouth: 0 };
    this.active = null; this.playbackStarted = false; return true;
  }
  thinking(scope: TurnScope): boolean {
    if (!this.accepts(scope) || !this.presentation) return false;
    this.presentation = {...this.presentation, state: 'thinking', mouth: 0};
    return true;
  }
  express(scope: TurnScope, expression: ExpressionIntent): boolean {
    if (!this.accepts(scope) || !this.presentation) return false;
    this.presentation = {...this.presentation, expression: structuredClone(expression)};
    return true;
  }
  playback(event: PlaybackEvent): boolean {
    if (!this.accepts(event.scope) || !this.presentation) return false;
    switch (event.type) {
      case 'started': this.playbackStarted = true; this.presentation = {...this.presentation, state: 'speaking', mouth: 0}; break;
      case 'amplitude':
        if (!this.playbackStarted || !Number.isFinite(event.value)) return false;
        this.presentation = {...this.presentation, mouth: Math.min(1, Math.max(0, event.value))}; break;
      case 'progress': return this.playbackStarted;
      case 'ended': case 'stopped': case 'error':
        this.playbackStarted = false;
        this.presentation = {...this.presentation, state: event.type === 'error' ? 'error' : 'idle', mouth: 0};
        // Terminal events invalidate later events, even with the same turn scope.
        if (event.type !== 'ended') this.active?.controller.abort();
        this.active = null;
        break;
    }
    return true;
  }
  snapshot(): PetPresentation | null { return this.presentation ? structuredClone(this.presentation) : null; }
}
