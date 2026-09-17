import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BackendSession} from '../../app/backend-session.js';
import {MemoryMediaStore} from '../../media/store.js';
import {ForwardReceipts} from '../../harness/receipts.js';
import {HarnessForwarding} from '../../harness/forwarding.js';
import {DesktopWork} from '../../harness/desktop-work.js';
import {SqliteProjectIndex} from '../../projects/sqlite-project-index.js';
import {WorkIntentClassifier} from '../../providers/work-intent.js';
import type {ProviderTransport} from '../../providers/transport.js';
import type {BackendToDesktop} from '../../contracts/desktop-bridge.js';
const tick=()=>new Promise<void>(r=>setImmediate(r));
test('actual UI/backend/SQLite voice answer, spoken arrangement and collapsed-card confirmation dispatch once',async()=>{
 const {app}=await import(new URL('../../../tests/desktop/ui-harness.mjs',import.meta.url).href);
 const parent=resolve('../../.local/work-voice-15/tmp');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'wire-'));
 const ui=await app({explicitRouting:true}),media=new MemoryMediaStore(),out:BackendToDesktop[]=[],errors:unknown[]=[],companion:string[]=[],spoken:string[]=[];
 const receipts=new ForwardReceipts(join(dir,'harness-relay.sqlite')),projects=new SqliteProjectIndex(join(dir,'project-index.sqlite'));
 const target=randomUUID();let sends=0,prompts=0,plans=0,interpretPosts=0,asr='在合成项目做同样任务',uiIndex=0,outIndex=0;
 const forwarding=new HarnessForwarding({receipts,projects,compatible:async()=>true,presetReady:async()=>true,presetId:'synthetic',workspace:dir,
  harness:{probe:async()=>({state:'ready',observedAt:'now',codexDelivery:'unverified'}),createRelaySession:async()=>{},submitConfirmedOperation:async()=>{prompts++;}},
  codex:{list:()=>[{threadId:target,hostId:'local',title:'合成研究任务',projectPath:dir}],discover:async()=>({available:true}),send:async(_target,text)=>{assert.equal(_target,target);assert.equal(text,'在合成项目只读整理文献目录');sends++;return {threadId:target,turnId:randomUUID(),requestId:randomUUID()};},receipt:async()=>{throw Error('No real receipt');}}});
 const classifier=new WorkIntentClassifier({endpoint:'https://synthetic.invalid',model:'synthetic',apiKey:()=>'',authorizer:{async authorize(){return {async settle(){}};}}},{request:async()=>{interpretPosts++;return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({kind:'supplement',text:'在合成项目只读整理文献目录',question:'',executionAuthorized:false})}}]};}} as unknown as ProviderTransport);
 const session=new BackendSession({mediaStore:media,perception:{async perceive(input){return {scope:input.scope,status:'complete',transcript:asr,modalities:[],cues:[]};}},
  tts:{async synthesize(reply){spoken.push(reply.text);return {...reply,audio:await media.put(reply.scope,Uint8Array.of(1,2),'audio/wav'),durationMs:20,synchronization:'amplitude'};}},
  dialogue:{async reply(){throw Error('No companion response');}},memory:{async append(_s,m){companion.push(...m.map(x=>x.text));},async context(){throw Error('No memory');},async maintain(){throw Error('No maintenance');},maintenanceInput(scope){return {scope,messages:[],relevantMemories:[]};}}
 },m=>out.push(m),()=>{});
 const work=new DesktopWork({receipts,projects,forwarding,classify:async()=>({kind:'clarify',question:'是只读整理文献目录吗？'}),interpret:classifier.interpret.bind(classifier),
  plan:async(_scope,text)=>{plans++;return {kind:'ready',executor:'codex',title:'整理文献',text,reason:'用户指定',targetId:target,spokenSummary:'只读整理文献目录，保留原资料'};},emit:state=>out.push({channel:'work_state',state}),notify:n=>session.notifyWork(n)});
 session.attachWork(work);
 const launch=(p:Promise<unknown>)=>{void p.catch(e=>errors.push(e));};
 const pump=async(done:()=>boolean)=>{for(let n=0;n<250;n++){
  while(uiIndex<ui.messages.length){const m=ui.messages[uiIndex++];if(m.name==='desktop')launch(session.receiveLine(JSON.stringify(m.value.message)));}
  while(outIndex<out.length)launch(ui.bridge.receive(JSON.parse(JSON.stringify(out[outIndex++])),1));
  await tick();assert.deepEqual(errors,[]);if(done()&&uiIndex===ui.messages.length&&outIndex===out.length)return;
 }assert.fail('Voice integration did not settle');};
 const state=()=>out.filter((m):m is Extract<BackendToDesktop,{channel:'work_state'}>=>m.channel==='work_state').at(-1)!.state;
 const playToEnd=async()=>{const before=ui.harness.playOpens;await pump(()=>ui.harness.playOpens>before||!!ui.harness.playback);const p=out.filter((m):m is Extract<BackendToDesktop,{channel:'play'}>=>m.channel==='play').at(-1)!;
  ui.harness.playback.emit({type:'started',audioId:p.tts.audio.id,at:new Date().toISOString()});await pump(()=>true);
  ui.harness.playback.emit({type:'ended',at:new Date().toISOString()});ui.harness.playback.session.stop();await pump(()=>media.count===0);ui.harness.playback=undefined;};
 const voice=async(text:string)=>{asr=text;const opens=ui.harness.captureOpens;ui.node('voice').onclick();await pump(()=>ui.harness.captureOpens>opens);
  ui.harness.openCapture({stop(){},async finish(){return {audio:Uint8Array.of(1,2,3),images:[],captureStoppedAt:new Date().toISOString()};}});await pump(()=>ui.node('status').textContent.includes('正在听'));
  ui.node('voice').onclick();await pump(()=>out.some(m=>m.channel==='event'&&m.event.type==='transcript'&&m.event.text===text));};
 try{
  await work.start(60000);ui.changed(1);await pump(()=>!ui.node('voice').disabled);
  await voice(asr);await pump(()=>state().stage==='clarifying');const draft=state().draft!.id;await playToEnd();
  await voice('是的，保留原资料');await pump(()=>state().stage==='confirming');await playToEnd();
  assert.equal(state().draft!.id,draft);assert.equal(receipts.drafts().length,1);assert.equal(prompts,0);assert.equal(plans,1);assert.equal(interpretPosts,1);
  assert.deepEqual(state().sourceInput!.conversation?.map(m=>m.text),['是只读整理文献目录吗？','是的，保留原资料']);
  ui.node('work-hide').onclick();await voice('确认');await pump(()=>sends===1);assert.equal(plans,1);assert.equal(interpretPosts,1);
  const commands=ui.messages.filter((m:any)=>m.value?.message?.channel==='command').map((m:any)=>m.value.message.command);
  assert.equal(commands.filter((c:any)=>c.type==='start_voice').at(-1).workBinding.draftId,draft);
  const requests=receipts.list();assert.equal(requests.length,1);await work.action({type:'confirm',id:requests[0]!.id,expectedVersion:1});assert.equal(prompts,0);assert.equal(sends,1);
  assert.deepEqual(companion,[]);assert.ok(spoken.some(s=>s.includes('是只读整理')));assert.ok(spoken.some(s=>s.includes('保留原资料')));
  assert.equal(ui.messages.some((m:any)=>m.value?.message?.channel==='work_action'&&m.value.message.action.type==='confirm'),false);
 }finally{ui.changed(1,'disconnected');await session.close();await work.close();await forwarding.close();await projects.close();await rm(dir,{recursive:true,force:true});}
});
