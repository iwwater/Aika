import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { SummaryInput, SummaryProposal } from '../../contracts/memory-lifecycle.js';
import { fixture, scope, message, NOW, change } from './sqlite-fixture.js';
import { lifecycle, summaryProposal, forget, signal, deferred } from './lifecycle-fixture.js';

test('summary threshold, bounded input and restart coverage avoid duplicate generation',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();let calls=0;let input!:SummaryInput;
  const summarize=async(value:SummaryInput)=>{calls++;input=value;return summaryProposal(value);};
  let port=lifecycle(store,undefined,summarize);
  store.append(scope(),[message('a','今天练琴了')]);assert.equal((await port.summarizePending(scope(),signal())).status,'unchanged');assert.equal(calls,0);
  store.append(scope(),[message('b','练琴让我放松')]);const result=await port.summarizePending(scope(),signal());assert.equal(result.status,'applied');assert.equal(calls,1);
  assert.deepEqual(input.sources.map(source=>source.id),['a','b']);assert.ok(input.sources.every(source=>source.scope.characterId==='companion'));
  const record=store.inspect(scope(),result.summaryId!)!;assert.deepEqual(record.sources.map(source=>source.id),['a','b']);
  assert.equal((await port.summarizePending(scope(),signal())).status,'unchanged');assert.equal(calls,1);
  store.close();store=f.open();port=lifecycle(store,undefined,summarize);assert.equal((await port.summarizePending(scope(),signal())).status,'unchanged');assert.equal(calls,1);
});

test('summary selection obeys count/budget bounds without trimming source text or crossing roles',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();for(const id of ['a','b','c','d'])store.append(scope(),[message(id,`事实${id}`)]);
  assert.throws(()=>store.append(scope('sweetheart'),[message('other','旧角色内容','sweetheart')]),/unknown_character/);let input!:SummaryInput;
  const port=lifecycle(store,undefined,undefined,{summary:{provider:{summarize:async value=>{input=value;return summaryProposal(value);}},minMessages:2,maxMessages:3,inputTokenBudget:2,countTokens:value=>value.sources.length}});
  assert.equal((await port.summarizePending(scope(),signal())).status,'applied');assert.equal(input.sources.length,2);assert.deepEqual(input.sources.map(source=>source.text),['事实a','事实b']);
  assert.ok(input.sources.every(source=>source.scope.characterId==='companion'));
});

test('summary cannot publish a subset, duplicate, wrong role or stale version of its full input',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('a','今天练琴了'),message('b','准备周末登山')]);
  const invalid = [
    (input:SummaryInput)=>({...summaryProposal(input),sourceVersions:[{id:'a',version:1}]}),
    (input:SummaryInput)=>({...summaryProposal(input),sourceVersions:[{id:'a',version:1},{id:'a',version:1}]}),
    (input:SummaryInput)=>({...summaryProposal(input),sourceVersions:[{id:'a',version:2},{id:'b',version:1}]}),
    (input:SummaryInput)=>({...summaryProposal(input),scope:scope('sweetheart')}),
  ];
  for(const proposal of invalid){const port=lifecycle(store,undefined,async input=>proposal(input));assert.equal((await port.summarizePending(scope(),signal())).status,'rejected');}
  assert.deepEqual(store.visible(scope(),'summary'),[]);
});

test('summary model wait holds no write transaction; duplicate concurrent coverage commits once',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('a','今天练琴了'),message('b','准备周末登山')]);const second=f.open();
  const delayed=deferred<SummaryProposal>();let input!:SummaryInput;const slow=lifecycle(store,undefined,async value=>{input=value;return delayed.promise;});
  const pending=slow.summarizePending(scope(),signal());assert.throws(()=>second.append(scope('sweetheart'),[message('other','旧角色内容','sweetheart')]),/unknown_character/);
  assert.equal((await lifecycle(second).summarizePending(scope(),signal())).status,'applied');delayed.resolve(summaryProposal(input));
  assert.equal((await pending).status,'unchanged');assert.equal(store.visible(scope(),'summary').length,1);
});

test('forgetting during summary generation rejects late output and it cannot restore forgotten raw',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('a','今天练琴了'),message('b','准备周末登山')]);
  const delayed=deferred<SummaryProposal>();let input!:SummaryInput;const port=lifecycle(store,async value=>forget(value,['a']),async value=>{input=value;return delayed.promise;});
  const pending=port.summarizePending(scope(),signal());store.append(scope(),[message('request','请忘记练琴')]);
  assert.equal((await port.prepareTurn(scope(),'request','请忘记练琴',signal())).status,'applied');
  delayed.resolve(summaryProposal(input));assert.equal((await pending).status,'rejected');assert.deepEqual(store.visible(scope(),'summary'),[]);
});

test('normal transcript expiry retains an effective summary; explicit correction/forgetting invalidates it',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();store.append(scope(),[message('a','周三练琴'),message('b','准备周末登山')]);
  store.apply(change({type:'add',id:'guitar',text:'周三练琴',sourceIds:['a']},'add'));
  const original=await lifecycle(store).summarizePending(scope(),signal());assert.equal(original.status,'applied');store.close();
  f.setTime('2026-10-06T12:00:00Z');store=f.open();assert.deepEqual(store.visible(scope(),'transcript'),[]);assert.equal(store.inspect(scope(),original.summaryId!)!.state,'active');
  store.append(scope(),[message('request','周三练琴取消了','companion','2026-10-06T12:00:00Z')]);
  const port=lifecycle(store,async input=>({scope:input.scope,request:'correction',changes:[change({type:'update',id:'guitar',expectedVersion:1,text:'周三不再练琴',sourceIds:['request']},'correction')],suppressSources:[{id:original.summaryId!,version:1}],reason:'fact changed',clarification:null}));
  assert.equal((await port.prepareTurn(scope(),'request','周三练琴取消了',signal())).status,'applied');assert.equal(store.inspect(scope(),original.summaryId!)!.state,'invalidated');assert.equal(store.inspect(scope(),original.summaryId!)!.text,'');
});

test('native coverage write failure rolls back both summary record and partial coverage',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('a','今天练琴了'),message('b','准备周末登山')]);
  const db=new Database(f.filename);t.after(()=>db.close());db.exec("CREATE TRIGGER fail_coverage BEFORE INSERT ON summary_coverage WHEN new.source_id='b' BEGIN SELECT RAISE(ABORT,'coverage_write_failure'); END");
  await assert.rejects(()=>lifecycle(store).summarizePending(scope(),signal()),/coverage_write_failure/);
  assert.deepEqual(store.visible(scope(),'summary'),[]);assert.equal((db.prepare('SELECT count(*) n FROM summary_coverage').get() as {n:number}).n,0);
});

test('summary budget failure and cancellation make no persistent proposal',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('a','今天练琴了'),message('b','准备周末登山')]);let calls=0;
  const tooSmall=lifecycle(store,undefined,undefined,{summary:{provider:{summarize:async input=>{calls++;return summaryProposal(input);}},minMessages:2,maxMessages:2,inputTokenBudget:1,countTokens:input=>input.sources.length}});
  assert.equal((await tooSmall.summarizePending(scope(),signal())).status,'rejected');assert.equal(calls,0);
  const delayed=deferred<SummaryProposal>();let input!:SummaryInput;const slow=lifecycle(store,undefined,async value=>{input=value;return delayed.promise;});const controller=new AbortController();
  const pending=slow.summarizePending(scope(),controller.signal);controller.abort(new Error('summary-cancel'));
  await assert.rejects(pending,/summary-cancel/);delayed.resolve(summaryProposal(input));await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(store.visible(scope(),'summary'),[]);
});

test('summary ancestor group exceeding raw count is rejected before model without dropping unseen text',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('a','那次面试失败了'),message('b','那次面试让我失望')]);
  const generated=await lifecycle(store).summarizePending(scope(),signal());store.append(scope(),[message('request','请忘记摘要里的面试经历')]);let calls=0;
  const port=lifecycle(store,async input=>{calls++;return forget(input,[generated.summaryId!]);},undefined,{context:{inputTokenBudget:10000,maxRecentMessages:1,maxMemories:0,summaryLimit:2,countTokens:()=>1,relevance:()=>1}});
  const outcome=await port.prepareTurn(scope(),'request','请忘记摘要里的面试经历',signal());
  assert.equal(outcome.rejectionCode,'turn_source_group_exceeds_budget');assert.equal(calls,0);
  assert.equal(store.inspect(scope(),'a')!.state,'active');assert.equal(store.inspect(scope(),generated.summaryId!)!.state,'active');
});

test('explicit summary plus its raw ancestor is a valid plan, not a duplicate inferred suppression',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('a','面试失败了'),message('b','面试让我失望')]);
  const generated=await lifecycle(store).summarizePending(scope(),signal());store.append(scope(),[message('request','忘记那次面试')]);
  const port=lifecycle(store,async input=>forget(input,[generated.summaryId!,'a']));
  assert.equal((await port.prepareTurn(scope(),'request','忘记那次面试',signal())).status,'applied');assert.deepEqual(store.visible(scope(),'transcript'),[]);
});
