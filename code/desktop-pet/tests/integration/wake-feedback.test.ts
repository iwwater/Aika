import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendSession, parseDesktopCommand } from '../../app/backend-session.js';
import type { BackendToDesktop } from '../../contracts/desktop-bridge.js';
import { WAKE_DEFAULT_SETTINGS } from '../../contracts/wake.js';
import { MemoryMediaStore } from '../../media/store.js';
import { DesktopChatLog } from '../../desktop/chat-log.js';
import type { TurnScope } from '../../contracts/index.js';

test('wake default uses 3000ms; untrusted commands cannot inject a cleanup keyword',()=>{
  assert.equal(WAKE_DEFAULT_SETTINGS.silenceMs,3000);
  assert.deepEqual(parseDesktopCommand({type:'start_voice',wakeKeyword:'任意名字'}),{type:'start_voice'});
});

test('actual session cleans only hit-bound leading wake text before events, routing, context and new memory',async t=>{
  for(const [label,kind,keyword,transcript,expected] of [
    ['exact','wake','乐正绫','乐正绫，晚上好。','晚上好。'],
    ['observed alias','wake','乐正绫','岳正宁，晚上好。','晚上好。'],
    ['no separator','wake','乐正绫','乐正绫晚上好。','晚上好。'],
    ['alias no separator','wake','乐正绫','岳正宁晚上好。','晚上好。'],
    ['one prefix only','wake','乐正绫','乐正绫，乐正绫晚上好。','乐正绫晚上好。'],
    ['middle unchanged','wake','乐正绫','我想叫乐正绫，晚上好。','我想叫乐正绫，晚上好。'],
    ['PTT unchanged','voice','乐正绫','岳正宁，晚上好。','岳正宁，晚上好。'],
    ['text unchanged','text','乐正绫','乐正绫，晚上好。','乐正绫，晚上好。'],
    ['custom exact','wake','小月','小月晚上好。','晚上好。'],
    ['custom never uses alias','wake','小月','岳正宁，晚上好。','岳正宁，晚上好。'],
    ['name only','wake','乐正绫','乐正绫。',''],
    ['alias only','wake','乐正绫','岳正宁，',''],
    ['empty ASR','wake','乐正绫','',''],
  ])await t.test(label!,async()=>{
    const media=new MemoryMediaStore(),events:BackendToDesktop[]=[],saved:string[]=['old untouched memory'],contexts:string[]=[],routes:string[]=[],replies:string[]=[];
    let hits=0,captures=0;
    const session=new BackendSession({mediaStore:media,
      consumeWakeHit:hit=>{assert.deepEqual(hit,{generation:1,sequence:42});hits++;return keyword;},
      perception:{async perceive(input){return {scope:input.scope,transcript:transcript!,status:'complete',modalities:[],cues:[]};}},
      memory:{async append(_scope,messages){saved.push(...messages.map(m=>m.text));},async context(scope,text,perception){contexts.push(text);assert.equal(perception?.transcript,kind==='text'?undefined:expected);return {scope,characterPrompt:'synthetic',recent:[],summary:'',memories:[],perception,inputTokenBudget:1000};},async maintain(){return [];},maintenanceInput(scope){return {scope,messages:[],relevantMemories:[]};}},
      dialogue:{async reply(input){replies.push(input.text);assert.equal(input.context.perception?.transcript,kind==='text'?undefined:expected);return {scope:input.scope,text:'synthetic reply',expression:{emotion:'neutral',intensity:0,delivery:'natural',gesture:null}};}},
      tts:{async synthesize(reply){return {...reply,audio:await media.put(reply.scope,Uint8Array.of(1),'audio/wav'),durationMs:1,synchronization:'amplitude'};}},
    },message=>{
      events.push(message);
      if(['capture_start','capture_stop','stop'].includes(message.channel)&&'requestId' in message){if(message.channel==='capture_start')captures++;queueMicrotask(()=>void session.receiveLine(JSON.stringify({channel:'ack',requestId:message.requestId})));}
      if(message.channel==='capture_finish')queueMicrotask(()=>void session.receiveLine(JSON.stringify({channel:'capture',requestId:message.requestId,result:{scope:message.scope,audio:{mimeType:'audio/wav',base64:'AQI='},images:[],inputEndedAt:new Date().toISOString(),captureStoppedAt:new Date().toISOString()}})));
      if(message.channel==='play')queueMicrotask(()=>{for(const type of ['started','ended'])void session.receiveLine(JSON.stringify({channel:'playback',requestId:message.requestId,event:{scope:message.tts.scope,type,audioId:message.tts.audio.id,at:new Date().toISOString()}}));});
    },()=>{});
    session.attachWork({beginInput(){},onInput(){},async route(_scope:TurnScope,text:string){routes.push(text);return 'companion';},async action(){},async close(){}} as never);
    const command=(command:unknown)=>session.receiveLine(JSON.stringify({channel:'command',command}));
    try{
      if(kind==='text')await command({type:'submit_text',text:transcript});
      else {await command({type:'start_voice',...(kind==='wake'?{wakeHit:{generation:1,sequence:42}}:{})});await command({type:'finish_voice'});}
      await session.drain();
      assert.equal(hits,kind==='wake'?1:0);assert.equal(captures,kind==='text'?0:1);
      assert.equal(events.some(m=>m.channel==='event'&&m.event.type==='error'),false);
      assert.deepEqual(replies,expected?[expected]:[]);assert.deepEqual(contexts,replies);assert.deepEqual(routes,replies);
      assert.deepEqual(saved,expected?['old untouched memory',expected,'synthetic reply']:['old untouched memory']);
      if(kind!=='text'){
        const transcripts=events.filter(m=>m.channel==='event'&&m.event.type==='transcript');assert.equal(transcripts.length,1);
        const event=transcripts[0]!;assert.ok(event.channel==='event'&&event.event.type==='transcript');assert.equal(event.event.text,expected);
        if(!expected){const chat=new DesktopChatLog();chat.beginVoice('companion',true);chat.bindVoice(event.event.scope);chat.transcript(event.event.scope,event.event.text);assert.equal(chat.rows('companion').length,0);}
      }
      assert.equal(media.count,0);
    }finally{await session.close();}
  });
});
