import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { MemoryImportConfiguration } from '../../contracts/memory-import.js';
import type { MemoryTurnInput, MemoryTurnPlan } from '../../contracts/memory-lifecycle.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { discoverHistoricalSource, MemoryImportError } from '../../memory/import-source.js';
import { SqliteMemoryImportManagement, type MemoryImportProcessor } from '../../memory/import-management.js';
import { CONFIRMED_RETENTION, SqliteMemoryStore } from '../../memory/sqlite-store.js';

const configuration:MemoryImportConfiguration={model:'synthetic-memory',endpointHost:'local.invalid',batchMessages:2,maxInputBytes:64*1024,maxOutputTokens:64,concurrency:1,timeoutMs:2_000,budgetMode:'unlimited',limitMicros:null,inputMicrosPerToken:1,outputMicrosPerToken:1,currency:'CNY',textExportFormat:'jsonl-v1'};
const noChange=(input:MemoryTurnInput):MemoryTurnPlan=>({scope:input.scope,request:'none',changes:[],suppressSources:[],retainSources:[],clarification:null,reason:'synthetic no change'});
const waitFor=async<T>(read:()=>T,accept:(value:T)=>boolean,timeout=3_000):Promise<T>=>{
  const start=Date.now();for(;;){const value=read();if(accept(value))return value;if(Date.now()-start>timeout)throw new Error('wait_timeout');await new Promise(resolve=>setTimeout(resolve,5));}
};
function temp(t:test.TestContext){const root=mkdtempSync(join(tmpdir(),'memory-import-49-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function storeAt(file:string,clock=()=>new Date('2026-09-18T12:00:00Z').toISOString()){return new SqliteMemoryStore({filename:file,retention:CONFIRMED_RETENTION,invitations:confirmedInvitationPolicy('Asia/Shanghai'),clock});}
function exportFile(root:string,rows:unknown[],name='history.jsonl'){const file=join(root,name);writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});return file;}

test('Codex discovery includes archived main tasks, filters typed injections and deduplicates inherited fork history',async t=>{
  const root=temp(t),project=join(root,'companion-project'),home=join(root,'codex'),sessions=join(home,'sessions'),archived=join(home,'archived_sessions');mkdirSync(project);mkdirSync(sessions,{recursive:true});mkdirSync(archived);
  const exact=randomUUID(),fork=randomUUID(),other=randomUUID(),subagent=randomUUID(),rollout=join(sessions,'exact.jsonl'),forkRollout=join(archived,'fork.jsonl');
  const events=[
    {type:'session_meta',payload:{id:exact,cwd:project}},
    {timestamp:'2020-01-01T01:02:03Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'真实用户原话\n<environment_context>不应导入</environment_context>'}]}},
    {timestamp:'2020-01-01T01:02:04Z',type:'response_item',payload:{type:'message',role:'assistant',phase:'analysis',content:[{type:'output_text',text:'内部推理'}]}},
    {timestamp:'2020-01-01T01:02:05Z',type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'最终答复'}]}},
    {timestamp:'2020-01-01T01:02:06Z',type:'response_item',payload:{type:'message',role:'system',content:'系统文字'}},
    {timestamp:'2020-01-01T01:02:07Z',type:'event_msg',payload:{type:'task_complete',last_agent_message:'最终答复'}},
    {timestamp:'2020-01-02T01:02:03Z',type:'response_item',item:{type:'message',role:'assistant',phase:'final',content:'旧格式最终答复'}},
    {timestamp:'2020-01-03T01:02:03Z',type:'response_item',payload:{type:'message',role:'user',metadata:{internal_chat_message_metadata_passthrough:{content_item_kinds:['user.text','system.environment']}},content:[{type:'input_text',text:'新版可见原话'},{type:'input_text',text:'环境注入不可见'}]}},
    {timestamp:'2020-01-04T01:02:03Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<codex_delegation>任务交接不可见</codex_delegation>'}]}},
  ];
  writeFileSync(rollout,events.map(row=>JSON.stringify(row)).join('\n')+'\n');
  writeFileSync(forkRollout,[
    {type:'session_meta',payload:{id:fork,cwd:project}},
    events[1],
    {timestamp:'2020-01-05T01:02:03Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'归档分支中的独立原话'}]}},
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const db=new Database(join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT,archived INT,source TEXT,thread_source TEXT,agent_path TEXT,agent_nickname TEXT)');
  const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)');
  insert.run(exact,project,rollout,1,'vscode','user',null,null);
  insert.run(fork,project,forkRollout,1,'vscode','user',null,null);
  insert.run(other,join(root,'other'),join(sessions,'other.jsonl'),0,'vscode','user',null,null);
  insert.run(subagent,project,rollout,0,'vscode','user','/root/subagent','helper');db.close();
  const snapshot=await discoverHistoricalSource({kind:'codex-project',projectName:'以前的陪伴 AI',path:project},home);
  assert.deepEqual(snapshot.messages.map(row=>[row.role,row.text,row.createdAt]),[
    ['user','真实用户原话','2020-01-01T01:02:03.000Z'],['assistant','最终答复','2020-01-01T01:02:05.000Z'],['assistant','旧格式最终答复','2020-01-02T01:02:03.000Z'],
    ['user','新版可见原话','2020-01-03T01:02:03.000Z'],['user','归档分支中的独立原话','2020-01-05T01:02:03.000Z'],
  ]);
  assert.equal(snapshot.fingerprint.length,64);
  await assert.rejects(discoverHistoricalSource({kind:'codex-project',projectName:'',path:project},home),(error:unknown)=>error instanceof MemoryImportError&&error.code==='ambiguous_project');
});

test('oversized visible Codex dialogue is an explicit source error',async t=>{
  const root=temp(t),project=join(root,'project'),home=join(root,'codex'),sessions=join(home,'sessions'),id=randomUUID();mkdirSync(project);mkdirSync(sessions,{recursive:true});
  const rollout=join(sessions,'oversized.jsonl');writeFileSync(rollout,[{type:'session_meta',payload:{id,cwd:project}},{timestamp:'2020-01-01T00:00:00Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(1024*1024+1)}]}}].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const db=new Database(join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT,source TEXT,thread_source TEXT,agent_path TEXT,agent_nickname TEXT)');db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id,project,rollout,'vscode','user',null,null);db.close();
  await assert.rejects(discoverHistoricalSource({kind:'codex-project',projectName:'显示名称',path:project},home),(error:unknown)=>error instanceof MemoryImportError&&error.code==='invalid_source_entry');
});

test('text export requires an explicit date, speaker and bounded text',async t=>{
  const root=temp(t),rows=[{id:'a',timestamp:'2019-02-03T04:05:06Z',speaker:'用户',text:'我喜欢红茶'},{id:'b',createdAt:'2019-02-03T04:06:06Z',role:'assistant',text:'可以试试绿茶'}],valid=exportFile(root,rows);
  const snapshot=await discoverHistoricalSource({kind:'text-export',projectName:'old-companion',path:valid},join(root,'unused'));
  assert.deepEqual(snapshot.messages.map(row=>row.role),['user','assistant']);
  const copied=join(root,'copied.jsonl');copyFileSync(valid,copied);const reformatted=join(root,'reformatted.json');writeFileSync(reformatted,JSON.stringify(rows,null,2));
  for(const path of [copied,reformatted]){const other=await discoverHistoricalSource({kind:'text-export',projectName:'任意显示名',path},join(root,'unused'));assert.deepEqual(other.messages,snapshot.messages);}
  const invalid=exportFile(root,[{speaker:'user',text:'没有日期'}],'invalid.jsonl');
  await assert.rejects(discoverHistoricalSource({kind:'text-export',projectName:'old-companion',path:invalid},join(root,'unused')),(error:unknown)=>error instanceof MemoryImportError&&error.code==='invalid_source_entry');
});

test('historical import is newest-first, restart-deduplicated and never enters recent or 30-day cleanup',async t=>{
  const root=temp(t),source=exportFile(root,[
    {id:'u1',timestamp:'2020-01-01T00:00:00Z',speaker:'user',text:'我以前喜欢红茶。'},
    {id:'a1',timestamp:'2020-01-01T00:01:00Z',speaker:'assistant',text:'你可以继续喝红茶。'},
    {id:'u2',timestamp:'2021-02-02T00:00:00Z',speaker:'user',text:'纠正一下，我现在喜欢绿茶。'},
  ]),pet=join(root,'companion.sqlite'),jobs=join(root,'memory-import.sqlite');let store=storeAt(pet),calls=0;
  const processor:MemoryImportProcessor={plan:async(input,_signal,settle)=>{
    calls++;settle(100);
    const assistant=input.sources.find(item=>item.messageRole==='assistant');if(assistant)assert.equal(assistant.evidenceEligible,false);
    const current=input.sources.find(item=>item.id===input.currentMessageId)!;
    if(current.text.includes('绿茶'))return {scope:input.scope,request:'none',suppressSources:[],retainSources:[],clarification:null,reason:'synthetic newest fact',changes:[{scope:input.scope,operationId:`add:${input.currentMessageId}`,reason:'synthetic import',createdAt:'2026-01-01T00:00:00Z',operation:{type:'add',id:`memory:${input.currentMessageId}`,text:'用户喜欢绿茶。',sourceIds:[current.id]}}]};
    assert.ok(input.relevantMemories.some(memory=>memory.text.includes('绿茶')));return noChange(input);
  }};
  const instanceId=randomUUID();let service=new SqliteMemoryImportManagement({filename:jobs,codexHome:join(root,'codex'),instanceId,store,configuration,processor});
  assert.throws(()=>service.start({instanceId,operationId:'wrong-role',characterId:'friend',source:{kind:'text-export',projectName:'old-companion',path:source}}),/invalid_state/);
  const started=service.start({instanceId,operationId:'first',characterId:'companion',source:{kind:'text-export',projectName:'old-companion',path:source}});assert.equal(started.status,'discovering');
  const done=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===started.id)!,job=>job.status==='completed');
  assert.equal(done.discoveredMessages,3);assert.equal(done.processedMessages,3);assert.equal(done.totalBatches,2);assert.equal(done.importedMemories,1);assert.equal(done.actualCalls,2);assert.equal(done.accountedMicros,200);
  assert.equal(store.contextRecords({characterId:'companion',sessionId:'test',turnId:'test',generation:1},'绿茶',20,20,20).recent.length,0);
  const memory=store.search({characterId:'companion',sessionId:'test',turnId:'test',generation:1},'绿茶',10)[0]!;
  assert.match(memory.text,/^\[历史对话 2021-02-02\]/);assert.equal(store.inspect({characterId:'companion',sessionId:'test',turnId:'test',generation:1},memory.sourceIds[0]!)!.createdAt,'2021-02-02T00:00:00.000Z');
  store.cleanup();assert.equal(store.inspect({characterId:'companion',sessionId:'test',turnId:'test',generation:1},memory.sourceIds[0]!)!.state,'active');
  const summary=store.lifecycle.readSummary({characterId:'companion',sessionId:'summary',turnId:'summary',generation:1},{minMessages:1,maxMessages:20,inputTokenBudget:100000,countTokens:()=>1});assert.equal('status' in summary&&summary.status,'unchanged');
  const rerun=service.start({instanceId,operationId:'rerun',characterId:'companion',source:{kind:'text-export',projectName:'old-companion',path:source}});
  const deduped=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===rerun.id)!,job=>job.status==='completed');assert.equal(deduped.skippedMessages,3);assert.equal(deduped.totalBatches,0);assert.equal(calls,2);
  assert.equal(readFileSync(jobs).includes(Buffer.from('纠正一下')),false);
  await service.close();store.close();store=storeAt(pet);assert.ok(store.search({characterId:'companion',sessionId:'restart',turnId:'restart',generation:1},'绿茶',10).length>0);
  service=new SqliteMemoryImportManagement({filename:jobs,codexHome:join(root,'codex'),instanceId,store,configuration,processor});
  const afterRestart=service.start({instanceId,operationId:'restart-rerun',characterId:'companion',source:{kind:'text-export',projectName:'old-companion',path:source}});
  await waitFor(()=>service.snapshot().jobs.find(job=>job.id===afterRestart.id)!,job=>job.status==='completed');assert.equal(calls,2);
  const scope={characterId:'companion',sessionId:'forget',turnId:'forget',generation:1};
  const forgotten=store.apply({scope,operationId:'forget-imported',reason:'synthetic user forget',createdAt:'2026-09-18T12:00:00Z',operation:{type:'soft_delete',id:memory.id,expectedVersion:memory.version}},memory.sourceIds);
  assert.equal(forgotten.status,'applied');assert.equal(store.search(scope,'绿茶',10).length,0);
  const noRevive=service.start({instanceId,operationId:'no-revive',characterId:'companion',source:{kind:'text-export',projectName:'old-companion',path:source}});
  await waitFor(()=>service.snapshot().jobs.find(job=>job.id===noRevive.id)!,job=>job.status==='completed');assert.equal(store.search(scope,'绿茶',10).length,0);assert.equal(calls,2);
  await service.close();store.close();
});

test('cross-format replay stays deduplicated and cannot revive a management-forgotten fact',async t=>{
  const root=temp(t),project=join(root,'old-project'),home=join(root,'codex'),sessions=join(home,'sessions'),threadId=randomUUID(),createdAt='2020-08-01T00:00:00Z',text='我喜欢纸鸢。';mkdirSync(project);mkdirSync(sessions,{recursive:true});
  const rollout=join(sessions,'history.jsonl');writeFileSync(rollout,[{type:'session_meta',payload:{id:threadId,cwd:project}},{timestamp:createdAt,type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const registry=new Database(join(home,'state_5.sqlite'));registry.exec('CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT,source TEXT,thread_source TEXT,agent_path TEXT,agent_nickname TEXT)');registry.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(threadId,project,rollout,'vscode','user',null,null);registry.close();
  const exported=exportFile(root,[{id:'different-export-id',role:'user',createdAt,text}]),store=storeAt(join(root,'pet.sqlite')),instanceId=randomUUID();let calls=0;
  const processor:MemoryImportProcessor={plan:async input=>{calls++;const source=input.sources.find(item=>item.id===input.currentMessageId)!;return {scope:input.scope,request:'none',suppressSources:[],retainSources:[],clarification:null,reason:'synthetic cross-format fact',changes:[{scope:input.scope,operationId:`add:${source.id}`,reason:'synthetic import',createdAt:source.createdAt,operation:{type:'add',id:`memory:${source.id}`,text:'用户喜欢纸鸢。',sourceIds:[source.id]}}]};}};
  const service=new SqliteMemoryImportManagement({filename:join(root,'jobs.sqlite'),codexHome:home,instanceId,store,configuration,processor});
  const run=async(operationId:string,source:{kind:'codex-project'|'text-export';projectName:string;path:string})=>{const job=service.start({instanceId,operationId,characterId:'companion',source});return waitFor(()=>service.snapshot().jobs.find(item=>item.id===job.id)!,item=>item.status==='completed');};
  await run('codex-first',{kind:'codex-project',projectName:'旧 AI 显示名',path:project});assert.equal(calls,1);
  const scope={characterId:'companion' as const,sessionId:'management',turnId:'forget',generation:1},memory=store.search(scope,'纸鸢',10)[0]!;
  const action={characterId:'companion' as const,id:memory.id,expectedVersion:memory.version,operationId:'forget-cross-format',reason:'synthetic management forget'};
  const ticket=store.lifecycle.readManagementForget(action,{inputTokenBudget:100_000,countTokens:()=>1}),input=ticket.input;
  const outcome=store.lifecycle.commitManagementForget(ticket,{scope:input.scope,request:'forget',clarification:null,retainSources:[],reason:'synthetic management forget',changes:[{scope:input.scope,operationId:'forget-cross-format-change',reason:'synthetic management forget',createdAt:'2026-09-18T12:00:00Z',operation:{type:'soft_delete',id:memory.id,expectedVersion:memory.version}}],suppressSources:input.sources.filter(source=>source.kind!=='memory'&&source.evidenceEligible!==false).map(source=>({id:source.id,version:source.version}))});
  assert.equal(outcome.status,'applied');assert.equal(store.search(scope,'纸鸢',10).length,0);
  await run('text-second',{kind:'text-export',projectName:'重新导出',path:exported});assert.equal(calls,1);assert.equal(store.search(scope,'纸鸢',10).length,0);
  await service.close();store.close();
});

test('storage rejects historical commands and assistant suggestions as fact evidence',async t=>{
  const root=temp(t),source=exportFile(root,[
    {id:'a',timestamp:'2024-01-01T00:00:00Z',speaker:'assistant',text:'建议你搬到海边。'},
    {id:'u',timestamp:'2024-01-01T00:01:00Z',speaker:'user',text:'我听到了。'},
  ]),store=storeAt(join(root,'pet.sqlite')),instanceId=randomUUID();
  const processor:MemoryImportProcessor={plan:async(input)=>{
    const assistant=input.sources.find(item=>item.messageRole==='assistant')!;
    return {scope:input.scope,request:'none',suppressSources:[],retainSources:[],clarification:null,reason:'malicious synthetic plan',changes:[{scope:input.scope,operationId:'assistant-fact',reason:'should fail',createdAt:'2024-01-01T00:00:00Z',operation:{type:'add',id:'assistant-fact',text:'用户想搬到海边。',sourceIds:[assistant.id]}}]};
  }};
  const service=new SqliteMemoryImportManagement({filename:join(root,'jobs.sqlite'),codexHome:join(root,'codex'),instanceId,store,configuration,processor});
  const start=service.start({instanceId,operationId:'assistant-fact',characterId:'companion',source:{kind:'text-export',projectName:'old',path:source}});
  const failed=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='failed');
  assert.equal(failed.failures.at(-1)?.code,'commit_conflict');assert.equal(store.search({characterId:'companion',sessionId:'test',turnId:'test',generation:1},'海边',10).length,0);
  await service.close();store.close();
});

test('provider failure has no invented charge; failed resumes from the durable batch',async t=>{
  const root=temp(t),source=exportFile(root,[{id:'u',timestamp:'2022-01-01T00:00:00Z',speaker:'user',text:'我喜欢散步。'}]),store=storeAt(join(root,'pet.sqlite')),instanceId=randomUUID();let attempts=0;
  const processor:MemoryImportProcessor={plan:async(input,_signal,settle)=>{attempts++;if(attempts===1)throw new Error('synthetic preflight');settle(null);return noChange(input);}};
  const service=new SqliteMemoryImportManagement({filename:join(root,'jobs.sqlite'),codexHome:join(root,'codex'),instanceId,store,configuration,processor});
  const start=service.start({instanceId,operationId:'failure',characterId:'companion',source:{kind:'text-export',projectName:'old',path:source}});
  const failed=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='failed');assert.equal(failed.actualCalls,0);assert.equal(failed.unknownCostCalls,0);assert.deepEqual(failed.failures.at(-1)?.code,'provider_failed');
  service.resume({instanceId,jobId:failed.id,expectedRevision:failed.revision});const done=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='completed');
  assert.equal(done.actualCalls,1);assert.equal(done.unknownCostCalls,1);assert.equal(attempts,2);await service.close();store.close();
});

test('provider timeout fails the batch even when the adapter ignores abort',async t=>{
  const root=temp(t),source=exportFile(root,[{id:'u',timestamp:'2022-01-01T00:00:00Z',speaker:'user',text:'超时测试。'}]),store=storeAt(join(root,'pet.sqlite')),instanceId=randomUUID();
  const processor:MemoryImportProcessor={plan:async()=>new Promise<MemoryTurnPlan>(()=>{})};
  const service=new SqliteMemoryImportManagement({filename:join(root,'jobs.sqlite'),codexHome:join(root,'codex'),instanceId,store,configuration:{...configuration,timeoutMs:25},processor});
  const start=service.start({instanceId,operationId:'timeout',characterId:'companion',source:{kind:'text-export',projectName:'old',path:source}});
  const failed=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='failed');assert.equal(failed.failures.at(-1)?.code,'provider_timeout');assert.equal(failed.actualCalls,0);
  await service.close();store.close();
});

test('pause aborts the in-flight batch and a late provider result cannot commit',async t=>{
  const root=temp(t),rows=[{id:'u1',timestamp:'2023-01-01T00:00:00Z',speaker:'user',text:'第一条。'},{id:'u2',timestamp:'2023-01-02T00:00:00Z',speaker:'user',text:'第二条。'}],source=exportFile(root,rows),store=storeAt(join(root,'pet.sqlite')),instanceId=randomUUID();
  let release!:(plan:MemoryTurnPlan)=>void,captured!:MemoryTurnInput,calls=0;
  const processor:MemoryImportProcessor={plan:async(input)=>{calls++;captured=input;if(calls===1)return new Promise<MemoryTurnPlan>(resolve=>{release=resolve;});return noChange(input);}};
  const service=new SqliteMemoryImportManagement({filename:join(root,'jobs.sqlite'),codexHome:join(root,'codex'),instanceId,store,configuration:{...configuration,batchMessages:1},processor});
  const start=service.start({instanceId,operationId:'pause',characterId:'companion',source:{kind:'text-export',projectName:'old',path:source}});
  const running=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='running'&&calls===1);service.pause({instanceId,jobId:start.id,expectedRevision:running.revision});
  const current=captured.sources.find(item=>item.id===captured.currentMessageId)!;
  release({scope:captured.scope,request:'none',suppressSources:[],retainSources:[],clarification:null,reason:'synthetic late result',changes:[{scope:captured.scope,operationId:'late-add',reason:'must not commit',createdAt:current.createdAt,operation:{type:'add',id:'late-memory',text:'迟到结果',sourceIds:[current.id]}}]});
  const paused=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='paused'&&job.completedBatches===0);assert.equal(calls,1);
  assert.equal(store.search({characterId:'companion',sessionId:'test',turnId:'test',generation:1},'迟到结果',10).length,0);
  writeFileSync(source,rows.map(row=>JSON.stringify(row)).join('\n')+'\n'+JSON.stringify({id:'u3',timestamp:'2023-01-03T00:00:00Z',speaker:'user',text:'后来追加。'})+'\n');
  service.resume({instanceId,jobId:start.id,expectedRevision:paused.revision});const changed=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='failed');assert.equal(changed.failures.at(-1)?.code,'source_changed');assert.equal(calls,1);
  await service.close();store.close();
});

test('close aborts an ignored provider and a new runtime instance reopens the durable job paused',async t=>{
  const root=temp(t),source=exportFile(root,[{id:'u',timestamp:'2023-03-01T00:00:00Z',speaker:'user',text:'重启继续。'}]),store=storeAt(join(root,'pet.sqlite')),jobs=join(root,'jobs.sqlite');
  let calls=0;const processor:MemoryImportProcessor={plan:async input=>{calls++;if(calls===1)return new Promise<MemoryTurnPlan>(()=>{});return noChange(input);}};
  const firstId=randomUUID();let service=new SqliteMemoryImportManagement({filename:jobs,codexHome:join(root,'codex'),instanceId:firstId,store,configuration,processor});
  const start=service.start({instanceId:firstId,operationId:'restart',characterId:'companion',source:{kind:'text-export',projectName:'old',path:source}});
  await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='running'&&calls===1);await service.close();
  const secondId=randomUUID();service=new SqliteMemoryImportManagement({filename:jobs,codexHome:join(root,'codex'),instanceId:secondId,store,configuration,processor});
  const paused=service.snapshot().jobs.find(job=>job.id===start.id)!;assert.equal(paused.status,'paused');assert.equal(service.snapshot().instanceId,secondId);
  service.resume({instanceId:secondId,jobId:start.id,expectedRevision:paused.revision});const done=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='completed');
  assert.equal(done.completedBatches,1);assert.equal(calls,2);await service.close();store.close();
});

test('restart resume rejects changed model and billing configuration before another provider call',async t=>{
  const root=temp(t),source=exportFile(root,[{id:'u',timestamp:'2023-03-02T00:00:00Z',speaker:'user',text:'重启配置保护。'}]),store=storeAt(join(root,'pet.sqlite')),jobs=join(root,'jobs.sqlite');
  let calls=0;const processor:MemoryImportProcessor={plan:async()=>{calls++;return new Promise<MemoryTurnPlan>(()=>{});}};
  const firstId=randomUUID();let service=new SqliteMemoryImportManagement({filename:jobs,codexHome:join(root,'codex'),instanceId:firstId,store,configuration,processor});
  const start=service.start({instanceId:firstId,operationId:'configuration-restart',characterId:'companion',source:{kind:'text-export',projectName:'old',path:source}});
  await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='running'&&calls===1);await service.close();
  const secondId=randomUUID(),changed:MemoryImportConfiguration={...configuration,model:'synthetic-memory-v2',budgetMode:'bounded',limitMicros:10_000,inputMicrosPerToken:2};
  service=new SqliteMemoryImportManagement({filename:jobs,codexHome:join(root,'codex'),instanceId:secondId,store,configuration:changed,processor});
  const paused=service.snapshot().jobs.find(job=>job.id===start.id)!;assert.equal(paused.status,'paused');assert.deepEqual(paused.configuration,configuration);assert.deepEqual(service.snapshot().configuration,changed);
  assert.throws(()=>service.resume({instanceId:secondId,jobId:start.id,expectedRevision:paused.revision}),(error:unknown)=>error instanceof MemoryImportError&&error.code==='version_conflict');
  const unchanged=service.snapshot().jobs.find(job=>job.id===start.id)!;assert.equal(unchanged.status,'paused');assert.equal(unchanged.revision,paused.revision);assert.equal(calls,1);
  await service.close();store.close();
});

test('evidence written before a discovery planning failure remains pending and resumes exactly once',async t=>{
  const root=temp(t),source=exportFile(root,[{id:'u',timestamp:'2023-04-01T00:00:00Z',speaker:'user',text:'规划失败后继续。'}]),store=storeAt(join(root,'pet.sqlite')),instanceId=randomUUID();let counts=0,calls=0;
  const service=new SqliteMemoryImportManagement({filename:join(root,'jobs.sqlite'),codexHome:join(root,'codex'),instanceId,store,configuration,processor:{plan:async input=>{calls++;return noChange(input);}},countTokens:input=>{counts++;if(counts===1)throw new Error('synthetic planning loss');return Buffer.byteLength(JSON.stringify(input));}});
  const start=service.start({instanceId,operationId:'planning-loss',characterId:'companion',source:{kind:'text-export',projectName:'old',path:source}});
  const failed=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='failed');assert.equal(calls,0);
  service.resume({instanceId,jobId:start.id,expectedRevision:failed.revision});const done=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='completed');
  assert.equal(done.processedMessages,1);assert.equal(done.skippedMessages,0);assert.equal(calls,1);await service.close();store.close();
});

test('one multi-user batch marks every user source processed for stable cross-job deduplication',async t=>{
  const root=temp(t),source=exportFile(root,[1,2,3].map(index=>({id:`u${index}`,timestamp:`2023-05-0${index}T00:00:00Z`,speaker:'user',text:`事实${index}。`}))),store=storeAt(join(root,'pet.sqlite')),instanceId=randomUUID();let calls=0;
  const service=new SqliteMemoryImportManagement({filename:join(root,'jobs.sqlite'),codexHome:join(root,'codex'),instanceId,store,configuration:{...configuration,batchMessages:10},processor:{plan:async input=>{calls++;return noChange(input);}}});
  const first=service.start({instanceId,operationId:'multi',characterId:'companion',source:{kind:'text-export',projectName:'old',path:source}});const done=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===first.id)!,job=>job.status==='completed');assert.equal(done.totalBatches,1);assert.equal(calls,1);
  const second=service.start({instanceId,operationId:'multi-rerun',characterId:'companion',source:{kind:'text-export',projectName:'old',path:source}});const replay=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===second.id)!,job=>job.status==='completed');assert.equal(replay.totalBatches,0);assert.equal(replay.skippedMessages,3);assert.equal(calls,1);
  await service.close();store.close();
});

test('actual prompt upper bound splits batches and retains an individually oversized user item as failure',async t=>{
  const root=temp(t),source=exportFile(root,[
    {id:'u1',timestamp:'2023-06-01T00:00:00Z',speaker:'user',text:'短一。'},
    {id:'u2',timestamp:'2023-06-02T00:00:00Z',speaker:'user',text:'单条过大。'},
    {id:'u3',timestamp:'2023-06-03T00:00:00Z',speaker:'user',text:'短三。'},
  ]),store=storeAt(join(root,'pet.sqlite')),instanceId=randomUUID();let calls=0;
  const service=new SqliteMemoryImportManagement({filename:join(root,'jobs.sqlite'),codexHome:join(root,'codex'),instanceId,store,configuration:{...configuration,batchMessages:10,maxInputBytes:1200},processor:{plan:async input=>{calls++;return noChange(input);}},countTokens:input=>input.messages.some(message=>message.text.includes('单条过大'))?2000:100+700*input.messages.length});
  const start=service.start({instanceId,operationId:'dynamic',characterId:'companion',source:{kind:'text-export',projectName:'old',path:source}});
  const failed=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='failed'&&job.completedBatches===2);assert.equal(calls,2);assert.equal(failed.totalBatches,2);assert.equal(failed.processedMessages,2);assert.equal(failed.failures.at(-1)?.code,'budget_exceeded');
  await service.close();store.close();
});

test('a privacy hold created while the model waits invalidates the import ticket and leaves no late memory',async t=>{
  const root=temp(t),source=exportFile(root,[{id:'u',timestamp:'2023-07-01T00:00:00Z',speaker:'user',text:'需要保护的历史事实。'}]),store=storeAt(join(root,'pet.sqlite')),instanceId=randomUUID();let captured!:MemoryTurnInput,release!:(plan:MemoryTurnPlan)=>void;
  const service=new SqliteMemoryImportManagement({filename:join(root,'jobs.sqlite'),codexHome:join(root,'codex'),instanceId,store,configuration,processor:{plan:async input=>{captured=input;return new Promise<MemoryTurnPlan>(resolve=>{release=resolve;});}}});
  const start=service.start({instanceId,operationId:'stale-ticket',characterId:'companion',source:{kind:'text-export',projectName:'old',path:source}});await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='running'&&!!captured);
  store.pending.begin(captured.scope,captured.currentMessageId,1,'forget');const current=captured.sources.find(item=>item.id===captured.currentMessageId)!;
  release({scope:captured.scope,request:'none',suppressSources:[],retainSources:[],clarification:null,reason:'synthetic stale result',changes:[{scope:captured.scope,operationId:'stale-add',reason:'must reject',createdAt:current.createdAt,operation:{type:'add',id:'stale-memory',text:'不应写入',sourceIds:[current.id]}}]});
  const failed=await waitFor(()=>service.snapshot().jobs.find(job=>job.id===start.id)!,job=>job.status==='failed');assert.equal(failed.failures.at(-1)?.code,'commit_conflict');assert.equal(store.search({characterId:'companion',sessionId:'test',turnId:'test',generation:1},'不应写入',10).length,0);
  await service.close();store.close();
});

// Platform policy applies only to the owned import database, never to read-only sources.
test('import jobs reopen privately and reject a newly broad file grant',async t=>{
  const {isPrivateFileSync}=await import('../../core/platform-files.js');
  const {chmodSync}=await import('node:fs');
  const {execFileSync}=await import('node:child_process');
  const root=temp(t), filename=join(root,'jobs.sqlite'), store=storeAt(join(root,'companion.sqlite'));
  const options={filename,codexHome:join(root,'codex'),instanceId:'synthetic-acl',store,configuration,
    processor:{async plan(input:MemoryTurnInput){return noChange(input);}}};
  try {
    const first=new SqliteMemoryImportManagement(options);await first.close();
    assert.equal(isPrivateFileSync(filename),true);
    const reopened=new SqliteMemoryImportManagement(options);await reopened.close();
    const before=readFileSync(filename);
    if(process.platform==='win32')execFileSync('icacls.exe',[filename,'/grant','*S-1-1-0:R'],{windowsHide:true,stdio:'pipe'});
    else chmodSync(filename,0o644);
    assert.throws(()=>new SqliteMemoryImportManagement(options),/unsafe_import_database/);
    assert.deepEqual(readFileSync(filename),before);
  } finally {store.close();}
});
