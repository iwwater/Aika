import type { MediaStorePort, TtsProvider, TtsRequest, TtsResult } from '../contracts/index.js';
import { checkAbort } from '../media/scope.js';
import { inspectPcmWav, joinPcmWav } from '../media/wav.js';
import { audioDownloadUrl, billedCharacters, splitSpeech } from './qwen-tts.js';
import { type EndpointConfig, object, ProviderTransport, string } from './transport.js';
import { assertRegisteredVoiceBinding, type RegisteredVoiceBinding } from './registered-voices.js';

export interface QwenAudioTtsConfig extends EndpointConfig {
  voice: string;
  credentialRef?: string;
  registeredVoice?: RegisteredVoiceBinding;
  languageHints?: readonly ['zh'];
}
export const QWEN_AUDIO_TTS_MODEL = 'qwen-audio-3.0-tts-flash';
export const QWEN_AUDIO_TTS_PLUS_MODEL = 'qwen-audio-3.0-tts-plus';
export const QWEN_AUDIO_TTS_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
export const QWEN_AUDIO_TTS_VOICES = ['longanfengyue', 'longanlingxi'] as const;
export const isQwenAudioTtsModel = (model: string): boolean => model === QWEN_AUDIO_TTS_MODEL || model === QWEN_AUDIO_TTS_PLUS_MODEL;
const supportedVoice = (model: string, voice: string): boolean => model === QWEN_AUDIO_TTS_PLUS_MODEL
  ? voice === 'longanlingxin' : model === QWEN_AUDIO_TTS_MODEL && QWEN_AUDIO_TTS_VOICES.some(value => value === voice);

/** The completed QwenAudio HTTP response can retain this exact streaming length
 * pair. Repair only its canonical mono PCM header; arbitrary truncation remains
 * an error in inspectPcmWav. Audio samples are never changed or resampled. */
export function normalizeQwenAudioWav(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 46) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, value: string) => [...value].every((char, i) => bytes[offset + i] === char.charCodeAt(0));
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE') || !tag(12, 'fmt ') || !tag(36, 'data')
    || view.getUint32(4, true) !== 0x7fffffbf || view.getUint32(40, true) !== 0x7fffff9b
    || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
    || view.getUint32(24, true) !== 24000 || view.getUint32(28, true) !== 48000
    || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || (bytes.length - 44) % 2) return bytes;
  const normalized = new Uint8Array(bytes), output = new DataView(normalized.buffer, normalized.byteOffset, normalized.byteLength);
  output.setUint32(4, bytes.length - 8, true); output.setUint32(40, bytes.length - 44, true);
  return normalized;
}

/** Beijing HTTP WAV adapter; reviewed system voices or exact locally registered bindings.
 * Provider enrollment and credential-to-key resolution remain owned by the host. */
export class QwenAudioTtsProvider implements TtsProvider {
  private readonly config: QwenAudioTtsConfig;
  constructor(config: QwenAudioTtsConfig, private readonly store: MediaStorePort,
    private readonly transport = new ProviderTransport()) {
    if (config.languageHints !== undefined && (!config.registeredVoice || !Array.isArray(config.languageHints)
      || config.languageHints.length !== 1 || config.languageHints[0] !== 'zh')) throw new Error('Registered QwenAudio voice with explicit zh language hint required');
    this.config = Object.freeze({ ...config, ...(config.languageHints ? { languageHints: Object.freeze(['zh'] as const) } : {}) });
    if (!isQwenAudioTtsModel(config.model) || config.endpoint !== QWEN_AUDIO_TTS_ENDPOINT) throw new Error('Explicit reviewed QwenAudio model and endpoint required');
    if (config.registeredVoice) this.checkRegisteredVoice(config.registeredVoice.voiceId);
    this.checkVoice(config.voice, true);
  }
  private checkRegisteredVoice(voiceId: string): void {
    assertRegisteredVoiceBinding(this.config.registeredVoice, { voiceId, provider: 'dashscope', endpoint: this.config.endpoint,
      targetModel: this.config.model, credentialRef: this.config.credentialRef ?? '' });
  }
  private checkVoice(voice: string, configuration = false): void {
    if (supportedVoice(this.config.model, voice)) return;
    try { this.checkRegisteredVoice(voice); }
    catch { throw new Error(configuration ? 'Explicit reviewed QwenAudio system voice or registered binding required' : 'Unreviewed QwenAudio voice binding'); }
  }
  async synthesize(input: TtsRequest, signal: AbortSignal): Promise<TtsResult> {
    checkAbort(signal);
    if (!input.text.trim()) throw new Error('Cannot synthesize empty reply');
    const scope = Object.freeze({ ...input.scope });
    const expression = structuredClone(input.expression);
    const voice = input.voiceId ?? this.config.voice;
    this.checkVoice(voice);
    const languageHints = supportedVoice(this.config.model, voice) ? undefined : this.config.languageHints;
    const instruction = expression.delivery || `用${expression.emotion}的情绪自然表达。`;
    // Local request bound, not an assertion of the supplier's undocumented instruction maximum.
    if (Buffer.byteLength(instruction, 'utf8') > 1600) throw new Error('QwenAudio instruction exceeds its reviewed bound');
    const clips: Uint8Array[] = [];
    try {
      for (const text of splitSpeech(input.text)) {
        checkAbort(signal);
        // Billing rules for this model are text Han=2/other=1; usage.characters is authoritative.
        const raw = await this.transport.request(this.config, scope, 'tts', { input: {
          text, voice, format: 'wav', sample_rate: 24000, instruction,
          ...(languageHints ? { language_hints: languageHints } : {}),
        } }, signal, billedCharacters(text));
        checkAbort(signal);
        const output = object(raw.output);
        if (output.finish_reason !== 'stop') throw new Error('QwenAudio synthesis did not complete');
        const downloaded = await this.transport.downloadAudio(audioDownloadUrl(string(object(output.audio).url)), signal);
        const bytes = normalizeQwenAudioWav(downloaded);
        if (bytes !== downloaded) downloaded.fill(0);
        clips.push(bytes);
        checkAbort(signal);
        const wav = inspectPcmWav(bytes);
        if (wav.sampleRate !== 24000 || wav.channels !== 1) throw new Error('Unexpected QwenAudio WAV format');
      }
      const bytes = joinPcmWav(clips); checkAbort(signal);
      const durationMs = inspectPcmWav(bytes).durationMs;
      const audio = await this.store.put(scope, bytes, 'audio/wav');
      try { checkAbort(signal); } catch (error) { await this.store.releaseScope(scope); throw error; }
      return { scope, audio, expression, durationMs, synchronization: 'amplitude' };
    } finally { clips.forEach(clip => clip.fill(0)); }
  }
}
