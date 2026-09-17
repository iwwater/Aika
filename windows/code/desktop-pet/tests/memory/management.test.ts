import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { CharacterId } from '../../contracts/index.js';
import { ManagementError, type RecordEdit, type RecordQuery } from '../../contracts/management.js';
import type { MemoryTurnInput, MemoryTurnPlan } from '../../contracts/memory-lifecycle.js';
import { SqliteManagementMemoryPort } from '../../memory/management-port.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { checkedTurn, MemoryWire } from '../../providers/memory-wire.js';
import { checkRetentions } from '../../providers/memory-retention.js';
import { lifecycle, none, forget, signal, deferred, contextOptions, replyMessage } from './lifecycle-fixture.js';
import { scope, message, change, seed, NOW } from './sqlite-fixture.js';

const receipts:unknown[]=[];
after(()=>{if(process.env.W3_MANAGEMENT_RECEIPT)writeFileSync(process.env.W3_MANAGEMENT_RECEIPT,JSON.stringify({evidence:'ManagementMemoryPort + real synthetic SQLite; no HTTP/UI/model/device claim',receipts},null,2)+'\n');});
function fixture(maxBytes=CONFIRMED_RETENTION.transcriptMaxBytes) {
  const parent=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../../.local/companion-step1-01/tmp');
  mkdirSync(parent,{recursive:true});const directory=mkdtempSync(join(parent,'case-')),filename=join(directory,'pet.sqlite');
  let now=NOW;const stores:SqliteMemoryStore[]=[];const readers:Database.Database[]=[];
  return {filename,track(reader:Database.Database){readers.push(reader);},setTime(value:string){now=value;},open(){const store=new SqliteMemoryStore({filename,retention:{...CONFIRMED_RETENTION,transcriptMaxBytes:maxBytes},invitations:confirmedInvitationPolicy('Asia/Shanghai'),clock:()=>now});stores.push(store);return store;},cleanup(){for(const reader of readers)reader.close();for(const store of stores)store.close();rmSync(directory,{recursive:true,force:true});}};
}
const query=(characterId:CharacterId='companion',kind:RecordQuery['kind']='memory',text=''):RecordQuery=>({characterId,kind,query:text,state:'active',offset:0,limit:50});
const edit=(id:string,text:string,operationId='manual-1',characterId:CharacterId='companion',expectedVersion=1):RecordEdit=>({characterId,id,text,operationId,expectedVersion,reason:'用户在管理页更正'});
const errorCode=(code:ManagementError['code'])=>(error:unknown)=>error instanceof ManagementError&&error.code===code;

test('management lists the business rows with role-bound search, pagination, origin and derived editability',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);
  store.apply(change({type:'add',id:'second',text:'喜欢阅读',sourceIds:['raw']},'second'));
  for(const kind of ['summary','keyword_index','vector_index','context_cache'] as const)store.recordDerived(scope(),{id:kind,kind,text:'公司相关派生',sourceIds:['job'],createdAt:NOW});
  const api=new SqliteManagementMemoryPort(store,lifecycle(store));
  assert.equal(api.list(query()).total,2);
  const pages=[0,1].map(offset=>api.list({...query(),limit:1,offset}));
  assert.ok(pages.every(page=>page.records.length===1&&page.total===2));assert.notEqual(pages[0]!.records[0]!.id,pages[1]!.records[0]!.id);
  assert.deepEqual(api.list(query('companion','memory','阅读')).records.map(row=>row.id),['second']);
  assert.throws(()=>api.list(query('sweetheart','memory','阅读')),errorCode('invalid_request'));
  assert.deepEqual(api.characters().map(c=>c.id),['companion']);
  assert.equal(api.list(query('companion','transcript')).records[0]!.origin,'conversation');
  assert.equal(api.list(query('companion','summary')).records[0]!.editable,true);
  for(const kind of ['keyword_index','vector_index','context_cache'] as const)assert.equal(api.list(query('companion',kind)).records[0]!.editable,false);
  const before=store.revision(scope());
  for(const id of ['keyword_index','vector_index','context_cache'])assert.throws(()=>api.edit(edit(id,'不能直接改索引',id)),errorCode('invalid_request'));
  assert.equal(store.revision(scope()),before);
  assert.throws(()=>api.list({...query(),characterId:'other' as CharacterId}),errorCode('invalid_request'));
  assert.throws(()=>api.list({...query(),limit:201}),errorCode('invalid_request'));
  assert.throws(()=>api.list({...query(),offset:-1}),errorCode('invalid_request'));
  assert.throws(()=>api.edit(edit('missing','不存在')),errorCode('not_found'));
  receipts.push({case:'scoped-list',characters:api.characters(),pages,friendSearch:api.list(query('companion','memory','阅读')),legacySearch:'invalid_request'});
});

test('memory edit updates real retrieval/context, cuts old evidence and invalidates derived records, cache and held plans',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);
  const owned=scope();store.append(owned,[message('current','聊聊工作')]);
  for(const kind of ['summary','keyword_index','vector_index','context_cache'] as const)store.recordDerived(owned,{id:kind,kind,text:'在海风公司工作',sourceIds:['job'],createdAt:NOW});
  const release=deferred<MemoryTurnPlan>(),entered=deferred<MemoryTurnInput>();
  const port=lifecycle(store,async input=>{entered.resolve(input);return release.promise;}),api=new SqliteManagementMemoryPort(store,port);
  const before=await api.context('companion','工作'),oldContext=await port.context(owned,'工作',null,signal());
  const held=port.prepareBackgroundTurn(owned,'current','聊聊工作',signal()),input=await entered.promise;
  const outcome=api.edit(edit('job','现在在山川公司工作'));
  assert.equal(outcome.record.version,2);assert.equal(outcome.record.origin,'manual');assert.deepEqual(outcome.record.sources,[]);
  assert.deepEqual(store.search(owned,'海风公司',10),[]);assert.equal(store.search(owned,'山川公司',10)[0]!.id,'job');
  assert.ok(['summary','keyword_index','vector_index','context_cache'].every(id=>outcome.invalidatedIds.includes(id)));
  assert.throws(()=>port.assertContextCurrent(oldContext),/stale_context/);
  release.resolve({...none(input),changes:[change({type:'add',id:'late',text:'过时结果',sourceIds:['current']},'late')]});
  const rejected=await held;assert.equal(rejected.rejectionCode,'stale_lifecycle_epoch');assert.equal(store.inspect(owned,'late'),null);
  const context=await api.context('companion','山川公司');assert.equal(context.memories[0]!.text,'现在在山川公司工作');assert.equal(context.memories[0]!.origin,'manual');assert.equal(context.summaries.length,0);
  assert.throws(()=>store.inspect(scope('sweetheart'),'job'),/unknown_character/);
  receipts.push({case:'memory-write-through',before,outcome,after:context,oldBackground:rejected,legacyRole:'rejected'});
});

test('raw edit persists manual origin, invalidates old dependent memory and replays once without storing raw payload copies',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();seed(store);let port=lifecycle(store),api=new SqliteManagementMemoryPort(store,port);
  const request=edit('raw','用户在管理页更正：我现在在山川工作');
  const result=api.edit(request);assert.equal(store.inspect(scope(),'job')!.state,'deleted');
  const raw=store.inspect(scope(),'raw')!;assert.equal(raw.message!.origin,'manual');assert.deepEqual(raw.sources,[]);assert.equal(raw.createdAt,NOW);
  const context=await api.context('companion','工作');assert.ok(context.recent.some(row=>row.id==='raw'&&row.text===request.text&&row.origin==='manual'));
  const db=new Database(f.filename);const operation=db.prepare("SELECT signature,result_json FROM memory_operations WHERE character_id='companion' AND operation_id=?").get(request.operationId) as {signature:string;result_json:string};db.close();
  assert.ok(!JSON.stringify(operation).includes(request.text));assert.ok(!JSON.stringify(operation).includes('海风'));
  store.close();store=f.open();port=lifecycle(store);api=new SqliteManagementMemoryPort(store,port);
  assert.deepEqual(api.edit(request),result);assert.equal(store.inspect(scope(),'raw')!.version,2);
  const later=scope('companion','later');await port.append(later,[message('later','我现在在哪里工作？')]);let wire:unknown;
  const checked=lifecycle(store,async input=>{wire=new MemoryWire(checkedTurn(input)).data();return none(input);});
  assert.equal((await checked.prepareBackgroundTurn(later,'later','我现在在哪里工作？',signal())).status,'unchanged');
  assert.ok(JSON.stringify(wire).includes('manual'));
  receipts.push({case:'raw-edit-reopen',result,reopenedContext:await api.context('companion','工作'),wire,operationMetadata:JSON.parse(operation.result_json)});
});

test('manual assistant becomes labelled human evidence; exact partial retention keeps manual root while automatic derivatives do not',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open(),owned=scope();
  store.append(owned,[replyMessage(owned,'未经证明的旧助手猜测')]);
  const port=lifecycle(store),api=new SqliteManagementMemoryPort(store,port);
  assert.equal((await api.context('companion','喜好')).recent.length,0);
  api.edit(edit('turn-1:assistant','我喜欢种花，也喜欢游泳'));
  const labelled=await api.context('companion','喜好');assert.equal(labelled.recent[0]!.origin,'manual');assert.equal(labelled.recent[0]!.role,'assistant');assert.deepEqual(labelled.recent[0]!.sources,[]);
  const later=scope('companion','forget');await port.append(later,[message('forget','忘记种花')]);
  let captured!:MemoryTurnInput;
  const resolver=lifecycle(store,async input=>{
    captured=input;const known=checkedTurn(input),parent=input.sources.find(source=>source.id==='turn-1:assistant')!,start=[...parent.text].indexOf('也');
    const plan={...forget(input,[parent.id]),retainSources:[{source:{id:parent.id,version:parent.version},fragmentId:'f0',start,end:[...parent.text].length,supportSourceIds:[]}],
      changes:[change({type:'add',id:'hobby',text:'喜欢游泳',sourceIds:['f0']},'hobby',later)]};
    checkRetentions(plan.retainSources,plan.changes,known,new Set(plan.suppressSources.map(source=>source.id)));
    return plan;
  });
  const result=await resolver.prepareBackgroundTurn(later,'forget','忘记种花',signal());assert.equal(result.status,'applied');
  const fragment=store.visible(later,'transcript').find(row=>row.fragment)!;
  assert.equal(fragment.text,'也喜欢游泳');assert.equal(fragment.origin,'manual');assert.deepEqual(fragment.sources,[]);assert.equal(fragment.message!.origin,'manual');
  const memory=api.list(query()).records.find(row=>row.id==='hobby')!;assert.equal(memory.origin,'automatic');assert.ok(memory.sources.some(ref=>ref.id===fragment.id));
  const next=scope('companion','next');await port.append(next,[message('next','我还有什么喜好？')]);
  const recheck=lifecycle(store,async input=>{checkedTurn(input);return none(input);});assert.equal((await recheck.prepareBackgroundTurn(next,'next','我还有什么喜好？',signal())).status,'unchanged');
  receipts.push({case:'manual-assistant-retention',labelled,input:captured,result,fragment,derived:memory});
});

test('manual summary is budgeted with its label and preview reports exactly the actual selected context',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open(),owned=scope();seed(store);
  store.recordDerived(owned,{id:'summary',kind:'summary',text:'旧摘要',sourceIds:['raw'],createdAt:NOW});
  const options={...contextOptions,maxRecentMessages:1,inputTokenBudget:40,countTokens:(ctx:{recent:readonly unknown[];summary:string;memories:readonly {text:string}[]})=>ctx.recent.length*100+ctx.summary.length+ctx.memories.reduce((n,m)=>n+m.text.length,0)};
  const port=lifecycle(store,undefined,undefined,{context:options}),api=new SqliteManagementMemoryPort(store,port);
  api.edit(edit('summary','用户目前在山川工作','summary-edit'));api.edit(edit('job','山川工作'.repeat(20),'memory-edit'));
  const actual=await port.context(owned,'山川',null,signal()),preview=await api.context('companion','山川');
  assert.equal(actual.summary,'[人工编辑摘要] 用户目前在山川工作');assert.equal(store.inspect(owned,'summary')!.text,'用户目前在山川工作');
  assert.equal(actual.memories.length,0);assert.ok(store.search(owned,'山川',5).length>0);
  assert.deepEqual(preview.recent,[]);assert.deepEqual(preview.memories,[]);assert.deepEqual(preview.summaries.map(row=>row.id),['summary']);assert.equal(preview.summaries[0]!.origin,'manual');
  receipts.push({case:'exact-budgeted-preview',actual,preview});
});

test('automatic rewrites stop claiming manual origin, while ordinary append cannot manufacture human-edit authority',async t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);const port=lifecycle(store),api=new SqliteManagementMemoryPort(store,port);
  api.edit(edit('job','手工确认的工作'));
  const owned=scope('companion','update');await port.append(owned,[message('update','我又换到了新的工作')]);
  const resolver=lifecycle(store,async input=>{checkedTurn(input);return {...none(input),changes:[change({type:'update',id:'job',expectedVersion:2,text:'现在的新工作',sourceIds:['update']},'automatic',owned)]};});
  assert.equal((await resolver.prepareBackgroundTurn(owned,'update','我又换到了新的工作',signal())).status,'applied');
  assert.equal(store.inspect(owned,'job')!.origin,'automatic');assert.deepEqual(store.inspect(owned,'job')!.sources,[{id:'update',version:1}]);
  api.edit(edit('job','再次手工确认','manual-again','companion',3));
  assert.equal(store.apply(change({type:'update',id:'job',expectedVersion:4,text:'自动维护更新',sourceIds:['update']},'legacy-automatic',owned)).status,'applied');
  assert.equal(api.list(query()).records[0]!.origin,'automatic');
  await assert.rejects(()=>port.append(owned,[{...message('forged','伪造人工来源'),origin:'manual'}]),/manual_origin_requires_management/);
  await assert.rejects(()=>port.appendAssistant(owned,{...replyMessage(owned),origin:'manual'},{} as never,'update',signal()),/manual_origin_requires_management/);
  assert.equal(store.inspect(owned,'forged'),null);
  const labelled=scope('companion','labelled');
  await port.append(labelled,[{...message('labelled-user','你好'),origin:'conversation'}]);
  await port.prepareTurn(labelled,'labelled-user','你好',signal());
  const context=await port.context(labelled,'你好',null,signal()),reply={...replyMessage(labelled),origin:'automatic' as const};
  await port.appendAssistant(labelled,reply,context,'labelled-user',signal());
  await port.appendAssistant(labelled,reply,context,'labelled-user',signal());
  assert.equal(store.inspect(labelled,'labelled-user')!.origin,'conversation');assert.equal(store.inspect(labelled,reply.id)!.origin,'automatic');
  receipts.push({case:'automatic-origin',record:store.inspect(owned,'job'),forgedAppendRejected:true});
});

test('prompt update persists with revision conflict and operation replay, invalidating same-role contexts and old tickets',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();const owned=scope();store.append(owned,[message('current','你好')]);
  let port=lifecycle(store),api=new SqliteManagementMemoryPort(store,port);const before=api.prompt('companion');
  const context=await port.context(owned,'你好',null,signal());
  const ticket=store.lifecycle.readTurn(owned,'current','你好',{...contextOptions,inputTokenBudget:20000,countTokens:input=>JSON.stringify(input).length});
  store.recordDerived(owned,{id:'cache',kind:'context_cache',text:'旧上下文',sourceIds:['current'],createdAt:NOW});
  const request={characterId:'companion' as const,expectedRevision:api.prompt('companion').revision,text:'你是一个温和但有自己判断的朋友。',operationId:'prompt-1'};
  const result=api.savePrompt(request);assert.ok(result.revision>before.revision);assert.equal(store.inspect(owned,'cache')!.state,'invalidated');assert.throws(()=>port.assertContextCurrent(context),/stale_context/);
  assert.equal(store.lifecycle.commitTurn(ticket,none(ticket.input)).rejectionCode,'stale_lifecycle_epoch');assert.throws(()=>api.prompt('sweetheart'),errorCode('invalid_request'));
  assert.throws(()=>api.savePrompt({...request,operationId:'stale',text:'旧提交'}),errorCode('version_conflict'));
  assert.deepEqual(api.savePrompt(request),result);
  store.close();store=f.open();port=lifecycle(store);api=new SqliteManagementMemoryPort(store,port);
  assert.deepEqual(api.savePrompt(request),result);assert.equal((await api.context('companion','你好')).prompt,request.text);
  receipts.push({case:'prompt-reopen',before,result,after:api.prompt('companion'),legacyPrompt:'invalid_request'});
});

test('stale versions and reused operation payloads do not write; old role operation IDs are refused',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);const api=new SqliteManagementMemoryPort(store,lifecycle(store));
  const request=edit('job','更正后的工作'),first=api.edit(request),revision=store.revision(scope());
  assert.deepEqual(api.edit(request),first);
  assert.throws(()=>api.edit({...request,text:'不同载荷'}),errorCode('version_conflict'));
  assert.throws(()=>api.edit({...request,operationId:'stale'}),errorCode('version_conflict'));
  assert.equal(store.revision(scope()),revision);assert.equal(store.inspect(scope(),'job')!.text,request.text);
  assert.throws(()=>api.edit({...request,characterId:'sweetheart',text:'旧角色写入'}),errorCode('invalid_request'));assert.equal(store.inspect(scope(),'job')!.text,request.text);
  api.edit(edit('job','又一次更正','next','companion',2));assert.throws(()=>api.edit(request),errorCode('version_conflict'));
  assert.throws(()=>api.edit(edit('job','  ','empty','companion',3)),errorCode('invalid_request'));
  assert.throws(()=>api.savePrompt({characterId:'companion',text:'x',expectedRevision:api.prompt('companion').revision,operationId:request.operationId}),errorCode('version_conflict'));
  receipts.push({case:'conflict-and-idempotence',first,legacyEdit:'invalid_request',current:api.list(query())});
});

test('prompt A-B-A does not make an obsolete operation replay current again',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open(),api=new SqliteManagementMemoryPort(store,lifecycle(store));
  const first={characterId:'companion' as const,expectedRevision:api.prompt('companion').revision,text:'Prompt A',operationId:'prompt-A'};
  api.savePrompt(first);
  api.savePrompt({characterId:'companion',expectedRevision:api.prompt('companion').revision,text:'Prompt B',operationId:'prompt-B'});
  const latest=api.savePrompt({characterId:'companion',expectedRevision:api.prompt('companion').revision,text:'Prompt A',operationId:'prompt-A-again'});
  assert.throws(()=>api.savePrompt(first),errorCode('version_conflict'));
  assert.deepEqual(api.prompt('companion'),latest);
});

test('native failure rolls back record, derivatives, FTS, revision, epoch and operation reservation',t=>{
  const f=fixture();t.after(f.cleanup);const store=f.open();seed(store);store.recordDerived(scope(),{id:'cache',kind:'context_cache',text:'cached',sourceIds:['job'],createdAt:NOW});
  const db=new Database(f.filename);f.track(db);const before=db.prepare("SELECT revision,epoch,prompt FROM characters WHERE character_id='companion'").get();
  db.exec("CREATE TRIGGER fail_manual BEFORE UPDATE ON memory_records WHEN NEW.origin='manual' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
  const api=new SqliteManagementMemoryPort(store,lifecycle(store)),request=edit('job','不能半写');
  assert.throws(()=>api.edit(request),errorCode('unavailable'));assert.deepEqual(db.prepare("SELECT revision,epoch,prompt FROM characters WHERE character_id='companion'").get(),before);
  assert.equal(store.inspect(scope(),'job')!.version,1);assert.equal(store.inspect(scope(),'cache')!.state,'active');assert.equal(store.search(scope(),'海风公司',5).length,1);
  assert.equal(db.prepare('SELECT * FROM memory_operations WHERE operation_id=?').get(request.operationId),undefined);
  db.exec('DROP TRIGGER fail_manual');assert.equal(api.edit(request).record.version,2);
  const prior=api.prompt('companion');db.exec("CREATE TRIGGER fail_prompt BEFORE INSERT ON memory_operations WHEN NEW.operation_id='prompt-fail' BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
  assert.throws(()=>api.savePrompt({characterId:'companion',expectedRevision:prior.revision,text:'不能半写Prompt',operationId:'prompt-fail'}),errorCode('unavailable'));assert.deepEqual(api.prompt('companion'),prior);
});

test('raw edits keep original expiry and byte quota, long memory remains independent, and replay cannot restore expired text',async t=>{
  const f=fixture(90);t.after(f.cleanup);let store=f.open();const port=lifecycle(store);let api=new SqliteManagementMemoryPort(store,port);
  store.append(scope(),[message('raw','短原文')]);store.apply(change({type:'add',id:'long',text:'长期事实',sourceIds:['raw']},'seed'));
  const memory=api.edit(edit('long','保留的长期事实','memory'));
  const request=edit('raw','手工原文的新正文','raw');api.edit(request);
  assert.equal(store.transcriptBytes(),Buffer.byteLength(request.text));
  const revision=store.revision(scope());assert.throws(()=>api.edit(edit('raw','过长'.repeat(100),'overflow','companion',2)),errorCode('invalid_request'));assert.equal(store.revision(scope()),revision);assert.equal(store.inspect(scope(),'raw')!.version,2);
  f.setTime('2026-10-07T12:00:00.000Z');store.close();store=f.open();api=new SqliteManagementMemoryPort(store,lifecycle(store));
  assert.equal(store.inspect(scope(),'raw')!.text,'');assert.equal(store.inspect(scope(),'raw')!.state,'expired');assert.equal(store.transcriptBytes(),0);
  assert.throws(()=>api.edit(request),errorCode('version_conflict'));assert.deepEqual(api.list(query('companion','transcript')).records,[]);
  assert.equal((await api.context('companion','长期事实')).memories[0]!.text,memory.record.text);
  const db=new Database(f.filename);const logged=db.prepare('SELECT signature,result_json FROM memory_operations').all();db.close();assert.ok(!JSON.stringify(logged).includes(request.text));
  receipts.push({case:'retention',expired:api.list({...query('companion','transcript'),state:'all'}),longMemory:api.list(query()),replay:'version_conflict',transcriptBytes:store.transcriptBytes()});
});

test('new product schema database gains nullable origin metadata without changing historical rows; preview refuses other instances and late scope/version changes',async t=>{
  const f=fixture();t.after(f.cleanup);let store=f.open();seed(store);const before=store.inspect(scope(),'raw');store.close();
  const db=new Database(f.filename);db.exec('ALTER TABLE memory_records DROP COLUMN origin');db.close();store=f.open();
  assert.deepEqual(store.inspect(scope(),'raw'),before);const port=lifecycle(store),api=new SqliteManagementMemoryPort(store,port);
  const second=f.open();assert.throws(()=>new SqliteManagementMemoryPort(second,port),errorCode('unavailable'));
  const entered=deferred<void>(),release=deferred<void>();
  const delayed=new SqliteManagementMemoryPort(store,{store,assertContextCurrent:context=>port.assertContextCurrent(context),async context(...args){const context=await port.context(...args);entered.resolve();await release.promise;return context;}});
  const pending=delayed.context('companion','工作');await entered.promise;api.edit(edit('job','新的工作'));release.resolve();await assert.rejects(pending,errorCode('version_conflict'));
  const wrong=new SqliteManagementMemoryPort(store,{store,assertContextCurrent:context=>port.assertContextCurrent(context),context:(_scope,...args)=>port.context(scope('sweetheart'),...args)});
  await assert.rejects(()=>wrong.context('companion','工作'),errorCode('unavailable'));
});
