import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {BrowserCaptureDriver} from '../../media/browser-capture.js';
import {PressToTalk} from '../../desktop/press-to-talk.js';

// Deterministic synthetic PCM + actual recorder source; never opens a device or provider.
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred(){let resolve!:()=>void;return {promise:new Promise<void>(r=>resolve=r),resolve:()=>resolve()};}
function replace(name:string,value:unknown){const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});return()=>{if(old)Object.defineProperty(globalThis,name,old);else Reflect.deleteProperty(globalThis,name);};}
function fixture({lateCamera=false,lateJPEG=false,delayFlush=false,cameraFails=false}={}){
 let now=0,connected=false,resumed=false,poll=()=>{},node:NodeStub,processor:Processor;
 const grant=deferred(),module=deferred(),camera=deferred(),cameraGrant=deferred(),jpeg=deferred(),flush=deferred(),events:string[]=[],stops=[0,0],frameBuffers:Uint8Array[]=[];
 if(!lateJPEG)jpeg.resolve();if(!delayFlush)flush.resolve();
 if(!lateCamera)cameraGrant.resolve();
 const tracks=stops.map((_,i)=>({stop(){stops[i]!++;}}));
 const video={videoWidth:320,videoHeight:240,currentTime:0,srcObject:null,async play(){events.push('camera-wait');await camera.promise;if(cameraFails)throw Error('synthetic camera unavailable');events.push('camera-ready');},pause(){}};
 type Processor={process(input:Float32Array[][]):boolean;port:{onmessage:(e:{data:string})=>void}};
 let Recorder!:new()=>Processor;
 runInNewContext(readFileSync(new URL('../../../media/recorder-worklet.mjs',import.meta.url),'utf8'),{
  Float32Array,AudioWorkletProcessor:class{port={onmessage:null,postMessage(data:unknown){node.port.onmessage?.({data});}};},
  registerProcessor(_name:string,ctor:new()=>Processor){Recorder=ctor;}
 });
 class NodeStub{constructor(){node=this;processor=new Recorder();}port={onmessage:null as null|((e:{data:unknown})=>void),close(){},postMessage(data:string){events.push('flush');assert.ok(stops[0]!>0);if(delayFlush)void flush.promise.then(()=>processor.port.onmessage({data}));else processor.port.onmessage({data});}};connect(){}disconnect(){connected=false;}}
 const restores=[replace('performance',{now:()=>now}),replace('setInterval',(f:()=>void)=>{poll=f;return 1;}),replace('clearInterval',()=>{}),
  replace('navigator',{mediaDevices:{async getUserMedia(request:{audio?:boolean;video?:unknown}){if(request.audio){events.push('mic-request');await grant.promise;events.push('mic-granted');return {getTracks:()=>request.video?tracks:[tracks[0]],getAudioTracks:()=>[tracks[0]],getVideoTracks:()=>request.video?[tracks[1]]:[]};}events.push('camera-request');await cameraGrant.promise;return {getTracks:()=>[tracks[1]],getAudioTracks:()=>[],getVideoTracks:()=>[tracks[1]]};}}}),
  replace('AudioContext',class{state='running';sampleRate=24000;destination={};audioWorklet={async addModule(){events.push('module-wait');await module.promise;events.push('module-ready');}};async resume(){resumed=true;events.push('audio-resumed');}async close(){this.state='closed';}createMediaStreamSource(){return {connect(){connected=true;events.push('graph-connected');}};}createGain(){return {gain:{value:1},connect(){}};}}),
  replace('AudioWorkletNode',NodeStub),replace('document',{createElement(kind:string){return kind==='video'?video:{width:0,height:0,getContext(){return {drawImage(){}};},toBlob(cb:(b:Blob)=>void){const bytes=Uint8Array.of(frameBuffers.length+1);frameBuffers.push(bytes);cb({async arrayBuffer(){await jpeg.promise;return bytes.buffer;}} as Blob);}};}})];
 return {grant,module,camera,cameraGrant,jpeg,flush,frameBuffers,events,stops,async advance(ms:number){now+=ms;video.currentTime=now/1000;poll();await tick();},pulse(value:number,length=128){if(connected&&resumed){processor.process([[new Float32Array(length).fill(value)]]);return true;}return false;},restore(){restores.reverse().forEach(f=>f());}};
}
const options={cameraWidth:320,jpegQuality:.75,maxBufferedSamples:24000};
test('Space hold retains onset PCM while camera preview is delayed, then flushes the exact tail on release',async()=>{
 const h=fixture(),controller=new AbortController();let session:Awaited<ReturnType<BrowserCaptureDriver['open']>>|undefined,opening:Promise<void>|undefined,result:Promise<Awaited<ReturnType<NonNullable<typeof session>['finish']>>>|undefined;
 const hold=new PressToTalk({start(){opening=new BrowserCaptureDriver(options).open(controller.signal).then(value=>{session=value;h.events.push('capture-ready');hold.ready();});return true;},finish(){result=session!.finish();},cancel(){controller.abort();}});hold.configure('Space');
 try{
  hold.down('Space');assert.equal(h.pulse(.125),false,'no capture before OS grants devices');
  h.grant.resolve();await tick();assert.equal(h.pulse(.25),false,'no fabricated PCM while recorder module unavailable');
  h.module.resolve();await tick();await h.advance(250);
  h.pulse(.5); // Synthetic first word: audio is ready, but camera.play has not resolved.
  h.camera.resolve();await opening;
  for(let i=0;i<36;i++)await h.advance(34);
  h.pulse(.25,3);hold.up('Space');const captured=await result!;
  const wav=new DataView(captured.audio.buffer,captured.audio.byteOffset,captured.audio.byteLength);
  assert.equal((captured.audio.length-44)/2,131,'first 128 PCM samples must not disappear while waiting for camera preview');
  assert.equal(wav.getInt16(44,true),16384);assert.equal(wav.getInt16(44+128*2,true),8192);assert.ok(captured.images.length<=3);assert.ok(h.stops.every(n=>n>0));
  assert.ok(h.events.indexOf('graph-connected')<h.events.indexOf('camera-ready'));
 }finally{controller.abort();h.grant.resolve();h.module.resolve();h.camera.resolve();await opening?.catch(()=>{});session?.stop();h.restore();}
});

test('microphone can become ready and finish while camera permission or preview is still pending',async()=>{
 for(const lateCamera of [true,false]){
  const h=fixture({lateCamera}),controller=new AbortController();let session:Awaited<ReturnType<BrowserCaptureDriver['open']>>|undefined,ready=false;
  const opening=new BrowserCaptureDriver(options).open(controller.signal).then(s=>{session=s;ready=true;});
  try{
   h.grant.resolve();await tick();h.module.resolve();await tick();h.pulse(.5);await tick();
   assert.equal(ready,true,'camera must not gate microphone readiness');
   h.pulse(.25,3);const captured=await session!.finish();assert.equal(captured.images.length,0);assert.equal(captured.audio.length,44+131*2);assert.ok(h.stops[0]!>0);
   h.cameraGrant.resolve();h.camera.resolve();await tick();assert.ok(h.stops[1]!>0,'late camera tracks close instead of extending the capture window');
  }finally{controller.abort();h.grant.resolve();h.module.resolve();h.cameraGrant.resolve();h.camera.resolve();await opening.catch(()=>{});session?.stop();h.restore();}
 }
});

test('release never waits for JPEG, and its late bytes are erased; unavailable camera keeps audio valid',async()=>{
 for(const cameraFails of [false,true]){
  const h=fixture({lateJPEG:true,cameraFails}),controller=new AbortController();let session:Awaited<ReturnType<BrowserCaptureDriver['open']>>|undefined;
  const opening=new BrowserCaptureDriver(options).open(controller.signal);
  try{
   h.grant.resolve();h.module.resolve();h.camera.resolve();await tick();h.pulse(.5);session=await opening;await tick();
   const captured=await session.finish();assert.equal(captured.images.length,0);assert.equal(captured.audio.length,44+128*2);
   h.jpeg.resolve();await tick();assert.ok(h.frameBuffers.every(b=>b.every(v=>v===0)));assert.ok(h.stops.every(n=>n>0));
  }finally{controller.abort();h.grant.resolve();h.module.resolve();h.cameraGrant.resolve();h.camera.resolve();h.jpeg.resolve();await opening.catch(()=>{});session?.stop();h.restore();}
 }
});
test('release reserves a third current frame, included only if encoded before normal audio drain',async()=>{
 const h=fixture({delayFlush:true}),controller=new AbortController();let session:Awaited<ReturnType<BrowserCaptureDriver['open']>>|undefined;
 const opening=new BrowserCaptureDriver(options).open(controller.signal);
 try{
  h.grant.resolve();h.module.resolve();h.camera.resolve();await tick();h.pulse(.5);session=await opening;await tick();
  await h.advance(1100);await h.advance(10000);assert.equal(h.frameBuffers.length,2,'third slot remains available through a long hold');
  const finished=session.finish();assert.ok(h.stops.every(n=>n>0),'devices stop before JPEG or drain');assert.equal(h.frameBuffers.length,3);await tick();h.flush.resolve();
  const captured=await finished;assert.equal(captured.images.length,3);assert.deepEqual(captured.images.map(i=>i.bytes[0]),[1,2,3]);
 }finally{controller.abort();h.grant.resolve();h.module.resolve();h.cameraGrant.resolve();h.camera.resolve();h.jpeg.resolve();h.flush.resolve();await opening.catch(()=>{});session?.stop();h.restore();}
});
test('release before first PCM cancels the opening and never starts camera or revives on a late frame',async()=>{
 const h=fixture(),controller=new AbortController(),opening=new BrowserCaptureDriver(options).open(controller.signal);
 try{
  h.grant.resolve();h.module.resolve();await tick();assert.equal(h.events.includes('camera-request'),false);
  const rejected=assert.rejects(opening,{name:'AbortError'});controller.abort();await rejected;assert.ok(h.stops[0]!>0);assert.equal(h.pulse(.5),false);
 }finally{controller.abort();h.grant.resolve();h.module.resolve();h.cameraGrant.resolve();h.camera.resolve();h.restore();}
});


test('idle driver does nothing; explicit open prepares the recorder and resumes in parallel with OS permission',async()=>{
 const h=fixture(),controller=new AbortController();let opening:Promise<Awaited<ReturnType<BrowserCaptureDriver['open']>>>|undefined;
 try{
  const driver=new BrowserCaptureDriver(options);await tick();assert.equal(h.events.length,0,'idle must not load/resume contexts or acquire devices');
  opening=driver.open(controller.signal);await tick();
  assert.ok(h.events.includes('module-wait'),'module setup must not wait for microphone grant');
  assert.ok(h.events.includes('audio-resumed'),'explicit-turn activation must overlap OS permission');
  h.module.resolve();await tick();assert.equal(h.pulse(.5),false,'no source connection before OS permission');assert.equal(h.events.includes('camera-request'),false);
  h.grant.resolve();await tick();assert.equal(h.pulse(.5),true,'first available PCM can enter the already prepared graph');
  const session=await opening;h.pulse(.25,3);const captured=await session.finish();assert.equal(captured.audio.length,44+131*2);assert.equal(captured.images.length,0);
 }finally{controller.abort();h.grant.resolve();h.module.resolve();h.cameraGrant.resolve();h.camera.resolve();await opening?.catch(()=>{});h.restore();}
});
