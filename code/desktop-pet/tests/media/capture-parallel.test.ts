import test from 'node:test';import assert from 'node:assert/strict';
import {BrowserCaptureDriver} from '../../media/browser-capture.js';import {CaptureError} from '../../media/capture-errors.js';
const tick=()=>new Promise<void>(r=>setImmediate(r));
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;return {promise:new Promise<T>((r,j)=>{resolve=r;reject=j}),resolve,reject};}
function replace(name:string,value:unknown){const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value,configurable:true});return()=>{if(old)Object.defineProperty(globalThis,name,old);else Reflect.deleteProperty(globalThis,name);};}
const options={cameraWidth:320,jpegQuality:.75,maxBufferedSamples:24000};
function environment(){
 const requests:ReturnType<typeof deferred<MediaStream>>[]=[],contexts:Context[]=[],tracks:{stops:number;stop:()=>void}[]=[];
 class Context{
  state='suspended';sampleRate=24000;destination={};closes=0;connected=false;node?:Node;
  module=deferred<void>();activation=deferred<void>();
  constructor(){contexts.push(this);}
  audioWorklet={addModule:()=>this.module.promise};
  async resume(){await this.activation.promise;if(this.state!=='closed')this.state='running';}
  async close(){this.closes++;this.state='closed';}
  createMediaStreamSource(){return {connect:()=>{this.connected=true;}};}
  createGain(){return {gain:{value:1},connect(){}};}
 }
 class Node{
  constructor(c:Context){c.node=this;}
  port={onmessage:null as ((e:{data:unknown})=>void)|null,close(){},postMessage:()=>{this.port.onmessage?.({data:{finished:true}});}};
  connect(){}disconnect(){}
 }
 const restores=[replace('navigator',{mediaDevices:{getUserMedia(request:{audio:boolean}){if(!request.audio)return new Promise(()=>{});const r=deferred<MediaStream>();requests.push(r);return r.promise;}}}),replace('AudioContext',Context),replace('AudioWorkletNode',Node)];
 const grant=(i:number)=>{const t={stops:0,stop(){this.stops++;}};tracks[i]=t;requests[i]!.resolve({getTracks:()=>[t],getAudioTracks:()=>[t]} as unknown as MediaStream);};
 return {requests,contexts,tracks,grant,restore(){restores.reverse().forEach(f=>f());}};
}
for(const failed of ['microphone','module','resume'] as const)test(`parallel ${failed} failure keeps its own stage and clears other late resources`,async()=>{
 const h=environment(),c=new AbortController(),opening=new BrowserCaptureDriver(options).open(c.signal);
 const expected=failed==='microphone'?'get_user_media':failed==='module'?'audio_worklet':'audio_resume';
 try{
  const rejected=assert.rejects(opening,e=>e instanceof CaptureError&&e.failure.stage===expected);
  const target=failed==='microphone'?h.requests[0]!:failed==='module'?h.contexts[0]!.module:h.contexts[0]!.activation;
  target.reject(new DOMException('synthetic failure','NotAllowedError'));await rejected;assert.equal(h.contexts[0]!.closes,1);
  if(failed!=='microphone')h.grant(0);h.contexts[0]!.module.resolve();h.contexts[0]!.activation.resolve();await tick();
  assert.equal(h.contexts[0]!.connected,false);assert.equal(h.contexts[0]!.node,undefined);if(failed!=='microphone')assert.equal(h.tracks[0]!.stops,1);
 }finally{c.abort();h.restore();}
});
test('old cancellation and late permission do not close a newer turn context or erase its first PCM',async()=>{
 const h=environment(),old=new AbortController(),current=new AbortController();let session:Awaited<ReturnType<BrowserCaptureDriver['open']>>|undefined;
 try{
  const first=new BrowserCaptureDriver(options).open(old.signal);const rejected=assert.rejects(first,{name:'AbortError'});old.abort();await rejected;
  const second=new BrowserCaptureDriver(options).open(current.signal);h.grant(1);h.contexts[1]!.module.resolve();h.contexts[1]!.activation.resolve();await tick();
  assert.equal(h.contexts[1]!.connected,true);h.contexts[1]!.node!.port.onmessage?.({data:{started:true,sampleCount:128,samples:new Float32Array(128).fill(.25)}});session=await second;
  h.grant(0);h.contexts[0]!.module.resolve();h.contexts[0]!.activation.resolve();await tick();
  assert.equal(h.tracks[0]!.stops,1);assert.equal(h.contexts[0]!.closes,1);assert.equal(h.contexts[1]!.closes,0);assert.equal(h.tracks[1]!.stops,0);
  const bytes=await session.finish();assert.equal(bytes.audio.length,44+128*2);assert.equal(h.contexts[1]!.closes,1);
 }finally{old.abort();current.abort();session?.stop();h.restore();}
});

test('synchronous context failure still stops a later microphone grant without unhandled rejection',async()=>{
 const h=environment(),restore=replace('AudioContext',class{constructor(){throw Error('synthetic unavailable context');}}),controller=new AbortController();
 try{
  await assert.rejects(new BrowserCaptureDriver(options).open(controller.signal),e=>e instanceof CaptureError&&e.failure.stage==='unknown');
  h.grant(0);await tick();assert.equal(h.tracks[0]!.stops,1);
 }finally{controller.abort();restore();h.restore();}
});
