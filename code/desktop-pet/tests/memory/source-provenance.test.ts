import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {spawnSync} from 'node:child_process';
import type {MemoryTurnInput,MemoryTurnPlan,SourceRetention} from '../../contracts/memory-lifecycle.js';
import {fixture,scope,message,change,NOW} from './sqlite-fixture.js';
import {lifecycle,none,forget,signal,replyMessage,deferred,contextOptions} from './lifecycle-fixture.js';

function fragment(input:MemoryTurnInput,id:string,text:string,alias='f0',supportSourceIds:string[]=[]):SourceRetention {
  const source=input.sources.find(source=>source.id===id)!;
  const start=[...source.text.slice(0,source.text.indexOf(text))].length;
  return {source:{id,version:source.version},fragmentId:alias,start,end:start+[...text].length,supportSourceIds};
}
const disposition=(input:MemoryTurnInput,ids:string[])=>ids.map(id=>({id,version:input.sources.find(source=>source.id===id)!.version}));

test('actual Chinese recall/forget queries retrieve both existing duplicate cat memories after raw expiry and process restart',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();store.append(scope(),[message('raw','我的猫叫团子')]);
  for(const id of ['cat-1','cat-2'])store.apply(change({type:'add',id,text:'用户养了一只名叫团子的猫',sourceIds:['raw']},id));
  assert.throws(()=>store.append(scope('sweetheart'),[message('raw','猫叫星星','sweetheart')]),/unknown_character/);
  store.close();f.setTime('2026-10-07T12:00:00Z');store=f.open();
  for(const query of ['我那只猫叫什么名字？','忘记我养猫和猫咪名字这件事。'])assert.deepEqual(store.search(scope(),query,32,'lexical').map(m=>m.id).sort(),['cat-1','cat-2']);
  const owned={...scope('companion','restart'),sessionId:'new-session'};store.append(owned,[message('query','我那只猫叫什么名字？','companion','2026-10-07T12:00:00Z')]);let input!:MemoryTurnInput;
  const port=lifecycle(store,async value=>{input=value;return none(value);});assert.equal((await port.prepareTurn(owned,'query','我那只猫叫什么名字？',signal())).status,'unchanged');
  assert.equal(input.relevantMemories.length,2);assert.deepEqual(input.messages.map(m=>m.id),['query']);
  assert.ok(input.sources.every(source=>source.evidenceEligible===true&&Array.isArray(source.sourceVersions)));
  const context=await port.context(owned,'我那只猫叫什么名字？',null,signal());assert.equal(context.memories.length,2);assert.ok(!context.recent.some(m=>m.text.includes('团子')));
  store.close();const child=spawnSync(process.execPath,['--input-type=module','-e',`import {SqliteMemoryStore} from ${JSON.stringify(new URL('../../memory/sqlite-store.js',import.meta.url).href)};const s=new SqliteMemoryStore(JSON.parse(process.argv[1]));console.log(s.search(JSON.parse(process.argv[2]),'我那只猫叫什么名字？',32,'lexical').map(m=>m.id).sort().join(','));s.close();`,JSON.stringify({...f.options,clock:undefined}),JSON.stringify(owned)],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'cat-1,cat-2');
});

test('long/exact Chinese words outrank useful unigram and unrelated role cannot affect order',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','猫喜欢团子，还有茶')]);
  for(const [id,text] of [['long','用户喜欢猫咪'],['short','用户养猫'],['noise','用户在这里生活']])store.apply(change({type:'add',id:id!,text:text!,sourceIds:['raw']},id!));
  const before=store.search(scope(),'猫咪怎么样？',10,'lexical').map(m=>m.id);assert.deepEqual(before,['long','short']);
  assert.deepEqual(store.search(scope(),'我那这的了？',10,'lexical'),[]);assert.deepEqual(store.search(scope(),'猫咪怎么样？',10),[]);
  assert.throws(()=>store.append(scope('sweetheart'),[message('other','猫咪','sweetheart')]),/unknown_character/);
  assert.deepEqual(store.search(scope(),'猫咪怎么样？',10,'lexical').map(m=>m.id),before);
});

test('maintenance includes linked existing records despite zero lexical overlap and avoids a duplicate controlled add',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','我称呼宠物为团子')]);store.apply(change({type:'add',id:'pet',text:'猫名团子',sourceIds:['raw']},'seed'));
  store.append(scope(),[message('question','记住刚才说的事情')]);let input!:MemoryTurnInput;
  const port=lifecycle(store,async value=>{input=value;return value.relevantMemories.length?none(value):{...none(value),changes:[change({type:'add',id:'duplicate',text:'猫名团子',sourceIds:['raw']},'dup')]};});
  assert.equal((await port.prepareTurn(scope(),'question','记住刚才说的事情',signal())).status,'unchanged');assert.deepEqual(input.relevantMemories.map(m=>m.id),['pet']);assert.equal(store.visible(scope(),'memory').length,1);
});

test('shared provenance group exceeding memory limit rejects before provider and persists no partial outcome',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','养猫也养狗'),message('question','猫怎么样')]);
  for(const id of ['cat','dog'])store.apply(change({type:'add',id,text:id==='cat'?'养猫':'养狗',sourceIds:['raw']},id));let calls=0;
  const port=lifecycle(store,async input=>{calls++;return none(input);},undefined,{context:{...contextOptions,maxMemories:1}});
  const outcome=await port.prepareTurn(scope(),'question','猫怎么样',signal());assert.equal(outcome.rejectionCode,'turn_source_group_exceeds_budget');assert.equal(calls,0);assert.equal(store.lifecycle.outcome(scope(),'question','猫怎么样'),null);
});

test('two-hop shared sources bring siblings into maintenance without crossing character',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('a','种花'),message('b','养猫')]);
  store.apply(change({type:'add',id:'both',text:'喜欢花猫',sourceIds:['a','b']},'both'));store.apply(change({type:'add',id:'sibling',text:'宠物团子',sourceIds:['b']},'sibling'));
  store.append(scope(),[message('request','花')]);let input!:MemoryTurnInput;
  await lifecycle(store,async value=>{input=value;return none(value);}).prepareTurn(scope(),'request','花',signal());
  assert.deepEqual(input.relevantMemories.map(m=>m.id).sort(),['both','sibling']);assert.ok(input.sources.some(s=>s.id==='b'));
});

test('mixed LT/raw/summary/assistant preserve cat via support DAG and a second forget propagates after restart',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();const raw='面试失败了，另外我养的猫叫团子';store.append(scope(),[message('raw',raw)]);
  store.apply(change({type:'add',id:'interview',text:'面试失败了',sourceIds:['raw']},'interview'));store.apply(change({type:'add',id:'cat',text:'猫叫团子',sourceIds:['raw']},'cat'));
  store.recordDerived(scope(),{id:'summary',kind:'summary',text:'面试失败了，猫叫团子',sourceIds:['raw'],createdAt:NOW});
  const initial=lifecycle(store);await initial.prepareTurn(scope(),'raw',raw,signal());const context=await initial.context(scope(),raw,null,signal());
  await initial.appendAssistant(scope(),replyMessage(scope(),'面试失败让你难过，猫叫团子'),context,'raw',signal());
  const requestScope=scope('companion','forget-interview');store.append(requestScope,[message('request','忘记面试经历')]);
  let captured!:MemoryTurnInput;
  const port=lifecycle(store,async input=>{captured=input;return {...none(input),request:'forget',suppressSources:disposition(input,['raw','summary','turn-1:assistant','request']),retainSources:[fragment(input,'raw','我养的猫叫团子'),fragment(input,'summary','猫叫团子','f1',['f0']),fragment(input,'turn-1:assistant','猫叫团子','f2',['f1'])],changes:[change({type:'soft_delete',id:'interview',expectedVersion:1},'forget-interview',input.scope),change({type:'update',id:'cat',expectedVersion:1,text:'猫叫团子',sourceIds:['f0']},'preserve-cat',input.scope)]};});
  const result=await port.prepareTurn(requestScope,'request','忘记面试经历',signal());assert.equal(result.status,'applied',result.rejectionCode??'');
  // Approved coverage scoring can omit the cat LT on this multi-topic query. The
  // assistant must still carry the actual raw/summary evidence used in its context.
  const assistantSource=captured.sources.find(source=>source.id==='turn-1:assistant')!;
  for(const id of [...context.recent.map(item=>item.id),...context.memories.map(item=>item.id),'summary'])assert.ok(assistantSource.sourceVersions!.some(ref=>ref.id===id));
  const fragments=store.visible(scope(),'transcript').filter(r=>r.fragment);const catRoot=fragments.find(r=>r.message?.role==='user')!;
  assert.equal(catRoot.text,'我养的猫叫团子');assert.deepEqual(catRoot.sources,[]);assert.equal(catRoot.logicalOrder,store.inspect(scope(),'raw')!.logicalOrder);
  assert.equal(store.inspect(scope(),'interview')!.state,'deleted');assert.equal(store.search(scope(),'团子',10).length,1);assert.equal(store.search(scope(),'面试',10).length,0);
  assert.ok(result.affectedIds.every(id=>!/^f\d+$/.test(id)));assert.equal(store.inspect(scope(),'cat')!.sources[0]!.id,catRoot.id);
  store.close();store=f.open();const next=scope('companion','forget-cat');store.append(next,[message('next','现在忘记猫名')]);
  const again=lifecycle(store,async input=>({...forget(input,[catRoot.id]),changes:[change({type:'soft_delete',id:'cat',expectedVersion:2},'forget-cat',input.scope)]}));
  const second=await again.prepareTurn(next,'next','现在忘记猫名',signal());assert.equal(second.status,'applied',second.rejectionCode??'');
  assert.equal(store.search(next,'团子',10).length,0);assert.equal(store.visible(next,'summary').length,0);assert.ok(store.visible(next,'transcript').every(r=>!r.text.includes('团子')));
});

test('raw-only and mixed current request keep independent exact fragments, old ordering, negation and emoji',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();const raw='面试失败了；我不喜欢🍵，猫叫团子团子';const request='忘记面试经历；我周五练琴';
  store.append(scope(),[message('raw',raw),message('queued','猫的情况'),message('request',request)]);
  const port=lifecycle(store,async input=>({...none(input),request:'forget',suppressSources:disposition(input,['raw','request']),retainSources:[fragment(input,'raw','我不喜欢🍵，猫叫团子团子'),fragment(input,'request','我周五练琴','f1')]}));
  const result=await port.prepareTurn(scope(),'request',request,signal());assert.equal(result.status,'applied',result.rejectionCode??'');
  const kept=store.visible(scope(),'transcript').filter(r=>r.fragment);assert.deepEqual(kept.map(r=>r.text).sort(),['我不喜欢🍵，猫叫团子团子','我周五练琴'].sort());
  let oldInput!:MemoryTurnInput;const older=lifecycle(store,async input=>{oldInput=input;return none(input);});
  assert.equal((await older.prepareTurn(scope('companion','queued'),'queued','猫的情况',signal())).status,'unchanged');
  assert.ok(oldInput.messages.some(m=>m.text.includes('🍵')));assert.ok(!oldInput.messages.some(m=>m.text.includes('练琴')));
  assert.ok(kept.every(r=>r.createdAt===NOW));assert.equal(store.transcriptBytes(),[...store.visible(scope(),'transcript'),store.inspect(scope(),'raw')!,store.inspect(scope(),'request')!].reduce((n,r)=>n+Buffer.byteLength(r.text),0));
});

test('only-summary with naturally expired raw inherits metadata and remains correctable after restart',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();store.append(scope(),[message('raw','面试失败了，猫叫团子')]);store.recordDerived(scope(),{id:'s',kind:'summary',text:'面试失败了，猫叫团子',sourceIds:['raw'],createdAt:NOW});store.close();
  f.setTime('2026-10-07T12:00:00Z');store=f.open();store.append(scope(),[message('request','忘记面试经历','companion','2026-10-07T12:00:00Z')]);
  const port=lifecycle(store,async input=>({...none(input),request:'forget',suppressSources:disposition(input,['s','request']),retainSources:[fragment(input,'s','猫叫团子')]}));
  const outcome=await port.prepareTurn(scope(),'request','忘记面试经历',signal());assert.equal(outcome.status,'applied',outcome.rejectionCode??'');
  const kept=store.visible(scope(),'summary')[0]!;assert.equal(kept.text,'猫叫团子');assert.deepEqual(kept.sources,[{id:'raw',version:1}]);assert.equal(store.inspect(scope(),'raw')!.text,'');
  store.close();store=f.open();const next=scope('companion','second');store.append(next,[message('next','忘记猫名','companion','2026-10-07T12:00:00Z')]);
  assert.equal((await lifecycle(store,async input=>forget(input,[kept.id])).prepareTurn(next,'next','忘记猫名',signal())).status,'applied');assert.equal(store.visible(next,'summary').length,0);
});

for(const [name,mutate] of [
  ['overlap',(p:MemoryTurnPlan)=>({...p,retainSources:[...p.retainSources!,{...p.retainSources![0]!,fragmentId:'f1'}]})],
  ['negative',(p:MemoryTurnPlan)=>({...p,retainSources:[{...p.retainSources![0]!,start:-1}]})],
  ['fractional',(p:MemoryTurnPlan)=>({...p,retainSources:[{...p.retainSources![0]!,start:0.5}]})],
  ['out-of-range',(p:MemoryTurnPlan)=>({...p,retainSources:[{...p.retainSources![0]!,end:999}]})],
  ['duplicate-alias',(p:MemoryTurnPlan)=>({...p,retainSources:[...p.retainSources!,p.retainSources![0]!]})],
  ['wrong-version',(p:MemoryTurnPlan)=>({...p,retainSources:[{...p.retainSources![0]!,source:{id:'raw',version:9}}]})],
  ['copy-without-suppress',(p:MemoryTurnPlan)=>({...p,suppressSources:p.suppressSources.filter(s=>s.id!=='raw')})],
  ['user-support',(p:MemoryTurnPlan)=>({...p,retainSources:[{...p.retainSources![0]!,supportSourceIds:['request']}]})],
  ['clarification-and-retention',(p:MemoryTurnPlan)=>({...p,clarification:'指哪件事？'})],
] as const)test(`invalid fragment ${name} rejects atomically`,async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','不喜欢茶，猫叫团子'),message('request','忘记喜好')]);const before=store.revision(scope());
  const outcome=await lifecycle(store,async input=>mutate({...forget(input,['raw']),retainSources:[fragment(input,'raw','猫叫团子')]})).prepareTurn(scope(),'request','忘记喜好',signal());
  assert.equal(outcome.status,'rejected');assert.ok(outcome.rejectionCode);assert.equal(store.revision(scope()),before);assert.equal(store.visible(scope(),'transcript').length,2);
});

test('derived fragment DAG cycle, unknown support and support being suppressed are refused',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','面试失败，猫叫团子'),message('request','忘记面试')]);
  for(const id of ['s1','s2'])store.recordDerived(scope(),{id,kind:'summary',text:'面试失败，猫叫团子',sourceIds:['raw'],createdAt:NOW});
  for(const support of [['f2'],['unknown'],['raw']]){
    const result=await lifecycle(store,async input=>({...forget(input,['raw']),retainSources:[fragment(input,'s1','猫叫团子','f1',support),fragment(input,'s2','猫叫团子','f2',['f1'])]})).prepareTurn(scope(),'request','忘记面试',signal());
    assert.equal(result.status,'rejected');assert.equal(store.visible(scope(),'summary').length,2);
  }
});

test('fragment SQL failure rolls back original state, epoch, FTS, operation IDs and allocated fragments',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','面试失败，猫叫团子'),message('request','忘记面试')]);store.apply(change({type:'add',id:'cat',text:'猫叫团子',sourceIds:['raw']},'cat'));
  const db=new Database(f.filename);t.after(()=>db.close());const before=db.prepare('SELECT revision,epoch FROM characters WHERE character_id=?').get('companion');
  db.exec("CREATE TRIGGER fail_fragment BEFORE INSERT ON memory_records WHEN new.fragment_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'fragment_failure'); END");
  await assert.rejects(()=>lifecycle(store,async input=>({...forget(input,['raw']),retainSources:[fragment(input,'raw','猫叫团子')],changes:[change({type:'update',id:'cat',expectedVersion:1,text:'猫叫团子',sourceIds:['f0']},'update')]})).prepareTurn(scope(),'request','忘记面试',signal()),/fragment_failure/);
  assert.deepEqual(db.prepare('SELECT revision,epoch FROM characters WHERE character_id=?').get('companion'),before);assert.equal(store.inspect(scope(),'cat')!.version,1);assert.equal(store.search(scope(),'团子',5).length,1);assert.equal(store.inspect(scope(),'raw')!.state,'active');assert.equal(db.prepare("SELECT * FROM memory_operations WHERE operation_id='update'").get(),undefined);
});

test('fragment duplicate bytes are charged inside the transaction and do not extend raw expiry',async t=>{
  const f=fixture(36);t.after(f.cleanup);let store=f.open();store.append(scope(),[message('raw','甲甲猫猫猫'),message('request','忘记甲')]);
  const result=await lifecycle(store,async input=>({...forget(input,['raw']),retainSources:[fragment(input,'raw','猫猫猫')]})).prepareTurn(scope(),'request','忘记甲',signal());
  assert.equal(result.status,'applied');assert.equal(store.transcriptBytes(),33);assert.equal(store.inspect(scope(),'raw')!.state,'invalidated');
  store.append(scope('companion'),[message('other','乙乙','companion')]);assert.equal(store.inspect(scope(),'raw')!.state,'expired');assert.ok(store.transcriptBytes()<=36);
  store.close();f.setTime('2026-10-06T12:00:00Z');store=f.open();assert.equal(store.transcriptBytes(),0);
});

test('assistant provenance survives window eviction; forgotten content cannot re-enter summary after restart',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();const port=lifecycle(store,async input=>({...none(input),changes:[change({type:'add',id:'cat',text:'猫叫团子',sourceIds:['raw']},'add-cat')]}));store.append(scope(),[message('raw','我的猫叫团子')]);await port.prepareTurn(scope(),'raw','我的猫叫团子',signal());
  const context=await port.context(scope(),'我的猫叫团子',null,signal());const reply=replyMessage(scope(),'团子这个名字真可爱');
  await port.appendAssistant(scope(),reply,context,'raw',signal());await port.appendAssistant(scope(),reply,context,'raw',signal());
  assert.deepEqual(store.inspect(scope(),reply.id)!.sources,[{id:'raw',version:1},{id:'cat',version:1}]);
  for(let i=0;i<30;i++)store.append(scope(),[message(`filler-${i}`,'天气不错')]);
  const owned=scope('companion','forget');store.append(owned,[message('request','请忘记猫名')]);const resolver=lifecycle(store,async input=>({...forget(input,['raw']),changes:[change({type:'soft_delete',id:'cat',expectedVersion:1},'forget-cat',input.scope)]}),undefined,{context:{...contextOptions,maxRecentMessages:24}});
  assert.equal((await resolver.prepareTurn(owned,'request','请忘记猫名',signal())).status,'applied');
  const acknowledgement=await resolver.context(owned,'请忘记猫名',null,signal());await resolver.appendAssistant(owned,replyMessage(owned,'已经处理好了'),acknowledgement,'request',signal());
  assert.equal(store.inspect(owned,'forget:assistant')!.evidenceEligible,false);store.close();store=f.open();
  let seen:string[]=[];const reopened=lifecycle(store,undefined,async input=>{seen=input.sources.map(s=>s.text);return {text:seen.join(' '),scope:input.scope,sourceVersions:input.sources.map(s=>({id:s.id,version:s.version}))};});
  await reopened.summarizePending(owned,signal());assert.ok(seen.every(text=>!text.includes('团子')&&!text.includes('处理好了')));assert.ok(!store.contextRecords(owned,'团子',40,10,10).recent.some(m=>m.text.includes('团子')));
});

test('assistant context/current/scope/ID replay/cancellation protections preserve storage',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();const port=lifecycle(store);store.append(scope(),[message('custom-current-id','你好')]);await port.prepareTurn(scope(),'custom-current-id','你好',signal());const context=await port.context(scope(),'你好',null,signal());
  await assert.rejects(()=>port.append(scope(),[replyMessage(scope())]),/assistant_requires/);
  await assert.rejects(()=>port.appendAssistant(scope(),replyMessage(scope()),structuredClone(context),'custom-current-id',signal()),/identity/);
  await assert.rejects(()=>port.appendAssistant(scope(),replyMessage(scope()),context,'wrong-id',signal()),/identity/);
  await assert.rejects(()=>port.appendAssistant(scope('sweetheart'),replyMessage(scope('sweetheart')),context,'custom-current-id',signal()),/identity/);
  const aborted=new AbortController();aborted.abort();await assert.rejects(()=>port.appendAssistant(scope(),replyMessage(scope()),context,'custom-current-id',aborted.signal),/cancelled/);
  await port.appendAssistant(scope(),replyMessage(scope()),context,'custom-current-id',signal());
  await assert.rejects(()=>port.appendAssistant(scope(),replyMessage(scope(),'篡改'),context,'custom-current-id',signal()),/already_used/);
  await assert.rejects(()=>port.appendAssistant(scope(),{...replyMessage(scope()),id:'other-reply'},context,'custom-current-id',signal()),/already_used/);
  assert.equal(store.visible(scope(),'transcript').length,2);
});

test('clarification assistant is display-only even while current raw remains active',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','忘记那件事')]);const port=lifecycle(store,async input=>({...none(input),request:'forget',clarification:'指哪件事？'}));
  await port.prepareTurn(scope(),'raw','忘记那件事',signal());const context=await port.context(scope(),'忘记那件事',null,signal());await port.appendAssistant(scope(),replyMessage(scope(),'指哪件事？'),context,'raw',signal());
  assert.equal(store.inspect(scope(),'turn-1:assistant')!.evidenceEligible,false);assert.ok(!port.maintenanceInput(scope(),'').messages.some(m=>m.role==='assistant'));
});

test('new product metadata repair preserves unbound assistant payload and refuses lifecycle when derived facts depend on it',t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();store.append(scope(),[replyMessage(scope(),'猫叫团子')]);store.close();
  const db=new Database(f.filename);db.exec('DROP INDEX records_logical_order; ALTER TABLE memory_records DROP COLUMN logical_order; ALTER TABLE memory_records DROP COLUMN evidence_eligible; ALTER TABLE memory_records DROP COLUMN fragment_json');db.close();
  store=f.open();assert.equal(store.inspect(scope(),'turn-1:assistant')!.text,'猫叫团子');assert.equal(store.inspect(scope(),'turn-1:assistant')!.evidenceEligible,false);assert.equal(store.contextRecords(scope(),'团子',10,10,10).recent.length,0);assert.doesNotThrow(()=>lifecycle(store));
  store.apply(change({type:'add',id:'bad',text:'猫叫团子',sourceIds:['turn-1:assistant']},'old-path'));
  assert.throws(()=>lifecycle(store),/unbound_assistant_derivatives/);assert.equal(store.inspect(scope(),'bad')!.state,'active');assert.equal(store.inspect(scope(),'turn-1:assistant')!.text,'猫叫团子');
});

test('empty-change source omission has a stable rejectionCode and no success marker',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','猫叫糯米'),message('request','忘记我养猫和猫咪名字这件事。')]);
  for(const id of ['cat1','cat2'])store.apply(change({type:'add',id,text:'用户养了一只名叫糯米的猫。',sourceIds:['raw']},id));
  const outcome=await lifecycle(store,async input=>forget(input,['raw'])).prepareTurn(scope(),'request','忘记我养猫和猫咪名字这件事。',signal());
  assert.equal(outcome.rejectionCode,'unresolved_memory_suppression');assert.deepEqual(outcome.results,[]);assert.equal(outcome.retrievalInvalidated,false);assert.equal(store.search(scope(),'糯米',32).length,2);
});

test('current identity remains a dependency when budget omits current text from issued context',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('arbitrary-id','猫叫团子')]);
  const port=lifecycle(store,undefined,undefined,{context:{...contextOptions,inputTokenBudget:10,countTokens:context=>context.recent.length*100}});
  await port.prepareTurn(scope(),'arbitrary-id','猫叫团子',signal());const context=await port.context(scope(),'猫叫团子',null,signal());assert.equal(context.recent.length,0);
  await port.appendAssistant(scope(),replyMessage(scope(),'团子真可爱'),context,'arbitrary-id',signal());assert.deepEqual(store.inspect(scope(),'turn-1:assistant')!.sources,[{id:'arbitrary-id',version:1}]);
});

test('assistant rejects silent current text replacement even if version and epoch did not change',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('current','猫叫团子')]);
  const port=lifecycle(store,undefined,undefined,{context:{...contextOptions,inputTokenBudget:10,countTokens:context=>context.recent.length*100}});
  await port.prepareTurn(scope(),'current','猫叫团子',signal());const context=await port.context(scope(),'猫叫团子',null,signal());
  const db=new Database(f.filename);t.after(()=>db.close());db.prepare("UPDATE memory_records SET text='猫叫糯米' WHERE character_id='companion' AND id='current'").run();
  await assert.rejects(()=>port.appendAssistant(scope(),replyMessage(scope()),context,'current',signal()),/stale_assistant_current/);assert.equal(store.inspect(scope(),'turn-1:assistant'),null);
});

test('late fragment plan is rejected after source version changes; cancelled plan allocates nothing',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','面试失败，猫叫团子'),message('request','忘记面试')]);
  for(const mode of ['version','cancel'] as const){
    let input!:MemoryTurnInput;const pending=deferred<MemoryTurnPlan>();const controller=new AbortController();
    const port=lifecycle(store,async value=>{input=value;return pending.promise;});const result=port.prepareTurn(scope(),'request','忘记面试',controller.signal);
    if(mode==='version'){const db=new Database(f.filename);db.prepare("UPDATE memory_records SET version=version+1 WHERE character_id='companion' AND id='raw'").run();db.close();}else controller.abort(new Error('cancel-fragment'));
    pending.resolve({...forget(input,['raw']),retainSources:[fragment(input,'raw','猫叫团子')]});
    if(mode==='cancel')await assert.rejects(result,/cancel-fragment/);else assert.equal((await result).rejectionCode,'stale_lifecycle_source');
    assert.equal(store.visible(scope(),'transcript').filter(r=>r.fragment).length,0);assert.equal(store.inspect(scope(),'raw')!.state,'active');
  }
});

test('mixed current correction replaces old fact using retained current fragment without losing another fact',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('old','猫叫团子'),message('current','猫现在叫糯米；我不喝茶')]);store.apply(change({type:'add',id:'cat',text:'猫叫团子',sourceIds:['old']},'add'));
  const result=await lifecycle(store,async input=>({...none(input),request:'correction',suppressSources:disposition(input,['old','current']),retainSources:[fragment(input,'current','猫现在叫糯米'),fragment(input,'current','我不喝茶','f1')],changes:[change({type:'update',id:'cat',expectedVersion:1,text:'猫叫糯米',sourceIds:['f0']},'correct')]})).prepareTurn(scope(),'current','猫现在叫糯米；我不喝茶',signal());
  assert.equal(result.status,'applied',result.rejectionCode??'');assert.equal(store.search(scope(),'团子',10).length,0);assert.equal(store.search(scope(),'糯米',10).length,1);assert.ok(store.visible(scope(),'transcript').some(r=>r.text==='我不喝茶'));
});

test('only-summary no-support exception rejects hidden or missing ancestors instead of laundering provenance',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','面试失败，猫叫团子')]);store.recordDerived(scope(),{id:'s',kind:'summary',text:'面试失败，猫叫团子',sourceIds:['raw'],createdAt:NOW});store.append(scope(),[message('request','忘记面试')]);
  const db=new Database(f.filename);t.after(()=>db.close());db.prepare("UPDATE memory_records SET state='invalidated' WHERE character_id='companion' AND id='raw'").run();
  const result=await lifecycle(store,async input=>({...forget(input,['s']),retainSources:[fragment(input,'s','猫叫团子')]})).prepareTurn(scope(),'request','忘记面试',signal());
  assert.equal(result.rejectionCode,'derived_fragment_requires_support');assert.equal(store.inspect(scope(),'s')!.state,'active');
});

test('assistant SQL failure rolls back and leaves issued ticket reusable for the same response',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('current','你好')]);const port=lifecycle(store);await port.prepareTurn(scope(),'current','你好',signal());const context=await port.context(scope(),'你好',null,signal());
  const db=new Database(f.filename);t.after(()=>db.close());db.exec("CREATE TRIGGER fail_assistant BEFORE INSERT ON memory_records WHEN new.message_role='assistant' BEGIN SELECT RAISE(ABORT,'assistant_failure'); END");const before=store.revision(scope());
  await assert.rejects(()=>port.appendAssistant(scope(),replyMessage(scope()),context,'current',signal()),/assistant_failure/);assert.equal(store.revision(scope()),before);assert.equal(store.inspect(scope(),'turn-1:assistant'),null);
  db.exec('DROP TRIGGER fail_assistant');await port.appendAssistant(scope(),replyMessage(scope()),context,'current',signal());assert.equal(store.inspect(scope(),'turn-1:assistant')!.evidenceEligible,true);
});

test('memory descendant cannot be used as update evidence, and rejection leaves actual SQLite unchanged',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','猫叫团子')]);
  store.apply(change({type:'add',id:'A',text:'猫叫团子',sourceIds:['raw']},'A'));store.apply(change({type:'add',id:'B',text:'团子是猫',sourceIds:['A']},'B'));store.append(scope(),[message('request','猫的情况')]);const before=store.revision(scope());
  const result=await lifecycle(store,async input=>({...none(input),changes:[change({type:'update',id:'A',expectedVersion:1,text:'猫叫团子',sourceIds:['B']},'cycle')]})).prepareTurn(scope(),'request','猫的情况',signal());
  assert.equal(result.rejectionCode,'cyclic_source');assert.equal(store.revision(scope()),before);assert.equal(store.inspect(scope(),'A')!.version,1);assert.equal(store.inspect(scope(),'B')!.version,1);
});

test('same-batch mutually dependent memory updates reject even when old graph was acyclic',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','猫叫团子')]);
  for(const id of ['A','B'])store.apply(change({type:'add',id,text:'猫叫团子',sourceIds:['raw']},id));store.append(scope(),[message('request','猫的情况')]);
  const result=await lifecycle(store,async input=>({...none(input),changes:[change({type:'update',id:'A',expectedVersion:1,text:'猫叫团子',sourceIds:['B']},'A-update'),change({type:'update',id:'B',expectedVersion:1,text:'猫叫团子',sourceIds:['A']},'B-update')]})).prepareTurn(scope(),'request','猫的情况',signal());
  assert.equal(result.rejectionCode,'cyclic_source');assert.equal(store.inspect(scope(),'A')!.version,1);assert.equal(store.inspect(scope(),'B')!.version,1);
});

test('direct previous-version self evidence and a merge using retired targets keep established semantics',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('raw','猫叫团子')]);
  for(const id of ['A','B'])store.apply(change({type:'add',id,text:'猫叫团子',sourceIds:['raw']},id));store.append(scope(),[message('request','猫的情况')]);
  const first=await lifecycle(store,async input=>({...none(input),changes:[change({type:'update',id:'A',expectedVersion:1,text:'猫叫团子',sourceIds:['A']},'self')]})).prepareTurn(scope(),'request','猫的情况',signal());assert.equal(first.status,'applied',first.rejectionCode??'');
  store.append(scope('companion','merge'),[message('merge','猫的情况')]);
  const second=await lifecycle(store,async input=>({...none(input),changes:[change({type:'merge',targets:[{id:'A',expectedVersion:2},{id:'B',expectedVersion:1}],replacement:{id:'C',text:'猫叫团子',sourceIds:['A','B']}},'merge',input.scope)]})).prepareTurn(scope('companion','merge'),'merge','猫的情况',signal());
  assert.equal(second.status,'applied',second.rejectionCode??'');assert.equal(store.inspect(scope(),'C')!.state,'active');assert.equal(store.inspect(scope(),'A')!.state,'deleted');
});

test('twenty ordinary assistant turns do not block cat recall; a genuinely oversized later forget stays atomic and rejected',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('cat-raw','我的猫叫团子')]);store.apply(change({type:'add',id:'cat',text:'用户养了一只名叫团子的猫',sourceIds:['cat-raw']},'cat'));
  let input!:MemoryTurnInput;let deleting=false;
  const port=lifecycle(store,async value=>{input=value;return deleting?{...forget(value,['cat-raw']),changes:[change({type:'soft_delete',id:'cat',expectedVersion:1},'delete-cat',value.scope)]}:none(value);},undefined,{context:{...contextOptions,maxRecentMessages:24,maxMemories:32,summaryLimit:8}});
  for(let i=0;i<30;i++){
    const owned=scope('companion',`ordinary-${i}`),id=`u-${i}`,text='今天聊聊日常安排';store.append(owned,[message(id,text)]);
    assert.equal((await port.prepareTurn(owned,id,text,signal())).status,'unchanged');const context=await port.context(owned,text,null,signal());await port.appendAssistant(owned,replyMessage(owned,'收到，我们聊今天的安排。'),context,id,signal());
    if(i===19){
      const queryScope=scope('companion','twenty');store.append(queryScope,[message('twenty','我那只猫叫什么名字？')]);
      assert.equal((await port.prepareTurn(queryScope,'twenty','我那只猫叫什么名字？',signal())).status,'unchanged');
      assert.equal(input.relevantMemories[0]!.id,'cat');assert.ok(input.messages.length<=24);assert.equal(store.visible(queryScope,'memory').length,1);
    }
  }
  const queryScope=scope('companion','thirty');store.append(queryScope,[message('thirty','我那只猫叫什么名字？')]);
  assert.equal((await port.prepareTurn(queryScope,'thirty','我那只猫叫什么名字？',signal())).status,'unchanged');assert.equal(input.relevantMemories[0]!.id,'cat');
  deleting=true;const forgetScope=scope('companion','big-forget');store.append(forgetScope,[message('big-forget','忘记我养猫和猫咪名字这件事。')]);const before=store.revision(forgetScope);
  const outcome=await port.prepareTurn(forgetScope,'big-forget','忘记我养猫和猫咪名字这件事。',signal());assert.equal(outcome.status,'rejected');assert.equal(outcome.rejectionCode,'unresolved_source_disposition');
  assert.equal(store.revision(forgetScope),before);assert.equal(store.inspect(forgetScope,'cat')!.state,'active');assert.equal(store.inspect(forgetScope,'cat-raw')!.state,'active');assert.equal(store.lifecycle.outcome(forgetScope,'big-forget','忘记我养猫和猫咪名字这件事。'),null);
});

test('raw-only correction can retain the new current fact without forcing a long-term memory add',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();store.append(scope(),[message('old','猫叫团子'),message('current','猫现在叫糯米；我不喝茶')]);
  const result=await lifecycle(store,async input=>({...none(input),request:'correction',suppressSources:disposition(input,['old','current']),retainSources:[fragment(input,'current','猫现在叫糯米'),fragment(input,'current','我不喝茶','f1')]})).prepareTurn(scope(),'current','猫现在叫糯米；我不喝茶',signal());
  assert.equal(result.status,'applied',result.rejectionCode??'');assert.equal(store.visible(scope(),'memory').length,0);assert.deepEqual(store.visible(scope(),'transcript').map(r=>r.text).sort(),['我不喝茶','猫现在叫糯米'].sort());
});

test('already constructed lifecycle also refuses subsequently introduced unbound assistant derivatives',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();const port=lifecycle(store);
  store.append(scope(),[replyMessage(scope(),'猫叫团子')]);store.apply(change({type:'add',id:'unsafe',text:'猫叫团子',sourceIds:['turn-1:assistant']},'unsafe'));
  await assert.rejects(()=>port.context(scope(),'猫',null,signal()),/unbound_assistant_derivatives/);
  await assert.rejects(()=>port.summarizePending(scope(),signal()),/unbound_assistant_derivatives/);
  assert.equal(store.inspect(scope(),'unsafe')!.state,'active');
});
