import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { MemoryTurnInput, MemoryTurnPlan } from '../../contracts/memory-lifecycle.js';
import { fixture, scope, message, change, seed, NOW } from './sqlite-fixture.js';
import { lifecycle, none, forget, signal, deferred, contextOptions, replyMessage } from './lifecycle-fixture.js';

test('raw-only forgetting atomically hides original, restated request and derived paths; restart cannot re-extract',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();const owned=scope();
  store.append(owned,[message('fact','那次面试失败了。'),message('request','请忘记那次面试失败的事情。')]);
  for(const kind of ['summary','keyword_index','vector_index','context_cache'] as const) store.recordDerived(owned,{id:kind,kind,text:'那次面试失败了',sourceIds:['fact'],createdAt:NOW});
  const pending=store.prepareMaintenance({scope:owned,messages:store.visible(owned,'transcript').map(r=>r.message!),relevantMemories:[]});
  let calls=0;const port=lifecycle(store,async input=>{calls++;return forget(input,['fact']);});
  const outcome=await port.prepareTurn(owned,'request','请忘记那次面试失败的事情。',signal());
  assert.equal(outcome.status,'applied');assert.ok(outcome.affectedIds.includes('request'));assert.deepEqual(store.visible(owned,'transcript'),[]);
  for(const kind of ['summary','keyword_index','vector_index','context_cache'] as const) assert.deepEqual(store.visible(owned,kind),[]);
  assert.equal(store.finishMaintenance(pending,[change({type:'add',id:'late',text:'那次面试失败了',sourceIds:['fact']},'late')])[0]!.status,'rejected');
  assert.equal(store.inspect(owned,'late'),null);store.close();store=f.open();
  const reopened=lifecycle(store,async()=>{throw new Error('must not call provider on an already processed request');});
  assert.deepEqual(await reopened.prepareTurn(owned,'request','请忘记那次面试失败的事情。',signal()),outcome);
  assert.equal(calls,1);assert.deepEqual(reopened.maintenanceInput(owned,'面试').messages,[]);
  assert.throws(()=>store.lifecycle.outcome(scope('sweetheart'),'request','other'),/unknown_character/);
});

test('long-memory forgetting suppresses source, FTS, invitation and request while legacy identity is refused',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);
  store.append(scope(),[message('request','忘记我在海风公司工作的事')]);
  store.invitations.register(scope(),{id:'invite',eventId:'job',text:'工作怎么样',gesture:'wave',eligibleAt:NOW,expiresAt:'2026-09-10T00:00:00Z'});
  const port=lifecycle(store,async input=>({...forget(input,['raw']),changes:[change({type:'soft_delete',id:'job',expectedVersion:1},'forget',input.scope)]}));
  assert.equal((await port.prepareTurn(scope(),'request','忘记我在海风公司工作的事',signal())).status,'applied');
  assert.equal(store.inspect(scope(),'job')!.state,'deleted');assert.deepEqual(store.search(scope(),'海风公司',10),[]);
  assert.deepEqual(store.visible(scope(),'transcript'),[]);assert.equal(store.invitations.inspect(scope(),'invite')!.text,'');
  assert.throws(()=>store.search(scope('sweetheart'),'海风公司',10),/unknown_character/);
});

test('correction changes fact and suppresses old raw atomically, retaining current new evidence',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);store.append(scope(),[message('correct','我换到山川公司工作了')]);
  const port=lifecycle(store,async input=>({...none(input),request:'correction',suppressSources:[{id:'raw',version:1}],changes:[change({type:'update',id:'job',expectedVersion:1,text:'在山川公司工作',sourceIds:['correct']},'update',input.scope)]}));
  assert.equal((await port.prepareTurn(scope(),'correct','我换到山川公司工作了',signal())).status,'applied');
  assert.deepEqual(store.search(scope(),'海风公司',10),[]);assert.equal(store.search(scope(),'山川公司',10).length,1);
  assert.equal(store.inspect(scope(),'raw')!.state,'invalidated');assert.equal(store.inspect(scope(),'correct')!.state,'active');
});

test('raw-only correction may suppress old raw and add the replacement from current evidence',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('old','我周三练吉他'),message('current','我现在改在周五练吉他')]);
  const port=lifecycle(store,async input=>({...none(input),suppressSources:[{id:'old',version:1}],request:'correction',changes:[change({type:'add',id:'guitar',text:'用户周五练吉他',sourceIds:['current']},'new',input.scope)]}));
  assert.equal((await port.prepareTurn(scope(),'current','我现在改在周五练吉他',signal())).status,'applied');
  assert.equal(store.inspect(scope(),'current')!.state,'active');assert.equal(store.inspect(scope(),'old')!.state,'invalidated');assert.equal(store.search(scope(),'周五',5).length,1);
});

test('second business rejection rolls back earlier writes, FTS, operation log, source suppression and outcome',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);store.append(scope(),[message('request','我开始种花')]);
  const port=lifecycle(store,async input=>({...none(input),changes:[change({type:'add',id:'flowers',text:'用户种花',sourceIds:['request']},'first'),change({type:'add',id:'job',text:'duplicate',sourceIds:['request']},'second')],suppressSources:[{id:'raw',version:1}]}));
  const outcome=await port.prepareTurn(scope(),'request','我开始种花',signal());
  assert.equal(outcome.status,'rejected');assert.ok(outcome.results.every(result=>result.status==='rejected'));assert.deepEqual(outcome.affectedIds,[]);
  assert.equal(store.inspect(scope(),'flowers'),null);assert.equal(store.inspect(scope(),'raw')!.state,'active');assert.equal(store.search(scope(),'海风公司',10).length,1);
  const db=new Database(f.filename);f.track(db);assert.equal((db.prepare('SELECT count(*) n FROM memory_turn_outcomes').get() as {n:number}).n,0);
  assert.equal((db.prepare("SELECT count(*) n FROM memory_operations WHERE operation_id='first'").get() as {n:number}).n,0);
});

test('native error during a later change rolls back the complete plan and remains an error',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('request','我开始种花，也喜欢读书')]);
  const db=new Database(f.filename);f.track(db);db.exec("CREATE TRIGGER fail_plan BEFORE INSERT ON memory_records WHEN new.id='books' BEGIN SELECT RAISE(ABORT,'plan_write_failure'); END");
  const port=lifecycle(store,async input=>({...none(input),changes:[change({type:'add',id:'flowers',text:'种花',sourceIds:['request']},'first'),change({type:'add',id:'books',text:'读书',sourceIds:['request']},'second')]}));
  await assert.rejects(()=>port.prepareTurn(scope(),'request','我开始种花，也喜欢读书',signal()),/plan_write_failure/);
  assert.equal(store.inspect(scope(),'flowers'),null);assert.equal((db.prepare('SELECT count(*) n FROM memory_turn_outcomes').get() as {n:number}).n,0);
});

test('ambiguous target and explicit no-action forget do not mutate business data or confirm success',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','面试失败了，另外我养的猫叫团子'),message('request','忘记那件事')]);
  const before=store.revision(scope());const port=lifecycle(store,async input=>({...none(input),request:'forget',clarification:'你指的是哪件事？'}));
  assert.equal((await port.prepareTurn(scope(),'request','忘记那件事',signal())).status,'needs_clarification');assert.equal(store.revision(scope()),before);
  const unexecutable=lifecycle(store,async input=>({...none(input),request:'forget',reason:'mixed source cannot safely preserve unrelated facts'}));
  assert.equal((await unexecutable.prepareTurn(scope(),'request','忘记那件事',signal())).status,'rejected');assert.equal(store.revision(scope()),before);
  assert.equal(store.inspect(scope(),'raw')!.text,'面试失败了，另外我养的猫叫团子');assert.equal(store.inspect(scope(),'request')!.state,'active');
});

test('later same-role mutation makes an awaited whole plan stale; another-session append does not hold a lock',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);store.append(scope(),[message('request','我换工作了')]);const second=f.open();
  const delayed=deferred<MemoryTurnPlan>();let input!:MemoryTurnInput;
  const port=lifecycle(store,async value=>{input=value;return delayed.promise;});
  const pending=port.prepareTurn(scope(),'request','我换工作了',signal());
  second.append(scope('companion','other'),[message('other','新轮次独立输入')]);
  second.apply(change({type:'update',id:'job',expectedVersion:1,text:'最新事实',sourceIds:['raw']},'external'));
  delayed.resolve({...none(input),changes:[change({type:'add',id:'late',text:'迟到结果',sourceIds:['request']},'late')]});
  assert.equal((await pending).status,'rejected');assert.equal(store.inspect(scope(),'late'),null);
});

test('queued turns stop raw input at current storage order, even when newer turns share timestamps',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();const first=scope('companion','first');
  store.append(first,[message('old','旧事实'),message('first:user','先聊工作')]);
  store.append(scope('companion','second'),[message('second:user','请忘记旧事实')]);
  let captured!:MemoryTurnInput;const port=lifecycle(store,async input=>{captured=input;return none(input);});
  assert.equal((await port.prepareTurn(first,'first:user','先聊工作',signal())).status,'unchanged');
  assert.deepEqual(captured.messages.map(m=>m.id),['old','first:user']);assert.ok(!captured.sources.some(source=>source.id==='second:user'));
  assert.equal(captured.currentMessageId,'first:user');assert.equal(store.inspect(first,'old')!.state,'active');
});

test('pending companion plan remains fixed; old identity, forged scope and source versions are refused',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('request','我喜欢种花')]);
  const delayed=deferred<MemoryTurnPlan>();let input!:MemoryTurnInput;const port=lifecycle(store,async value=>{input=value;return delayed.promise;});
  const pending=port.prepareTurn(scope(),'request','我喜欢种花',signal());
  assert.throws(()=>store.append(scope('sweetheart'),[message('request','旧任务','sweetheart')]),/unknown_character/);
  delayed.resolve({...none(input),changes:[change({type:'add',id:'hobby',text:'种花',sourceIds:['request']},'add')]});
  assert.equal((await pending).status,'applied');
  const next=scope('companion','next');store.append(next,[message('next','我喜欢游泳')]);
  const forged=lifecycle(store,async value=>({...forget(value,['next']),scope:scope('sweetheart')}));
  assert.equal((await forged.prepareTurn(next,'next','我喜欢游泳',signal())).status,'rejected');
  const wrongVersion=lifecycle(store,async value=>({...none(value),request:'forget',suppressSources:[{id:'next',version:100}]}));
  assert.equal((await wrongVersion.prepareTurn(next,'next','我喜欢游泳',signal())).status,'rejected');
});

test('cancellation discards a late plan without changing storage',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('request','我喜欢种花')]);
  const delayed=deferred<MemoryTurnPlan>();let input!:MemoryTurnInput;const port=lifecycle(store,async value=>{input=value;return delayed.promise;});
  const controller=new AbortController();const pending=port.prepareTurn(scope(),'request','我喜欢种花',controller.signal);controller.abort(new Error('cancelled-test'));
  await assert.rejects(pending,/cancelled-test/);delayed.resolve(forget(input,['request']));await new Promise(resolve=>setImmediate(resolve));assert.equal(store.inspect(scope(),'request')!.state,'active');
});

test('whole current message budget failure makes zero model calls',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('request','不能截断的长文本'.repeat(200))]);let calls=0;
  const port=lifecycle(store,async input=>{calls++;return none(input);},undefined,{turn:{provider:{plan:async input=>{calls++;return none(input);}},inputTokenBudget:20,countTokens:input=>JSON.stringify(input).length}});
  assert.equal((await port.prepareTurn(scope(),'request','不能截断的长文本'.repeat(200),signal())).rejectionCode,'current_message_exceeds_turn_budget');assert.equal(calls,0);
});

test('issued context survives assistant append and new summaries but fails after forgetting recalled evidence',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);const port=lifecycle(store,async input=>({...forget(input,['raw']),changes:[change({type:'soft_delete',id:'job',expectedVersion:1},'forget-job',input.scope)]}));
  store.append(scope(),[message('greeting','工作')]);
  store.lifecycle.registerCurrent(scope(),'greeting','工作');
  const context=await port.context(scope(),'工作',null,signal());
  await port.appendAssistant(scope(),replyMessage(scope()),context,'greeting',signal());assert.doesNotThrow(()=>port.assertContextCurrent(context));
  await port.summarizePending(scope(),signal());assert.doesNotThrow(()=>port.assertContextCurrent(context));
  store.append(scope(),[message('forget','忘记工作')]);assert.doesNotThrow(()=>port.assertContextCurrent(context));
  await port.prepareTurn(scope(),'forget','忘记工作',signal());assert.throws(()=>port.assertContextCurrent(context),/stale_context/);
  assert.throws(()=>port.assertContextCurrent(structuredClone(context)),/unissued/);
});

test('source versions are rechecked even if an external write does not advance maintenance epoch',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','原文事实'),message('request','请忘记原文事实')]);
  const delayed=deferred<MemoryTurnPlan>();let input!:MemoryTurnInput;const port=lifecycle(store,async value=>{input=value;return delayed.promise;});
  const pending=port.prepareTurn(scope(),'request','请忘记原文事实',signal());
  const db=new Database(f.filename);f.track(db);db.prepare("UPDATE memory_records SET version=version+1,text='已经修正' WHERE character_id='companion' AND id='raw'").run();
  delayed.resolve(forget(input,['raw']));assert.equal((await pending).status,'rejected');assert.equal(store.inspect(scope(),'request')!.state,'active');assert.equal(store.inspect(scope(),'raw')!.text,'已经修正');
});

test('turn input stays bounded and preserves original read scope even if the provider mutates its copy',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();for(const id of ['a','b','request'])store.append(scope(),[message(id,`完整消息${id}`)]);
  let captured!:MemoryTurnInput;const port=lifecycle(store,async input=>{captured=structuredClone(input);Object.assign(input, {scope:{...input.scope,characterId:'sweetheart'}});return none(captured);},undefined,
    {context:{...contextOptions,maxRecentMessages:2,maxMemories:0,summaryLimit:0}});
  assert.equal((await port.prepareTurn(scope(),'request','完整消息request',signal())).status,'unchanged');assert.deepEqual(captured.messages.map(message=>message.id),['b','request']);
  assert.ok(captured.sources.every(source=>source.scope.characterId==='companion'));assert.equal(store.lifecycle.outcome(scope(),'request','完整消息request')!.scope.characterId,'companion');
});
