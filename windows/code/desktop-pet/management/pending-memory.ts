import {COMPANION_ID} from '../contracts/character.js';
import {ManagementError} from '../contracts/management.js';
import type {BackgroundMemoryPort} from '../contracts/memory-lifecycle.js';
import type {TurnScope} from '../contracts/index.js';
export interface PendingMemoryManagement {
 list():{instanceId:string;requests:readonly {id:string;intent:string;status:string;preview:string;createdAt:string|null}[];busy:boolean};
 retry(instanceId:string,id:string):{status:'queued'};
 cancel(instanceId:string,id:string):Promise<{status:'cancelled'}>;
}
/** Explicit management clicks only; never starts or cancels work during construction/read. */
export function pendingMemoryManagement(instanceId:string,memory:BackgroundMemoryPort,
 readSource:(scope:TurnScope,id:string)=>{text:string;createdAt:string}|undefined,
 enqueue:(scope:TurnScope,id:string,text:string)=>Promise<unknown>,isBusy:()=>boolean):PendingMemoryManagement {
 const running=new Set<string>();
 const list=()=>({instanceId,requests:(memory.pendingMutations?.(COMPANION_ID)??[]).map(x=>{const source=readSource(x.scope,x.currentMessageId);return{id:x.currentMessageId,intent:x.intent,status:x.status,preview:source?Array.from(source.text).slice(0,100).join(''):'原请求内容已不可用',createdAt:source?.createdAt??null};}),busy:isBusy()||running.size>0});
 const find=(expected:string,id:string)=>{if(expected!==instanceId)throw new ManagementError('version_conflict','服务已经重启，请刷新后核对未完成请求。');const row=memory.pendingMutations?.(COMPANION_ID).find(x=>x.currentMessageId===id);if(!row)throw new ManagementError('version_conflict','请求状态已经变化，请刷新后核对。');return row;};
 return{list,retry(expected,id){const row=find(expected,id);if(list().busy)throw new ManagementError('version_conflict','后台仍有任务，请等它结束后再决定是否重新处理。');const source=readSource(row.scope,id);if(source===undefined)throw new ManagementError('unavailable','原请求已经无法读取，请核对后撤销未完成请求或重新说明。');running.add(id);try{void enqueue(row.scope,id,source.text).catch(()=>{}).finally(()=>running.delete(id));}catch(error){running.delete(id);throw error;}return{status:'queued'};},
 async cancel(expected,id){const row=find(expected,id);if(!memory.cancelPendingMutation)throw new ManagementError('unavailable','当前版本尚未接入此操作。');await memory.cancelPendingMutation(row.scope,id);return{status:'cancelled'};}};
}
