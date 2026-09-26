import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {ForwardReceipts,publicForward} from '../../harness/receipts.js';
import {HarnessForwarding} from '../../harness/forwarding.js';
import {DesktopWork} from '../../harness/desktop-work.js';
import {isClearUnknownReminderCommand} from '../../harness/local-reminder-intent.js';
import {SqliteProjectIndex} from '../../projects/sqlite-project-index.js';
import {DesktopRuntime,type RuntimePorts} from '../../core/desktop-runtime.js';
import {MemoryMediaStore} from '../../media/store.js';
import {BackendSession,parseWorkAction} from '../../app/backend-session.js';
import type {DesktopWorkState} from '../../contracts/desktop-work.js';
import {WorkSpeech,type WorkStatusNotice} from '../../core/work-speech.js';
import type {TurnScope} from '../../contracts/index.js';
const scope:TurnScope={characterId:'companion',sessionId:'s',turnId:'t',generation:1};
const screenshot='取消掉待核对两项的这个案。';
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function fixture(t:TestContext,draftText?:string){
 const parent=resolve('../../.local/clear-reminders-24/tmp');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'clear-'));
 const file=join(root,'harness-relay.sqlite'),receipts=new ForwardReceipts(file),projects=new SqliteProjectIndex(join(root,'project-index.sqlite'));const states:DesktopWorkState[]=[],notices:WorkStatusNotice[]=[];
 let models=0,sends=0,observes=0;const ids:string[]=[];
 for(const phase of ['unknown','completed','unavailable','unknown','awaiting_confirmation'] as const){const row=receipts.create({text:'Original synthetic '+phase,executor:'codex'});receipts.mutate(row.id,r=>{r.phase=phase;if(phase==='unknown'||phase==='completed')r.confirmedAt='now';if(phase==='completed')r.result='Original result';});if(phase==='unknown')ids.push(row.id);}
 const draft=draftText?receipts.createDraft(scope,draftText,'Synthetic previous clarification'):undefined;
 const forwarding=new HarnessForwarding({receipts,projects,compatible:async()=>true,presetReady:async()=>true,presetId:'synthetic',workspace:root,harness:{probe:async()=>({state:'ready',observedAt:'now',codexDelivery:'unverified'}),createRelaySession:async()=>{sends++;},submitConfirmedOperation:async()=>{sends++;}},codex:{list:()=>[],discover:async()=>({available:true}),send:async()=>{sends++;throw Error('No send');},receipt:async()=>{observes++;throw Error('No external query');}}});
 const work=new DesktopWork({receipts,projects,forwarding,emit:s=>states.push(s),notify:n=>notices.push(n),classify:async()=>{models++;return {kind:'companion'};},interpret:async()=>{models++;return {kind:'companion'};},plan:async()=>{models++;throw Error('No plan');}});await work.start(60000);
 t.after(async()=>{await work.close();await forwarding.close();await projects.close();await rm(root,{recursive:true,force:true});});
 return {work,receipts,forwarding,projects,file,states,notices,ids,draft,get models(){return models;},get sends(){return sends;},get observes(){return observes;},selection:()=>ids.map(id=>({id,expectedVersion:receipts.get(id).version}))};
}
for(const text of ['清除全部待核对提醒','清除所有待核对提醒','清除待核对提醒','把待核对两项清掉',screenshot,' 取消掉 待核对 2 项 的这个案。 ','请帮我清除待核实提醒','隐藏待核对通知','取消待核对两项'])test('strict local positive: '+text,()=>assert.equal(isClearUnknownReminderCommand(text),true));
for(const text of ['不要清除待核对提醒','怎么清除待核对提醒','给Codex写一个清除待核对按钮','取消Codex的任务','能清除待核对提醒吗？','别把待核对两项清掉','我说过清除待核对提醒','清除待核对提醒然后删除记录','开发清除待核对提醒功能','清除所有工程记录'])test('strict local negative: '+text,()=>assert.equal(isClearUnknownReminderCommand(text),false));
test('snapshot clear is atomic, durable and idempotent; raw execution/body remain intact',async t=>{
 const f=await fixture(t),before=f.receipts.list(),selected=f.selection();await f.work.action(parseWorkAction({type:'clear_unknown_reminders',records:selected}));assert.equal(f.receipts.pendingCount(),0);assert.match(f.states.at(-1)!.reminderFeedback!,/已清除 2 项/);
 for(const old of before){const after=f.receipts.get(old.id);const {version,clearedUnknownReminder,...rest}=after;const {version:oldVersion,...original}=old;assert.deepEqual(rest,original);assert.equal(version,oldVersion+(f.ids.includes(old.id)?1:0));}
 const once=f.receipts.list();await f.work.action({type:'clear_unknown_reminders',records:selected});assert.deepEqual(f.receipts.list(),once);
 await f.work.close();await f.forwarding.close();const reopened=new ForwardReceipts(f.file);assert.equal(reopened.pendingCount(),0);assert.equal(reopened.list().filter(r=>publicForward(r).reminderCleared).length,2);reopened.close();assert.equal(f.models+f.sends+f.observes,0);
});
test('stale version refuses entire selection and never reports success',async t=>{
 const f=await fixture(t),selection=f.selection();f.receipts.mutate(f.ids[1]!,r=>{r.phase='completed';r.result='New result';});await f.work.action({type:'clear_unknown_reminders',records:selection});assert.equal(f.receipts.pendingCount(),1);assert.equal(publicForward(f.receipts.get(f.ids[0]!)).reminderCleared,undefined);assert.match(f.states.at(-1)!.reminderFeedback!,/已变化/);
});
test('clear one retains the other; refresh metadata does not resurrect, new task/result is visible',async t=>{
 const f=await fixture(t);await f.work.action({type:'clear_unknown_reminders',records:f.selection().slice(0,1)});assert.equal(f.receipts.pendingCount(),1);f.receipts.mutate(f.ids[0]!,r=>{r.detail='Same unknown, later observation';});assert.equal(f.receipts.pendingCount(),1);
 const fresh=f.receipts.create({text:'New independent task'});f.receipts.mutate(fresh.id,r=>{r.phase='unknown';r.confirmedAt='now';});assert.equal(f.receipts.pendingCount(),2);
 f.receipts.mutate(f.ids[0]!,r=>{r.phase='completed';r.result='Actual new result';});await f.work.action({type:'refresh'});assert.equal(publicForward(f.receipts.get(f.ids[0]!)).reminderCleared,undefined);assert.ok(f.states.at(-1)!.requests.some(r=>r.result==='Actual new result'));
});
test('local control beats even stale card binding; exact mistaken draft closes, unrelated draft survives',async t=>{
 const f=await fixture(t,screenshot);f.work.beginInput(scope,{draftId:f.draft!.id,draftVersion:999});assert.equal(await f.work.route(scope,screenshot,new AbortController().signal),'handled');assert.equal(f.receipts.draft(f.draft!.id).status,'dismissed');assert.equal(f.receipts.draft(f.draft!.id).text,screenshot);assert.equal(f.receipts.drafts().length,1);assert.equal(f.models+f.sends,0);assert.equal(f.states.at(-1)!.stage,'idle');assert.equal(f.notices.at(-1)!.kind,'local_control');
 const g=await fixture(t,'整理文献目录');g.work.beginInput(scope,{draftId:g.draft!.id,draftVersion:g.draft!.version});await g.work.route(scope,'清除待核对提醒',new AbortController().signal);assert.equal(g.receipts.draft(g.draft!.id).status,'open');assert.equal(g.models,0);
});
test('aborted or queued stale local input cannot clear reminders',async t=>{
 const f=await fixture(t);const c=new AbortController();c.abort();await assert.rejects(f.work.route(scope,screenshot,c.signal));assert.equal(f.receipts.pendingCount(),2);
 const run=f.work.route(scope,screenshot,new AbortController().signal);f.work.onInput();await assert.rejects(run);assert.equal(f.receipts.pendingCount(),2);assert.equal(f.notices.length,0);
});
for(const kind of ['text','voice','late_voice'] as const)test('actual runtime '+kind+' local control bypasses models/companion writes and cleans media',async t=>{
 const f=await fixture(t,screenshot),media=new MemoryMediaStore(),calls:string[]=[],routes:string[]=[];let release:undefined|(()=>void);
 const ports:RuntimePorts={work:f.work,mediaStore:media,onInputRoute:(_s,r)=>routes.push(r),capture:{start:async()=>{},stop:async()=>{},finish:async s=>({scope:s,audio:await media.put(s,Uint8Array.of(1),'audio/wav'),images:[],inputEndedAt:'now',captureStoppedAt:'now'})},perception:{perceive:async input=>{if(kind==='late_voice')await new Promise<void>(r=>release=r);return {scope:input.scope,status:'complete',transcript:screenshot,modalities:[],cues:[]};}},memory:{append:async()=>{calls.push('append');},context:async()=>{calls.push('context');throw Error('No context');},maintain:async()=>{calls.push('maintain');return [];}},dialogue:{reply:async()=>{calls.push('dialogue');throw Error('No dialogue');}},tts:{synthesize:async()=>{calls.push('tts');throw Error('No TTS');}},playback:{stop:async()=>{},play:async()=>{calls.push('play');}}};const runtime=new DesktopRuntime(ports,()=>{},()=>calls.push('maintenance'));
 await runtime.dispatch(kind==='text'?{type:'submit_text',text:screenshot}:{type:'start_voice'});if(kind!=='text')await runtime.dispatch({type:'finish_voice'});
 if(kind==='late_voice'){for(let n=0;n<30&&!release;n++)await tick();assert.ok(release);await runtime.dispatch({type:'cancel'});release!();}
 await runtime.drain();assert.equal(f.receipts.pendingCount(),kind==='late_voice'?2:0);assert.deepEqual(calls,[]);assert.equal(f.models+f.sends,0);assert.equal(f.receipts.drafts().length,1);assert.equal(media.count,0);if(kind!=='late_voice')assert.deepEqual(routes,['work']);await runtime.close();
});

test('input-start snapshot excludes new unknowns during ASR; different turn cannot consume it',async t=>{
 const f=await fixture(t);f.work.beginInput(scope);const newRow=f.receipts.create({text:'Arrived while user speaks'});f.receipts.mutate(newRow.id,r=>{r.phase='unknown';r.confirmedAt='now';});
 await assert.rejects(f.work.route({...scope,turnId:'other'},screenshot,new AbortController().signal));assert.equal(f.receipts.pendingCount(),3);
 await f.work.route(scope,screenshot,new AbortController().signal);assert.equal(f.receipts.pendingCount(),1);assert.equal(publicForward(f.receipts.get(newRow.id)).reminderCleared,undefined);assert.match(f.states.at(-1)!.reminderFeedback!,/已清除 2 项/);
});

test('local control uses existing bounded work speech text and never speaks task body',async t=>{
 const f=await fixture(t);f.work.beginInput(scope);await f.work.route(scope,'清除待核对提醒',new AbortController().signal);const spoken:string[]=[];const speech=new WorkSpeech({identity:()=>({characterId:scope.characterId,sessionId:scope.sessionId}),busy:()=>false,tts:{synthesize:async reply=>{spoken.push(reply.text);throw Error('Controlled stop before device/audio');}},playback:{stop:async()=>{},play:async()=>{throw Error('No playback');}},media:new MemoryMediaStore(),emit:()=>{}});speech.notify(f.notices.at(-1)!);await speech.drain();assert.deepEqual(spoken,['已清除 2 项待核对提醒，工程记录仍保留。']);await speech.close();
});

test('real renderer button through BackendSession clears actual fixture snapshot and wrong draft while preserving history',async t=>{
 const f=await fixture(t,screenshot);const {app}=await import(new URL('../../../tests/desktop/ui-harness.mjs',import.meta.url).href);const ui=await app({explicitRouting:true});const out:import('../../contracts/desktop-bridge.js').BackendToDesktop[]=[];
 const session=new BackendSession({mediaStore:new MemoryMediaStore(),perception:{perceive:async()=>{throw Error('No device');}},dialogue:{reply:async()=>{throw Error('No dialogue');}},tts:{synthesize:async()=>{throw Error('No TTS');}},memory:{append:async()=>{throw Error('No companion write');},context:async()=>{throw Error('No context');},maintain:async()=>[],maintenanceInput:scope=>({scope,messages:[],relevantMemories:[]})}},m=>out.push(m),()=>{});session.attachWork(f.work);ui.changed(1);let input=0,output=0,state=0;
 const pump=async()=>{for(let n=0;n<12;n++){while(input<ui.messages.length){const m=ui.messages[input++];if(m.name==='desktop')await session.receiveLine(JSON.stringify(m.value.message));}while(output<out.length)await ui.bridge.receive(out[output++],1);while(state<f.states.length)await ui.bridge.receive({channel:'work_state',state:f.states[state++]!},1);await tick();}};
 await pump();ui.node('work-badge').onclick();await pump();ui.node('work-records-open').onclick();assert.equal(ui.node('work-records-dialog').open,true);ui.node('work-reminders-clear').onclick();await pump();assert.equal(f.receipts.pendingCount(),0);assert.equal(f.receipts.draft(f.draft!.id).status,'dismissed');assert.equal(f.receipts.list().length,5);assert.equal(ui.node('work-badge').hidden,true);assert.match(ui.node('work-reminder-feedback').textContent,/已清除 2 项/);assert.match(ui.node('work-records-content').textContent,/结果待核实.*提醒已清除/);
 ui.node('work-records-close').onclick();assert.equal(ui.node('work-actions').hidden,false);ui.node('work-records-open').onclick();assert.equal(ui.node('work-records-dialog').open,true);assert.equal(f.models+f.sends+f.observes,0);assert.equal(ui.harness.playOpens+ui.harness.captureOpens,0);await session.close();
});
