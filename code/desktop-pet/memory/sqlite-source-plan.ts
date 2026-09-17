import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import type {MemoryChange, MemoryChangeResult} from '../contracts/index.js';
import type {MemoryTurnInput, MemoryTurnPlan, SourceRetention, SourceVersion} from '../contracts/memory-lifecycle.js';
import type {MemoryRecord} from './ledger.js';
import {SqliteLedgerBacking} from './sqlite-backing.js';
import type {SqliteMemoryStore} from './sqlite-store.js';
import {MemoryRuleError, sameScope, timestamp} from './scope.js';
import {descendants, sourceGraph} from './source-graph.js';

const fail = (code: string): never => {throw new MemoryRuleError(code);};
const refs = (change: MemoryChange): readonly string[] => {
  const op=change.operation;return op.type==='add'||op.type==='update'?op.sourceIds:op.type==='merge'?op.replacement.sourceIds:[];
};
const targets = (change: MemoryChange): readonly {id:string;expectedVersion:number}[] => {
  const op=change.operation;return op.type==='add'?[]:op.type==='merge'?op.targets:[{id:op.id,expectedVersion:op.expectedVersion}];
};
export type SourcePlanPreparation =
  | {status:'needs_sources'; missing:readonly SourceVersion[]; rejectionCode:string}
  | {status:'ready'; records:ReadonlyMap<string,MemoryRecord>; results:readonly MemoryChangeResult[]};

/** Pure read/validation stage shared by expansion preflight and atomic commit. No ID allocation or writes. */
export function prepareSourcePlan(db: Database.Database, store: SqliteMemoryStore, input: MemoryTurnInput, plan: MemoryTurnPlan): SourcePlanPreparation {
  const scope=input.scope, now=store.now(), backing=new SqliteLedgerBacking(db,scope.characterId);
  const graph=sourceGraph(db,scope), allowed=new Map(input.sources.map(source=>[source.id,source]));
  const read=(id:string):MemoryRecord => backing.records.get(id) ?? fail('unknown_source');
  const retentions=plan.retainSources ?? [];
  if (!Array.isArray(retentions)) fail('invalid_retention_plan');
  const explicit=new Set<string>(), roots=new Set<string>(), targetIds=new Set<string>(), operationIds=new Set<string>();
  const freshIds=new Set<string>();
  for (const ref of plan.suppressSources) {
    const source=allowed.get(ref.id);
    if (!source || source.evidenceEligible===false || source.kind==='memory' || source.version!==ref.version || explicit.has(ref.id)) fail('invalid_suppression_source');
    explicit.add(ref.id);roots.add(ref.id);
  }
  for (const change of plan.changes) {
    if (!sameScope(change.scope,scope) || !change.operationId || !change.reason?.trim() || operationIds.has(change.operationId) || backing.operations.has(change.operationId)) fail('invalid_change_identity');
    timestamp(change.createdAt); operationIds.add(change.operationId);
    const op=change.operation;
    if (!['add','update','merge','soft_delete','restore'].includes(op.type)) fail('unknown_operation');
    if (op.type==='merge' && (op.targets.length<2 || new Set(op.targets.map(t=>t.id)).size!==op.targets.length)) fail('invalid_merge_targets');
    for (const target of targets(change)) {
      if (targetIds.has(target.id)) fail('duplicate_memory_target');
      const source=allowed.get(target.id);
      if (!source || source.kind!=='memory' || source.version!==target.expectedVersion) fail('target_not_in_turn_input');
      targetIds.add(target.id);
    }
    if (op.type==='restore') fail('restore_target_not_in_turn_input');
    if(op.type==='update' && op.sourceIds.some(id=>id!==op.id&&descendants(graph,[op.id]).has(id)))fail('cyclic_source');
    const fresh=op.type==='add'?op.id:op.type==='merge'?op.replacement.id:null;
    if (fresh!==null) {
      if (!fresh || /^f\d+$/.test(fresh) || backing.records.has(fresh) || freshIds.has(fresh)) fail('duplicate_or_empty_id');
      freshIds.add(fresh);
    }
  }
  const fragments=new Map<string, {entry:SourceRetention; parent:MemoryRecord; id:string}>();
  const ranges=new Map<string,{start:number;end:number}[]>();
  for (const entry of retentions) {
    if (!/^f\d+$/.test(entry.fragmentId) || fragments.has(entry.fragmentId) || allowed.has(entry.fragmentId) || backing.records.has(entry.fragmentId) || freshIds.has(entry.fragmentId)) fail('invalid_fragment_alias');
    const source=allowed.get(entry.source.id) ?? fail('invalid_fragment_source');
    if (!source || source.evidenceEligible===false || source.version!==entry.source.version || source.kind==='memory' || !explicit.has(source.id)) fail('invalid_fragment_source');
    const parent=read(source.id), length=[...parent.text].length;
    if (!Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) || entry.start<0 || entry.start>=entry.end || entry.end>length || !Array.isArray(entry.supportSourceIds) || new Set(entry.supportSourceIds).size!==entry.supportSourceIds.length) fail('invalid_fragment_range_or_support');
    const prior=ranges.get(source.id) ?? [];
    if (prior.some(span=>entry.start<span.end && span.start<entry.end)) fail('overlapping_fragments');
    prior.push(entry);ranges.set(source.id,prior);
    // A plan-local alias is sufficient for pure DAG validation. Permanent IDs are allocated only at commit.
    const id=entry.fragmentId;freshIds.add(id);fragments.set(entry.fragmentId,{entry,parent,id});
  }
  // Updated/retired memory versions invalidate descendants, but surviving targets are rebuilt below.
  const mutationRoots=new Set(targetIds);
  for (const change of plan.changes) {
    const op=change.operation;
    if (op.type!=='update' && op.type!=='soft_delete') continue;
    const newEvidence=new Set<string>();
    for (const id of refs(change)) if (allowed.has(id)) {newEvidence.add(id);for(const ref of read(id).sources)newEvidence.add(ref.id);}
    for (const ref of read(op.id).sources) {
      const ancestor=graph.get(ref.id);
      if (ancestor?.kind==='transcript' && ancestor.state==='active' && !newEvidence.has(ref.id)) roots.add(ref.id);
    }
  }
  if (plan.request==='forget') {
    if (!plan.changes.length && !explicit.size) fail('forget_without_target');
    roots.add(input.currentMessageId);
  }
  // Summary ancestors may still contain the forgotten words. Expired payloads are metadata only.
  for (let changed=true;changed;) {
    changed=false;
    for (const id of descendants(graph,[...roots,...mutationRoots])) {
      const node=graph.get(id);
      if (node?.kind==='summary') for (const ref of node.sources) {
        const parent=graph.get(ref.id);
        if (parent?.kind==='transcript' && parent.state==='active' && !roots.has(parent.id)) {roots.add(parent.id);changed=true;}
      }
    }
  }
  if (plan.request==='correction' && !plan.changes.length && !roots.size) fail('correction_without_change');
  const affected=descendants(graph,[...roots,...mutationRoots]);
  // An expired raw ancestor remains an opaque bridge to its existing siblings. It is not a kill root.
  for (const id of [...roots,...mutationRoots]) for (const ref of graph.get(id)?.sources ?? []) {
    if (graph.get(ref.id)?.state==='expired' && graph.get(ref.id)?.kind==='transcript') {
      for (const sibling of descendants(graph,[ref.id])) if (graph.get(sibling)?.state==='active') affected.add(sibling);
    }
  }
  const missing:SourceVersion[]=[];
  for (const id of affected) {
    const node=graph.get(id);
    if(node?.state!=='active'||!['memory','transcript','summary'].includes(node.kind))continue;
    // Evidence eligibility cannot weaken the existing no-implicit-memory-deletion rule.
    if(node.kind==='memory'&&!node.eligible)fail('unresolved_memory_suppression');
    if(!node.eligible)continue;
    if(!allowed.has(id)){missing.push({id,version:node.version});continue;}
    if(node.kind==='memory'&&!targetIds.has(id))fail('unresolved_memory_suppression');
  }
  for (const id of affected) {
    const node=graph.get(id);
    if(node?.state==='active'&&node.eligible&&allowed.has(id)&&['transcript','summary'].includes(node.kind)&&!explicit.has(id))fail('unresolved_source_disposition');
  }
  const missingAffected=missing.length>0;
  // Known omissions have already failed above. Missing valid supports of affected derived
  // content are necessary to preserve unrelated fragments, even if the source itself survives.
  const needed=new Set(missing.map(ref=>ref.id));
  for(const id of affected){
    const node=graph.get(id);if(node?.state!=='active'||!node.eligible)continue;
    for(const ref of node.sources){
      const support=graph.get(ref.id);
      if(support&&support.state==='active'&&support.eligible&&support.version===ref.version&&['memory','transcript','summary'].includes(support.kind)&&!allowed.has(ref.id)&&!needed.has(ref.id)){
        missing.push({...ref});needed.add(ref.id);
      }
    }
  }
  const built=new Map<string,MemoryRecord>(), visiting=new Set<string>();
  const flatten=(ids: readonly string[], fragmentSupport=false):SourceVersion[] => {
    if (!ids.length || new Set(ids).size!==ids.length) return fail('missing_or_duplicate_sources');
    const versions=new Map<string,SourceVersion>();
    for (const id of ids) {
      let record:MemoryRecord;
      if (fragments.has(id)) record=build(id);
      else {
        const source=allowed.get(id);
        if (!source || source.evidenceEligible===false) fail('source_not_in_turn_input');
        record=read(id);
        if (fragmentSupport && (affected.has(id)||targetIds.has(id))) fail('fragment_support_will_change');
        if (roots.has(id) || record.sources.some(ref=>roots.has(ref.id))) fail('new_evidence_will_be_suppressed');
        if (record.kind!=='memory' && affected.has(id)) fail('new_evidence_will_be_suppressed');
      }
      for (const ref of [...record.sources,{id:record.id,version:record.version}]) {
        if ((versions.get(ref.id)?.version??0)<ref.version) versions.set(ref.id,{...ref});
      }
    }
    return [...versions.values()];
  };
  const build=(alias:string):MemoryRecord => {
    if (built.has(alias)) return built.get(alias)!;
    if (visiting.has(alias)) return fail('cyclic_fragment_support');
    const fragment=fragments.get(alias) ?? fail('unknown_fragment');
    const {entry,parent,id}=fragment;visiting.add(alias);
    let sources:SourceVersion[]=[];
    if (parent.message?.role==='user'||parent.origin==='manual') {
      if (entry.supportSourceIds.length) fail('user_fragment_must_be_root');
    } else if (entry.supportSourceIds.length) sources=flatten(entry.supportSourceIds,true);
    else {
      if (parent.kind!=='summary' || !parent.sources.length || parent.sources.some(ref=>{
        const ancestor=graph.get(ref.id);return !ancestor || ancestor.kind!=='transcript' || ancestor.state!=='expired' || ancestor.version!==ref.version;
      })) fail('derived_fragment_requires_support');
      sources=parent.sources.map(ref=>({...ref}));
    }
    const text=[...parent.text].slice(entry.start,entry.end).join('');
    const result:MemoryRecord={...parent,id,version:1,state:'active',text,sources,deletedAt:null,reason:'retained_source_fragment',evidenceEligible:true,
      fragment:{parent:{...entry.source},start:entry.start,end:entry.end},message:parent.message?{...parent.message,id,text}:null};
    built.set(alias,result);visiting.delete(alias);return result;
  };
  for(const alias of fragments.keys())build(alias);
  const final=new Map<string,MemoryRecord>(), results:MemoryChangeResult[]=[];
  const makeMemory=(id:string,text:string,sources:SourceVersion[],createdAt:string):MemoryRecord=>({characterId:scope.characterId,id,kind:'memory',version:1,state:'active',text,sources,createdAt,deletedAt:null,reason:null,message:null,perception:null,evidenceEligible:true});
  for (const change of plan.changes) {
    const op=change.operation, changed:string[]=[];
    if (op.type==='add') {final.set(op.id,makeMemory(op.id,op.text,flatten(op.sourceIds),change.createdAt));changed.push(op.id);}
    else if (op.type==='update') {const old=read(op.id);final.set(op.id,{...old,...(old.origin?{origin:'automatic' as const}:{}),version:old.version+1,text:op.text,sources:flatten(op.sourceIds),reason:change.reason});changed.push(op.id);}
    else if (op.type==='merge') {
      const sources=flatten(op.replacement.sourceIds);
      for(const target of op.targets){const old=read(target.id);final.set(old.id,{...old,state:'deleted',version:old.version+1,deletedAt:now,reason:change.reason});changed.push(old.id);}
      final.set(op.replacement.id,makeMemory(op.replacement.id,op.replacement.text,sources,change.createdAt));changed.push(op.replacement.id);
    } else if (op.type==='soft_delete') {const old=read(op.id);final.set(old.id,{...old,state:'deleted',version:old.version+1,deletedAt:now,reason:change.reason});changed.push(old.id);}
    results.push({characterId:scope.characterId,operationId:change.operationId,status:'applied',affectedIds:changed,retrievalInvalidated:true});
  }
  // A batch may introduce a cycle that was absent in the captured graph. Self means a prior
  // version (the established update semantics); dependencies through another ID may not cycle.
  const visitingMemory=new Set<string>(),visitedMemory=new Set<string>();
  const acyclic=(id:string):void=>{
    if(visitingMemory.has(id))fail('cyclic_source');if(visitedMemory.has(id))return;
    visitingMemory.add(id);
    const record=final.get(id)??[...built.values()].find(record=>record.id===id)??backing.records.get(id);
    for(const ref of record?.sources??[])if(ref.id!==id)acyclic(ref.id);
    visitingMemory.delete(id);visitedMemory.add(id);
  };
  for(const record of final.values())if(record.kind==='memory'&&record.state==='active')acyclic(record.id);
  if (plan.request==='correction' && explicit.has(input.currentMessageId) && ![...built.values()].some(fragment=>fragment.message?.role==='user'&&fragment.fragment?.parent.id===input.currentMessageId)) fail('correction_current_without_retained_evidence');
  if(missing.length)return {status:'needs_sources',missing,rejectionCode:!missingAffected?'unread_preservation_support':missing.some(ref=>graph.get(ref.id)?.kind==='memory')?'unresolved_memory_suppression':'unresolved_source_disposition'};
  for (const id of affected) {
    if (final.has(id)) continue;
    const node=graph.get(id);if(node?.state!=='active')continue;
    const old=read(id);
    final.set(id,{...old,state:old.kind==='memory'?'deleted':'invalidated',version:old.version+1,reason:'lifecycle_source_suppressed',
      ...(old.kind==='memory'?{deletedAt:now}:old.kind==='transcript'?{}:{text:'',perception:null})});
  }
  for(const record of built.values())final.set(record.id,record);
  // Any business change invalidates retained query caches, including negative results.
  if(final.size)for(const node of graph.values())if(node.kind==='context_cache'&&node.state==='active'&&!final.has(node.id)){
    const old=read(node.id);final.set(node.id,{...old,state:'invalidated',text:'',version:old.version+1,reason:'context_revision_changed'});
  }
  return {status:'ready',records:final,results};
}

/** The caller owns an immediate transaction and revalidates the full captured input before this call. */
export function applySourcePlan(db:Database.Database,store:SqliteMemoryStore,input:MemoryTurnInput,plan:MemoryTurnPlan,options:{prune?:boolean}={}):{results:readonly MemoryChangeResult[];affectedIds:readonly string[]}{
  const draft=prepareSourcePlan(db,store,input,plan);
  if(draft.status==='needs_sources')return fail(draft.rejectionCode);
  const scope=input.scope,backing=new SqliteLedgerBacking(db,scope.characterId),aliases=new Map<string,string>();
  const reserved=new Set([...draft.records.keys()]);
  for(const [alias,record] of draft.records)if(record.fragment&&/^f\d+$/.test(alias)){
    let id:string;do{id=`fragment:${scope.characterId}:${scope.sessionId}:${scope.turnId}:${randomUUID()}`;}while(backing.records.has(id)||reserved.has(id));
    aliases.set(alias,id);reserved.add(id);
  }
  const resolve=(id:string)=>aliases.get(id)??id;
  const ids:string[]=[];
  for(const [oldId,record] of draft.records){
    const id=resolve(oldId);ids.push(id);
    backing.records.set(id,{...record,id,sources:record.sources.map(ref=>({...ref,id:resolve(ref.id)})),message:record.message?{...record.message,id}:null});
  }
  for(const change of plan.changes)backing.operations.add(change.operationId);
  if(draft.records.size){backing.revision++;backing.epoch++;}
  // A virtual management request is scrubbed before normal retention runs in its outer transaction.
  const pruned=options.prune===false?[]:store.pruneForLifecycle();
  store.dynamics.sync(scope);
  store.dynamics.merged(scope,plan.changes);
  return {results:draft.results.map(result=>({...result,affectedIds:result.affectedIds.map(resolve)})),affectedIds:[...new Set([...ids,...pruned.filter(item=>item.characterId===scope.characterId).map(item=>item.id)])]};
}
