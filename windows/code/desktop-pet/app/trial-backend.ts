import { EmotionTurns } from '../core/emotion-state.js';
import { homedir } from 'node:os';
import { SqliteMemoryImportManagement } from '../memory/import-management.js';
import { HistoricalMemoryTransport, historicalMemoryInputBytes, memoryImportConfiguration, observedImportEndpoint } from './memory-import.js';
import { WakeManager } from './wake-manager.js';
import { wechatTranscriber } from '../wechat/asr.js';
import { wechatAudioFileSender } from '../wechat/output.js';
import { WeChatService } from '../wechat/service.js';
import { WeChatApi } from '../wechat/api.js';
import { WeChatStore } from '../wechat/store.js';
import { WeChatTextConversation } from '../wechat/conversation.js';
import { WorkPlanner } from '../providers/work-plan.js';
import { DesktopWork } from '../harness/desktop-work.js';
import { WorkIntentClassifier } from '../providers/work-intent.js';
import { QwenAsrProvider } from '../providers/qwen-asr.js';
import { QwenVisualEmotionProvider, VISUAL_EMOTION_PROMPT } from '../providers/qwen-visual-emotion.js';
import { SplitPerceptionProvider } from '../providers/split-perception.js';
import { SherpaStreamingAsr } from '../providers/sherpa-streaming-asr.js';
import { streamingAsrConfiguration } from './backend-session.js';
import { StrictManagementForget, withStrictManagementForget } from './management-forget.js';
import { assertCompanionDataConfiguration } from './companion-data.js';
import { isOutside, isPrivateFileSync } from '../core/platform-files.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, open, unlink, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {pendingMemoryManagement} from '../management/pending-memory.js';
import { fileURLToPath } from 'node:url';
import type { MemoryTurnInput, MemoryTurnPlan, MemoryTurnProvider, MemoryTurnOutcome } from '../contracts/memory-lifecycle.js';
import type { TurnScope, TtsProvider, MediaStorePort } from '../contracts/index.js';
import type { ProviderSelection } from '../contracts/management.js';
import { confirmedInvitationPolicy } from '../companion/invitations.js';
import { ProactiveInvitationRuntime } from '../companion/proactive-invitation-runtime.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../memory/sqlite-lifecycle-port.js';
import { SqliteManagementMemoryPort } from '../memory/management-port.js';
import { ManagementSettingsStore } from '../management/settings-store.js';
import { effectiveTrialConfiguration } from '../management/settings.js';
import { ManagementRuntime } from '../management/runtime.js';
import { PresentationSettingsStore, readPresentationCatalog } from '../management/presentation.js';
import { startRuntimeManagement } from '../management/bootstrap.js';
import { ProductionPlaygroundPort } from '../management/playground-port.js';
import type { MemoryRecord } from '../memory/ledger.js';
import { abortable } from '../media/scope.js';
import { MemoryMediaStore } from '../media/store.js';
import { JsonDialogueProvider } from '../providers/qwen-dialogue.js';
import { JsonSummaryProvider } from '../providers/qwen-memory-lifecycle.js';
import { QwenPerceptionProvider } from '../providers/qwen-perception.js';
import { QwenTtsProvider, billedCharacters } from '../providers/qwen-tts.js';
import { QwenAudioTtsProvider, isQwenAudioTtsModel } from '../providers/qwen-audio-tts.js';
import { MiniMaxTtsProvider, MINIMAX_TTS_MODEL, MINIMAX_TTS_ENDPOINT } from '../providers/minimax-tts.js';
import { RegisteredVoiceStore } from '../providers/registered-voices.js';
import { ProviderTransport, type EndpointConfig, type JsonRecord, type ProviderOperation } from '../providers/transport.js';
import { BackendSession, type BackendPorts } from './backend-session.js';
import { TrialAuthorizer } from './trial-authorizer.js';
import { readActiveTrialConfiguration, type TrialConfiguration, type TrialOperation } from './trial-config.js';
import { verifyTrialRuntime } from './trial-launcher.js';
import { contextInputUpperBound, summaryInputUpperBound } from './input-budgets.js';
import { inspectPcmWav } from '../media/wav.js';
import { prototypeSnapshot } from './memory-planning-prototype.js';
import { runMemorySemanticAttempt, type SemanticAttemptEvent } from './memory-semantic-adapter.js';
import { buildMemorySemanticFormat } from './memory-semantic-format.js';
import { TrialAdmission } from './trial-admission.js';
import { AikaProfileStore, applyAikaProfile } from '../management/aika-profile.js';
import { AikaTimelineStore } from '../management/aika-timeline.js';
import { KnowledgeLibraryStore } from '../memory/knowledge-library.js';
import { knowledgeManagement } from '../management/knowledge-routes.js';
import { MicrophonePreferenceStore } from '../media/microphone-preference.js';
import { SkinStore } from '../management/skin-store.js';
import { CharacterPackStore } from '../memory/character-pack-store.js';
import { ContinuityMemoryStore } from '../memory/continuity-memory-store.js';
import { ConversationCandidateWriter } from '../memory/conversation-candidate-writer.js';
import { readTraceContentFromHistory } from '../memory/trace-history-content.js';
import { ProductionContinuityContext, productionPairingResolver } from '../memory/continuity-production.js';
import { productionPairing, type PairingScope } from '../contracts/character-pack.js';
import { continuityManagement } from '../management/continuity-routes.js';
import { proactiveInvitationManagement } from '../management/proactive-invitation-routes.js';
import { RuntimeTraceStore } from '../core/trace-store.js';
import { LegacyProviderRuntimeAdapter } from '../plugins/legacy-provider-adapter.js';
import { Next65Management } from '../management/next65-management.js';
import { FlowAwareDialogueProvider } from '../providers/flow-aware-dialogue.js';
import { CompanionEventHub } from '../core/companion-event-hub.js';
import { UnifiedTimelineService } from '../memory/unified-timeline.js';
import { WorkProtocolRuntime } from '../management/work-protocol-runtime.js';
import { CaptureGrantManager } from '../core/perception-grant.js';
import { ScreenPerceptionService } from '../core/screen-perception.js';
import { ObservationContextAdapter, ObservationTurnInbox, ObservationAwareDialogueProvider } from '../core/observation-context.js';
import { PerceptionManagementRuntime } from '../management/perception-runtime.js';
import { CollectionStore } from '../memory/collection-store.js';
import { CollectionGrantManager } from '../core/collection-grants.js';
import { CollectionService } from '../core/collection-service.js';
import { CollectionManagement } from '../management/collection-management.js';
import { CollectionHelperClient, collectionHelperPaths, resolveHelperPackageRoot, loadCollectionHelperManifest, sweepStaleStaging } from '../core/collection-helper-client.js';
import { ScreenshotDirectorySource } from '../core/screenshot-directory-source.js';
import { ClipboardImageSource } from '../core/clipboard-image-source.js';
import { loadCollectionPolicy } from '../contracts/collection.js';
import { createLocalOcrEngine } from '../core/local-ocr-engine.js';
import { CompanionModeRuntime } from '../core/companion-mode-runtime.js';
import { CollectionBatchRunner } from '../core/collection-batch-runner.js';
import { ObservationScheduler } from '../core/observation-scheduler.js';
import { ScreenCaptureSource } from '../core/screen-capture-source.js';
import { DocumentParser } from '../core/document-parser.js';
import { qwenCloudScreenObservation, SCREEN_OBSERVATION_PROMPT } from '../providers/qwen-screen-observation.js';
// Health is derived from the runtime's own observations, so no extra probe is started here.

/**
 * N081-06: decode PNG/JPEG/WebP intrinsic dimensions from the header only.
 *
 * Used as the collection store's pixel probe. It reads no pixels, performs no decoding work beyond
 * the header, and returns null for anything it cannot confidently interpret — so a malformed image
 * is refused rather than stored with a guessed size.
 */
export function probeImageDimensions(bytes: Uint8Array, mimeType?: string): { readonly width: number; readonly height: number } | null {
  const detected = mimeType ?? (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
    : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
    : bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 ? 'image/webp'
    : bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d ? 'image/bmp' : '');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (detected === 'image/bmp') {
    // BMP carries signed 32-bit width/height at offsets 18 and 22; a negative height means the rows
    // are stored top-down, which is still a valid image of that absolute size.
    if (bytes.length < 26) return null;
    const width = view.getInt32(18, true);
    const height = Math.abs(view.getInt32(22, true));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (detected === 'image/png') {
    if (bytes.length < 24) return null;
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (detected === 'image/webp') {
    if (bytes.length < 30) return null;
    // Only the lossy (`VP8 `) variant carries plain 14-bit dimensions at a fixed offset.
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
      const width = view.getUint16(26, true) & 0x3fff;
      const height = view.getUint16(28, true) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    return null;
  }
  if (detected === 'image/jpeg') {
    // Walk the segment chain to the SOF marker, which carries the real frame dimensions.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = view.getUint16(offset + 2);
      if (length < 2) return null;
      const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame) {
        const height = view.getUint16(offset + 5);
        const width = view.getUint16(offset + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      offset += 2 + length;
    }
    return null;
  }
  return null;
}

/** Keep production trial calls within the reviewed text bounds without truncating user content or replies. */
export class TrialTransport extends ProviderTransport {  constructor(private readonly configuration: TrialConfiguration, private readonly providerFetch: typeof fetch = fetch,
    private readonly runtime?: ManagementRuntime, private readonly dialogueTemperature?: number) { super(providerFetch); }
  override async request(config: EndpointConfig, scope: TurnScope, operation: ProviderOperation, body: JsonRecord,
    signal: AbortSignal, textCharacters?: number, audioSeconds?: number): Promise<JsonRecord> {
    const model = this.configuration.models[operation as TrialOperation];
    if (!model || operation === 'memory_maintenance') throw new Error('Unregistered trial operation');
    if (operation !== 'tts' && operation !== 'perception' && operation !== 'asr') {
      const upper = Buffer.byteLength(JSON.stringify(body.messages), 'utf8') + 2048;
      if (upper > model.inputTokenLimit) throw new Error('Trial request exceeds its reviewed input bound');
    }
    if (operation === 'perception' && this.configuration.models.asr) {
      const messages = body.messages as {role?:string;content?:Record<string,unknown>[]}[] | undefined;
      const content=messages?.[0]?.content;
      if(messages?.length!==1 || messages[0]?.role!=='user' || !Array.isArray(content) || content.length<2 || content.length>4
        || ![{type:'text',text:VISUAL_EMOTION_PROMPT},{type:'text',text:SCREEN_OBSERVATION_PROMPT}].some(prompt=>JSON.stringify(content.at(-1))===JSON.stringify(prompt))
        || content.slice(0,-1).some(part=>part.type!=='image_url' || Object.keys(part).some(k=>!['type','image_url'].includes(k))
          || !/^data:image\/(jpeg|png);base64,/.test(String((part.image_url as {url?:string})?.url)))
        || JSON.stringify(body.modalities)!=='["text"]' || body.stream!==true
        || Object.keys(body).some(k=>!['messages','stream','stream_options','modalities'].includes(k)))
        throw new Error('Visual request must contain only current images and the fixed visual prompt');
    }
    if (operation === 'asr') {
      const messages=body.messages as {role?:string;content?:{type?:string;input_audio?:{data?:string}}[]}[]|undefined;
      const content=messages?.[0]?.content,data=content?.[0]?.input_audio?.data;
      if (messages?.length!==1 || messages[0]?.role!=='user' || content?.length!==1 || content[0]?.type!=='input_audio' || typeof data!=='string' || !data.startsWith('data:audio/wav;base64,')) throw new Error('ASR audio request is invalid');
      const bytes=Buffer.from(data.slice('data:audio/wav;base64,'.length),'base64');
      try { const actualSeconds=inspectPcmWav(bytes).durationMs/1000; if(typeof audioSeconds!=='number'||!Number.isFinite(audioSeconds)||Math.abs(actualSeconds-audioSeconds)>0.000001)throw new Error('ASR audio duration mismatch'); } finally {bytes.fill(0);}
    }
    if (operation === 'tts') {
      const input = body.input as Record<string, unknown> | undefined;
      if (!input || typeof input.text !== 'string' || (this.configuration.purpose !== 'user-trial' && [...input.text].length > 600)) throw new Error('Trial speech request exceeds its reviewed bounds');
      if (model.model === MINIMAX_TTS_MODEL || model.model === 'MiniMax/speech-2.8-hd') {
        const voice = input.voice_setting as Record<string, unknown> | undefined;
        const audio = input.audio_setting as Record<string, unknown> | undefined;
        if (config.endpoint !== MINIMAX_TTS_ENDPOINT || Buffer.byteLength(input.text, 'utf8') !== textCharacters
          || !voice || typeof voice.voice_id !== 'string' || !voice.voice_id || voice.speed !== 1 || voice.vol !== 1 || voice.pitch !== 0
          || !audio || audio.sample_rate !== 24000 || audio.format !== 'wav' || audio.channel !== 1
          || input.output_format !== 'hex' || input.language_boost !== 'Chinese'
          || Object.keys(input).some(key => !['text', 'voice_setting', 'audio_setting', 'output_format', 'language_boost'].includes(key))
          || Object.keys(voice).some(key => !['voice_id', 'speed', 'vol', 'pitch'].includes(key))
          || Object.keys(audio).some(key => !['sample_rate', 'format', 'channel'].includes(key)))
          throw new Error('Trial MiniMax speech request exceeds its reviewed bounds');
      } else {
        const instruction = input[isQwenAudioTtsModel(model.model) ? 'instruction' : 'instructions'];
        if (billedCharacters(input.text) !== textCharacters || typeof instruction !== 'string'
          || Buffer.byteLength(instruction, 'utf8') > 1600) throw new Error('Trial speech request exceeds its reviewed bounds');
      }
    }
    const timeout = AbortSignal.timeout(this.configuration.memory.timeoutMs);
    const boundedSignal = AbortSignal.any([signal, timeout]);
    if (config.model !== model.model || config.endpoint !== model.endpoint) throw new Error('Trial transport provider mismatch');
    const boundedBody = model.provider === 'deepseek' && operation !== 'memory_turn' ? { ...body, max_tokens: operation === 'admission' && Number.isSafeInteger(body.max_tokens) && Number(body.max_tokens) > 0 && Number(body.max_tokens) <= 4096 ? Math.min(Number(body.max_tokens), model.outputTokenLimit) : model.outputTokenLimit } : body;
    const requestBody = operation === 'dialogue' && this.dialogueTemperature !== undefined ? { ...boundedBody, temperature: this.dialogueTemperature } : boundedBody;
    const call = (sent: () => void = () => {}) => new ProviderTransport((...args) => {
      sent(); return this.providerFetch(...args);
    }).request(config, scope, operation, requestBody, boundedSignal, textCharacters, audioSeconds);
    return this.runtime ? this.runtime.observeCall(operation as TrialOperation, scope.characterId, call, boundedSignal) : call();
  }
}

export function createTrialTtsProvider(selection: ProviderSelection, endpoint: EndpointConfig,
  store: MediaStorePort, transport: ProviderTransport, voices?: RegisteredVoiceStore): TtsProvider {
  if (selection.adapterId === 'minimax-tts') {
    if (!voices || !selection.voice || endpoint.model !== selection.model || endpoint.endpoint !== selection.endpoint) throw new Error('Registered MiniMax voice required');
    const registeredVoice = voices.resolve({ voiceId: selection.voice, provider: 'dashscope', targetModel: selection.model,
      endpoint: selection.endpoint, credentialRef: selection.credentialRef });
    return new MiniMaxTtsProvider({ ...endpoint, voice: selection.voice, credentialRef: selection.credentialRef, registeredVoice }, store, transport);
  }
  if (selection.adapterId === 'qwen-audio-tts') {
    const registeredVoice = voices?.snapshot().voices.some(voice => voice.voiceId === selection.voice)
      ? voices.resolve({ voiceId: selection.voice!, provider: 'dashscope', targetModel: selection.model,
        endpoint: selection.endpoint, credentialRef: selection.credentialRef }) : undefined;
    return new QwenAudioTtsProvider({ ...endpoint, voice: selection.voice!, credentialRef: selection.credentialRef,
      ...(registeredVoice ? { registeredVoice, languageHints: ['zh'] as const } : {}) }, store, transport);
  }
  if (selection.adapterId === 'qwen-tts-instruct') return new QwenTtsProvider({ ...endpoint, voice: selection.voice!, language: selection.language! }, store, transport);
  throw new Error('Unregistered speech adapter');
}

/** Real semantic adapter and compiler; the SQLite port still owns tickets, source expansion and atomic commit. */
export class StrictTrialMemoryProvider implements MemoryTurnProvider {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly store: SqliteMemoryStore, private readonly config: EndpointConfig,
    private readonly transport: ProviderTransport, private readonly runId: string,
    private readonly evidence: (event: SemanticAttemptEvent) => Promise<void>, private readonly thinking?: 'high',
    private readonly provenanceKind: 'real_provider' | 'controlled_stub' = 'real_provider') {}
  plan(input: MemoryTurnInput, signal: AbortSignal): Promise<MemoryTurnPlan> {
    return this.planWithMode(input,signal);
  }
  /** Called only with the storage-issued virtual management ticket. */
  planManagement(input:MemoryTurnInput,signal:AbortSignal,managementTarget:import('../contracts/memory-lifecycle.js').SourceVersion):Promise<MemoryTurnPlan>{
    return this.planWithMode(input,signal,managementTarget);
  }
  private planWithMode(input:MemoryTurnInput,signal:AbortSignal,managementTarget?:import('../contracts/memory-lifecycle.js').SourceVersion):Promise<MemoryTurnPlan>{
    const captured = structuredClone(input);
    managementTarget=managementTarget?structuredClone(managementTarget):undefined;
    const work = this.pending.then(async () => {
      signal.throwIfAborted();
      // Include inactive parents as metadata so unread/deleted support is never silently invented.
      const records = new Map<string, MemoryRecord>();
      const visit = (record: MemoryRecord) => {
        if (records.has(record.id)) return;
        records.set(record.id, record);
        for (const ref of record.sources) { const parent = this.store.inspect(captured.scope, ref.id); if (parent) visit(parent); }
      };
      for (const kind of ['transcript', 'summary', 'memory', 'keyword_index', 'vector_index', 'context_cache', 'emotion'] as const)
        for (const record of this.store.visible(captured.scope, kind)) visit(record);
      let snapshot=prototypeSnapshot(captured,[...records.values()]);
      if(managementTarget){
        const current=captured.sources.find(s=>s.id===captured.currentMessageId);
        if(!current||current.kind!=='transcript'||current.messageRole!=='user'||current.origin!=='manual'||records.has(current.id))throw Error('Invalid virtual management request');
        snapshot={...snapshot,graph:[...snapshot.graph,{id:current.id,version:current.version,characterId:captured.scope.characterId,kind:'transcript',state:'active',eligible:true,parents:[]}]};
      }
      const result = await runMemorySemanticAttempt({ snapshot,
        config: this.config, transport: this.transport, provenance: { kind: this.provenanceKind, runId: this.runId, attemptId: randomUUID() },
        signal, evidence: this.evidence, dynamics:true, ...(managementTarget?{managementTarget}:{}), ...(this.thinking ? { reasoningEffort: this.thinking } : {}) });
      if (result.compiled.status === 'ready') return result.compiled.plan;
      if (result.compiled.status === 'needs_sources' && result.compiled.readProbe) return result.compiled.readProbe;
      throw new Error('Strict memory semantics are incomplete; no update was committed');
    });
    // Across both characters only one strict model request can reserve the large peak budget.
    this.pending = work.then(() => {}, () => {});
    return abortable(work, signal);
  }
}

export function keyReader(filename: string, configuration: TrialConfiguration, configFile: string, activationFile: string): () => string {
  return () => {
    // The generic transport requests its key before its async budget permit. Recheck metadata here first.
    const raw = readFileSync(configFile, 'utf8'), activation = JSON.parse(readFileSync(activationFile, 'utf8'));
    if (activation?.version !== 1 || activation.status !== 'active' || activation.phaseId !== configuration.phaseId
      || activation.configSha256 !== createHash('sha256').update(raw).digest('hex')
      || JSON.stringify(JSON.parse(raw)) !== JSON.stringify(configuration)) throw new Error('Trial is not active');
    const actual = realpathSync(filename), local = relative(realpathSync(configuration.projectRoot), actual), info = statSync(actual);
    if (!isAbsolute(filename) || !isOutside(realpathSync(configuration.projectRoot), actual) || !isPrivateFileSync(actual, info)) throw new Error('Restricted external trial credential file required');
    const key = readFileSync(actual, 'utf8').trim();
    if (!/^sk-[A-Za-z0-9_-]+$/.test(key)) throw new Error('Trial credential must contain exactly one key');
    return key;
  };
}

export async function startTrialBackend(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configFile = environment.PET_TRIAL_CONFIG, activationFile = environment.PET_TRIAL_ACTIVATION;
  if (!configFile || !activationFile || !isAbsolute(configFile) || !isAbsolute(activationFile)) throw new Error('Explicit trial configuration required');
  // FIX61-03: typed backend_startup progress ahead of backend_ready, so the shell renews its stall
  // window on real work instead of blind waiting. Only counters and the frozen phase names go on
  // stdout — never paths, credential material or diagnostics. The phase set mirrors the shell's
  // STARTUP_PHASES (desktop/electron/transport.mjs); this plain-protocol backend cannot import it.
  const STARTUP_PHASES = ['starting', 'verifying', 'initializing', 'ready'] as const;
  type StartupPhase = (typeof STARTUP_PHASES)[number];
  let startupSequence = 0;
  const emitStartup = (phase: StartupPhase, completed: number, total = 4) => {
    if (!STARTUP_PHASES.includes(phase)) throw new Error('Unknown startup phase');
    process.stdout.write(JSON.stringify({ channel: 'backend_startup', sequence: ++startupSequence,
      phase, completed, total, elapsedMs: Math.round(process.uptime() * 1000) }) + '\n');
  };
  const registeredConfiguration = await readActiveTrialConfiguration(configFile, activationFile);
  emitStartup('verifying', 1);
  if (registeredConfiguration.purpose === 'user-trial') assertCompanionDataConfiguration(registeredConfiguration);
  await verifyTrialRuntime(registeredConfiguration);
  emitStartup('initializing', 2);
  const voices = await RegisteredVoiceStore.open(resolve(registeredConfiguration.projectRoot, '.local/data/registered-voices.json'));
  const settings = await ManagementSettingsStore.open(resolve(dirname(configFile), 'management-settings.json'), registeredConfiguration, voices);
  const configuration = effectiveTrialConfiguration(registeredConfiguration, settings.effective);
  const evidenceRoot = resolve(configuration.projectRoot, '.local/model-evaluation/trial');
  await mkdir(evidenceRoot, { recursive: true });
  const runtime = new ManagementRuntime(configuration.sourceRevision, async diagnostic => {
    await appendFile(resolve(evidenceRoot, 'voice-failures.jsonl'), JSON.stringify({sourceRevision:configuration.sourceRevision,
      instanceId:runtime.instanceId, ...diagnostic}) + '\n', {mode:0o600});
  });
  const lockPath = resolve(evidenceRoot, '../backend.lock');
  let lock: import('node:fs/promises').FileHandle;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (lockError) {
    if ((lockError as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        const rawLock = await readFile(lockPath, 'utf8');
        const parsed = JSON.parse(rawLock);
        if (typeof parsed?.pid === 'number') {
          try {
            process.kill(parsed.pid, 0);
            throw Error('Another backend instance is currently running.');
          } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code === 'ESRCH') {
              await unlink(lockPath).catch(() => {});
              lock = await open(lockPath, 'wx', 0o600);
            } else throw killError;
          }
        } else {
          await unlink(lockPath).catch(() => {});
          lock = await open(lockPath, 'wx', 0o600);
        }
      } catch (checkError) {
        throw lockError;
      }
    } else throw lockError;
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, phaseId: configuration.phaseId, sourceRevision: configuration.sourceRevision, startedAt: new Date().toISOString() }) + '\n');
  let store: SqliteMemoryStore | undefined, session: BackendSession | undefined;
  let wechat: WeChatService | undefined;
  let wake: WakeManager | undefined;
  let managementForget: StrictManagementForget | undefined;
  let memoryImport: SqliteMemoryImportManagement | undefined;
  let desktopWork: import('../contracts/desktop-work.js').DesktopWorkPort | undefined;
  let management: Awaited<ReturnType<typeof startRuntimeManagement>> | undefined;
  let perceptionManagement: PerceptionManagementRuntime | undefined;
  // N081-06: declared here so the outer failure path can also stop collection listeners.
  let collectionService: CollectionService | undefined;
  let protocolWork: WorkProtocolRuntime | undefined;
  let liveHost: import('../plugins/host-runtime.js').PackageHost | undefined;
  let next65Runtime: Next65Management | undefined;
  const release = async () => { await lock.close(); await unlink(lockPath); };
  try {
    const authorizer = new TrialAuthorizer(configuration, configFile, activationFile, registeredConfiguration);
    const transport = new TrialTransport(configuration, fetch, runtime, settings.effective.providers.dialogue.temperature);
    // N075-01/R7: adapt the legacy TrialConfiguration onto the frozen ProviderRuntime.
    // Callers requesting endpoint(operation) resolve through ProviderRuntime.resolveBinding.
    const legacyProviderAdapter = new LegacyProviderRuntimeAdapter(
      configuration,
      authorizer,
      ref => keyReader(ref ?? '', registeredConfiguration, configFile, activationFile),
    );
    const endpoint = (operation: TrialOperation): EndpointConfig => legacyProviderAdapter.getEndpointConfig(operation);
    store = new SqliteMemoryStore({ filename: configuration.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
    const diagnostic = async (value: object) => appendFile(resolve(evidenceRoot, 'events.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 });
    const evidence = async (event: SemanticAttemptEvent) => {
      if (event.type === 'failure' && configuration.purpose === 'smoke-text') await authorizer.stop('semantic_failure');
      const data = event.data as Record<string, unknown>;
      // Persist trace identity and statuses only; avoid duplicating personal conversation bodies in diagnostics.
      await diagnostic({ type: event.type, provenance: event.provenance, scope: event.scope, elapsedMs: event.elapsedMs,
        digest: createHash('sha256').update(JSON.stringify(event.data)).digest('hex'),
        ...(event.type === 'failure' ? { stage: data.stage, name: data.name, ...(data.transport ? {transport:data.transport} : {}) } : {}),
        ...(event.type === 'compiled' ? { status: (data.compiled as { status: string }).status } : {}) });
      if (configuration.purpose === 'smoke-text' && event.type === 'declaration')
        await diagnostic({ type: 'smoke_memory_declaration', provenance: event.provenance, scope: event.scope, declaration: data.declaration });
      if (configuration.purpose === 'smoke-text' && event.type === 'response') {
        const raw = data.raw as Record<string, unknown>, usage = raw.usage as Record<string, unknown> | undefined;
        await diagnostic({ type: 'smoke_memory_final', provenance: event.provenance, scope: event.scope,
          finalContent: data.content, usage: { prompt_tokens: usage?.prompt_tokens ?? null, completion_tokens: usage?.completion_tokens ?? null,
            total_tokens: usage?.total_tokens ?? null } });
      }
    };
    class ObservedTrialMemory extends SqliteLifecycleMemoryPort {
      private async report(outcome: MemoryTurnOutcome, currentMessageId: string, text: string, signal: AbortSignal) {
        if (outcome.status === 'rejected' && configuration.purpose === 'smoke-text') await authorizer.stop('memory_commit_rejected');
        if (configuration.purpose === 'smoke-text' && outcome.status === 'applied') {
          const context = await this.context(outcome.scope, text, null, signal);
          this.assertContextCurrent(context);
          await diagnostic({ type: 'smoke_postcommit_context', scope: outcome.scope, context,
            purpose: 'Actual post-commit context assembly; not the earlier foreground reply input' });
        }
        await diagnostic({ type: 'memory_outcome', scope: outcome.scope, currentMessageId, outcome });
        return outcome;
      }
      override async prepareTurn(scope: TurnScope, id: string, text: string, signal: AbortSignal) {
        return this.report(await super.prepareTurn(scope, id, text, signal), id, text, signal);
      }
      override async prepareBackgroundTurn(scope: TurnScope, id: string, text: string, signal: AbortSignal) {
        return this.report(await super.prepareBackgroundTurn(scope, id, text, signal), id, text, signal);
      }
    }
    const strictProvider=new StrictTrialMemoryProvider(store, endpoint('memory_turn'), transport, configuration.phaseId, evidence, configuration.models.memory_turn.thinking);
    // FIX61-06: the knowledge library lives in the SAME companion database and reaches the turn only
    // through the context assembly, so switching a library is visible to the next turn immediately.
    const knowledgeStore = await KnowledgeLibraryStore.open(store, resolve(configuration.projectRoot, '.local/data/knowledge'));
    const knowledge = knowledgeManagement(knowledgeStore);
    // N07: continuity tables live beside History/Knowledge in the same companion database. N075-01/R1:
    // both stores are retained as formal runtime dependencies — the pack store feeds the dialogue
    // context composer below, the continuity store feeds both the composer and the management API.
    // Neither instance is dropped after open; they are composition-root dependencies, not side effects.
    const characterPacks = await CharacterPackStore.open(store);
    const continuityStore = await ContinuityMemoryStore.open(store);
    const candidatePairing = productionPairing('companion', configuration.purpose === 'user-trial' ? 'companion-default' : 'smoke-default');
    const captureGrantManager = new CaptureGrantManager();
    let cloudObservationEngine: ReturnType<typeof qwenCloudScreenObservation> | undefined;
    try {
      if (configuration.purpose === 'user-trial' && settings.effective.providers.perception?.credentialRef) {
        cloudObservationEngine = qwenCloudScreenObservation(transport, endpoint('perception'));
      }
    } catch { /* The authenticated route remains unavailable without a registered provider binding. */ }
    const localOcr = createLocalOcrEngine();
    const screenPerception = new ScreenPerceptionService(captureGrantManager, {
      localOcrEngine: localOcr,
      ...(cloudObservationEngine ? { cloudVlmEngine: cloudObservationEngine } : {})
    });
    const observationContext = new ObservationContextAdapter(screenPerception);
    const observationInbox = new ObservationTurnInbox(screenPerception, observationContext);
    perceptionManagement = configuration.purpose === 'user-trial'
      ? new PerceptionManagementRuntime(captureGrantManager, screenPerception, observationInbox, candidatePairing,
        runtime.instanceId, { local: true, cloud: !!cloudObservationEngine }) : undefined;
    // --- N081-06: controlled collection composition root -----------------------------------------
    // Only a real product launch wires a collection service. A preview script or a fixture run must
    // never carry this, so the whole block is fenced behind the same user-trial purpose.
    let collectionManagement: CollectionManagement | undefined;
    let collectionGrants: CollectionGrantManager | undefined;
    let companionModeRuntime: CompanionModeRuntime | undefined;
    let batchRunner: CollectionBatchRunner | undefined;
    let observationScheduler: ObservationScheduler | undefined;
    if (configuration.purpose === 'user-trial') {
      // The `smoke` profile is only ever selected explicitly at launch and never inherited by the
      // normal product entry; `loadCollectionPolicy` additionally refuses a shared data root.
      const collectionProfile = process.env.Aika_COLLECTION_PROFILE === 'smoke' ? 'smoke' : 'normal';
      const collectionDataRoot = process.env.Aika_COLLECTION_DATA_ROOT
        ?? resolve(configuration.projectRoot, '..', '.local', 'data');
      try {
        const collectionPolicy = loadCollectionPolicy(collectionProfile, collectionDataRoot,
          collectionProfile === 'smoke' ? resolve(configuration.projectRoot, '..', '.local', 'data') : undefined);
        const collectionStore = await CollectionStore.open(store, {
          collectionDirectory: resolve(collectionDataRoot, 'collection'),
          policy: collectionPolicy,
          probeImage: probeImageDimensions,
        });
        const grants = new CollectionGrantManager({ store: collectionStore, policy: collectionPolicy });
        collectionGrants = grants;
        const helperPaths = {
          // The trial configuration's projectRoot is the WORKSPACE, but the helper builds into the
          // desktop-pet package's dist/. Resolving from the workspace would look in windows/dist.
          ...collectionHelperPaths(resolveHelperPackageRoot(configuration.projectRoot)),
          ...(process.env.Aika_COLLECTION_STAGING_ROOT ? { stagingRoot: process.env.Aika_COLLECTION_STAGING_ROOT } : {}),
        };
        // A crashed helper can leave staged files behind; sweep them before wiring the client.
        sweepStaleStaging(helperPaths.stagingRoot);
        const helperAvailable = loadCollectionHelperManifest(helperPaths) !== null;
        const helper = helperAvailable
          ? new CollectionHelperClient({
            paths: helperPaths,
            instanceId: runtime.instanceId,
            // The routing closure reads the manager variable, so declaration order does not matter.
            onEvent: event => routeCollectionEvent(event),
          })
          : undefined;
        const screenshotDirectory = new ScreenshotDirectorySource({
          fileStableIntervalMs: collectionPolicy.fileStableIntervalMs,
          maxImageBytes: collectionPolicy.maxImageBytes,
          maxImagePixels: collectionPolicy.maxImagePixels,
          probeImage: probeImageDimensions,
        });
        collectionService = new CollectionService({
          grants, store: collectionStore, pairing: candidatePairing, instanceId: runtime.instanceId,
          ...(helper ? { helper } : {}),
          screenshotDirectory,
        });
        const syncLegacySource = async (kind: 'keyboard' | 'screenshot_directory' | 'clipboard_image', active: boolean) => {
          if (!active) {
            await collectionService!.stopSource(kind);
            return;
          }
          const mode = companionModeRuntime;
          if (!mode || mode.currentRunState !== 'running') return;
          const generation = mode.currentGeneration;
          if (grants.hasLease(kind)) await collectionService!.stopSource(kind);
          await collectionService!.startSource(kind);
          if (mode.currentRunState !== 'running' || mode.currentGeneration !== generation) {
            await collectionService!.stopSource(kind);
          }
        };
        collectionManagement = new CollectionManagement({
          service: collectionService, grants, store: collectionStore, pairing: candidatePairing,
          syncSource: syncLegacySource,
        });
        // A restart begins paused. Old grants require an explicit per-source resume.
        for (const kind of ['keyboard', 'screenshot_directory', 'clipboard_image'] as const) {
          const current = grants.current(candidatePairing, kind);
          if (current && current.state === 'active') {
            grants.transition({ pairing: candidatePairing, kind, action: 'pause',
              expectedRevision: current.revision, operationId: randomUUID() });
          }
        }
        // N082-08: companion mode runtime, batch runner, and observation scheduler
        companionModeRuntime = new CompanionModeRuntime({
          db: store.rawDatabaseForKnowledge(),
          pairing: candidatePairing,
          onGenerationChange: () => observationScheduler?.cancel(),
          onPauseAll: () => grants.suspendAll('paused', candidatePairing),
          onResume: async () => {
            for (const kind of ['keyboard', 'screenshot_directory', 'clipboard_image'] as const) {
              const current = grants.current(candidatePairing, kind);
              if (current?.state === 'active' && Date.parse(current.expiresAt) > Date.now()) {
                await syncLegacySource(kind, true);
              }
            }
          },
          onSourceSync: async (kind, active) => {
            if (kind !== 'keyboard' && kind !== 'screenshot_directory' && kind !== 'clipboard_image') {
              throw new Error(`collection_source_unavailable:${kind}`);
            }
            await syncLegacySource(kind, active);
          },
        });
        batchRunner = new CollectionBatchRunner({
          db: store.rawDatabaseForKnowledge(),
          store: collectionStore,
          pairing: candidatePairing,
          parser: new DocumentParser(),
        });
        const screenCapture = new ScreenCaptureSource();
        const nativeOcr = createLocalOcrEngine();
        observationScheduler = new ObservationScheduler({
          pairing: candidatePairing,
          captureSource: screenCapture,
          ocrEngine: nativeOcr,
        });

        // The console reads the true wiring, so an absent helper reports unavailable rather than healthy.
        runtime.observeModuleState('collection', helperAvailable ? 'ready' : 'unknown',
          helperAvailable
            ? `本地采集已接线（${collectionProfile} 档）；默认关闭，需在控制台为每个来源选择范围并启用。`
            : '本地采集存储与授权已就绪，但采集 helper 未构建；来源将显示为不可用，基础对话不受影响。');
      } catch {
        // A collection failure must never stop companion chat.
        process.stderr.write('Local collection unavailable; companion chat continues.\n');
      }
    }
    /**
     * N081-06: dispatch one helper event to the service that owns its grant.
     * The grant is re-read here so a late event can never be written under a superseded revision.
     */
    function routeCollectionEvent(event: { op: string; kind: string; grantRevision: number; payload: Record<string, unknown> }): void {
      const service = collectionService;
      const grants = collectionGrants;
      if (!service || !grants) return;
      if (event.kind === 'keyboard' && event.op === 'activity') {
        const grant = grants.current(candidatePairing, 'keyboard');
        if (!grant) return;
        void service.onKeyboardActivity({
          grantId: grant.grantId, grantRevision: event.grantRevision || grant.revision,
          bucketStart: String(event.payload.bucketStart ?? ''),
          bucketEnd: String(event.payload.bucketEnd ?? ''),
          activityCount: Number(event.payload.activityCount ?? 0),
          foregroundAppId: event.payload.foregroundAppId === null || event.payload.foregroundAppId === undefined
            ? null : String(event.payload.foregroundAppId),
          afkBoundary: event.payload.afkBoundary === true,
        });
        return;
      }
      if (event.kind === 'clipboard_image' && event.op === 'clipboard_seq') {
        const grant = grants.current(candidatePairing, 'clipboard_image');
        if (!grant) return;
        void service.onClipboardChange({
          grantId: grant.grantId, grantRevision: event.grantRevision || grant.revision,
          clipboardSequence: Number(event.payload.clipboardSequence ?? 0),
          observedAt: String(event.payload.observedAt ?? new Date().toISOString()),
        });
        return;
      }
      if (event.kind === 'system' && event.op === 'session_locked') {
        if (companionModeRuntime) {
          void companionModeRuntime.onSessionLock().catch(() => {
            process.stderr.write('Collection could not pause on session lock.\n');
          });
        } else {
          void grants.suspendAll('session_locked', candidatePairing);
        }
        return;
      }
    }
    const unifiedTimeline = new UnifiedTimelineService(store.rawDatabaseForKnowledge(), characterPacks);
    const companionEventHub = new CompanionEventHub();
    let timelineDispatchError: unknown;
    companionEventHub.subscribeDomain(['canon', 'companion', 'work'], envelope => {
      try { unifiedTimeline.recordEventSync(envelope); }
      catch (error) { timelineDispatchError = error; throw error; }
    }, candidatePairing);
    // N081-06: collection is an explicit opt-in domain. It is NOT added to the default subscriber
    // above, so an old client's three-domain result set is unchanged; the collection projection is
    // read from the Collection store by the management layer instead.
    companionEventHub.subscribeDomain(['collection'], envelope => {
      try { unifiedTimeline.recordEventSync(envelope); }
      catch (error) { timelineDispatchError = error; throw error; }
    }, candidatePairing);
    const publishUnifiedTimelineEvent = (envelope: import('../contracts/perception.js').CompanionEventEnvelope): void => {
      timelineDispatchError = undefined;
      companionEventHub.publishEnvelope(envelope);
      if (timelineDispatchError !== undefined) throw timelineDispatchError;
    };
    const proactiveInvitations = configuration.purpose === 'user-trial'
      ? new ProactiveInvitationRuntime(store.rawDatabaseForKnowledge(), continuityStore, store.invitations, companionEventHub)
      : undefined;
    if (proactiveInvitations) {
      const active = proactiveInvitations.policy(candidatePairing).enabled;
      runtime.observeModuleState('invitations', active ? 'ready' : 'unknown', active
        ? '主动陪伴已启用；来源限策略开启后新确认且证据有效的连续性事实/里程碑，展示受忙闲、勿扰与共享配额仲裁。'
        : '正式候选、持久仲裁与桌面展示已接线；策略默认关闭，可在控制台启用。');
    }
    const conversationCandidates = configuration.purpose === 'user-trial'
      ? new ConversationCandidateWriter(store, continuityStore, characterId => productionPairing(characterId, 'companion-default'))
      : undefined;
    if (conversationCandidates) {
      conversationCandidates.initialize(candidatePairing);
      conversationCandidates.recover(candidatePairing);
    }
    const syncProactiveInvitations = (pairing: PairingScope) => {
      if (!proactiveInvitations) return;
      const previous = proactiveInvitations.shown(pairing);
      proactiveInvitations.sync(pairing);
      if (previous && !proactiveInvitations.shown(pairing)) session?.withdrawInvitation(previous);
      session?.requestProactiveEvaluation();
    };
    if (proactiveInvitations) proactiveInvitations.sync(candidatePairing);
    const continuity = continuityManagement(continuityStore, syncProactiveInvitations);
    // N075-01/R5: open persistent trace store in the companion SQLite database and wire to both the
    // production turn pipeline and the management server.
    const traceStore = RuntimeTraceStore.open(store.rawDatabaseForKnowledge());
    // N075-01/R2: the continuity context source composes the pack store and the continuity memory
    // store into ONE production dialogue context. It is a read-only projection: no second pipeline,
    // no second store, one dialogue call. A compose failure fails the turn visibly; capability-off
    // (no pairing) keeps the ordinary text path byte-identical.
    const continuityContext = new ProductionContinuityContext({
      packs: characterPacks, memory: continuityStore,
      pairing: productionPairingResolver(configuration.purpose === 'user-trial' ? 'companion-default' : 'smoke-default'),
      dialogueInputTokenBudget: configuration.models.dialogue.inputTokenLimit,
    });
    // The active library is read fresh per turn; the port never caches a selection across a switch.
    // A library read failure must never take the whole conversation store down with it.
    const knowledgeSelection = async () => {
      try { return await knowledgeStore.selection(); } catch { return null; }
    };
    const memory = new ObservedTrialMemory(store, {
      context: { knowledge: knowledgeSelection, inputTokenBudget: configuration.models.dialogue.inputTokenLimit, maxRecentMessages: settings.effective.context.maxRecentMessages, maxMemories: settings.effective.context.maxMemories,
        summaryLimit: settings.effective.context.summaryLimit, countTokens: contextInputUpperBound, relevance: () => 1,
        // N075-01/R2: the continuity projection is read fresh per turn, scoped by the production
        // pairing resolver. Character soul, relationship, user soul, user wiki, canon timeline and
        // companion timeline now reach the ONE production DialogueContext.
        continuity: (scope: { readonly characterId: string }) => continuityContext.contextFor(scope.characterId, ''),
        // RP75-02: synchronous continuity validation in assertContextCurrent against live mutations
        assertContinuityCurrent: (result: import('../contracts/continuity-context.js').ContinuityContextResult) => continuityContext.assertCurrent(result) },
      turn: { inputTokenBudget: configuration.models.memory_turn.inputTokenLimit,
        countTokens: input => buildMemorySemanticFormat(input,true).inputUpperBound, maxSupplementaryPlans: 1,
        provider: strictProvider },
      summary: { inputTokenBudget: configuration.models.summary.inputTokenLimit, minMessages: settings.effective.context.summaryMinMessages, maxMessages: settings.effective.context.summaryMaxMessages,
        countTokens: summaryInputUpperBound, provider: new JsonSummaryProvider(endpoint('summary'), transport) },
    });
    const pendingCompanionProjections: Array<{
      readonly pairing: PairingScope;
      readonly sessionId: string;
      readonly turnId: string;
      readonly createdAt: string;
    }> = [];

    const drainCompanionProjection = () => {
      if (pendingCompanionProjections.length > 0) {
        const toRetry = [...pendingCompanionProjections];
        pendingCompanionProjections.length = 0;
        for (const item of toRetry) {
          try {
            characterPacks.stageCompanionProjection(item);
          } catch {
            pendingCompanionProjections.push(item);
          }
        }
      }
      return characterPacks.projectPendingCompanionEvents((scope, messageId) => {
        const historyScope = { ...scope, generation: 0 } as TurnScope;
        const record = store!.inspect(historyScope, messageId);
        return record ? { state: record.state, role: record.message?.role, text: record.message?.text } : null;
      }, publishUnifiedTimelineEvent);
    };
    // Recover turns staged immediately before a previous process exited.
    drainCompanionProjection();
    if(configuration.purpose==='user-trial' && typeof (memory as import('../contracts/memory-lifecycle.js').BackgroundMemoryPort).beginPendingMutation!=='function')throw Error('Background privacy capability is required');
    const mediaStore = new MemoryMediaStore();
    const admission = new TrialAdmission(endpoint('admission'), transport,
      (scope, text, signal) => configuration.purpose==='user-trial' ? memory.foregroundContext(scope,`${scope.turnId}:user`,text,null,signal) : memory.context(scope, text, null, signal), async value => {
        if (value.rejected && configuration.purpose === 'smoke-text') await authorizer.stop('admission_rejected');
        await diagnostic({ type: 'admission', ...value });
      },
      context => memory.assertContextCurrent(context), async event => {
        if (configuration.purpose === 'smoke-text') await diagnostic({ ...event, phaseId: configuration.phaseId });
      });
    const presentation = await PresentationSettingsStore.open(resolve(configuration.projectRoot, '.local/data/presentation-settings.json'),
      await readPresentationCatalog(configuration.projectRoot), policy => process.stdout.write(JSON.stringify({ channel: 'presentation_policy', policy }) + '\n'));
    const streamingModels = streamingAsrConfiguration();
    const sessionPorts: BackendPorts = { memory, backgroundMemory: memory, mediaStore,
      onConversationSaved: scope => {
        const pairing = productionPairing('companion', configuration.purpose === 'user-trial' ? 'companion-default' : 'smoke-default');
        const projectionItem = {
          pairing,
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          createdAt: new Date().toISOString(),
        };
        try {
          characterPacks.stageCompanionProjection(projectionItem);
        } catch (error) {
          /* Staging failure is recoverable and must not undo a delivered reply. */
          pendingCompanionProjections.push(projectionItem);
          void diagnostic({
            type: 'companion_projection_error',
            sessionId: scope.sessionId,
            turnId: scope.turnId,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {});
        }
        try {
          conversationCandidates?.afterConversationSaved(scope);
        } catch (error) {
          /* Candidate persistence is recoverable from its ID-only outbox and never delays the reply. */
          void diagnostic({
            type: 'conversation_candidate_error',
            sessionId: scope.sessionId,
            turnId: scope.turnId,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {});
        }
      },
      // Invitation clicks are consumed by the existing durable store; the returned command goes
      // through DesktopRuntime so the explicit click, turn scope and microphone gate stay singular.
      acceptInvitation: invitationId => {
        const proactiveAccepted = proactiveInvitations?.accept(candidatePairing, invitationId);
        if (proactiveAccepted) return { type: 'submit_text' as const, text: proactiveAccepted.text };
        const accepted = store!.invitations.clickForCharacter(candidatePairing.characterId, invitationId);
        if (!accepted) return null;
        const occurredAt = new Date().toISOString();
        companionEventHub.publishEnvelope({
          eventId: `invitation-accepted-${accepted.invitationId}`,
          schemaVersion: 1,
          domain: 'companion',
          type: 'companion.invitation.accepted',
          pairing: candidatePairing,
          sourceRef: { id: accepted.eventId, version: accepted.sourceVersion },
          occurredAt,
          receivedAt: occurredAt,
          payload: { invitationId: accepted.invitationId, actionKind: accepted.type, status: 'accepted' },
          summary: '接受了一条主动陪伴邀请',
        });
        return { type: 'start_voice' as const };
      },
      ignoreInvitation: invitationId => {
        const proactiveDismissed = proactiveInvitations?.ignore(candidatePairing, invitationId);
        if (proactiveDismissed) return true;
        const dismissed = store!.invitations.ignoreForCharacter(candidatePairing.characterId, invitationId);
        if (!dismissed) return false;
        const occurredAt = new Date().toISOString();
        companionEventHub.publishEnvelope({
          eventId: `invitation-dismissed-${dismissed.invitationId}`,
          schemaVersion: 1,
          domain: 'companion',
          type: 'companion.invitation.dismissed',
          pairing: candidatePairing,
          sourceRef: { id: dismissed.eventId, version: dismissed.sourceVersion },
          occurredAt,
          receivedAt: occurredAt,
          payload: { invitationId: dismissed.invitationId, actionKind: 'start_voice', status: 'dismissed' },
          summary: '暂不接受这条主动陪伴邀请',
        });
        return true;
      },
      onConversationIdle: () => {
        try {
          const result = drainCompanionProjection();
          if (result.pending > 0) void diagnostic({ type: 'companion_projection_pending', pending: result.pending }).catch(() => {});
        } catch (error) {
          void diagnostic({ type: 'companion_projection_error', error: error instanceof Error ? error.message : String(error) }).catch(() => {});
        }
      },
      onProactiveOpportunity: busy => {
        if (!proactiveInvitations || store!.invitations.shownForCharacter(candidatePairing.characterId)) return;
        const invitation = proactiveInvitations.showNext(candidatePairing, busy);
        if (invitation) session?.presentInvitation(invitation);
      },
      createEmotion:()=>new EmotionTurns(store!.emotion,store!),
      consumeWakeHit: hit => wake?.consumeHit(hit),
      companionProfile: store,
      ...(configuration.purpose==='user-trial' ? {classifyMemoryRequest:admission.foregroundRequest.bind(admission)} : {isMemoryIndependent:admission.isIndependent.bind(admission)}),
      dialogue: new FlowAwareDialogueProvider(new ObservationAwareDialogueProvider(
        new JsonDialogueProvider(endpoint('dialogue'), transport, () => presentation.allowedIntent()), observationInbox, candidatePairing), {
        runActiveConversationFlow: (scope, query, signal) => next65Runtime?.runActiveConversationFlow(scope, query, signal) ?? Promise.resolve(null),
      }),
      perception: configuration.models.asr
        ? new SplitPerceptionProvider(new QwenAsrProvider(endpoint('asr'), mediaStore, transport),
          new QwenVisualEmotionProvider(endpoint('perception'), mediaStore, transport), { visualTimeoutMs: 1500 })
        : new QwenPerceptionProvider({ ...endpoint('perception'), cueLifetimeMs: 5 * 60_000 }, mediaStore, transport),
      tts: createTrialTtsProvider(settings.effective.providers.tts, endpoint('tts'), mediaStore, transport, voices),
      // FIX61-08: the local streaming recognizer is optional. When its model package is configured the
      // voice turn streams partials and commits the verified transcript; otherwise the batch ASR above
      // still transcribes the whole clip after release.
      ...(streamingModels ? { createStreamingAsr: () => new SherpaStreamingAsr(streamingModels) } : {}),
      // N075-01/R5: real production trace store wired to dialogue pipeline and memory lifecycle queue
      traceStore,
    };
    const playgroundPort = new ProductionPlaygroundPort({
      sendCommand: command => session!.receiveLine(JSON.stringify({ channel: 'command', command })),
      cancelCurrent: () => session!.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'cancel' } })),
      pairing: candidatePairing,
      getConfigRevision: () => settings.snapshot().effectiveRevision,
      hasStt: () => !!streamingModels || !!configuration.models.asr,
      hasTts: () => !!settings.effective.providers.tts?.voice,
      traceStore,
      isBusy: () => session ? session.pendingMemoryJobs().some(x => x.queued + x.running > 0) : false,
    });
    session = new BackendSession(sessionPorts, message => {
      runtime.observeDesktop(message);
      playgroundPort.observeDesktopMessage(message);
      if (message.channel === 'event' && message.event.type === 'error' && configuration.purpose === 'smoke-text') void authorizer.stop('backend_error').catch(() => {});
      process.stdout.write(JSON.stringify(message) + '\n');
    }, () => store!.close(), (scope, kind) => {
      runtime.record(kind === 'summary' ? 'summary' : 'memory_turn', 'failed', scope.characterId, '后台维护未完成；未记录对话正文。');
      if (configuration.purpose === 'smoke-text') void authorizer.stop(`${kind}_failure`).catch(() => {});
      void diagnostic({ type: 'background_failure', scope, kind }).catch(() => {});
    });
    process.stdout.write(JSON.stringify({ channel: 'presentation_policy', policy: presentation.snapshot() }) + '\n');
    const shownInvitation = store!.invitations.shownForCharacter(candidatePairing.characterId)
      ?? proactiveInvitations?.shown(candidatePairing);
    if (shownInvitation) session.presentInvitation(shownInvitation);
    emitStartup('initializing', 3);
    runtime.observeMemoryQueue(() => session!.pendingMemoryJobs());
    if (configuration.purpose === 'user-trial') {
      try {
        const channelStore=new WeChatStore(resolve(configuration.projectRoot,'.local/data/wechat/channel.sqlite'));
        const voiceMedia=new MemoryMediaStore();
        const replyMedia=new MemoryMediaStore(),channelApi=new WeChatApi();
        const replyTts=createTrialTtsProvider(settings.effective.providers.tts,endpoint('tts'),replyMedia,transport,voices);
        wechat=new WeChatService(channelStore,channelApi,async(key,send)=>{
          if(!management)throw Error('Management not ready');
          const workChannel=management.createWorkChannel(resolve(configuration.projectRoot,'.local/data/wechat/work',key));
          const conversation=new WeChatTextConversation({key,store:channelStore,send,ports:sessionPorts,...workChannel,
            classifier:new WorkIntentClassifier(endpoint('admission'),transport),planner:new WorkPlanner(endpoint('admission'),transport)});
          try{return await conversation.start();}catch(error){await conversation.close();throw error;}
        },{transcribe:wechatTranscriber(voiceMedia,new QwenAsrProvider(endpoint('asr'),voiceMedia,transport)),
          sendVoice:wechatAudioFileSender(replyMedia,replyTts,channelApi)});
      } catch { process.stderr.write('WeChat channel storage unavailable; companion data unchanged.\n'); }
      const wakeModels=resolve(configuration.projectRoot,'.local/data/wake-models');
      let wakeAvailable=false;
      try { const {verifyWakeModels}=await import('../media/wake/models.js');await verifyWakeModels(wakeModels);wakeAvailable=true; } catch { /* Off until a verified model package is installed. */ }
      try { wake=await WakeManager.open({instanceId:runtime.instanceId,file:resolve(configuration.projectRoot,'.local/data/wake-settings.json'),available:wakeAvailable,
        createDetector:async settings=>{const {openWakeDetector}=await import('../media/wake/detector.js');return openWakeDetector({modelDirectory:wakeModels,settings});},
        send:message=>process.stdout.write(JSON.stringify(message)+'\n')});
      } catch { process.stderr.write('Local wake settings unavailable; existing settings preserved.\n'); }
      managementForget=new StrictManagementForget(store,store.lifecycle,{inputTokenBudget:configuration.models.memory_turn.inputTokenLimit,
        countTokens:input=>buildMemorySemanticFormat(input,true).inputUpperBound+1024},
        (input,signal,action)=>strictProvider.planManagement(input,signal,{id:action.id,version:action.expectedVersion}));
      const importConfiguration = memoryImportConfiguration(configuration);
      try { memoryImport = new SqliteMemoryImportManagement({
        filename: resolve(configuration.projectRoot,'.local/data/memory-import.sqlite'),
        codexHome: resolve(process.env.CODEX_HOME || resolve(homedir(),'.codex')), instanceId: runtime.instanceId, store,
        configuration: importConfiguration,
        countTokens: historicalMemoryInputBytes,
        processor: { async plan(input,signal,settle) {
          const importEndpoint = observedImportEndpoint(endpoint('memory_turn'),configuration.models.memory_turn,settle);
          const provider = new StrictTrialMemoryProvider(store!,importEndpoint,
            new HistoricalMemoryTransport(transport,importConfiguration),configuration.phaseId,
            async () => {}, configuration.models.memory_turn.thinking);
          return provider.plan(input,signal);
        } },
      });
      } catch { process.stderr.write('Historical memory import unavailable; companion chat remains available.\n'); }
      const aikaProfile = await AikaProfileStore.open(resolve(configuration.projectRoot, '.local/data/aika-profile.json'));
      const aikaTimeline = await AikaTimelineStore.open(resolve(configuration.projectRoot, '.local/data/aika-timeline.sqlite'));
      // FIX61-11: the skin registry is opened over the real pack directories so 换肤 is reachable from the
      // console. A registry failure must never take the console down: the section then reports unavailable.
      // The built-in rig stays bound to desktop/assets/local-model, the same directory tools/configure-model
      // validates, so the skin path never becomes a second configuration authority.
      let skins: SkinStore | undefined;
      try { skins = await SkinStore.open(resolve(configuration.projectRoot, '.local/data/skins.json'),
        resolve(configuration.projectRoot, '.local/data/skin-packs'), resolve(configuration.projectRoot, 'code/desktop-pet/desktop')); }
      catch { process.stderr.write('Skin registry unavailable; appearance stays on the built-in model.\n'); }
      const next65HostRoot = resolve(configuration.projectRoot, '.local/next65-host');
      await mkdir(next65HostRoot, { recursive: true });
      try {
        const { createPackageHost } = await import('../plugins/host-runtime.js');
        const { secretStore } = await import('../plugins/secret-store.js');
        liveHost = createPackageHost({
          hostRoot: next65HostRoot,
          secrets: secretStore(configuration),
        });
      } catch { /* Host stays unavailable if creation fails */ }
      next65Runtime = new Next65Management({
        hostRoot: next65HostRoot,
        host: liveHost,
        providerRuntime: legacyProviderAdapter.runtime,
      });

      if (configuration.purpose === 'user-trial') try {
        protocolWork = await WorkProtocolRuntime.open({ profileFile: resolve(configuration.projectRoot, '.local/data/work-protocol-profiles.json'),
          journalFile: resolve(configuration.projectRoot, '.local/data/work-protocol.sqlite'), eventHub: companionEventHub,
          pairing: candidatePairing, characterPacks });
      } catch { process.stderr.write('ACP/MCP work protocol unavailable; native work and companion chat remain available.\n'); }

      // The console reads and writes the same profile the composition root applies; nothing is duplicated.
      management = await startRuntimeManagement(registeredConfiguration, configFile, settings, runtime,
        withStrictManagementForget(new SqliteManagementMemoryPort(store,memory),managementForget),presentation,
        pendingMemoryManagement(runtime.instanceId,memory,(scope,id)=>{const source=store!.inspect(scope,id);return source?.state==='active'&&source.message?.role==='user'?{text:source.text,createdAt:source.message.createdAt}:undefined;},
          (scope,id,text)=>session!.retryPendingMemory(scope,id,text),()=>session!.pendingMemoryJobs().some(x=>x.queued+x.running>0)),wechat,wake,memoryImport,store.emotion,
        { store: aikaProfile, timeline: aikaTimeline }, knowledge,
        // The preference is per-machine app data; the console only reads and writes it.
        continuity,
        await MicrophonePreferenceStore.open(resolve(configuration.projectRoot, '.local/data/microphone.json')),
        skins,
        traceStore,
        trace => readTraceContentFromHistory(store!, trace),
        next65Runtime,
        { service: unifiedTimeline, pairing: candidatePairing }, protocolWork,
        proactiveInvitations ? proactiveInvitationManagement(proactiveInvitations, (pairing, policy, previouslyShown) => {
          runtime.observeModuleState('invitations', policy.enabled ? 'ready' : 'unknown', policy.enabled
            ? '主动陪伴已启用；来源限策略开启后新确认且证据有效的连续性事实/里程碑，展示受忙闲、勿扰与共享配额仲裁。'
            : '正式候选、持久仲裁与桌面展示已接线；策略默认关闭，可在控制台启用。');
          if (!policy.enabled && previouslyShown) session?.withdrawInvitation(previouslyShown);
          if (policy.enabled) syncProactiveInvitations(pairing);
          session?.requestProactiveEvaluation();
        }) : undefined, perceptionManagement, playgroundPort, collectionManagement,
        companionModeRuntime, batchRunner, observationScheduler);
    }
    if (configuration.purpose === 'user-trial') {
      const classifier = new WorkIntentClassifier(endpoint('admission'), transport);
      if (management?.tasks && management.projects && management.receipts) {
        const work = new DesktopWork({ receipts: management.receipts, projects: management.projects, forwarding: management.tasks,
          classify: classifier.classify.bind(classifier), interpret: classifier.interpret.bind(classifier),
          plan: (scope,text,catalog,signal)=>new WorkPlanner(endpoint('admission'),transport).plan(scope,text,catalog,signal),
          onReceipt: row => {
            if (!row.confirmedAt) return;
            const status = row.phase === 'completed' || row.nativeStatus === 'completed' ? 'succeeded'
              : row.phase === 'unknown' || row.nativeStatus === 'unknown' ? 'uncertain'
              : row.phase === 'unavailable' || row.nativeStatus === 'failed' ? 'failed'
              : row.phase === 'forwarding' ? 'dispatched'
              : row.phase === 'accepted' ? 'running'
              : undefined;
            if (!status) return;
            const title = row.plan?.title?.trim() || row.target?.title?.trim() || '工程任务';
            const occurredAt = row.confirmedAt || row.createdAt;
            publishUnifiedTimelineEvent({
              eventId: `work-receipt-${row.id}-v${row.version}`,
              schemaVersion: 1,
              domain: 'work',
              type: 'work.task.receipt',
              pairing: candidatePairing,
              turnId: row.appTurnId ?? row.harnessSessionId ?? row.id,
              sourceRef: { id: `work-request:${row.id}`, version: row.version },
              occurredAt,
              receivedAt: new Date().toISOString(),
              payload: { executorId: row.executor ?? 'codex', taskId: row.id, status, title, instruction: '', resultSummary: '' },
              summary: `${title} (${status})`,
            });
          },
          emit: state => process.stdout.write(JSON.stringify({ channel: 'work_state', state }) + '\n'), notify: notice => session!.notifyWork(notice) });
        desktopWork = work; session.attachWork(work); await work.start();
      } else {
        // Failed independent storage must not stop unrelated companion chat or leak engineering input into it.
        let sequence = 0;
        const unavailable = () => process.stdout.write(JSON.stringify({ channel: 'work_state', state: { sequence: ++sequence,
          focus: 'work', stage: 'failed', requests: [], detail: '工作记录暂不可用；这次任务没有保存或发送，陪伴聊天仍可继续。' } }) + '\n');
        desktopWork = { onInput() {}, async route(scope, text, signal) {
          const intent = await classifier.classify(scope, text, signal);
          if (intent.kind === 'companion') return 'companion'; unavailable(); return 'handled';
        }, async action() { unavailable(); }, async close() {} };
        session.attachWork(desktopWork);
      }
    }
    await wechat?.restore().catch(()=>{process.stderr.write('WeChat restore deferred; use connection page.\n');});
    emitStartup('ready', 4);
    const cleanupTimer = setInterval(() => { try { store!.cleanup(); } catch { process.stderr.write('Local memory cleanup did not complete\n'); } }, 60_000);
    cleanupTimer.unref();
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let stopping = false;
    const close = async () => {
      if (stopping) return; stopping = true; clearInterval(cleanupTimer); lines.close(); process.stdin.pause();
      managementForget?.close();
      // Stop collection listeners before the memory store closes, so no late event writes into a
      // closing database. `collectionService.close()` also terminates the helper process.
      try { await collectionService?.close(); } catch { process.stderr.write('Collection shutdown did not complete\n'); }
      try { await wake?.close(); await wechat?.close(); await desktopWork?.close(); await liveHost?.close(); await management?.close(); await managementForget?.drain(); await settings.drain(); await presentation.drain(); }
      finally { try { await session!.close(); } finally { await release(); } }
    };
    let submitted = false;
    lines.on('line', line => {
      if (configuration.purpose === 'smoke-text') {
        try {
          const message = JSON.parse(line);
          if (message.channel === 'command') {
            if (submitted || message.command?.type !== 'submit_text' || message.command.text !== configuration.smokeInput) throw new Error('Unregistered smoke input');
            submitted = true;
          }
        } catch { void authorizer.stop('unregistered_smoke_input').finally(close); return; }
      }
      try {
        const event = JSON.parse(line);
        if (event?.channel === 'desktop_system' && event.event === 'session_locked') {
          if (configuration.purpose === 'user-trial') {
            void companionModeRuntime?.onSessionLock().catch(() => {
              process.stderr.write('Collection could not pause on session lock.\n');
            });
          }
          return;
        }
      } catch { /* The session protocol reports malformed input. */ }
      try { if(wake?.receive(JSON.parse(line)))return; } catch { /* Original protocol validator owns non-wake input. */ }
      void session!.receiveLine(line);
    });
    lines.on('close', () => { void close(); });
    process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
  } catch (error) {
    managementForget?.close();
    perceptionManagement?.close();
    try { await collectionService?.close(); } catch { /* best-effort collection teardown */ }
    await wake?.close(); await wechat?.close(); await liveHost?.close(); await management?.close(); await managementForget?.drain();
    await memoryImport?.close();
    if (session) await session.close(); else store?.close();
    await release(); throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startTrialBackend().catch(() => { process.stderr.write('试用后端未启动，请检查已登记的配置与程序版本。\n'); process.exitCode = 1; });
}
