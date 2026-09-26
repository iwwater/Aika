import { randomUUID } from 'node:crypto';
import { MAX_CAPTURE_IMAGES } from '../contracts/index.js';
import type { BackendToDesktop, DesktopToBackend } from '../contracts/desktop-bridge.js';
import type { CapturePort, CapturedInput, MediaStorePort, PlaybackEvent, PlaybackPort, TurnScope } from '../contracts/index.js';
import { sameScope } from '../core/turn-controller.js';
import { CaptureError, readDeviceFailure } from '../media/capture-errors.js';

type DeviceOperation = Extract<BackendToDesktop, { requestId: string }>['channel'];
type Pending = { kind: 'ack' | 'capture' | 'play'; operation: DeviceOperation; scope: TurnScope; resolve: (value: unknown) => void; reject: (error: Error) => void; dispose: () => void; emit?: (event: PlaybackEvent) => void };
const abortError = () => new DOMException('Device request cancelled', 'AbortError');
function operationFailure(operation: DeviceOperation): Error {
  switch (operation) {
    case 'capture_start': return new CaptureError({ code: 'capture_start_failed', stage: 'unknown' });
    case 'capture_finish': return new CaptureError({ code: 'capture_finish_failed', stage: 'capture_finish' });
    case 'capture_stop': return new Error('录音停止未确认，请重新打开应用后重试。');
    case 'play': return new Error('语音播放失败，请检查声音输出后重试。');
    case 'stop': return new Error('语音停止未确认，请重新打开应用后重试。');
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
/** Device ports over the native bridge. Media URI namespaces remain local to their owning process. */
export class DesktopDeviceBridge {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  readonly capture: CapturePort;
  readonly playback: PlaybackPort;
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
    for (const id of this.pending.keys()) this.reject(id, new Error('Desktop bridge closed'));
  }
}
