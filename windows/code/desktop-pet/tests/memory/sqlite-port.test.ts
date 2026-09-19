import test from 'node:test';
import assert from 'node:assert/strict';
import type { MemoryMaintenanceProvider } from '../../contracts/index.js';
import { SqliteMemoryPort, type SqliteContextOptions } from '../../memory/sqlite-port.js';
import { fixture, scope, seed, message, change } from './sqlite-fixture.js';

const options:SqliteContextOptions={inputTokenBudget:4000,maxRecentMessages:8,maxMemories:4,summaryLimit:2,
 countTokens:(context,text)=>JSON.stringify(context).length+text.length,relevance:()=>1}; // synthetic tokenizer, not actual Qwen token proof

test('MemoryPort commits append before returning, retrieves lexical facts, and needs no maintenance model to read',async t=>{
 const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);const port=new SqliteMemoryPort(store,options);
 await port.append(scope(),[message('new','刚有了一个计划')]);
 const context=await port.context(scope(),'你还记得我在哪家公司工作吗？',null,new AbortController().signal);
 assert.ok(context.recent.some(item=>item.id==='new'));assert.equal(context.memories[0]!.id,'job');
 assert.equal(context.scope.characterId,'companion');
 await assert.rejects(()=>port.maintain(port.maintenanceInput(scope(),'工作'),new AbortController().signal),/not_configured/);
});

test('asynchronous maintenance holds no write transaction and remains in original role after a session change',async t=>{
 const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);const second=f.open();
 let release!:(value:Awaited<ReturnType<MemoryMaintenanceProvider['propose']>>)=>void;
 const provider:MemoryMaintenanceProvider={propose:()=>new Promise(resolve=>{release=resolve;})};
 const port=new SqliteMemoryPort(store,options,provider);const pending=port.maintain(port.maintenanceInput(scope(),'工作'),new AbortController().signal);
 // A second connection writes while the model awaits; it cannot do so if the first retained its write transaction.
 second.append(scope('companion','next'),[message('during-await','新轮次内容')]);
 release([change({type:'add',id:'late',text:'朋友后台记忆',sourceIds:['raw']},'late')]);
 assert.equal((await pending)[0]!.status,'applied');assert.throws(()=>second.inspect(scope('sweetheart'),'late'),/unknown_character/);assert.equal(second.search(scope(),'朋友后台',10).length,1);
});

test('resolved automatic deletion suppresses source re-extraction before next model input',async t=>{
 const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);
 const provider:MemoryMaintenanceProvider={propose:async()=>[change({type:'soft_delete',id:'job',expectedVersion:1},'model-delete')]};
 const port=new SqliteMemoryPort(store,options,provider);
 assert.equal((await port.maintain(port.maintenanceInput(scope(),'工作'),new AbortController().signal))[0]!.status,'applied');
 assert.deepEqual(port.maintenanceInput(scope(),'工作').messages,[]);assert.deepEqual(store.search(scope(),'海风公司',10),[]);
});

test('cancelled maintenance rejects late provider result and does not leave a pending job',async t=>{
 const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);
 let release!:(value:Awaited<ReturnType<MemoryMaintenanceProvider['propose']>>)=>void;
 const provider:MemoryMaintenanceProvider={propose:()=>new Promise(resolve=>{release=resolve;})};
 const port=new SqliteMemoryPort(store,options,provider);const controller=new AbortController();
 const pending=port.maintain(port.maintenanceInput(scope(),'工作'),controller.signal);controller.abort(new Error('stop-test'));
 await assert.rejects(pending,/stop-test/);release([change({type:'add',id:'late',text:'late',sourceIds:['raw']},'late')]);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(store.inspect(scope(),'late'),null);assert.deepEqual(store.pendingTasks(scope()),[]);
});

test('maintenance rejects a target never provided to the model, even if its ID/version was guessed',async t=>{
 const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);
 const input=store.contextRecords(scope(),'unmatched-query',8,4,2);
 const provider:MemoryMaintenanceProvider={propose:async()=>[change({type:'soft_delete',id:'job',expectedVersion:1},'guessed')]};
 const port=new SqliteMemoryPort(store,options,provider);
 const result=await port.maintain({scope:scope(),messages:input.recent,relevantMemories:[]},new AbortController().signal);
 assert.equal(result[0]!.reason,'target_not_in_task_input');assert.equal(store.search(scope(),'海风公司',10).length,1);
});
