// FIX61-08 08-D: local sherpa-onnx streaming ASR adapter. The recognizer itself runs in a worker
// thread (see sherpa-streaming-asr-worker.ts) so decoding never blocks the Node main event loop.
// Model paths, tokens and decode parameters are configuration; no model-name whitelist is applied.
// This is the real streaming path — the Qwen provider stays separate and keeps its batch label.
import { Worker } from 'node:worker_threads';
import type { AsrSegment } from '../core/speech-bridge.js';
import type { TurnScope } from '../contracts/index.js';

/** The rate the recognizer's feature extractor expects; captured audio is resampled to it. */
export const SHERPA_STREAMING_SAMPLE_RATE = 16000;
/** Trailing silence appended on finish so the last encoder window can emit its words. */
export const SHERPA_TAIL_PADDING_SEC = 0.3;

export interface SherpaStreamingAsrConfig {
  readonly encoder: string;
  readonly decoder: string;
  readonly joiner: string;
  readonly tokens: string;
  readonly modelType?: string;
  readonly numThreads?: number;
  readonly provider?: string;
  readonly decodingMethod?: string;
  readonly hotwordsFile?: string;
  readonly hotwordsScore?: number;
  readonly rule1MinTrailingSilence?: number;
  readonly rule2MinTrailingSilence?: number;
  readonly tailPaddingSec?: number;
  /** Overridable for tests; the default loads './sherpa-streaming-asr-worker.js'. */
  readonly workerUrl?: URL;
  readonly openTimeoutMs?: number;
  readonly callTimeoutMs?: number;
}

export type StreamingAsrEvent =
  | { readonly scope: TurnScope; readonly type: 'partial'; readonly segment: AsrSegment }
  | { readonly scope: TurnScope; readonly type: 'final'; readonly segment: AsrSegment }
  | { readonly scope: TurnScope; readonly type: 'error'; readonly error: unknown };

/** The recognizer configuration handed to the worker; exposed so tests can pin the real mapping. */
export function sherpaRecognizerConfig(config: SherpaStreamingAsrConfig): Record<string, unknown> {
  return {
    featConfig: { sampleRate: SHERPA_STREAMING_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: config.encoder, decoder: config.decoder, joiner: config.joiner },
      tokens: config.tokens,
      numThreads: config.numThreads ?? 2,
      provider: config.provider ?? 'cpu',
      debug: 0,
      modelType: config.modelType ?? 'zipformer',
    },
    decodingMethod: config.decodingMethod ?? 'greedy_search',
    maxActivePaths: 4,
    ...(config.hotwordsFile ? { hotwordsFile: config.hotwordsFile, hotwordsScore: config.hotwordsScore ?? 1.5 } : {}),
    enableEndpoint: true,
    rule1MinTrailingSilence: config.rule1MinTrailingSilence ?? 2.4,
    rule2MinTrailingSilence: config.rule2MinTrailingSilence ?? 1.2,
    rule3MinUtteranceLength: 20,
  };
}

interface VoiceStream {
  readonly scope: TurnScope;
  readonly key: string;
  readonly workerId: number;
  /** Highest revision already published per segment; a final segment is never revised. */
  readonly revisions: Map<number, number>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const streamKey = (scope: TurnScope): string => `${scope.characterId}:${scope.sessionId}:${scope.turnId}:${scope.generation}`;

/**
 * Only flags a worker may legally inherit. The harness runs the tests under NODE_OPTIONS, whose
 * entries appear in process.execArgv and are rejected by new Worker(); forwarding them unchanged
 * would make the recognizer unspawnable in every instrumented process.
 */
const WORKER_EXEC_ARGV = /^--(experimental-[a-z0-9-]+|no-warnings|enable-source-maps|max-old-space-size=\d+|stack-size=\d+|trace-warnings)$/;
const workerExecArgv = (): string[] => process.execArgv.filter(arg => WORKER_EXEC_ARGV.test(arg));

/**
 * One recognizer, one worker, one stream per authorized input session. push() is called for every
 * captured frame; finish() is called when the user releases the key and is bounded by the caller.
 */
export class SherpaStreamingAsr {
  readonly #config: SherpaStreamingAsrConfig;
  readonly #pending = new Map<number, Pending>();
  readonly #streams = new Map<string, VoiceStream>();
  readonly #listeners = new Set<(event: StreamingAsrEvent) => void>();
  #worker: Worker | undefined;
  #ready: Promise<void>;
  #closed = false;
  #failed: Error | undefined;
  #sequence = 0;
  #streamId = 0;

  constructor(config: SherpaStreamingAsrConfig) {
    for (const [name, value] of Object.entries({ encoder: config.encoder, decoder: config.decoder, joiner: config.joiner, tokens: config.tokens })) {
      if (typeof value !== 'string' || !value.length) throw new Error(`Streaming ASR requires a configured ${name} path`);
    }
    this.#config = Object.freeze({ ...config });
    this.#ready = this.#open();
    // A failed background open must not become an unhandled rejection before the first call.
    void this.#ready.catch(() => {});
  }

  /** Partial/final/error events of every open stream. Register before openStream(). */
  subscribe(listener: (event: StreamingAsrEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async #open(): Promise<void> {
    const worker = new Worker(this.#config.workerUrl ?? new URL('./sherpa-streaming-asr-worker.js', import.meta.url), {
      workerData: { config: sherpaRecognizerConfig(this.#config), tailPaddingSec: this.#config.tailPaddingSec ?? SHERPA_TAIL_PADDING_SEC },
      stdout: true, stderr: true, execArgv: workerExecArgv(),
    });
    this.#worker = worker;
    worker.stdout.resume(); worker.stderr.resume();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Streaming ASR initialization timed out')), this.#config.openTimeoutMs ?? 30_000);
      worker.once('message', (message: { ready?: boolean; failed?: boolean }) => {
        clearTimeout(timer);
        if (message.ready) resolve(); else reject(new Error('Local streaming ASR model failed to load'));
      });
      worker.once('error', () => { clearTimeout(timer); reject(new Error('Local streaming ASR worker failed')); });
    });
    worker.on('message', message => this.#receive(message));
    worker.on('error', () => this.#failAll(new Error('Local streaming ASR worker failed')));
    worker.on('exit', () => { if (!this.#closed) this.#failAll(new Error('Local streaming ASR worker exited')); });
  }

  #receive(message: { id?: number; streamId?: number; failed?: boolean; type?: string; text?: string; segmentId?: string; index?: number; revision?: number; audioEndMs?: number }): void {
    if (message.type === 'partial' || message.type === 'final') {
      const stream = [...this.#streams.values()].find(value => value.workerId === message.streamId);
      if (stream) this.#deliver(stream, message.type, message);
      return;
    }
    if (message.id === undefined) return;
    const call = this.#pending.get(message.id);
    if (!call) return;
    this.#pending.delete(message.id); clearTimeout(call.timer);
    if (message.failed) call.reject(new Error('Local streaming ASR processing failed'));
    else call.resolve(message);
  }

  #deliver(stream: VoiceStream, type: 'partial' | 'final', message: { text?: string; segmentId?: string; index?: number; revision?: number; audioEndMs?: number }): void {
    const index = message.index ?? 0;
    const revision = message.revision ?? 0;
    const previous = stream.revisions.get(index) ?? 0;
    // A final snapshot is immutable and a stale revision never overwrites newer text.
    if (revision <= previous) return;
    stream.revisions.set(index, revision);
    const segment: AsrSegment = { inputSessionId: stream.scope.turnId, segmentId: message.segmentId ?? String(index), index,
      text: String(message.text ?? ''), audioEndMs: message.audioEndMs ?? 0, timeSource: 'audio', revision };
    this.#emit({ scope: stream.scope, type, segment });
  }

  #emit(event: StreamingAsrEvent): void { for (const listener of [...this.#listeners]) listener(event); }

  #failAll(error: Error): void {
    this.#closed = true; this.#failed = error;
    for (const call of this.#pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.#pending.clear();
    for (const stream of [...this.#streams.values()]) this.#emit({ scope: stream.scope, type: 'error', error });
    this.#streams.clear();
  }

  #call(type: string, data: Record<string, unknown>): Promise<unknown> {
    if (this.#failed) return Promise.reject(this.#failed);
    if (this.#closed || !this.#worker) return Promise.reject(new Error('Streaming ASR is closed'));
    const id = ++this.#sequence;
    const worker = this.#worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('Local streaming ASR call timed out')); }, this.#config.callTimeoutMs ?? 15_000);
      this.#pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ type, id, ...data }); }
      catch (error) { this.#pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error('Local streaming ASR write failed')); }
    });
  }

  /** Opens one stream per authorized input session; a second open for the same scope is refused. */
  async openStream(scope: TurnScope, sampleRate: number): Promise<void> {
    await this.#ready;
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Invalid voice sample rate');
    const key = streamKey(scope);
    if (this.#streams.has(key)) throw new Error('Voice stream already open for this turn');
    const workerId = ++this.#streamId;
    await this.#call('open', { streamId: workerId, sampleRate });
    this.#streams.set(key, { scope: Object.freeze({ ...scope }), key, workerId, revisions: new Map() });
  }

  /** Feeds one PCM16 mono frame; the bytes are copied for transfer and not retained here. */
  async push(scope: TurnScope, pcm: Uint8Array, sampleRate: number): Promise<void> {
    const stream = this.#streams.get(streamKey(scope));
    if (!stream) throw new Error('Voice stream is not open for this turn');
    if (!pcm.length || pcm.length % 2) throw new Error('Invalid voice frame length');
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('Invalid voice sample rate');
    const copy = new Int16Array(pcm.length / 2);
    new Uint8Array(copy.buffer).set(pcm);
    await this.#call('push', { streamId: stream.workerId, samples: copy, sampleRate });
  }

  /** Flushes the tail and publishes the final segment. Bounded by the caller's finish deadline. */
  async finish(scope: TurnScope): Promise<void> {
    const stream = this.#streams.get(streamKey(scope));
    if (!stream) return;
    try { await this.#call('finish', { streamId: stream.workerId }); }
    finally { this.#streams.delete(stream.key); }
  }

  /** Drops the stream without publishing anything further; no old session continues in a new one. */
  async cancel(scope: TurnScope): Promise<void> {
    const stream = this.#streams.get(streamKey(scope));
    if (!stream) return;
    this.#streams.delete(stream.key);
    try { await this.#call('cancel', { streamId: stream.workerId }); } catch { /* The stream is being dropped anyway. */ }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const worker = this.#worker; this.#worker = undefined;
    this.#streams.clear(); this.#listeners.clear();
    for (const call of this.#pending.values()) { clearTimeout(call.timer); call.reject(new Error('Streaming ASR closed')); }
    this.#pending.clear();
    if (worker) await worker.terminate().catch(() => {});
  }
}
