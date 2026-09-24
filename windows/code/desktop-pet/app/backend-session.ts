import { WorkSpeech, type WorkStatusNotice } from '../core/work-speech.js';
import type { DesktopWorkAction, DesktopWorkPort, WorkInputBinding } from '../contracts/desktop-work.js';
import { PRODUCT_CHARACTERS, type CompanionProfilePort } from '../contracts/character.js';
import { DESKTOP_BRIDGE_VERSION, type BackendToDesktop } from '../contracts/desktop-bridge.js';
import type { DesktopCommand, MemoryMaintenanceInput, MemoryPort, ProactiveInvitation, TurnScope } from '../contracts/index.js';
import type { DialoguePorts } from '../core/dialogue-pipeline.js';
import { DesktopRuntime } from '../core/desktop-runtime.js';
import type { UserBusyState } from '../core/proactive-companion.js';
import { RoleMaintenanceQueue } from '../core/maintenance-queue.js';
import { RoleMemoryLifecycleQueue } from '../core/memory-lifecycle-queue.js';
import type { BackgroundMemoryPort, MemoryPendingObservation, MemoryTurnPort, SummaryPort, ForegroundMemoryRequest } from '../contracts/memory-lifecycle.js';
import { join } from 'node:path';
import { DesktopDeviceBridge } from './desktop-device-bridge.js';

import { LiveVoiceTurn } from '../core/live-voice-turn.js';
import { userFacingError } from '../core/user-facing-error.js';
import type { SherpaStreamingAsr } from '../providers/sherpa-streaming-asr.js';

/**
 * FIX61-08: the local streaming model package. Any compatible sherpa-onnx streaming transducer works;
 * the four paths are configuration, so no model name is whitelisted. `PET_STREAMING_ASR_DIR` (or the
 * conventional .local/data directory) points at the package; without it the voice turn stays on the
 * batch path instead of failing the session.
 */
export function streamingAsrConfiguration(environment: NodeJS.ProcessEnv = process.env): {
  encoder: string; decoder: string; joiner: string; tokens: string } | undefined {
  const directory = environment.PET_STREAMING_ASR_DIR?.trim();
  if (!directory) return undefined;
  return { encoder: join(directory, 'encoder.onnx'), decoder: join(directory, 'decoder.onnx'),
    joiner: join(directory, 'joiner.onnx'), tokens: join(directory, 'tokens.txt') };
}

/**
 * A missing or unloadable local model must not take the whole session down: the voice turn then runs
 * on the batch path. Construction failures stay silent here — the batch transcript is real speech,
 * so the user loses only the partials, never their turn.
 */
function safeRecognizer(create?: () => SherpaStreamingAsr): SherpaStreamingAsr | undefined {
  if (!create) return undefined;
  try { return create(); }
  catch { return undefined; }
}

export interface PersistentMemoryPort extends MemoryPort { maintenanceInput(scope: TurnScope, text: string): MemoryMaintenanceInput }
export interface BackendPorts extends Omit<DialoguePorts, 'playback' | 'memory' | 'memoryLifecycle' | 'backgroundMemory'> {
  /**
   * FIX61-08: the local streaming recognizer factory. When absent (or when it cannot open) the voice
   * turn keeps the batch path and the pipeline transcribes the whole clip — never both.
   */
  createStreamingAsr?: () => import('../providers/sherpa-streaming-asr.js').SherpaStreamingAsr;
  memory: PersistentMemoryPort;
  createEmotion?: () => import('../contracts/emotion-state.js').EmotionTurnPort;
  companionProfile?: CompanionProfilePort;
  consumeWakeHit?: (hit: unknown) => string | undefined;
  lifecycleMemory?: PersistentMemoryPort & MemoryTurnPort & SummaryPort;
  backgroundMemory?: PersistentMemoryPort & BackgroundMemoryPort & SummaryPort;
  classifyMemoryRequest?: (scope: TurnScope, text: string, signal: AbortSignal) => ForegroundMemoryRequest | Promise<ForegroundMemoryRequest>;
  /** Trusted application policy only; desktop commands cannot opt themselves into this path. */
  isMemoryIndependent?: (scope: TurnScope, text: string, signal: AbortSignal, pending: MemoryPendingObservation) => boolean | Promise<boolean>;
  /** Called only after both History messages are saved. Consumers should resolve bodies by stable IDs. */
  onConversationSaved?: (scope: TurnScope) => void;
  /** Drain saved-conversation projections after the current foreground turn stops validating its issued Context. */
  onConversationIdle?: () => void;
  /** Consumes only a previously shown, still-valid persisted invitation. The returned command runs through the sole DesktopRuntime. */
  acceptInvitation?: (invitationId: string) => Extract<DesktopCommand, { type: 'submit_text' | 'start_voice' }> | null;
  /** Ignores only a previously shown, still-valid persisted invitation and records the source-linked audit. */
  ignoreInvitation?: (invitationId: string) => boolean;
  /** Runs arbitration only from fresh renderer presence or a completed foreground turn. */
  onProactiveOpportunity?: (busy: UserBusyState) => void;
}
export function parseWorkAction(value: unknown): DesktopWorkAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid work action');
  const a = value as Record<string, unknown>;
  const id = (v: unknown): string => { if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(v)) throw Error('Invalid work identity'); return v; };
  const version = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 1) throw Error('Invalid work version'); return Number(v); };
  if(a.type==='clear_unknown_reminders'){
    if(!Array.isArray(a.records)||a.records.length>10000)throw Error('Invalid reminder selection');
    return {type:'clear_unknown_reminders',records:a.records.map(record=>{if(!record||typeof record!=='object'||Array.isArray(record))throw Error('Invalid reminder');const r=record as Record<string,unknown>;return {id:id(r.id),expectedVersion:version(r.expectedVersion)};})};
  }
  if(a.type==='open_native')return {type:'open_native',id:id(a.id)};
  if(a.type==='reprepare'||a.type==='replan'){
    if(typeof a.text!=='string'||!a.text.trim()||a.text.length>20000||a.text.includes('\\0'))throw Error('Invalid work text');
    const base={draftId:id(a.draftId),expectedVersion:version(a.expectedVersion),text:a.text};
    if(a.type==='replan')return {type:'replan',...base};
    if(!['codex','harness'].includes(String(a.executor))||(a.projectId===undefined)!==(a.projectVersion===undefined))throw Error('Invalid work executor');
    const target=a.target as Record<string,unknown>|undefined;
    if(a.executor==='codex'&&(!target||target.hostId!=='local')||a.executor==='harness'&&target!==undefined)throw Error('Invalid work target');
    return {type:'reprepare',...base,executor:a.executor as 'codex'|'harness',
      ...(target?{target:{hostId:'local',threadId:id(target.threadId)}}:{}),
      ...(a.projectId===undefined?{}:{projectId:id(a.projectId),projectVersion:version(a.projectVersion)})};
  }
  if (a.type === 'confirm') return { type: 'confirm', id: id(a.id), expectedVersion: version(a.expectedVersion) };
  if (a.type === 'refresh' || a.type === 'focus') return { type: a.type, ...(a.id === undefined ? {} : { id: id(a.id) }) };
  if (a.type === 'dismiss') return { type: 'dismiss', ...(a.draftId === undefined ? {} : { draftId: id(a.draftId) }) };
  if (a.type === 'revise') {
    if (typeof a.text !== 'string' || !a.text.trim() || a.text.length > 20000 || a.text.includes('\0')) throw Error('Invalid work text');
    return { type: 'revise', draftId: id(a.draftId), expectedVersion: version(a.expectedVersion), text: a.text };
  }
  if (a.type === 'select') {
    const target = a.target as Record<string, unknown> | undefined;
    if (!target || target.hostId !== 'local' || (a.projectId === undefined) !== (a.projectVersion === undefined)) throw Error('Invalid work target');
    return { type: 'select', draftId: id(a.draftId), expectedVersion: version(a.expectedVersion), target: { hostId: 'local', threadId: id(target.threadId) },
      ...(a.projectId === undefined ? {} : { projectId: id(a.projectId), projectVersion: version(a.projectVersion) }) };
  }
  throw Error('Unknown work action');
}
function parseWorkBinding(value: unknown): WorkInputBinding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid work binding');
  const b = value as Record<string, unknown>;
  const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(v);
  const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
  if (!id(b.draftId) || !version(b.draftVersion) || (b.requestId === undefined) !== (b.requestVersion === undefined)
    || b.requestId !== undefined && (!id(b.requestId) || !version(b.requestVersion))) throw Error('Invalid work binding');
  return {draftId:b.draftId,draftVersion:b.draftVersion,...(b.requestId===undefined?{}:{requestId:b.requestId as string,requestVersion:b.requestVersion as number})};
}
export function parseDesktopCommand(value: unknown): DesktopCommand {
  if (!value || typeof value !== 'object') throw new Error('Invalid desktop command');
  const command = value as Record<string, unknown>;
  const binding = command.type === 'submit_text' || command.type === 'start_voice' ? parseWorkBinding(command.workBinding) : undefined;
  switch (command.type) {
    case 'submit_text': if (typeof command.text !== 'string' || !command.text.trim()) throw new Error('Text must not be empty'); if (command.clientRequestId !== undefined && (typeof command.clientRequestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.clientRequestId))) throw new Error('Invalid text request ID'); return { type: 'submit_text', text: command.text, ...(binding ? {workBinding:binding}:{}), ...(command.clientRequestId === undefined ? {} : { clientRequestId: command.clientRequestId as string }) };
    case 'acknowledge_introduction':
      if (typeof command.introductionId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(command.introductionId)) throw new Error('Invalid introduction ID');
      return { type: 'acknowledge_introduction', introductionId: command.introductionId };
    case 'start_voice': {
      if (command.clientRequestId !== undefined && (typeof command.clientRequestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.clientRequestId))) throw new Error('Invalid voice request ID');
      return { type: 'start_voice', ...(binding ? {workBinding:binding}:{}), ...(command.clientRequestId === undefined ? {} : { clientRequestId: command.clientRequestId as string }) };
    }
    case 'finish_voice': case 'cancel': return { type: command.type };
    case 'click_invitation': if (typeof command.invitationId !== 'string' || !command.invitationId) throw new Error('Missing invitation ID'); return { type: command.type, invitationId: command.invitationId };
    case 'ignore_invitation': if (typeof command.invitationId !== 'string' || !command.invitationId) throw new Error('Missing invitation ID'); return { type: command.type, invitationId: command.invitationId };
    default: throw new Error('Unsupported desktop command');
  }
}
/** Trusted Node-side session. The shell only sends commands and device responses. */
export class BackendSession {
  private readonly devices: DesktopDeviceBridge;
  /** The live turn that currently owns the frame sink; the device bridge routes accepted frames here. */
  private liveVoice: LiveVoiceTurn | undefined;
  private readonly maintenance: RoleMaintenanceQueue | RoleMemoryLifecycleQueue;
  private readonly runtime: DesktopRuntime;
  private work?: DesktopWorkPort;
  private readonly workSpeech: WorkSpeech;
  notifyWork(notice: WorkStatusNotice) { this.workSpeech.notify(notice); }
  attachWork(work: DesktopWorkPort) { this.work = work; this.runtime.attachWork(work); }
  /** Replays only a still-shown, unexpired invitation for this product session after backend restart. */
  presentInvitation(invitation: ProactiveInvitation): boolean {
    const expiresAt = Date.parse(invitation.expiresAt);
    if (invitation.characterId !== this.runtime.identity().characterId || invitation.status !== 'shown'
      || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
    this.send({ channel: 'event', event: { type: 'invitation', invitation } });
    return true;
  }
  withdrawInvitation(invitation: ProactiveInvitation): void {
    const { responseText: _responseText, ...safe } = invitation;
    this.send({ channel: 'event', event: { type: 'invitation', invitation: { ...safe, status: 'expired', text: '' } } });
  }
  private readonly profile: CompanionProfilePort | undefined;
  private readonly streamingAsr: SherpaStreamingAsr | undefined;
  private readonly consumeWakeHit: BackendPorts['consumeWakeHit'];
  private readonly acceptInvitation: BackendPorts['acceptInvitation'];
  private readonly ignoreInvitation: BackendPorts['ignoreInvitation'];
  private readonly onProactiveOpportunity: BackendPorts['onProactiveOpportunity'];
  private desktopPresence: UserBusyState = { isTyping: true };
  private desktopPresenceAt = 0;
  constructor(ports: BackendPorts, private readonly send: (message: BackendToDesktop) => void, private readonly closeStore: () => void, reportBackgroundFailure: (scope: TurnScope, kind: 'memory' | 'summary') => void = () => {}) {
    this.profile = ports.companionProfile;
    this.consumeWakeHit = ports.consumeWakeHit;
    this.acceptInvitation = ports.acceptInvitation;
    this.ignoreInvitation = ports.ignoreInvitation;
    this.onProactiveOpportunity = ports.onProactiveOpportunity;
    this.devices = new DesktopDeviceBridge(ports.mediaStore, send);
    if (ports.lifecycleMemory && ports.lifecycleMemory !== ports.memory) throw new Error('Lifecycle and dialogue must share the same memory port');
    if (ports.backgroundMemory && ports.backgroundMemory !== ports.memory) throw new Error('Background and dialogue must share the same memory port');
    if (ports.isMemoryIndependent && !ports.backgroundMemory) throw new Error('Independent scheduling requires the background memory capability');
    const lifecyclePort = ports.backgroundMemory ?? ports.lifecycleMemory;
    const lifecycle = lifecyclePort ? new RoleMemoryLifecycleQueue(lifecyclePort, (scope, _error, kind) => reportBackgroundFailure(scope, kind ?? 'summary'), ports.traceStore) : undefined;
    this.maintenance = lifecycle ?? new RoleMaintenanceQueue(ports.memory, (scope, text) => ports.memory.maintenanceInput(scope, text), scope => reportBackgroundFailure(scope, 'memory'));
    const { backgroundMemory: _background, isMemoryIndependent, classifyMemoryRequest, createEmotion, createStreamingAsr, ...runtimePorts } = ports;
    const emotion=createEmotion?.()??ports.emotion;
    // One recognizer process for the whole session; the live leg reuses it across authorized turns.
    this.streamingAsr = ports.outputMode === 'text' ? undefined : safeRecognizer(createStreamingAsr);
    const streamingAsr = this.streamingAsr;
    this.runtime = new DesktopRuntime({ ...runtimePorts, ...(emotion?{emotion}:{}), ...(lifecycle ? { memoryLifecycle: lifecycle } : {}),
      ...(ports.backgroundMemory && lifecycle ? { backgroundMemory: {
        isIndependent: async (scope: TurnScope, text: string, signal: AbortSignal) => {
          const pending = lifecycle.observePending(scope.characterId);
          const independent = await isMemoryIndependent?.(scope, text, signal, pending) === true;
          signal.throwIfAborted();
          try { pending.assertCurrent(); } catch { return false; }
          return independent;
        },
        ...(classifyMemoryRequest ? {classifyRequest:classifyMemoryRequest} : {}),
        beginPendingMutation:lifecycle.beginPendingMutation.bind(lifecycle),
        enqueueTurn: lifecycle.enqueueTurn.bind(lifecycle), foregroundContext: lifecycle.foregroundContext.bind(lifecycle),
        appendForegroundAssistant: lifecycle.appendForegroundAssistant.bind(lifecycle), assertContextCurrent: lifecycle.assertContextCurrent.bind(lifecycle),
      } } : {}), onInputRoute: (scope, route) => send({ channel: 'input_route', scope, route }), onForegroundIdle: () => {
        this.workSpeech.flush();
        try { ports.onConversationIdle?.(); } catch { /* A durable outbox remains for the next foreground idle or restart. */ }
        this.evaluateProactiveOpportunity();
      },
      ...(streamingAsr ? { liveVoice: { open: (voiceScope: TurnScope) => {
        const turn = new LiveVoiceTurn(voiceScope, { asr: streamingAsr,
          // Live partial text is display only; it is never written to Memory or the Timeline.
          onInterim: (target: TurnScope, text: string) => send({ channel: 'event', event: { type: 'transcript', scope: target, text, interim: true } }),
          onError: (target: TurnScope, error: unknown) => send({ channel: 'event', event: { type: 'error', scope: target, message: userFacingError(error) } }) });
        this.liveVoice = turn;
        // The renderer pushes frames through the bridge; binding this turn's sink here means the
        // bridge acknowledgement is exactly "the recognizer accepted this frame" (real backpressure).
        this.devices.openVoiceCapture(voiceScope.turnId, voiceScope, turn);
        return turn;
      } } } : {}), capture: ports.outputMode==='text'?{start:async()=>{throw Error('Text channel cannot capture');},finish:async()=>{throw Error('Text channel cannot capture');},stop:async()=>{}}:this.devices.capture, playback: ports.outputMode==='text'?{play:async()=>{throw Error('Text channel cannot play');},stop:async()=>{}}:this.devices.playback }, event => send({ channel: 'event', event }), (scope, userText, assistantText) => {
      try { ports.onConversationSaved?.(scope); } catch { /* Durable outbox recovery must not undo the already-saved conversation. */ }
      if (this.maintenance instanceof RoleMemoryLifecycleQueue) this.maintenance.afterConversationSaved(scope);
      else this.maintenance.enqueue(scope, userText);
    });
    this.workSpeech = new WorkSpeech({ identity: () => this.runtime.identity(), busy: () => this.runtime.isBusy(), tts: ports.tts, playback: this.devices.playback, media: ports.mediaStore, emit: event => send({channel:'work_speech',event}) });
    const introduction = this.profile?.introduction();
    send({ channel: 'backend_ready', bridgeVersion: DESKTOP_BRIDGE_VERSION, ...this.runtime.identity(), ...(introduction ? { introduction } : {}) });
  }
  /** Stale/missing renderer state is treated as busy so an invitation can never interrupt an unknown UI state. */
  private currentBusyState(): UserBusyState {
    const fresh = Date.now() - this.desktopPresenceAt <= 3_000;
    return fresh
      ? { ...this.desktopPresence, isTurnActive: this.desktopPresence.isTurnActive === true || this.runtime.isBusy() }
      : { isTyping: true, isTurnActive: true };
  }
  private evaluateProactiveOpportunity(): void {
    try { this.onProactiveOpportunity?.(this.currentBusyState()); } catch { /* A pending durable candidate is retried by the next presence update. */ }
  }
  requestProactiveEvaluation(): void { this.evaluateProactiveOpportunity(); }
  async receiveLine(line: string): Promise<void> {
    try {
      const raw: unknown = JSON.parse(line);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid desktop message');
      const message = raw as Record<string, unknown>;
      if (message.channel === 'presence') {
        const values = [message.isTyping, message.isSpeaking, message.isTurnActive, message.isWorkPendingConfirmation];
        if (values.some(value => typeof value !== 'boolean')) throw new Error('Invalid desktop presence');
        this.desktopPresence = { isTyping: message.isTyping as boolean, isSpeaking: message.isSpeaking as boolean,
          isTurnActive: message.isTurnActive as boolean, isWorkPendingConfirmation: message.isWorkPendingConfirmation as boolean };
        this.desktopPresenceAt = Date.now();
        this.evaluateProactiveOpportunity();
        return;
      }
      if (message.channel === 'command') {
        let command = parseDesktopCommand(message.command);
        if(command.type==='start_voice'){
          const hit=(message.command as Record<string,unknown>).wakeHit;
          if(hit!==undefined){
            const keyword=this.consumeWakeHit?.(hit);
            if(!keyword)throw Error('Expired local wake hit');
            command={...command,wakeKeyword:keyword};
          }
        }
        if (['cancel','submit_text','start_voice','click_invitation','ignore_invitation'].includes(command.type)) this.workSpeech.onInput();
        if (command.type === 'acknowledge_introduction') {
          if (!this.profile) throw new Error('Companion profile unavailable');
          this.profile.acknowledgeIntroduction(command.introductionId);
        } else if (command.type === 'click_invitation') {
          const accepted = this.acceptInvitation?.(command.invitationId);
          if (!accepted) throw new Error('Invitation is no longer available');
          // Acceptance is an explicit user gesture. Text invitations enter the ordinary text turn;
          // voice invitations enter the ordinary microphone authorization path.
          await this.runtime.dispatch(accepted);
        } else if (command.type === 'ignore_invitation') {
          if (!this.ignoreInvitation?.(command.invitationId)) throw new Error('Invitation is no longer available');
        } else await this.runtime.dispatch(command);
      }
      else if (message.channel === 'work_action') { if (!this.work) throw Error('Work routing unavailable'); await this.work.action(parseWorkAction(message.action)); }
      else this.devices.receive(raw);
    } catch {
      // Never echo untrusted command bodies, transient media or provider errors to logs/UI.
      this.send({ channel: 'event', event: { type: 'error', scope: null, message: '这次操作没有完成，可以停止后重试。' } });
    }
  }
  async drainForeground(): Promise<void> { await this.runtime.drain(); }
  async drain(): Promise<void> { await this.runtime.drain(); await this.workSpeech.drain(); await this.maintenance.drain(); }
  retryPendingMemory(scope:TurnScope,id:string,text:string) {
    if(!(this.maintenance instanceof RoleMemoryLifecycleQueue))throw new Error('Background memory is unavailable');
    return this.maintenance.enqueueTurn(scope,id,text);
  }
  pendingMemoryJobs() {
    const queue = this.maintenance;
    return queue instanceof RoleMemoryLifecycleQueue
      ? PRODUCT_CHARACTERS.map(({ id }) => queue.observePending(id).snapshot) : [];
  }
  async close(): Promise<void> {
    // EOF means no more device acknowledgements are possible. Reject waits before cleanup.
    this.devices.close();
    await this.streamingAsr?.close().catch(() => {});
    await this.workSpeech.close();
    try { await this.runtime.close(); } catch { /* Device teardown belongs to the closing native shell. */ }
    await this.work?.close();
    await this.maintenance.close(); await this.runtime.drain(); this.closeStore();
  }
}
