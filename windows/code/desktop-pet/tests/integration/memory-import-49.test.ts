import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoricalMemoryTransport, observedImportEndpoint, HISTORICAL_MEMORY_INSTRUCTION, historicalMemoryInputBytes } from '../../app/memory-import.js';
import { ProviderTransport, type EndpointConfig, type JsonRecord, type ProviderOperation } from '../../providers/transport.js';
import type { TurnScope } from '../../contracts/index.js';
import type { TrialModel } from '../../app/trial-config.js';
const scope = { characterId:'companion', sessionId:'import-job', turnId:'batch-1', generation:0 };
const model: TrialModel = {provider:'deepseek',model:'test-only',endpoint:'https://example.invalid/chat',credentialFile:'/no-key',inputTokenLimit:32768,outputTokenLimit:2048,inputMicrosPerToken:2,outputMicrosPerToken:8,reservationMicros:100000};
const endpoint: EndpointConfig = { endpoint:model.endpoint,model:model.model,apiKey:()=>{throw Error('must not read credentials');},authorizer:{async authorize(){throw Error('must not call real API');}} };

test('historical adapter preserves source roles/dates, confines operation and rejects oversized batch before transport', async () => {
  let calls=0,seen:JsonRecord|undefined;
  class Capture extends ProviderTransport { override async request(_c:EndpointConfig,_s:TurnScope,_op:ProviderOperation,body:JsonRecord) { calls++;seen=body;return {}; } }
  const port=new HistoricalMemoryTransport(new Capture(),{maxInputBytes:9000,maxOutputTokens:2048});
  const data=JSON.stringify({currentMessage:'anchor',evidence:[{role:'user',createdAt:'2020-01-01T00:00:00Z',text:'synthetic past preference'},{role:'assistant',createdAt:'2020-01-01T00:00:01Z',text:'synthetic suggestion',evidenceEligible:false}]});
  const body={messages:[{role:'system',content:'strict compiler protocol'},{role:'user',content:data}],stream:false};
  await port.request(endpoint,scope,'memory_turn',body,new AbortController().signal);
  assert.equal(calls,1);assert.equal(seen!.max_tokens,2048);
  const messages=seen!.messages as {content:string}[];
  assert.equal(messages[1]!.content,data);assert.ok(messages[0]!.content.endsWith(HISTORICAL_MEMORY_INSTRUCTION));
  assert.equal(body.messages[0]!.content,'strict compiler protocol');
  await assert.rejects(port.request(endpoint,scope,'dialogue',body,new AbortController().signal));
  await assert.rejects(port.request(endpoint,scope,'memory_turn',{...body,messages:[body.messages[0],{role:'user',content:'x'.repeat(10000)}]},new AbortController().signal));
  assert.equal(calls,1);
});

test('import cost observer preserves original accounting exactly once and reports unknown separately without content',async()=>{
  const events:unknown[]=[];
  const config={...endpoint,authorizer:{async authorize(){events.push('reserve');return {async settle(){events.push('settle');}};}}};
  const wrapped=observedImportEndpoint(config,model,cost=>{events.push(cost);});
  const request={scope,operation:'memory_turn' as const,model:model.model,endpoint:model.endpoint};
  const permit=await wrapped.authorizer.authorize(request,new AbortController().signal);
  await permit.settle({status:'success',usage:{prompt_tokens:100,completion_tokens:10},requestId:null});
  assert.deepEqual(events,['reserve','settle',280]);
  const second=await wrapped.authorizer.authorize(request,new AbortController().signal);
  await second.settle({status:'failed',usage:null,requestId:null});
  assert.deepEqual(events,['reserve','settle',280,'reserve','settle',null]);
});

test('historical batches still pass the real semantic compiler; assistant-only assertions cannot become facts', async () => {
  const { runMemorySemanticAttempt } = await import('../../app/memory-semantic-adapter.js');
  const sources = [
    {scope,id:'old-user',version:1,kind:'transcript' as const,messageRole:'user' as const,text:'我曾经喜欢画水彩。',createdAt:'2020-01-01T00:00:00Z',sourceVersions:[],evidenceEligible:true},
    {scope,id:'old-ai',version:1,kind:'transcript' as const,messageRole:'assistant' as const,text:'你可能想去海边。',createdAt:'2020-01-01T00:00:01Z',sourceVersions:[],evidenceEligible:false},
  ];
  const input={scope,currentMessageId:'old-user',sources,relevantMemories:[],messages:sources.map(s=>({characterId:'companion',id:s.id,role:s.messageRole,text:s.text,createdAt:s.createdAt}))};
  let useAssistant=false;
  class SemanticResponse extends ProviderTransport {
    override async request(_c:EndpointConfig,_s:TurnScope,_op:ProviderOperation,body:JsonRecord) {
      const messages=body.messages as {content:string}[];
      assert.equal(Buffer.byteLength(JSON.stringify(messages),'utf8')+2048,historicalMemoryInputBytes(input));
      const wire=JSON.parse(messages[1]!.content) as {currentMessage:{id:string;version:number;text:string};evidence:{id:string;version:number;text:string}[]};
      const source=useAssistant ? wire.evidence[0]! : wire.currentMessage;
      const evidence={source:{id:source.id,version:source.version},quote:{text:source.text,context:null}};
      return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({request:'none',erase:[],facts:[{intent:'remember',statement:useAssistant?'用户想去海边':'用户2020年说曾喜欢画水彩',evidence:[evidence],basis:[evidence]}],assessments:[],reason:'合成历史导入',unresolved:null})}}]};
    }
  }
  const args={snapshot:{input,graph:sources.map(s=>({id:s.id,version:1,characterId:'companion',kind:s.kind,state:'active' as const,eligible:s.evidenceEligible,parents:[]}))},config:endpoint,
    transport:new HistoricalMemoryTransport(new SemanticResponse(),{maxInputBytes:32768,maxOutputTokens:2048}),
    dynamics:true,provenance:{kind:'controlled_stub' as const,runId:'synthetic-import',attemptId:'one'},signal:new AbortController().signal,evidence:async()=>{}};
  const result=await runMemorySemanticAttempt(args);
  assert.equal(result.compiled.status,'ready');
  if(result.compiled.status==='ready') {
    assert.equal(result.compiled.plan.changes.length,1);
    const op=result.compiled.plan.changes[0]!.operation;
    assert.equal(op.type,'add');if(op.type==='add')assert.deepEqual(op.sourceIds,['old-user']);
  }
  useAssistant=true;
  await assert.rejects(runMemorySemanticAttempt({...args,provenance:{...args.provenance,attemptId:'two'}}));
});

test('real import HTTP/store stays off current recent chat, survives a new backend instance and deduplicates replay',async t=>{
  const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
  const {resolve,join}=await import('node:path');
  const {fileURLToPath}=await import('node:url');
  const {SqliteMemoryStore,CONFIRMED_RETENTION}=await import('../../memory/sqlite-store.js');
  const {confirmedInvitationPolicy}=await import('../../companion/invitations.js');
  const {SqliteMemoryImportManagement}=await import('../../memory/import-management.js');
  const {startManagementServer}=await import('../../management/server.js');
  const parent=fileURLToPath(new URL('../../../../../.local/memory-import-49/tmp/',import.meta.url));
  await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'wire-'));
  const stamp='2026-09-18T00:00:00.000Z';
  const store=new SqliteMemoryStore({filename:join(root,'companion.sqlite'),retention:CONFIRMED_RETENTION,invitations:confirmedInvitationPolicy('Asia/Shanghai'),clock:()=>stamp});
  const live={characterId:'companion',sessionId:'current',turnId:'today',generation:1};
  store.append(live,[{characterId:'companion',id:'current-user',role:'user',text:'今天继续聊天。',createdAt:stamp}]);
  const source={kind:'text-export' as const,projectName:'synthetic-old-companion',path:resolve(root,'old.jsonl')};
  await writeFile(source.path,[{role:'user',text:'以前常画水彩。',createdAt:'2019-01-01T00:00:00Z'},{role:'assistant',text:'也许你喜欢雪山。',createdAt:'2019-01-01T00:00:01Z'},{role:'user',text:'后来改成画素描。',createdAt:'2019-02-01T00:00:00Z'}].map(x=>JSON.stringify(x)).join('\n'));
  const configuration:import('../../contracts/memory-import.js').MemoryImportConfiguration={model:'synthetic-only',endpointHost:'example.invalid',batchMessages:16,maxInputBytes:32768,maxOutputTokens:2048,concurrency:1,timeoutMs:10000,budgetMode:'unlimited',limitMicros:null,inputMicrosPerToken:2,outputMicrosPerToken:8,currency:'CNY',textExportFormat:'synthetic JSONL'};
  let calls=0,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const processor={async plan(input:import('../../contracts/memory-lifecycle.js').MemoryTurnInput,_signal:AbortSignal,settle:(micros:number|null)=>void):Promise<import('../../contracts/memory-lifecycle.js').MemoryTurnPlan>{
    calls++;entered();await gate;settle(0);
    const user=input.sources.find(s=>s.messageRole==='user'&&s.text==='后来改成画素描。')!;
    assert.ok(user);assert.equal(input.sources.find(s=>s.messageRole==='assistant')?.evidenceEligible,false);
    return {scope:input.scope,request:'none',changes:[{scope:input.scope,operationId:'synthetic-write',createdAt:stamp,reason:'synthetic historical test',operation:{type:'add',id:'synthetic-import-memory',text:'后来改画素描',sourceIds:[user.id]}}],suppressSources:[],clarification:null,reason:'synthetic import'};
  }};
  const open=(instanceId:string)=>new SqliteMemoryImportManagement({filename:join(root,'memory-import.sqlite'),codexHome:join(root,'codex'),instanceId,store,configuration,processor,countTokens:historicalMemoryInputBytes});
  let service=open('instance-one');
  let server=await startManagementServer({memoryImport:service,uiRoot:root,settings:{async drain(){}} as unknown as import('../../management/settings-store.js').ManagementSettingsStore,memory:{} as import('../../contracts/management.js').ManagementMemoryPort,snapshot:()=>({} as import('../../contracts/management.js').ManagementSnapshot)});
  t.after(async()=>{release();await server.close();await service.close();store.close();await rm(root,{recursive:true,force:true});});
  const post=(action:string,body:unknown)=>fetch(server.origin+'/api/memory-import/'+action,{method:'POST',headers:{Authorization:'Bearer '+server.token,Origin:server.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const recent=()=>store.contextRecords(live,'',10,10,3).recent.map(m=>m.id);
  const request={instanceId:'instance-one',operationId:'synthetic-start',characterId:'companion',source};
  const response=await post('start',request);assert.equal(response.status,200);const job=await response.json() as {id:string};
  await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('Synthetic import did not start')),3000))]);
  assert.deepEqual(recent(),['current-user']);assert.equal(store.visible(live,'memory').length,0);
  release();
  const finished=async(id:string)=>{for(let i=0;i<100;i++){const j=service.snapshot().jobs.find(j=>j.id===id)!;if(j.status==='completed')return j;if(j.status==='failed')throw Error('Synthetic import failed: '+j.failures.map(f=>f.code).join(','));await new Promise(r=>setTimeout(r,20));}throw Error('Synthetic import did not finish');};
  const done=await finished(job.id);assert.equal(done.importedMemories,1);assert.equal(calls,1);assert.deepEqual(recent(),['current-user']);
  assert.match(store.visible(live,'memory')[0]!.text,/历史对话 2019-02-01/);
  store.cleanup();assert.equal(store.visible(live,'memory').length,1);
  assert.ok(store.contextRecords(live,'素描',10,10,3).memories.some(m=>m.id==='synthetic-import-memory'));
  await server.close();await service.close();service=open('instance-two');
  server=await startManagementServer({memoryImport:service,uiRoot:root,settings:{async drain(){}} as unknown as import('../../management/settings-store.js').ManagementSettingsStore,memory:{} as import('../../contracts/management.js').ManagementMemoryPort,snapshot:()=>({} as import('../../contracts/management.js').ManagementSnapshot)});
  assert.equal(service.snapshot().jobs[0]!.status,'completed');
  assert.equal((await post('start',request)).status,409);
  const repeated=await post('start',{...request,instanceId:'instance-two',operationId:'synthetic-replay'});assert.equal(repeated.status,200);
  const repeatedJob=await repeated.json() as {id:string};const replay=await finished(repeatedJob.id);
  assert.equal(replay.importedMemories,0);assert.equal(replay.skippedMessages,3);assert.equal(calls,1);assert.equal(store.visible(live,'memory').length,1);assert.deepEqual(recent(),['current-user']);
});

test('production strict provider and transport compile imported sources and settle the original authorizer',async t=>{
  const {mkdir,mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const {fileURLToPath}=await import('node:url');
  const {SqliteMemoryStore,CONFIRMED_RETENTION}=await import('../../memory/sqlite-store.js');
  const {confirmedInvitationPolicy}=await import('../../companion/invitations.js');
  const {SqliteMemoryImportManagement}=await import('../../memory/import-management.js');
  const {StrictTrialMemoryProvider,TrialTransport}=await import('../../app/trial-backend.js');
  const parent=fileURLToPath(new URL('../../../../../.local/memory-import-49/tmp/',import.meta.url));
  await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'strict-'));
  const store=new SqliteMemoryStore({filename:join(root,'pet.sqlite'),retention:CONFIRMED_RETENTION,invitations:confirmedInvitationPolicy('Asia/Shanghai'),clock:()=> '2026-09-18T00:00:00Z'});
  const configuration:import('../../contracts/memory-import.js').MemoryImportConfiguration={model:model.model,endpointHost:'example.invalid',batchMessages:16,maxInputBytes:32768,maxOutputTokens:2048,concurrency:1,timeoutMs:3000,budgetMode:'unlimited',limitMicros:null,inputMicrosPerToken:2,outputMicrosPerToken:8,currency:'CNY',textExportFormat:'synthetic JSONL'};
  const source={kind:'text-export' as const,projectName:'synthetic',path:join(root,'source.jsonl')};
  await writeFile(source.path,[{role:'assistant',text:'也许你喜欢海边。',createdAt:'2019-01-01T00:00:00Z'},{role:'user',text:'我喜欢素描。',createdAt:'2019-01-01T00:00:01Z'}].map(x=>JSON.stringify(x)).join('\n'));
  let requests=0,reservations=0,settlements=0;
  const controlledEndpoint:EndpointConfig={...endpoint,apiKey:()=> 'synthetic-not-a-secret',authorizer:{async authorize(request){assert.equal(request.operation,'memory_turn');reservations++;return {async settle(outcome){assert.equal(outcome.status,'success');settlements++;}};}}};
  const fakeFetch:typeof fetch=async(_url,init)=>{
    requests++;const body=JSON.parse(String(init?.body));assert.equal(body.max_tokens,2048);assert.equal(body.reasoning_effort,'high');
    assert.match(body.messages[0].content,/HISTORICAL IMPORT MODE/);
    const wire=JSON.parse(body.messages[1].content),user=wire.currentMessage,assistant=wire.evidence.find((s:{messageRole:string})=>s.messageRole==='assistant');
    assert.equal(user.createdAt,'2019-01-01T00:00:01.000Z');assert.equal(assistant.evidenceEligible,false);
    const support={source:{id:user.id,version:user.version},quote:{text:user.text,context:null}};
    return new Response(JSON.stringify({usage:{prompt_tokens:100,completion_tokens:10},choices:[{finish_reason:'stop',message:{content:JSON.stringify({request:'none',erase:[],facts:[{intent:'remember',statement:'用户当时喜欢素描',evidence:[support],basis:[support]}],assessments:[],reason:'synthetic',unresolved:null})}}]}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const trial={models:{memory_turn:model},memory:{timeoutMs:3000}} as import('../../app/trial-config.js').TrialConfiguration;
  const transport=new TrialTransport(trial,fakeFetch);
  const service=new SqliteMemoryImportManagement({filename:join(root,'jobs.sqlite'),codexHome:join(root,'unused'),instanceId:'synthetic-instance',store,configuration,countTokens:historicalMemoryInputBytes,processor:{async plan(input,signal,settle){
    return new StrictTrialMemoryProvider(store,observedImportEndpoint(controlledEndpoint,model,settle),new HistoricalMemoryTransport(transport,configuration),'synthetic-import',async()=>{},'high','controlled_stub').plan(input,signal);
  }}});
  t.after(async()=>{await service.close();store.close();await rm(root,{recursive:true,force:true});});
  service.start({instanceId:'synthetic-instance',operationId:'strict-start',characterId:'companion',source});
  for(let i=0;i<150;i++){
    const job=service.snapshot().jobs[0]!;
    if(job.status==='failed')assert.fail('Synthetic strict pipeline failed: '+job.failures.map(f=>f.code).join(','));
    if(job.status==='completed'){
      assert.equal(job.importedMemories,1);assert.equal(job.actualCalls,1);assert.equal(job.accountedMicros,280);
      assert.equal(requests,1);assert.equal(reservations,1);assert.equal(settlements,1);
      assert.ok(store.contextRecords(scope,'素描',10,10,3).memories.some(m=>m.text.includes('2019-01-01')));return;
    }
    await new Promise(r=>setTimeout(r,20));
  }
  assert.fail('Synthetic strict pipeline did not finish');
});
