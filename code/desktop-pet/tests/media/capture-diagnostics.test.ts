import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {BrowserCaptureDriver,type CaptureDiagnostic} from '../../media/browser-capture.js';
const tick=()=>new Promise<void>(r=>setImmediate(r));
function replace(name:string,value:unknown){const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{value,configurable:true});return()=>{if(old)Object.defineProperty(globalThis,name,old);else Reflect.deleteProperty(globalThis,name);};}
function recorderFixture(){
 const messages:any[]=[];let Recorder!:new()=>{process(input:Float32Array[][]):boolean;port:{onmessage(e:{data:string}):void}};
 runInNewContext(readFileSync(new URL('../../../media/recorder-worklet.mjs',import.meta.url),'utf8'),{
  Float32Array,AudioWorkletProcessor:class{port={onmessage:null,postMessage:(message:unknown)=>messages.push(message)};},
  registerProcessor(_name:string,ctor:typeof Recorder){Recorder=ctor;}
 });
 return {messages,recorder:new Recorder()};
}
test('real worklet reports first block before any nonzero and retains every zero-prefix and tail sample',()=>{
 const {messages,recorder}=recorderFixture();
 recorder.process([[new Float32Array(128)]]);
 assert.equal(messages[0].started,true);assert.equal(messages[0].firstNonzero,undefined);assert.equal(messages[0].leadingZeroSampleCount,128);
 recorder.process([[new Float32Array(128)]]);assert.equal(messages.length,1,'zero blocks must not create diagnostic spam');
 recorder.process([[Float32Array.of(0,0,.25,-.5)]]);
 assert.equal(messages.length,2);assert.equal(messages[1].firstNonzero,true);assert.equal(messages[1].leadingZeroSampleCount,258);
 recorder.process([[Float32Array.of(.75)]]);assert.equal(messages.length,2);
 recorder.port.onmessage({data:'finish'});
 const pcm=messages.filter(m=>m.samples).flatMap(m=>Array.from(m.samples as Float32Array));
 assert.equal(pcm.length,261);assert.ok(pcm.slice(0,258).every(v=>v===0));assert.deepEqual(pcm.slice(258),[.25,-.5,.75]);
 const end=messages.at(-1);assert.equal(end.finished,true);assert.equal(end.nonzeroObserved,true);assert.equal(end.leadingZeroSampleCount,258);
 const count=messages.length;recorder.port.onmessage({data:'finish'});assert.equal(recorder.process([[Float32Array.of(1)]]),false);assert.equal(messages.length,count);
});
test('all-zero turn finishes normally and reports the total zero prefix without inventing a nonzero event',()=>{
 const {messages,recorder}=recorderFixture();
 for(let i=0;i<20;i++)recorder.process([[new Float32Array(128)]]);
 recorder.port.onmessage({data:'finish'});
 assert.equal(messages.filter(m=>m.firstNonzero).length,0);
 assert.equal(messages.at(-1).nonzeroObserved,false);assert.equal(messages.at(-1).leadingZeroSampleCount,2560);
 assert.equal(messages.filter(m=>m.samples).reduce((n,m)=>n+m.samples.length,0),2560);
 assert.equal(messages.length,4,'started + two buffers + finish only');
});
test('first nonzero counts recorded mono after channel averaging, including tiny noise, not semantic speech',()=>{
 const {messages,recorder}=recorderFixture();
 recorder.process([[new Float32Array(128).fill(.5),new Float32Array(128).fill(-.5)]]);
 assert.equal(messages[0].firstNonzero,undefined);
 recorder.process([[Float32Array.of(0,1e-12)]]);
 assert.equal(messages[1].firstNonzero,true);assert.equal(messages[1].leadingZeroSampleCount,129);
 recorder.port.onmessage({data:'finish'});
 assert.equal(messages.at(-2).samples[129],Math.fround(1e-12));
});
test('same-block onset coalesces with started notification and has zero prefix',()=>{
 const {messages,recorder}=recorderFixture();recorder.process([[Float32Array.of(.5)]]);
 assert.equal(messages.length,1);assert.equal(messages[0].started,true);assert.equal(messages[0].firstNonzero,true);assert.equal(messages[0].leadingZeroSampleCount,0);
});

test('driver emits bounded safe phase/count metadata and rejects late diagnostics after cancellation',async()=>{
 let now=0,node:NodeStub|undefined,micStops=0,closes=0;
 const diagnostics:CaptureDiagnostic[]=[];
 let grant!:(stream:unknown)=>void;const microphone=new Promise(r=>{grant=r;});
 class Context{state='running';sampleRate=24000;destination={};audioWorklet={async addModule(){}};async resume(){}async close(){closes++;this.state='closed';}createMediaStreamSource(){return {connect(){}};}createGain(){return {gain:{value:0},connect(){}};}}
 class NodeStub{constructor(){node=this;}connect(){}disconnect(){}port={onmessage:null as ((e:{data:any})=>void)|null,close(){},postMessage(){}};}
 const restores=[replace('performance',{now:()=>now}),replace('navigator',{mediaDevices:{getUserMedia:({audio}:{audio:boolean})=>audio?microphone:new Promise(()=>{})}}),replace('AudioContext',Context),replace('AudioWorkletNode',NodeStub)];
 const c=new AbortController();
 try{
  const driver=new BrowserCaptureDriver({cameraWidth:320,jpegQuality:.8,maxBufferedSamples:24000,onDiagnostic:e=>diagnostics.push(e)});
  await tick();assert.equal(diagnostics.length,0,'constructor remains idle with no resources or diagnostics');
  let ready=false;const opening=driver.open(c.signal).then(s=>{ready=true;return s;});
  await tick();assert.ok(diagnostics.some(e=>e.phase==='context_created'));assert.ok(!diagnostics.some(e=>e.phase==='graph_connected'));
  now=50;const track={stop(){micStops++;}};grant({getTracks:()=>[track],getAudioTracks:()=>[track]});await tick();
  assert.equal(diagnostics.find(e=>e.phase==='graph_connected')?.elapsedMs,50);
  now=54;node!.port.onmessage!({data:{started:true,sampleCount:128,leadingZeroSampleCount:128}});await tick();
  assert.equal(ready,true,'all-zero PCM readiness must not become gated on nonzero or camera');const session=await opening;
  assert.equal(diagnostics.find(e=>e.phase==='first_pcm')?.nonzeroObserved,false);
  now=310;const handler=node!.port.onmessage!;handler({data:{firstNonzero:true,leadingZeroSampleCount:6144}});
  const nonzero=diagnostics.find(e=>e.phase==='first_nonzero_pcm');assert.equal(nonzero?.elapsedMs,310);assert.equal(nonzero?.leadingZeroSampleCount,6144);assert.equal(nonzero?.sampleRate,24000);assert.equal(nonzero?.nonzeroObserved,true);
  handler({data:{firstNonzero:true,leadingZeroSampleCount:6144}});assert.equal(diagnostics.filter(e=>e.phase==='first_nonzero_pcm').length,1);
  for(const e of diagnostics)assert.ok(Object.keys(e).every(k=>['phase','elapsedMs','firstBlockSampleCount','flushedSampleCount','leadingZeroSampleCount','nonzeroObserved','sampleRate'].includes(k)));
  const count=diagnostics.length;c.abort();assert.equal(diagnostics.at(-1)?.phase,'stopped');session.stop();handler({data:{firstNonzero:true,leadingZeroSampleCount:999}});
  assert.equal(diagnostics.length,count+1,'one terminal diagnostic, no late updates');assert.equal(micStops,1);assert.equal(closes,1);
 }finally{c.abort();restores.reverse().forEach(f=>f());}
});


test('nonfinite synthetic input cannot be reported as a verified signal prefix',()=>{
 const {messages,recorder}=recorderFixture();recorder.process([[Float32Array.of(0,NaN)]]);recorder.process([[Float32Array.of(.5)]]);recorder.port.onmessage({data:'finish'});
 assert.equal(messages.filter(m=>m.firstNonzero).length,0);assert.equal(messages.at(-1).leadingZeroSampleCount,null);
});

for(const mode of ['false','true','missing','throws','nonboolean'] as const)test('echo-off trial requests only one constraint and safely reads actual setting: '+mode,async()=>{
 const diagnostics:CaptureDiagnostic[]=[],requests:unknown[]=[];let node:any,stops=0,reads=0;
 const track={stop(){stops++;},getSettings(){reads++;if(mode==='throws')throw Error('Synthetic settings failure');return {echoCancellation:mode==='false'?false:mode==='true'?true:mode==='nonboolean'?'false':undefined,get deviceId(){throw Error('Do not read private fields');},get label(){throw Error('Do not read labels');}};}};
 const restores=[replace('navigator',{mediaDevices:{getUserMedia(c:any){requests.push(c);return c.audio?Promise.resolve({getAudioTracks:()=>[track],getTracks:()=>[track]}):new Promise(()=>{});}}}),replace('AudioContext',class{state='running';sampleRate=48000;destination={};audioWorklet={async addModule(){}};async resume(){}async close(){this.state='closed';}createMediaStreamSource(){return {connect(){}};}createGain(){return {gain:{value:0},connect(){}};}}),replace('AudioWorkletNode',class{constructor(){node=this;}port={onmessage:null as any,close(){},postMessage(){}};connect(){}disconnect(){}})];
 const c=new AbortController();
 try{
  const opening=new BrowserCaptureDriver({cameraWidth:320,jpegQuality:.8,maxBufferedSamples:24000,onDiagnostic:e=>diagnostics.push(e)}).open(c.signal);await tick();
  assert.deepEqual(requests,[{audio:{echoCancellation:false},video:false}]);assert.equal(reads,1);
  const granted=diagnostics.find(e=>e.phase==='microphone_granted')!;assert.ok(granted);
  if(mode==='false'||mode==='true')assert.equal(granted.echoCancellation,mode==='true');else assert.equal(Object.hasOwn(granted,'echoCancellation'),false,'unknown must be omitted, never guessed false');
  assert.equal(Object.hasOwn(diagnostics[0]!,'echoCancellation'),false);assert.ok(!JSON.stringify(diagnostics).includes('deviceId'));assert.ok(!JSON.stringify(diagnostics).includes('label'));
  const deliver=node.port.onmessage;deliver({data:{started:true,sampleCount:128,leadingZeroSampleCount:128}});const session=await opening;
  assert.deepEqual(requests[1],{audio:false,video:{width:{ideal:320}}});assert.ok(diagnostics.some(e=>e.phase==='audio_ready'),'settings failure or zero input must not gate readiness');
  c.abort();session.stop();const count=diagnostics.length;deliver({data:{firstNonzero:true,leadingZeroSampleCount:128}});assert.equal(diagnostics.length,count);assert.equal(stops,1);assert.equal(reads,1);
 }finally{c.abort();restores.reverse().forEach(f=>f());}
});
