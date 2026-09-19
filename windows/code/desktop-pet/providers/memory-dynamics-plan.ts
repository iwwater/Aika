import type { MemoryChange } from '../contracts/index.js';
import type { MemoryDynamicsPlan, MemoryDynamicsTraits } from '../contracts/memory-dynamics.js';
import type { MemoryTurnInput } from '../contracts/memory-lifecycle.js';
import { MemoryWire } from './memory-wire.js';
import { exactFields, nonempty } from './memory-json.js';
import { object } from './transport.js';

export const MEMORY_DYNAMICS_PROMPT = `
上述六个顶层字段仍全部必填；唯一允许的额外字段是可选dynamics={traits:[],reinforcements:[]}，不确定就省略，不改变原严格修改规则。
traits项为{recordId,expectedVersion,traits:{category,importance,evidenceSources,emotion}}。
category为event/stable_profile/unassessed；稳定资料仅姓名、持续偏好等有依据事实，不能凭瞬时情绪推断人格。
importance仅0普通/0.5有明确重要依据/1用户明确要求记住。evidenceSources为实际有效来源{id,version}，必须支撑该记忆。
emotion={status,intensity,sources,observation}：无可靠强度来源用missing/null/[]/null；有明确原文程度自述时可提议observed和0~1强度，observation须逐字引用来源。七类分类、占位标签不代表强度。不能编造感知说明。
recordId引用现有memory别名且expectedVersion照输入；新增/合并记录引用本批新别名、expectedVersion=0。实际ID及提交后版本由程序分配。
reinforcements项为{recordId,expectedVersion,source:{id,version},kind:reiteration或confirmation}，只提议用户本轮主动重提/确认的现有记忆；source必须本轮user原文。纠正/遗忘、助手复述或仅被检索不强化。不在此字段猜测新的记忆或修改事实。`;

export function parseMemoryDynamicsPlan(value:unknown,input:MemoryTurnInput,wire:MemoryWire,
  rawChanges:unknown,assigned:readonly MemoryChange[],request:string):MemoryDynamicsPlan {
  const data=object(value);exactFields(data,['traits','reinforcements']);
  if(!Array.isArray(data.traits)||!Array.isArray(data.reinforcements)||data.traits.length>100||data.reinforcements.length>100)throw Error('Invalid dynamics proposal arrays');
  const fresh=new Map<string,string>();
  if(!Array.isArray(rawChanges))throw Error('Invalid structural change array');
  rawChanges.forEach((raw,i)=>{
    const op=object(object(raw).operation),actual=assigned[i]!.operation;
    if(op.type==='add'&&actual.type==='add')fresh.set(nonempty(op.id),actual.id);
    if(op.type==='merge'&&actual.type==='merge')fresh.set(nonempty(object(op.replacement).id),actual.replacement.id);
  });
  const target=(v:Record<string,unknown>,allowFresh:boolean)=>{
    const id=nonempty(v.recordId);
    if(fresh.has(id)){if(!allowFresh||v.expectedVersion!==0)throw Error('Invalid new dynamics target');return {recordId:fresh.get(id)!,expectedVersion:1};}
    const source=wire.source(id,'memory');if(v.expectedVersion!==source.version)throw Error('Stale dynamics target');
    const mutation=assigned.find(c=>c.operation.type!=='add'&&(c.operation.type==='merge'?c.operation.targets.some(t=>t.id===source.id):c.operation.id===source.id));
    if(mutation&&mutation.operation.type!=='update')throw Error('Dynamics targets a removed or restored record');
    return {recordId:source.id,expectedVersion:source.version+(mutation?1:0)};
  };
  const seen=new Set<string>();
  const traits=data.traits.map(raw=>{
    const item=object(raw);exactFields(item,['recordId','expectedVersion','traits']);const resolved=target(item,true);
    if(seen.has(resolved.recordId))throw Error('Repeated dynamics traits');seen.add(resolved.recordId);
    const t=object(item.traits);exactFields(t,['category','importance','evidenceSources','emotion']);
    if(!['event','stable_profile','unassessed'].includes(String(t.category))||![0,.5,1].includes(Number(t.importance))||typeof t.importance!=='number')throw Error('Invalid memory traits');
    const e=object(t.emotion);exactFields(e,['status','intensity','sources','observation']);
    if(!['missing','invalid','observed'].includes(String(e.status)))throw Error('Invalid emotion evidence status');
    const sources=wire.versions(e.sources),evidenceSources=wire.versions(t.evidenceSources);
    if(e.status==='observed'){
      if(typeof e.intensity!=='number'||!Number.isFinite(e.intensity)||e.intensity<0||e.intensity>1||!sources.length)throw Error('Invalid emotion intensity');
      const excerpt=nonempty(e.observation);
      if(!sources.some(ref=>input.sources.some(s=>s.id===ref.id&&s.version===ref.version&&s.messageRole==='user'&&s.text.includes(excerpt))))throw Error('Emotion intensity lacks user evidence');
    }else if(e.intensity!==null||e.observation!==null||sources.length)throw Error('Unobserved emotion cannot claim evidence');
    const accepted={category:t.category,importance:t.importance,evidenceSources,emotion:{status:e.status,intensity:e.intensity,sources,observation:e.observation}} as MemoryDynamicsTraits;
    return {...resolved,traits:accepted};
  });
  if(request!=='none'&&data.reinforcements.length)throw Error('Correction or forget cannot strengthen memories');
  const reinforcements=data.reinforcements.map(raw=>{
    const item=object(raw);exactFields(item,['recordId','expectedVersion','source','kind']);const resolved=target(item,false),source=wire.reference(item.source);
    if(item.kind!=='reiteration'&&item.kind!=='confirmation')throw Error('Invalid reinforcement kind');
    const stored=input.sources.find(s=>s.id===source.id&&s.version===source.version);
    if(source.id!==input.currentMessageId||stored?.messageRole!=='user'||stored.evidenceEligible===false)throw Error('Reinforcement lacks current user source');
    return {...resolved,source,kind:item.kind as 'reiteration'|'confirmation'};
  });
  return {traits,reinforcements};
}
