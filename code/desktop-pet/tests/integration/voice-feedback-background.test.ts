import test from 'node:test';
import assert from 'node:assert/strict';
import {DialoguePipeline,type DialoguePorts} from '../../core/dialogue-pipeline.js';
import {TurnController} from '../../core/turn-controller.js';
import type {DialogueContext,TurnScope} from '../../contracts/index.js';
import type {MemoryTurnOutcome} from '../../contracts/memory-lifecycle.js';
import {MemoryMediaStore} from '../../media/store.js';
const context=(scope:TurnScope):DialogueContext=>({scope,characterPrompt:'合成角色',recent:[],summary:'',memories:[],perception:null,inputTokenBudget:10000});
for(const text of ['今天的风很舒服。','你刚才提到的那本书叫什么？','我说的是蓝色，你刚才回答成了红色。']){
 test('foreground reply does not await unresolved strict writer: '+text,async t=>{
  const controller=new TurnController(),started=controller.begin('text',text),scope=started.input.scope;
  let release!:(value:MemoryTurnOutcome)=>void;const held=new Promise<MemoryTurnOutcome>(r=>release=r),calls:string[]=[];
  const store=new MemoryMediaStore();
  const ports:DialoguePorts={mediaStore:store,
   memory:{async append(){calls.push('append-user');},async context(s){return context(s);},async maintain(){return[];}},
   memoryLifecycle:{async prepareTurn(){calls.push('strict-sync');return held;},assertContextCurrent(){},async appendAssistant(){calls.push('assistant');}},
   backgroundMemory:{isIndependent(){return false;},enqueueTurn(){calls.push('strict-background');return held;},async foregroundContext(s){return context(s);},assertContextCurrent(){},async appendForegroundAssistant(){calls.push('assistant');}},
   perception:{async perceive(){throw Error('no devices');}},
   dialogue:{async reply(input){calls.push('reply');return {scope:input.scope,text:'合成当前回复',expression:{emotion:'neutral',intensity:0,delivery:'自然',gesture:null}};}},
   tts:{async synthesize(reply){return {...reply,audio:await store.put(reply.scope,Uint8Array.of(1),'audio/wav'),durationMs:1,synchronization:'amplitude'};}},
   playback:{async stop(){},async play(input,event){event({scope:input.scope,type:'started',audioId:input.audio.id,at:new Date().toISOString()});event({scope:input.scope,type:'ended',at:new Date().toISOString()});}},
  };
  const work=new DialoguePipeline(ports,controller,()=>{}).run(started.input,started.signal);
  t.after(async()=>{controller.resetSession();release({scope,request:'none',status:'unchanged',results:[],affectedIds:[],retrievalInvalidated:false,clarification:null});await work;});
  await new Promise<void>(r=>setImmediate(r));
  assert.ok(calls.includes('reply'),'strict writer remains unresolved, but foreground must already call dialogue');
  assert.ok(calls.includes('strict-background'));assert.ok(!calls.includes('strict-sync'));
 });
}

test('pending forget response uses actual pending status and excludes target text from dialogue payload',async()=>{
 const {JsonDialogueProvider}=await import('../../providers/qwen-dialogue.js');
 const {ProviderTransport}=await import('../../providers/transport.js');
 const {hostClock}=await import('../../providers/host-clock.js');
 const controller=new TurnController(),started=controller.begin('text','合成遗忘请求'),scope=started.input.scope;
 const current=context(scope),secret='synthetic-private-marker';
 let calls=0;
 const transport=new ProviderTransport(async(_url,init)=>{
  calls++;const body=JSON.parse(String(init?.body));assert.ok(!JSON.stringify(body).includes(secret));
  assert.match(body.messages[0].content,/pending/);assert.match(body.messages[0].content,/2026\/09\/12 15:30:00/);assert.match(body.messages[0].content,/Asia\/Shanghai/);
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'这件事正在处理。',expression:{emotion:'neutral',intensity:0,delivery:'自然',gesture:null}})}}]});
 });
 const provider=new JsonDialogueProvider({endpoint:'https://example.invalid/chat',model:'controlled',apiKey:()=> 'synthetic',authorizer:{async authorize(){return{async settle(){}};}}},transport,undefined,()=>hostClock(new Date('2026-09-12T07:30:00Z'),'Asia/Shanghai'));
 await provider.reply({scope,text:'忘掉'+secret,context:current,memoryPending:{scope,request:'forget',status:'pending'}},new AbortController().signal);
 assert.equal(calls,1);
});

test('everyday time answer receives a newly read local clock for each request despite old conversation time',async()=>{
 const {JsonDialogueProvider}=await import('../../providers/qwen-dialogue.js');const {ProviderTransport}=await import('../../providers/transport.js');const {hostClock}=await import('../../providers/host-clock.js');
 const scope={characterId:'companion',sessionId:'synthetic',turnId:'clock',generation:1};let reads=0;const payloads:any[]=[];
 const transport=new ProviderTransport(async(_url,init)=>{payloads.push(JSON.parse(String(init?.body)));return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'当前时间',expression:{emotion:'neutral',intensity:0,delivery:'自然',gesture:null}})}}]});});
 const provider=new JsonDialogueProvider({endpoint:'https://example.invalid/chat',model:'controlled',apiKey:()=> 'synthetic',authorizer:{async authorize(){return{async settle(){}};}}},transport,undefined,()=>hostClock(new Date(reads++===0?'2026-09-15T09:00:00Z':'2026-09-15T09:01:00Z'),'Asia/Shanghai'));
 const old={...context(scope),summary:'过去聊到的时间是早上六点'};
 for(let n=0;n<2;n++)await provider.reply({scope,text:'下午好，现在帮我查一下现在是几点了',context:old},new AbortController().signal);
 assert.equal(reads,2);assert.match(payloads[0].messages[0].content,/2026\/09\/15 17:00:00/);assert.match(payloads[1].messages[0].content,/2026\/09\/15 17:01:00/);assert.match(payloads[1].messages[0].content,/Asia\/Shanghai/);
});
