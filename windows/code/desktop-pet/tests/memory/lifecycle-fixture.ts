import type { MemoryTurnInput, MemoryTurnPlan, MemoryTurnProvider, SummaryInput, SummaryProvider } from '../../contracts/memory-lifecycle.js';
import type { TurnScope } from '../../contracts/index.js';
import type { SqliteMemoryStore } from '../../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort, type SqliteLifecycleOptions } from '../../memory/sqlite-lifecycle-port.js';
export const signal = () => new AbortController().signal;
export const none = (input: MemoryTurnInput): MemoryTurnPlan => ({ scope:input.scope, request:'none', changes:[], suppressSources:[], clarification:null, reason:'no relevant change' });
/** Fixture emits explicit 0.3 dispositions for a deliberately resolved whole-source request. */
export const forget = (input: MemoryTurnInput, ids: string[]): MemoryTurnPlan => {
  const chosen=new Set([...ids,input.currentMessageId]);
  for(let changed=true;changed;){changed=false;for(const source of input.sources){
    if(source.kind==='memory')continue;
    if(chosen.has(source.id)&&source.kind==='summary')for(const ref of source.sourceVersions??[])if(input.sources.some(s=>s.id===ref.id&&s.kind==='transcript')&&!chosen.has(ref.id)){chosen.add(ref.id);changed=true;}
    if((source.sourceVersions??[]).some(ref=>chosen.has(ref.id))&&!chosen.has(source.id)){chosen.add(source.id);changed=true;}
  }}
  return {...none(input),request:'forget',reason:'explicit whole-source fixture',suppressSources:[...chosen].map(id=>({id,version:input.sources.find(source=>source.id===id)!.version})),retainSources:[]};
};
export const summaryProposal = (input: SummaryInput) => ({scope:input.scope,text:'用户讨论了已选择的事情。',sourceVersions:input.sources.map(({id,version})=>({id,version}))});
export const contextOptions = {inputTokenBudget:30000,maxRecentMessages:12,maxMemories:8,summaryLimit:4,countTokens:(context:unknown,text:string)=>JSON.stringify(context).length+text.length,relevance:()=>1};
export function lifecycle(store:SqliteMemoryStore, turn:MemoryTurnProvider['plan']=async input=>none(input), summary:SummaryProvider['summarize']=async input=>summaryProposal(input), override:Partial<SqliteLifecycleOptions>={}) {
  return new SqliteLifecycleMemoryPort(store,{context:contextOptions,
    turn:{provider:{plan:turn},inputTokenBudget:20000,countTokens:input=>JSON.stringify(input).length},
    summary:{provider:{summarize:summary},minMessages:2,maxMessages:6,inputTokenBudget:10000,countTokens:input=>JSON.stringify(input).length},...override});
}
export function deferred<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve}; }
export const replyMessage = (scope:TurnScope,text='收到。') => ({characterId:scope.characterId,id:`${scope.turnId}:assistant`,role:'assistant' as const,text,createdAt:'2026-09-06T12:01:00Z'});
