import { COMPANION_ID, isProductCharacter } from '../contracts/character.js';
import type { CharacterId, DesktopCommand, DesktopEvent, ExpressionIntent, PetPresentation, TurnScope } from '../contracts/index.js';
export const neutral = (): ExpressionIntent => ({ emotion: 'neutral', intensity: 0, delivery: '', gesture: null });
export function scopeEquals(a: TurnScope | null, b: TurnScope): boolean {
  return !!a && a.characterId === b.characterId && a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;
}
/** The view trusts actual playback events for speech, never a model/presentation completion flag. */
export class DesktopViewState {
  readonly characterId = COMPANION_ID;
  scope: TurnScope | null = null;
  state: PetPresentation['state'] = 'idle';
  expression: ExpressionIntent = neutral();
  mouth = 0;
  reply = '';
  error = '';
  invitation: Extract<DesktopEvent, {type: 'invitation'}>['invitation'] | null = null;
  private playing = false;
  private replyExpression: ExpressionIntent | null = null;
  private floors = new Map<string, number>();
  private sessionId: string | null = null;
  setSession(characterId: CharacterId, sessionId: string): void {
    if (!isProductCharacter(characterId)) throw new Error('当前桌面只支持青梅竹马。');
    this.reset(); this.sessionId = sessionId;
    this.reply = ''; this.invitation = null;
  }
  command(command: DesktopCommand): void {
    if (command.type === 'finish_voice' && this.state === 'listening') this.state = 'thinking';
    if (command.type === 'cancel' || command.type === 'submit_text' || command.type === 'start_voice' || command.type === 'click_invitation') {
      this.reset();
      this.invitation = null;
    }
  }
  reset(): void {
    if (this.scope) this.floors.set(this.scope.sessionId, this.scope.generation);
    this.scope = null; this.playing = false; this.replyExpression = null; this.mouth = 0; this.expression = neutral(); this.state = 'idle'; this.error = '';
  }
  accepts(scope: TurnScope): boolean { return scopeEquals(this.scope, scope); }
  expireInvitation(now: number): boolean {
    if (this.invitation && Date.parse(this.invitation.expiresAt) <= now) { this.invitation = null; return true; }
    return false;
  }
  receive(event: DesktopEvent): boolean {
    if (event.type === 'transcript') return this.accepts(event.scope);
    if (event.type === 'turn') {
      const s = event.input.scope;
      if (this.sessionId && s.sessionId !== this.sessionId || s.characterId !== this.characterId || s.generation <= (this.floors.get(s.sessionId) ?? -1)) return false;
      if (this.scope && s.sessionId === this.scope.sessionId && s.generation <= this.scope.generation) return false;
      this.reset(); this.scope = s; this.sessionId = s.sessionId; this.state = event.input.kind === 'voice' ? 'listening' : 'thinking';
      this.reply = ''; this.invitation = null; return true;
    }
    if (event.type === 'invitation') {
      const i = event.invitation;
      if (i.characterId !== this.characterId || !Number.isFinite(Date.parse(i.expiresAt)) || Date.parse(i.expiresAt) <= Date.now()) return false;
      this.invitation = ['eligible', 'shown'].includes(i.status) ? i : null; return true;
    }
    if (event.type === 'error') {
      if (event.scope && !this.accepts(event.scope)) return false;
      this.reset(); this.state = 'error'; this.error = event.message; return true;
    }
    const scope = event.type === 'presentation' ? event.presentation.scope : event.type === 'reply' ? event.reply.scope : event.playback.scope;
    if (!this.accepts(scope)) return false;
    if (event.type === 'reply') { this.reply = event.reply.text; this.replyExpression ??= event.reply.expression; this.expression = this.replyExpression; return true; }
    if (event.type === 'presentation') {
      const p = event.presentation;
      // An upstream completion snapshot cannot end sound still leaving the device.
      if (p.state === 'idle' && this.playing) return false;
      if (p.state === 'idle' || p.state === 'error') { this.reset(); this.state = p.state; return true; }
      this.expression = this.replyExpression ?? p.expression;
      this.state = this.playing ? 'speaking' : p.state === 'speaking' ? 'thinking' : p.state;
      return true;
    }
    const p = event.playback;
    if (p.type === 'started') { if (this.playing) return false; this.playing = true; this.state = 'speaking'; this.mouth = 0; }
    else if (p.type === 'amplitude') { if (!this.playing || !Number.isFinite(p.value)) return false; this.mouth = Math.min(1, Math.max(0, p.value)); }
    else if (p.type === 'ended' || p.type === 'stopped' || p.type === 'error') { this.reset(); if (p.type === 'error') { this.state = 'error'; this.error = p.message; } }
    return true;
  }
}

/** Shell-local connection generation; never added to the public backend wire. */
export class DesktopConnectionState {
  generation = 0;
  state: 'connecting' | 'ready' | 'failed' | 'disconnected' = 'disconnected';
  reason = '';
  canRetry = false;
  get connected(): boolean { return this.state === 'ready'; }
  get active(): boolean { return ['connecting', 'ready'].includes(this.state); }
  current(generation: number): boolean { return generation === this.generation && this.active; }
  update(value: { generation: number; state: string; reason?: string; canRetry?: boolean }): boolean {
    if (!Number.isSafeInteger(value.generation) || value.generation < 1) return false;
    if (value.state === 'connecting') {
      if (value.generation <= this.generation) return false;
    } else if (!this.current(value.generation) || !['failed', 'disconnected'].includes(value.state)) return false;
    this.generation = value.generation; this.state = value.state as typeof this.state;
    this.reason = value.reason ?? ''; this.canRetry = value.canRetry ?? this.canRetry; return true;
  }
  ready(generation: number): boolean {
    if (!this.current(generation) || this.state !== 'connecting') return false;
    this.state = 'ready'; this.reason = ''; return true;
  }
}
