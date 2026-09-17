import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkSpeech } from '../../core/work-speech.js';
import { MemoryMediaStore } from '../../media/store.js';
import type { DialogueReply, TtsResult, TtsProvider, PlaybackPort } from '../../contracts/index.js';
import type { WorkSpeechEvent } from '../../contracts/desktop-work.js';
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred<T>() { let resolve!: (v:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve}; }
function fixture() {
  const media=new MemoryMediaStore(),events:WorkSpeechEvent[]=[],texts:string[]=[],played:string[]=[],stopped:string[]=[];
  let busy=false,now=0;
  const audio=async (reply:DialogueReply):Promise<TtsResult>=>({...reply,audio:await media.put(reply.scope,Uint8Array.of(1),'audio/wav'),durationMs:1,synchronization:'amplitude'});
  const tts:TtsProvider={async synthesize(reply){texts.push(reply.text);return audio(reply);}};
  const playback:PlaybackPort={async stop(scope){stopped.push(scope.turnId);},async play(value,emit,signal){signal.throwIfAborted();played.push(value.scope.turnId);emit({type:'started',scope:value.scope,at:'now',audioId:value.audio.id});emit({type:'ended',scope:value.scope,at:'now'});}};
  const speech=new WorkSpeech({identity:()=>({characterId:'companion',sessionId:'synthetic-session'}),busy:()=>busy,tts,playback,media,emit:e=>events.push(e),now:()=>now});
  return {speech,media,events,texts,played,stopped,tts,playback,audio,setBusy:(v:boolean)=>busy=v,setNow:(v:number)=>now=v};
}
test('only fixed brief state text is spoken; duplicate real event never repeats and scopes release',async()=>{
 const f=fixture();f.speech.notify({id:'task',kind:'transferred',executor:'codex'});await f.speech.drain();
 f.speech.notify({id:'task',kind:'transferred',executor:'codex'});await f.speech.drain();
 assert.equal(f.texts.length,1);assert.match(f.texts[0]!,/已经交给Codex/);assert.equal(f.played.length,1);assert.equal(f.media.count,0);
 assert.equal(f.events.filter(e=>e.state==='start').length,1);assert.equal(f.events[0]!.inputEpoch,0);await f.speech.close();
});
test('foreground blocks speech, coalesces to one latest true state and expires stale notices',async()=>{
 const f=fixture();f.setBusy(true);f.speech.notify({id:'t',kind:'confirmed',executor:'codex'});f.speech.notify({id:'t',kind:'completed',executor:'codex'});
 assert.equal(f.texts.length,0);f.setBusy(false);await f.speech.drain();assert.equal(f.texts.length,1);assert.match(f.texts[0]!,/有结果/);
 f.setBusy(true);f.speech.notify({id:'old',kind:'ready',executor:'harness'});f.setNow(15001);f.setBusy(false);await f.speech.drain();assert.equal(f.texts.length,1);await f.speech.close();
});
test('new input cancels synthesis immediately and late provider result cannot play or leak media',async()=>{
 const f=fixture(),pending=deferred<void>();let request:DialogueReply|undefined,signal:AbortSignal|undefined;
 f.tts.synthesize=async (reply,s)=>{request=reply;signal=s;await pending.promise;return f.audio(reply);};
 f.speech.notify({id:'old',kind:'confirmed',executor:'codex'});assert.ok(request);f.speech.onInput();assert.equal(signal!.aborted,true);assert.equal(f.stopped.length,1);
 pending.resolve();await f.speech.drain();assert.equal(f.played.length,0);assert.equal(f.media.count,0);
 f.tts.synthesize=async reply=>f.audio(reply);f.speech.notify({id:'new',kind:'ready',executor:'codex'});await f.speech.drain();assert.equal(f.played.length,1);assert.equal(f.events.filter(e=>e.state==='start').at(-1)!.inputEpoch,1);await f.speech.close();
});
test('Space-equivalent input stops live playback and discards queued progress without cancelling work',async()=>{
 const f=fixture(),terminal=deferred<void>();let inputSignal:AbortSignal|undefined;
 f.playback.play=async(value,emit,signal)=>{inputSignal=signal;f.played.push(value.scope.turnId);emit({type:'started',scope:value.scope,at:'now',audioId:value.audio.id});await terminal.promise;emit({type:'stopped',scope:value.scope,at:'now'});};
 f.speech.notify({id:'t',kind:'confirmed',executor:'harness'});await tick();f.speech.notify({id:'t',kind:'completed',executor:'harness'});f.speech.onInput();assert.equal(inputSignal!.aborted,true);terminal.resolve();await f.speech.drain();assert.equal(f.played.length,1);assert.equal(f.texts.length,1);assert.equal(f.media.count,0);await f.speech.close();
});
test('failed or wrong-scope TTS and rejected playback terminate without retries',async()=>{
 for(const mode of ['failure','scope','stopped'] as const){
  const f=fixture();let attempts=0;
  f.tts.synthesize=async reply=>{attempts++;if(mode==='failure')throw Error('Synthetic TTS failure');const result=await f.audio(reply);return mode==='scope'?{...result,scope:{...reply.scope,turnId:'wrong'}}:result;};
  if(mode==='stopped')f.playback.play=async(value,emit)=>{emit({type:'stopped',scope:value.scope,at:'now'});};
  f.speech.notify({id:'t',kind:'ready',executor:'codex'});await f.speech.drain();f.speech.notify({id:'t',kind:'ready',executor:'codex'});await f.speech.drain();assert.equal(attempts,1);assert.equal(f.media.count,0);assert.equal(f.events.at(-1)!.state,'end');await f.speech.close();
 }
});


test('new actual state supersedes unsounded synthesis of the same task without replaying obsolete confirmation guidance',async()=>{
 const f=fixture(),pending=deferred<void>();let first=true,oldSignal:AbortSignal|undefined;
 f.tts.synthesize=async(reply,signal)=>{f.texts.push(reply.text);if(first){first=false;oldSignal=signal;await pending.promise;}return f.audio(reply);};
 f.speech.notify({id:'t',kind:'ready',executor:'codex'});
 f.speech.notify({id:'t',kind:'confirmed',executor:'codex'});
 assert.equal(oldSignal!.aborted,true);pending.resolve();await f.speech.drain();
 assert.equal(f.played.length,1);assert.match(f.texts.at(-1)!,/收到你的确认/);assert.equal(f.media.count,0);
 assert.equal(f.events.filter(e=>e.state==='start').every(e=>e.inputEpoch===0),true);await f.speech.close();
});
