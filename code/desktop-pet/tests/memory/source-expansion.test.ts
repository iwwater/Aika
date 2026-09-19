import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type {TestContext} from 'node:test';
import type {MemoryTurnInput,MemoryTurnPlan} from '../../contracts/memory-lifecycle.js';
import {fixture,scope,message,change,NOW} from './sqlite-fixture.js';
import {lifecycle,none,signal,contextOptions,replyMessage,deferred} from './lifecycle-fixture.js';
import {memoryTurnInputUpperBound} from '../../app/input-budgets.js';

async function setup(t:TestContext){
  const f=fixture();t.after(f.cleanup);const store=f.open(),seed=scope('companion','seed'),owned=scope('companion','forget');
  store.append(seed,[message('cat-raw','猫叫团子'),message('daily','今天聊聊日常安排')]);store.apply(change({type:'add',id:'cat',text:'猫叫团子',sourceIds:['cat-raw']},'seed-cat',seed));
  const original=lifecycle(store);await original.prepareTurn(seed,'daily','今天聊聊日常安排',signal());const context=await original.context(seed,'今天聊聊日常安排',null,signal());await original.appendAssistant(seed,replyMessage(seed,'猫叫团子；我们聊日常'),context,'daily',signal());
  store.append(owned,[message('request','忘记猫名')]);
  const first=(input:MemoryTurnInput):MemoryTurnPlan=>({...none(input),request:'forget',suppressSources:['cat-raw','request'].map(id=>({id,version:input.sources.find(s=>s.id===id)!.version})),changes:[change({type:'soft_delete',id:'cat',expectedVersion:1},'delete-cat',input.scope)]});
  const complete=(input:MemoryTurnInput):MemoryTurnPlan=>({...first(input),suppressSources:[...first(input).suppressSources,{id:'seed:assistant',version:1}],retainSources:[{source:{id:'seed:assistant',version:1},fragmentId:'f0',start:5,end:10,supportSourceIds:['daily']}]});
  const port=(provider:(input:MemoryTurnInput)=>Promise<MemoryTurnPlan>,max:0|1|null=1,budget=32768)=>lifecycle(store,provider,undefined,{context:{...contextOptions,maxRecentMessages:2},turn:{provider:{plan:provider},inputTokenBudget:budget,countTokens:memoryTurnInputUpperBound,...(max===null?{}:{maxSupplementaryPlans:max})}});
  const assertUnchanged=()=>{assert.equal(store.inspect(owned,'cat')!.state,'active');assert.equal(store.inspect(owned,'cat-raw')!.state,'active');assert.equal(store.inspect(owned,'request')!.state,'active');assert.equal(store.inspect(owned,'seed:assistant')!.state,'active');assert.equal(store.lifecycle.outcome(owned,'request','忘记猫名'),null);assert.equal(store.visible(owned,'transcript').filter(r=>r.fragment).length,0);};
  return {f,store,owned,first,complete,port,assertUnchanged,run:(p:ReturnType<typeof port>,s=signal())=>p.prepareTurn(owned,'request','忘记猫名',s)};
}

test('one necessary source expansion keeps first plan read-only and preserves unrelated assistant text atomically',async t=>{
  const f=await setup(t);let calls=0;let expanded!:MemoryTurnInput;const revision=f.store.revision(f.owned);
  const port=f.port(async input=>{
    calls++;f.assertUnchanged();assert.equal(f.store.revision(f.owned),revision);
    const db=new Database(f.f.filename,{readonly:true});assert.equal(db.prepare("SELECT * FROM memory_operations WHERE operation_id='delete-cat'").get(),undefined);db.close();
    if(calls===1){assert.equal(input.messages.length,2);assert.ok(!input.sources.some(s=>s.id==='seed:assistant'));return f.first(input);}
    expanded=input;assert.equal(input.messages.length,4);assert.ok(input.sources.some(s=>s.id==='daily'));return f.complete(input);
  });
  const result=await f.run(port);assert.equal(result.status,'applied',result.rejectionCode??'');assert.equal(calls,2);assert.ok(memoryTurnInputUpperBound(expanded)<=32768);
  assert.equal(f.store.inspect(f.owned,'cat')!.state,'deleted');assert.equal(f.store.search(f.owned,'团子',10).length,0);
  const survivor=f.store.visible(f.owned,'transcript').find(r=>r.fragment)!;assert.equal(survivor.text,'我们聊日常');assert.deepEqual(survivor.sources,[{id:'daily',version:1}]);assert.ok(!/^f\d+$/.test(survivor.id));
  assert.deepEqual(await f.run(port),result);assert.equal(calls,2);
});

for(const limit of [0,null] as const)test(`supplementary planning ${limit===null?'defaults to off':'can be explicitly disabled'}`,async t=>{
  const f=await setup(t);let calls=0;const result=await f.run(f.port(async input=>{calls++;return f.first(input);},limit));assert.equal(result.status,'rejected');assert.equal(calls,1);f.assertUnchanged();
});

test('already-read missing disposition is not an expansion trigger, even when other sources are unread',async t=>{
  const f=await setup(t);let calls=0;const result=await f.run(f.port(async input=>{calls++;return {...f.first(input),suppressSources:[{id:'request',version:1}]};}));
  assert.equal(result.rejectionCode,'unresolved_source_disposition');assert.equal(calls,1);f.assertUnchanged();
});

test('provider protocol failure is propagated once without treating it as missing evidence',async t=>{
  const f=await setup(t);let calls=0;await assert.rejects(()=>f.run(f.port(async()=>{calls++;throw Error('invalid provider plan');})),/invalid provider plan/);assert.equal(calls,1);f.assertUnchanged();
});

test('expanded actual wire exceeding budget rejects with no second model call',async t=>{
  const f=await setup(t);let calls=0;
  const ticket=f.store.lifecycle.readTurn(f.owned,'request','忘记猫名',{maxRecentMessages:2,maxMemories:8,summaryLimit:4,inputTokenBudget:32768,countTokens:memoryTurnInputUpperBound});
  const budget=memoryTurnInputUpperBound(ticket.input)+1;f.store.lifecycle.discardTurn(ticket);
  const result=await f.run(f.port(async input=>{calls++;return f.first(input);},1,budget));
  assert.equal(result.rejectionCode,'source_expansion_exceeds_budget');assert.equal(calls,1);f.assertUnchanged();
});

test('second plan cannot change the current request category',async t=>{
  const f=await setup(t);let calls=0;const result=await f.run(f.port(async input=>++calls===1?f.first(input):{...f.complete(input),request:'none'}));
  assert.equal(result.rejectionCode,'supplementary_request_changed');assert.equal(calls,2);f.assertUnchanged();
});

test('second plan omitting a now-read source rejects without a third attempt',async t=>{
  const f=await setup(t);let calls=0;const result=await f.run(f.port(async input=>{calls++;return f.first(input);}));assert.equal(result.rejectionCode,'unresolved_source_disposition');assert.equal(calls,2);f.assertUnchanged();
});

test('late same-role descendant without epoch bump is detected during final closure recomputation',async t=>{
  const f=await setup(t);let calls=0;const result=await f.run(f.port(async input=>{
    if(++calls===1)return f.first(input);
    f.store.recordDerived(f.owned,{id:'late-summary',kind:'summary',text:'猫叫团子',sourceIds:['cat-raw'],createdAt:NOW});return f.complete(input);
  }));
  assert.equal(result.status,'rejected');assert.equal(calls,2);f.assertUnchanged();assert.equal(f.store.inspect(f.owned,'late-summary')!.state,'active');
});

test('source version changed after expansion rejects the second plan',async t=>{
  const f=await setup(t);let calls=0;const result=await f.run(f.port(async input=>{
    if(++calls===1)return f.first(input);const db=new Database(f.f.filename);db.prepare("UPDATE memory_records SET version=version+1 WHERE character_id='companion' AND id='daily'").run();db.close();return f.complete(input);
  }));
  assert.equal(result.rejectionCode,'stale_lifecycle_source');assert.equal(calls,2);f.assertUnchanged();
});

test('old role write is rejected during supplementary planning without poisoning the companion ticket',async t=>{
  const f=await setup(t);let calls=0;const result=await f.run(f.port(async input=>{
    assert.ok(input.sources.every(s=>s.scope.characterId==='companion'));
    if(++calls===1)return f.first(input);assert.throws(()=>f.store.append(scope('sweetheart'),[message('daily','旧角色内容','sweetheart')]),/unknown_character/);return f.complete(input);
  }));
  assert.equal(result.status,'applied');assert.equal(calls,2);assert.throws(()=>f.store.inspect(scope('sweetheart'),'daily'),/unknown_character/);
});

test('cancellation while awaiting supplementary plan cannot persist its late fragments',async t=>{
  const f=await setup(t),delayed=deferred<MemoryTurnPlan>();let expanded!:MemoryTurnInput,calls=0;const controller=new AbortController();
  const pending=f.run(f.port(async input=>{if(++calls===1)return f.first(input);expanded=input;return delayed.promise;}),controller.signal);
  while(calls<2)await new Promise(resolve=>setImmediate(resolve));controller.abort(new Error('cancel-expanded'));
  await assert.rejects(pending,/cancel-expanded/);delayed.resolve(f.complete(expanded));await new Promise(resolve=>setImmediate(resolve));f.assertUnchanged();
});

test('SQL failure in final fragment write rolls back all second-plan writes and first-plan IDs',async t=>{
  const f=await setup(t);const db=new Database(f.f.filename);t.after(()=>db.close());db.exec("CREATE TRIGGER fail_expansion BEFORE INSERT ON memory_records WHEN new.fragment_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'expanded_write_failure'); END");let calls=0;
  await assert.rejects(()=>f.run(f.port(async input=>++calls===1?f.first(input):f.complete(input))),/expanded_write_failure/);assert.equal(calls,2);f.assertUnchanged();assert.equal(db.prepare("SELECT * FROM memory_operations WHERE operation_id='delete-cat'").get(),undefined);
});

test('active ineligible memory cannot be silently deleted or disguised as a readable missing source',async t=>{
  const f=await setup(t);f.store.apply(change({type:'add',id:'ineligible',text:'猫的关联记忆',sourceIds:['cat-raw']},'seed-ineligible',f.owned));
  const db=new Database(f.f.filename);t.after(()=>db.close());db.prepare("UPDATE memory_records SET evidence_eligible=0 WHERE character_id='companion' AND id='ineligible'").run();let calls=0;
  const result=await f.run(f.port(async input=>{calls++;return f.first(input);}));
  assert.equal(result.rejectionCode,'unresolved_memory_suppression');assert.equal(calls,1);f.assertUnchanged();assert.equal(f.store.inspect(f.owned,'ineligible')!.state,'active');
});

test('scope or current identity changes cannot be introduced by a supplementary provider copy',async t=>{
  const f=await setup(t);let calls=0;const result=await f.run(f.port(async input=>{
    if(++calls===1)return f.first(input);Object.assign(input,{scope:scope('sweetheart'),currentMessageId:'other'});return f.complete({...input,scope:scope('sweetheart')});
  }));
  assert.equal(result.rejectionCode,'invalid_turn_plan');assert.equal(calls,2);f.assertUnchanged();
});

test('same-role epoch change before expansion prevents a second model call',async t=>{
  const f=await setup(t);let calls=0;const result=await f.run(f.port(async input=>{
    calls++;f.store.apply(change({type:'update',id:'cat',expectedVersion:1,text:'猫叫糯米',sourceIds:['cat-raw']},'concurrent',f.owned));return f.first(input);
  }));
  assert.equal(result.rejectionCode,'stale_lifecycle_epoch');assert.equal(calls,1);assert.equal(f.store.inspect(f.owned,'cat')!.text,'猫叫糯米');assert.equal(f.store.inspect(f.owned,'cat-raw')!.state,'active');
  assert.equal(f.store.lifecycle.outcome(f.owned,'request','忘记猫名'),null);
});

test('clarification after supplementation remains a clarification with no effects',async t=>{
  const f=await setup(t);let calls=0;const result=await f.run(f.port(async input=>++calls===1?f.first(input):{...none(input),request:'forget',clarification:'你指哪段经历？'}));
  assert.equal(result.status,'needs_clarification');assert.equal(calls,2);f.assertUnchanged();
});
