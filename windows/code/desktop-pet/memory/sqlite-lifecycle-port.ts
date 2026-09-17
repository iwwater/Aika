import type { ConversationMessage, DialogueContext, MemoryMaintenanceProvider, PerceptionResult, TurnScope } from '../contracts/index.js';
import type { BackgroundMemoryPort, MemoryTurnInput, MemoryTurnOutcome, MemoryTurnProvider, SummaryPort, SummaryProvider, SummaryResult } from '../contracts/memory-lifecycle.js';
import { MemoryRuleError, bindScope } from './scope.js';
import { SqliteMemoryPort, abortable, checkAbort, type SqliteContextOptions } from './sqlite-port.js';
import type { InputBudget, SummaryReadOptions } from './sqlite-lifecycle-state.js';
import { SqliteMemoryStore } from './sqlite-store.js';

export interface SqliteLifecycleOptions {
  readonly context: SqliteContextOptions;
  readonly turn: InputBudget<MemoryTurnInput> & { readonly provider: MemoryTurnProvider; readonly maxSupplementaryPlans?: 0 | 1 };
  readonly summary: SummaryReadOptions & { readonly provider: SummaryProvider };
}
/** No hidden scheduler or generation configuration. The application queues the original role and supplies providers. */
export class SqliteLifecycleMemoryPort extends SqliteMemoryPort implements BackgroundMemoryPort, SummaryPort {
  constructor(store: SqliteMemoryStore, private readonly lifecycleOptions: SqliteLifecycleOptions, legacyMaintenanceProvider?: MemoryMaintenanceProvider) {
    super(store, lifecycleOptions.context, legacyMaintenanceProvider);
    store.lifecycle.assertReady();
    if(![0,1].includes(lifecycleOptions.turn.maxSupplementaryPlans??0))throw new Error('invalid_supplementary_plan_limit');
    for (const n of [lifecycleOptions.turn.inputTokenBudget,lifecycleOptions.summary.inputTokenBudget,lifecycleOptions.summary.minMessages,lifecycleOptions.summary.maxMessages,lifecycleOptions.context.maxRecentMessages]) {
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error('invalid_lifecycle_configuration');
    }
    if (lifecycleOptions.summary.maxMessages < lifecycleOptions.summary.minMessages) throw new Error('invalid_summary_threshold');
    for (const n of [lifecycleOptions.context.maxMemories, lifecycleOptions.context.summaryLimit]) {
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid_lifecycle_configuration');
    }
  }
  async prepareTurn(scope: TurnScope, currentMessageId: string, text: string, signal: AbortSignal): Promise<MemoryTurnOutcome> {
    return this.prepare(scope,currentMessageId,text,signal,true);
  }
  async prepareBackgroundTurn(scope: TurnScope, currentMessageId: string, text: string, signal: AbortSignal): Promise<MemoryTurnOutcome> {
    return this.prepare(scope,currentMessageId,text,signal,false);
  }
  private async prepare(scope:TurnScope,currentMessageId:string,text:string,signal:AbortSignal,registerForeground:boolean):Promise<MemoryTurnOutcome> {
    checkAbort(signal); const owned = bindScope(scope, scope.characterId);
    const prior = this.store.lifecycle.outcome(owned, currentMessageId, text);
    if (prior) {if(registerForeground)this.store.lifecycle.registerCurrent(owned,currentMessageId,text,prior);return prior;}
    let ticket;
    try {ticket=this.store.lifecycle.readTurn(owned,currentMessageId,text,{...this.lifecycleOptions.context,...this.lifecycleOptions.turn});}
    catch(error){if(!(error instanceof MemoryRuleError))throw error;this.store.pending.fail(owned,currentMessageId);return {scope:owned,request:'none',status:'rejected',results:[],affectedIds:[],retrievalInvalidated:false,clarification:null,rejectionCode:error.message};}
    try {
      checkAbort(signal);
      let plan = await abortable(this.lifecycleOptions.turn.provider.plan(structuredClone(ticket.input), signal), signal);
      checkAbort(signal);
      if(this.lifecycleOptions.turn.maxSupplementaryPlans===1){
        const expansion=this.store.lifecycle.expandTurn(ticket,plan,this.lifecycleOptions.turn);
        if(expansion.status==='rejected'){this.store.pending.fail(owned,currentMessageId);return expansion.outcome;}
        if(expansion.status==='expanded'){
          const request=plan.request;ticket=expansion.ticket;checkAbort(signal);
          plan=await abortable(this.lifecycleOptions.turn.provider.plan(structuredClone(ticket.input),signal),signal);
          checkAbort(signal);
          if(plan.request!==request){this.store.pending.fail(owned,currentMessageId);return this.store.lifecycle.rejectTurn(ticket,plan,'supplementary_request_changed');}
        }
      }
      checkAbort(signal); const outcome=this.store.lifecycle.commitTurn(ticket,plan);
      if(registerForeground)this.store.lifecycle.registerCurrent(owned,currentMessageId,text,outcome);
      if(outcome.status==='rejected'||outcome.status==='needs_clarification')this.store.pending.fail(owned,currentMessageId);
      return outcome;
    } catch(error) {if(!this.store.closed)this.store.pending.fail(owned,currentMessageId);throw error;
    } finally { this.store.lifecycle.discardTurn(ticket); }
  }
  beginPendingMutation(scope:TurnScope,currentMessageId:string,pending:{request:'correction'|'forget'|'uncertain';sources:null}):void {this.store.lifecycle.beginPendingMutation(scope,currentMessageId,pending);}
  cancelPendingMutation(scope:TurnScope,currentMessageId:string):void {this.store.pending.cancel(scope,currentMessageId);}
  pendingMutations(characterId:TurnScope['characterId']) {return this.store.pending.list(characterId);}
  override async context(scope: TurnScope, text: string, perception: PerceptionResult | null, signal: AbortSignal): Promise<DialogueContext> {
    return this.store.lifecycle.trackContext(this.createContext(scope, text, perception, signal),text);
  }
  async foregroundContext(scope:TurnScope,currentMessageId:string,text:string,perception:PerceptionResult|null,signal:AbortSignal):Promise<DialogueContext> {
    checkAbort(signal);const owned=bindScope(scope,scope.characterId);
    const completedPending=this.store.lifecycle.registerForegroundCurrent(owned,currentMessageId,text);
    return this.store.lifecycle.trackContext(this.createContext(owned,text,perception,signal,completedPending),text,true);
  }
  override async append(scope:TurnScope,messages:readonly ConversationMessage[]):Promise<void> {
    if(messages.some(message=>message.role==='assistant'))throw new MemoryRuleError('assistant_requires_issued_context');
    const owned=bindScope(scope,scope.characterId),captured=structuredClone(messages);
    this.store.append(owned,captured);
    this.store.lifecycle.bindAppendedUsers(owned,captured);
  }
  async appendAssistant(scope:TurnScope,message:ConversationMessage,context:DialogueContext,currentMessageId:string,signal:AbortSignal):Promise<void> {
    this.store.lifecycle.appendAssistant(scope,message,context,currentMessageId,signal);
  }
  assertContextCurrent(context: DialogueContext): void { this.store.lifecycle.assertContextCurrent(context); }
  async summarizePending(scope: TurnScope, signal: AbortSignal): Promise<SummaryResult> {
    checkAbort(signal); const owned = bindScope(scope, scope.characterId);
    const ticket = this.store.lifecycle.readSummary(owned, this.lifecycleOptions.summary);
    if ('status' in ticket) return ticket;
    try {
      checkAbort(signal);
      const proposal = await abortable(this.lifecycleOptions.summary.provider.summarize(structuredClone(ticket.input), signal), signal);
      checkAbort(signal); return this.store.lifecycle.commitSummary(ticket, proposal);
    } finally { this.store.lifecycle.discardSummary(ticket); }
  }
}
