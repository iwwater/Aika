import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {BackendSession} from '../../app/backend-session.js';
import {DesktopWork} from '../../harness/desktop-work.js';
import {ForwardReceipts} from '../../harness/receipts.js';
import {HarnessForwarding} from '../../harness/forwarding.js';
import {SqliteProjectIndex} from '../../projects/sqlite-project-index.js';
import {MemoryMediaStore} from '../../media/store.js';
import type {BackendToDesktop} from '../../contracts/desktop-bridge.js';
import type {DesktopWorkState} from '../../contracts/desktop-work.js';
async function fixture(t:TestContext){
 const parent=fileURLToPath(new URL('../../../../../.local/work-records-23/tmp/',import.meta.url));await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'record-entry-'));
 const receipts=new ForwardReceipts(join(root,'harness-relay.sqlite')),projects=new SqliteProjectIndex(join(root,'project-index.sqlite'));
 const task=randomUUID(),unknown:string[]=[],outputs:BackendToDesktop[]=[],states:DesktopWorkState[]=[];let dispatches=0,observations=0;
 const phases=['unknown','completed','unavailable','unavailable','completed','unknown','awaiting_confirmation','completed','awaiting_confirmation'] as const;
 for(const [n,phase]of phases.entries()){const r=receipts.create({text:'Synthetic record '+n,executor:'codex',target:{hostId:'local',threadId:task,title:'Synthetic target'},plan:{title:'记录 '+n,reason:'Fixture'}});receipts.mutate(r.id,row=>{row.phase=phase;if(['unknown','completed'].includes(phase)){row.confirmedAt='2026-09-15T00:00:00.000Z';row.appTurnId='synthetic-turn-'+n;row.dispatchAttempted=true;}if(phase==='completed')row.result='Synthetic completed result';});if(phase==='unknown')unknown.push(r.id);}
 const forwarding=new HarnessForwarding({receipts,projects,compatible:async()=>true,presetReady:async()=>true,presetId:'desktop-pet-relay-v1',workspace:root,harness:{probe:async()=>({state:'ready',observedAt:'now',codexDelivery:'unverified'}),createRelaySession:async()=>{dispatches++;throw Error('Must not dispatch');},submitConfirmedOperation:async()=>{dispatches++;throw Error('Must not dispatch');}},codex:{list:()=>[{threadId:task,hostId:'local',title:'Synthetic target',projectPath:root}],discover:async()=>({available:true}),send:async()=>{dispatches++;throw Error('Must not dispatch');},receipt:async(_thread,turn)=>{observations++;return {threadId:task,turnId:turn,status:'unknown'};}}});
 const session=new BackendSession({mediaStore:new MemoryMediaStore(),perception:{async perceive(){throw Error('No device');}},dialogue:{async reply(){throw Error('No model');}},tts:{async synthesize(){throw Error('No TTS');}},memory:{async append(){throw Error('No companion write');},async context(){throw Error('No companion read');},async maintain(){return [];},maintenanceInput(scope){return {scope,messages:[],relevantMemories:[]};}}},m=>outputs.push(m),()=>{});
 const work=new DesktopWork({receipts,projects,forwarding,classify:async()=>{throw Error('No classifier');},emit:s=>{states.push(s);outputs.push({channel:'work_state',state:s});}});session.attachWork(work);await work.start(60000);
 t.after(async()=>{await session.close();await forwarding.close();await projects.close();await rm(root,{recursive:true,force:true});});
 return {session,work,receipts,outputs,states,unknown,get observations(){return observations;},get dispatches(){return dispatches;}};
}
test('restored actual record snapshot keeps nine records and two unknown pending; refresh acknowledges without dispatch or companion activity',async t=>{
 const f=await fixture(t),before=f.states.at(-1)!;assert.equal(before.stage,'idle');assert.equal(before.draft,undefined);assert.equal(before.activeRequestId,undefined);assert.equal(before.requests.length,9);assert.equal(before.pendingCount,2);const ids=before.requests.map(r=>r.id);
 await f.session.receiveLine(JSON.stringify({channel:'work_action',action:{type:'refresh',id:f.unknown[0]}}));const next=f.states.at(-1)!;assert.ok(next.sequence>before.sequence);assert.deepEqual(next.requests.map(r=>r.id),ids);assert.equal(next.pendingCount,2);assert.equal(f.observations,1);assert.equal(f.dispatches,0);assert.equal(f.outputs.some(m=>['play','capture_start','capture_stop'].includes(m.channel)),false);
});
test('real backend snapshot and desktop badge open the independent history on the first click, preserving chat and read-only refresh',async t=>{
 const f=await fixture(t);const {app}=await import(new URL('../../../tests/desktop/ui-harness.mjs',import.meta.url).href);const a=await app({explicitRouting:true});a.changed(1);let input=0,output=0;
 const pump=async()=>{for(let n=0;n<5;n++){while(input<a.messages.length){const m=a.messages[input++];if(m.name==='desktop')await f.session.receiveLine(JSON.stringify(m.value.message));}while(output<f.outputs.length)await a.bridge.receive(f.outputs[output++],1);await new Promise<void>(r=>setImmediate(r));}};
 await pump();assert.match(a.node('work-badge').textContent,/待核对 2 项/);const chat=a.node('reply').textContent;a.node('work-badge').onclick();await pump();assert.equal(a.node('work-records-dialog').open,true,'first badge click must open records, not an empty current-task card');
 for(const r of f.states.at(-1)!.requests)assert.ok(a.node('work-record-'+r.id));assert.match(a.node('work-records-content').textContent,/结果待核实/);assert.match(a.node('work-records-content').textContent,/已完成/);assert.match(a.node('work-records-content').textContent,/本次未完成/);assert.equal(a.node('reply').textContent,chat);
 const sequence=f.states.at(-1)!.sequence;a.node('work-record-'+f.unknown[0]).open=true;a.node('work-record-refresh-'+f.unknown[0]).onclick();await pump();assert.ok(f.states.at(-1)!.sequence>sequence);assert.match(a.node('work-records-feedback').textContent,/已收到更新/);assert.equal(a.node('work-records-dialog').open,true);assert.equal(f.dispatches,0);assert.equal(a.harness.playOpens,0);assert.equal(a.node('reply').textContent,chat);
});

test('every pending counted record remains visible beyond the recent ten and fifty historical rows',async t=>{
 const f=await fixture(t);await new Promise(r=>setTimeout(r,2));
 for(let n=0;n<60;n++){const r=f.receipts.create({text:'Synthetic later history '+n,executor:'codex'});f.receipts.mutate(r.id,row=>{row.phase='completed';row.result='Synthetic historical result';});}
 await f.work.action({type:'refresh'});const state=f.states.at(-1)!;assert.equal(state.pendingCount,2);assert.equal(state.requests.length,52,'recent fifty plus two older pending records');for(const id of f.unknown)assert.ok(state.requests.some(r=>r.id===id&&r.phase==='unknown'));assert.equal(f.dispatches,0);
});
