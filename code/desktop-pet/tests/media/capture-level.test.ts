import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {BrowserCaptureDriver, type CaptureLevel} from '../../media/browser-capture.js';
const source=readFileSync(new URL('../../../media/recorder-worklet.mjs',import.meta.url),'utf8');
function processor(rate=48000,enabled=true){let Recorder:any;const messages:any[]=[];
 runInNewContext(source,{sampleRate:rate,Float32Array,AudioWorkletProcessor:class{port={onmessage:null,postMessage(v:any){messages.push(v);}};},registerProcessor(_name:string,c:any){Recorder=c;}});
 return {recorder:new Recorder({processorOptions:{captureLevels:enabled}}),messages};
}
for(const rate of [24000,44100,48000,96000])test('same mono PCM first envelope and bounded cadence at '+rate,()=>{
 const {recorder:r,messages:m}=processor(rate);const block=[new Float32Array(128).fill(.5),new Float32Array(128).fill(-.25)];
 r.process([block]);const first=m.find(x=>x.level);assert.equal(first.level.rms,.125);assert.equal(first.level.peak,.125);assert.ok(m.some(x=>x.started));assert.equal(m.some(x=>x.samples),false,'first level need not wait for2048 flush');
 for(let n=1;n<Math.ceil(rate/128);n++)r.process([block]);const levels=m.filter(x=>x.level);assert.ok(levels.length>=15&&levels.length<=25);
 r.port.onmessage({data:'finish'});const before=m.length;assert.equal(r.process([block]),false);assert.equal(m.length,before);
 const chunks=m.filter(x=>x.samples).map(x=>x.samples);assert.equal(chunks.reduce((n,x)=>n+x.length,0),128*Math.ceil(rate/128));assert.ok(chunks.every(x=>[...x].every(v=>v===.125)));
});
test('real zero PCM remains zero; optional feedback never changes audio packets',()=>{
 const a=processor(),b=processor(48000,false);for(let n=0;n<32;n++){const input=[[new Float32Array(128)]];a.recorder.process(input);b.recorder.process(input);}
 assert.ok(a.messages.filter(x=>x.level).every(x=>x.level.rms===0&&x.level.peak===0));assert.equal(b.messages.some(x=>x.level),false);
 assert.deepEqual(JSON.parse(JSON.stringify(a.messages.filter(x=>!x.level))),JSON.parse(JSON.stringify(b.messages)));a.recorder.port.onmessage({data:'finish'});b.recorder.port.onmessage({data:'finish'});
});
test('invalid PCM cannot fabricate a finite envelope',()=>{const f=processor();f.recorder.process([[Float32Array.of(NaN)]]);assert.equal(f.messages.some(x=>x.level),false);});
function replace(key:string,value:unknown){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value});return ()=>old?Object.defineProperty(globalThis,key,old):Reflect.deleteProperty(globalThis,key);}
const tick=()=>new Promise<void>(r=>setImmediate(r));
for(const ending of ['finish','abort','stop','processor-error'] as const)test('driver releases local levels on '+ending+' without altering PCM drain',async()=>{
 let node:any;const levels:CaptureLevel[]=[],phases:string[]=[];let stopped=0;
 const restore=[replace('navigator',{mediaDevices:{async getUserMedia(c:any){return {getAudioTracks:()=>c.audio?[{}]:[],getVideoTracks:()=>[],getTracks:()=>[{stop(){stopped++;}}]};}}}),
 replace('AudioContext',class{state='running';sampleRate=48000;destination={};audioWorklet={async addModule(){}};async resume(){}async close(){this.state='closed';}createMediaStreamSource(){return {connect(){}};}createGain(){return {gain:{value:0},connect(){}};}}),
 replace('AudioWorkletNode',class{constructor(_c:any,_name:any,options:any){assert.equal(options.processorOptions.captureLevels,true);node=this;}port={onmessage:null as any,close(){},postMessage(){node.port.onmessage?.({data:{level:{rms:.9,peak:1},samples:Float32Array.of(.5),finished:true}});}};onprocessorerror:any;connect(){}disconnect(){}})];
 try{const stop=new AbortController();const opened=new BrowserCaptureDriver({cameraWidth:640,jpegQuality:.8,maxBufferedSamples:10000,onLevel:l=>{levels.push(l);if(ending==='finish')throw Error('Synthetic display failure');},onDiagnostic:d=>phases.push(d.phase)}).open(stop.signal);await tick();const deliver=node.port.onmessage;
 deliver({data:{started:true,sampleCount:128,level:{rms:0,peak:0}}});const session=await opened;assert.deepEqual(levels,[{rms:0,peak:0}]);
 deliver({data:{level:{rms:.2,peak:.4}}});assert.equal(levels.length,2);deliver({data:{level:{rms:NaN,peak:1}}});assert.equal(levels.length,2);
 if(ending==='finish')await session.finish();else if(ending==='abort')stop.abort();else if(ending==='stop')session.stop();else node.onprocessorerror();
 deliver({data:{level:{rms:1,peak:1},samples:Float32Array.of(.2)}});assert.equal(levels.length,2);assert.ok(phases.includes('stopped'));assert.ok(stopped>=1);
 }finally{restore.reverse().forEach(f=>f());}
});
