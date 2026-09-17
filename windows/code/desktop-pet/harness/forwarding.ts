import {isOutside} from '../core/platform-files.js';
import {openLocalUrl} from '../core/open-url.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workProjects } from './work-catalog.js';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { ManagementError } from '../contracts/management.js';
import { FORWARD_TARGET_LIMIT } from '../contracts/harness.js';
import type { ForwardingPort, ForwardPrepare, ForwardRequest, ForwardSnapshot, ForwardTargets } from '../contracts/harness.js';
import type { ProjectIndexPort } from '../contracts/projects.js';
import type { HarnessConnection, RelayMetrics } from './connection.js';
import { CodexAppError, type CodexAppConnection } from './codex-app.js';
import { ForwardReceipts, publicForward, type StoredForward } from './receipts.js';

interface Options {
  receipts: ForwardReceipts;
  projects: ProjectIndexPort;
  harness: Pick<HarnessConnection, 'probe' | 'createRelaySession' | 'submitConfirmedOperation'> & Partial<Pick<HarnessConnection, 'relayMetrics' | 'relayMetricsBatch' | 'requestTerminal'>>;
  nativeWork?: {
    workHostUrl?():Promise<string>;
    createWorkSession(sessionId:string,cwd:string):Promise<void>;
    submitWork(sessionId:string,requestId:string,text:string):Promise<void>;
    workReceipt(sessionId:string,requestId:string):Promise<{status:'working'|'approval'|'completed'|'failed'|'unknown';result?:string;detail?:string;sessionUrl?:string;approvalTools?:string[]}>;
  };
  workPresetReady?():Promise<boolean>;
  codex: Pick<CodexAppConnection, 'list' | 'discover' | 'send' | 'receipt'> & Partial<Pick<CodexAppConnection,'ensureAvailable'>>;
  compatible(): Promise<boolean>;
  presetReady(): Promise<boolean>;
  presetId: string;
  workspace: string;
  recordMetrics?(metrics: RelayMetrics): Promise<void>;
}
const invalid = (): never => { throw new ManagementError('invalid_request', '请核对任务正文、现有任务和项目。'); };
const sameVersion = (row: StoredForward, version: number) => { if (row.version !== version) throw new ManagementError('version_conflict', '请求已变化，请重新核对后确认。'); };
export class HarnessForwarding implements ForwardingPort {
  private readonly active = new Set<Promise<unknown>>();
  private observationTimer: NodeJS.Timeout | undefined;
  private observing = false;
  private usageWarning = false;
  constructor(private readonly options: Options) {}
  private track<T>(promise: Promise<T>): Promise<T> { this.active.add(promise); void promise.finally(() => this.active.delete(promise)).catch(() => {}); return promise; }
  observationPage(after?: { createdAt: string; id: string }): ForwardRequest[] { return this.options.receipts.observationPage(after).map(publicForward); }
  record(id: string): ForwardRequest { return publicForward(this.options.receipts.get(id)); }
  pendingCount(): number { return this.options.receipts.pendingCount(); }
  records(): ForwardRequest[] { return this.options.receipts.list().map(publicForward); }
  async snapshot(): Promise<ForwardSnapshot> {
    const [host, app, preset] = await Promise.all([this.options.harness.probe(), this.options.compatible(), this.options.presetReady()]);
    return { requests: this.options.receipts.list().map(publicForward), connection: { harness: host.state, codex: app ? 'compatible' : 'incompatible', preset: preset ? 'ready' : 'unavailable' } };
  }
  async targets(query: string): Promise<ForwardTargets> { return { limit: FORWARD_TARGET_LIMIT, items: this.options.codex.list(query,FORWARD_TARGET_LIMIT) }; }
  async projectChoices() {
    let targets: ReturnType<CodexAppConnection['list']>=[];
    try { targets=this.options.codex.list('',1000); } catch {}
    return workProjects(this.options.projects,targets);
  }
  private async validatePrepare(input: ForwardPrepare): Promise<Pick<ForwardRequest,'text'|'target'|'project'|'executor'|'plan'>> {
    const executor=input?.executor??'codex';
    if (!input || typeof input.text!=='string' || !input.text.trim() || input.text.length>20000 || input.text.includes('\0') ||
      !['codex','harness'].includes(executor) || (input.projectId===undefined)!==(input.projectVersion===undefined)) return invalid();
    let target: ForwardRequest['target'];
    if(executor==='codex'){
      if(input.target?.hostId!=='local'||typeof input.target.threadId!=='string')return invalid();
      const actual=this.options.codex.list(input.target.threadId).find(t=>t.threadId===input.target!.threadId);
      if(!actual)throw new ManagementError('not_found','目标不在真实用户任务目录中，请重新整理任务卡。');
      target={hostId:'local',threadId:actual.threadId,title:actual.title};
    } else if(input.target!==undefined)return invalid();
    const choices=await this.projectChoices();
    let selected=input.projectId?choices.find(p=>p.id===input.projectId):undefined;
    if(input.projectId && (!selected||selected.version!==input.projectVersion))throw new ManagementError('version_conflict','项目目录已变化，请重新整理任务卡。');
    if(target){
      const actual=this.options.codex.list(target.threadId).find(t=>t.threadId===target!.threadId)!;
      const root=await realpath(actual.projectPath).catch(()=>invalid());
      if(selected && selected.detailRef.rootPath!==root)throw new ManagementError('invalid_request','目标任务与项目目录不一致，请修改任务卡。');
      selected??=choices.find(p=>p.detailRef.rootPath===root);
    }
    let project:ForwardRequest['project'];
    if(selected){
      const root=await realpath(selected.detailRef.rootPath).catch(()=>invalid());
      if(root!==selected.detailRef.rootPath || !(await stat(root)).isDirectory())return invalid();
      if(selected.detailRef.entryFile){
        const path=await realpath(resolve(root,selected.detailRef.entryFile)).catch(()=>invalid()), rel=relative(root,path);
        if(isOutside(root,path)||!(await stat(path)).isFile())return invalid();
      }
      project={id:selected.id,name:selected.name,version:selected.version,detailRef:selected.detailRef,source:selected.source};
    }
    if(input.plan && (typeof input.plan.title!=='string'||input.plan.title.length>120||typeof input.plan.reason!=='string'||input.plan.reason.length>500 || input.plan.spokenSummary!==undefined&&(typeof input.plan.spokenSummary!=='string'||!input.plan.spokenSummary.trim()||input.plan.spokenSummary.length>500||input.plan.spokenSummary.includes('\0'))))return invalid();
    return {text:input.text,executor,...(target?{target}:{}),...(project?{project}:{}),...(input.plan?{plan:input.plan}:{})};
  }
  async prepare(input: ForwardPrepare): Promise<ForwardRequest> { return publicForward(this.options.receipts.create(await this.validatePrepare(input))); }
  async prepareDraft(input: ForwardPrepare, draftId:string, expectedVersion:number): Promise<ForwardRequest> {
    const frozen=await this.validatePrepare(input);
    return publicForward(this.options.receipts.prepareDraft(draftId,expectedVersion,frozen));
  }
  async openNative(id:string):Promise<void>{
    const row=this.options.receipts.get(id);
    if(row.executor!=='harness'||!row.confirmedAt||!row.harnessSessionId||!this.options.nativeWork?.workHostUrl)invalid();
    const url=new URL(await this.options.nativeWork!.workHostUrl!());
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)invalid();
    await openLocalUrl(url.toString());
  }
  async confirm(id: string, expectedVersion: number, assertCurrent?: () => void): Promise<ForwardRequest> {
    assertCurrent?.();
    const current = this.options.receipts.get(id);
    if (current.phase !== 'awaiting_confirmation') return publicForward(current);
    sameVersion(current, expectedVersion);
    await this.validatePrepare({text:current.text,executor:current.executor??'codex',...(current.target?{target:current.target}:{}),...(current.project?{projectId:current.project.id,projectVersion:current.project.version}:{})});
    if (current.project) {
      const latest=(await this.projectChoices()).find(p=>p.id===current.project!.id);
      if(!latest||latest.version!==current.project.version||latest.detailRef.rootPath!==current.project.detailRef.rootPath)
        throw new ManagementError('version_conflict','项目资料已变化，请修改任务卡后确认。');
    }
    if(current.executor==='harness'){
      if(!this.options.nativeWork || !await this.options.workPresetReady?.())throw new ManagementError('unavailable','Harness原生执行配置尚未就绪；没有发送。');
    } else {
      if (!current.target || !await this.options.compatible()) throw new ManagementError('unavailable','任务连接尚未就绪；没有发送。');
      const owner=await (this.options.codex.ensureAvailable?.(current.target.threadId)??this.options.codex.discover(current.target.threadId)).catch(()=>({available:false}));
      if(!owner.available)throw new ManagementError('unavailable','已尝试恢复这个真实Codex任务，但仍未连接；本次没有发送，请稍后重试原卡。');
    }
    assertCurrent?.();
    let claimed = false;
    const record = this.options.receipts.mutate(id, row => {
      if (row.phase !== 'awaiting_confirmation') return;
      sameVersion(row, expectedVersion); row.phase = 'forwarding'; row.confirmedAt = new Date().toISOString();
      if(row.executor==='harness')row.harnessSessionId = 'session-' + randomUUID();
      claimed = true;
    });
    if (!claimed) return publicForward(record);
    // The existing exact-once send boundary also accepts old confirmed relay requests.
    if(record.executor!=='harness')return this.sendConfirmed(id);
    return this.track((async () => {
      try {
        if(record.executor==='harness'){
          await this.options.nativeWork!.createWorkSession(record.harnessSessionId!,record.project?.detailRef.rootPath??this.options.workspace);
          const text=record.text+(record.project?'\n\n[Confirmed project reference]\n'+JSON.stringify(record.project)+'\nRead current project constraints as needed.':'');
          await this.options.nativeWork!.submitWork(record.harnessSessionId!,record.harnessRequestId,text);
          this.options.receipts.mutate(id,row=>{row.phase='accepted';row.detail='Harness正在执行；如需工具批准，请在原生会话中处理。';});
        }
      } catch {
        this.options.receipts.mutate(id, row => { if (!row.appTurnId) { row.phase = 'unknown'; row.detail = '尚未确认转发结果，请核对原请求；不会自动重复发送。'; } });
      }
      return publicForward(this.options.receipts.get(id));
    })());
  }
  /** Narrow MCP entry: no prompt, path, target, model or permissions can be supplied here. */
  async sendConfirmed(id: string): Promise<ForwardRequest> {
    let claimed = false;
    const record = this.options.receipts.mutate(id, row => {
      if (row.executor==='harness') throw new ManagementError('forbidden','Harness自身执行记录不允许转发到Codex。');
      if (!row.confirmedAt) throw new ManagementError('forbidden', '这次请求尚未得到用户确认。');
      if (row.dispatchAttempted) return;
      row.dispatchAttempted = true; row.phase = 'forwarding'; claimed = true;
    });
    if (!claimed) return publicForward(record);
    return this.track((async () => {
      const text = record.text;
      try {
        if (record.project) {
          try {
            const ref = record.project.detailRef, root = await realpath(ref.rootPath);
            if (root !== ref.rootPath || !(await stat(root)).isDirectory()) throw Error();
            if (ref.entryFile) {
              const path = await realpath(resolve(root, ref.entryFile)), rel = relative(root, path);
              if (isOutside(root,path) || !(await stat(path)).isFile()) throw Error();
            }
          } catch { throw new CodexAppError('invalid_target'); }
        }
        const receipt = await this.options.codex.send(record.target!.threadId, text, record.ipcRequestId);
        return publicForward(this.options.receipts.mutate(id, row => { row.appTurnId = receipt.turnId; row.phase = 'accepted'; delete row.detail; }));
      } catch (error) {
        return publicForward(this.options.receipts.mutate(id, row => {
          row.phase = error instanceof CodexAppError && error.code !== 'unknown_delivery' ? 'unavailable' : 'unknown';
          row.detail = row.phase === 'unknown' ? 'Codex 的接收结果尚未确认，请查看原任务；不会自动重发。' : '这次没有连接到目标任务，请核对 Codex 连接。';
        }));
      }
    })());
  }
  async refresh(id: string): Promise<ForwardRequest> {
    const record = this.options.receipts.get(id);
    if (record.harnessSessionId && this.options.harness.relayMetrics && this.options.recordMetrics) {
      try { const metrics = await this.options.harness.relayMetrics(record.harnessSessionId); if (metrics) await this.options.recordMetrics(metrics); }
      catch { this.warnUsage(); }
    }
    return this.refreshReceipt(id);
  }
  /** Receipt-only observation for the desktop; no model prompt or repeated usage polling. */
  async refreshReceipt(id: string): Promise<ForwardRequest> {
    const record = this.options.receipts.get(id);
    if(record.executor==='harness'){
      if(!record.harnessSessionId||!this.options.nativeWork||['completed','unavailable'].includes(record.phase))return publicForward(record);
      const state=await this.options.nativeWork.workReceipt(record.harnessSessionId,record.harnessRequestId);
      return publicForward(this.options.receipts.mutate(id,row=>{
        row.nativeStatus=state.status;
        if(state.status==='approval')row.nativeApprovalTools=(state.approvalTools??[]).filter(name=>['bash','read_file','write_file','edit_file','apply_patch'].includes(name));
        else delete row.nativeApprovalTools;
        if(state.sessionUrl)row.nativeSessionUrl=state.sessionUrl;
        if(state.status==='completed'){row.phase='completed';row.result=state.result??'';delete row.detail;}
        else if(state.status==='failed'){row.phase='unavailable';row.detail=state.detail??'Harness执行未完成，请查看原会话。';}
        else if(state.status==='approval'){row.phase='accepted';row.detail=state.detail??'等待原生Harness中的工具批准。';}
        else if(state.status==='unknown'){row.phase='unknown';row.detail=state.detail??'原生请求结果未知；不会自动重发。';}
        else {row.phase='accepted';row.detail=state.detail??'Harness正在执行。';}
      }));
    }
    if (!record.appTurnId || record.phase === 'completed') return publicForward(record);
    const receipt = await this.options.codex.receipt(record.target!.threadId, record.appTurnId);
    // A slower unknown observation must not downgrade a concurrent exact completion.
    const latest = this.options.receipts.get(id);
    if (latest.phase === 'completed') return publicForward(latest);
    if (receipt.status !== 'completed') {
      if (receipt.reason && ['accepted', 'forwarding', 'unknown'].includes(latest.phase)) {
        const detail = receipt.reason === 'interrupted' ? '原任务已中断，请到 Codex 查看后续结果。'
          : '原任务的完成回执未找到，请到 Codex 核对后续结果。';
        if (latest.phase !== 'unknown' || latest.detail !== detail)
          return publicForward(this.options.receipts.mutate(id, row => { row.phase = 'unknown'; row.detail = detail; }));
      }
      return publicForward(latest);
    }
    return publicForward(this.options.receipts.mutate(id, row => { row.phase = 'completed'; row.result = receipt.reply ?? ''; delete row.detail; }));
  }
  async toolStatus(id: string): Promise<ForwardRequest> {
    if (!this.options.receipts.get(id).confirmedAt) throw new ManagementError('forbidden', '这次请求尚未得到用户确认。');
    return this.refresh(id);
  }
  private warnUsage() { if (!this.usageWarning) { this.usageWarning = true; process.stderr.write('Harness usage reconciliation pending; native usage retained, no cost assumed zero.\n'); } }
  /** Read-only usage observation, including after restart; never creates, prompts or resends work. */
  async observeUsage(): Promise<void> {
    if (this.observing || !this.options.harness.relayMetricsBatch || !this.options.recordMetrics) return;
    const records = this.options.receipts.pendingUsage(); if (!records.length) return;
    this.observing = true;
    try {
      const metrics = await this.options.harness.relayMetricsBatch(records.map(row => row.harnessSessionId!));
      for (const row of records) {
        const value = metrics.find(value => value.sessionId === row.harnessSessionId);
        let ended = row.harnessEnded === true;
        if (!ended && value?.throughSeq !== undefined && this.options.harness.requestTerminal) {
          const terminal = await this.options.harness.requestTerminal(row.harnessSessionId!, row.harnessRequestId, value.throughSeq);
          if (terminal.status === 'ended') {
            ended = true;
            this.options.receipts.mutate(row.id, latest => {
              latest.harnessEnded = true;
              if (latest.executor!=='harness' && !latest.appTurnId && latest.phase === 'forwarding') { latest.phase = 'unknown'; latest.detail = '转发会话已结束，尚未取得目标任务回执；请核对原任务，不会自动重发。'; }
            });
          }
        }
        if (!value?.usage || !value.model) continue;
        await this.options.recordMetrics(value);
        if (ended && !value.running && Object.values(value.usage).some(tokens => tokens > 0)) this.options.receipts.mutate(row.id, latest => {
          latest.usageComplete = true;
        });
      }
      this.usageWarning = false;
    } catch { this.warnUsage(); }
    finally { this.observing = false; }
  }
  startUsageObservation(intervalMs = 5000) {
    if (this.observationTimer) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10) throw Error('Invalid observation interval');
    const tick = () => { void this.track(this.observeUsage()).catch(() => this.warnUsage()); };
    this.observationTimer = setInterval(tick, intervalMs); this.observationTimer.unref(); tick();
  }
  async close() { clearInterval(this.observationTimer); this.observationTimer = undefined; await Promise.allSettled([...this.active]); this.options.receipts.close(); }
}
