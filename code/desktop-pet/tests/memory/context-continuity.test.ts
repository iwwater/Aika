import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, scope, message } from './sqlite-fixture.js';
import { lifecycle, signal, replyMessage } from './lifecycle-fixture.js';
import Database from 'better-sqlite3';
import { assembleContext } from '../../memory/context.js';

test('failed uncertain hold preserves later complete naming conversation while older facts stay excluded',async t=>{
 const f=fixture();t.after(f.cleanup);let store=f.open(),port=lifecycle(store);
 const old=scope('companion','old'),hold=scope('companion','hold');
 await port.append(old,[message('old:user','old private place')]);
 await port.append(hold,[message('hold:user','a pending ambiguous memory request')]);
 port.beginPendingMutation(hold,'hold:user',{request:'uncertain',sources:null});store.pending.fail(hold,'hold:user');
 const one=scope('companion','one');await port.append(one,[message('one:user','Your formal name is Mira; your nickname is Pip.')]);
 const c1=await port.foregroundContext(one,'one:user','Your formal name is Mira; your nickname is Pip.',null,signal());
 await port.appendAssistant(one,replyMessage(one,'Both names are mine.'),c1,'one:user',signal());
 assert.equal(store.inspect(one,'one:assistant')!.evidenceEligible,false);
 // No in-memory cache may be required to restore continuity after a restart.
 store.close();store=f.open();port=lifecycle(store);
 const two=scope('companion','two');await port.append(two,[message('two:user','Mira and Pip. Just those two!')]);
 const c2=await port.foregroundContext(two,'two:user','Mira and Pip. Just those two!',null,signal());
 assert.deepEqual(c2.recent.map(m=>m.id),['one:user','one:assistant','two:user']);
 assert.equal(c2.summary,'');assert.deepEqual(c2.memories,[]);assert.ok(!JSON.stringify(c2).includes('old private place'));
 assert.equal(store.pending.list('companion')[0]!.status,'failed');
 await port.appendAssistant(two,replyMessage(two,'Yes, those are my two names.'),c2,'two:user',signal());
 assert.equal(store.inspect(two,'two:assistant')!.evidenceEligible,false);
});

test('failed forget still excludes earlier content; a newer hold invalidates the already-issued protected context',async t=>{
 const f=fixture();t.after(f.cleanup);const store=f.open(),port=lifecycle(store);
 const old=scope('companion','old'),hold=scope('companion','hold'),fresh=scope('companion','fresh'),later=scope('companion','later');
 await port.append(old,[message('old:user','private old location')]);await port.append(hold,[message('hold:user','forget that location')]);
 port.beginPendingMutation(hold,'hold:user',{request:'forget',sources:null});store.pending.fail(hold,'hold:user');
 await port.append(fresh,[message('fresh:user','new harmless hobby')]);
 const context=await port.foregroundContext(fresh,'fresh:user','new harmless hobby',null,signal());
 assert.deepEqual(context.recent.map(m=>m.id),['fresh:user']);assert.ok(!JSON.stringify(context).includes('private old location'));
 await port.append(later,[message('later:user','forget the new hobby too')]);port.beginPendingMutation(later,'later:user',{request:'forget',sources:null});
 assert.throws(()=>port.assertContextCurrent(context),/stale_context/);
 const last=scope('companion','last');await port.append(last,[message('last:user','unrelated fresh question')]);
 const final=await port.foregroundContext(last,'last:user','unrelated fresh question',null,signal());
 assert.deepEqual(final.recent.map(m=>m.id),['last:user']);assert.deepEqual(final.memories,[]);
 assert.equal(store.pending.list('companion').length,2);
});

test('unchanged privacy scope may fail or complete without aborting its safe foreground response',async t=>{
 const f=fixture();t.after(f.cleanup);const store=f.open(),port=lifecycle(store),held=scope('companion','held');
 await port.append(held,[message('held:user','uncertain operation')]);port.beginPendingMutation(held,'held:user',{request:'uncertain',sources:null});
 const context=await port.foregroundContext(held,'held:user','uncertain operation',null,signal());store.pending.fail(held,'held:user');
 assert.doesNotThrow(()=>port.assertContextCurrent(context));
 store.pending.finish(held,'held:user',{scope:held,request:'none',status:'unchanged',results:[],affectedIds:[],retrievalInvalidated:false,clarification:null});
 assert.doesNotThrow(()=>port.assertContextCurrent(context));
 await port.appendAssistant(held,replyMessage(held,'Neutral response.'),context,'held:user',signal());
 assert.equal(store.inspect(held,'held:assistant')!.evidenceEligible,false);
 const next=scope('companion','next');await port.append(next,[message('next:user','normal after completion')]);
 const normal=await port.foregroundContext(next,'next:user','normal after completion',null,signal());assert.ok(normal.recent.some(m=>m.id==='held:user'));
 const hold2=scope('companion','hold2');await port.append(hold2,[message('hold2:user','another hold')]);port.beginPendingMutation(hold2,'hold2:user',{request:'uncertain',sources:null});
 assert.throws(()=>port.assertContextCurrent(normal),/stale_context/);
 const safe=await port.foregroundContext(hold2,'hold2:user','another hold',null,signal());port.cancelPendingMutation(hold2,'hold2:user');assert.doesNotThrow(()=>port.assertContextCurrent(safe));
});

test('missing or changed hold trigger never lowers the privacy boundary to zero',async t=>{
 const f=fixture();t.after(f.cleanup);const store=f.open(),port=lifecycle(store),held=scope('companion','held'),fresh=scope('companion','fresh');
 await port.append(held,[message('held:user','privacy request')]);port.beginPendingMutation(held,'held:user',{request:'forget',sources:null});
 await port.append(fresh,[message('fresh:user','new ordinary message')]);
 const db=new Database(f.filename);t.after(()=>db.close());db.prepare("UPDATE memory_pending_mutations SET current_message_id='missing' WHERE current_message_id='held:user'").run();
 assert.equal(store.pending.contextBoundary('companion').afterOrder,null);
 const context=await port.foregroundContext(fresh,'fresh:user','new ordinary message',null,signal());assert.deepEqual(context.recent,[]);assert.deepEqual(context.memories,[]);
});

test('budget pressure keeps latest complete turns ahead of recall and never backfills past an omitted latest turn',()=>{
 const owned=scope('companion','current');
 const recent=[message('old:user','old'),{...message('old:assistant','old answer'),role:'assistant' as const},message('latest:user','X'.repeat(200)),{...message('latest:assistant','latest answer'),role:'assistant' as const},message('current:user','these two')];
 const reader={characterId:'companion' as const,contextRecords:()=>({characterId:'companion' as const,revision:1,recent,summaries:[],memories:[]}),assertContextCurrent(){}};
 const options={prompts:{companion:'synthetic'},inputTokenBudget:100,maxRecentMessages:12,maxMemories:0,countTokens:(c:{recent:readonly {text:string}[]})=>c.recent.reduce((n,m)=>n+m.text.length,0),relevance:()=>1};
 const result=assembleContext(reader,owned,'these two',null,'2026-09-16T00:00:00Z',options);
 assert.deepEqual(result.context.recent.map(m=>m.id),['current:user']);assert.ok(result.omittedIds.includes('latest:user'));assert.ok(result.omittedIds.includes('latest:assistant'));assert.ok(result.omittedIds.includes('old:user'));
 const full=assembleContext(reader,owned,'these two',null,'2026-09-16T00:00:00Z',{...options,inputTokenBudget:1000,maxRecentMessages:4});
 assert.deepEqual(full.context.recent.map(m=>m.id),['latest:user','latest:assistant','current:user']);
});
