import type { MemoryDynamicsManagementPort, MemoryRecordAction, MemoryRecordActionResult } from '../contracts/memory-dynamics.js';
import type { TurnScope } from '../contracts/index.js';
import { ManagementError } from '../contracts/management.js';
import type { SqliteMemoryStore } from './sqlite-store.js';
import { bindScope, MemoryRuleError } from './scope.js';

export class SqliteDynamicsManagementPort implements MemoryDynamicsManagementPort {
  constructor(private readonly store:SqliteMemoryStore) {}
  private read<T>(action:()=>T):T {
    try{return action();}catch(error){
      if(error instanceof ManagementError)throw error;
      if(error instanceof MemoryRuleError) {
        if(['version_conflict','operation_id_payload_mismatch'].includes(error.message))throw new ManagementError('version_conflict','数据或策略已变化，请刷新后重试。');
        if(error.message==='forget_requires_source_plan')throw new ManagementError('invalid_request','这条记忆的来源还包含其他内容，需要严格来源处理与片段保留计划；尚未执行遗忘。');
        if(error.message==='restore_sources_unavailable')throw new ManagementError('invalid_request','来源已失效，无法只恢复这条记忆；未恢复原文或历史召回。');
        throw new ManagementError('invalid_request',`记忆操作未执行（${error.message}）。`);
      }
      throw new ManagementError('unavailable','记忆存储暂不可用。');
    }
  }
  snapshot=(query:Parameters<MemoryDynamicsManagementPort['snapshot']>[0])=>this.read(()=>this.store.recall.snapshot(query));
  traces=(query:Parameters<MemoryDynamicsManagementPort['traces']>[0])=>this.read(()=>this.store.recall.traces(query));
  preview=(input:Parameters<MemoryDynamicsManagementPort['preview']>[0])=>this.read(()=>this.store.recall.preview(input));
  savePolicy=(input:Parameters<MemoryDynamicsManagementPort['savePolicy']>[0])=>this.read(()=>this.store.dynamics.savePolicy(input));
  rollbackPolicy=(input:Parameters<MemoryDynamicsManagementPort['rollbackPolicy']>[0])=>this.read(()=>this.store.dynamics.rollbackPolicy(input));
  forget(input:MemoryRecordAction):MemoryRecordActionResult {return this.read(()=>this.action(input,false));}
  restore(input:MemoryRecordAction):MemoryRecordActionResult {return this.read(()=>this.action(input,true));}
  private action(input:MemoryRecordAction,restore:boolean):MemoryRecordActionResult {
    const scope:TurnScope=bindScope({characterId:input.characterId,sessionId:'management-dynamics',turnId:input.operationId,generation:0},input.characterId);
    if(!input.id?.trim()||!input.operationId?.trim()||!input.reason?.trim()||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1)throw new MemoryRuleError('invalid_management_request');
    return this.store.dynamicsAction(scope,input,restore);
  }
}
