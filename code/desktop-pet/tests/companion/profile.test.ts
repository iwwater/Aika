import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { fixture, scope, seed, message } from '../memory/sqlite-fixture.js';
import { lifecycle, none, signal, contextOptions } from '../memory/lifecycle-fixture.js';
import { COMPANION_INTRODUCTION } from '../../companion/introduction.js';
import { SqliteManagementMemoryPort } from '../../memory/management-port.js';

test('A09: presentation-only opening is independent of context, raw, summary, memory, operations, and maintenance input', async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();const first=store.introduction()!;
  assert.deepEqual(first,COMPANION_INTRODUCTION);(first as {text:string}).text='tampered';assert.equal(store.introduction()!.text,COMPANION_INTRODUCTION.text);
  const port=lifecycle(store),api=new SqliteManagementMemoryPort(store,port);
  const revision=store.revision(scope());assert.equal(store.transcriptBytes(),0);
  const context=await port.context(scope(),'你好',null,signal());assert.deepEqual(context.recent,[]);assert.deepEqual(context.memories,[]);assert.equal(context.summary,'');
  assert.ok(!JSON.stringify(context).includes(COMPANION_INTRODUCTION.text));assert.deepEqual(port.maintenanceInput(scope(),'失忆').messages,[]);
  assert.equal(api.list({characterId:'companion',kind:'transcript',query:'',offset:0,limit:10,state:'all'}).total,0);
  assert.throws(()=>store.acknowledgeIntroduction('invented-introduction'),/unknown_introduction/);assert.ok(store.introduction());
  store.acknowledgeIntroduction(COMPANION_INTRODUCTION.id);store.acknowledgeIntroduction(COMPANION_INTRODUCTION.id);
  assert.equal(store.introduction(),null);assert.equal(store.revision(scope()),revision);port.assertContextCurrent(context);
  const db=new Database(f.filename,{readonly:true});t.after(()=>db.close());
  for(const table of ['memory_records','memory_operations','maintenance_tasks','memory_turn_outcomes','memory_search','summary_coverage'])assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n,0,table);
});

test('A09/A10: read-before-display is repeatable, display ack survives reopen and a new process; new data persists independently',t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();const intro=store.introduction()!;store.close();store=f.open();assert.deepEqual(store.introduction(),intro);
  seed(store);store.acknowledgeIntroduction(intro.id);store.close();
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {SqliteMemoryStore} from ${JSON.stringify(new URL('../../memory/sqlite-store.js',import.meta.url).href)};
    const store=new SqliteMemoryStore(JSON.parse(process.argv[1]));
    console.log(JSON.stringify({introduction:store.introduction(),memories:store.search(JSON.parse(process.argv[2]),'海风公司',10)}));store.close();
  `,JSON.stringify(f.options),JSON.stringify(scope())],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);const restored=JSON.parse(child.stdout);assert.equal(restored.introduction,null);assert.equal(restored.memories[0].id,'job');
  store=f.open();assert.equal(store.introduction(),null);assert.equal(store.visible(scope(),'transcript').length,1);
  t.diagnostic(JSON.stringify({processExit:child.status,restored}));
});

test('presentation ack is shared by connections, idempotent, and cannot invalidate a legitimate memory ticket',t=>{
  const f=fixture();t.after(f.cleanup);const a=f.open(),b=f.open();a.append(scope(),[message('current','真实的问候')]);
  const ticket=a.lifecycle.readTurn(scope(),'current','真实的问候',{...contextOptions,countTokens:input=>JSON.stringify(input).length});
  const intro=a.introduction()!;b.acknowledgeIntroduction(intro.id);a.acknowledgeIntroduction(intro.id);
  assert.equal(a.introduction(),null);assert.equal(a.lifecycle.commitTurn(ticket,none(ticket.input)).status,'unchanged');
});
