import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { SqliteMemoryStore } from '../../memory/sqlite-store.js';
import { fixture, scope, seed, message, change, NOW } from './sqlite-fixture.js';

const storeModule = new URL('../../memory/sqlite-store.js', import.meta.url).href;

test('A09/A10: role content, prompts and actual FTS recall survive close/reopen and independent Mac process', t => {
  const f=fixture();t.after(f.cleanup);let store=f.open();seed(store);
  store.setPrompt(scope(),'朋友专属Prompt');
  store.apply(change({type:'update',id:'job',expectedVersion:1,text:'朋友在山川公司工作',sourceIds:['raw']},'update'));
  store.close();store=f.open();
  assert.equal(store.search(scope(),'山川公司',10).length,1);
  assert.throws(()=>store.search(scope('sweetheart'),'山川公司',10),/unknown_character/);
  assert.throws(()=>store.search(scope('sweetheart'),'海风公司',10),/unknown_character/);
  assert.equal(store.prompt(scope()),'朋友专属Prompt');
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {SqliteMemoryStore} from ${JSON.stringify(storeModule)};
    const store=new SqliteMemoryStore(JSON.parse(process.argv[1]));
    const scope=characterId=>({characterId,sessionId:'s2',turnId:'t2',generation:1});
    console.log(JSON.stringify({companion:store.search(scope('companion'),'山川公司',10),prompt:store.prompt(scope('companion'))}));store.close();`,JSON.stringify({...f.options,clock:undefined})],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const read=JSON.parse(child.stdout);
  assert.equal(read.companion[0].text,'朋友在山川公司工作');assert.equal(read.prompt,'朋友专属Prompt');
  t.diagnostic(`reopened=true independent_process_exit=${child.status} role_leak=false`);
});

test('A12: deletion clears real search, summaries, caches and source retrieval across connections and restart',t=>{
  const f=fixture();t.after(f.cleanup);const a=f.open();seed(a);const b=f.open();
  a.recordDerived(scope(),{id:'summary',kind:'summary',text:'海风公司',sourceIds:['job'],createdAt:NOW});
  a.recordDerived(scope(),{id:'cache',kind:'context_cache',text:'海风公司',sourceIds:['summary'],createdAt:NOW});
  const revision=b.revision(scope());
  const deletion=change({type:'soft_delete',id:'job',expectedVersion:1},'forget');
  assert.equal(a.apply(deletion,['raw']).status,'applied');
  assert.deepEqual(b.search(scope(),'海风公司',10),[]);
  assert.deepEqual(b.visible(scope(),'summary'),[]);assert.deepEqual(b.visible(scope(),'transcript'),[]);
  assert.equal(b.inspect(scope(),'cache')!.text,'');
  assert.throws(()=>b.assertContextCurrent(scope(),revision),/stale_context/);
  a.close();b.close();const c=f.open();assert.deepEqual(c.search(scope(),'海风公司',10),[]);
  assert.equal(c.inspect(scope(),'job')!.state,'deleted');
  assert.equal(c.apply(deletion,['raw']).status,'applied'); // durable idempotent retry
  assert.equal(c.inspect(scope(),'job')!.version,2);
});

test('SQLite rollback prevents partial merge/FTS changes when a native write fails',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);
  store.apply(change({type:'add',id:'second',text:'海风公司工作',sourceIds:['raw']},'second'));
  const db=new Database(f.filename);t.after(()=>db.close());
  db.exec("CREATE TRIGGER test_failure BEFORE INSERT ON memory_records WHEN new.id='boom' BEGIN SELECT RAISE(ABORT,'injected_native_failure'); END");
  assert.throws(()=>store.apply(change({type:'merge',targets:[{id:'job',expectedVersion:1},{id:'second',expectedVersion:1}],replacement:{id:'boom',text:'merged',sourceIds:['job','second']}},'merge')),/injected_native_failure/);
  assert.equal(store.inspect(scope(),'job')!.state,'active');assert.equal(store.inspect(scope(),'second')!.state,'active');
  assert.equal(store.search(scope(),'海风公司',10).length,2);
  assert.equal((db.prepare("SELECT count(*) n FROM memory_operations WHERE operation_id='merge'").get() as {n:number}).n,0);
});

test('expectedVersion and operation signatures remain authoritative across two connections',t=>{
  const f=fixture();t.after(f.cleanup);const a=f.open();seed(a);const b=f.open();
  const one=change({type:'update',id:'job',expectedVersion:1,text:'新版事实',sourceIds:['raw']},'update');
  assert.equal(a.apply(one).status,'applied');assert.equal(b.apply(one).status,'applied');
  assert.equal(b.apply(change({type:'update',id:'job',expectedVersion:1,text:'迟到旧事实',sourceIds:['raw']},'old')).status,'conflict');
  assert.equal(b.apply({...one,operation:{...one.operation,type:'add',id:'intruder',text:'wrong',sourceIds:['raw']}}).reason,'operation_id_payload_mismatch');
  assert.equal(a.inspect(scope(),'job')!.text,'新版事实');
});

test('A10: persistent background scope and deletion epoch reject late write after session change and reopen',t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();seed(store);
  const data=store.contextRecords(scope(),'工作',10,10,10);
  const task=store.prepareMaintenance({scope:scope(),messages:data.recent,relevantMemories:data.memories});
  store.apply(change({type:'soft_delete',id:'job',expectedVersion:1},'forget'),['raw']);store.close();store=f.open();
  assert.equal(store.pendingTasks(scope())[0]!.scope.characterId,'companion');
  assert.equal(store.finishMaintenance(task,[change({type:'add',id:'late',text:'海风公司',sourceIds:['raw']},'late')])[0]!.reason,'stale_maintenance_epoch');
  assert.equal(store.inspect(scope(),'late'),null);assert.throws(()=>store.search(scope('sweetheart'),'海风公司',10),/unknown_character/);
});

test('task metadata stores source IDs without an unmetered duplicate of transcript payload',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);
  const data=store.contextRecords(scope(),'工作',10,10,10);store.prepareMaintenance({scope:scope(),messages:data.recent,relevantMemories:data.memories});
  const db=new Database(f.filename);t.after(()=>db.close());
  const tasks=db.prepare('SELECT * FROM maintenance_tasks').all();assert.ok(!JSON.stringify(tasks).includes('海风公司'));
  assert.equal(store.transcriptBytes(),Buffer.byteLength('我在海风公司工作','utf8'));
});

test('A13: global UTF-8 quota evicts oldest across sessions and does not include long memory size',t=>{
  const f=fixture(10);t.after(f.cleanup);const store=f.open();
  store.append(scope(),[message('a','中文')]); // six bytes
  store.apply(change({type:'add',id:'m',text:'长期内容'.repeat(100),sourceIds:['a']},'add'));
  store.append(scope('companion'),[message('b','abcd','companion','2026-09-06T12:00:01Z')]);
  assert.equal(store.transcriptBytes(),10);
  store.append(scope('companion'),[message('c','🙂','companion','2026-09-06T12:00:02Z')]);
  assert.equal(store.transcriptBytes(),8);assert.equal(store.inspect(scope(),'a')!.state,'expired');
  assert.equal(store.search(scope(),'长期内容',10).length,1);
});

test('A13/A14: startup age cleanup is independent of memory lifetime, and restore never restores expired raw',t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();seed(store);
  store.recordDerived(scope(),{id:'s',kind:'summary',text:'工作摘要',sourceIds:['job'],createdAt:NOW});store.close();
  f.setTime('2026-10-06T12:00:00.000Z');store=f.open();
  assert.equal(store.transcriptBytes(),0);assert.equal(store.inspect(scope(),'raw')!.message,null);
  assert.equal(store.search(scope(),'海风公司',10).length,1);assert.equal(store.visible(scope(),'summary').length,1);
  const result=store.apply(change({type:'update',id:'job',expectedVersion:1,text:'存活事实更新',sourceIds:['job']},'update-existing'));
  assert.equal(result.status,'applied');
});

test('A14: 30-day purge removes memory and derived payload from SQLite and WAL files',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);
  const marker='UNIQUE_FORGET_PAYLOAD_8e519afc';
  store.apply(change({type:'update',id:'job',expectedVersion:1,text:marker,sourceIds:['raw']},'unique'));
  store.recordDerived(scope(),{id:'s',kind:'summary',text:marker,sourceIds:['job'],createdAt:NOW});
  store.apply(change({type:'soft_delete',id:'job',expectedVersion:2},'delete'),['raw']);
  f.setTime('2026-10-06T11:59:59.999Z');assert.deepEqual(store.cleanup().purgedMemories,[]);
  f.setTime('2026-10-06T12:00:00.000Z');const result=store.cleanup();assert.ok(result.checkpointComplete);assert.equal(result.purgedMemories.length,1);
  assert.equal(store.inspect(scope(),'job')!.text,'');assert.equal(store.inspect(scope(),'job')!.state,'purged');store.close();
  assert.equal(readFileSync(f.filename).includes(Buffer.from(marker)),false);
  assert.equal(readFileSync(f.filename).includes(Buffer.from('我在海风公司工作')),false);
  t.diagnostic(`purged=${result.purgedMemories.length} checkpoint_complete=${result.checkpointComplete} raw_marker_absent=true`);
});

test('A14: restore within the persisted deletion window restores only memory, never expired original text',t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();seed(store);
  store.recordDerived(scope(),{id:'s',kind:'summary',text:'海风公司',sourceIds:['job'],createdAt:NOW});
  f.setTime('2026-09-08T12:00:00.000Z');
  store.apply(change({type:'soft_delete',id:'job',expectedVersion:1},'delete'),['raw']);store.close();
  f.setTime('2026-10-07T12:00:00.000Z');store=f.open();
  assert.deepEqual(store.search(scope(),'海风公司',10),[]);assert.equal(store.inspect(scope(),'raw')!.state,'expired');
  assert.equal(store.apply(change({type:'restore',id:'job',expectedVersion:2},'restore')).status,'applied');
  assert.equal(store.search(scope(),'海风公司',10).length,1);
  assert.deepEqual(store.visible(scope(),'transcript'),[]);assert.deepEqual(store.visible(scope(),'summary'),[]);
  assert.equal(store.inspect(scope(),'raw')!.message,null);store.close();store=f.open();
  assert.equal(store.search(scope(),'海风公司',10).length,1);assert.equal(store.transcriptBytes(),0);
});

test('opening a foreign database refuses to modify its existing tables',t=>{
  const f=fixture();t.after(f.cleanup);const db=new Database(f.filename);db.exec('CREATE TABLE unrelated(value TEXT)');db.close();
  assert.throws(()=>new SqliteMemoryStore(f.options),/foreign_database/);
  const check=new Database(f.filename);assert.ok(check.prepare("SELECT name FROM sqlite_master WHERE name='unrelated'").get());assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='characters'").get(),undefined);check.close();
});
