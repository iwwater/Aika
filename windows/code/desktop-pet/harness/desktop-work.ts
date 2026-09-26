import { WorkPlanFailure, type WorkPlanFailureCode } from '../providers/work-plan.js';
import { isClearUnknownReminderCommand } from './local-reminder-intent.js';
import { sameScope } from '../core/turn-controller.js';
import type { WorkStatusNotice } from '../core/work-speech.js';
import type { TurnScope } from '../contracts/index.js';
import type { DesktopWorkAction, DesktopWorkPort, DesktopWorkState, WorkDraft, WorkIntent, WorkStage, WorkPlan, WorkPlanCatalog, WorkInputBinding, PendingWorkContext, WorkContinuationIntent, WorkConversationMessage } from '../contracts/desktop-work.js';
import type { ForwardRequest } from '../contracts/harness.js';
import type { ProjectIndexPort } from '../contracts/projects.js';
import { ManagementError } from '../contracts/management.js';
import type { ForwardReceipts, StoredWorkDraft } from './receipts.js';
import type { HarnessForwarding } from './forwarding.js';

interface Options {
  receipts: ForwardReceipts;
  forwarding: Pick<HarnessForwarding, 'records' | 'record' | 'observationPage' | 'pendingCount' | 'targets' | 'prepare' | 'confirm' | 'refreshReceipt'> & Partial<Pick<HarnessForwarding,'projectChoices'|'prepareDraft'|'openNative'>>;
  projects: ProjectIndexPort;
  classify(scope: TurnScope, text: string, signal: AbortSignal): Promise<WorkIntent>;
  interpret?(scope: TurnScope, text: string, context: PendingWorkContext, signal: AbortSignal): Promise<WorkContinuationIntent>;
  plan?(scope:TurnScope,text:string,catalog:WorkPlanCatalog,signal:AbortSignal):Promise<WorkPlan>;
  emit(state: DesktopWorkState): void;
  notify?(notice: WorkStatusNotice): void;
  onReceipt?(row: ForwardRequest): void;
}
type WorkInputSnapshot = { scope: TurnScope; draft?: StoredWorkDraft; request?: ForwardRequest; authorized: boolean; invalid: boolean };
const phaseStage = (row?: ForwardRequest): WorkStage => !row ? 'idle' :
  ({ awaiting_confirmation: 'confirming', forwarding: 'sending', accepted: 'working', completed: 'completed', unavailable: 'failed', unknown: 'unknown' } as const)[row.phase];
const invalid = (message = '工作卡已变化，请重新核对。'): never => { throw new ManagementError('invalid_request', message); };
class PlanningFailure extends ManagementError {
  constructor(readonly stage: 'plan' | 'target' | 'prepare', safe?: ManagementError, readonly codeDetail?:WorkPlanFailureCode) { super(safe?.code ?? 'unavailable', safe?.message ?? '这次任务卡暂时没整理好，原请求已保留，没有发送；可以重新整理或继续聊天。'); }
}
/** Isolated desktop input/confirmation state, not an engineering execution queue. */
export class DesktopWork implements DesktopWorkPort {
  private sequence = 0;
  private focus: DesktopWorkState['focus'] = 'companion';
  private stage: WorkStage = 'idle';
  private draftId: string | undefined;
  private focusId: string | undefined;
  private choices: Pick<WorkDraft, 'projects' | 'targets'> | undefined;
  private detail: string | undefined;
  private reminderFeedback: string | undefined;
  private epoch = 0;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private observationCursor: { createdAt: string; id: string } | undefined;
  private latestCompletion: ForwardRequest | undefined;
  private notificationTimer: NodeJS.Timeout | undefined;
  private readonly seenPhases = new Map<string, string>();
  private readonly timelineVersions = new Map<string, number>();
  private previous = '';
  private actions:Promise<void>=Promise.resolve();
  private boundInput: WorkInputSnapshot | undefined;
  private publishTimelineReceipt(row: ForwardRequest): void {
    if (!row.confirmedAt || !this.options.onReceipt || this.timelineVersions.get(row.id) === row.version) return;
    try {
      this.options.onReceipt(row);
      this.timelineVersions.set(row.id, row.version);
    } catch { /* Durable ForwardReceipts are replayed at startup and retried on later observation. */ }
  }
  private localInput: {scope:TurnScope;epoch:number;records:{id:string;expectedVersion:number}[]} | undefined;
  constructor(private readonly options: Options) {}
  private track<T>(job: Promise<T>): Promise<T> {
    this.active.add(job); void job.finally(() => this.active.delete(job)).catch(() => {}); return job;
  }
  private draft(): StoredWorkDraft | undefined { return this.draftId ? this.options.receipts.draft(this.draftId) : undefined; }
  private publish(force = false) {
    if (this.closed) return;
    const draft = this.draft();
    const selectedId = draft?.operationId ?? this.focusId;
    const selected = selectedId ? this.options.forwarding.record(selectedId) : undefined;
    const rows = [...new Map([selected, this.latestCompletion, ...this.options.forwarding.records()]
      .filter((row): row is ForwardRequest => !!row).map(row => [row.id, row])).values()];
    const confirmation = draft?.operationId ? rows.find(r => r.id === draft.operationId && r.phase === 'awaiting_confirmation') : undefined;
    const stage = this.focus === 'work' && this.stage !== 'classifying' && !draft
      ? phaseStage(rows.find(r => r.id === this.focusId)) : this.stage;
    const sourceDraft = draft ?? (selectedId ? this.options.receipts.draftForOperation(selectedId) : undefined);
    const state = { focus: this.focus, stage,
      ...(sourceDraft ? { sourceInput: { draftId: sourceDraft.id, scope: sourceDraft.scope, text: sourceDraft.originalText ?? sourceDraft.text, provenance: sourceDraft.originalText === undefined ? 'legacy_saved_input' as const : 'original_input' as const, ...(sourceDraft.conversation ? {conversation:sourceDraft.conversation}: {}) } } : {}), ...(selectedId?{activeRequestId:selectedId}:{}),
      ...(draft && ['open','prepared'].includes(draft.status) && this.choices ? { draft: { id: draft.id, version: draft.version, text: draft.text,
        ...(draft.question ? { question: draft.question } : {}), ...(confirmation?{executor:confirmation.executor??'codex'}:{}), ...this.choices } } : {}),
      ...(confirmation && draft?.status === 'prepared' ? { confirmation } : {}), requests: rows, pendingCount: this.options.forwarding.pendingCount(),
      ...(this.reminderFeedback ? {reminderFeedback:this.reminderFeedback} : {}), ...(this.detail ? { detail: this.detail } : {}) };
    const encoded = JSON.stringify(state); if (!force && encoded === this.previous) return; this.previous = encoded;
    this.options.emit({ sequence: ++this.sequence, ...state });
  }
  private async loadChoices(): Promise<Pick<WorkDraft, 'projects' | 'targets'>> {
    const [p,t]=await Promise.allSettled([
      this.options.forwarding.projectChoices?this.options.forwarding.projectChoices():this.options.projects.list({limit:100}).then(p=>p.items),
      this.options.forwarding.targets('')
    ]);
    if(p.status==='rejected')throw p.reason;
    return {projects:p.value.map(({id,version,name,abstract,detailRef})=>({id,version,name,abstract,detailRef})),targets:t.status==='fulfilled'?t.value.items:[]};
  }
  private async planDraft(d:StoredWorkDraft,text:string,signal:AbortSignal,epoch:number, dialogueScope:TurnScope=d.scope, expectedExecutor?:'codex'|'harness'):Promise<void> {
    if(!this.options.plan||!this.options.forwarding.prepareDraft)throw Error('Automatic planning unavailable');
    this.choices=await this.loadChoices();
    const full=this.choices,input=text.normalize('NFKC').toLowerCase();
    // Retrieval narrows metadata only; it does not select an executor or authorize a send.
    const rank=(name:string,path:string)=>{const n=name.toLowerCase(),leaf=path.split('/').at(-1)?.toLowerCase()??'';
      return (leaf.length>1&&input.includes(leaf)?100:0)+(n.length>1&&input.includes(n)?50:0)+[...new Set(n)].filter(ch=>input.includes(ch)).length;};
    const targets=full.targets.map((t,i)=>({t,i,score:rank(t.title,t.projectPath)})).sort((a,b)=>b.score-a.score||a.i-b.i).slice(0,60).map(x=>x.t);
    const roots=new Set(targets.map(t=>t.projectPath));
    const projects=full.projects.map((p,i)=>({p,i,score:rank(p.name,p.detailRef.rootPath)+(roots.has(p.detailRef.rootPath)?10:0)}))
      .sort((a,b)=>b.score-a.score||a.i-b.i).slice(0,80).map(x=>x.p);
    let plan:WorkPlan;
    try{plan=await this.options.plan(d.scope,text,{targets,projects},signal);}
    catch(error) {signal.throwIfAborted();throw new PlanningFailure('plan',undefined,error instanceof WorkPlanFailure?error.code:undefined);}
    signal.throwIfAborted();if(epoch!==this.epoch||this.closed)throw Error('Plan became stale');
    if(plan.kind==='clarify'){
      this.options.receipts.mutateDraft(d.id,d.version,row=>{row.text=text;row.question=plan.question;(row.conversation??=[]).push({role:'assistant',text:plan.question,scope:dialogueScope});});
      this.stage='clarifying';this.publish();this.speakQuestion(dialogueScope,plan.question);return;
    }
    if(expectedExecutor && plan.executor!==expectedExecutor)throw new PlanningFailure('plan',undefined,'executor_mismatch');
    const target=plan.targetId?full.targets.find(t=>t.threadId===plan.targetId):undefined;
    if(plan.executor==='codex'&&!target)throw new PlanningFailure('target');
    const request=await this.options.forwarding.prepareDraft({text:plan.text,executor:plan.executor,
      ...(target?{target:{hostId:'local',threadId:target.threadId}}:{}),
      ...(plan.projectId?{projectId:plan.projectId,projectVersion:plan.projectVersion}:{}),plan:{title:plan.title,reason:plan.reason,...(plan.spokenSummary?{spokenSummary:plan.spokenSummary}:{})}},d.id,d.version).catch(error=>{signal.throwIfAborted();throw new PlanningFailure('prepare',error instanceof ManagementError?error:undefined);});
    if(epoch!==this.epoch||this.closed)throw Error('Prepared card became stale');
    this.focusId=request.id;this.stage='confirming';this.publish();
    this.speakArrangement(dialogueScope,request);
  }

  async start(intervalMs = 2000): Promise<void> {
    for (const row of this.options.forwarding.records()) {
      this.seenPhases.set(row.id, `${row.phase}:${row.nativeStatus??''}`);
      this.publishTimelineReceipt(row);
    }
    const drafts = this.options.receipts.drafts();
    const latest = drafts.find(d => ['open', 'prepared', 'confirming'].includes(d.status));
    if (latest) {
      this.draftId = latest.id;
      const row = this.options.forwarding.records().find(r => r.id === latest.operationId);
      // A process restart does not send a confirmed or partially dispatched request again.
      if (latest.status === 'confirming') this.options.receipts.mutateDraft(latest.id, latest.version,
        d => { d.status = row?.phase === 'awaiting_confirmation' ? 'prepared' : 'confirmed'; });
      const current = this.draft();
      if (current?.status === 'confirmed') { this.focusId = current.operationId; this.draftId = undefined; }
      else {
        this.stage = current?.status === 'open' ? current.question ? 'clarifying' : 'selecting' : 'confirming';
        try { this.choices = await this.loadChoices(); } catch { this.choices = { projects: [], targets: [] }; this.detail = '项目或 Codex 任务暂不可用，可以稍后刷新。'; }
      }
    }
    this.publish();
    this.timer = setInterval(() => { void this.track(this.observe()).catch(() => {}); }, intervalMs); this.timer.unref();
  }
  onInput(): void {
    if (this.closed) return;
    this.epoch++; this.boundInput=undefined; this.focus='companion'; this.detail=undefined;
    const d=this.draft();
    this.stage=d?.status==='prepared'?'confirming':d?.status==='open'?(d.question?'clarifying':'selecting'):'idle';
    this.publish();
  }
  beginInput(scope: TurnScope, binding?: WorkInputBinding): void {
    this.localInput={scope:{...scope},epoch:this.epoch,records:this.options.forwarding.records().filter(r=>r.confirmedAt&&r.phase==='unknown'&&!r.reminderCleared).map(r=>({id:r.id,expectedVersion:r.version}))};
    const draft=this.draft() ?? (this.focusId?this.options.receipts.draftForOperation(this.focusId):undefined);
    if(!draft || !['open','prepared'].includes(draft.status)) {this.boundInput={scope,authorized:false,invalid:!!binding};return;}
    const request=draft.operationId?this.options.forwarding.record(draft.operationId):undefined;
    const valid=!!binding && binding.draftId===draft.id && binding.draftVersion===draft.version &&
      (draft.status==='prepared' ? !!request && request.phase==='awaiting_confirmation' && !request.confirmedAt && binding.requestId===request.id && binding.requestVersion===request.version
        : binding.requestId===undefined && binding.requestVersion===undefined);
    this.boundInput={scope,draft,...(request?{request}:{}),authorized:valid,invalid:!!binding&&!valid};
  }
  private binding(): WorkInputBinding | undefined {
    const d=this.draft();if(!d || !['open','prepared'].includes(d.status))return;
    const request=d.operationId?this.options.forwarding.record(d.operationId):undefined;
    return {draftId:d.id,draftVersion:d.version,...(d.status==='prepared'&&request?{requestId:request.id,requestVersion:request.version}:{})};
  }
  private speakQuestion(scope:TurnScope,question:string): void {
    const binding=this.draft()?.status==='open'?this.binding():undefined;
    this.options.notify?.({id:(binding?.draftId??scope.turnId)+':'+scope.turnId+':question',kind:'clarification',executor:'codex',spokenText:question,...(binding?{workBinding:binding}:{})});
  }
  private speakArrangement(scope:TurnScope,request:ForwardRequest): void {
    const brief=request.plan?.spokenSummary ?? (request.text.length<=500?request.text:undefined);
    const label=request.executor==='harness'?'DeepSeek Harness':'Codex';
    const text=brief?'安排给'+label+(request.project?'，项目是'+request.project.name:'')+(request.target?.title?'，任务是'+request.target.title:'')+'：'+brief+'。你可以说确认，或者继续修改。':'任务正文较长，可以说重新整理，让我先整理成清楚的语音安排。';
    const binding=brief?this.binding():undefined;
    this.options.notify?.({id:request.id+':'+scope.turnId,taskId:request.id,kind:'arrangement',executor:request.executor??'codex',spokenText:text,...(binding?{workBinding:binding}:{})});
  }
  private context(snapshot:WorkInputSnapshot):PendingWorkContext {
    const d=snapshot.draft!,request=snapshot.request;
    return {stage:d.status==='prepared'?'confirming':'clarifying',originalRequest:d.originalText??d.text,currentRequest:request?.text??d.text,
      ...(d.question?{question:d.question}:{}),conversation:(d.conversation??[]).slice(-8).map(({role,text})=>({role,text})),
      ...(request?{arrangement:{executor:request.executor??'codex',title:request.plan?.title??'',...(request.project?{projectName:request.project.name}:{}),...(request.target?.title?{targetName:request.target.title}:{})}}:{})};
  }
  private async continueInput(scope:TurnScope,text:string,signal:AbortSignal,epoch:number,snapshot:WorkInputSnapshot):Promise<'companion'|'handled'|'new_work'> {
    const d=snapshot.draft!;
    const current=()=>{signal.throwIfAborted();if(this.closed||epoch!==this.epoch||this.boundInput!==snapshot)throw Error('Task input became stale');};
    const unchanged=()=>{current();const latest=this.options.receipts.draft(d.id);
      if(latest.version!==d.version||latest.status!==d.status||(this.draftId&&this.draftId!==d.id))invalid('任务安排已变化，请先核对新的安排。');
      if(snapshot.request){const request=this.options.forwarding.record(snapshot.request.id);if(request.version!==snapshot.request.version||request.phase!==snapshot.request.phase)invalid('任务安排已变化，请先核对新的安排。');}};
    unchanged();
    let intent:WorkContinuationIntent;
    const retry=/^(?:请)?重新整理(?:任务卡)?[。.!！]?$/.test(text.trim());
    const arrangement=snapshot.request;
    const retryPrefix=arrangement ? '用'+(arrangement.executor==='harness'?'DeepSeek Harness':'Codex')+'执行以下任务。\n'+
      (arrangement.project?'项目：'+arrangement.project.name+'。\n':'')+(arrangement.target?'现有任务：'+arrangement.target.title+'。\n':'')+'任务正文：\n' : '';
    const retryText=retryPrefix && !d.text.startsWith(retryPrefix) ? retryPrefix+d.text : d.text;
    try{intent=retry ? {kind:'supplement',text:retryText,executionAuthorized:false} : await this.options.interpret!(scope,text,this.context(snapshot),signal);}
    catch(error){unchanged();this.options.receipts.mutateDraft(d.id,d.version,row=>{(row.conversation??=[]).push({role:'user',text,scope});});throw error;}
    unchanged();
    if(intent.kind==='companion'){this.focus='companion';this.publish();return 'companion';}
    if(intent.kind==='new_work')return 'new_work';
    this.draftId=d.id;this.focus='work';this.detail=undefined;
    if(intent.kind==='confirm'){
      if(!snapshot.authorized || d.status!=='prepared' || !snapshot.request){
        this.stage=d.status==='prepared'?'confirming':'clarifying';this.publish();
        if(snapshot.request)this.speakArrangement(scope,snapshot.request);else this.speakQuestion(scope,d.question??'请先说明要完成的任务，我会把完整安排告诉你。');
        return 'handled';
      }
      await this.scopedAction({type:'confirm',id:snapshot.request.id,expectedVersion:snapshot.request.version},current,{role:'user',text,scope});return 'handled';
    }
    if(intent.kind==='cancel'){
      this.options.receipts.mutateDraft(d.id,d.version,row=>{(row.conversation??=[]).push({role:'user',text,scope});});
      await this.scopedAction({type:'dismiss',draftId:d.id},current);signal.throwIfAborted();this.options.notify?.({id:d.id+':'+scope.turnId,kind:'cancelled',executor:snapshot.request?.executor??'codex'});return 'handled';
    }
    if(intent.kind==='clarify'){
      this.options.receipts.mutateDraft(d.id,d.version,row=>{(row.conversation??=[]).push({role:'user',text,scope},{role:'assistant',text:intent.question,scope});if(row.status==='open')row.question=intent.question;});
      this.stage=d.status==='prepared'?'confirming':'clarifying';this.publish();this.speakQuestion(scope,intent.question);return 'handled';
    }
    if(intent.kind!=='supplement')throw Error('Unsupported task continuation');
    let next=this.options.receipts.mutateDraft(d.id,d.version,row=>{(row.conversation??=[]).push({role:'user',text,scope});});
    if(next.status==='prepared')next=this.options.receipts.reopenDraft(next.id,next.version,intent.text);
    else next=this.options.receipts.mutateDraft(next.id,next.version,row=>{row.text=intent.text;delete row.question;});
    this.focusId=undefined;this.stage='classifying';this.publish();
    await this.planDraft(next,intent.text,signal,epoch,scope,retry?arrangement?.executor:undefined);current();
    const prepared=this.draft();
    const noPreviousArrangement=d.everPrepared===false || d.everPrepared===undefined&&d.version===1&&d.status==='open';
    if(intent.executionAuthorized && noPreviousArrangement && prepared?.status==='prepared' && prepared.operationId){
      const request=this.options.forwarding.record(prepared.operationId);
      await this.scopedAction({type:'confirm',id:request.id,expectedVersion:request.version},current);
    }
    return 'handled';
  }
  async route(scope: TurnScope, text: string, signal: AbortSignal): Promise<'companion' | 'handled'> {
    return this.track(this.routeInput(scope, text, signal));
  }
  private async routeInput(scope: TurnScope, text: string, signal: AbortSignal): Promise<'companion' | 'handled'> {
    const epoch = this.epoch, combined = AbortSignal.any([signal, this.shutdown.signal]);
    if(!text.trim())throw new ManagementError('invalid_request','没有听清任务内容，请再说一次。');
    if(isClearUnknownReminderCommand(text)) {
      combined.throwIfAborted();if(this.closed || epoch!==this.epoch)throw Error('Local control became stale');
      const local=this.localInput;
      if(local&&(!sameScope(local.scope,scope)||local.epoch!==epoch))throw Error('Local input snapshot is stale');
      const records=local?.records??this.options.forwarding.records().filter(r=>r.confirmedAt&&r.phase==='unknown'&&!r.reminderCleared).map(r=>({id:r.id,expectedVersion:r.version}));
      await this.scopedAction({type:'clear_unknown_reminders',records},()=>{combined.throwIfAborted();if(this.closed||epoch!==this.epoch)throw Error('Local control became stale');});
      combined.throwIfAborted();if(this.closed||epoch!==this.epoch)throw Error('Local control became stale');
      this.options.notify?.({id:scope.turnId+':clear-reminders',kind:'local_control',executor:'codex',spokenText:this.reminderFeedback??'提醒操作未完成，请刷新后重试。'});
      return 'handled';
    }
    let intent: WorkIntent;let routingFailed=false;
    const snapshot=this.boundInput&&sameScope(this.boundInput.scope,scope)?this.boundInput:undefined;
    if(snapshot?.invalid){this.focus='work';this.detail='任务安排已变化，请先核对新的安排。';this.publish();this.speakQuestion(scope,this.detail);return 'handled';}
    if(snapshot?.draft && this.options.interpret){
      try{const outcome=await this.continueInput(scope,text,combined,epoch,snapshot);if(outcome!=='new_work')return outcome;intent={kind:'work'};}
      catch(error){combined.throwIfAborted();if(epoch!==this.epoch)throw error;this.focus='work';this.detail=error instanceof ManagementError?error.message:'这次没能接着整理；原任务与回答已保留，可以再说一次。';
        const failed=this.draft();if(error instanceof PlanningFailure && failed?.status==='open')this.options.receipts.mutateDraft(failed.id,failed.version,row=>{row.question=this.detail!;row.lastPlanningFailure={stage:error.stage,...(error.codeDetail?{code:error.codeDetail}:{}),at:new Date().toISOString()};(row.conversation??=[]).push({role:'assistant',text:this.detail!,scope});});
        this.stage=this.draft()?.status==='prepared'?'confirming':'clarifying';this.publish();this.speakQuestion(scope,this.detail);return 'handled';}
    } else intent={kind:'companion'};
    this.stage = 'classifying'; this.publish();
    try { if(!(snapshot?.draft && this.options.interpret))intent = await this.options.classify(scope, text, combined); }
    catch { combined.throwIfAborted();routingFailed=true; intent = { kind: 'clarify', question: '这次请求暂时没能整理，原话已保留，可以重新整理或继续聊天。' }; }
    combined.throwIfAborted();
    if (this.closed || epoch !== this.epoch) throw new Error('Input routing became stale');
    if (intent.kind === 'companion') { this.focus = 'companion'; this.stage = 'idle'; this.publish(); return 'companion'; }
    let choices: Pick<WorkDraft, 'projects' | 'targets'>;
    try { choices = await this.loadChoices(); }
    catch { choices = { projects: [], targets: [] }; this.detail = '暂时无法列出已有任务；没有发送，可以稍后刷新。'; }
    combined.throwIfAborted(); if (epoch !== this.epoch) throw new Error('Input routing became stale');
    const row = this.options.receipts.createDraft(scope, text, intent.question);
    this.draftId = row.id; this.focusId = undefined; this.choices = choices; this.focus = 'work';
    this.stage=routingFailed?'failed':intent.kind==='clarify'?'clarifying':'classifying';this.publish();
    if(intent.kind==='clarify'&&intent.question)this.speakQuestion(scope,intent.question);
    if(intent.kind==='work'&&this.options.plan){
      try{await this.planDraft(row,text,combined,epoch);}
      catch(error){combined.throwIfAborted();if(epoch!==this.epoch)throw error;
        const fallback='这次任务卡暂时没整理好，原请求已保留，没有发送；可以重新整理或继续聊天。';
        const question=error instanceof ManagementError&&error.message!==fallback?error.message+' 原请求已保留，没有发送。':fallback;
        const current=this.draft();if(current?.status==='open')this.options.receipts.mutateDraft(current.id,current.version,d=>{d.question=question;d.lastPlanningFailure={stage:error instanceof PlanningFailure?error.stage:'unknown',...(error instanceof PlanningFailure&&error.codeDetail?{code:error.codeDetail}:{}),at:new Date().toISOString()};(d.conversation??=[]).push({role:'assistant',text:question,scope});});
        this.detail=question;this.stage='failed';this.publish();this.speakQuestion(scope,question);}
    }else if(intent.kind==='work'){this.stage='selecting';this.publish();}
    return 'handled';
  }
  action(action: DesktopWorkAction): Promise<void> { return this.scopedAction(action); }
  private scopedAction(action:DesktopWorkAction,assertCurrent?:()=>void,input?:WorkConversationMessage):Promise<void>{
    const job=this.actions.then(()=>{assertCurrent?.();return this.apply(action,assertCurrent,input);});this.actions=job.catch(()=>{});return this.track(job);
  }
  private async apply(action: DesktopWorkAction, assertCurrent?:()=>void, input?:WorkConversationMessage): Promise<void> {
    if (this.closed) return;
    const epoch = this.epoch;
    try {
      if(action.type==='clear_unknown_reminders') {
        const d=this.draft();
        const erroneous=d?.status==='open'&&!d.operationId&&!d.everPrepared&&isClearUnknownReminderCommand(d.originalText??d.text)&&d.text===(d.originalText??d.text)?d:undefined;
        const count=this.options.receipts.clearUnknownReminders(action.records,erroneous?{id:erroneous.id,expectedVersion:erroneous.version}:undefined);
        if(erroneous){this.draftId=undefined;this.choices=undefined;this.boundInput=undefined;}
        const focused=this.focusId?this.options.forwarding.record(this.focusId):undefined;
        if(focused?.reminderCleared)this.focusId=undefined;
        if(!this.draftId&&!this.focusId){this.stage='idle';this.focus='companion';this.detail=undefined;}
        this.reminderFeedback=count?`已清除 ${count} 项待核对提醒，工程记录仍保留。`:'没有需要清除的待核对提醒，工程记录仍保留。';
        return;
      }
      if(action.type==='open_native'){await this.options.forwarding.openNative?.(action.id);return;}
      if (action.type === 'dismiss') {
        const d = action.draftId ? this.options.receipts.draft(action.draftId) : this.draft();
        if (d && ['open', 'prepared'].includes(d.status)) this.options.receipts.mutateDraft(d.id, d.version, row => { row.status = 'dismissed'; });
        this.draftId = undefined; this.choices = undefined; this.onInput(); return;
      }
      if (action.type === 'focus') {
        this.focus = 'work'; this.detail = undefined;
        if (action.id) { const row = this.options.forwarding.records().find(r => r.id === action.id); if (!row) invalid(); this.focusId=row!.id;const restored=this.options.receipts.draftForOperation(row!.id);this.draftId=restored&&['open','prepared'].includes(restored.status)?restored.id:undefined;if(this.draftId)this.choices=await this.loadChoices();this.stage=phaseStage(row); }
        else this.stage = this.draft()?.status === 'prepared' ? 'confirming' : this.draft()?.status === 'open' ? this.draft()?.question ? 'clarifying' : 'selecting' : phaseStage(this.options.forwarding.records().find(r => r.id === this.focusId));
        this.publish(); return;
      }
      if (action.type === 'refresh') {
        if (action.id) await this.options.forwarding.refreshReceipt(action.id); else await this.observe();
        if (this.draft()?.status === 'open') this.choices = await this.loadChoices(); this.publish(); return;
      }
      if(action.type==='reprepare'||action.type==='replan'){
        const d=this.options.receipts.draft(action.draftId);
        if(d.id!==this.draftId||d.version!==action.expectedVersion||!['open','prepared'].includes(d.status))invalid();
        if(action.type==='replan'){
          if(!this.options.plan || !this.options.forwarding.prepareDraft)invalid();
          const planning = d.status === 'prepared' ? this.options.receipts.reopenDraft(d.id,d.version,action.text) : d;
          this.focusId=undefined;this.detail=undefined;this.stage='classifying';this.publish();
          await this.planDraft(planning,action.text,this.shutdown.signal,epoch);
        }else{
          if(!this.options.forwarding.prepareDraft)invalid();
          const request=await this.options.forwarding.prepareDraft!({text:action.text,executor:action.executor,
            ...(action.target?{target:action.target}:{}),...(action.projectId?{projectId:action.projectId,projectVersion:action.projectVersion}:{})},d.id,d.version);
          this.focusId=request.id;if(epoch===this.epoch){this.stage='confirming';this.focus='work';}this.publish();
        }return;
      }
      if (action.type === 'revise' || action.type === 'select') {
        const d = this.options.receipts.draft(action.draftId);
        if (d.status !== 'open' || d.version !== action.expectedVersion || d.id !== this.draftId) invalid();
        if (action.type === 'revise') {
          if (!action.text.trim() || action.text.length > 20000 || action.text.includes('\0')) invalid('请填写完整、有效的任务正文。');
          this.options.receipts.mutateDraft(d.id, d.version, row => { row.text = action.text; delete row.question; });
          this.stage = 'selecting'; this.publish(); return;
        }
        const request = await this.options.forwarding.prepare({ text: d.text, target: action.target,
          ...(action.projectId ? { projectId: action.projectId, projectVersion: action.projectVersion } : {}) });
        const latest = this.options.receipts.draft(d.id);
        if (latest.status !== 'open' || latest.version !== d.version) invalid();
        this.options.receipts.mutateDraft(d.id, d.version, row => { row.status = 'prepared'; row.everPrepared = true; row.operationId = request.id; });
        this.focusId = request.id; if (epoch === this.epoch) { this.stage = 'confirming'; this.focus = 'work'; }
        this.publish(); return;
      }
      if (action.type === 'confirm') {
        const d = this.options.receipts.drafts().find(row => row.operationId === action.id);
        if (!d || !['prepared', 'confirming', 'confirmed'].includes(d.status)) invalid();
        // Only the first desktop confirm may call the existing forwarding boundary.
        if (d!.status !== 'prepared') { this.publish(); return; }
        const row = this.options.forwarding.records().find(row => row.id === action.id);
        if (!row || row.version !== action.expectedVersion || row.phase !== 'awaiting_confirmation') invalid();
        const claimed = this.options.receipts.mutateDraft(d!.id, d!.version, row => { row.status = 'confirming';if(input)(row.conversation??=[]).push(input); });
        this.stage = 'sending'; this.publish();
        this.options.notify?.({id:row!.id,kind:'confirmed',executor:row!.executor??'codex'});
        try {
          const sent = await this.options.forwarding.confirm(action.id, action.expectedVersion,()=>{assertCurrent?.();const latest=this.options.receipts.draft(claimed.id);if(latest.version!==claimed.version||latest.status!=='confirming')invalid('任务安排已变化，请重新核对。');});
          this.options.receipts.mutateDraft(claimed.id, claimed.version, row => { row.status = 'confirmed'; });
          if (this.draftId === claimed.id) this.draftId = undefined;
          this.announce(sent); this.publishTimelineReceipt(sent); this.focusId = sent.id; if (epoch === this.epoch) this.stage = phaseStage(sent); this.publish();
        } catch (error) {
          this.options.receipts.mutateDraft(claimed.id, claimed.version, row => { row.status = 'prepared'; });
          if (epoch === this.epoch) this.stage = 'confirming'; throw error;
        }
        return;
      }
      invalid();
    } catch (error) {
      if (this.closed) return;
      if(this.stage==='classifying')this.stage='failed';
      this.detail = error instanceof ManagementError ? error.message : '工作连接暂时不可用；未自动重发，请核对原记录。';
      if(action.type==='clear_unknown_reminders')this.reminderFeedback=this.detail;
      this.publish();
    } finally { this.publish(true); }
  }
  private announce(row: ForwardRequest): void {
    const current = `${row.phase}:${row.nativeStatus??''}`, previous = this.seenPhases.get(row.id);
    this.seenPhases.set(row.id,current);
    if (previous === current || !row.confirmedAt) return;
    const kind = row.nativeStatus === 'approval' ? 'approval' : row.phase === 'completed' ? 'completed'
      : row.phase === 'unavailable' ? 'failed' : row.phase === 'unknown' ? 'unknown'
      : row.phase === 'accepted' && !previous?.startsWith('accepted:') && (row.executor === 'harness' ? row.harnessSessionId : row.appTurnId) ? 'transferred' : undefined;
    if (kind) this.options.notify?.({id:row.id,kind,executor:row.executor??'codex'});
  }
  async observe(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      // A small bounded read of exact App turns. No prompt, execution retry, or global task history.
      let active = this.options.forwarding.observationPage(this.observationCursor);
      if (!active.length && this.observationCursor) { this.observationCursor = undefined; active = this.options.forwarding.observationPage(); }
      const results = await Promise.allSettled(active.map(row => this.options.forwarding.refreshReceipt(row.id)));
      let terminal: ForwardRequest | undefined;
      for (const result of results) if (result.status === 'fulfilled') {
        const row=result.value; this.publishTimelineReceipt(row);
        if(row.phase==='unavailable'&&row.confirmedAt&&this.seenPhases.get(row.id)!==`${row.phase}:${row.nativeStatus??''}`)terminal=row;
        if(this.seenPhases.has(row.id)) this.announce(row); else this.seenPhases.set(row.id,`${row.phase}:${row.nativeStatus??''}`);
        if(row.phase==='completed'){this.latestCompletion=row;terminal=row;}
      }
      for (const row of this.options.forwarding.records()) {
        this.publishTimelineReceipt(row);
        if (row.phase === 'unavailable' && row.confirmedAt && this.seenPhases.get(row.id) !== `${row.phase}:${row.nativeStatus??''}`) terminal = row;
        if(this.seenPhases.has(row.id))this.announce(row);else this.seenPhases.set(row.id,`${row.phase}:${row.nativeStatus??''}`);
      }
      if (terminal && this.focus === 'work' && !this.draft() && this.focusId === terminal.id) this.focus = 'companion';
      if (terminal && this.focus === 'companion' && this.stage !== 'classifying') {
        this.stage = terminal.phase === 'completed' ? 'completed' : 'failed';
        clearTimeout(this.notificationTimer); const notice = this.stage;
        this.notificationTimer = setTimeout(() => { if (!this.closed && this.focus === 'companion' && this.stage === notice) { this.stage = 'idle'; this.publish(); } }, 4000);
        this.notificationTimer.unref();
      }
      const last = active.at(-1); if (last) this.observationCursor = { createdAt: last.createdAt, id: last.id };
      this.publish();
    } finally { this.ticking = false; }
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.shutdown.abort(); clearInterval(this.timer); clearTimeout(this.notificationTimer);
    await Promise.allSettled([...this.active]);
  }
}
