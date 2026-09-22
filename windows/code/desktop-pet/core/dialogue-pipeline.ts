import type { EmotionInferenceInput, EmotionTurnPort } from '../contracts/emotion-state.js';
import { cleanWakeTranscript } from './wake-transcript.js';
import { userFacingError } from './user-facing-error.js';
import type { CapturedInput, DialogueProvider, MemoryPort, MediaStorePort, PerceptionProvider, PlaybackEvent, PlaybackPort, TtsProvider, TurnInput, TurnScope, DesktopEvent, PerceptionResult, DialogueContext, ConversationMessage } from '../contracts/index.js';
import { sameScope, TurnController } from './turn-controller.js';
import type { AssistantMemoryPort, BackgroundMemoryPort, MemoryTurnOutcome, MemoryTurnPort, ForegroundMemoryRequest, MemoryTurnPending } from '../contracts/memory-lifecycle.js';
import type { RuntimeTraceStore, TraceStage } from './trace-store.js';
import { randomUUID } from 'node:crypto';

/** Strict writes are always background; semantic request kind controls privacy, never a writer wait. */
export interface BackgroundDialogueMemory extends Pick<BackgroundMemoryPort, 'foregroundContext' | 'assertContextCurrent'> {
  /** Historical host API remains readable; it no longer selects a synchronous writer path. */
  isIndependent?(scope: TurnScope, text: string, signal: AbortSignal): boolean | Promise<boolean>;
  classifyRequest?(scope: TurnScope, text: string, signal: AbortSignal): ForegroundMemoryRequest | Promise<ForegroundMemoryRequest>;
  beginPendingMutation?: BackgroundMemoryPort['beginPendingMutation'];
  enqueueTurn(scope: TurnScope, currentMessageId: string, text: string): Promise<MemoryTurnOutcome>;
  appendForegroundAssistant: AssistantMemoryPort['appendAssistant'];
}

export interface DialoguePorts {
  emotion?: EmotionTurnPort;
  /** Trusted channel policy; text output completes without any audio or playback events. */
  outputMode?: 'voice' | 'text';
  work?: import('../contracts/desktop-work.js').DesktopWorkPort;
  onInputRoute?(scope: TurnScope, route: 'companion' | 'work'): void;
  perception: PerceptionProvider;
  dialogue: DialogueProvider;
  tts: TtsProvider;
  playback: PlaybackPort;
  memory: MemoryPort;
  mediaStore: MediaStorePort;
  memoryLifecycle?: Pick<MemoryTurnPort, 'prepareTurn' | 'assertContextCurrent'> & AssistantMemoryPort;
  backgroundMemory?: BackgroundDialogueMemory;
  /** N075-01/R5: optional real production trace recording for every turn stage. */
  traceStore?: RuntimeTraceStore;
  /** Privacy opt-in: defaults to false (storing only digest and lengths, not full personal chat). */
  traceDebugOptIn?: boolean;
}
export class StaleTurnError extends Error {
  constructor() { super('Turn is cancelled or no longer current'); this.name = 'StaleTurnError'; }
}
/** Executes one already-created turn; UI owns starting/stopping capture and serializing commands. */
export class DialoguePipeline {
  constructor(private readonly ports: DialoguePorts, private readonly controller: TurnController, private readonly emit: (event: DesktopEvent) => void, private readonly afterConversationSaved?: (scope: TurnScope, text: string) => void) {}
  private current(scope: TurnScope, signal: AbortSignal): void {
    if (signal.aborted || !this.controller.accepts(scope)) throw new StaleTurnError();
  }
  private belongs(scope: TurnScope, response: {scope: TurnScope}): void {
    if (!sameScope(scope, response.scope)) throw new Error('Response scope does not match its request');
  }
  private contextBelongs(scope: TurnScope, context: DialogueContext): void {
    this.belongs(scope, context);
    if (context.recent.some(m => m.characterId !== scope.characterId) || context.memories.some(m => m.characterId !== scope.characterId)) throw new Error('Context contains another character');
    if (context.perception) this.belongs(scope, context.perception);
  }
  private presentation(): void {
    const presentation = this.controller.snapshot();
    if (presentation) this.emit({type: 'presentation', presentation});
  }
  async run(input: TurnInput, signal: AbortSignal, captured?: CapturedInput): Promise<{status: 'played' | 'replied' | 'handled' | 'cancelled' | 'failed'; error?: string}> {
    const {scope} = input;
    let outcome: {status: 'played' | 'replied' | 'handled' | 'cancelled' | 'failed'; error?: string} | undefined;
    let playbackFailed = false;
    const turnStart = performance.now();
    let llmStart = 0;
    const stages: TraceStage[] = [];
    let text = input.text ?? '';
    let replyText = '';
    try {
      this.current(scope, signal);
      let perception: PerceptionResult | null = null;
      if (input.kind === 'voice') {
        if (!captured) throw new Error('Voice turn requires captured audio and capture-stop evidence');
        this.belongs(scope, captured);
        if (input.transcript === undefined) {
          // Batch fallback only: the whole utterance is transcribed after the key is released.
          perception = await this.ports.perception.perceive(captured, signal);
          this.current(scope, signal); this.belongs(scope, perception);
          if (perception.status === 'failed') throw new Error('Perception failed');
          text = perception.transcript;
        } else {
          // FIX61-08: the live streaming recognizer already produced the verified transcript for this
          // input session. Accept it as-is — never call a second (batch) ASR for a voice turn.
          text = input.transcript;
          if (!captured.audio.id) throw new Error('Voice turn requires its captured audio');
          perception = { scope, transcript: text, modalities: [], cues: [], status: 'complete' };
        }
        if(input.wakeKeyword){
          text=cleanWakeTranscript(text,input.wakeKeyword);
          perception={...(perception ?? { scope, transcript: text, modalities: [], cues: [], status: 'complete' as const }),transcript:text};
        }
        this.emit({ type: 'transcript', scope: Object.freeze({ ...scope }), text });
      } else if (captured) {
        throw new Error('Text turns must not receive microphone or camera capture');
      }
      if(input.kind==='voice'&&input.wakeKeyword&&!text){
        this.controller.finish(scope);this.presentation();outcome={status:'handled'};
      }else{
      this.controller.thinking(scope); this.presentation();
      const admissionStart = performance.now();
      const routed = await this.ports.work?.route(scope, text, signal) ?? 'companion';
      this.current(scope, signal);
      this.ports.onInputRoute?.(scope, routed === 'handled' ? 'work' : 'companion');
      if (routed === 'handled') {
        stages.push({ name: 'admission', label: '意图路由与准入', elapsedMs: Math.max(1, Math.round(performance.now() - admissionStart)), status: 'ok', details: { route: 'work' } });
        this.controller.finish(scope); this.presentation(); outcome = { status: 'handled' };
      } else {
      const userMessage: ConversationMessage = {characterId: scope.characterId, id: `${scope.turnId}:user`, role: 'user', text, createdAt: new Date().toISOString()};
      const source={id:userMessage.id,version:1};
      const observations=this.ports.emotion?.observations(scope,source,text,perception);
      const capturedUser=observations?{...userMessage,emotionObservations:observations}:userMessage;
      await this.ports.memory.append(scope, [capturedUser]);
      this.current(scope, signal);
      const background = this.ports.backgroundMemory;
      const independent = !!background;
      let memoryPending: MemoryTurnPending | undefined;
      if (background) {
        const request = await background.classifyRequest?.(Object.freeze({ ...scope }), text, signal) ?? 'none';
        this.current(scope, signal);
        if (!['none','correction','forget','uncertain'].includes(request)) throw new Error('Invalid foreground memory request');
        if (request !== 'none') {
          if (!background.beginPendingMutation) throw new Error('Pending memory privacy is unavailable');
          await background.beginPendingMutation(scope, userMessage.id, {request, sources:null});
          this.current(scope, signal);
        }
        memoryPending={scope:Object.freeze({...scope}),request,status:'pending'};
        // Queue owns lifetime and diagnostics; no completed outcome is invented for the foreground.
        void background!.enqueueTurn(scope, userMessage.id, text).catch(() => {});
        stages.push({ name: 'memory_enqueue', label: '后台记忆排队', elapsedMs: 0, status: 'ok', category: 'background', details: { request } });
      }
      stages.push({ name: 'admission', label: '意图路由与准入', elapsedMs: Math.max(1, Math.round(performance.now() - admissionStart)), status: 'ok', category: 'foreground', details: { route: 'companion', memoryRequest: memoryPending?.request ?? 'none' } });
      const memoryOutcome = independent ? undefined : await this.ports.memoryLifecycle?.prepareTurn(scope, userMessage.id, text, signal);
      this.current(scope, signal);
      if (memoryOutcome) {
        this.belongs(scope, memoryOutcome);
        if (memoryOutcome.status === 'rejected') throw new Error('这次记忆变更没有完成，请稍后再试。');
        if (memoryOutcome.request !== 'none' && memoryOutcome.status === 'unchanged') throw new Error('这次记忆请求尚未确定处理结果。');
        if (memoryOutcome.status === 'applied' && (memoryOutcome.results.some(result => result.status !== 'applied' || result.characterId !== scope.characterId) || !memoryOutcome.retrievalInvalidated || !memoryOutcome.affectedIds.length)) throw new Error('记忆提交结果不完整，尚不能确认。');
        if (memoryOutcome.status === 'needs_clarification' && (memoryOutcome.results.length || memoryOutcome.affectedIds.length || memoryOutcome.retrievalInvalidated)) throw new Error('澄清请求不能包含已执行的变更。');
      }
      const contextStart = performance.now();
      const context = independent
        ? await background!.foregroundContext(scope, userMessage.id, text, perception, signal)
        : await this.ports.memory.context(scope, text, perception, signal);
      this.current(scope, signal); this.contextBelongs(scope, context);
      stages.push({ name: 'context', label: '上下文与记忆召回', elapsedMs: Math.max(1, Math.round(performance.now() - contextStart)), status: 'ok', category: 'foreground', details: { memories: context.memories.length, recent: context.recent.length, inputTokenBudget: context.inputTokenBudget, hasContinuity: !!context.continuity } });
      const validateContext = () => independent ? background!.assertContextCurrent(context) : this.ports.memoryLifecycle?.assertContextCurrent(context);
      validateContext();
      let emotionInput:EmotionInferenceInput|null=null;
      if(!memoryPending || memoryPending.request==='none')try{emotionInput=this.ports.emotion?.prepare(context,source,text)??null;}catch{/* Optional state stays unavailable. */}
      // Ambiguous requests get the resolver's question without another model turning it into an acknowledgement.
      const llmStart = performance.now();
      const reply = memoryOutcome?.status === 'needs_clarification'
        ? { scope, text: memoryOutcome.clarification?.trim() ?? '', expression: { emotion: 'neutral', intensity: 0, delivery: '自然、温和地询问', gesture: null } }
        : await this.ports.dialogue.reply({scope, text, context, ...(memoryOutcome ? { memoryOutcome } : {}), ...(memoryPending ? {memoryPending} : {})}, signal);
      if (!reply.text) throw new Error('需要澄清的记忆请求缺少问题。');
      replyText = reply.text;
      stages.push({ name: 'llm', label: '大模型对话生成', elapsedMs: Math.max(1, Math.round(performance.now() - llmStart)), status: 'ok', category: 'foreground', details: { emotion: reply.expression.emotion } });
      this.current(scope, signal); this.belongs(scope, reply);
      validateContext();
      if(emotionInput)try{this.ports.emotion?.complete(emotionInput,reply.emotionAssessment);}catch{/* Emotion metadata cannot interrupt a reply. */}
      const persistStart = performance.now();
      const assistantMessage: ConversationMessage = {characterId: scope.characterId, id: `${scope.turnId}:assistant`, role: 'assistant', text: reply.text, createdAt: new Date().toISOString()};
      if (independent) {
        await background!.appendForegroundAssistant(scope, assistantMessage, context, userMessage.id, signal);
      } else if (this.ports.memoryLifecycle) {
        await this.ports.memoryLifecycle.appendAssistant(scope, assistantMessage, context, userMessage.id, signal);
      } else {
        await this.ports.memory.append(scope, [assistantMessage]);
      }
      stages.push({ name: 'assistant_persist', label: '助手回复持久化', elapsedMs: Math.max(1, Math.round(performance.now() - persistStart)), status: 'ok', category: 'foreground' });
      // The background owner captures this original role before frontend cancellation/switching.
      this.afterConversationSaved?.(scope, text);
      this.current(scope, signal);
      validateContext();
      this.emit({type: 'reply', reply});
      if (this.ports.outputMode === 'text') {
        this.controller.finish(scope); this.presentation(); outcome = { status: 'replied' };
      } else {
      this.controller.express(scope, reply.expression); this.presentation();
      const ttsStart = performance.now();
      const audio = await this.ports.tts.synthesize(reply, signal);
      stages.push({ name: 'tts', label: '语音合成', elapsedMs: Math.max(1, Math.round(performance.now() - ttsStart)), status: 'ok', category: 'foreground' });
      this.current(scope, signal); this.belongs(scope, audio);
      validateContext();
      let started = false; let ended = false; let stopped = false; let playbackError: string | undefined;
      let contextInvalidated = false;
      let invalidationStop: Promise<void> | undefined;
      await this.ports.playback.play(audio, (event: PlaybackEvent) => {
        if (!sameScope(scope, event.scope)) return;
        if (!contextInvalidated && ['started', 'amplitude', 'progress'].includes(event.type)) {
          try { validateContext(); } catch {
            contextInvalidated = true;
            playbackFailed = true;
            invalidationStop = this.ports.playback.stop(scope);
            void invalidationStop.catch(() => {});
          }
        }
        if (contextInvalidated && !['stopped', 'ended', 'error'].includes(event.type)) return;
        if (!this.controller.playback(event)) return;
        if (event.type === 'started') started = true;
        if (event.type === 'ended') ended = true;
        if (event.type === 'stopped') stopped = true;
        if (event.type === 'error') playbackError = event.message;
        this.emit({type: 'playback', playback: event}); this.presentation();
      }, signal);
      await invalidationStop;
      if (contextInvalidated) throw new Error('记忆内容已更新，这轮回应已停止。');
      if (playbackError) { playbackFailed = true; throw new Error(playbackError); }
      if (stopped || (!ended && signal.aborted)) throw new StaleTurnError();
      if (!started || !ended) throw new Error('Playback did not report actual start and normal completion');
      outcome = {status: 'played'};
      }
      }
      }
    } catch (error) {
      this.ports.emotion?.cancel(scope);
      const message = error instanceof Error ? error.message : String(error);
      const isCancelled = error instanceof StaleTurnError || (signal.aborted && !playbackFailed);
      if (isCancelled) outcome = {status: 'cancelled'};
      else {
        if (this.controller.accepts(scope)) {
          this.controller.playback({scope, at: new Date().toISOString(), type: 'error', message});
          this.emit({type: 'error', scope, message:userFacingError(error)}); this.presentation();
        }
        outcome = {status: 'failed', error: message};
      }

      // RV75-05: Record failed or cancelled stage in trace so the broken phase is visible
      const stageStatus = isCancelled ? 'cancelled' : 'failed';
      const errCode = error instanceof Error && 'code' in error ? String((error as any).code) : undefined;
      const errType = error instanceof Error ? error.name : 'UnknownError';
      if (!stages.some(s => s.name === 'llm')) {
        stages.push({
          name: 'llm',
          label: '大模型对话生成',
          elapsedMs: Math.max(1, Math.round(performance.now() - (llmStart > 0 ? llmStart : turnStart))),
          status: stageStatus,
          category: 'foreground',
          details: { error: errType, ...(errCode ? { code: errCode } : {}) },
        });
      } else if (this.ports.outputMode !== 'text' && !stages.some(s => s.name === 'tts')) {
        stages.push({
          name: 'tts',
          label: '语音合成',
          elapsedMs: Math.max(1, Math.round(performance.now() - turnStart)),
          status: stageStatus,
          category: 'foreground',
          details: { error: errType, ...(errCode ? { code: errCode } : {}) },
        });
      }
    } finally {
      if (this.ports.traceStore) {
        try {
          this.ports.traceStore.record({
            traceId: randomUUID(),
            turnId: scope.turnId,
            characterId: scope.characterId,
            sessionId: scope.sessionId,
            userText: text,
            replyText,
            totalElapsedMs: Math.max(1, Math.round(performance.now() - turnStart)),
            status: !outcome || outcome.status === 'failed' || outcome.status === 'cancelled' ? 'failed' : 'ok',
            stages,
            createdAt: new Date().toISOString(),
          }, this.ports.traceDebugOptIn ?? false);
        } catch { /* Trace logging must never fail a completed turn */ }
      }
    }
    try { await this.ports.mediaStore.releaseScope(scope); }
    catch (error) {
      const message = `Temporary media cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      this.emit({type: 'error', scope, message:userFacingError(message)});
      outcome = {status: 'failed', error: message};
    }
    return outcome ?? { status: 'failed' };
  }
}
