import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type {MemoryTurnInput,MemoryTurnPlan} from '../../contracts/memory-lifecycle.js';
import type {MemoryRecordAction} from '../../contracts/memory-dynamics.js';
import {DEFAULT_MEMORY_DYNAMICS_POLICY} from '../../contracts/memory-dynamics.js';
import {fixture,scope,message,change,NOW} from './sqlite-fixture.js';
import {lifecycle,signal,none} from './lifecycle-fixture.js';
const budget={inputTokenBudget:100000,countTokens:(input:MemoryTurnInput)=>JSON.stringify(input).length};
const action:MemoryRecordAction={characterId:'companion',id:'tea',expectedVersion:1,operationId:'web-forget',reason:'不想再记住红茶'};
function dump(filename:string):string {
 const db=new Database(filename,{readonly:true});try{return JSON.stringify((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'memory_search%' ORDER BY name").all() as {name:string}[]).map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));}finally{db.close();}
}
async function setup() {
 const f=fixture(undefined,'memory-dynamics-01'),store=f.open(),port=lifecycle(store);
 const raw='我喜欢红茶；我养的猫叫团子';await port.append(scope(),[message('raw',raw)]);
 store.apply(change({type:'add',id:'tea',text:'喜欢红茶',sourceIds:['raw']},'tea'));
 store.apply(change({type:'add',id:'cat',text:'猫叫团子',sourceIds:['raw']},'cat'));
 store.recordDerived(scope(),{id:'summary',kind:'summary',text:raw,sourceIds:['raw'],createdAt:NOW});
 store.recordDerived(scope(),{id:'index',kind:'keyword_index',text:'红茶',sourceIds:['tea'],createdAt:NOW});
 store.recordPerception(scope(),{scope:scope(),transcript:raw,status:'partial',modalities:[],cues:[]},['raw']);
 await port.foregroundContext(scope(),'raw',raw,null,signal());
 return {f,store};
}
function plan(input:MemoryTurnInput):MemoryTurnPlan {
 const fragment=(id:string,fragmentId:string,supportSourceIds:string[]=[])=>{
  const source=input.sources.find(item=>item.id===id)!,text='我养的猫叫团子',start=[...source.text.slice(0,source.text.indexOf(text))].length;
  return {source:{id,version:source.version},fragmentId,start,end:start+[...text].length,supportSourceIds};
 };
 return {scope:input.scope,request:'forget',reason:'保留猫，遗忘红茶',clarification:null,
 changes:[change({type:'soft_delete',id:'tea',expectedVersion:1},'web-delete-tea',input.scope),change({type:'update',id:'cat',expectedVersion:1,text:'猫叫团子',sourceIds:['f0']},'web-preserve-cat',input.scope)],
 suppressSources:['raw','summary',input.currentMessageId].map(id=>({id,version:1})),retainSources:[fragment('raw','f0'),fragment('summary','f1',['f0'])]};
}

test('management preparation is zero-write; mixed-source commit preserves unrelated fragments and clears virtual request',async()=>{
 const {f,store}=await setup();try{
  const before=dump(f.filename),ticket=store.lifecycle.readManagementForget(action,budget);
  assert.equal(dump(f.filename),before);assert.equal(store.inspect(ticket.input.scope,ticket.input.currentMessageId),null);
  const current=ticket.input.sources.find(source=>source.id===ticket.input.currentMessageId)!;
  assert.equal(current.origin,'manual');assert.match(current.text,/不是发生过的聊天/);
  const old=store.lifecycle.readTurn(scope(),'raw','我喜欢红茶；我养的猫叫团子',{...budget,maxMemories:32,maxRecentMessages:32,summaryLimit:8});
  const result=store.lifecycle.commitManagementForget(ticket,plan(ticket.input));
  assert.equal(result.status,'applied');assert.equal(store.inspect(scope(),'tea')!.state,'deleted');assert.equal(store.inspect(scope(),'cat')!.state,'active');assert.equal(store.inspect(scope(),'cat')!.version,2);
  assert.equal(store.search(scope(),'红茶',32,'lexical').length,0);assert.equal(store.search(scope(),'团子',32,'lexical').length,1);
  assert.ok(store.visible(scope(),'transcript').every(record=>!record.text.includes('红茶')&&!record.text.includes('网页')));
  assert.ok(store.visible(scope(),'summary').every(record=>!record.text.includes('红茶')));
  assert.equal(store.inspect(scope(),'index')!.state,'invalidated');assert.equal(store.visible(scope(),'emotion').length,0);
  assert.equal(store.recall.traces({characterId:'companion',offset:0,limit:20}).records[0]!.status,'invalidated');
  const request=store.inspect(scope(),ticket.input.currentMessageId)!;assert.equal(request.text,'');assert.equal(request.message,null);assert.equal(request.evidenceEligible,false);assert.equal(request.state,'purged');
  assert.equal(store.lifecycle.commitTurn(old,none(old.input)).rejectionCode,'stale_lifecycle_epoch');
 }finally{f.cleanup();}
});
test('failed strict partition rolls back request, fragments, target and receipt together',async()=>{
 const {f,store}=await setup();try{
  const ticket=store.lifecycle.readManagementForget(action,budget),before=dump(f.filename),proposal=plan(ticket.input);
  assert.throws(()=>store.lifecycle.commitManagementForget(ticket,{...proposal,changes:proposal.changes.slice(0,1)}),/unresolved_memory_suppression/);
  assert.equal(dump(f.filename),before);assert.equal(store.lifecycle.managementForgetOutcome(action),null);
  assert.equal(store.inspect(scope(),ticket.input.currentMessageId),null);
  assert.throws(()=>store.lifecycle.commitManagementForget(ticket,proposal),/unknown_or_modified/);
 }finally{f.cleanup();}
});
test('target/version or data competition rejects without adding the virtual request',async()=>{
 const {f,store}=await setup();try{
  const ticket=store.lifecycle.readManagementForget(action,budget);
  store.append(scope(),[message('new','无关的新消息')]);const before=dump(f.filename);
  assert.throws(()=>store.lifecycle.commitManagementForget(ticket,plan(ticket.input)),/stale_management_forget/);assert.equal(dump(f.filename),before);
  assert.throws(()=>store.lifecycle.readManagementForget({...action,expectedVersion:2},budget),/version_conflict/);
 }finally{f.cleanup();}
});
test('receipt survives restart, accepts concurrent prepared retries and rejects changed payload',async()=>{
 const {f,store}=await setup();try{
  const first=store.lifecycle.readManagementForget(action,budget),second=store.lifecycle.readManagementForget(action,budget);
  const result=store.lifecycle.commitManagementForget(first,plan(first.input)),after=dump(f.filename);
  assert.deepEqual(store.lifecycle.commitManagementForget(second,plan(second.input)),result);assert.equal(dump(f.filename),after);
  store.close();const reopened=f.open();assert.deepEqual(reopened.lifecycle.managementForgetOutcome({...action}),result);
  assert.throws(()=>reopened.lifecycle.managementForgetOutcome({...action,reason:'不同参数'}),/payload_mismatch/);
 }finally{f.cleanup();}
});
test('direct complete deletion and prepared path share exactly one receipt namespace',async()=>{
 const f=fixture(undefined,'memory-dynamics-01');try{
  const store=f.open();store.append(scope(),[message('raw','喜欢红茶')]);store.apply(change({type:'add',id:'tea',text:'喜欢红茶',sourceIds:['raw']},'add'));
  const result=store.dynamicsAction(scope(),action,false);assert.deepEqual(store.lifecycle.managementForgetOutcome(action),result);
 }finally{f.cleanup();}
});
test('foreign, modified, discarded, oversized and retained-request tickets never mutate storage',async()=>{
 const {f,store}=await setup();try{
  const before=dump(f.filename);
  assert.throws(()=>store.lifecycle.readManagementForget({...action,characterId:'friend'},budget),/unknown_character/);
  assert.throws(()=>store.lifecycle.readManagementForget(action,{...budget,inputTokenBudget:1}),/closure_exceeds_budget/);
  const ticket=store.lifecycle.readManagementForget(action,budget);assert.throws(()=>store.lifecycle.commitManagementForget(structuredClone(ticket),plan(ticket.input)),/unknown_or_modified/);
  store.lifecycle.discardManagementForget(ticket);assert.throws(()=>store.lifecycle.commitManagementForget(ticket,plan(ticket.input)),/unknown_or_modified/);
  const retained=store.lifecycle.readManagementForget(action,budget),proposal=plan(retained.input);
  assert.throws(()=>store.lifecycle.commitManagementForget(retained,{...proposal,retainSources:[...proposal.retainSources!,{source:{id:retained.input.currentMessageId,version:1},fragmentId:'f9',start:0,end:2,supportSourceIds:[]}]}),/cannot_be_retained/);
  assert.equal(dump(f.filename),before);
 }finally{f.cleanup();}
});
test('management closure includes more than six related memories without reading an unrelated component',()=>{
 const f=fixture(undefined,'memory-dynamics-01');try{
  const store=f.open();store.append(scope(),[message('raw','共同来源'),message('other','独立内容')]);
  for(let i=0;i<10;i++)store.apply(change({type:'add',id:i?'m'+i:'tea',text:'相关 '+i,sourceIds:['raw']},'add'+i));
  store.apply(change({type:'add',id:'unrelated',text:'独立事实',sourceIds:['other']},'other'));
  const ticket=store.lifecycle.readManagementForget(action,budget);assert.equal(ticket.input.relevantMemories.length,10);assert.ok(!ticket.input.sources.some(source=>source.id==='other'||source.id==='unrelated'));
  store.lifecycle.discardManagementForget(ticket);
 }finally{f.cleanup();}
});
test('preview now resolves to one ISO timestamp and exact ID queries locate off-page sources',()=>{
 const f=fixture(undefined,'memory-dynamics-01');try{
  const store=f.open();for(let i=0;i<5;i++){store.append(scope(),[message('raw-'+i,'茶 '+i)]);store.apply(change({type:'add',id:'memory-'+i,text:'茶 '+i,sourceIds:['raw-'+i]},'add'+i));}
  const query={characterId:'companion' as const,query:'',state:'all' as const,offset:0,limit:1};
  assert.notEqual(store.recall.snapshot(query).items[0]!.record.id,'raw-0');
  store.append(scope(),[message('id-mentioned-in-text','正文引用 raw-0，但不是该来源')]);
  const found=store.recall.snapshot({...query,query:'raw-0'});assert.equal(found.items[0]!.record.id,'raw-0');
  assert.ok(store.recall.snapshot({...query,query:'茶',limit:200}).items.length>=5);
  const before=dump(f.filename),result=store.recall.preview({characterId:'companion',query:'茶',evaluatedAt:'now',expectedDataRevision:store.revision(scope()),expectedPolicyRevision:1,policy:DEFAULT_MEMORY_DYNAMICS_POLICY});
  assert.equal(result.evaluatedAt,NOW);assert.equal(result.effectiveFrom,NOW);assert.equal(dump(f.filename),before);
 }finally{f.cleanup();}
});

test('virtual request text never consumes transcript quota or evicts independent raw history',()=>{
 const raw='我喜欢红茶；我养的猫叫团子',independent='独立原文',kept='我养的猫叫团子';
 const quota=Buffer.byteLength(raw+independent+kept)+4,f=fixture(quota,'memory-dynamics-01');try{
  const store=f.open();store.append(scope(),[message('raw',raw),message('independent',independent)]);
  store.apply(change({type:'add',id:'tea',text:'喜欢红茶',sourceIds:['raw']},'tea'));store.apply(change({type:'add',id:'cat',text:'猫叫团子',sourceIds:['raw']},'cat'));
  store.recordDerived(scope(),{id:'summary',kind:'summary',text:raw,sourceIds:['raw'],createdAt:NOW});
  const ticket=store.lifecycle.readManagementForget(action,budget);
  assert.ok(Buffer.byteLength(ticket.input.sources.at(-1)!.text)>quota);
  store.lifecycle.commitManagementForget(ticket,plan(ticket.input));
  assert.equal(store.inspect(scope(),'independent')!.state,'active');assert.equal(store.inspect(scope(),'independent')!.text,independent);assert.ok(store.transcriptBytes()<=quota);
 }finally{f.cleanup();}
});
