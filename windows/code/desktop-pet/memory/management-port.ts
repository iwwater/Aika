import { SqliteDynamicsManagementPort } from './dynamics-management.js';
import { randomUUID } from 'node:crypto';
import { PRODUCT_CHARACTERS, isProductCharacter, type CharacterId, type TurnScope } from '../contracts/index.js';
import type { MemoryTurnPort } from '../contracts/memory-lifecycle.js';
import { ManagementError, type ManagedContext, type ManagedRecord, type ManagementMemoryPort, type RecordEdit, type RecordEditResult, type RecordPage, type RecordQuery } from '../contracts/management.js';
import type { MemoryRecord } from './ledger.js';
import { MemoryRuleError, sameScope } from './scope.js';
import type { SqliteMemoryStore } from './sqlite-store.js';

const kinds = ['memory','transcript','summary','keyword_index','vector_index','context_cache'] as const;
const roles = PRODUCT_CHARACTERS;
function ownedScope(characterId:CharacterId,turnId='read'):TurnScope {
  if(!isProductCharacter(characterId))throw new ManagementError('invalid_request','请选择有效角色。');
  return Object.freeze({characterId,sessionId:'management',turnId,generation:0});
}
function string(value:unknown,nonempty=false):asserts value is string {
  if(typeof value!=='string'||(nonempty&&!value.trim()))throw new ManagementError('invalid_request','文本、标识或操作原因无效。');
}
function integer(value:unknown,min:number,max=Number.MAX_SAFE_INTEGER):asserts value is number {
  if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw new ManagementError('invalid_request','版本或分页参数无效。');
}
function object(value:unknown):void {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ManagementError('invalid_request','请求格式无效。');
}
function managed(record:MemoryRecord):ManagedRecord {
  if(record.kind==='emotion')throw new ManagementError('invalid_request','该记录不属于记忆管理范围。');
  return {characterId:record.characterId,id:record.id,kind:record.kind,version:record.version,state:record.state,text:record.text,
    createdAt:record.createdAt,role:record.message?.role??null,sources:record.sources.map(ref=>({...ref})),
    editable:record.state==='active'&&['memory','transcript','summary'].includes(record.kind),
    origin:record.origin??(record.kind==='transcript'?'conversation':'automatic')};
}
function translate(error:unknown):never {
  if(error instanceof ManagementError)throw error;
  if(error instanceof MemoryRuleError){
    if(['version_conflict','operation_id_payload_mismatch','management_operation_superseded','stale_context','unissued_or_modified_context'].includes(error.message))throw new ManagementError('version_conflict','数据已变更，请刷新后重试。');
    if(error.message==='management_record_not_found')throw new ManagementError('not_found','当前角色中没有这条记录。');
    if(error.message==='management_record_not_editable')throw new ManagementError('invalid_request','仅可修改有效的记忆、摘要或对话；派生索引请修改其来源。');
    if(error.message==='edited_record_exceeds_retention')throw new ManagementError('invalid_request','修改后的原文超出当前保留范围，未保存。');
    if(error.message==='invalid_management_request')throw new ManagementError('invalid_request','编辑参数无效。');
  }
  // Native errors may contain local paths or SQL; the HTTP boundary receives no such details.
  throw new ManagementError('unavailable','记忆存储暂不可用。');
}

/** The runtime injects its existing store and lifecycle instance, including effective retrieval budgets. */
export class SqliteManagementMemoryPort implements ManagementMemoryPort {
  readonly dynamics:SqliteDynamicsManagementPort;
  constructor(private readonly store:SqliteMemoryStore,private readonly lifecycle:Pick<MemoryTurnPort,'context'|'assertContextCurrent'> & {readonly store:SqliteMemoryStore}) {
    this.dynamics=new SqliteDynamicsManagementPort(store);
    if(lifecycle.store!==store)throw new ManagementError('unavailable','管理入口必须连接当前业务存储。');
  }
  private read<T>(action:()=>T):T { try{return action();}catch(error){return translate(error);} }
  characters():ReturnType<ManagementMemoryPort['characters']> {
    return this.read(()=>roles.map(role=>({...role,revision:this.store.revision(ownedScope(role.id))})));
  }
  list(query:RecordQuery):RecordPage {
    return this.read(()=>{
      object(query);const scope=ownedScope(query.characterId);string(query.query);integer(query.offset,0);integer(query.limit,1,200);
      if(!kinds.includes(query.kind)||!['active','all'].includes(query.state))throw new ManagementError('invalid_request','记录类别或状态无效。');
      const input={kind:query.kind,query:query.query,offset:query.offset,limit:query.limit,state:query.state};
      const page=this.store.queryRecords(scope,input);
      return {characterId:scope.characterId,...page,records:page.records.map(managed),offset:input.offset,limit:input.limit};
    });
  }
  edit(input:RecordEdit):RecordEditResult {
    return this.read(()=>{
      object(input);const scope=ownedScope(input.characterId);string(input.id,true);string(input.operationId,true);string(input.text,true);string(input.reason,true);integer(input.expectedVersion,1);
      const captured={id:input.id,operationId:input.operationId,expectedVersion:input.expectedVersion,text:input.text,reason:input.reason};
      const result=this.store.editRecord(scope,captured);
      return {status:'applied',characterId:scope.characterId,operationId:captured.operationId,...result,record:managed(result.record)};
    });
  }
  prompt(characterId:CharacterId):ReturnType<ManagementMemoryPort['prompt']> {
    return this.read(()=>{const scope=ownedScope(characterId);const snapshot=this.store.promptSnapshot(scope);return {characterId:scope.characterId,...snapshot};});
  }
  savePrompt(input:Parameters<ManagementMemoryPort['savePrompt']>[0]):ReturnType<ManagementMemoryPort['savePrompt']> {
    return this.read(()=>{
      object(input);const scope=ownedScope(input.characterId);string(input.text,true);string(input.operationId,true);integer(input.expectedRevision,0);
      const result=this.store.editPrompt(scope,{text:input.text,operationId:input.operationId,expectedRevision:input.expectedRevision});
      return {characterId:scope.characterId,...result};
    });
  }
  async context(characterId:CharacterId,query:string):Promise<ManagedContext> {
    try {
      const scope=ownedScope(characterId,randomUUID());string(query);
      const revision=this.store.revision(scope);
      const context=await this.lifecycle.context(scope,query,null,new AbortController().signal);
      if(!sameScope(context.scope,scope))throw new ManagementError('unavailable','上下文角色或轮次不匹配。');
      this.lifecycle.assertContextCurrent(context);
      const refs=this.store.lifecycle.contextSources(context);
      const selected=new Map(refs.map(ref=>{
        const record=this.store.inspect(scope,ref.id);
        if(!record||record.state!=='active'||record.version!==ref.version)throw new ManagementError('version_conflict','上下文已变化，请刷新。');
        return [ref.id,managed(record)];
      }));
      const summaries=[...selected.values()].filter(record=>record.kind==='summary');
      const recent=context.recent.map(record=>selected.get(record.id)!);
      const memories=context.memories.map(record=>selected.get(record.id)!);
      this.store.assertContextCurrent(scope,revision);
      return {characterId:scope.characterId,revision,query,prompt:context.characterPrompt,recent,summaries,memories,
        note:'按当前生效的检索与上下文预算组装；人工修改保留来源标记，未调用对话或记忆维护模型。'};
    }catch(error){return translate(error);}
  }
}
