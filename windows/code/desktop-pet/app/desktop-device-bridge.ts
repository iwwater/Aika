import { randomUUID } from 'node:crypto';
import { MAX_CAPTURE_IMAGES } from '../contracts/index.js';
import type { BackendToDesktop, DesktopToBackend } from '../contracts/desktop-bridge.js';
import type { CapturePort, CapturedInput, MediaStorePort, PlaybackEvent, PlaybackPort, TurnScope } from '../contracts/index.js';
import { sameScope } from '../core/turn-controller.js';
import { CaptureError, readDeviceFailure } from '../media/capture-errors.js';
import { VoiceFrameReorder, decodeVoiceChunkFrame, VOICE_FRAME_SAMPLES, type VoiceChunkFrame, type VoiceFrameSink } from '../media/voice-input-session.js';
import { SHERPA_STREAMING_SAMPLE_RATE } from '../providers/sherpa-streaming-asr.js';

type Pending = { kind: 'ack' | 'capture' | 'play'; operation: DeviceOperation; scope: TurnScope; resolve: (value: unknown) => void; reject: (error: Error) => void; dispose: () => void; emit?: (event: PlaybackEvent) => void };
/** How long the pull leg waits before asking again for a frame the renderer has not produced yet. */
const VOICE_PULL_RETRY_MS = 10;
/** A requested frame the renderer never answers fails instead of wedging the capture. */
const VOICE_PULL_TIMEOUT_MS = 2_000;

/** One live capture session: its authorized scope, index accounting and the sink that owns the audio. */
interface VoiceCapture { readonly inputSessionId: string; readonly scope: TurnScope; readonly order: VoiceFrameReorder; readonly sink: VoiceFrameSink;
  /** The next index a push or pull is waiting for. */
  expected?: number;
  /** True once this session's frames are being pulled from the renderer. */
  pulling?: boolean;
  /** The pending tick of this session's pull loop. */
  timer?: ReturnType<typeof setTimeout>;
  /** Consecutive "nothing captured yet" answers, so a silent room stops spinning. */
  empty?: number;
  /** Every voice_frame request still owed an answer, keyed by the requestId that asked for it. */
  readonly requests: Map<string, VoiceRequest> }
/** One unanswered voice_frame pull: the index it asked for and, for a bridged push, the audio itself. */
interface VoiceRequest { readonly requestId: string; readonly index: number; readonly pcm?: Uint8Array | undefined;
  readonly createdAtMs: number; resolve: (notCaptured?: boolean) => void; readonly reject: (error: Error) => void }
/** Whether a pull was answered with audio, with "not captured yet", or not answered at all. */
type VoicePullResult = 'empty' | 'frame' | 'timeout';
const abortError = () => new DOMException('Device request cancelled', 'AbortError');
/** Constant-time-ish byte comparison for the payload a pull request asked for. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}
function operationFailure(operation: DeviceOperation): Error {
  switch (operation) {
    case 'capture_start': return new CaptureError({ code: 'capture_start_failed', stage: 'unknown' });
    case 'capture_finish': return new CaptureError({ code: 'capture_finish_failed', stage: 'capture_finish' });
    case 'capture_stop': return new Error('录音停止未确认，请重新打开应用后重试。');
    case 'play': return new Error('语音播放失败，请检查声音输出后重试。');
    case 'stop': return new Error('语音停止未确认，请重新打开应用后重试。');
    default: return new Error('设备操作未确认，请重新打开应用后重试。');
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid desktop message');
  return value as Record<string, unknown>;
}
function matchesScope(value: unknown, expected: TurnScope): boolean {
  try { const s = record(value); return s.characterId === expected.characterId && s.sessionId === expected.sessionId && s.turnId === expected.turnId && s.generation === expected.generation; } catch { return false; }
}
function mediaBytes(value: unknown, expectedType?: string): { bytes: Uint8Array; mimeType: string } {
  const media = record(value);
  if (typeof media.base64 !== 'string' || !media.base64.length || media.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(media.base64)) throw new Error('Invalid captured media encoding');
  if (typeof media.mimeType !== 'string' || (expectedType ? media.mimeType !== expectedType : !['image/jpeg', 'image/png', 'image/webp'].includes(media.mimeType))) throw new Error('Invalid captured media type');
  // Node Buffer.slice aliases storage. Normalize at this process boundary so the
  // media-store Uint8Array copy contract survives clearing this transfer buffer.
  return { bytes: Uint8Array.from(Buffer.from(media.base64, 'base64')), mimeType: media.mimeType };
}
type DeviceOperation = Extract<BackendToDesktop, { requestId: string }>['channel'];

/** Device ports over the native bridge. Media URI namespaces remain local to their owning process. */
export class DesktopDeviceBridge {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  readonly capture: CapturePort;
  readonly playback: PlaybackPort;
  /**
   * FIX61-08 live capture: the still-recording renderer pushes 100 ms PCM16 frames here through the
   * bridge. openVoiceCapture() binds the one authorized input session; a frame from another session,
   * generation or index is refused, and it is acknowledged only after the sink accepted it.
   */
  readonly receiveVoiceChunk: (value: unknown) => boolean;
  /**
   * FIX61-08: the sink the bridge itself owns. A session can push into it directly instead of bringing
   * its own sink, and the bridge then routes each accepted frame exactly as if the renderer had pushed it.
   */
  readonly captureChunks: VoiceFrameSink;
  constructor(private readonly store: MediaStorePort, private readonly send: (message: BackendToDesktop) => void, private readonly controlTimeoutMs = 60_000) {
    this.capture = {
      start: async (scope, signal) => { await this.request('ack', scope, requestId => ({ channel: 'capture_start', requestId, scope }), signal); },
      finish: scope => this.finishCapture(scope),
      stop: async scope => { this.rejectScope(scope, 'capture'); await this.request('ack', scope, requestId => ({ channel: 'capture_stop', requestId, scope })); },
    };
    this.playback = {
      play: async (tts, emit, signal) => {
        signal.throwIfAborted(); const bytes = await store.read(tts.scope, tts.audio);
        try { signal.throwIfAborted(); await this.request('play', tts.scope, requestId => ({ channel: 'play', requestId, tts, audioBase64: Buffer.from(bytes).toString('base64') }), signal, emit); }
        finally { bytes.fill(0); }
      },
      stop: async scope => { this.rejectScope(scope, 'play'); await this.request('ack', scope, requestId => ({ channel: 'stop', requestId, scope })); },
    };
    // Two legs share one accounting: the renderer either pushes a frame it just captured, or answers
    // the voice_frame request this bridge sent for exactly that index. A foreign session, generation
    // or payload is refused, so a late frame of a previous recording can never enter a newer one.
    this.receiveVoiceChunk = value => this.#voiceChunk(value);
    // The bridge-owned sink. push() validates the frame against the ONE bound session and then asks the
    // renderer for that exact payload with a voice_frame request; the answer comes back through
    // receiveVoiceChunk and reaches the bound sink. That request/response pair is the backpressure
    // signal, so a slow recognizer stops the renderer instead of buffering its audio.
    this.captureChunks = {
      push: async (frame, pcm) => {
        const capture = this.#voiceCapture;
        if (!capture) throw new Error('voice capture session is not active');
        if (capture.inputSessionId !== frame.inputSessionId || capture.scope.generation !== frame.generation) {
          throw new Error('voice frame does not match the requested frame');
        }
        if (capture.expected !== undefined && capture.expected !== frame.index) throw new Error('voice frame does not match the captured frame');
        capture.expected = frame.index + 1;
        // Every request is registered on its own id: the answer settles exactly the waiter that
        // asked for it, and a refused answer rejects it instead of leaving it pending forever.
        return new Promise<void>((resolve, reject) => {
          const requestId = randomUUID();
          capture.requests.set(requestId, { requestId, index: frame.index, createdAtMs: Date.now(),
            ...(pcm ? { pcm: Uint8Array.from(pcm) } : {}), resolve: () => resolve(), reject });
          this.send({ channel: 'voice_frame', requestId, inputSessionId: frame.inputSessionId, generation: frame.generation,
            index: frame.index, sampleRate: frame.sampleRate, sampleCount: frame.sampleCount });
        });
      },
      finish: async header => {
        const capture = this.#voiceCapture;
        if (!capture || capture.inputSessionId !== header.inputSessionId || capture.scope.generation !== header.generation) {
          throw new Error('voice capture session is not active');
        }
        // Bound to its own sink there is nothing to forward: the producer already owns the audio.
        if (capture.sink !== this.captureChunks) await capture.sink.finish(header);
      }
    };
  }
  #voiceCapture: VoiceCapture | undefined;
  /**
   * Binds the one authorized input session to its frame sink. A new binding replaces — and thereby
   * invalidates — the previous session, so an old recording can never continue into a new turn.
   */
  openVoiceCapture(inputSessionId: string, scope: TurnScope, sink?: VoiceFrameSink): void {
    // Without an explicit sink the bridge routes into its own captureChunks sink, so a caller can bind
    // a session and push frames into the same object.
    this.#releaseVoiceCapture(new Error('voice capture session is not active'));
    const capture: VoiceCapture = { inputSessionId, scope: Object.freeze({ ...scope }), order: new VoiceFrameReorder(),
      requests: new Map(), sink: sink ?? this.captureChunks };
    this.#voiceCapture = capture;
    // Only a foreign sink is pulled: a producer that already pushes into this bridge's own sink is
    // driven by those pushes, and asking the renderer in parallel would duplicate its frames.
    if (sink) this.#startVoicePull(capture);
  }
  /**
   * The pull leg: the backend asks the renderer for the next frame it has not seen yet. Whereas the
   * renderer pushes only whole frames it already captured, this keeps asking for the frame after the
   * last one delivered, so nothing has to wait for a whole frame to be captured first. One request at
   * a time per session: the acknowledgement IS the backpressure signal, so a slow recognizer stops the
   * pull instead of letting the renderer run ahead.
   */
  #startVoicePull(capture: VoiceCapture): void {
    if (capture.pulling) return;
    capture.pulling = true;
    const sampleCount = VOICE_FRAME_SAMPLES;
    const tick = (): void => {
      // The session was released: its frames belong to a recording that is over.
      if (this.#voiceCapture !== capture || this.closed) return;
      // Requests are keyed by id, so several may legitimately be open at once — each still fails by
      // itself. Never pile up more while the renderer owes an answer for the current one.
      if (capture.requests.size) {
        this.#failStaleVoiceRequests(capture);
        if (capture.requests.size) { this.#scheduleVoicePull(capture, tick, true); return; }
      }
      const index = capture.order.nextIndex;
      const frame = { inputSessionId: capture.inputSessionId, generation: capture.scope.generation,
        index, sampleRate: SHERPA_STREAMING_SAMPLE_RATE, sampleCount };
      void this.#pullVoiceFrame(capture, frame).then(result => {
        if (this.#voiceCapture !== capture || this.closed) return;
        // Nothing captured yet (or a refusal): ask again. The renderer answered, so it is alive and
        // another immediate round costs one real message exchange, not a busy spin.
        this.#scheduleVoicePull(capture, tick, result !== 'timeout');
      }, () => {
        if (this.#voiceCapture !== capture || this.closed) return;
        this.#scheduleVoicePull(capture, tick, false);
      });
    };
    this.#scheduleVoicePull(capture, tick, true);
  }
  /** Queues the next pull tick: at once while the renderer answers, otherwise on the retry interval. */
  #scheduleVoicePull(capture: VoiceCapture, tick: () => void, immediately: boolean): void {
    if (immediately) setImmediate(tick);
    else capture.timer = setTimeout(tick, VOICE_PULL_RETRY_MS);
  }
  /**
   * One pull round trip: delivered to the bound sink, then acknowledged. Resolves to 'empty' when the
   * renderer has not captured that frame yet, 'frame' when audio was delivered, and 'timeout' when it
   * never answered at all — so the next pull knows whether the renderer is still there.
   */
  async #pullVoiceFrame(capture: VoiceCapture, frame: { inputSessionId: string; generation: number; index: number; sampleRate: number; sampleCount: number }): Promise<'empty' | 'frame' | 'timeout'> {
    const requestId = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<'empty' | 'frame'>((resolve, reject) => {
        capture.requests.set(requestId, { requestId, index: frame.index, createdAtMs: Date.now(),
          resolve: notCaptured => resolve(notCaptured ? 'empty' : 'frame'), reject });
        timer = setTimeout(() => {
          const request = capture.requests.get(requestId);
          if (!request) return;
          capture.requests.delete(requestId);
          // A frame the renderer never produced is normal while the user is silent; asking again is
          // the retry. Anything else must not wedge the capture.
          request.reject(new Error('voice frame request timed out'));
        }, VOICE_PULL_TIMEOUT_MS);
        // The sample rate the pull asks for is the recognizer's; the sink resamples if needed.
        this.send({ channel: 'voice_frame', requestId, ...frame });
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (failure.message !== 'voice frame request timed out') this.onVoiceChunkError?.(failure);
      // A refused or failed frame stops this round; the next tick asks again.
      return 'timeout';
    } finally { if (timer) clearTimeout(timer); capture.requests.delete(requestId); }
  }
  /** Fails any request that has waited far longer than the renderer needs to produce one frame. */
  #failStaleVoiceRequests(capture: VoiceCapture): void {
    const deadline = Date.now() - VOICE_PULL_TIMEOUT_MS;
    for (const request of [...capture.requests.values()]) {
      if (request.createdAtMs > deadline) continue;
      capture.requests.delete(request.requestId);
      request.reject(new Error('voice frame request timed out'));
    }
  }
  closeVoiceCapture(inputSessionId: string): void {
    if (this.#voiceCapture?.inputSessionId === inputSessionId) this.#releaseVoiceCapture(new Error('voice capture session is not active'));
  }
  /** Drops the bound session and settles every request it still owes an answer to. */
  #releaseVoiceCapture(error: Error): void {
    const capture = this.#voiceCapture;
    if (!capture) return;
    this.#voiceCapture = undefined;
    if (capture.timer) clearTimeout(capture.timer);
    for (const request of [...capture.requests.values()]) {
      capture.requests.delete(request.requestId);
      request.reject(error);
    }
  }
  /**
   * One renderer frame: it must address the bound session and generation, its index must be next,
   * and it is acknowledged only after the sink accepted it — that ack is the backpressure signal.
   * An answer to a pull request is additionally checked against that request: a foreign generation
   * or index fails it as "requested", an altered payload as "captured".
   */
  #voiceChunk(value: unknown): boolean {
    let frame: VoiceChunkFrame;
    try { frame = decodeVoiceChunkFrame(value); }
    catch (error) { this.onVoiceChunkError?.(error); return false; }
    const capture = this.#voiceCapture;
    if (!capture) return false;
    const raw = value as Record<string, unknown>;
    const request = typeof raw.requestId === 'string' ? capture.requests.get(raw.requestId) : undefined;
    if (capture.inputSessionId !== frame.inputSessionId || capture.scope.generation !== frame.generation) {
      // Addressed to a request of this session but not to the session itself: fail the request
      // instead of leaving it pending, so the producer cannot keep feeding a broken stream.
      if (request) this.#refuseVoiceRequest(capture, request, 'voice frame does not match the requested frame');
      return request !== undefined;
    }
    if (request) {
      capture.requests.delete(request.requestId);
      // An empty answer means the renderer has not captured that frame yet — while the user is silent
      // this is normal. It is not a frame: the index does not advance and nothing reaches the sink.
      if (!frame.pcm.length) { request.resolve(true); return true; }
      if (frame.index !== request.index) return this.#refuseVoiceRequest(capture, request, 'voice frame does not match the requested frame');
      if (request.pcm && !sameBytes(request.pcm, frame.pcm)) return this.#refuseVoiceRequest(capture, request, 'voice frame does not match the captured frame');
    }
    // A repeat is ignored; a gap is a lost frame and stops the turn rather than transcribing a hole.
    try { if (!capture.order.accept(frame.index)) return true; }
    catch (error) {
      if (request) this.#refuseVoiceRequest(capture, request, 'voice frame does not match the requested frame');
      else this.onVoiceChunkError?.(error);
      return true;
    }
    void this.#deliverVoiceFrame(capture, frame, request);
    return true;
  }
  /** Hands one accepted frame to the bound sink; its acceptance is the acknowledgement. */
  async #deliverVoiceFrame(capture: VoiceCapture, frame: VoiceChunkFrame, request: VoiceRequest | undefined): Promise<void> {
    try {
      // Bound to its own sink the answered payload already is the producer's audio.
      if (capture.sink !== this.captureChunks) await capture.sink.push(frame, frame.pcm);
      request?.resolve();
      this.onVoiceChunkAck?.({ channel: 'voice_chunk_ack', inputSessionId: frame.inputSessionId, generation: frame.generation, index: frame.index });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      request?.reject(failure);
      this.onVoiceChunkError?.(failure);
    }
  }
  /** Refuses one pull request: it never reaches the recognizer and never produces an ack. */
  #refuseVoiceRequest(capture: VoiceCapture, request: VoiceRequest, message: string): boolean {
    capture.requests.delete(request.requestId);
    const failure = new Error(message);
    request.reject(failure);
    this.onVoiceChunkError?.(failure);
    return true;
  }
  /** Backpressure acknowledgement and failure reporting towards the renderer. */
  onVoiceChunkAck?: (message: Extract<BackendToDesktop, { channel: 'voice_chunk_ack' }>) => void;
  onVoiceChunkError?: (error: unknown) => void;
  /**
   * FIX61-08 pull leg: request one specific frame from the renderer. The shell answers with a
   * `voice_chunk` carrying the same requestId, so a late answer can never be mistaken for the
   * frame that is currently wanted.
   */
  requestVoiceFrame(input: { inputSessionId: string; generation: number; index: number; sampleRate: number; sampleCount: number }): void {
    if (this.closed) throw new Error('Desktop bridge closed');
    this.send({ channel: 'voice_frame', requestId: randomUUID(), ...input });
  }
  private rejectScope(scope: TurnScope, kind: Pending['kind']): void {
    for (const [id, pending] of this.pending) if ((pending.kind === kind || (kind === 'capture' && pending.operation === 'capture_start')) && sameScope(scope, pending.scope)) this.reject(id, abortError());
  }
  private request(kind: Pending['kind'], scope: TurnScope, message: (id: string) => Extract<BackendToDesktop, { requestId: string }>, signal?: AbortSignal, emit?: (event: PlaybackEvent) => void): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Desktop bridge closed'));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const outgoing = message(id);
      // Control timeouts diagnose a disconnected shell; speech duration is never hard-truncated.
      const timer = kind === 'play' ? undefined : setTimeout(() => this.reject(id, new Error('Desktop device acknowledgement timed out')), this.controlTimeoutMs);
      const abort = () => this.reject(id, abortError());
      const pending: Pending = { kind, operation: outgoing.channel, scope, resolve, reject, dispose: () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); }, ...(emit ? { emit } : {}) };
      this.pending.set(id, pending); signal?.addEventListener('abort', abort, { once: true });
      try { this.send(outgoing); } catch { this.reject(id, new Error('Desktop bridge write failed')); }
    });
  }
  private reject(id: string, error: Error): void {
    const pending = this.pending.get(id); if (!pending) return;
    this.pending.delete(id); pending.dispose(); pending.reject(error);
  }
  private resolve(id: string, value?: unknown): void {
    const pending = this.pending.get(id); if (!pending) return;
    this.pending.delete(id); pending.dispose(); pending.resolve(value);
  }
  receive(value: unknown): boolean {
    const raw = record(value);
    // The live voice leg answers its own pull request; it never carries a pending control request.
    if (raw.channel === 'voice_chunk') return this.receiveVoiceChunk(raw);
    if (typeof raw.requestId !== 'string') return false;
    const pending = this.pending.get(raw.requestId); if (!pending) return false;
    try {
      if (raw.channel === 'rpc_error') {
        // An explicitly foreign scope cannot terminate the request that happens to share its ID.
        if (raw.scope !== undefined && !matchesScope(raw.scope, pending.scope)) return false;
        const failure = readDeviceFailure(raw.error);
        const captureStage = pending.operation === 'capture_start'
          ? failure?.stage !== 'capture_finish'
          : pending.operation === 'capture_finish' && failure?.stage === 'capture_finish';
        this.reject(raw.requestId, failure && captureStage && failure.code !== 'device_operation_failed'
          ? new CaptureError(failure) : operationFailure(pending.operation));
        return true;
      }
      if (raw.channel === 'ack' && pending.kind === 'ack') { this.resolve(raw.requestId); return true; }
      if (raw.channel === 'capture' && pending.kind === 'capture') {
        const result = record(raw.result);
        if (!matchesScope(result.scope, pending.scope) || !Array.isArray(result.images) || typeof result.inputEndedAt !== 'string' || !Number.isFinite(Date.parse(result.inputEndedAt)) || typeof result.captureStoppedAt !== 'string' || !Number.isFinite(Date.parse(result.captureStoppedAt))) throw new Error('Invalid capture result scope or timing');
        if(result.images.length>MAX_CAPTURE_IMAGES)throw new Error('Capture must contain at most three actual frames from the current turn');
        this.resolve(raw.requestId, result); return true;
      }
      if (raw.channel === 'playback' && pending.kind === 'play') {
        const event = record(raw.event);
        if (!matchesScope(event.scope, pending.scope) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid playback scope or time');
        if (!['started', 'amplitude', 'progress', 'ended', 'stopped', 'error'].includes(String(event.type))) throw new Error('Invalid playback event type');
        if (event.type === 'started' && typeof event.audioId !== 'string') throw new Error('Missing playback audio ID');
        if (event.type === 'amplitude' && (typeof event.value !== 'number' || !Number.isFinite(event.value) || event.value < 0 || event.value > 1)) throw new Error('Invalid playback amplitude');
        if (event.type === 'progress' && (typeof event.positionMs !== 'number' || !Number.isFinite(event.positionMs) || event.positionMs < 0 || (event.durationMs !== null && (typeof event.durationMs !== 'number' || !Number.isFinite(event.durationMs) || event.durationMs < 0)))) throw new Error('Invalid playback progress');
        if (event.type === 'error' && typeof event.message !== 'string') throw new Error('Missing playback error');
        const message = raw as unknown as Extract<DesktopToBackend, { channel: 'playback' }>;
        pending.emit?.(message.event);
        if (['ended', 'stopped', 'error'].includes(String(event.type))) this.resolve(raw.requestId);
        return true;
      }
      throw new Error('Desktop response does not match request');
    } catch (error) { this.reject(raw.requestId, error instanceof Error ? error : new Error('Invalid desktop response')); return true; }
  }
  private async finishCapture(scope: TurnScope): Promise<CapturedInput> {
    const raw = record(await this.request('capture', scope, requestId => ({ channel: 'capture_finish', requestId, scope })));
    const audioBytes = mediaBytes(raw.audio, 'audio/wav');
    try {
      const audio = await this.store.put(scope, audioBytes.bytes, audioBytes.mimeType), images = [];
      for (const value of raw.images as unknown[]) {
        const image = mediaBytes(value);
        try { images.push(await this.store.put(scope, image.bytes, image.mimeType)); } finally { image.bytes.fill(0); }
      }
      return { scope, audio, images, inputEndedAt: raw.inputEndedAt as string, captureStoppedAt: raw.captureStoppedAt as string };
    } catch (error) { await this.store.releaseScope(scope); throw error; }
    finally { audioBytes.bytes.fill(0); }
  }
  close(): void {
    this.closed = true;
    // A closed bridge must not leave a producer waiting for an acknowledgement that can never arrive.
    this.#releaseVoiceCapture(new Error('Desktop bridge closed'));
    for (const id of this.pending.keys()) this.reject(id, new Error('Desktop bridge closed'));
  }
}
