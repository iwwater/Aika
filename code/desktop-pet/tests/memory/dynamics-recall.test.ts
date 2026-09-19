import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { DEFAULT_MEMORY_DYNAMICS_POLICY as policy } from '../../contracts/memory-dynamics.js';
import { SqliteDynamicsManagementPort } from '../../memory/dynamics-management.js';
import { fixture, scope, message, change, NOW } from './sqlite-fixture.js';
import { lifecycle, signal } from './lifecycle-fixture.js';
const setup=()=>fixture(undefined,'memory-dynamics-01');
const add=(store:ReturnType<ReturnType<typeof setup>['open']>,id:string,text:string)=>{
 store.append(scope(),[message('raw-'+id,text)]);store.apply(change({type:'add',id,text,sourceIds:['raw-'+id]},'add-'+id));
};
const snapshotQuery={characterId:'companion' as const,query:'',state:'all' as const,offset:0,limit:200};
function databaseContent(filename:string):string {
 const db=new Database(filename,{readonly:true});try {
  const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'memory_search%' ORDER BY name").all() as {name:string}[]).map(row=>row.name);
  return JSON.stringify(tables.map(name=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
 }finally{db.close();}
}
test('ordinary ranking caps at six after all candidates, leaving maintenance closure uncapped',async()=>{
 const f=setup();try{
  const store=f.open();for(let i=0;i<10;i++)add(store,'m'+i,'红茶 '+i);
  const ranked=store.recall.rank(scope(),'红茶');assert.equal(ranked.filter(r=>r.selected).length,6);assert.equal(ranked.filter(r=>r.omission==='limit').length,4);
  assert.equal(store.search(scope(),'红茶',30,'lexical').length,10);
  const port=lifecycle(store);const context=await port.context(scope(),'红茶',null,signal());assert.equal(context.memories.length,6);
  assert.equal(store.recall.traces({characterId:'companion',offset:0,limit:20}).total,0);
  store.apply(change({type:'soft_delete',id:'m0',expectedVersion:1},'del'));
  const candidate=store.recall.rank(scope(),'红茶').find(r=>r.source.id==='m0')!;assert.equal(candidate.omission,'hard_gate');assert.equal(candidate.priority,0);assert.deepEqual(candidate.matchedTerms,[]);
 }finally{f.cleanup();}
});
test('snapshot and future preview are zero-write; changed policy does not alter the settled past',()=>{
 const f=setup();try{
  const store=f.open();add(store,'m','红茶');const port=new SqliteDynamicsManagementPort(store);
  f.setTime('2026-09-13T12:00:00Z');const before=databaseContent(f.filename),revision=store.revision(scope());
  const result=port.preview({characterId:'companion',query:'红茶',evaluatedAt:'2026-10-13T12:00:00Z',expectedDataRevision:revision,expectedPolicyRevision:1,policy:{...policy,baseHalfLifeDays:60}});
  assert.equal(result.kind,'preview');assert.ok(result.after[0]!.activation>result.before[0]!.activation);
  port.snapshot(snapshotQuery);port.traces({characterId:'companion',offset:0,limit:20});assert.equal(databaseContent(f.filename),before);
  assert.throws(()=>port.preview({characterId:'companion',query:'红茶',evaluatedAt:NOW,expectedDataRevision:revision,expectedPolicyRevision:1,policy}));
  assert.throws(()=>port.savePolicy({characterId:'companion',operationId:'bad',expectedRevision:1,policy:{...policy,baseHalfLifeDays:61}}));
 }finally{f.cleanup();}
});
test('actual trace records selected sources, consumption, restart and irreversible forgetting redaction',async()=>{
 const f=setup();try{
  let store=f.open();add(store,'m','红茶');const port=lifecycle(store),owned=scope('companion','question');
  await port.append(owned,[message('question:user','红茶')]);
  const context=await port.foregroundContext(owned,'question:user','红茶',null,signal());
  let traces=store.recall.traces({characterId:'companion',offset:0,limit:20});assert.equal(traces.total,1);assert.equal(traces.records[0]!.status,'assembled');assert.equal(traces.records[0]!.candidates[0]!.selected,true);
  await port.appendAssistant(owned,{characterId:'companion',id:'answer',role:'assistant',text:'记得红茶',createdAt:NOW},context,'question:user',signal());
  assert.equal(store.recall.traces({characterId:'companion',offset:0,limit:20}).records[0]!.status,'consumed');
  store.close();store=f.open();traces=store.recall.traces({characterId:'companion',offset:0,limit:20});assert.equal(traces.records[0]!.status,'consumed');
  const result=new SqliteDynamicsManagementPort(store).forget({characterId:'companion',id:'m',expectedVersion:1,operationId:'forget',reason:'用户要求遗忘'});
  assert.equal(result.status,'applied');assert.equal(store.inspect(scope(),'raw-m')!.state,'invalidated');
  const trace=store.recall.traces({characterId:'companion',offset:0,limit:20}).records[0]!;assert.equal(trace.status,'invalidated');assert.deepEqual(trace.candidates,[]);
  const db=new Database(f.filename,{readonly:true});assert.ok(!JSON.stringify(db.prepare('SELECT * FROM memory_recall_trace').all()).includes('红茶'));db.close();
  assert.throws(()=>new SqliteDynamicsManagementPort(store).restore({characterId:'companion',id:'m',expectedVersion:2,operationId:'restore',reason:'恢复'}),/来源已失效/);
 }finally{f.cleanup();}
});
test('shared or mixed-content source requires a strict plan, with no partial deletion',()=>{
 const f=setup();try{
  const store=f.open();store.append(scope(),[message('raw','喜欢红茶，也养猫')]);
  store.apply(change({type:'add',id:'tea',text:'喜欢红茶',sourceIds:['raw']},'tea'));store.apply(change({type:'add',id:'cat',text:'养猫',sourceIds:['raw']},'cat'));
  const before=databaseContent(f.filename);
  assert.throws(()=>new SqliteDynamicsManagementPort(store).forget({characterId:'companion',id:'tea',expectedVersion:1,operationId:'forget',reason:'遗忘'}),/片段保留计划/);
  assert.equal(databaseContent(f.filename),before);assert.equal(store.inspect(scope(),'cat')!.state,'active');
 }finally{f.cleanup();}
});
test('saved policy invalidates an in-flight context, while viewing never reinforces',async()=>{
 const f=setup();try{
  const store=f.open();add(store,'m','红茶');const owned=scope('companion','q'),port=lifecycle(store);
  await port.append(owned,[message('q:user','红茶')]);const context=await port.foregroundContext(owned,'q:user','红茶',null,signal());
  const anchor=store.dynamics.state(scope(),'m');store.recall.snapshot(snapshotQuery);assert.deepEqual(store.dynamics.state(scope(),'m'),anchor);
  store.dynamics.savePolicy({characterId:'companion',operationId:'p',expectedRevision:1,policy:{...policy,baseHalfLifeDays:60}});
  assert.throws(()=>port.assertContextCurrent(context),/stale_context/);
 }finally{f.cleanup();}
});
