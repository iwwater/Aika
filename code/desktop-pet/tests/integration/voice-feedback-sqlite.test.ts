import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {SqliteMemoryStore,CONFIRMED_RETENTION} from '../../memory/sqlite-store.js';
import {confirmedInvitationPolicy} from '../../companion/invitations.js';
import {lifecycle,none,deferred,forget} from '../memory/lifecycle-fixture.js';
import {message,change,scope as seedScope} from '../memory/sqlite-fixture.js';
import {DialoguePipeline,type DialoguePorts} from '../../core/dialogue-pipeline.js';
import {TurnController} from '../../core/turn-controller.js';
import {RoleMemoryLifecycleQueue} from '../../core/memory-lifecycle-queue.js';
import {MemoryMediaStore} from '../../media/store.js';
import {BackendSession} from '../../app/backend-session.js';
import {TrialAdmission} from '../../app/trial-admission.js';
import {JsonDialogueProvider} from '../../providers/qwen-dialogue.js';
import {ProviderTransport} from '../../providers/transport.js';
import type {MemoryTurnPlan,MemoryTurnInput} from '../../contracts/memory-lifecycle.js';

function fixture(){const parent=resolve('../../.local/voice-feedback-03/tmp');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(join(parent,'sqlite-'));const store=new SqliteMemoryStore({filename:join(dir,'state.sqlite'),retention:CONFIRMED_RETENTION,invitations:confirmedInvitationPolicy('Asia/Shanghai')});return{store,close(){store.close();rmSync(dir,{recursive:true,force:true});}};}
const expression={emotion:'neutral' as const,intensity:0,delivery:'自然',gesture:null};
test('an old strict ticket cannot omit disposition for a subsequently saved dependent reply',async()=>{
 const f=fixture(),store=f.store,scope=seedScope(),gate=deferred<MemoryTurnPlan>();let input!:MemoryTurnInput;
 try{store.append(scope,[message('raw-tea','红茶')]);store.apply(change({type:'add',id:'tea',text:'红茶',sourceIds:['raw-tea']},'add'));
 const memory=lifecycle(store,async value=>{input=value;return gate.promise;});await memory.append(scope,[message('turn-1:user','红茶')]);const writer=memory.prepareBackgroundTurn(scope,'turn-1:user','红茶',new AbortController().signal);
 const context=await memory.foregroundContext(scope,'turn-1:user','红茶',null,new AbortController().signal);await memory.appendAssistant(scope,{...message('turn-1:assistant','合成红茶回复'),role:'assistant'},context,'turn-1:user',new AbortController().signal);
 gate.resolve({...none(input),changes:[change({type:'update',id:'tea',expectedVersion:1,text:'绿茶',sourceIds:['raw-tea']},'incomplete-update')]});const outcome=await writer;
 assert.equal(outcome.status,'rejected');assert.equal(outcome.rejectionCode,'unresolved_source_disposition');assert.equal(store.inspect(scope,'tea')!.version,1);memory.assertContextCurrent(context);
 }finally{f.close();}
});
for(const phase of ['reply','tts','playback'] as const)for(const selected of [false,true])test(`actual queued strict commit during ${phase}: ${selected?'selected source rejects':'unrelated source continues'}`,{timeout:5000},async t=>{
 const f=fixture(),store=f.store,controller=new TurnController(),start=controller.begin('text','红茶'),scope=start.input.scope;
 const entered=deferred<void>(),readGate=deferred<void>(),gate=deferred<MemoryTurnPlan>();let input!:MemoryTurnInput,stopped=0,played=0;
 store.append(seedScope(),[message('raw-tea','红茶'),message('raw-cat','猫叫团子')]);
 for(const id of ['tea','cat'])store.apply(change({type:'add',id,text:id==='tea'?'红茶':'猫叫团子',sourceIds:['raw-'+id]},'add-'+id));
 const memory=lifecycle(store,async value=>{if(value.scope.turnId!==scope.turnId)return {...forget(value,['raw-tea',scope.turnId+':user',scope.turnId+':assistant']),changes:[change({type:'soft_delete',id:'tea',expectedVersion:1},'strict-forget',value.scope)]};input=value;entered.resolve();return gate.promise;});
 const prepare=memory.prepareBackgroundTurn.bind(memory);memory.prepareBackgroundTurn=async(...args)=>{await readGate.promise;return prepare(...args);};
 const queue=new RoleMemoryLifecycleQueue(memory,()=>{}),media=new MemoryMediaStore();
 t.after(async()=>{readGate.resolve();if(input)gate.resolve(none(input));await queue.close();f.close();});
 const commit=async()=>{readGate.resolve();await entered.promise;const id=selected?'tea':'cat';
  if(selected&&phase!=='reply'){
   // A new strict request owns evidence after the already-saved assistant. The old
   // request is not allowed to read future sources or omit propagation obligations.
   gate.resolve(none(input));await queue.drain();const next={...scope,turnId:scope.turnId+'-forget',generation:scope.generation+1},current=next.turnId+':user';
   await memory.append(next,[message(current,'忘记红茶')]);const outcome=await queue.enqueueTurn(next,current,'忘记红茶');assert.equal(outcome.status,'applied',JSON.stringify(outcome));
  }else{gate.resolve({...none(input),changes:[change({type:'update',id,expectedVersion:1,text:id==='tea'?'绿茶':'猫叫小团子',sourceIds:['raw-'+id]},'strict-update',scope)]});await queue.drain();}
  assert.equal(store.inspect(scope,id)!.version,2);
 };
 const ports:DialoguePorts={memory,mediaStore:media,backgroundMemory:queue,perception:{async perceive(){throw Error('no device');}},
  dialogue:{async reply(request){assert.ok(request.context.memories.some(m=>m.id==='tea'));assert.ok(!request.context.memories.some(m=>m.id==='cat'));if(phase==='reply')await commit();return{scope,text:'合成回复',expression};}},
  tts:{async synthesize(reply){if(phase==='tts')await commit();return{...reply,audio:await media.put(scope,Uint8Array.of(1),'audio/wav'),durationMs:1,synchronization:'amplitude'};}},
  playback:{async stop(){stopped++;},async play(audio,event){played++;event({scope,type:'started',audioId:audio.audio.id,at:new Date().toISOString()});if(phase==='playback'){await commit();event({scope,type:'amplitude',value:0.3,at:new Date().toISOString()});}event({scope,type:'ended',at:new Date().toISOString()});}},
 };
 const result=await new DialoguePipeline(ports,controller,()=>{}).run(start.input,start.signal);
 assert.equal(result.status,selected?'failed':'played',JSON.stringify(result));if(selected)assert.match(result.error!,/stale_context|记忆内容已更新/);assert.equal(media.count,0);
 if(selected&&phase==='reply')assert.equal(store.inspect(scope,scope.turnId+':assistant'),null);
 if(selected&&phase==='tts')assert.equal(played,0);
 if(selected&&phase==='playback')assert.equal(stopped,1,JSON.stringify(result));
});

for(const failure of [false,true])test(`actual BackendSession pending privacy before held strict writer: ${failure?'classifier transport failure':'explicit forget'}`,{timeout:5000},async t=>{
 const f=fixture(),store=f.store,gate=deferred<MemoryTurnPlan>(),entered=deferred<void>(),played=deferred<void>();let input!:MemoryTurnInput,session:BackendSession|undefined;
 const secret='synthetic-confidential-tea';store.append(seedScope(),[message('raw',secret)]);store.apply(change({type:'add',id:'tea',text:secret,sourceIds:['raw']},'add'));
 const memory=lifecycle(store,async value=>{input=value;entered.resolve();return gate.promise;},undefined,{summary:{minMessages:100,maxMessages:100,inputTokenBudget:30000,countTokens:()=>1,provider:{async summarize(){throw Error('no summary');}}}});
 const config={endpoint:'https://example.invalid/chat',model:'controlled',apiKey:()=> 'synthetic',authorizer:{async authorize(){return{async settle(){}};}}};
 const admission=new TrialAdmission(config,new ProviderTransport(async(_url,options)=>{if(failure)throw Error('controlled offline');const body=JSON.parse(String(options?.body)),payload=JSON.parse(body.messages[1].content);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({scope:payload.hostScope,request:'forget',reason:'Controlled explicit request'})}}]});}),
  (scope,text,signal)=>memory.foregroundContext(scope,scope.turnId+':user',text,null,signal));
 let dialogueCalls=0;
 const dialogue=new JsonDialogueProvider(config,new ProviderTransport(async(_url,options)=>{dialogueCalls++;const body=JSON.parse(String(options?.body));assert.ok(!JSON.stringify(body).includes(secret));assert.match(body.messages[0].content,/pending/);assert.match(body.messages[0].content,failure?/uncertain/:/forget/);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:failure?'你希望调整哪一条个人资料？':'正在处理这项请求。',expression})}}]});}));
 const media=new MemoryMediaStore();
 session=new BackendSession({memory,backgroundMemory:memory,classifyMemoryRequest:admission.foregroundRequest.bind(admission),mediaStore:media,dialogue,
  perception:{async perceive(){throw Error('no device');}},tts:{async synthesize(reply){return{...reply,audio:await media.put(reply.scope,Uint8Array.of(1),'audio/wav'),durationMs:1,synchronization:'amplitude'};}}},
  output=>{if(output.channel==='play')queueMicrotask(()=>{for(const type of ['started','ended'] as const)void session!.receiveLine(JSON.stringify({channel:'playback',requestId:output.requestId,event:{type,scope:output.tts.scope,at:new Date().toISOString(),...(type==='started'?{audioId:output.tts.audio.id}:{})}}));});if(output.channel==='event'&&output.event.type==='playback'&&output.event.playback.type==='ended')played.resolve();if(output.channel==='stop'||output.channel==='capture_stop')queueMicrotask(()=>void session!.receiveLine(JSON.stringify({channel:'ack',requestId:output.requestId})));},()=>{});
 t.after(async()=>{if(input)gate.resolve(none(input));await session?.close();f.close();});
 await session.receiveLine(JSON.stringify({channel:'command',command:{type:'submit_text',text:'忘记'+secret}}));await entered.promise;await played.promise;
 assert.equal(dialogueCalls,1);assert.equal(memory.pendingMutations('companion').length,1);assert.equal(store.inspect(input.scope,input.scope.turnId+':assistant')!.evidenceEligible,false);
 assert.deepEqual(store.search(input.scope,secret,10),[]);assert.ok(input.sources.some(x=>x.id==='raw'),'strict writer retains required evidence');
 gate.resolve(failure?none(input):{...forget(input,['raw']),changes:[change({type:'soft_delete',id:'tea',expectedVersion:1},'delete',input.scope)]});await session.drain();assert.deepEqual(memory.pendingMutations('companion'),[]);
 if(!failure)assert.deepEqual(store.search(input.scope,secret,10),[]);
});
