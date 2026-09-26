// FIX61-08 voice input session: bounded 100 ms PCM16 mono framing shared by the recorder worklet
// (2048-sample flushes), the desktop shell and the live ASR session. Every index is accounted for by
// the receiving bridge; the producer stops at the in-flight ceiling and reports backpressure instead
// of buffering without bound or dropping speech. No audio is retained after it is handed on.
import type { TurnScope } from '../contracts/index.js';

/** ~100 ms of 16 kHz mono PCM16. */
export const VOICE_FRAME_SAMPLES = 1600;
/** Hard frame ceiling on the wire (200 ms at 16 kHz). */
export const VOICE_FRAME_MAX_SAMPLES = 3200;
/** Frames allowed in flight before the producer is stopped and backpressure is reported. */
export const VOICE_MAX_FRAMES_IN_FLIGHT = 20;
/** Default whole-utterance limit. */
export const VOICE_MAX_UTTERANCE_MS = 120_000;
/** Default bound on the final recognition result. */
export const VOICE_FINISH_TIMEOUT_MS = 10_000;

export interface VoiceFrameHeader {
  readonly inputSessionId: string;
  readonly generation: number;
  readonly index: number;
  readonly sampleRate: number;
  readonly sampleCount: number;
}

export interface VoiceChunkFrame extends VoiceFrameHeader {
  readonly pcm: Uint8Array;
}

/** Reorders frames arriving from a shell host; only strictly newer indexes are accepted. */
export class VoiceFrameReorder {
  #next = 0;
  get nextIndex(): number { return this.#next; }
  /** true when this index is neither a repeat nor a gap; false ignores a repeat, throws on a gap. */
  accept(index: number): boolean {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid voice frame index');
    if (index < this.#next) return false;
    if (index > this.#next) throw new Error(`Voice frame gap: expected ${this.#next}, received ${index}`);
    this.#next += 1;
    return true;
  }
  reset(): void { this.#next = 0; }
}

export interface VoiceFrameSink {
  /** Resolves once the receiver acknowledged this frame; rejects when it never will. */
  push(header: VoiceFrameHeader, pcm: Uint8Array): Promise<void>;
  finish(header: Omit<VoiceFrameHeader, 'index' | 'sampleCount'>): Promise<void>;
}

/** Decodes one bridge payload; an invalid payload is a failure, never a silent drop. */
export function decodeVoiceChunkFrame(value: unknown): VoiceChunkFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid voice chunk');
  const frame = value as Record<string, unknown>;
  if (typeof frame.inputSessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(frame.inputSessionId)) throw new Error('Invalid voice input session');
  if (!Number.isSafeInteger(frame.generation) || Number(frame.generation) < 0) throw new Error('Invalid voice generation');
  if (!Number.isSafeInteger(frame.index) || Number(frame.index) < 0) throw new Error('Invalid voice frame index');
  if (!Number.isSafeInteger(frame.sampleRate) || Number(frame.sampleRate) < 8000 || Number(frame.sampleRate) > 192000) throw new Error('Invalid voice sample rate');
  if (!Number.isSafeInteger(frame.sampleCount) || Number(frame.sampleCount) < 0 || Number(frame.sampleCount) > VOICE_FRAME_MAX_SAMPLES) throw new Error('Voice frame exceeds the 200 ms ceiling');
  const pcm = frame.pcm;
  if (typeof pcm !== 'string' || pcm.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(pcm)) throw new Error('Invalid voice PCM encoding');
  const bytes = Uint8Array.from(Buffer.from(pcm, 'base64'));
  if (bytes.length !== Number(frame.sampleCount) * 2) throw new Error('Voice frame length does not match its sample count');
  return Object.freeze({ inputSessionId: frame.inputSessionId, generation: Number(frame.generation), index: Number(frame.index),
    sampleRate: Number(frame.sampleRate), sampleCount: Number(frame.sampleCount), pcm: bytes });
}

/** Aggregates 2048-sample worklet flushes into fixed 100 ms frames; the tail is flushed, never lost. */
export class PcmFrameAggregator {
  #tail = new Uint8Array(0);
  #samples = 0;
  #closed = false;
  constructor(private readonly frameSamples: number = VOICE_FRAME_SAMPLES) {
    if (frameSamples !== VOICE_FRAME_SAMPLES) throw new Error('Voice frames are fixed at 100 ms');
  }
  get capturedSamples(): number { return this.#samples; }
  push(block: Float32Array): Uint8Array[] {
    if (this.#closed || !block.length) return [];
    const joined = new Uint8Array(this.#tail.length + block.length * 2);
    joined.set(this.#tail, 0);
    const view = new DataView(joined.buffer);
    for (let i = 0; i < block.length; i++) {
      const sample = block[i]!;
      if (!Number.isFinite(sample)) throw new Error('Non-finite audio sample');
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(this.#tail.length + i * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
    }
    this.#samples += block.length;
    const frames: Uint8Array[] = [];
    const frameBytes = this.frameSamples * 2;
    let offset = 0;
    while (joined.length - offset >= frameBytes) { frames.push(joined.slice(offset, offset + frameBytes)); offset += frameBytes; }
    this.#tail = offset === joined.length ? new Uint8Array(0) : joined.slice(offset);
    return frames;
  }
  takeTail(): Uint8Array | undefined {
    this.#closed = true;
    const tail = this.#tail;
    this.#tail = new Uint8Array(0);
    return tail.length ? tail : undefined;
  }
  clear(): void { this.#closed = true; this.#tail = new Uint8Array(0); }
}

/** Stateful linear resampler; the phase carries across chunks so no sample is invented or dropped. */
export class StatefulResampler {
  #position = 0;
  #carry = new Float32Array(0);
  constructor(private readonly sourceRate: number, private readonly targetRate: number) {
    if (!Number.isFinite(sourceRate) || sourceRate < 8000 || !Number.isFinite(targetRate) || targetRate < 8000) throw new Error('Invalid resample rates');
  }
  get passthrough(): boolean { return this.sourceRate === this.targetRate; }
  push(input: Float32Array): Float32Array {
    if (this.passthrough) return input;
    if (!input.length) return new Float32Array(0);
    const source = new Float32Array(this.#carry.length + input.length);
    source.set(this.#carry, 0); source.set(input, this.#carry.length);
    const ratio = this.sourceRate / this.targetRate;
    const out: number[] = [];
    let position = this.#position;
    while (position < source.length - 1) {
      const left = Math.floor(position), fraction = position - left;
      out.push(source[left]! + (source[left + 1]! - source[left]!) * fraction);
      position += ratio;
    }
    const consumed = Math.min(Math.floor(position), source.length - 1);
    this.#carry = source.slice(Math.max(0, consumed));
    this.#position = position - Math.max(0, consumed);
    return out.length ? Float32Array.from(out) : new Float32Array(0);
  }
  clear(): void { this.#carry = new Float32Array(0); this.#position = 0; }
}

export interface VoiceInputSessionOptions {
  readonly inputSessionId: string;
  readonly generation: number;
  /** The rate the device actually produced; always reported as-is on every frame. */
  readonly sampleRate: number;
  readonly sink: VoiceFrameSink;
  /** Normalized rate required by the recognizer; stateful resampling when it differs. */
  readonly targetSampleRate?: number;
  readonly finishTimeoutMs?: number;
  readonly maxUtteranceMs?: number;
  readonly onBackpressure?: () => void;
}

/** One input session: index accounting, in-flight backpressure, the 120 s ceiling and a bounded finish. */
export class VoiceInputSession {
  readonly inputSessionId: string;
  readonly #aggregator = new PcmFrameAggregator();
  readonly #resampler: StatefulResampler;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #waiters: (() => void)[] = [];
  #index = 0;
  #samples = 0;
  #closed = false;
  #finishing = false;
  #failure: Error | undefined;
  constructor(private readonly options: VoiceInputSessionOptions) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.inputSessionId)) throw new Error('Invalid voice input session');
    if (!Number.isSafeInteger(options.sampleRate) || options.sampleRate < 8000 || options.sampleRate > 192000) throw new Error('Invalid capture sample rate');
    this.inputSessionId = options.inputSessionId;
    this.#resampler = new StatefulResampler(options.sampleRate, options.targetSampleRate ?? options.sampleRate);
  }
  get capturedSamples(): number { return this.#aggregator.capturedSamples; }
  get framesSent(): number { return this.#index; }
  get framesInFlight(): number { return this.#inFlight.size; }

  #start(pcm: Uint8Array): void {
    const index = this.#index++;
    const header: VoiceFrameHeader = { inputSessionId: this.inputSessionId, generation: this.options.generation, index,
      sampleRate: this.options.sampleRate, sampleCount: pcm.length / 2 };
    const job = this.options.sink.push(header, pcm).then(
      () => { this.#inFlight.delete(job); this.#settled(); },
      error => { this.#inFlight.delete(job); this.#failure ??= error instanceof Error ? error : new Error('Voice frame failed'); this.#settled(); });
    this.#inFlight.add(job);
  }

  /** Wakes every waiter blocked on a free in-flight slot; a refusal must release the producer too. */
  #settled(): void {
    for (const wake of this.#waiters.splice(0)) wake();
  }

  /** Waits until one in-flight frame settles; a rejection is reported through the latched failure. */
  async #awaitSlot(): Promise<void> {
    await new Promise<void>(resolve => {
      this.#waiters.push(resolve);
      Promise.race(this.#inFlight).then(() => {}, () => {});
    });
  }

  /** Feeds 2048-sample worklet flushes; throws when the whole-utterance ceiling is exceeded. */
  async push(block: Float32Array): Promise<void> {
    if (this.#closed) return;
    if (this.#finishing) throw new Error('Voice input session is already finishing');
    if (this.#samples + block.length > Math.round((this.options.maxUtteranceMs ?? VOICE_MAX_UTTERANCE_MS) / 1000 * this.options.sampleRate)) {
      this.#closed = true;
      throw new Error('Voice recording exceeded the 120 second limit');
    }
    this.#samples += block.length;
    for (const frame of this.#aggregator.push(this.#resampler.push(block))) {
      if (this.#failure) throw this.#failure;
      while (this.#inFlight.size >= VOICE_MAX_FRAMES_IN_FLIGHT) {
        this.options.onBackpressure?.();
        await this.#awaitSlot();
        if (this.#failure) throw this.#failure;
      }
      this.#start(frame);
    }
    // A frame that failed while it was the last one in flight must still surface to the recorder.
    if (this.#failure) throw this.#failure;
  }

  /** Flushes the tail, waits for every in-flight acknowledgement, then the bounded final result. */
  async finish(): Promise<void> {
    if (this.#closed) return;
    if (this.#finishing) throw new Error('Voice input session is already finishing');
    this.#finishing = true;
    await this.#awaitBounded(this.#flushAndSettle());
  }

  async #flushAndSettle(): Promise<void> {
    const tail = this.#aggregator.takeTail();
    if (tail) {
      const frames = [tail];
      for (const frame of frames) {
        while (this.#inFlight.size >= VOICE_MAX_FRAMES_IN_FLIGHT) await this.#awaitSlot();
        this.#start(frame);
      }
    }
    // allSettled: a failed frame must reach the caller, not become an unhandled rejection.
    await Promise.allSettled([...this.#inFlight]);
    if (this.#failure) throw this.#failure;
    this.#closed = true;
    await this.options.sink.finish({ inputSessionId: this.inputSessionId, generation: this.options.generation, sampleRate: this.options.sampleRate });
  }

  /** Cancels without waiting: local audio is dropped and nothing further is emitted. */
  cancel(): void {
    this.#closed = true;
    this.#aggregator.clear(); this.#resampler.clear();
    this.#settled();
  }

  async #awaitBounded(pending: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Voice recognition finish timed out')), this.options.finishTimeoutMs ?? VOICE_FINISH_TIMEOUT_MS);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

/** The bridge labels of one authorized voice turn; the turn scope stays the backend authority. */
export function voiceTurnLabels(scope: TurnScope): { inputSessionId: string; generation: number } {
  return { inputSessionId: scope.turnId, generation: scope.generation };
}
