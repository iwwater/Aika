import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WakeManager } from '../../app/wake-manager.js';
import { wakeRoute } from '../../management/wake-routes.js';
import { WAKE_DEFAULT_SETTINGS, type WakeDetector, type WakeToDesktop, type WakeDetectorResult } from '../../contracts/wake.js';
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function fixture(factory?:(settings:unknown)=>Promise<WakeDetector>){
 const dir=await mkdtemp(join(tmpdir(),'pet-wake-')),file=join(dir,'wake.json'),messages:WakeToDesktop[]=[];
 const counters={opens:0,accepts:0,resets:0,closes:0,capturing:[] as boolean[]};
 const detector:WakeDetector={async accept(){counters.accepts++;return {speech:false};},async close(){counters.closes++;},async reset(){counters.resets++;},async setCapturing(x){counters.capturing.push(x);}};
 const options={instanceId:'runtime',file,available:true,createDetector:async(settings:unknown)=>{counters.opens++;return factory?factory(settings):detector;},send:(m:WakeToDesktop)=>messages.push(m)};
 const manager=await WakeManager.open(options);
 return {manager,options,dir,file,messages,counters,detector,async close(){await manager.close();await rm(dir,{recursive:true,force:true});}};
}
function packet(generation:number,sequence:number){return {channel:'wake_pcm',generation,sequence,pcm16Base64:Buffer.alloc(1024).toString('base64')};}
test('off/read/save/reopen never opens detector and only preferences are persisted',async()=>{
 const f=await fixture();try{
  assert.equal(f.manager.snapshot().session.enabled,false);assert.equal(f.counters.opens,0);
  await f.manager.save('runtime',0,{...WAKE_DEFAULT_SETTINGS,keyword:'乐正绫'});
  const data=JSON.parse(await readFile(f.file,'utf8'));assert.deepEqual(Object.keys(data).sort(),['revision','settings','version']);assert.equal(data.settings.keyword,'乐正绫');
  const fresh=await WakeManager.open(f.options);assert.equal(fresh.snapshot().session.enabled,false);assert.equal(fresh.snapshot().revision,1);await fresh.close();assert.equal(f.counters.opens,0);
 }finally{await f.close();}
});
test('explicit enable requires both current instance and revisions; waiting requires observed AEC',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.manager.enable('stale',0,0,true));await assert.rejects(f.manager.enable('runtime',0,1,true));
  const s=await f.manager.enable('runtime',0,0,true);assert.equal(f.counters.opens,1);assert.equal(s.session.phase,'connecting');
  f.manager.receive({channel:'wake_status',generation:s.session.generation,phase:'waiting',echoCancellation:false});await tick();
  assert.equal(f.manager.snapshot().session.enabled,false);assert.equal(f.manager.snapshot().session.phase,'error');assert.equal(f.counters.closes,1);
 }finally{await f.close();}
});
test('disable while loading closes late worker without sending enable',async()=>{
 let complete!:(d:WakeDetector)=>void;const f=await fixture(()=>new Promise(r=>complete=r));
 try{const opening=f.manager.enable('runtime',0,0,true);assert.equal(f.manager.snapshot().session.enabled,true);
  await f.manager.enable('runtime',0,1,false);complete(f.detector);await opening;
  assert.equal(f.counters.closes,1);assert.equal(f.messages.some(m=>m.channel==='wake_control'&&m.enabled),false);assert.equal(f.manager.snapshot().session.enabled,false);
 }finally{await f.close();}
});
test('stale/duplicate PCM is ignored, valid frame acknowledged once without samples in output',async()=>{
 const f=await fixture();try{await f.manager.enable('runtime',0,0,true);
  f.manager.receive({channel:'wake_status',generation:1,phase:'waiting',echoCancellation:true});
  f.manager.receive(packet(0,0));f.manager.receive(packet(1,0));await tick();f.manager.receive(packet(1,0));await tick();
  assert.equal(f.counters.accepts,1);const ack=f.messages.filter(m=>m.channel==='wake_result');assert.equal(ack.length,1);assert.deepEqual(ack[0],{channel:'wake_result',generation:1,sequence:0,samples:512,speech:false});
 }finally{await f.close();}
});
test('PTT pause resets detector and invalidates late keyword; new sequence after resume works',async()=>{
 let complete!:(r:WakeDetectorResult)=>void;const f=await fixture();f.detector.accept=()=>new Promise(r=>complete=r);
 try{await f.manager.enable('runtime',0,0,true);f.manager.receive({channel:'wake_status',generation:1,phase:'waiting',echoCancellation:true});f.manager.receive(packet(1,0));await tick();
  f.manager.receive({channel:'wake_status',generation:1,phase:'paused'});complete({keyword:'乐正绫',speech:true});await tick();
  assert.equal(f.counters.resets,1);assert.equal(f.messages.some(m=>m.channel==='wake_result'),false);
  f.manager.receive({channel:'wake_status',generation:1,phase:'waiting',echoCancellation:true});f.manager.receive(packet(1,1));await tick();complete({speech:false});await tick();assert.equal(f.messages.filter(m=>m.channel==='wake_result').length,1);
 }finally{await f.close();}
});
test('one in-flight limit fails closed and releases local worker',async()=>{
 let complete!:(r:WakeDetectorResult)=>void;const f=await fixture();f.detector.accept=()=>new Promise(r=>complete=r);
 try{await f.manager.enable('runtime',0,0,true);f.manager.receive(packet(1,0));await tick();f.manager.receive(packet(1,1));await tick();complete({speech:true});await tick();
  assert.equal(f.manager.snapshot().session.enabled,false);assert.equal(f.counters.closes,1);assert.equal(f.messages.some(m=>m.channel==='wake_result'),false);
 }finally{await f.close();}
});
test('VAD enabled only in active utterance and reset after submitting; same state idempotent',async()=>{
 const f=await fixture();try{await f.manager.enable('runtime',0,0,true);
  for(const phase of ['waiting','listening','listening','submitting','replying'] as const)f.manager.receive({channel:'wake_status',generation:1,phase,echoCancellation:true});
  await tick();assert.deepEqual(f.counters.capturing,[true,false]);
 }finally{await f.close();}
});
test('preference save stops active stream and stale actions cannot reenable it; bad edits retain bytes',async()=>{
 const f=await fixture();try{await f.manager.save('runtime',0,WAKE_DEFAULT_SETTINGS);const bytes=await readFile(f.file);
  await assert.rejects(f.manager.save('runtime',1,{...WAKE_DEFAULT_SETTINGS,enabled:true}));assert.deepEqual(await readFile(f.file),bytes);
  await f.manager.enable('runtime',1,1,true);await f.manager.save('runtime',1,{...WAKE_DEFAULT_SETTINGS,silenceMs:2500});
  assert.equal(f.manager.snapshot().session.enabled,false);assert.equal(f.manager.snapshot().revision,2);await assert.rejects(f.manager.enable('runtime',1,2,true));
 }finally{await f.close();}
});
test('corrupt existing settings are preserved; wake cannot reset them silently',async()=>{
 const f=await fixture();try{await writeFile(f.file,'invalid',{mode:0o600});await assert.rejects(WakeManager.open(f.options));assert.equal(await readFile(f.file,'utf8'),'invalid');}finally{await f.close();}
});
test('management route separates settings and runtime enable and rejects malformed actions',async()=>{
 const f=await fixture();try{
  const get=await wakeRoute('GET',f.manager,async()=>{throw Error('GET should not read body');});assert.equal(get.session.enabled,false);
  await assert.rejects(wakeRoute('POST',f.manager,async()=>({instanceId:'runtime',expectedRevision:0,enabled:'true'})));
  await wakeRoute('PUT',f.manager,async()=>({instanceId:'runtime',expectedRevision:0,settings:WAKE_DEFAULT_SETTINGS}));assert.equal(f.counters.opens,0);
  const enabled=await wakeRoute('POST',f.manager,async()=>({instanceId:'runtime',expectedRevision:1,expectedGeneration:1,enabled:true}));assert.equal(enabled.session.enabled,true);
 }finally{await f.close();}
});
test('actual loopback wake route requires authorization and origin before opening a detector',async()=>{
 const {startManagementServer}=await import('../../management/server.js');const f=await fixture();
 const server=await startManagementServer({uiRoot:'.',memory:{} as never,settings:{async drain(){}} as never,snapshot:()=>{throw Error('Not used');},wake:f.manager});
 try{
  const body=JSON.stringify({instanceId:'runtime',expectedRevision:0,expectedGeneration:0,enabled:true});
  const url=server.origin+'/api/wake';
  assert.equal((await fetch(url)).status,401);
  const auth={Authorization:'Bearer '+server.token,'Content-Type':'application/json'};
  assert.equal((await fetch(url,{method:'POST',headers:auth,body})).status,403);assert.equal(f.counters.opens,0);
  assert.equal((await fetch(url,{headers:auth})).status,200);assert.equal(f.counters.opens,0);
  const response=await fetch(url,{method:'POST',headers:{...auth,Origin:server.origin},body});assert.equal(response.status,200);assert.equal(f.counters.opens,1);
  assert.equal((await fetch(url,{method:'POST',headers:{...auth,Origin:server.origin},body})).status,409);
 }finally{await server.close();await f.close();}
});
test('cleanup provenance consumes only the current KWS hit once; pause and disable invalidate it',async()=>{
 const f=await fixture();f.detector.accept=async()=>({keyword:'乐正绫',speech:true});
 try{
  await f.manager.enable('runtime',0,0,true);
  f.manager.receive({channel:'wake_status',generation:1,phase:'waiting',echoCancellation:true});
  assert.equal(f.manager.consumeHit({generation:1,sequence:0}),undefined);
  f.manager.receive(packet(1,0));await tick();
  assert.equal(f.manager.consumeHit({generation:0,sequence:0}),undefined);
  assert.equal(f.manager.consumeHit({generation:1,sequence:1}),undefined);
  assert.equal(f.manager.consumeHit({generation:1,sequence:0}),'乐正绫');
  assert.equal(f.manager.consumeHit({generation:1,sequence:0}),undefined);
  f.manager.receive(packet(1,1));await tick();f.manager.receive({channel:'wake_status',generation:1,phase:'paused'});
  assert.equal(f.manager.consumeHit({generation:1,sequence:1}),undefined);
  f.manager.receive({channel:'wake_status',generation:1,phase:'waiting',echoCancellation:true});f.manager.receive(packet(1,2));await tick();
  await f.manager.enable('runtime',0,1,false);assert.equal(f.manager.consumeHit({generation:1,sequence:2}),undefined);
 }finally{await f.close();}
});
