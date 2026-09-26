import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type {CharacterId,TurnScope} from '../contracts/index.js';
import type {MemoryTurnOutcome} from '../contracts/memory-lifecycle.js';
import {bindScope,sameScope,MemoryRuleError} from './scope.js';
export type PendingIntent='correction'|'forget'|'uncertain';
interface Row {scope_json:string;current_message_id:string;source_version:number;intent:PendingIntent;status:'pending'|'failed'|'completed'|'cancelled'}
/** Privacy holds are durable; this table is not a durable model-job scheduler. */
export class PendingMutations {
 constructor(private readonly db:Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_pending_mutations(character_id TEXT NOT NULL,current_message_id TEXT NOT NULL,scope_json TEXT NOT NULL,source_version INTEGER NOT NULL,intent TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(character_id,current_message_id));`);
 }
 private row(scope:TurnScope,id:string):Row|undefined {bindScope(scope,scope.characterId);return this.db.prepare('SELECT * FROM memory_pending_mutations WHERE character_id=? AND current_message_id=?').get(scope.characterId,id) as Row|undefined;}
 has(characterId:CharacterId):boolean {bindScope({characterId,sessionId:'pending',turnId:'pending',generation:0},characterId);return !!this.db.prepare("SELECT 1 FROM memory_pending_mutations WHERE character_id=? AND status IN ('pending','failed') LIMIT 1").get(characterId);}
 /** No failed hold is released here. New dialogue starts strictly after the latest known trigger. */
 contextBoundary(characterId:CharacterId):{fingerprint:string;holds:readonly string[];active:boolean;afterOrder:number|null} {
  this.has(characterId);
  const rows=this.db.prepare(`SELECT p.current_message_id,p.source_version,p.scope_json,p.intent,
    r.logical_order,r.version,r.state,r.kind,r.message_role FROM memory_pending_mutations p
    LEFT JOIN memory_records r ON r.character_id=p.character_id AND r.id=p.current_message_id
    WHERE p.character_id=? AND p.status IN ('pending','failed') ORDER BY p.current_message_id`).all(characterId) as {logical_order:number|null;version:number|null;source_version:number;state:string|null;kind:string|null;message_role:string|null}[];
  const valid=rows.length>0&&rows.every(r=>Number.isSafeInteger(r.logical_order)&&r.logical_order!>0&&r.version===r.source_version&&r.state==='active'&&r.kind==='transcript'&&r.message_role==='user');
  const holds=rows.map(row=>createHash('sha256').update(JSON.stringify(row)).digest('hex'));
  return {fingerprint:createHash('sha256').update(JSON.stringify(holds)).digest('hex'),holds,active:rows.length>0,afterOrder:valid?Math.max(...rows.map(r=>r.logical_order!)):null};
 }
 list(characterId:CharacterId):readonly {scope:TurnScope;currentMessageId:string;intent:PendingIntent;status:'pending'|'failed'}[] {
  this.has(characterId);
  return (this.db.prepare("SELECT * FROM memory_pending_mutations WHERE character_id=? AND status IN ('pending','failed') ORDER BY rowid").all(characterId) as Row[]).map(row=>({scope:JSON.parse(row.scope_json),currentMessageId:row.current_message_id,intent:row.intent,status:row.status as 'pending'|'failed'}));
 }
 begin(scope:TurnScope,id:string,version:number,intent:PendingIntent):void {
  if(!['forget','correction','uncertain'].includes(intent))throw new MemoryRuleError('invalid_pending_request');
  const prior=this.row(scope,id);
  if(prior){if(!sameScope(JSON.parse(prior.scope_json),scope)||prior.intent!==intent||prior.source_version!==version)throw new MemoryRuleError('pending_identity_mismatch');return;}
  this.db.prepare("INSERT INTO memory_pending_mutations VALUES(?,?,?,?,?,'pending')").run(scope.characterId,id,JSON.stringify(scope),version,intent);
  // Previously captured strict work cannot commit old material after a new privacy request.
  this.db.prepare('UPDATE characters SET epoch=epoch+1,revision=revision+1 WHERE character_id=?').run(scope.characterId);
 }
 finish(scope:TurnScope,id:string,outcome:MemoryTurnOutcome):void {
  const row=this.row(scope,id);if(!row||(row.status==='completed'||row.status==='cancelled'))return;
  if(!sameScope(scope,JSON.parse(row.scope_json))||!sameScope(scope,outcome.scope))throw new MemoryRuleError('pending_identity_mismatch');
  const successful=outcome.status==='applied'||outcome.status==='unchanged';
  const completed=successful&&(row.intent==='uncertain'||(outcome.status==='applied'&&row.intent===outcome.request));
  this.db.prepare('UPDATE memory_pending_mutations SET status=? WHERE character_id=? AND current_message_id=?').run(completed?'completed':'failed',scope.characterId,id);
 }
 fail(scope:TurnScope,id:string):void {const row=this.row(scope,id);if(!row||(row.status==='completed'||row.status==='cancelled'))return;if(!sameScope(scope,JSON.parse(row.scope_json)))throw new MemoryRuleError('pending_identity_mismatch');this.db.prepare("UPDATE memory_pending_mutations SET status='failed' WHERE character_id=? AND current_message_id=?").run(scope.characterId,id);}
 assertWritable(scope:TurnScope,id:string,version?:number):void {
  const row=this.row(scope,id);if(!row)return;
  if(!sameScope(scope,JSON.parse(row.scope_json)))throw new MemoryRuleError('pending_identity_mismatch');
  if(row.status==='cancelled')throw new MemoryRuleError('pending_request_cancelled');
  if(version!==undefined&&version!==row.source_version)throw new MemoryRuleError('pending_source_version_changed');
 }
 cancel(scope:TurnScope,id:string):void {
  this.db.transaction(()=>{
   const row=this.row(scope,id);if(!row)return;
   if(!sameScope(scope,JSON.parse(row.scope_json)))throw new MemoryRuleError('pending_identity_mismatch');
   if(row.status==='completed'||row.status==='cancelled')return;
   this.db.prepare("UPDATE memory_pending_mutations SET status='cancelled' WHERE character_id=? AND current_message_id=?").run(scope.characterId,id);
   this.db.prepare('UPDATE characters SET epoch=epoch+1,revision=revision+1 WHERE character_id=?').run(scope.characterId);
  }).immediate();
 }
 completed(scope:TurnScope,id:string,version:number):boolean {const row=this.row(scope,id);return !!row&&sameScope(scope,JSON.parse(row.scope_json))&&row.source_version===version&&row.status==='completed';}
}
