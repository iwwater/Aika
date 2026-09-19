import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { MemoryTurnInput, MemoryTurnPlan } from '../../contracts/memory-lifecycle.js';
import { RoleMemoryLifecycleQueue } from '../../core/memory-lifecycle-queue.js';
import { fixture, scope, message, change, NOW } from './sqlite-fixture.js';
import { lifecycle, none, forget, signal, deferred, contextOptions, replyMessage } from './lifecycle-fixture.js';

const receipts: unknown[] = [];
after(() => { if (process.env.W3_BACKGROUND_RECEIPT) writeFileSync(process.env.W3_BACKGROUND_RECEIPT, JSON.stringify({ evidence:'controlled synthetic SQLite; no model or device calls', receipts }, null, 2)+'\n'); });

test('held background plan permits same-role foreground context and verified reply, then commits only its captured role', { timeout:5000 }, async t => {
  const f=fixture(); t.after(f.cleanup); let store=f.open();
  const entered=deferred<MemoryTurnInput>(), release=deferred<MemoryTurnPlan>(); let calls=0;
  const port=lifecycle(store, async input => { calls++; entered.resolve(input); return release.promise; });
  const failures:unknown[]=[];
  const queue=new RoleMemoryLifecycleQueue(port, (...args)=>failures.push(args)); t.after(()=>queue.close());
  const original=scope('companion','background'), mutable={...original};
  await port.append(mutable,[message('old:user','我喜欢种花')]);
  let completed=false;
  const job=queue.enqueueTurn(mutable,'old:user','我喜欢种花'); void job.then(()=>{completed=true;});
  Object.assign(mutable,scope('sweetheart','switched'));
  const input=await entered.promise;
  const next={...scope('companion','foreground'),sessionId:'new-session',generation:2};
  await port.append(next,[message('next:user','下午好')]);
  const context=await queue.foregroundContext(next,'next:user','下午好',null,signal());
  await queue.appendForegroundAssistant(next,replyMessage(next,'下午好。'),context,'next:user',signal());
  assert.equal(completed,false);
  const saved=store.inspect(next,'foreground:assistant')!;
  assert.ok(saved.sources.some(ref=>ref.id==='next:user'&&ref.version===1));
  assert.ok(saved.evidenceEligible);
  const other=scope('sweetheart','other');
  await assert.rejects(()=>port.append(other,[message('old:user','旧任务','sweetheart')]),/unknown_character/);
  await assert.rejects(()=>queue.foregroundContext(other,'old:user','旧任务',null,signal()),/unknown_character/);
  release.resolve({...none(input),changes:[change({type:'add',id:'hobby',text:'用户喜欢种花',sourceIds:['old:user']},'background-add',input.scope)]});
  const outcome=await job;
  assert.equal(outcome.status,'applied'); assert.deepEqual(outcome.scope,original);
  assert.throws(()=>store.inspect(other,'hobby'),/unknown_character/);
  // An additive background memory did not change any source selected by this foreground reply.
  assert.doesNotThrow(()=>queue.assertContextCurrent(context));
  const renewed=await port.context(next,'下午好',null,signal());
  await queue.appendForegroundAssistant(next,{...replyMessage(next),id:'renewed:assistant'},renewed,'next:user',signal());
  assert.deepEqual(await queue.enqueueTurn(original,'old:user','我喜欢种花'),outcome);
  assert.equal(calls,1); assert.deepEqual(failures,[]);
  await queue.close(); store.close(); store=f.open();
  const reopened=lifecycle(store);
  const recalled=await reopened.context(scope('companion','restart'),'种花',null,signal());
  assert.ok(recalled.memories.some(memory=>memory.id==='hobby'&&memory.text==='用户喜欢种花'));
  assert.throws(()=>store.inspect(other,'hobby'),/unknown_character/);
  receipts.push({case:'foreground-before-background-completion',input,context,saved,outcome,renewed,restartedContext:recalled,providerFixtureCalls:calls});
});

test('late synchronous completion cannot replace a newer current with the same turn ID in another session/generation', { timeout:5000 }, async t => {
  const f=fixture(); t.after(f.cleanup); const store=f.open();
  const release=deferred<MemoryTurnPlan>(), entered=deferred<MemoryTurnInput>();
  const port=lifecycle(store,async input=>{entered.resolve(input);return release.promise;});
  const old=scope('companion','shared-turn'), next={...old,sessionId:'session-2',generation:2};
  await port.append(old,[message('old','早上好')]);
  const pending=port.prepareTurn(old,'old','早上好',signal()); const input=await entered.promise;
  await port.append(next,[message('next','晚上好')]);
  await port.foregroundContext(next,'next','晚上好',null,signal());
  release.resolve(none(input)); assert.equal((await pending).status,'unchanged');
  const context=await port.context(next,'晚上好',null,signal());
  await port.appendAssistant(next,replyMessage(next),context,'next',signal());
  assert.ok(store.inspect(next,'shared-turn:assistant')!.sources.some(ref=>ref.id==='next'));
  receipts.push({case:'late-legacy-completion',old,next,context,assistant:store.inspect(next,'shared-turn:assistant')});
});

test('foreground admission requires a successful append binding of the exact role/session/turn/generation and body', async t => {
  const f=fixture(); t.after(f.cleanup); const store=f.open(); let calls=0;
  const port=lifecycle(store,async input=>{calls++;return none(input);}); const owned=scope();
  await port.append(owned,[message('current','你好')]);
  for(const forged of [{...owned,sessionId:'forged'},{...owned,turnId:'forged'},{...owned,generation:2}]) {
    await assert.rejects(()=>port.foregroundContext(forged,'current','你好',null,signal()),/current_message_scope_mismatch/);
    assert.equal((await port.prepareBackgroundTurn(forged,'current','你好',signal())).rejectionCode,'current_message_scope_mismatch');
  }
  await assert.rejects(()=>port.foregroundContext(owned,'current','篡改',null,signal()),/foreground_current_not_available/);
  await assert.rejects(()=>port.foregroundContext({...owned,generation:-1},'current','你好',null,signal()),/invalid_scope/);
  await assert.rejects(()=>port.foregroundContext(scope('sweetheart'),'current','你好',null,signal()),/unknown_character/);
  await assert.rejects(()=>port.append(scope('sweetheart'),[message('current','旧角色','sweetheart')]),/unknown_character/);
  store.append(owned,[message('historical','历史正文')]);
  await assert.rejects(()=>port.append(owned,[message('historical','历史正文')]),/duplicate/);
  await assert.rejects(()=>port.foregroundContext(owned,'historical','历史正文',null,signal()),/foreground_current_not_bound/);
  const issued=await port.foregroundContext(owned,'current','你好',null,signal());
  await assert.rejects(()=>port.appendAssistant({...owned,sessionId:'forged'},replyMessage(owned),issued,'current',signal()),/identity/);
  await assert.rejects(()=>port.appendAssistant(owned,replyMessage(owned),structuredClone(issued),'current',signal()),/identity/);
  assert.equal(calls,0); assert.equal(store.inspect(owned,replyMessage(owned).id),null);
  receipts.push({case:'append-binding',rejectedDimensions:['session','turn','generation','body','role','invalid-scope','failed-append','forged-context'],providerFixtureCalls:calls});
});

test('historical reads and synchronous preparation do not bind foreground; reopen requires a freshly appended current', async t => {
  const f=fixture(); t.after(f.cleanup); let store=f.open(); let port=lifecycle(store); const owned=scope();
  store.append(owned,[message('history','历史')]);
  await port.prepareTurn(owned,'history','历史',signal()); await port.context(owned,'历史',null,signal());
  await assert.rejects(()=>port.foregroundContext(owned,'history','历史',null,signal()),/foreground_current_not_bound/);
  await port.append(scope('companion','bound'),[message('bound','本进程消息')]);
  await port.foregroundContext(scope('companion','bound'),'bound','本进程消息',null,signal());
  store.close(); store=f.open(); port=lifecycle(store);
  await assert.rejects(()=>port.foregroundContext(scope('companion','bound'),'bound','本进程消息',null,signal()),/foreground_current_not_bound/);
  assert.equal((await port.prepareTurn(owned,'history','历史',signal())).status,'unchanged');
  const fresh={...scope('companion','fresh'),sessionId:'restarted',generation:2};
  await port.append(fresh,[message('fresh','新轮次')]);
  const context=await port.foregroundContext(fresh,'fresh','新轮次',null,signal());
  await port.appendAssistant(fresh,replyMessage(fresh),context,'fresh',signal());
  receipts.push({case:'restart-admission',reopenedHistoricalRefused:true,legacyReplay:'unchanged',fresh,context});
});

test('background plans retain epoch, exact source version and forged scope protections', async t => {
  for(const guard of ['epoch','source-version','plan-scope','change-scope','disposition-version'] as const) await t.test(guard,async t=>{
    const f=fixture(); t.after(f.cleanup); const store=f.open(); const owned=scope();
    const release=deferred<MemoryTurnPlan>(), entered=deferred<MemoryTurnInput>();
    const port=lifecycle(store,async input=>{entered.resolve(input);return release.promise;});
    await port.append(owned,[message('raw','我喜欢种花'),message('current','记住种花')]);
    if(guard==='epoch')store.apply(change({type:'add',id:'external',text:'种花',sourceIds:['raw']},'external',owned));
    const pending=port.prepareBackgroundTurn(owned,'current','记住种花',signal()), input=await entered.promise;
    let plan:MemoryTurnPlan={...none(input),changes:[change({type:'add',id:'late',text:'喜欢种花',sourceIds:['raw']},'late',owned)]};
    if(guard==='epoch')store.apply(change({type:'update',id:'external',expectedVersion:1,text:'开始种花',sourceIds:['raw']},'external-update',owned));
    if(guard==='source-version') { const db=new Database(f.filename); db.prepare("UPDATE memory_records SET version=version+1 WHERE character_id='companion' AND id='raw'").run(); db.close(); }
    if(guard==='plan-scope')plan={...plan,scope:{...owned,sessionId:'forged'}};
    if(guard==='change-scope')plan={...plan,changes:[{...plan.changes[0]!,scope:scope('sweetheart')}]};
    if(guard==='disposition-version')plan={...none(input),request:'forget',suppressSources:[{id:'raw',version:100}]};
    release.resolve(plan); const outcome=await pending;
    assert.equal(outcome.status,'rejected'); assert.ok(outcome.rejectionCode);
    if(guard==='epoch')assert.equal(outcome.rejectionCode,'stale_lifecycle_epoch');
    if(guard==='source-version')assert.equal(outcome.rejectionCode,'stale_lifecycle_source');
    assert.equal(store.inspect(owned,'late'),null); assert.equal(store.inspect(owned,'raw')!.state,'active');
    assert.equal(store.lifecycle.outcome(owned,'current','记住种花'),null);
    receipts.push({case:'strict-background-guard',guard,outcome});
  });
});

test('issued turn tickets cannot be cloned or consumed twice', async t => {
  const f=fixture(); t.after(f.cleanup); const store=f.open(), owned=scope();
  await lifecycle(store).append(owned,[message('current','你好')]);
  const ticket=store.lifecycle.readTurn(owned,'current','你好',{...contextOptions,inputTokenBudget:20000,countTokens:input=>JSON.stringify(input).length});
  assert.equal(store.lifecycle.commitTurn(structuredClone(ticket),none(ticket.input)).rejectionCode,'unknown_or_consumed_turn');
  assert.equal(store.lifecycle.commitTurn(ticket,none(ticket.input)).status,'unchanged');
  assert.equal(store.lifecycle.commitTurn(ticket,none(ticket.input)).rejectionCode,'unknown_or_consumed_turn');
});

test('background forgetting still propagates to derived retrieval and rejects late foreground replies after restart', async t => {
  const f=fixture(); t.after(f.cleanup); let store=f.open(); const owned=scope();
  const port=lifecycle(store,async input=>forget(input,['raw']));
  await port.append(owned,[message('raw','面试失败')]);
  for(const kind of ['summary','keyword_index','vector_index','context_cache'] as const)store.recordDerived(owned,{id:kind,kind,text:'面试失败',sourceIds:['raw'],createdAt:NOW});
  const context=await port.foregroundContext(owned,'raw','面试失败',null,signal());
  const request=scope('companion','forget'); await port.append(request,[message('forget','忘记面试')]);
  const result=await port.prepareBackgroundTurn(request,'forget','忘记面试',signal());
  assert.equal(result.status,'applied');
  await assert.rejects(()=>port.appendAssistant(owned,replyMessage(owned),context,'raw',signal()),/stale_context/);
  assert.equal(store.inspect(owned,replyMessage(owned).id),null);
  for(const kind of ['transcript','summary','keyword_index','vector_index','context_cache'] as const)assert.deepEqual(store.visible(owned,kind),[]);
  store.close(); store=f.open(); const reopened=lifecycle(store);
  const after=await reopened.context(scope('companion','restart'),'面试',null,signal());
  assert.deepEqual(after.recent,[]); assert.equal(after.summary,''); assert.deepEqual(after.memories,[]);
  assert.deepEqual(await reopened.prepareBackgroundTurn(request,'forget','忘记面试',signal()),result);
  receipts.push({case:'background-forget-propagation',result,restartedContext:after,lateAssistantAbsent:true});
});

test('queue shutdown discards a held real SQLite plan and does not start its queued successor', { timeout:5000 }, async t => {
  const f=fixture(); t.after(f.cleanup); const store=f.open();
  const entered=deferred<MemoryTurnInput>(), release=deferred<MemoryTurnPlan>(); let calls=0;
  const port=lifecycle(store,async input=>{calls++;entered.resolve(input);return release.promise;});
  const failures:unknown[]=[]; const queue=new RoleMemoryLifecycleQueue(port, (...args)=>failures.push(args)); t.after(()=>queue.close());
  const first=scope('companion','first'),next=scope('companion','next');
  await port.append(first,[message('first','种花')]);
  const active=queue.enqueueTurn(first,'first','种花'), input=await entered.promise;
  await port.append(next,[message('next','游泳')]); const queued=queue.enqueueTurn(next,'next','游泳');
  const cancelled=new AbortController(); cancelled.abort(new Error('switched'));
  await assert.rejects(()=>queue.foregroundContext(next,'next','游泳',null,cancelled.signal),/switched/);
  const context=await queue.foregroundContext(next,'next','游泳',null,signal());
  await assert.rejects(()=>queue.appendForegroundAssistant(next,replyMessage(next),context,'next',cancelled.signal),/switched/);
  const rejected=Promise.all([assert.rejects(active),assert.rejects(queued)]); await queue.close(); await rejected;
  release.resolve({...none(input),changes:[change({type:'add',id:'late',text:'种花',sourceIds:['first']},'late',first)]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1); assert.equal(store.inspect(first,'late'),null); assert.equal(store.inspect(next,replyMessage(next).id),null);
  assert.deepEqual(failures,[]);
  await assert.rejects(()=>queue.foregroundContext(next,'next','游泳',null,signal()));
  receipts.push({case:'shutdown',providerFixtureCalls:calls,lateMemoryAbsent:true,lateAssistantAbsent:true,failureCount:failures.length});
});
