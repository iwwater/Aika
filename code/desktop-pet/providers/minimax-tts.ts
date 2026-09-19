import type { MediaStorePort, TtsProvider, TtsRequest, TtsResult } from '../contracts/index.js';
import { setTimeout as pause } from 'node:timers/promises';
import { checkAbort } from '../media/scope.js';
import { inspectPcmWav, joinPcmWav } from '../media/wav.js';
import { splitSpeech } from './qwen-tts.js';
import { assertRegisteredVoiceBinding, type RegisteredVoiceBinding } from './registered-voices.js';
import { type EndpointConfig, type JsonRecord, object, ProviderTransport, ProviderHttpError } from './transport.js';

export const MINIMAX_TTS_MODEL = 'MiniMax/speech-2.8-turbo';
export const MINIMAX_HD_TTS_MODEL = 'MiniMax/speech-2.8-hd';
export const MINIMAX_TTS_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export interface MiniMaxTtsConfig extends EndpointConfig {
  voice: string;
  credentialRef: string;
  registeredVoice: RegisteredVoiceBinding;
}

/** A conservative reservation bound, not the supplier's actual billable-character count. */
export function miniMaxCharacterUpperBound(text: string): number { return Buffer.byteLength(text, 'utf8'); }

function completedWav(raw: JsonRecord): Uint8Array {
  const output = object(raw.output), status = object(output.base_resp);
  if (status.status_code !== 0) throw new Error('MiniMax synthesis failed');
  const data = object(output.data);
  if (data.status !== 2) throw new Error('MiniMax synthesis did not complete');
  const hex = data.audio;
  // Buffer.from(hex) silently truncates malformed input, so validate the entire string first.
  if (typeof hex !== 'string' || !hex.length || hex.length % 2 || !/^[0-9a-fA-F]+$/.test(hex)) throw new Error('Invalid MiniMax audio hex');
  const decoded = Buffer.from(hex, 'hex'), bytes = new Uint8Array(decoded); decoded.fill(0);
  try {
    const wav = inspectPcmWav(bytes);
    if (new DataView(bytes.buffer).getUint32(4, true) + 8 !== bytes.length
      || wav.sampleRate !== 24000 || wav.channels !== 1) throw new Error('Unexpected MiniMax WAV format');
    if (output.extra_info !== undefined) {
      const extra = object(output.extra_info);
      if ((extra.audio_format !== undefined && extra.audio_format !== 'wav')
        || (extra.audio_sample_rate !== undefined && extra.audio_sample_rate !== 24000)
        || (extra.audio_channel !== undefined && extra.audio_channel !== 1)
        || (extra.audio_size !== undefined && extra.audio_size !== bytes.length)) throw new Error('MiniMax audio metadata differs from WAV');
    }
    return bytes;
  } catch (error) { bytes.fill(0); throw error; }
}

/** Only the registered DashScope 2.8 Turbo/HD pairings. Sync hex WAV uses existing scoped PCM
 * storage/amplitude playback; enrollment, first-use fee and actual key lookup stay in I.
 * Expression remains visual: omit voice emotion and never insert delivery into spoken text. */
export class MiniMaxTtsProvider implements TtsProvider {
  private readonly config: MiniMaxTtsConfig;
  constructor(config: MiniMaxTtsConfig, private readonly store: MediaStorePort, private readonly transport = new ProviderTransport()) {
    this.config = Object.freeze({ ...config });
    if ((config.model !== MINIMAX_TTS_MODEL && config.model !== MINIMAX_HD_TTS_MODEL)
      || config.endpoint !== MINIMAX_TTS_ENDPOINT) throw new Error('Explicit reviewed MiniMax 2.8 Turbo or HD model and endpoint required');
    this.checkVoice(config.voice);
  }
  private checkVoice(voiceId: string): void {
    assertRegisteredVoiceBinding(this.config.registeredVoice, { voiceId, provider: 'dashscope', endpoint: this.config.endpoint,
      targetModel: this.config.model, credentialRef: this.config.credentialRef });
  }
  async synthesize(input: TtsRequest, signal: AbortSignal): Promise<TtsResult> {
    checkAbort(signal);
    if (!input.text.trim()) throw new Error('Cannot synthesize empty reply');
    const scope = Object.freeze({ ...input.scope }), expression = structuredClone(input.expression);
    const voice = input.voiceId ?? this.config.voice; this.checkVoice(voice);
    const pieces = splitSpeech(input.text);
    const clips: Uint8Array[] = []; let joined: Uint8Array | undefined, storing = false;
    try {
      for (const text of pieces) {
        checkAbort(signal);
        let raw!: JsonRecord;
        // Only the current unplayed segment may recover once from a transient HTTP failure.
        for (let attempt = 0; attempt < 2; attempt++) {
          checkAbort(signal);
          try { raw = await this.transport.request(this.config, scope, 'tts', { input: {
          text, voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
          audio_setting: { sample_rate: 24000, format: 'wav', channel: 1 }, output_format: 'hex', language_boost: 'Chinese',
        } }, signal, miniMaxCharacterUpperBound(text)); break;
          } catch (error) {
            checkAbort(signal);
            if (attempt !== 0 || !(error instanceof ProviderHttpError) || ![500, 502, 503, 504].includes(error.status)) throw error;
            await pause(250, undefined, { signal });
          }
        }
        checkAbort(signal); clips.push(completedWav(raw));
      }
      joined = joinPcmWav(clips); checkAbort(signal);
      const durationMs = inspectPcmWav(joined).durationMs;
      storing = true; const audio = await this.store.put(scope, joined, 'audio/wav'); checkAbort(signal);
      return { scope, audio, expression, durationMs, synchronization: 'amplitude' };
    } catch (error) {
      if (storing) await this.store.releaseScope(scope);
      throw error;
    } finally { joined?.fill(0); clips.forEach(clip => clip.fill(0)); }
  }
}
