// FIX61-08 08-C/08-E production composition: the receiving half of the live voice leg for one
// authorized turn. The renderer already aggregated the recorder's 2048-sample flushes into 100 ms
// PCM16 mono frames; this class is the VoiceFrameSink the device bridge hands each accepted
// voice_chunk to, which is what makes the bridge acknowledgement mean "this frame is in the
// recognizer". It never submits: release only resolves the verified transcript, and the caller
// submits it through its own authoritative TurnController/Scope.
import { NextSpeechInput } from './speech-bridge.js';
import { LiveVoiceBridge } from './live-voice-bridge.js';
import { StatefulResampler, VOICE_FRAME_MAX_SAMPLES, VOICE_MAX_UTTERANCE_MS } from '../media/voice-input-session.js';
import type { VoiceFrameHeader, VoiceFrameSink } from '../media/voice-input-session.js';
import type { SherpaStreamingAsr } from '../providers/sherpa-streaming-asr.js';
import type { TurnScope } from '../contracts/index.js';

export interface LiveVoicePorts {
  /** The recognizer; the runtime owns its lifetime. Absent keeps the batch path in charge. */
  readonly asr?: Pick<SherpaStreamingAsr, 'openStream' | 'push' | 'finish' | 'cancel' | 'subscribe'>;
  /** Live partial text for the UI. Never persisted. */
  readonly onInterim?: (scope: TurnScope, text: string) => void;
  readonly onError?: (scope: TurnScope, error: unknown) => void;
  /** The rate the recognizer needs; the frame's captured rate is reported as-is and resampled here. */
  readonly sampleRate?: number;
  readonly maxUtteranceMs?: number;
}

export type LiveVoiceFinish = { readonly type: 'finished'; readonly transcript: string } | { readonly type: 'cancelled' };

/**
 * One live utterance. Frames arrive through the device bridge in capture order; every accepted frame
 * is resampled once (statefully, so the phase carries across frames) to the recognizer's rate.
 */
export class LiveVoiceTurn implements VoiceFrameSink {
  readonly #bridge: LiveVoiceBridge;
  readonly #input: NextSpeechInput;
  readonly #targetRate: number;
  #resampler: StatefulResampler | undefined;
  #sourceRate = 0;
  #samples = 0;
  #outcome: Promise<LiveVoiceFinish> | undefined;
  #started = false;
  #failure: Error | undefined;
  #closed = false;

  constructor(readonly scope: TurnScope, private readonly ports: LiveVoicePorts) {
    if (!ports.asr) throw new Error('Live voice requires the local streaming recognizer');
    this.#targetRate = ports.sampleRate ?? 16000;
    // The bridge accumulates final text here; submission is the caller's single responsibility.
    this.#input = new NextSpeechInput(async () => { throw new Error('The live voice bridge never submits by itself'); });
    this.#bridge = new LiveVoiceBridge({ asr: ports.asr, input: this.#input,
      ...(ports.onInterim ? { onInterim: ports.onInterim } : {}), ...(ports.onError ? { onError: ports.onError } : {}) });
  }

  /** Opens the recognizer stream for this turn. The sink is already bound to this scope by the caller. */
  async start(): Promise<void> {
    if (this.#started) throw new Error('Live voice turn already started');
    this.#started = true;
    await this.#bridge.start(this.scope, this.#targetRate);
  }

  /** One accepted 100 ms frame from the bridge; resolves once the recognizer took the audio. */
  async push(header: VoiceFrameHeader, pcm: Uint8Array): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (this.#closed) return;
    if (header.inputSessionId !== this.scope.turnId || header.generation !== this.scope.generation) throw new Error('Voice frame does not belong to this turn');
    if (!pcm.length || pcm.length % 2 || header.sampleCount > VOICE_FRAME_MAX_SAMPLES) throw new Error('Invalid voice frame');
    const samples = pcm.length / 2;
    if (this.#samples + samples > Math.round((this.ports.maxUtteranceMs ?? VOICE_MAX_UTTERANCE_MS) / 1000 * header.sampleRate)) {
      this.#failure = new Error('Voice recording exceeded the 120 second limit');
      this.#closed = true;
      this.ports.onError?.(this.scope, this.#failure);
      throw this.#failure;
    }
    this.#samples += samples;
    try { await this.#bridge.push(this.#resample(header, pcm), this.#targetRate); }
    catch (error) { this.#failure = error instanceof Error ? error : new Error('Live recognition failed'); throw this.#failure; }
  }

  /** The release is a command, not a frame; the recognizer flush happens in release(). */
  async finish(): Promise<void> { /* Nothing to answer: the capture side owns the release. */ }

  /** Converts one PCM16 frame to the recognizer's rate, keeping the resampler phase across frames. */
  #resample(header: VoiceFrameHeader, pcm: Uint8Array): Uint8Array {
    if (header.sampleRate === this.#targetRate) return pcm;
    if (!this.#resampler || this.#sourceRate !== header.sampleRate) {
      this.#resampler = new StatefulResampler(header.sampleRate, this.#targetRate);
      this.#sourceRate = header.sampleRate;
    }
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const input = new Float32Array(pcm.length / 2);
    for (let i = 0; i < input.length; i++) input[i] = view.getInt16(i * 2, true) / 32768;
    const output = this.#resampler.push(input);
    const out = new Uint8Array(output.length * 2);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < output.length; i++) {
      const clamped = Math.max(-1, Math.min(1, output[i]!));
      outView.setInt16(i * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
    }
    return out;
  }

  /** The live text of the current utterance; display only. */
  liveText(): string { return this.#input.liveText(); }

  /** Latency instrumentation of this utterance (first partial / last final). */
  stats(): ReturnType<LiveVoiceBridge['stats']> { return this.#bridge.stats(); }

  /** Release: flush the recognizer, wait for the bounded final result, return the transcript. */
  release(signal: AbortSignal): Promise<LiveVoiceFinish> {
    this.#outcome ??= (async (): Promise<LiveVoiceFinish> => {
      this.#closed = true;
      if (this.#failure) throw this.#failure;
      try { await this.#bridge.finish(this.scope, signal); }
      catch (error) { this.ports.onError?.(this.scope, error); throw error; }
      const text = this.#input.liveText().trim();
      // Releasing the key with no recognized text is an empty utterance, not a turn.
      return text ? { type: 'finished', transcript: text } : { type: 'cancelled' };
    })();
    return this.#outcome;
  }

  /** Cancels: recognizer stream and uncommitted text are dropped. */
  async cancel(): Promise<void> {
    this.#closed = true;
    this.#input.cancel();
    await this.#bridge.cancel();
  }
}
