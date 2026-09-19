import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { TurnScope, ConversationMessage } from '../contracts/index.js';
import type { MemoryRecordAction, MemoryRecordActionResult } from '../contracts/memory-dynamics.js';
import type { MemoryTurnInput, MemoryTurnPlan, MemoryTurnOutcome } from '../contracts/memory-lifecycle.js';
import type { InputBudget } from './sqlite-lifecycle-state.js';
import type { SqliteMemoryStore } from './sqlite-store.js';
import type { MemoryRecord } from './ledger.js';
import { SqliteLedgerBacking } from './sqlite-backing.js';
import { sourceGraph, readable } from './source-graph.js';
import { bindScope, MemoryRuleError } from './scope.js';

export interface ManagementForgetTicket {
  readonly action:MemoryRecordAction;
  readonly input:MemoryTurnInput;
  readonly dataRevision:number;
}
interface Captured {ticket:ManagementForgetTicket; fingerprint:string; epoch:number; virtual:MemoryRecord}
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}':JSON.stringify(value);
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const signature=(action:MemoryRecordAction)=>digest({type:'dynamics_forget',...action});
function fail(message:string):never {throw new MemoryRuleError(message);}

/** Read-only preparation; the model call belongs to the host, outside the commit transaction. */
export class SqliteManagementForget {
  private readonly tickets=new WeakMap<ManagementForgetTicket,Captured>();
  constructor(private readonly db:Database.Database,private readonly store:SqliteMemoryStore,
    private readonly commit:(input:MemoryTurnInput,plan:MemoryTurnPlan)=>MemoryTurnOutcome) {}
  private validate(action:MemoryRecordAction):TurnScope {
    if(!action||typeof action.id!=='string'||!action.id.trim()||typeof action.operationId!=='string'||!action.operationId.trim()||typeof action.reason!=='string'||!action.reason.trim()||!Number.isSafeInteger(action.expectedVersion)||action.expectedVersion<1)fail('invalid_management_request');
    return bindScope({characterId:action.characterId,sessionId:'management-forget',turnId:`management-forget:${digest(action.operationId)}`,generation:0},action.characterId);
  }
  outcome(action:MemoryRecordAction):MemoryRecordActionResult|null {
    const scope=this.validate(action);
    const row=this.db.prepare('SELECT signature,result_json FROM memory_operations WHERE character_id=? AND operation_id=?').get(scope.characterId,action.operationId) as {signature:string|null;result_json:string|null}|undefined;
    if(!row)return null;
    if(row.signature!==signature(action)||!row.result_json)fail('operation_id_payload_mismatch');
    return JSON.parse(row.result_json) as MemoryRecordActionResult;
  }
  read(action:MemoryRecordAction,budget:InputBudget<MemoryTurnInput>):ManagementForgetTicket {
    const scope=this.validate(action);
    if(!Number.isSafeInteger(budget.inputTokenBudget)||budget.inputTokenBudget<1)fail('invalid_context_budget');
    return this.db.transaction(()=>{
      if(this.outcome(action))fail('management_forget_already_completed');
      const target=this.store.inspect(scope,action.id);
      if(!target||target.kind!=='memory'||target.state!=='active'||target.evidenceEligible===false)fail('memory_hard_gate');
      if(target.version!==action.expectedVersion)fail('version_conflict');
      const graph=sourceGraph(this.db,scope),connected=new Set([target.id]);
      // Include shared siblings and all preservation supports. Never apply ordinary recall's six-item cap.
      for(let changed=true;changed;) {
        changed=false;
        for(const node of graph.values()) {
          if(connected.has(node.id)){for(const ref of node.sources)if(!connected.has(ref.id)){connected.add(ref.id);changed=true;}}
          if(!connected.has(node.id)&&node.sources.some(ref=>connected.has(ref.id))){connected.add(node.id);changed=true;}
        }
      }
      const records=[...connected].map(id=>graph.get(id)).filter(node=>node&&readable(node)).map(node=>this.store.inspect(scope,node!.id)!).sort((a,b)=>(a.logicalOrder??0)-(b.logicalOrder??0)||a.id.localeCompare(b.id));
      const createdAt=this.store.now(),id=`management-request:${randomUUID()}`;
      const text=`[用户在网页发起的遗忘请求；不是发生过的聊天，不得作为事实记忆或保留片段]\n选中记录ID：${target.id}；版本：${target.version}\n请遗忘选中的长期记忆：${target.text}\n用户填写的原因：${action.reason}`;
      const message:ConversationMessage={characterId:scope.characterId,id,role:'user',origin:'manual',text,createdAt};
      const virtual:MemoryRecord={characterId:scope.characterId,id,kind:'transcript',state:'active',version:1,text,sources:[],createdAt,deletedAt:null,reason:'management_request_only',message,perception:null,evidenceEligible:true,origin:'manual'};
      const source=(record:MemoryRecord)=>({...(record.origin?{origin:record.origin}:{}),scope,id:record.id,version:record.version,kind:record.kind as 'transcript'|'summary'|'memory',text:record.text,createdAt:record.createdAt,messageRole:record.message?.role??null,sourceVersions:record.sources.map(ref=>({...ref})),evidenceEligible:record.evidenceEligible!==false});
      const input:MemoryTurnInput={scope,currentMessageId:id,sources:[...records,virtual].map(source),messages:[...records.filter(record=>record.kind==='transcript').map(record=>record.message!),message],relevantMemories:records.filter(record=>record.kind==='memory').map(record=>({characterId:record.characterId,id:record.id,version:record.version,text:record.text,sourceIds:record.sources.map(ref=>ref.id),...(record.origin?{origin:record.origin}:{})}))};
      const count=budget.countTokens(structuredClone(input));if(!Number.isSafeInteger(count)||count<0)fail('invalid_token_count');if(count>budget.inputTokenBudget)fail('management_source_closure_exceeds_budget');
      const ticket:ManagementForgetTicket=Object.freeze({action:structuredClone(action),input:structuredClone(input),dataRevision:this.store.revision(scope)});
      const epoch=(this.db.prepare('SELECT epoch FROM characters WHERE character_id=?').get(scope.characterId) as {epoch:number}).epoch;
      this.tickets.set(ticket,{ticket:structuredClone(ticket),fingerprint:digest(ticket),epoch,virtual});return ticket;
    })();
  }
  discard(ticket:ManagementForgetTicket):void {this.tickets.delete(ticket);}
  apply(ticket:ManagementForgetTicket,proposal:MemoryTurnPlan):MemoryRecordActionResult {
    const captured=this.tickets.get(ticket);this.tickets.delete(ticket);
    if(!captured||digest(ticket)!==captured.fingerprint)fail('unknown_or_modified_management_ticket');
    const {action,input,dataRevision}=captured.ticket,scope=input.scope;
    const plan=structuredClone(proposal);
    return this.db.transaction(()=>{
      const prior=this.outcome(action);if(prior)return prior;
      const backing=new SqliteLedgerBacking(this.db,scope.characterId);
      if(backing.epoch!==captured.epoch||backing.revision!==dataRevision)fail('stale_management_forget');
      if(plan.request!=='forget'||plan.clarification!==null||!plan.changes.some(change=>change.operation.type==='soft_delete'&&change.operation.id===action.id&&change.operation.expectedVersion===action.expectedVersion))fail('management_forget_target_required');
      if((plan.dynamics?.traits.length??0)||(plan.dynamics?.reinforcements.length??0))fail('management_forget_dynamic_plan_not_supported');
      const virtualId=input.currentMessageId;
      if((plan.retainSources??[]).some(entry=>entry.source.id===virtualId||entry.supportSourceIds.includes(virtualId)))fail('management_request_cannot_be_retained');
      for(const {operation:op} of plan.changes) {
        const refs=op.type==='add'||op.type==='update'?op.sourceIds:op.type==='merge'?op.replacement.sourceIds:[];
        if(refs.includes(virtualId))fail('management_request_cannot_support_memory');
      }
      // Recheck every captured body/version before temporarily materializing the virtual request.
      for(const source of input.sources)if(source.id!==virtualId) {
        const actual=this.store.inspect(scope,source.id);
        if(!actual||actual.state!=='active'||actual.evidenceEligible===false||actual.version!==source.version||actual.text!==source.text)fail('stale_lifecycle_source');
      }
      if(backing.records.has(virtualId))fail('management_request_id_collision');
      backing.records.set(virtualId,captured.virtual);
      const outcome=this.commit(input,plan);
      if(outcome.status!=='applied')fail(outcome.rejectionCode??'management_forget_rejected');
      const target=this.store.inspect(scope,action.id);
      if(target?.state!=='deleted')fail('management_forget_target_survived');
      const request=backing.records.get(virtualId)!;
      if(request.state==='active')fail('management_request_survived');
      // The short-lived request is not conversation history, even in an all-records management view.
      backing.records.set(virtualId,{...request,state:'purged',text:'',message:null,perception:null,evidenceEligible:false,reason:'management_request_consumed'});
      const pruned=this.store.pruneForLifecycle();
      this.store.dynamics.sync(scope);this.store.recall.invalidate();
      const result:MemoryRecordActionResult={characterId:scope.characterId,revision:backing.revision,affectedIds:[...new Set([...outcome.affectedIds.filter(id=>id!==virtualId),...pruned.filter(item=>item.characterId===scope.characterId).map(item=>item.id)])],status:'applied'};
      this.db.prepare('INSERT INTO memory_operations(character_id,operation_id,signature,result_json) VALUES(?,?,?,?)').run(scope.characterId,action.operationId,signature(action),JSON.stringify(result));
      return result;
    }).immediate();
  }
}
