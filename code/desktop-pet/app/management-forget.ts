import { createHash } from 'node:crypto';
import type { MemoryRecordAction, MemoryRecordActionResult } from '../contracts/memory-dynamics.js';
import { ManagementError, type ManagementMemoryPort } from '../contracts/management.js';
import type { MemoryTurnInput, MemoryTurnPlan } from '../contracts/memory-lifecycle.js';
import type { SqliteMemoryStore } from '../memory/sqlite-store.js';
import type { InputBudget } from '../memory/sqlite-lifecycle-state.js';
import { MemoryRuleError } from '../memory/scope.js';

interface ForgetTicket {readonly input:MemoryTurnInput;readonly action:MemoryRecordAction;readonly dataRevision:number}
export interface ManagementForgetLifecycle {
 managementForgetOutcome(action:MemoryRecordAction):MemoryRecordActionResult|null;
 readManagementForget(action:MemoryRecordAction,budget:InputBudget<MemoryTurnInput>):ForgetTicket;
 commitManagementForget(ticket:ForgetTicket,plan:MemoryTurnPlan):MemoryRecordActionResult;
 discardManagementForget(ticket:ForgetTicket):void;
}
function translated(error:unknown):never {
 if(error instanceof ManagementError)throw error;
 if(error instanceof MemoryRuleError&&(/stale|version_conflict|operation_id_payload_mismatch/.test(error.message)))
  throw new ManagementError('version_conflict','数据或操作已变化，尚未执行遗忘，请刷新后重试。');
 throw new ManagementError('unavailable','严格来源处理未完成，尚未执行遗忘。请稍后查看或重试。');
}
/** User-triggered management only. No raw text, model responses or credentials are copied to diagnostics. */
export class StrictManagementForget {
 private readonly pending=new Map<string,{signature:string;result:Promise<MemoryRecordActionResult>}>();
 private readonly controller=new AbortController();
 constructor(private readonly store:SqliteMemoryStore,private readonly lifecycle:ManagementForgetLifecycle,
  private readonly budget:InputBudget<MemoryTurnInput>,private readonly plan:(input:MemoryTurnInput,signal:AbortSignal,action:MemoryRecordAction)=>Promise<MemoryTurnPlan>){}
 forget(action:MemoryRecordAction):Promise<MemoryRecordActionResult>{
  const captured=structuredClone(action),key=JSON.stringify([captured.characterId,captured.operationId]);
  const signature=createHash('sha256').update(JSON.stringify([captured.characterId,captured.id,captured.expectedVersion,captured.operationId,captured.reason])).digest('hex');
  const prior=this.pending.get(key);
  if(prior){if(prior.signature!==signature)return Promise.reject(new ManagementError('version_conflict','同一操作标识不能用于不同请求。'));return prior.result;}
  const result=this.execute(captured).catch(translated).finally(()=>this.pending.delete(key));
  this.pending.set(key,{signature,result});return result;
 }
 private async execute(action:MemoryRecordAction):Promise<MemoryRecordActionResult>{
  this.controller.signal.throwIfAborted();
  const prior=this.lifecycle.managementForgetOutcome(action);if(prior)return prior;
  try{return this.store.dynamicsAction({characterId:action.characterId,sessionId:'management-dynamics',turnId:action.operationId,generation:0},action,false);}
  catch(error){if(!(error instanceof MemoryRuleError)||error.message!=='forget_requires_source_plan')throw error;}
  const ticket=this.lifecycle.readManagementForget(action,this.budget);
  try{
   const plan=await this.plan(structuredClone(ticket.input),this.controller.signal,structuredClone(action));this.controller.signal.throwIfAborted();
   return this.lifecycle.commitManagementForget(ticket,plan);
  }finally{this.lifecycle.discardManagementForget(ticket);}
 }
 close(){this.controller.abort();}
 async drain(){await Promise.allSettled([...this.pending.values()].map(x=>x.result));}
}
export function withStrictManagementForget(memory:ManagementMemoryPort,forget:StrictManagementForget):ManagementMemoryPort {
 const d=memory.dynamics;if(!d)throw Error('Memory dynamics port is required');
 return {characters:()=>memory.characters(),list:q=>memory.list(q),edit:i=>memory.edit(i),context:(c,q)=>memory.context(c,q),prompt:c=>memory.prompt(c),savePrompt:i=>memory.savePrompt(i),
  dynamics:{snapshot:q=>d.snapshot(q),traces:q=>d.traces(q),preview:i=>d.preview(i),savePolicy:i=>d.savePolicy(i),rollbackPolicy:i=>d.rollbackPolicy(i),restore:i=>d.restore(i),forget:i=>forget.forget(i)}};
}
