import type { MemoryTurnPlan } from '../contracts/memory-lifecycle.js';
import { exactFields } from '../providers/memory-json.js';
import { object } from '../providers/transport.js';
import { parseMemoryDynamicsPlan } from '../providers/memory-dynamics-plan.js';
import type { MemorySemanticFormat } from './memory-semantic-format.js';

export const SEMANTIC_DYNAMICS_SYSTEM=`
Runtime additive dynamics extension: all six semantic root fields above remain required. The sole optional extra root field is dynamics:{traits:[],reinforcements:[]}. Omit it when evidence is insufficient. Never change the strict fact/partition rules to produce dynamics.
Each traits item is {target,traits:{category,importance,evidenceSources,emotion}}. target is {factIndex:N} for the zero-based facts array entry resulting in a memory, or an existing READ memory reference {id,version}. No targets for retire. category is event/stable_profile/unassessed; stable_profile requires an evidenced stable fact such as a name or lasting preference, never personality guessed from mood. importance is exactly 0 ordinary,0.5 explicitly significant,1 user explicitly asks to remember. evidenceSources is an array of READ R supporting the memory. Do not use old sources being erased or replaced; when a fact depends on newly retained fragments, omit its traits for this turn instead of citing invalid old sources.
emotion is {status,intensity,sources,observation}. Reliable explicit user intensity wording may support observed, a value 0..1, READ sources R and a verbatim observation excerpt. A seven-class emotion prediction or a bare label is not measured intensity. Missing or invalid evidence uses status missing or invalid, intensity:null,sources:[],observation:null. Never invent observations; valid observed neutral intensity0 is distinct from missing. emotion.sources must quote a READ user source.
Each reinforcements item is {target:R,source:R,kind}, target an existing memory, source the actual current user message, kind reiteration or confirmation. Only the user's active repetition or confirmation qualifies, never assistant repetition, retrieval, viewing, corrections or forgetting instructions. No reinforcement when request is correction/forget. Host enforces message identity and daily lineage idempotency. Unresolved declarations must have empty dynamics arrays.`;

export function attachSemanticDynamics(value:unknown,format:MemorySemanticFormat,plan:MemoryTurnPlan):MemoryTurnPlan {
 const data=object(value);exactFields(data,['traits','reinforcements']);
 if(!Array.isArray(data.traits)||!Array.isArray(data.reinforcements))throw Error('Invalid semantic dynamics arrays');
 const aliases=(format.wire.data() as {sources:{id:string;version:number}[]}).sources;
 const aliasFor=(id:string)=>{const a=aliases.find(a=>format.wire.source(a.id).id===id);if(!a)throw Error('Unseen dynamic target');return a;};
 const rawChanges=plan.changes.map((change,index)=>({operation:change.operation.type==='add'?{type:'add',id:`new-dynamic-${index}`}:change.operation.type==='merge'?{type:'merge',replacement:{id:`new-dynamic-${index}`}}:change.operation}));
 const traits=data.traits.map(raw=>{
  const item=object(raw);exactFields(item,['target','traits']);const target=object(item.target);
  if(Object.hasOwn(target,'factIndex')){
   exactFields(target,['factIndex']);if(!Number.isSafeInteger(target.factIndex)||Number(target.factIndex)<0)throw Error('Invalid dynamics fact index');
   const index=Number(target.factIndex),op=plan.changes[index]?.operation;
   if(!op||op.type==='soft_delete'||op.type==='restore')throw Error('Dynamics requires a surviving fact');
   const ref=op.type==='update'?aliasFor(op.id):{id:`new-dynamic-${index}`,version:0};
   return {recordId:ref.id,expectedVersion:ref.version,traits:item.traits};
  }
  exactFields(target,['id','version']);return {recordId:target.id,expectedVersion:target.version,traits:item.traits};
 });
 const reinforcements=data.reinforcements.map(raw=>{const item=object(raw);exactFields(item,['target','source','kind']);const target=object(item.target);exactFields(target,['id','version']);return {recordId:target.id,expectedVersion:target.version,source:item.source,kind:item.kind};});
 const dynamics=parseMemoryDynamicsPlan({traits,reinforcements},format.input,format.wire,rawChanges,plan.changes,plan.request);
 if(plan.clarification&&(dynamics.traits.length||dynamics.reinforcements.length))throw Error('Unresolved dynamics cannot mutate memory');
 const suppressed=new Set(plan.suppressSources.map(x=>x.id));
 if(dynamics.traits.some(x=>[...x.traits.evidenceSources,...x.traits.emotion.sources].some(s=>suppressed.has(s.id))))throw Error('Dynamics cannot cite a suppressed source');
 return {...plan,dynamics};
}
