import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, scope, message, change, NOW } from './sqlite-fixture.js';
import { lifecycle, none, signal, deferred } from './lifecycle-fixture.js';
import type { MemoryTurnPlan } from '../../contracts/memory-lifecycle.js';
const setup=()=>fixture(undefined,'memory-dynamics-01');
const traits=(source='raw')=>({category:'stable_profile' as const,importance:0.5 as const,evidenceSources:[{id:source,version:1}],emotion:{status:'missing' as const,intensity:null,sources:[],observation:null}});

test('strict structural and trait plan commits atomically; unsupported evidence rolls back both',async()=>{
 const f=setup();try{
  const store=f.open();store.append(scope(),[message('raw','我叫小明')]);
  const bad=lifecycle(store,async input=>({...none(input),changes:[change({type:'add',id:'name',text:'我叫小明',sourceIds:['raw']},'add',input.scope)],dynamics:{traits:[{recordId:'name',expectedVersion:1,traits:{...traits(),emotion:{status:'observed',intensity:0.7,sources:[{id:'raw',version:1}],observation:'中性'}}}],reinforcements:[]}}));
  const before=store.revision(scope());const result=await bad.prepareTurn(scope(),'raw','我叫小明',signal());
  assert.equal(result.status,'rejected');assert.equal(result.rejectionCode,'unverified_emotion_intensity');assert.equal(store.inspect(scope(),'name'),null);assert.equal(store.revision(scope()),before);assert.equal(store.lifecycle.outcome(scope(),'raw','我叫小明'),null);
  const good=lifecycle(store,async input=>({...none(input),changes:[change({type:'add',id:'name',text:'我叫小明',sourceIds:['raw']},'add',input.scope)],dynamics:{traits:[{recordId:'name',expectedVersion:1,traits:traits()}],reinforcements:[]}}));
  assert.equal((await good.prepareTurn(scope(),'raw','我叫小明',signal())).status,'applied');
  f.setTime('2026-12-06T12:00:00Z');assert.equal(store.dynamics.state(scope(),'name')!.activation,1);
 }finally{f.cleanup();}
});
test('pure reinforcement uses captured user scope, is idempotent and rejects correction/foreign-source proposals',async()=>{
 const f=setup();try{
  const store=f.open();store.append(scope(),[message('raw','红茶')]);store.apply(change({type:'add',id:'tea',text:'红茶',sourceIds:['raw']},'add'));
  f.setTime('2026-09-07T12:00:00Z');const owned=scope('companion','repeat');store.append(owned,[message('repeat','红茶','companion','2026-09-07T12:00:00Z')]);
  const port=lifecycle(store,async input=>({...none(input),dynamics:{traits:[],reinforcements:[{recordId:'tea',expectedVersion:1,source:{id:input.currentMessageId,version:1},kind:'reiteration'}]}}));
  const before=store.dynamics.state(scope(),'tea')!.activation;
  const result=await port.prepareTurn(owned,'repeat','红茶',signal());assert.equal(result.status,'applied');
  const after=store.dynamics.state(scope(),'tea')!;assert.equal(after.activation,before+0.2*(1-before));
  assert.deepEqual(await port.prepareTurn(owned,'repeat','红茶',signal()),result);assert.equal(store.dynamics.state(scope(),'tea')!.activation,after.activation);
  for(const request of ['correction','forget'] as const){
    const own=scope('companion',request);store.append(own,[message(request,'红茶')]);
    const bad=lifecycle(store,async input=>({...none(input),request,dynamics:{traits:[],reinforcements:[{recordId:'tea',expectedVersion:1,source:{id:request,version:1},kind:'confirmation'}]}}));
    assert.equal((await bad.prepareTurn(own,request,'红茶',signal())).rejectionCode,'correction_forget_cannot_reinforce');
  }
 }finally{f.cleanup();}
});
test('late trait plan cannot resurrect a forgotten memory or accept another message as current evidence',async()=>{
 const f=setup();try{
  const store=f.open();store.append(scope(),[message('raw','我叫小明')]);store.apply(change({type:'add',id:'name',text:'我叫小明',sourceIds:['raw']},'name'));
  const owned=scope('companion','q');store.append(owned,[message('q','小明')]);const pending=deferred<MemoryTurnPlan>();let captured!:Parameters<typeof none>[0];
  const port=lifecycle(store,async input=>{captured=input;return pending.promise;});const task=port.prepareTurn(owned,'q','小明',signal());
  await new Promise(resolve=>setImmediate(resolve));
  store.apply(change({type:'soft_delete',id:'name',expectedVersion:1},'forget'));
  pending.resolve({...none(captured),dynamics:{traits:[{recordId:'name',expectedVersion:1,traits:traits()}],reinforcements:[]}});
  assert.equal((await task).rejectionCode,'stale_lifecycle_epoch');assert.equal(store.inspect(scope(),'name')!.state,'deleted');assert.equal(store.dynamics.state(scope(),'name')!.activation,0);
 }finally{f.cleanup();}
});
test('delayed messages from different source days cannot get two reinforcements on one commit day',async()=>{
 const f=setup();try{
  const store=f.open();store.append(scope(),[message('raw','红茶')]);store.apply(change({type:'add',id:'tea',text:'红茶',sourceIds:['raw']},'add'));
  f.setTime('2026-09-09T12:00:00Z');
  for(const [index,createdAt] of [NOW,'2026-09-07T12:00:00Z'].entries()) {
    const owned=scope('companion','q'+index),id='q'+index;store.append(owned,[message(id,'红茶','companion',createdAt)]);
    const port=lifecycle(store);await port.prepareTurn(owned,id,'红茶',signal());
    const result=store.dynamics.reinforce(owned,{recordId:'tea',expectedVersion:1,source:{id,version:1},kind:'confirmation',operationId:id});
    assert.equal(result.reinforced,index===0);assert.equal(result.day,'2026-09-09');
  }
 }finally{f.cleanup();}
});
