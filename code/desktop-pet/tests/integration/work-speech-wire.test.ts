import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendSession } from '../../app/backend-session.js';
import { MemoryMediaStore } from '../../media/store.js';
import type { BackendToDesktop } from '../../contracts/desktop-bridge.js';
import type { DialogueReply, TtsResult } from '../../contracts/index.js';
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function setup(){
 const {app}=await import(new URL('../../../tests/desktop/ui-harness.mjs',import.meta.url).href);
 const ui=await app({explicitRouting:true}),output:BackendToDesktop[]=[],errors:unknown[]=[],media=new MemoryMediaStore(),calls:string[]=[];
 let uiIndex=0,outIndex=0;
 const tts={async synthesize(reply:DialogueReply):Promise<TtsResult>{calls.push('tts');return {...reply,audio:await media.put(reply.scope,Uint8Array.of(1,2),'audio/wav'),durationMs:50,synchronization:'amplitude'};}};
 const session=new BackendSession({mediaStore:media,tts,
  perception:{async perceive(){throw Error('No perception');}},dialogue:{async reply(){throw Error('No dialogue');}},
  memory:{async append(){calls.push('append');},async context(){throw Error('No memory context');},async maintain(){calls.push('maintain');return [];},maintenanceInput(scope){return {scope,messages:[],relevantMemories:[]};}},
 },m=>output.push(m),()=>{});
 const launch=(p:Promise<unknown>)=>{void p.catch(e=>errors.push(e));};
 const pump=async(done:()=>boolean)=>{for(let n=0;n<120;n++){
  while(uiIndex<ui.messages.length){const m=ui.messages[uiIndex++];if(m.name==='desktop')launch(session.receiveLine(JSON.stringify(m.value.message)));}
  while(outIndex<output.length)launch(ui.bridge.receive(JSON.parse(JSON.stringify(output[outIndex++])),1));
  await tick();assert.deepEqual(errors,[]);if(done()&&uiIndex===ui.messages.length&&outIndex===output.length)return;
 }assert.fail('Controlled work speech bridge did not settle');};
 ui.changed(1);await pump(()=>!ui.node('voice').disabled);
 return {ui,session,output,media,calls,tts,pump,async close(){ui.changed(1,'disconnected');await session.close();}};
}
test('actual frontend/backend use one playback lane and Space stops work speech without companion writes',async()=>{
 const f=await setup();try{
  f.session.notifyWork({id:'synthetic-task',kind:'transferred',executor:'codex'});
  await f.pump(()=>f.ui.harness.playOpens===1);
  const play=f.output.find((m):m is Extract<BackendToDesktop,{channel:'play'}>=>m.channel==='play')!;
  f.ui.harness.playback.emit({type:'started',audioId:play.tts.audio.id,at:new Date().toISOString()});
  await f.pump(()=>f.ui.node('status').textContent.includes('播报任务状态'));
  f.ui.node('stop').onclick();await f.pump(()=>f.media.count===0);await f.session.drain();
  assert.deepEqual(f.calls,['tts']);assert.equal(f.ui.harness.playOpens,1);
  assert.equal(f.ui.node('status').textContent.includes('播报任务状态'),false);
  assert.equal(f.output.some(m=>m.channel==='event'&&m.event.type==='reply'),false);
  assert.equal(f.output.some(m=>m.channel==='capture_start'),false);
  assert.ok(f.output.some(m=>m.channel==='stop'&&m.scope.turnId===play.tts.scope.turnId));
  // A late keyed end is harmless after input changes the shared epoch.
  await f.ui.bridge.receive({channel:'work_speech',event:{noticeId:'synthetic-task:transferred',scope:play.tts.scope,inputEpoch:0,state:'end'}},1);
  assert.equal(f.ui.node('status').textContent.includes('播报任务状态'),false);
 }finally{await f.close();}
});
test('typing rejects a same-epoch late work play with a real terminal acknowledgement and releases backend media',async()=>{
 const f=await setup();try{
  const synth=f.tts.synthesize;let release!:()=>void;
  const wait=new Promise<void>(r=>release=r);f.tts.synthesize=async reply=>{await wait;return synth(reply);};
  f.session.notifyWork({id:'late-task',kind:'ready',executor:'harness'});
  await f.pump(()=>f.output.some(m=>m.channel==='work_speech'&&m.event.state==='start'));
  f.ui.node('text').value='User is drafting a new thought';f.ui.node('text').oninput();release();
  await f.pump(()=>f.output.some(m=>m.channel==='play')&&f.media.count===0);await f.session.drain();
  const play=f.output.find((m):m is Extract<BackendToDesktop,{channel:'play'}>=>m.channel==='play')!;
  const sent=f.ui.messages.filter((m:{name:string})=>m.name==='desktop').map((m:{value:{message:unknown}})=>m.value.message);
  assert.ok(sent.some((m:{channel?:string;requestId?:string;event?:{type:string}})=>m.channel==='playback'&&m.requestId===play.requestId&&m.event?.type==='stopped'));
  assert.equal(f.ui.harness.playOpens,0);assert.equal(f.media.count,0);assert.deepEqual(f.calls,['tts']);
 }finally{await f.close();}
});
