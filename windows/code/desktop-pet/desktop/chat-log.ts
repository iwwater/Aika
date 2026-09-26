import { scopeEquals } from './view-state.js';
import type { CharacterId, TurnScope } from '../contracts/index.js';
type Row = { id: number; kind: 'user' | 'assistant'; text: string; status?: 'sending' | 'sent' | 'failed'; scope?: TurnScope; voice?: boolean; deferred?: boolean; routed?: boolean; transcribed?: boolean; sourceDraftId?:string; sourceLabel?:string };
/** Ephemeral display only: both routes retain verbatim user input. No backend memory writes. */
export class DesktopChatLog {
  revision = 0;
  private nextId = 0;
  private logs = new Map<CharacterId, Row[]>();
  private drafts = new Map<CharacterId, string>();
  private waiting = new Map<CharacterId, Row>();
  private voices = new Map<CharacterId, Row>();
  rows(role: CharacterId): readonly Row[] { return this.logs.get(role) ?? []; }
  draft(role: CharacterId): string { return this.drafts.get(role) ?? ''; }
  setDraft(role: CharacterId, text: string): void { this.drafts.set(role, text); }
  pending(role: CharacterId): boolean { return this.waiting.has(role); }
  submit(role: CharacterId, text: string, deferred = false): boolean {
    if (this.pending(role)) return false;
    const row: Row = { id: ++this.nextId, kind: 'user', text, status: 'sending', deferred };
    if (!deferred) this.append(role, row); this.waiting.set(role, row); this.setDraft(role, ''); return true;
  }
  acknowledge(scope: TurnScope, deferred = false): void {
    const row = this.waiting.get(scope.characterId);
    if (!row) return;
    row.scope = scope; if (deferred) return;
    row.status = 'sent'; this.waiting.delete(scope.characterId); this.revision++;
  }
  failPending(role: CharacterId): void {
    const row = this.waiting.get(role);
    if (!row) return;
    row.status = 'failed'; this.waiting.delete(role);
    if (!this.draft(role)) this.setDraft(role, row.text);
    this.revision++;
  }
  beginVoice(role: CharacterId, deferred = false): void {
    this.cancelVoice(role);
    const row: Row = { id: ++this.nextId, kind: 'user', text: '语音输入 · 准备中', voice: true, status: 'sending', deferred };
    if (!deferred) this.append(role, row); this.voices.set(role, row);
  }
  bindVoice(scope: TurnScope): void { const row = this.voices.get(scope.characterId); if (row) row.scope = scope; }
  cancelVoice(role: CharacterId): void {
    const row = this.voices.get(role);
    if (!row) return;
    row.text = '语音未发送'; row.status = 'failed'; this.voices.delete(role); this.revision++;
  }
  /** FIX61-08: live replacement text of the in-progress voice row; never finalizes the turn. */
  interim(scope: TurnScope, text: string): void {
    const row = this.voices.get(scope.characterId);
    if (!row?.scope || !scopeEquals(row.scope, scope)) return;
    row.text = text; row.transcribed = true; row.status = 'sent'; this.revision++;
  }
  transcript(scope: TurnScope, text: string): void {
    const row = this.voices.get(scope.characterId);
    if (!row?.scope || row.scope.sessionId !== scope.sessionId || row.scope.turnId !== scope.turnId || row.scope.generation !== scope.generation) return;
    if(!text.trim()){this.voices.delete(scope.characterId);this.revision++;return;}
    row.text = text; row.transcribed = true;
    row.status = 'sent'; if (row.deferred) this.append(scope.characterId, row); this.voices.delete(scope.characterId); this.revision++;
  }
  route(scope: TurnScope, route: 'companion' | 'work'): void {
    const role = scope.characterId;
    const row = this.waiting.get(role);
    if (row && scopeEquals(row.scope ?? null, scope)) {
      this.waiting.delete(role);
      row.status = 'sent'; row.routed = true; if (row.deferred) this.append(role, row);
      this.revision++;
    }
    const voice = this.voices.get(role);
    if (!voice || !scopeEquals(voice.scope ?? null, scope)) return;
    voice.routed = true;
    if (voice.transcribed) this.transcript(scope, voice.text);
  }
  restoreSource(input: import('../contracts/desktop-work.js').WorkSourceInput): void {
    const role=input.scope.characterId,existing=this.rows(role).find(row=>row.sourceDraftId===input.draftId);
    if(existing)return;
    const voice=this.voices.get(role);
    if(input.provenance==='original_input'&&voice&&scopeEquals(voice.scope??null,input.scope)){voice.text=input.text;voice.transcribed=true;voice.status='sent';voice.sourceDraftId=input.draftId;voice.deferred=false;this.append(role,voice);this.voices.delete(role);return;}
    const live=this.rows(role).find(row=>row.kind==='user'&&!row.sourceDraftId&&scopeEquals(row.scope??null,input.scope)&&row.text===input.text);
    if(live){live.sourceDraftId=input.draftId;if(input.provenance==='legacy_saved_input')live.sourceLabel='已保存的任务输入';this.revision++;return;}
    this.append(role,{id:++this.nextId,kind:'user',text:input.text,status:'sent',scope:input.scope,sourceDraftId:input.draftId,sourceLabel:input.provenance==='legacy_saved_input'?'已保存的任务输入':'你的原话'});
  }
  sourceRowId(role:CharacterId,draftId?:string):number|undefined {return draftId?this.rows(role).find(row=>row.sourceDraftId===draftId)?.id:undefined;}
  reply(scope: TurnScope, text: string): void {
    const row = this.rows(scope.characterId).find(r => r.kind === 'assistant' && r.scope?.sessionId === scope.sessionId && r.scope?.turnId === scope.turnId && r.scope?.generation === scope.generation);
    if (row) { row.text = text; this.revision++; }
    else this.append(scope.characterId, { id: ++this.nextId, kind: 'assistant', text, scope });
  }
  private append(role: CharacterId, row: Row): void {
    const rows = [...this.rows(role), row];
    // A bounded session-only panel; backend history and retention are untouched.
    this.logs.set(role, rows.slice(-50)); this.revision++;
  }
}
