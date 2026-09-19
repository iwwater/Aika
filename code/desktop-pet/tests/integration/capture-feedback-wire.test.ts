import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {readFileSync} from 'node:fs';
import {BackendSession} from '../../app/backend-session.js';
import {BrowserCaptureDriver} from '../../media/browser-capture.js';
import {MemoryMediaStore} from '../../media/store.js';
import type {BackendToDesktop} from '../../contracts/desktop-bridge.js';
const tick=()=>new Promise<void>(r=>setImmediate(r));
function replace(key:string,value:unknown){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value});return ()=>old?Object.defineProperty(globalThis,key,old):Reflect.deleteProperty(globalThis,key);}
test('real recorder and driver feed only scoped local UI levels; finish preserves bridge and rejects late waveform',async()=>{
 const {app}=await import(new URL('../../../tests/desktop/ui-harness.mjs',import.meta.url).href);
 const ui=await app({explicitRouting:true}),media=new MemoryMediaStore(),output:BackendToDesktop[]=[],errors:unknown[]=[];let node:any,Recorder:any,audioRequests=0,perceptions=0,uiIndex=0,outIndex=0;
 runInNewContext(readFileSync(new URL('../../../media/recorder-worklet.mjs',import.meta.url),'utf8'),{sampleRate:48000,Float32Array,AudioWorkletProcessor:class{port={onmessage:null,postMessage(data:any){node.port.onmessage?.({data});}};},registerProcessor(_name:string,c:any){Recorder=c;}});
 const restore=[replace('navigator',{mediaDevices:{async getUserMedia(c:any){if(c.audio)audioRequests++;return {getAudioTracks:()=>c.audio?[{}]:[],getVideoTracks:()=>[],getTracks:()=>[{stop(){}}]};}}}),
 replace('AudioContext',class{state='running';sampleRate=48000;destination={};audioWorklet={async addModule(){}};async resume(){}async close(){this.state='closed';}createMediaStreamSource(){return {connect(){}};}createGain(){return {gain:{value:0},connect(){}};}}),
 replace('AudioWorkletNode',class{recorder:any;constructor(_c:any,_name:any,options:any){node=this;this.recorder=new Recorder(options);}port={onmessage:null as any,close(){},postMessage(data:any){node.recorder.port.onmessage({data});}};connect(){}disconnect(){}})];
 const session=new BackendSession({mediaStore:media,
  perception:{async perceive(input){perceptions++;return {scope:input.scope,status:'complete',transcript:'合成录音',modalities:[],cues:[]};}},
  tts:{async synthesize(){throw Error('No TTS allowed');}},dialogue:{async reply(){throw Error('No model allowed');}},memory:{async append(){throw Error('No companion persistence');},async context(){throw Error('No companion context');},async maintain(){throw Error('No maintenance');},maintenanceInput(scope){return {scope,messages:[],relevantMemories:[]};}}
 },m=>output.push(m),()=>{});
 session.attachWork({async route(){return 'handled';},async action(){},onInput(){},async close(){}});
 const launch=(p:Promise<unknown>)=>{void p.catch(e=>errors.push(e));};
 const pump=async(done:()=>boolean)=>{for(let n=0;n<200;n++){
  while(uiIndex<ui.messages.length){const m=ui.messages[uiIndex++];if(m.name==='desktop')launch(session.receiveLine(JSON.stringify(m.value.message)));}
  while(outIndex<output.length)launch(ui.bridge.receive(JSON.parse(JSON.stringify(output[outIndex++])),1));await tick();assert.deepEqual(errors,[]);
  if(done()&&uiIndex===ui.messages.length&&outIndex===output.length)return;
 }assert.fail('Capture feedback bridge did not settle');};
 try{
  ui.changed(1);await pump(()=>!ui.node('voice').disabled);assert.equal(audioRequests,0);
  ui.node('voice').onclick();assert.equal(ui.node('capture-feedback').dataset.phase,'connecting');assert.equal(ui.harness.feedbackAtSend.phase,'connecting');
  await pump(()=>ui.harness.captureOpens===1);const oldLevel=ui.harness.captureLevel;
  const actual=new BrowserCaptureDriver({cameraWidth:640,jpegQuality:.8,maxBufferedSamples:100000,onLevel:oldLevel,onDiagnostic:ui.harness.captureDiagnostic});
  const opening=actual.open(ui.harness.captureSignal);await tick();assert.equal(audioRequests,1);assert.equal(ui.node('capture-feedback').dataset.phase,'connecting');
  node.recorder.process([[new Float32Array(128)]]);ui.frame(100);assert.equal(ui.node('capture-feedback').dataset.phase,'recording');assert.equal(ui.node('capture-connecting').hidden,true);assert.equal(ui.node('capture-wave').hidden,false);
  const flat=ui.node('capture-wave-path').d;ui.harness.openCapture(await opening);await pump(()=>ui.node('status').textContent.includes('正在听'));
  for(let n=0;n<25;n++)node.recorder.process([[new Float32Array(128).fill(.25)]]);ui.frame(200);assert.notEqual(ui.node('capture-wave-path').d,flat);
  const oldDeliver=node.port.onmessage;ui.node('voice').onclick();assert.equal(ui.node('capture-feedback').hidden,true,'release clears before finishing RPC');
  await pump(()=>perceptions===1&&media.count===0);await session.drain();oldLevel({rms:1,peak:1});oldDeliver({data:{level:{rms:1,peak:1}}});ui.frame(300);
  assert.equal(ui.node('capture-feedback').hidden,true);assert.equal(ui.node('capture-wave-path').d,'');assert.equal(audioRequests,1);
  assert.equal(JSON.stringify(ui.messages).includes('"rms"'),false);assert.equal(JSON.stringify(ui.messages).includes('"peak"'),false);assert.equal(ui.harness.playOpens,0);
 }finally{ui.changed(1,'disconnected');await session.close();restore.reverse().forEach(f=>f());}
});
