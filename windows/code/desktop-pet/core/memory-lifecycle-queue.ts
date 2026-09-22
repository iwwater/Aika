import type { CharacterId, ConversationMessage, DialogueContext, PerceptionResult, TurnScope } from '../contracts/index.js';
import type { AssistantMemoryPort, BackgroundMemoryPort, MemoryPendingObservation, MemoryPendingSnapshot, MemoryTurnOutcome, MemoryTurnPort, SummaryPort, PendingMemoryMutation } from '../contracts/memory-lifecycle.js';
import { requireAssistantMemoryPort } from './assistant-memory.js';

/** Preserve accepted input's role while allowing its frontend to stop waiting immediately. */
export class RoleMemoryLifecycleQueue {
  private readonly pending = new Map<CharacterId, Promise<unknown>>();
  private readonly foregroundPending = new Set<Promise<unknown>>();
  private readonly states = new Map<CharacterId, MemoryPendingSnapshot>();
  private readonly lifetime = new AbortController();
  private readonly assistantMemory: AssistantMemoryPort;
  constructor(
    private readonly memory: MemoryTurnPort & SummaryPort,
    private readonly reportFailure: (scope: TurnScope, error: unknown, kind?: 'memory' | 'summary') => void,
    private readonly traceStore?: import('./trace-store.js').RuntimeTraceStore,
  ) {
    this.assistantMemory = requireAssistantMemoryPort(memory);
  }
  private transition(characterId: CharacterId, queued: number, running: number): void {
    const before = this.states.get(characterId) ?? { revision: 0, queued: 0, running: 0 };
    this.states.set(characterId, Object.freeze({ characterId, revision: before.revision + 1,
      queued: before.queued + queued, running: before.running + running }));
  }
  observePending(characterId: CharacterId): MemoryPendingObservation {
    this.lifetime.signal.throwIfAborted();
    const snapshot = this.states.get(characterId) ?? Object.freeze({ characterId, revision: 0, queued: 0, running: 0 });
    return Object.freeze({ snapshot, assertCurrent: () => {
      this.lifetime.signal.throwIfAborted();
      if ((this.states.get(characterId)?.revision ?? 0) !== snapshot.revision) throw new Error('stale_memory_pending_state');
    } });
  }
  private schedule<T>(scope: TurnScope, work: (owned: TurnScope, signal: AbortSignal) => Promise<T>, track = true): Promise<T> {
    const owned = Object.freeze({ ...scope });
    const previous = this.pending.get(owned.characterId) ?? Promise.resolve();
    if (track) this.transition(owned.characterId, 1, 0);
    const next = previous.catch(() => {}).then(async () => {
      if (track) this.transition(owned.characterId, -1, 1);
      try {
        this.lifetime.signal.throwIfAborted();
        return await work(owned, this.lifetime.signal);
      } finally { if (track) this.transition(owned.characterId, 0, -1); }
    });
    // Keep rejection handled even after the cancelling frontend has detached.
    const settled = next.catch(() => {});
    this.pending.set(owned.characterId, settled);
    return next;
  }
  prepareTurn(scope: TurnScope, currentMessageId: string, text: string, foreground: AbortSignal): Promise<MemoryTurnOutcome> {
    foreground.throwIfAborted(); this.lifetime.signal.throwIfAborted();
    const work = this.schedule(scope, (owned, signal) => this.memory.prepareTurn(owned, currentMessageId, text, signal));
    return this.observeForeground(work, foreground);
  }
  private backgroundMemory(): BackgroundMemoryPort {
    const candidate=this.memory as Partial<BackgroundMemoryPort>;
    if(typeof candidate.prepareBackgroundTurn!=='function'||typeof candidate.foregroundContext!=='function')throw new Error('background_memory_not_implemented');
    return this.memory as MemoryTurnPort & SummaryPort & BackgroundMemoryPort;
  }
  async beginPendingMutation(scope:TurnScope,currentMessageId:string,pending:PendingMemoryMutation):Promise<void> {
    this.lifetime.signal.throwIfAborted();
    const memory=this.backgroundMemory();
    if(!memory.beginPendingMutation)throw new Error('pending_mutation_not_implemented');
    await memory.beginPendingMutation(Object.freeze({...scope}),currentMessageId,pending);
  }
  enqueueTurn(scope:TurnScope,currentMessageId:string,text:string):Promise<MemoryTurnOutcome> {
    const owned=Object.freeze({...scope});
    const planStart = performance.now();
    const work=this.schedule(owned, async (captured,signal)=>{
      const planStart = performance.now();
      const outcome = await this.backgroundMemory().prepareBackgroundTurn(captured,currentMessageId,text,signal);
      const planElapsed = Math.max(1, Math.round(performance.now() - planStart));
      try {
        this.traceStore?.appendStage(captured.turnId, {
          name: 'memory_plan',
          label: '后台记忆规划与提炼',
          elapsedMs: planElapsed,
          category: 'background',
          status: outcome.status === 'rejected' ? 'failed' : 'ok',
          details: { request: outcome.request, outcomeStatus: outcome.status },
        });
        if (outcome.status === 'applied') {
          const commitStart = performance.now();
          const commitElapsed = Math.max(1, Math.round(performance.now() - commitStart));
          this.traceStore?.appendStage(captured.turnId, {
            name: 'memory_commit',
            label: '后台记忆落库提交',
            elapsedMs: commitElapsed,
            category: 'background',
            status: 'ok',
            details: { affectedIds: outcome.affectedIds, retrievalInvalidated: outcome.retrievalInvalidated },
          });
        }
      } catch {}
      return outcome;
    });
    const reported=work.then(outcome=>{
      if(outcome.status==='rejected'&&!this.lifetime.signal.aborted)this.reportFailure(owned,new Error(outcome.rejectionCode??'background_memory_rejected'),'memory');
    },error=>{if(!this.lifetime.signal.aborted)this.reportFailure(owned,error,'memory');});
    // A diagnostic sink cannot leave an unhandled rejection or change the actual job result.
    void reported.catch(()=>{});
    return work;
  }
  private immediate<T>(scope:TurnScope,foreground:AbortSignal,work:(owned:TurnScope,signal:AbortSignal)=>Promise<T>):Promise<T> {
    foreground.throwIfAborted();this.lifetime.signal.throwIfAborted();
    const owned=Object.freeze({...scope}),signal=AbortSignal.any([foreground,this.lifetime.signal]);
    // Do not chain short foreground work behind a model wait. Still own its shutdown lifetime.
    const running=work(owned,signal),settled=running.catch(()=>{});
    this.foregroundPending.add(settled);
    void settled.then(()=>this.foregroundPending.delete(settled));
    return this.observeForeground(running,signal);
  }
  async foregroundContext(scope:TurnScope,currentMessageId:string,text:string,perception:PerceptionResult|null,signal:AbortSignal):Promise<DialogueContext> {
    return this.immediate(scope,signal,(owned,lifetime)=>this.backgroundMemory().foregroundContext(owned,currentMessageId,text,perception,lifetime));
  }
  async appendForegroundAssistant(scope:TurnScope,message:ConversationMessage,context:DialogueContext,currentMessageId:string,signal:AbortSignal):Promise<void> {
    const captured=Object.freeze({...message});
    return this.immediate(scope,signal,(owned,lifetime)=>this.backgroundMemory().appendAssistant(owned,captured,context,currentMessageId,lifetime));
  }
  private observeForeground<T>(work: Promise<T>, foreground: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(foreground.reason ?? new Error('Frontend cancelled'));
      foreground.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject).finally(() => foreground.removeEventListener('abort', abort));
      if (foreground.aborted) abort();
    });
  }
  assertContextCurrent(context: DialogueContext): void { this.memory.assertContextCurrent(context); }
  async appendAssistant(scope: TurnScope, message: ConversationMessage, context: DialogueContext, currentMessageId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); this.lifetime.signal.throwIfAborted();
    const captured = Object.freeze({ ...message });
    const work = this.schedule(scope, async owned => {
      signal.throwIfAborted();
      // Keep the issued context object: cloning it would destroy the storage-issued identity proof.
      await this.assistantMemory.appendAssistant(owned, captured, context, currentMessageId, signal);
    }, false);
    await this.observeForeground(work, signal);
  }
  afterConversationSaved(scope: TurnScope): void {
    if (this.lifetime.signal.aborted) return;
    const captured=Object.freeze({...scope});
    const summaryStart = performance.now();
    void this.schedule(captured, async (owned, signal) => {
      const result = await this.memory.summarizePending(owned, signal);
      const elapsedMs = Math.max(1, Math.round(performance.now() - summaryStart));
      try {
        if (result.status === 'applied') {
          this.traceStore?.appendStage(captured.turnId, {
            name: 'summary',
            label: '阶段对话摘要落库',
            elapsedMs,
            status: 'ok',
            details: { summaryId: result.summaryId },
          });
        }
      } catch {}
      return result;
    }).catch(error => {
      if (!this.lifetime.signal.aborted) this.reportFailure(captured, error,'summary');
    }).catch(()=>{});
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.pending.values(),...this.foregroundPending]); }
  async close(): Promise<void> { this.lifetime.abort(); await this.drain(); }
}
