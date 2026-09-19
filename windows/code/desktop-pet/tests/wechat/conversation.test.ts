import test,{type TestContext} from 'node:test';
import {ManagementError} from '../../contracts/management.js';
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm,realpath } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BackendSession,type BackendPorts } from '../../app/backend-session.js';
import { WeChatTextConversation } from '../../wechat/conversation.js';
import { WeChatStore } from '../../wechat/store.js';
import { ForwardReceipts } from '../../harness/receipts.js';
import { HarnessForwarding } from '../../harness/forwarding.js';
import { SqliteProjectIndex } from '../../projects/sqlite-project-index.js';
import { DesktopWork } from '../../harness/desktop-work.js';
import { WorkPlanner } from '../../providers/work-plan.js';
import { WorkIntentClassifier } from '../../providers/work-intent.js';
import { ProviderTransport, type EndpointConfig } from '../../providers/transport.js';
import { MemoryMediaStore } from '../../media/store.js';
import type { TurnScope } from '../../contracts/index.js';
import type { WorkContinuationIntent,WorkInputBinding,WorkPlan } from '../../contracts/desktop-work.js';
import type { WeChatReplyContext } from '../../wechat/service.js';
const signal=new AbortController().signal;
async function fixture(t:TestContext, actual?: {planner:WorkPlanner;classifier:WorkIntentClassifier}){
 const parent=resolve('../../.local/wechat-21/tmp');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(await realpath(parent),'conversation-'));
 const store=new WeChatStore(join(root,'channel.sqlite')),projects=new SqliteProjectIndex(join(root,'project-index.sqlite'));
 const task=randomUUID(),turn=randomUUID(),sends:string[]=[],replies:string[]=[],saved:{text:string;scope:TurnScope}[]=[],events:string[]=[];
 let completed=false,continuation:WorkContinuationIntent={kind:'confirm'},accept=true,replyWait:(()=>Promise<void>)|undefined;
 const ports:BackendPorts={mediaStore:new MemoryMediaStore(),perception:{async perceive(){throw Error('no physical capture');}},tts:{async synthesize(){throw Error('no TTS');}},
  memory:{async append(scope,rows){saved.push(...rows.map(r=>({text:r.text,scope})));},async context(scope){return {scope,characterPrompt:'Original companion',recent:[],summary:'',memories:[],perception:null,inputTokenBudget:4000};},maintenanceInput(scope){return {scope,messages:[],relevantMemories:[]};},async maintain(){return [];}},
  dialogue:{async reply(input){await replyWait?.();return {scope:input.scope,text:'陪伴回复：'+input.text,expression:{emotion:'neutral',intensity:0,delivery:'natural',gesture:null}};}}};
 const forwarding=(receipts:ForwardReceipts)=>new HarnessForwarding({receipts,projects,compatible:async()=>true,presetReady:async()=>true,presetId:'desktop-pet-relay-v1',workspace:root,
  harness:{probe:async()=>({state:'ready',observedAt:'now',codexDelivery:'unverified'}),createRelaySession:async()=>{throw Error('no extra Harness');},submitConfirmedOperation:async()=>{throw Error('no relay prompt');}},
  codex:{list:()=>[{threadId:task,hostId:'local',title:'Existing synthetic target',projectPath:root}],discover:async()=>({available:true}),send:async(_target,text)=>{sends.push(text);return {threadId:task,turnId:turn,requestId:randomUUID()};},receipt:async()=>({threadId:task,turnId:turn,status:completed?'completed':'unknown',reply:'原轮准确结果'})}});
 const file=join(root,'wechat','harness-relay.sqlite');const receipts=new ForwardReceipts(file),forward=forwarding(receipts);
 const modelReads:string[]=[];
 const classifier=actual?.classifier??{classify:async(_s:TurnScope,text:string)=>(modelReads.push('classify:'+text),text.startsWith('任务')?{kind:'work' as const}:{kind:'companion' as const}),interpret:async(_s:TurnScope,text:string)=>(modelReads.push('interpret:'+text),text.startsWith('聊天')?{kind:'companion' as const}:continuation)};
 let planOverride:(()=>Promise<WorkPlan>)|undefined;
 const planner=actual?.planner??{plan:async(_s:TurnScope,text:string):Promise<WorkPlan>=>planOverride?planOverride():({kind:'ready',executor:'codex',title:'受控任务',text,reason:'Explicit target',targetId:task})};
 const contexts:{text:string;context:WeChatReplyContext|undefined}[]=[];
 const options={key:'synthetic-channel',store,ports,receipts,forwarding:forward,projects,classifier,planner,send:async(text:string,_id:string,context?:WeChatReplyContext)=>{replies.push(text);contexts.push({text,context});return accept;}};
 const conversation=await new WeChatTextConversation(options).start();
 const desktopReceipts=new ForwardReceipts(join(root,'desktop','harness-relay.sqlite')),desktopForward=forwarding(desktopReceipts);
 const desktopWork=new DesktopWork({receipts:desktopReceipts,forwarding:desktopForward,projects,classify:classifier.classify,interpret:classifier.interpret,plan:planner.plan,emit:()=>{}});await desktopWork.start(60000);
 const desktop=new BackendSession({...ports,outputMode:'text'},m=>events.push(m.channel),()=>{});desktop.attachWork(desktopWork);
 const extraCleanup:(()=>Promise<unknown>)[]=[];
 t.after(async()=>{for(const close of extraCleanup.reverse())await close();await conversation.close();await desktop.close();await desktopForward.close();await projects.close();store.close();await rm(root,{recursive:true,force:true});});
 const receive=(text:string,binding:WorkInputBinding|undefined=conversation.capture(),createdAt?:number)=>conversation.receive({text,messageId:randomUUID(),...(createdAt!==undefined?{createdAt}:{})},binding,signal);
 return {onCleanup:(close:()=>Promise<unknown>)=>{extraCleanup.push(close);},setPlanOverride:(v:(()=>Promise<WorkPlan>)|undefined)=>{planOverride=v;},root,store,projects,ports,modelReads,conversation,receipts,forward,forwarding,options,contexts,desktop,desktopWork,desktopReceipts,sends,replies,saved,events,receive,setContinuation:(v:WorkContinuationIntent)=>{continuation=v;},setCompleted:()=>{completed=true;},setAccept:(v:boolean)=>{accept=v;},setReplyWait:(v:(()=>Promise<void>)|undefined)=>{replyWait=v;}};
}
test('real session/work/receipt classes: companion chat, separate desktop card, full WeChat card, exact once direct confirmation and query',async t=>{
 const f=await fixture(t);
 await f.desktop.receiveLine(JSON.stringify({channel:'command',command:{type:'submit_text',text:'任务 desktop pending'}}));await f.desktop.drainForeground();const desktop=f.desktopReceipts.list()[0]!;assert.equal(desktop.phase,'awaiting_confirmation');
 await f.receive('聊天今天开心');assert.equal(f.replies.at(-1),'陪伴回复：聊天今天开心');assert.deepEqual(f.saved.map(r=>r.text),['聊天今天开心','陪伴回复：聊天今天开心']);
 await f.receive('任务 完整正文\n保留约束');const binding=f.conversation.capture();assert.ok(binding?.requestId);assert.match(f.replies.at(-1)!,/任务 完整正文\n保留约束/);assert.match(f.replies.at(-1)!,/Existing synthetic target/);assert.equal(f.sends.length,0);
 await f.receive('确认',binding,1);assert.equal(f.sends.length,0,'pre-card timestamp cannot confirm');
 await f.receive('确认');assert.deepEqual(f.sends,['任务 完整正文\n保留约束']);assert.equal(f.desktopReceipts.get(desktop.id).phase,'awaiting_confirmation');
 await f.receive('确认',binding);assert.equal(f.sends.length,1);assert.equal(f.conversation.capture(),undefined,'old confirmed binding no longer blocks ordinary chat');
 await f.receive('聊天继续');assert.equal(f.replies.at(-1),'陪伴回复：聊天继续');assert.equal(f.saved.length,4);assert.ok(f.saved.every(r=>!r.text.includes('任务')));
 f.setCompleted();await f.receive('查询任务结果');assert.match(f.replies.at(-1)!,/原轮准确结果/);assert.equal(f.receipts.get(binding.requestId).phase,'completed');assert.equal(f.sends.length,1);
 assert.equal(f.events.some(e=>['play','capture_start','capture_stop','stop'].includes(e)),false);
});
test('failed outgoing card cannot authorize confirmation; supplement invalidates old card and cancellation sends nothing',async t=>{
 const f=await fixture(t);f.setAccept(false);await f.receive('任务 first');assert.equal(f.conversation.capture(),undefined);await f.receive('确认');assert.equal(f.sends.length,0);
 f.setAccept(true);await f.receive('确认');const old=f.conversation.capture();assert.ok(old);assert.equal(f.sends.length,0);
 f.setContinuation({kind:'supplement',text:'任务 revised',executionAuthorized:false});await f.receive('补充');const fresh=f.conversation.capture();assert.ok(fresh);assert.notEqual(fresh.requestId,old.requestId);
 f.setContinuation({kind:'confirm'});await f.receive('确认',old);assert.equal(f.sends.length,0);f.setContinuation({kind:'cancel'});await f.receive('取消',fresh);assert.equal(f.sends.length,0);assert.equal(f.receipts.draft(fresh.draftId).status,'dismissed');assert.equal(f.conversation.capture(),undefined);
});
test('text cancellation creates no device acknowledgement waits and does not cancel the other session',async t=>{
 const f=await fixture(t);let release!:()=>void,started=false;
 f.setReplyWait(()=>new Promise<void>(r=>{release=r;started=true;}));
 const abort=new AbortController();const run=f.conversation.receive({text:'聊天等待',messageId:randomUUID()},undefined,abort.signal);
 while(!started)await new Promise<void>(r=>setImmediate(r));abort.abort();release();await assert.rejects(run);assert.equal(f.replies.length,0);
 f.setReplyWait(undefined);await f.desktop.receiveLine(JSON.stringify({channel:'command',command:{type:'submit_text',text:'desktop survives'}}));await f.desktop.drainForeground();
 assert.equal(f.saved.at(-1)?.text,'陪伴回复：desktop survives');assert.equal(f.events.some(e=>['play','capture_start','capture_stop','stop'].includes(e)),false);
});
test('reply context follows each input and confirmed task, never the most recent unrelated chat',async t=>{
 const f=await fixture(t),voice={source:'voice',replyMode:'follow_input'} as const,text={source:'text',replyMode:'follow_input'} as const;
 const receive=(value:string,replyContext:WeChatReplyContext)=>f.conversation.receive({text:value,messageId:randomUUID(),replyContext},f.conversation.capture(),signal);
 await receive('任务 synthetic target',text);assert.deepEqual(f.contexts.at(-1)?.context,text);const binding=f.conversation.capture()!;
 await receive('确认',voice);assert.ok(f.contexts.filter(x=>x.text.includes('正在发送')).every(x=>x.context?.source==='voice'));
 assert.deepEqual(f.store.get('reply-context:synthetic-channel:'+binding.requestId),voice);
 await receive('聊天继续',text);assert.deepEqual(f.contexts.at(-1)?.context,text);
 f.setCompleted();await (f.conversation as any).work.observe();await new Promise(r=>setImmediate(r));
 assert.deepEqual(f.contexts.find(x=>x.text.includes('原轮准确结果'))?.context,voice);
 await receive('查询任务结果',text);assert.deepEqual(f.contexts.at(-1)?.context,text);assert.equal(f.sends.length,1);
});

test('same everyday input reaches companion on desktop and WeChat before and during pending work without changing cards',async t=>{
 const f=await fixture(t),text='下午好，现在帮我查一下现在是几点了';f.setContinuation({kind:'companion'});
 const desktop=async(value:string)=>{await f.desktop.receiveLine(JSON.stringify({channel:'command',command:{type:'submit_text',text:value}}));await f.desktop.drainForeground();};
 await f.receive(text);await desktop(text);assert.equal(f.receipts.drafts().length,0);assert.equal(f.desktopReceipts.drafts().length,0);
 await f.receive('任务 synthetic pending');await desktop('任务 desktop pending');
 const before=JSON.stringify([f.receipts.drafts(),f.receipts.list(),f.desktopReceipts.drafts(),f.desktopReceipts.list()]);
 const card=f.conversation.capture();assert.ok(card);
 await f.receive(text,card);await desktop(text);
 assert.equal(JSON.stringify([f.receipts.drafts(),f.receipts.list(),f.desktopReceipts.drafts(),f.desktopReceipts.list()]),before);
 assert.equal(f.replies.at(-1),'陪伴回复：'+text);assert.equal(f.saved.filter(r=>r.text===text).length,4);assert.equal(f.sends.length,0);
});

for(const stage of ['plan','target','prepare'] as const)test('initial planning failure sends one channel reply and keeps safe stage: '+stage,async t=>{
 const f=await fixture(t);
 if(stage==='plan')f.setPlanOverride(async()=>{throw Error('private provider body must not persist');});
 if(stage==='target')f.setPlanOverride(async()=>({kind:'ready',executor:'codex',title:'synthetic',text:'synthetic',reason:'synthetic',targetId:'missing-synthetic-id'}));
 if(stage==='prepare')f.forward.prepareDraft=async()=>{throw Error('private prepare details');};
 await f.conversation.receive({text:'任务 synthetic failing request',messageId:randomUUID(),replyContext:{source:'voice',replyMode:'follow_input'}},undefined,signal);
 assert.deepEqual(f.contexts[0]?.context,{source:'voice',replyMode:'follow_input'});
 assert.equal(f.replies.length,1);assert.match(f.replies[0]!,/未发送|没有发送|没整理好/);
 assert.equal(f.sends.length,0);assert.equal(f.saved.length,0);assert.equal(f.receipts.list().length,0);
 const d=f.receipts.drafts()[0]!;assert.equal(d.status,'open');assert.ok(d.question);assert.equal((d as any).lastPlanningFailure?.stage,stage);
 assert.ok(!JSON.stringify(d).includes('private'));assert.equal(d.conversation?.at(-1)?.text,f.replies[0]);
});
test('unscoped command rejection returns one response for current input without a model or task',async t=>{
 const f=await fixture(t);await f.conversation.receive({text:'synthetic invalid envelope',messageId:'invalid/id'},undefined,signal);
 assert.equal(f.replies.length,1);assert.match(f.replies[0]!,/未完成|没有完成/);assert.equal(f.sends.length,0);assert.equal(f.saved.length,0);
});

test('cancelled planner late failure produces no response under the following input identity',async t=>{
 const f=await fixture(t);let reject!:(e:Error)=>void,started=false;
 f.setPlanOverride(()=>new Promise((_resolve,r)=>{reject=r;started=true;}));
 const abort=new AbortController(),run=f.conversation.receive({text:'任务 synthetic held plan',messageId:randomUUID()},undefined,abort.signal);
 while(!started)await new Promise(r=>setImmediate(r));abort.abort();reject(Error('late private failure'));await assert.rejects(run);
 assert.equal(f.replies.length,0);f.setPlanOverride(undefined);f.setContinuation({kind:'companion'});
 await f.receive('聊天 fresh input');assert.deepEqual(f.replies,['陪伴回复：聊天 fresh input']);assert.equal(f.sends.length,0);
});

test('known preparation conflict keeps actionable safe reason without dispatch',async t=>{
 const f=await fixture(t);f.forward.prepareDraft=async()=>{throw new ManagementError('version_conflict','项目目录已变化，请重新整理任务卡。');};
 await f.receive('任务 synthetic project conflict');assert.equal(f.replies.length,1);assert.match(f.replies[0]!,/项目目录已变化/);assert.match(f.replies[0]!,/没有发送/);assert.equal(f.sends.length,0);assert.equal(f.receipts.drafts()[0]?.lastPlanningFailure?.stage,'prepare');
});

// B37: exercise the actual conversation and durable receipt selection, with no model/dispatch on a query.
async function queryFixture(t:TestContext){
 const f=await fixture(t);clearInterval((f.conversation as any).work.timer);
 await f.receive('任务 seed');await f.receive('确认');const seed=f.receipts.list()[0]!;
 f.receipts.mutate(seed.id,r=>{r.confirmedAt='2026-01-01T00:00:00.000Z';r.phase='completed';r.result='old result';r.plan={title:'old task',reason:'synthetic'};});
 const reads:string[]=[];const refresh=f.forward.refreshReceipt.bind(f.forward);f.forward.refreshReceipt=async id=>{reads.push(id);return refresh(id);};
 const beforeModelReads=f.modelReads.length;
 const add=(title:string,confirmedAt:string,receipts=f.receipts)=>{const row=receipts.create({text:title,target:seed.target!,executor:'codex',plan:{title,reason:'synthetic'}});return receipts.mutate(row.id,r=>{r.confirmedAt=confirmedAt;r.phase='completed';r.result=title+' result';r.appTurnId=seed.appTurnId!;});};
 return {...f,seed,reads,add,modelCalls:()=>f.modelReads.length-beforeModelReads};
}
for(const command of ['查询任务进度','查询任务结果','查询','查询！','查看工作状态','查询任务的进度','查询一下任务进度','/任务'])test('B37 default query selects only latest confirmed task: '+command,async t=>{
 const f=await queryFixture(t);const latest=f.add('latest task','2026-02-01T00:00:00.000Z');
 f.add('older dispatch created later','2026-01-02T00:00:00.000Z');
 f.receipts.mutate(f.seed.id,r=>{r.result='older updated after latest';});
 f.receipts.create({text:'new unconfirmed',executor:'harness'});
 await f.receive(command);assert.match(f.replies.at(-1)!,/latest task/);assert.doesNotMatch(f.replies.at(-1)!,/old task|older dispatch|new unconfirmed/);
 assert.deepEqual(f.reads,[latest.id]);assert.equal(f.modelCalls(),0);assert.equal(f.sends.length,1);
});
for(const command of ['查询所有任务进度','全部任务','查询全部任务结果'])test('B37 explicit-all returns all channel dispatches, including beyond old5and50limits: '+command,async t=>{
 const f=await queryFixture(t);for(let i=0;i<54;i++)f.add('item-'+i,new Date(Date.UTC(2026,1,1,0,0,i)).toISOString());
 f.add('foreign desktop','2026-03-01T00:00:00.000Z',f.desktopReceipts);
 await f.receive(command);assert.match(f.replies.at(-1)!,/old task/);assert.match(f.replies.at(-1)!,/item-0 result/);assert.match(f.replies.at(-1)!,/item-53 result/);assert.doesNotMatch(f.replies.at(-1)!,/foreign desktop/);assert.equal(f.reads.length,55);assert.equal(f.modelCalls(),0);assert.equal(f.sends.length,1);
});
test('B37 no dispatch query replies locally; does not start or confirm pending work',async t=>{
 const f=await fixture(t);clearInterval((f.conversation as any).work.timer);await f.receive('任务 pending');const binding=f.conversation.capture();const before=JSON.stringify(f.receipts.list());
 await f.receive('查询');assert.match(f.replies.at(-1)!,/还没有.*已派发/);assert.equal(JSON.stringify(f.receipts.list()),before);assert.deepEqual(f.conversation.capture(),binding);assert.equal(f.sends.length,0);
});
test('B37 restart retains latest dispatch and isolates another WeChat channel',async t=>{
 const f=await queryFixture(t);const latest=f.add('persistent latest','2026-03-01T00:00:00.000Z');await f.conversation.close();
 const receipts=new ForwardReceipts(join(f.root,'wechat','harness-relay.sqlite'));const forward=f.forwarding(receipts);
 const restarted=await new WeChatTextConversation({...f.options,receipts,forwarding:forward}).start();clearInterval((restarted as any).work.timer);
 f.onCleanup(()=>restarted.close());await restarted.receive({text:'查询',messageId:randomUUID()},undefined,signal);assert.match(f.replies.at(-1)!,/persistent latest/);assert.equal(receipts.get(latest.id).phase,'completed');
 const otherReceipts=new ForwardReceipts(join(f.root,'other-wechat','harness-relay.sqlite')),otherForward=f.forwarding(otherReceipts),otherReplies:string[]=[];
 const other=await new WeChatTextConversation({...f.options,key:'other-channel',receipts:otherReceipts,forwarding:otherForward,send:async text=>{otherReplies.push(text);return true;}}).start();clearInterval((other as any).work.timer);f.onCleanup(()=>other.close());
 await other.receive({text:'查询全部任务结果',messageId:randomUUID()},undefined,signal);assert.match(otherReplies.at(-1)!,/还没有.*已派发/);assert.doesNotMatch(otherReplies.at(-1)!,/persistent latest/);assert.equal(f.sends.length,1);
});

test('B37 approval query and notice identify task/session and safe tool summary only',async t=>{
 const f=await queryFixture(t);const r=f.add('approval target','2026-04-01T00:00:00.000Z');
 f.receipts.mutate(r.id,row=>{row.executor='harness';row.phase='accepted';row.nativeStatus='approval';row.harnessSessionId='session-approval-synthetic';(row as any).nativeApprovalTools=['bash'];row.detail='private reason/args must not surface';row.nativeSessionUrl='http://127.0.0.1:19000/?token=private-secret';});
 await f.receive('查询');const text=f.replies.at(-1)!;assert.match(text,/approval target/);assert.match(text,/session-approval-synthetic/);assert.match(text,/bash/);assert.match(text,/终端命令/);assert.doesNotMatch(text,/private|token=|danger-full-access/);
 await (f.conversation as any).notice({kind:'approval',id:r.id,executor:'harness'});assert.equal(f.replies.at(-1),text.replace(/^1\. /,''));
 f.receipts.mutate(r.id,row=>{delete (row as any).nativeApprovalTools;delete row.nativeSessionUrl;});await f.receive('查询');assert.match(f.replies.at(-1)!,/未提供.*工具|工具.*未提供/);assert.match(f.replies.at(-1)!,/原生/);assert.equal(f.sends.length,1);
});

test('B37 named status query uses matching channel receipt or honest local missing reply, never dispatch',async t=>{
 const f=await queryFixture(t);const named=f.add('查看编导agent进展','2026-02-01T00:00:00.000Z');f.add('unrelated newer','2026-03-01T00:00:00.000Z');
 await f.receive('查看编导agent进展');assert.match(f.replies.at(-1)!,/查看编导agent进展/);assert.doesNotMatch(f.replies.at(-1)!,/unrelated newer/);assert.deepEqual(f.reads,[named.id]);
 await f.receive('查询未派发目标的任务进度');assert.match(f.replies.at(-1)!,/没有.*匹配.*回执/);assert.equal(f.modelCalls(),0);assert.equal(f.sends.length,1);
});
test('B37 failed read preserves selected task and labels saved result; no resends',async t=>{
 const f=await queryFixture(t);const row=f.add('selected cached','2026-03-01T00:00:00.000Z');f.forward.refreshReceipt=async()=>{throw Error('private read failure');};
 await f.receive('查询');assert.match(f.replies.at(-1)!,/selected cached/);assert.match(f.replies.at(-1)!,/已保存状态/);assert.doesNotMatch(f.replies.at(-1)!,/private read failure/);assert.equal(f.receipts.get(row.id).phase,'completed');assert.equal(f.sends.length,1);
});

test('B37 named query ambiguity offers candidates; compound request is not swallowed as status',async t=>{
 const f=await queryFixture(t);const a=f.add('共享任务','2026-02-01T00:00:00.000Z'),b=f.add('共享任务','2026-03-01T00:00:00.000Z');
 f.receipts.mutate(b.id,r=>{r.target={threadId:randomUUID(),hostId:'local',title:'different target'};});
 await f.receive('查询共享任务进度');assert.match(f.replies.at(-1)!,/多个匹配/);assert.ok(f.replies.at(-1)!.includes(a.id)&&f.replies.at(-1)!.includes(b.id));assert.equal(f.reads.length,0);assert.equal(f.modelCalls(),0);
 await f.receive('查询任务进度并修改任务状态');assert.ok(f.modelCalls()>0);assert.doesNotMatch(f.replies.at(-1)!,/没有.*匹配.*回执/);
});
test('B37 approval tool fields propagate through forwarding and clear after terminal receipt',async t=>{
 const f=await queryFixture(t);const r=f.add('native pending','2026-05-01T00:00:00.000Z');f.receipts.mutate(r.id,row=>{row.executor='harness';row.phase='accepted';row.harnessSessionId='session-forward-test';delete row.result;});
 let completed=false;(f.forward as any).options.nativeWork={workReceipt:async()=>completed?{status:'failed',detail:'cancelled in native'}:{status:'approval',approvalTools:['bash','private-tool-secret'],sessionUrl:'http://127.0.0.1:19000/',detail:'private reason'}};
 await f.receive('查询');assert.deepEqual((f.receipts.get(r.id) as any).nativeApprovalTools,['bash']);assert.match(f.replies.at(-1)!,/http:\/\/127.0.0.1:19000/);assert.doesNotMatch(f.replies.at(-1)!,/private/);
 completed=true;await f.receive('查询');assert.equal(f.receipts.get(r.id).phase,'unavailable');assert.equal((f.receipts.get(r.id) as any).nativeApprovalTools,undefined);assert.doesNotMatch(f.replies.at(-1)!,/等待原生 Harness 工具批准/);assert.equal(f.sends.length,1);
});

test('B37 exact Codex target title takes priority over newer Harness wrapper plan',async t=>{
 const f=await queryFixture(t);const exact=f.add('原有编导工作','2026-02-01T00:00:00.000Z');f.receipts.mutate(exact.id,r=>{r.target={threadId:randomUUID(),hostId:'local',title:'编导agent'};});
 const wrapper=f.add('查看编导agent进展','2026-03-01T00:00:00.000Z');f.receipts.mutate(wrapper.id,r=>{r.executor='harness';r.harnessSessionId='session-wrong-wrapper';delete r.target;});
 await f.receive('查看编导agent进展');assert.match(f.replies.at(-1)!,/原有编导工作/);assert.doesNotMatch(f.replies.at(-1)!,/多个匹配|查看编导agent进展/);assert.deepEqual(f.reads,[exact.id]);assert.equal(f.modelCalls(),0);
});

// B40: actual provider parser, planner and work/channel classes; synthetic HTTP/executor only.
function replanModels(){
 const calls:{kind:string;data:any}[]=[];let fail=true,wrong=false;
 const endpoint:EndpointConfig={endpoint:'https://api.deepseek.com/chat/completions',model:'deepseek-flash',apiKey:()=> 'synthetic',authorizer:{async authorize(){return {async settle(){}};}}};
 const transport=new ProviderTransport((async (_url,init)=>{
  const body=JSON.parse(String(init?.body)),data=JSON.parse(body.messages[1].content),kind=data.request!==undefined?'plan':data.pending?'interpret':'classify';calls.push({kind,data});
  const output=kind==='plan'?(fail?{bad:'synthetic malformed plan'}:{kind:'ready',executor:'harness',title:'查找论文',text:'检索graph algorithms论文并列原文来源',reason:'用户指定DeepSeek Harness',targetId:'',projectId:'',projectVersion:0,question:'',spokenSummary:'用DeepSeek Harness查找论文并列原文来源'}):kind==='classify'?{kind:data.currentInput.includes('DeepSeek')?'work':'companion',question:''}:{kind:data.currentInput==='取消'?'cancel':'clarify',text:'',question:data.currentInput==='取消'?'':'你指的重新整理是什么？',executionAuthorized:false};
  if(kind==='plan' && !fail && wrong){Object.assign(output,{executor:'codex',targetId:data.targets[0]?.threadId});}
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}),{status:200});
 }) as typeof fetch);
 return {calls,classifier:new WorkIntentClassifier(endpoint,transport),planner:new WorkPlanner(endpoint,transport),recover(){fail=false;},wrongExecutor(value:boolean){wrong=value;}};
}
for(const text of ['重新整理','重新整理。','请重新整理任务卡！'])test('B40 explicit retry replans failed Harness draft without interpreting or sending: '+text,async t=>{
 const m=replanModels(),f=await fixture(t,m),original='用DeepSeek Harness检索graph algorithms论文并列原文来源';await f.receive(original);const old=f.receipts.drafts()[0]!;assert.equal(old.lastPlanningFailure?.stage,'plan');m.recover();await f.receive(text);
 const d=f.receipts.draft(old.id),row=f.receipts.list()[0];assert.equal(d.status,'prepared');assert.equal(d.originalText,original);assert.equal(row?.executor,'harness');assert.equal(f.receipts.drafts().length,1);assert.equal(f.sends.length,0);assert.equal(row?.confirmedAt,undefined);
 assert.equal(m.calls.filter(c=>c.kind==='interpret').length,0);assert.deepEqual(m.calls.filter(c=>c.kind==='plan').map(c=>c.data.request),[original,original]);assert.match(f.replies.at(-1)!,/安排给 DeepSeek Harness/);assert.equal(d.lastPlanningFailure,undefined);
});
test('B40 prepared replan preserves executor and requires fresh confirmation',async t=>{
 const m=replanModels();m.recover();const f=await fixture(t,m);await f.receive('用DeepSeek Harness检索graph algorithms论文并列原文来源');const old=f.conversation.capture()!;await f.receive('重新整理');const fresh=f.conversation.capture()!;
 assert.notEqual(fresh.requestId,old.requestId);assert.equal(f.receipts.get(old.requestId!).phase,'unavailable');assert.equal(f.receipts.get(fresh.requestId!).executor,'harness');assert.ok(m.calls.filter(c=>c.kind==='plan').every(c=>c.data.request.includes('DeepSeek Harness')));await f.receive('确认',old);assert.equal(f.sends.length,0);assert.equal(f.receipts.get(fresh.requestId!).confirmedAt,undefined);
});
test('B40 cancelled card is not resurrected by retry or channel restart',async t=>{
 const m=replanModels(),f=await fixture(t,m);await f.receive('用DeepSeek Harness检索graph algorithms论文');await f.receive('取消');const before=JSON.stringify(f.receipts.drafts());m.recover();await f.receive('重新整理');assert.equal(JSON.stringify(f.receipts.drafts()),before);assert.equal(f.receipts.list().length,0);
 await f.conversation.close();const receipts=new ForwardReceipts(join(f.root,'wechat','harness-relay.sqlite')),forward=f.forwarding(receipts),conversation=await new WeChatTextConversation({...f.options,receipts,forwarding:forward}).start();f.onCleanup(()=>conversation.close());await conversation.receive({text:'重新整理',messageId:randomUUID()},conversation.capture(),signal);assert.equal(JSON.stringify(receipts.drafts()),before);assert.equal(receipts.list().length,0);assert.equal(f.sends.length,0);
});
for(const text of ['不要重新整理','重新整理是什么意思？','“重新整理”','重新整理并立即执行','重新整理后改用Codex'])test('B40 only complete retry bypasses interpretation: '+text,async t=>{
 const m=replanModels(),f=await fixture(t,m);await f.receive('用DeepSeek Harness检索graph algorithms论文');m.recover();await f.receive(text);assert.equal(m.calls.filter(c=>c.kind==='interpret').length,1);assert.equal(m.calls.filter(c=>c.kind==='plan').length,1);assert.equal(f.receipts.list().length,0);assert.equal(f.sends.length,0);
});

test('B40 historical draft without reason code can retry and repeated retry keeps routing prefix bounded',async t=>{
 const m=replanModels(),f=await fixture(t,m);await f.receive('用DeepSeek Harness检索graph algorithms论文');let d=f.receipts.drafts()[0]!;f.receipts.mutateDraft(d.id,d.version,row=>{delete row.lastPlanningFailure!.code;});m.recover();
 // Refresh the presented binding after a historical state change; no old confirmation authority is reused.
 await f.conversation.receive({text:'重新整理',messageId:randomUUID()},undefined,signal);assert.equal(f.receipts.draft(d.id).status,'prepared');
 for(let i=0;i<3;i++)await f.receive('重新整理');
 const plans=m.calls.filter(c=>c.kind==='plan').slice(-3);assert.equal(new Set(plans.map(c=>c.data.request)).size,1);assert.equal(f.receipts.drafts().length,1);assert.equal(f.sends.length,0);
});
test('B40 repeated failed retry retains safe code and never sends',async t=>{
 const m=replanModels(),f=await fixture(t,m);await f.receive('用DeepSeek Harness检索graph algorithms论文');await f.receive('重新整理');const d=f.receipts.drafts()[0]!;assert.equal(d.lastPlanningFailure?.code,'schema');assert.equal(d.status,'open');assert.equal(f.receipts.list().length,0);assert.equal(f.sends.length,0);assert.ok(!JSON.stringify(d).includes('synthetic malformed'));
});

test('B40 actual channel rejects explicit Harness to Codex switch in first plan and retry',async t=>{
 const m=replanModels();m.recover();m.wrongExecutor(true);const f=await fixture(t,m);await f.receive('用DeepSeek Harness检索graph algorithms论文');assert.equal(f.receipts.drafts()[0]?.lastPlanningFailure?.code,'executor_mismatch');assert.equal(f.receipts.list().length,0);
 m.wrongExecutor(false);await f.receive('重新整理');const old=f.conversation.capture()!;m.wrongExecutor(true);await f.receive('重新整理');assert.equal(f.receipts.draft(old.draftId).lastPlanningFailure?.code,'executor_mismatch');assert.equal(f.receipts.get(old.requestId!).phase,'unavailable');assert.equal(f.receipts.list().length,1);assert.equal(f.sends.length,0);
});

test('B40 executor instruction after a comma is retained for initial plan and retry',async t=>{
 const m=replanModels();m.recover();m.wrongExecutor(true);const f=await fixture(t,m);
 const text='帮我找一下最近关于graph algorithms的论文，用DeepSeek harness挑几篇最相关的，说清楚每篇做了什么，再把原文链接也带上';
 await f.receive(text);assert.equal(f.receipts.drafts()[0]?.lastPlanningFailure?.code,'executor_mismatch');assert.equal(f.receipts.list().length,0);m.wrongExecutor(false);await f.receive('重新整理');assert.equal(f.receipts.list()[0]?.executor,'harness');assert.equal(f.receipts.drafts()[0]?.originalText,text);assert.equal(f.sends.length,0);
});
