import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULT_MEMORY_DYNAMICS_POLICY as defaults, type MemoryDynamicsTraits } from '../../contracts/memory-dynamics.js';
import { fixture, seed, scope, change, message, NOW } from './sqlite-fixture.js';
import { lifecycle, signal } from './lifecycle-fixture.js';
const setup=()=>fixture(undefined,'memory-dynamics-01');
const traits=(importance:0|0.5|1=0):MemoryDynamicsTraits=>({category:'event',importance,evidenceSources:[{id:'raw',version:1}],emotion:{status:'missing',intensity:null,sources:[],observation:null}});

test('same PET2 store adds component state, preserves rows and resumes after restart',()=>{
 const f=setup();try{
  let store=f.open();seed(store);const raw=store.inspect(scope(),'raw');
  assert.equal(store.dynamics.state(scope(),'job')!.activation,1);
  f.setTime('2026-10-06T12:00:00Z');assert.equal(store.dynamics.state(scope(),'job')!.activation,0.5);
  store.close();store=f.open();assert.equal(store.dynamics.state(scope(),'job')!.activation,0.5);
  assert.equal(store.inspect(scope(),'job')!.state,'active');
  const db=new Database(f.filename,{readonly:true});assert.equal(db.pragma('user_version',{simple:true}),4);assert.equal(db.pragma('application_id',{simple:true}),0x50455432);db.close();
  assert.equal(raw!.text,'我在海风公司工作');
 }finally{f.cleanup();}
});
test('policy switches and rollback continue forward and reject stale or changed replays',()=>{
 const f=setup();try{
  const store=f.open();seed(store);f.setTime('2026-10-06T12:00:00Z');
  const request={characterId:'companion' as const,expectedRevision:1,operationId:'p1',policy:{...defaults,baseHalfLifeDays:60}};
  const saved=store.dynamics.savePolicy(request);assert.equal(saved.revision,2);assert.deepEqual(store.dynamics.savePolicy(request),saved);
  assert.throws(()=>store.dynamics.savePolicy({...request,policy:defaults}),/payload_mismatch/);
  assert.throws(()=>store.dynamics.savePolicy({...request,operationId:'stale'}),/version_conflict/);
  f.setTime('2026-12-05T12:00:00Z');assert.equal(store.dynamics.state(scope(),'job')!.activation,0.25);
  assert.equal(store.dynamics.rollbackPolicy({characterId:'companion',expectedRevision:2,targetRevision:1,operationId:'rollback'}).revision,3);
  f.setTime('2027-01-04T12:00:00Z');assert.equal(store.dynamics.state(scope(),'job')!.activation,0.125);
  assert.equal(store.dynamics.history().length,3);
 }finally{f.cleanup();}
});
test('traits require actual support; corrections invalidate metadata without rewinding activity',()=>{
 const f=setup();try{
  const store=f.open();seed(store);store.append(scope(),[message('unrelated','名字叫明明')]);
  assert.throws(()=>store.dynamics.applyTraits(scope(),{recordId:'job',expectedVersion:1,operationId:'bad',traits:{...traits(1),evidenceSources:[{id:'unrelated',version:1}]}}),/invalid_traits_evidence/);
  store.dynamics.applyTraits(scope(),{recordId:'job',expectedVersion:1,operationId:'traits',traits:traits(1)});
  f.setTime('2026-12-05T12:00:00Z');assert.equal(store.dynamics.state(scope(),'job')!.activation,0.5);
  store.apply(change({type:'update',id:'job',expectedVersion:1,text:'换工作',sourceIds:['job']},'edit'));
  const state=store.dynamics.state(scope(),'job')!;assert.equal(state.traits.importance,0);assert.equal(state.activation,0.5);
 }finally{f.cleanup();}
});
test('missing emotion differs from measured neutral; placeholders cannot become observations',()=>{
 const f=setup();try{
  const store=f.open();seed(store);
  const initial=store.dynamics.state(scope(),'job')!;assert.equal(initial.emotion,0);assert.equal(initial.traits.emotion.status,'missing');assert.equal(initial.traits.emotion.intensity,null);
  store.append(scope(),[message('e','我非常难过，当下线索')]);
  store.apply(change({type:'add',id:'sad',text:'本次感受',sourceIds:['e']},'sad'));
  const t={...traits(),evidenceSources:[{id:'e',version:1}],emotion:{status:'observed' as const,intensity:0.8,sources:[{id:'e',version:1}],observation:'当下线索'}};
  assert.throws(()=>store.dynamics.applyTraits(scope(),{recordId:'sad',expectedVersion:1,operationId:'bad-emotion',traits:t}),/unverified_emotion/);
  store.dynamics.applyTraits(scope(),{recordId:'sad',expectedVersion:1,operationId:'real-emotion',traits:{...t,emotion:{...t.emotion,observation:'非常难过'}}});
  f.setTime('2026-09-13T12:00:00Z');assert.equal(store.dynamics.state(scope(),'sad')!.emotion,0.4);
  store.apply(change({type:'soft_delete',id:'sad',expectedVersion:1},'forget'));
  assert.equal(store.dynamics.state(scope(),'sad')!.emotion,0);assert.equal(store.dynamics.state(scope(),'sad')!.traits.emotion.observation,null);
 }finally{f.cleanup();}
});
test('reinforcement requires a strict user turn, survives restart and shares quota through merge',async()=>{
 const f=setup();try{
  let store=f.open();seed(store);store.apply(change({type:'add',id:'job2',text:'另一工作记录',sourceIds:['raw']},'add2'));
  f.setTime('2026-09-07T12:00:00Z');const owned=scope('companion','reinforce');
  const port=lifecycle(store);await port.append(owned,[message('repeat','我还在海风公司工作','companion','2026-09-07T12:00:00Z')]);
  const input={recordId:'job',expectedVersion:1,source:{id:'repeat',version:1},kind:'reiteration' as const,operationId:'r1'};
  assert.throws(()=>store.dynamics.reinforce(owned,input),/unconfirmed/);
  await port.prepareTurn(owned,'repeat','我还在海风公司工作',signal());
  const before=store.dynamics.state(owned,'job')!.activation;
  assert.equal(store.dynamics.reinforce(owned,input).reinforced,true);
  assert.equal(store.dynamics.state(owned,'job')!.activation,before+0.2*(1-before));
  store.close();store=f.open();assert.equal(store.dynamics.reinforce(owned,{...input,operationId:'r2'}).reinforced,false);
  store.apply(change({type:'merge',targets:[{id:'job',expectedVersion:1},{id:'job2',expectedVersion:1}],replacement:{id:'merged',text:'合并工作',sourceIds:['job','job2']}},'merge',owned));
  assert.deepEqual(store.dynamics.state(owned,'merged')!.lineageIds,['job','job2','merged']);
  assert.equal(store.dynamics.reinforce(owned,{...input,recordId:'merged',operationId:'r3'}).reinforced,false);
  const count=store.dynamics.history().length;store.dynamics.state(owned,'merged');assert.equal(store.dynamics.history().length,count);
 }finally{f.cleanup();}
});

test('repeated trait extraction cannot refresh old emotion, and supported neutral remains observed',()=>{
 const f=setup();try{
  const store=f.open();store.append(scope(),[message('e','我非常难过'),message('neutral','我现在没有难过的感觉')]);
  store.apply(change({type:'add',id:'sad',text:'本次感受',sourceIds:['e']},'sad'));
  store.apply(change({type:'add',id:'neutral-memory',text:'本次平静感受',sourceIds:['neutral']},'neutral'));
  const observed:MemoryDynamicsTraits={category:'event',importance:0,evidenceSources:[{id:'e',version:1}],emotion:{status:'observed',intensity:0.8,sources:[{id:'e',version:1}],observation:'非常难过'}};
  store.dynamics.applyTraits(scope(),{recordId:'sad',expectedVersion:1,operationId:'e1',traits:observed});
  f.setTime('2026-09-13T12:00:00Z');store.dynamics.applyTraits(scope(),{recordId:'sad',expectedVersion:1,operationId:'e2',traits:observed});
  assert.equal(store.dynamics.state(scope(),'sad')!.emotion,0.4);
  const neutral:MemoryDynamicsTraits={category:'event',importance:0,evidenceSources:[{id:'neutral',version:1}],emotion:{status:'observed',intensity:0,sources:[{id:'neutral',version:1}],observation:'没有难过的感觉'}};
  store.dynamics.applyTraits(scope(),{recordId:'neutral-memory',expectedVersion:1,operationId:'neutral-traits',traits:neutral});
  const state=store.dynamics.state(scope(),'neutral-memory')!;assert.equal(state.emotion,0);assert.equal(state.traits.emotion.status,'observed');assert.equal(state.traits.emotion.intensity,0);
 }finally{f.cleanup();}
});
