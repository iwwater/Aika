import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture,scope,message,change,NOW} from './sqlite-fixture.js';
import {lifecycle,signal,none,deferred,forget,replyMessage} from './lifecycle-fixture.js';
import type {MemoryTurnPlan} from '../../contracts/memory-lifecycle.js';

test('foreground reads while strict writer is held and survives unrelated committed memory changes',async()=>{
 const f=fixture(undefined,'voice-feedback-03');try{
  const store=f.open();store.append(scope(),[message('raw-tea','红茶'),message('raw-cat','猫叫团子')]);
  store.apply(change({type:'add',id:'tea',text:'红茶',sourceIds:['raw-tea']},'tea'));
  store.apply(change({type:'add',id:'cat',text:'猫叫团子',sourceIds:['raw-cat']},'cat'));
  const gate=deferred<MemoryTurnPlan>();let input!:Parameters<typeof none>[0];
  const port=lifecycle(store,async value=>{input=value;return gate.promise;});
  const old=scope('companion','writer');await port.append(old,[message('writer:user','猫')]);
  const writer=port.prepareBackgroundTurn(old,'writer:user','猫',signal());await new Promise(resolve=>setImmediate(resolve));
  const current=scope('companion','front');await port.append(current,[message('front:user','红茶')]);
  // No timeout fallback: writer is still unresolved at the completed foreground read.
  const context=await port.foregroundContext(current,'front:user','红茶',null,signal());
  assert.ok(context.memories.some(m=>m.id==='tea'));assert.ok(!context.memories.some(m=>m.id==='cat'));
  gate.resolve({...none(input),changes:[change({type:'update',id:'cat',expectedVersion:1,text:'猫叫小团子',sourceIds:['raw-cat']},'update-cat',old)]});
  assert.equal((await writer).status,'applied');
  port.assertContextCurrent(context);
  await port.appendAssistant(current,{characterId:'companion',id:'front:assistant',role:'assistant',text:'记得红茶',createdAt:NOW},context,'front:user',signal());
 }finally{f.cleanup();}
});

for(const type of ['update','soft_delete'] as const)test(`selected-source ${type} invalidates foreground exposure and assistant save`,async()=>{
 const f=fixture(undefined,'voice-feedback-03');try{
  const store=f.open();store.append(scope(),[message('raw','红茶')]);store.apply(change({type:'add',id:'tea',text:'红茶',sourceIds:['raw']},'add'));
  const port=lifecycle(store);await port.append(scope(),[message('turn-1:user','红茶')]);
  const context=await port.foregroundContext(scope(),'turn-1:user','红茶',null,signal());
  store.apply(change(type==='soft_delete'?{type,id:'tea',expectedVersion:1}:{type,id:'tea',expectedVersion:1,text:'绿茶',sourceIds:['raw']},'mutation'));
  assert.throws(()=>port.assertContextCurrent(context),/stale_context/);
  await assert.rejects(port.appendAssistant(scope(),replyMessage(scope()),context,'turn-1:user',signal()),/stale_context/);
  assert.ok(!(await port.foregroundContext(scope(),'turn-1:user','红茶',null,signal())).memories.some(x=>x.id==='tea'&&x.version===1));
 }finally{f.cleanup();}
});

test('pending exclusion is durable, hides every personal context channel, keeps writer evidence and makes replies display-only',async()=>{
 const f=fixture(undefined,'voice-feedback-03');try{
  let store=f.open();store.append(scope(),[message('raw','红茶秘密')]);store.apply(change({type:'add',id:'tea',text:'红茶秘密',sourceIds:['raw']},'add'));
  store.recordDerived(scope(),{id:'summary',kind:'summary',text:'红茶秘密摘要',sourceIds:['raw'],createdAt:NOW});
  let port=lifecycle(store);await port.append(scope(),[message('turn-1:user','忘记红茶秘密')]);
  port.beginPendingMutation(scope(),'turn-1:user',{request:'forget',sources:null});
  assert.throws(()=>port.beginPendingMutation({...scope(),generation:2},'turn-1:user',{request:'forget',sources:null}));
  let seen=false;
  port=lifecycle(store,async input=>{seen=input.sources.some(x=>x.text==='红茶秘密');throw new Error('controlled_provider_failure');});
  const context=await port.foregroundContext(scope(),'turn-1:user','忘记红茶秘密',{scope:scope(),transcript:'红茶秘密',status:'partial',modalities:[],cues:[]},signal());
  assert.deepEqual(store.search(scope(),'红茶',10),[]);assert.deepEqual(store.contextRecords(scope(),'红茶',12,8,4).recent,[]);
  assert.deepEqual(context.memories,[]);assert.ok(!JSON.stringify(context).includes('红茶秘密'));
  await port.appendAssistant(scope(),replyMessage(scope(),'正在处理'),context,'turn-1:user',signal());
  const saved=store.inspect(scope(),'turn-1:assistant')!;assert.equal(saved.evidenceEligible,false);assert.deepEqual(saved.sources,[]);
  await assert.rejects(port.prepareBackgroundTurn(scope(),'turn-1:user','忘记红茶秘密',signal()),/controlled_provider_failure/);assert.equal(seen,true);
  assert.equal(port.pendingMutations('companion')[0]!.status,'failed');
  store.close();store=f.open();port=lifecycle(store);assert.equal(port.pendingMutations('companion')[0]!.status,'failed');
  const next=scope('companion','next');await port.append(next,[message('next:user','红茶')]);
  assert.ok(!JSON.stringify(await port.foregroundContext(next,'next:user','红茶',null,signal())).includes('红茶秘密'));
 }finally{f.cleanup();}
});

test('strict forget releases only its matching hold and a pending reply remains display-only after commit',async()=>{
 const f=fixture(undefined,'voice-feedback-03');try{
  const store=f.open();store.append(scope(),[message('raw','红茶秘密')]);store.apply(change({type:'add',id:'tea',text:'红茶秘密',sourceIds:['raw']},'add'));
  const port=lifecycle(store,async input=>({...forget(input,['raw']),changes:[change({type:'soft_delete',id:'tea',expectedVersion:1},'strict-delete',input.scope)]}));await port.append(scope(),[message('turn-1:user','忘记红茶秘密')]);
  port.beginPendingMutation(scope(),'turn-1:user',{request:'forget',sources:null});
  const context=await port.foregroundContext(scope(),'turn-1:user','忘记红茶秘密',null,signal());
  const outcome=await port.prepareBackgroundTurn(scope(),'turn-1:user','忘记红茶秘密',signal());assert.equal(outcome.status,'applied',JSON.stringify(outcome));
  assert.deepEqual(port.pendingMutations('companion'),[]);assert.deepEqual(store.search(scope(),'红茶',10),[]);
  await port.appendAssistant(scope(),replyMessage(scope(),'正在处理'),context,'turn-1:user',signal());assert.equal(store.inspect(scope(),'turn-1:assistant')!.evidenceEligible,false);
 }finally{f.cleanup();}
});

for(const intent of ['uncertain','forget'] as const)test(`successful strict none ${intent==='uncertain'?'releases uncertain':'retains explicit forget'} hold`,async()=>{
 const f=fixture(undefined,'voice-feedback-03');try{
  const store=f.open(),port=lifecycle(store);await port.append(scope(),[message('turn-1:user','测试请求')]);
  port.beginPendingMutation(scope(),'turn-1:user',{request:intent,sources:null});
  assert.equal((await port.prepareBackgroundTurn(scope(),'turn-1:user','测试请求',signal())).status,'unchanged');
  assert.equal(port.pendingMutations('companion').length,intent==='uncertain'?0:1);
  if(intent==='forget')assert.equal(port.pendingMutations('companion')[0]!.status,'failed');
 }finally{f.cleanup();}
});

test('new privacy barrier rejects old ordinary context and old writer; one completion cannot release another hold',async()=>{
 const f=fixture(undefined,'voice-feedback-03');try{
  const store=f.open(),gate=deferred<MemoryTurnPlan>();let oldInput!:Parameters<typeof none>[0];
  const port=lifecycle(store,async input=>{if(input.scope.turnId==='old'){oldInput=input;return gate.promise;}return none(input);});
  const old=scope('companion','old');await port.append(old,[message('old:user','普通消息')]);
  const context=await port.foregroundContext(old,'old:user','普通消息',null,signal());const work=port.prepareBackgroundTurn(old,'old:user','普通消息',signal());
  for(const id of ['one','two']){const s=scope('companion',id);await port.append(s,[message(`${id}:user`,'待确定')]);port.beginPendingMutation(s,`${id}:user`,{request:'uncertain',sources:null});}
  assert.throws(()=>port.assertContextCurrent(context),/stale_context/);gate.resolve(none(oldInput));assert.equal((await work).status,'rejected');
  await port.prepareBackgroundTurn(scope('companion','one'),'one:user','待确定',signal());
  assert.deepEqual(port.pendingMutations('companion').map(x=>x.currentMessageId),['two:user']);
 }finally{f.cleanup();}
});

test('failed strict task can retry after restart using the original persisted scope and source identity',async()=>{
 const f=fixture(undefined,'voice-feedback-03');try{
  let store=f.open();let port=lifecycle(store,async()=>{throw new Error('synthetic offline');});
  await port.append(scope(),[message('turn-1:user','测试')]);port.beginPendingMutation(scope(),'turn-1:user',{request:'uncertain',sources:null});
  await assert.rejects(port.prepareBackgroundTurn(scope(),'turn-1:user','测试',signal()),/synthetic offline/);
  store.close();store=f.open();port=lifecycle(store);
  const pending=port.pendingMutations('companion')[0]!;
  const result=await port.prepareBackgroundTurn(pending.scope,pending.currentMessageId,store.inspect(pending.scope,pending.currentMessageId)!.text,signal());
  assert.equal(result.status,'unchanged');assert.deepEqual(port.pendingMutations('companion'),[]);
 }finally{f.cleanup();}
});

test('explicit cancellation survives restart, blocks late and queued writers, and does not restore deleted records',async()=>{
 const f=fixture(undefined,'voice-feedback-03');try{
  let store=f.open();store.append(scope(),[message('raw','红茶')]);store.apply(change({type:'add',id:'tea',text:'红茶',sourceIds:['raw']},'add'));store.apply(change({type:'soft_delete',id:'tea',expectedVersion:1},'delete'));
  const gate=deferred<MemoryTurnPlan>();let input!:Parameters<typeof none>[0];let port=lifecycle(store,async value=>{input=value;return gate.promise;});
  await port.append(scope(),[message('turn-1:user','待处理')]);port.beginPendingMutation(scope(),'turn-1:user',{request:'uncertain',sources:null});
  const work=port.prepareBackgroundTurn(scope(),'turn-1:user','待处理',signal());
  assert.throws(()=>port.cancelPendingMutation({...scope(),generation:2},'turn-1:user'),/pending_identity_mismatch/);
  port.cancelPendingMutation(scope(),'turn-1:user');gate.resolve(none(input));assert.equal((await work).status,'rejected');
  assert.deepEqual(port.pendingMutations('companion'),[]);assert.notEqual(store.inspect(scope(),'tea')!.state,'active');
  store.close();store=f.open();port=lifecycle(store,async()=>{throw new Error('must not call provider');});
  const result=await port.prepareBackgroundTurn(scope(),'turn-1:user','待处理',signal());assert.equal(result.rejectionCode,'pending_request_cancelled');
  assert.deepEqual(port.pendingMutations('companion'),[]);assert.notEqual(store.inspect(scope(),'tea')!.state,'active');
 }finally{f.cleanup();}
});

test('a strict forget that wins the scheduling race still permits its already-bound foreground response with no private context',async()=>{
 const f=fixture(undefined,'voice-feedback-03');try{
  const store=f.open();store.append(scope(),[message('raw','红茶秘密')]);
  const port=lifecycle(store,async input=>forget(input,['raw']));
  await port.append(scope(),[message('turn-1:user','忘记红茶秘密')]);port.beginPendingMutation(scope(),'turn-1:user',{request:'forget',sources:null});
  assert.equal((await port.prepareBackgroundTurn(scope(),'turn-1:user','忘记红茶秘密',signal())).status,'applied');
  const context=await port.foregroundContext(scope(),'turn-1:user','忘记红茶秘密',null,signal());
  assert.ok(!JSON.stringify(context).includes('红茶秘密'));
  await port.appendAssistant(scope(),replyMessage(scope(),'正在处理'),context,'turn-1:user',signal());
  assert.equal(store.inspect(scope(),'turn-1:assistant')!.evidenceEligible,false);
  await assert.rejects(port.foregroundContext({...scope(),generation:2},'turn-1:user','忘记红茶秘密',null,signal()),/scope_mismatch/);
 }finally{f.cleanup();}
});
