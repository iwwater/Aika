import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { QwenMemoryTurnProvider } from '../../providers/qwen-memory-lifecycle.js';
import { ProviderTransport } from '../../providers/transport.js';
import { buildMemoryTurnFormat } from '../../providers/memory-turn-format.js';

const scope={characterId:'companion' as const,sessionId:'synthetic',turnId:'t',generation:1};
const createdAt='2026-09-12T00:00:00Z';
const source={scope,id:'raw',version:1,kind:'transcript' as const,messageRole:'user' as const,text:'请记住，我养的猫叫橘子，我非常开心',createdAt};
const input:MemoryTurnInput={scope,currentMessageId:'raw',sources:[source],messages:[{characterId:'companion',id:'raw',role:'user',text:source.text,createdAt}],relevantMemories:[]};
const base=()=>({request:'none',changes:[],suppressSources:[],retainSources:[],clarification:null,reason:'controlled'});
const metadata=()=>({category:'event',importance:1,evidenceSources:[{id:'s0',version:1}],emotion:{status:'observed',intensity:.8,sources:[{id:'s0',version:1}],observation:'非常开心'}});
function provider(plan:unknown){return new QwenMemoryTurnProvider({endpoint:'https://controlled.invalid',model:'controlled',apiKey:()=> 'synthetic',authorizer:{async authorize(){return {async settle(){}};}}},new ProviderTransport(async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan)}}]})),'numeric-v1',true);}
const signal=()=>new AbortController().signal;
test('optional dynamic extraction maps new aliases to assigned identity and preserves older plans',async()=>{
 const plan={...base(),changes:[{reason:'explicit remember',operation:{type:'add',id:'new',text:'猫叫橘子',sourceIds:['s0']}}],dynamics:{traits:[{recordId:'new',expectedVersion:0,traits:metadata()}],reinforcements:[]}};
 const result=await provider(plan).plan(input,signal());
 assert.equal(result.changes[0]!.operation.type,'add');
 assert.equal(result.dynamics!.traits[0]!.recordId,(result.changes[0]!.operation as {id:string}).id);
 assert.equal(result.dynamics!.traits[0]!.expectedVersion,1);
 assert.equal(result.dynamics!.traits[0]!.traits.emotion.sources[0]!.id,'raw');
 assert.equal((await provider(base()).plan(input,signal())).dynamics,undefined);
 assert.match(buildMemoryTurnFormat(input,'numeric-v1',true).system,/七类分类、占位标签不代表强度/);
});
test('dynamic extraction refuses fabricated intensity evidence and stale new aliases',async()=>{
 for(const kind of ['wrong-quote','category-only','stale-new'] as const){
  const traits=metadata();if(kind==='wrong-quote')traits.emotion.observation='我非常难过';
  if(kind==='category-only'){traits.emotion.observation='neutral';}
  const plan={...base(),changes:[{reason:'remember',operation:{type:'add',id:'new',text:'猫叫橘子',sourceIds:['s0']}}],dynamics:{traits:[{recordId:'new',expectedVersion:kind==='stale-new'?1:0,traits}],reinforcements:[]}};
  await assert.rejects(provider(plan).plan(input,signal()));
 }
});
test('reinforcement resolves only the current user source and cannot target a deleted memory',async()=>{
 const memory={scope,id:'cat',version:3,kind:'memory' as const,messageRole:null,text:'猫叫橘子',createdAt,sourceVersions:[{id:'raw',version:1}]};
 const i:MemoryTurnInput={...input,sources:[source,memory],relevantMemories:[{characterId:'companion',id:'cat',version:3,text:memory.text,sourceIds:['raw']}]};
 const dynamics={traits:[],reinforcements:[{recordId:'s1',expectedVersion:3,source:{id:'s0',version:1},kind:'confirmation'}]};
 const plan={...base(),dynamics};
 const result=await provider(plan).plan(i,signal());assert.equal(result.dynamics!.reinforcements[0]!.recordId,'cat');
 await assert.rejects(provider({...plan,changes:[{reason:'forget',operation:{type:'soft_delete',id:'s1',expectedVersion:3}}]}).plan(i,signal()),/removed/);
 await assert.rejects(provider({...plan,dynamics:{...dynamics,reinforcements:[{...dynamics.reinforcements[0],source:{id:'s1',version:3}}]}}).plan(i,signal()),/current user/);
});
