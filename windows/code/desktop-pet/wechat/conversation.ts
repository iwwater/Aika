import { BackendSession, type BackendPorts } from '../app/backend-session.js';
import { DesktopWork } from '../harness/desktop-work.js';
import type { HarnessForwarding } from '../harness/forwarding.js';
import type { ForwardRequest } from '../contracts/harness.js';
import type { ForwardReceipts } from '../harness/receipts.js';
import type { ProjectIndexPort } from '../contracts/projects.js';
import type { DesktopWorkState, WorkInputBinding } from '../contracts/desktop-work.js';
import type { WorkStatusNotice } from '../core/work-speech.js';
import type { WorkIntentClassifier } from '../providers/work-intent.js';
import type { WorkPlanner } from '../providers/work-plan.js';
import type { WeChatConversation, WeChatInput, WeChatSend, WeChatReplyContext } from './service.js';
import type { WeChatStore } from './store.js';
import { MemoryMediaStore } from '../media/store.js';

interface Options {
  key: string; store: WeChatStore; send: WeChatSend; ports: BackendPorts;
  receipts: ForwardReceipts; forwarding: HarnessForwarding; projects: ProjectIndexPort;
  classifier: Pick<WorkIntentClassifier,'classify'|'interpret'>; planner: Pick<WorkPlanner,'plan'>;
}
type Presented = { binding: WorkInputBinding; sentAt: number };
const labels = {awaiting_confirmation:'等待确认',forwarding:'正在发送',accepted:'已接收，等待结果',completed:'已完成',unavailable:'暂不可用',unknown:'结果待核对'};
function queryMode(text: string): 'latest'|'all'|{name:string}|undefined {
  const value=text.normalize('NFKC').trim().replace(/[。？?!！\s]+$/g,'');
  if(/^(?:(?:查询|查看|看看|查下|查一下)(?:一下)?)?(?:所有|全部)(?:任务|工作)(?:的)?(?:结果|进度|状态)?$/.test(value))return 'all';
  if(/^(?:(?:查询|查看|看看|查下|查一下)(?:一下)?(?:任务|工作)?(?:的)?(?:结果|进度|状态)?|(?:任务|工作)?(?:的)?(?:结果|进度|状态)|\/任务)$/.test(value))return 'latest';
  const named=value.match(/^(?:查询|查看|看看|查一下)(.{1,120}?)(?:的)?(?:结果|进度|状态|进展)$/);
  if(named?.[1]&&!/(?:并且?|然后|顺便|同时|再)(?:帮我|把|给我)?(?:修改|重做|执行|删除|运行|安装|部署|发送|创建|新建)/.test(value)&&!/[，,;；。]/.test(named[1]))return {name:named[1]};
}
function approvalText(r:ForwardRequest):string {
  const known:Record<string,string>={bash:'请求执行终端命令，需要原生批准',read_file:'请求读取文件，需要原生批准',write_file:'请求写入文件，需要原生批准',edit_file:'请求编辑文件，需要原生批准',apply_patch:'请求修改文件，需要原生批准'};
  const tools=[...new Set(r.nativeApprovalTools??[])].filter(name=>Object.hasOwn(known,name));
  let entry='';
  try{const url=new URL(r.nativeSessionUrl??'');if(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password)entry='\n原生入口（在本机打开）：'+url.toString();}catch{}
  const session=r.harnessSessionId&&/^[A-Za-z0-9_-]{1,128}$/.test(r.harnessSessionId)?'\n原生会话：'+r.harnessSessionId:'\n回执未提供可定位的原生会话。';
  return (r.plan?.title??r.text.slice(0,80))+'：等待原生 Harness 工具批准'+session+entry+'\n'+(tools.length?tools.map(name=>name+'：'+known[name]).join('\n'):'回执未提供可显示的工具名称或具体动作。')+'\n请在原生会话核对具体操作；这里不会代为批准。';
}
/** Same runtime/work classes, separate channel state and real text-only output. */
export class WeChatTextConversation implements WeChatConversation {
  private readonly session: BackendSession;
  private readonly work: DesktopWork;
  private state?: DesktopWorkState;
  private pending=new Set<Promise<unknown>>();
  private suppressNotices=false;
  private closed=false;
  private incoming: {id:string;context:WeChatReplyContext}|undefined;
  private turns=new Map<string,WeChatReplyContext>();
  constructor(private readonly options: Options) {
    this.session=new BackendSession({...options.ports,outputMode:'text',mediaStore:new MemoryMediaStore()},message=>{
      if(message.channel==='event'&&message.event.type==='turn'&&message.event.input.clientRequestId===this.incoming?.id){
        this.turns.set(message.event.input.scope.turnId,{...this.incoming!.context});
        if(this.turns.size>128)this.turns.delete(this.turns.keys().next().value!);
      }else if(message.channel==='event'&&message.event.type==='reply')this.track(options.send(message.event.reply.text,'reply:'+message.event.reply.scope.turnId,this.turns.get(message.event.reply.scope.turnId)));
      else if(message.channel==='event'&&message.event.type==='error'&&message.event.scope)this.track(options.send('这次聊天暂未完成，请稍后再试。','chat-error:'+message.event.scope.turnId,this.turns.get(message.event.scope.turnId)));
      else if(message.channel==='event'&&message.event.type==='error'&&!message.event.scope&&this.incoming&&!this.closed)this.track(options.send('这次操作没有完成，请先核对当前状态；不会自动重复发送。','input-error:'+this.incoming.id,this.incoming.context));
    },()=>{});
    this.work=new DesktopWork({receipts:options.receipts,forwarding:options.forwarding,projects:options.projects,
      classify:options.classifier.classify.bind(options.classifier),interpret:options.classifier.interpret.bind(options.classifier),
      plan:options.planner.plan.bind(options.planner),emit:state=>{this.state=state;},notify:notice=>{if(!this.suppressNotices)this.track(this.notice(notice));}});
    this.session.attachWork(this.work);
  }
  async start() { await this.work.start();return this; }
  private track(job: Promise<unknown>) { this.pending.add(job);void job.finally(()=>this.pending.delete(job)).catch(()=>{}); }
  private async flush() { while(this.pending.size)await Promise.allSettled([...this.pending]); }
  capture(): WorkInputBinding|undefined {
    const binding=this.options.store.get<Presented>('presented:'+this.options.key)?.binding,draft=this.state?.draft;
    if(!binding||!draft||binding.draftId!==draft.id||binding.draftVersion!==draft.version)return;
    const request=this.state?.confirmation;
    if(binding.requestId && (!request||request.id!==binding.requestId||request.version!==binding.requestVersion||request.phase!=='awaiting_confirmation'||request.confirmedAt))return;
    return structuredClone(binding);
  }
  private async notice(notice: WorkStatusNotice) {
    if(this.closed)return;
    const taskId=notice.taskId??notice.id;
    const key='reply-context:'+this.options.key+':'+taskId;
    const isInputNotice=['arrangement','clarification','confirmed','cancelled','local_control','ready'].includes(notice.kind);
    const context=isInputNotice?this.incoming?.context:this.options.store.get<WeChatReplyContext>(key);
    // A confirmation in a different input format becomes the task's delivery source.
    if(context&&(notice.kind==='arrangement'||notice.kind==='confirmed'))this.options.store.set(key,context);
    const state=this.state;let text=notice.spokenText??'',binding=notice.workBinding;
    if(notice.kind==='arrangement'&&state?.confirmation){
      const r=state.confirmation;
      text='安排给 '+(r.executor==='harness'?'DeepSeek Harness':'Codex')+(r.project?'，项目：'+r.project.name:'')+(r.target?.title?'，任务：'+r.target.title:'')+'\n\n'+r.text+'\n\n回复“确认”即可发送；也可以继续补充或说“取消”。查询已发任务可说“查询任务结果”。';
      if(state.draft)binding={draftId:state.draft.id,draftVersion:state.draft.version,requestId:r.id,requestVersion:r.version};
    } else if(notice.kind==='completed'||notice.kind==='unknown'||notice.kind==='failed'){
      const r=this.options.forwarding.record(notice.taskId??notice.id);
      text=(r.plan?.title??'任务')+'：'+labels[r.phase]+(r.result?'\n'+r.result:r.detail?'\n'+r.detail:'');
    } else if(notice.kind==='confirmed')text='已收到确认，正在发送给 '+(notice.executor==='harness'?'DeepSeek Harness':'Codex')+'。';
    else if(notice.kind==='transferred')text='任务已被 '+(notice.executor==='harness'?'DeepSeek Harness':'Codex')+' 接收。可继续聊天，或说“查询任务结果”。';
    else if(notice.kind==='cancelled')text='已取消这次待发送的安排。';
    else if(notice.kind==='approval')text=approvalText(this.options.forwarding.record(notice.taskId??notice.id));
    if(!text)return;
    const accepted=await this.options.send(text,'notice:'+notice.kind+':'+notice.id,context);
    if(accepted&&binding)this.options.store.set('presented:'+this.options.key,{binding,sentAt:Date.now()} satisfies Presented);
  }
  async receive(input: WeChatInput,binding: WorkInputBinding|undefined,signal: AbortSignal) {
    signal.throwIfAborted();
    const context={...(input.replyContext??{source:'text' as const,replyMode:'follow_input' as const})};
    const query=queryMode(input.text);
    if(query){
      // Freeze selected IDs before any await. A later task or old task update cannot change this query's target.
      const rows=this.options.receipts.queryDispatched(query!=='latest');
      const normalize=(name:string)=>name.normalize('NFKC').replace(/[\s，。？！!?、：:“”"'「」]/g,'').toLowerCase();
      let selected:ForwardRequest[]=rows;
      if(typeof query==='object'){
        const name=normalize(query.name.replace(/的任务$/,''));
        const ranked=rows.map(r=>{
          const plan=r.plan?.title,parsed=plan?queryMode(plan):undefined;
          const score=normalize(r.id)===name?4:r.target?.title&&normalize(r.target.title)===name?3:plan&&normalize(plan)===name?2:typeof parsed==='object'&&normalize(parsed.name)===name?1:0;
          return {r,score};
        });
        const best=Math.max(0,...ranked.map(x=>x.score));
        const matches=ranked.filter(x=>x.score>0&&x.score===best).map(x=>x.r);
        const targets=new Map<string,ForwardRequest>();
        for(const r of matches){const key=r.target?.threadId??r.harnessSessionId??r.id;if(!targets.has(key))targets.set(key,r);}
        if(targets.size>1){
          await this.options.send('有多个匹配任务，请补充完整任务名称或回执编号：\n'+[...targets.values()].slice(0,5).map(r=>(r.plan?.title??r.target?.title??'任务')+'（'+(r.target?.title??'Harness')+'）\n回执：'+r.id).join('\n')+(targets.size>5?'\n另有'+(targets.size-5)+'个匹配，请使用更完整名称。':''),'query:'+input.messageId,context);return;
        }
        selected=[...targets.values()];
      }
      const records: {row:ForwardRequest;stale:boolean}[]=[];
      for(const r of selected){
        signal.throwIfAborted();
        try{records.push({row:await this.options.forwarding.refreshReceipt(r.id),stale:false});}
        catch{records.push({row:this.options.forwarding.record(r.id),stale:true});}
      }
      signal.throwIfAborted();
      const text=records.length?records.map(({row:r,stale},n)=>(n+1)+'. '+(r.nativeStatus==='approval'?approvalText(r):(r.plan?.title??r.text.slice(0,40))+'：'+labels[r.phase]+(r.result?'\n'+r.result:r.detail?'\n'+r.detail:''))+(stale?'\n本次刷新未完成，以上为已保存状态。':'')).join('\n\n'):typeof query==='object'?'当前微信会话没有与“'+query.name+'”匹配的已派发任务回执。请到原任务查看；本次没有新建或转发查询。':'还没有从当前微信会话已派发的任务。';
      await this.options.send(text,'query:'+input.messageId,context);return;
    }
    const shown=this.options.store.get<Presented>('presented:'+this.options.key);
    const usableBinding=input.createdAt!==undefined&&shown&&input.createdAt<shown.sentAt?undefined:binding;
    const cancel=()=>{void this.session.receiveLine(JSON.stringify({channel:'command',command:{type:'cancel'}}));};
    signal.addEventListener('abort',cancel,{once:true});
    this.incoming={id:input.messageId,context};
    try{
      await this.session.receiveLine(JSON.stringify({channel:'command',command:{type:'submit_text',text:input.text,clientRequestId:input.messageId,...(usableBinding?{workBinding:usableBinding}:{})}}));
      await this.session.drainForeground();signal.throwIfAborted();await this.flush();
    }finally{signal.removeEventListener('abort',cancel);this.incoming=undefined;}
  }
  async close() { this.closed=true;await this.session.close();await this.flush();await this.options.forwarding.close(); }
}
