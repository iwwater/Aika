import type { MediaStorePort, TtsProvider, TtsRequest, TtsResult } from '../contracts/index.js';
import { checkAbort } from '../media/scope.js';
import { inspectPcmWav, joinPcmWav } from '../media/wav.js';
import { EndpointConfig, object, ProviderTransport, string } from './transport.js';

/** API limit is per request; concatenating these parts recovers the exact original string. */
export function splitSpeech(text: string, maxCharacters = 600): string[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1) throw new Error('Invalid speech segment size');
  const chars = Array.from(text), result: string[] = [];
  for (let start = 0; start < chars.length;) {
    let end = Math.min(chars.length, start + maxCharacters);
    if (end < chars.length) for (let i = end - 1; i > start + maxCharacters / 2; i--) if (/[。！？.!?\n]/u.test(chars[i]!)) { end = i + 1; break; }
    result.push(chars.slice(start, end).join('')); start = end;
  }
  return result;
}
export function billedCharacters(text: string): number {
  return Array.from(text).reduce((total, char) => total + (/\p{Script=Han}/u.test(char) ? 2 : 1), 0);
}

export function audioDownloadUrl(uri: string): string {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new Error('Invalid provider audio URL'); }
  if (parsed.username || parsed.password) throw new Error('Invalid provider audio URL');
  if (parsed.protocol === 'https:') return uri;
  // Qwen returns signed HTTP URLs from DashScope OSS buckets. These same buckets
  // support HTTPS. Match the raw authority; never reserialize the signed suffix.
  const match = /^http:\/\/(dashscope-[a-z0-9-]+\.oss-cn-[a-z0-9-]+\.aliyuncs\.com)(?::80)?(\/[^\s\\#]*)$/i.exec(uri);
  if (!match || parsed.protocol !== 'http:' || parsed.port || parsed.hash || parsed.hostname !== match[1]!.toLowerCase()) throw new Error('Invalid provider audio URL');
  // An explicit HTTP :80 becomes the default HTTPS port, never TLS on port 80.
  return `https://${match[1]}${match[2]}`;
}

export interface QwenTtsConfig extends EndpointConfig { voice: string; language: string }
export class QwenTtsProvider implements TtsProvider {
  constructor(private readonly config: QwenTtsConfig, private readonly store: MediaStorePort, private readonly transport = new ProviderTransport()) {
    if (!/^qwen3-tts-instruct-flash(-\d{4}-\d{2}-\d{2})?$/.test(config.model) || !config.voice || !config.language) throw new Error('Explicit instruction-capable TTS model, language and test voice required');
  }
  async synthesize(input: TtsRequest, signal: AbortSignal): Promise<TtsResult> {
    checkAbort(signal);
    if (!input.text.trim()) throw new Error('Cannot synthesize empty reply');
    const clips: Uint8Array[] = [];
    try {
      for (const text of splitSpeech(input.text)) {
        checkAbort(signal);
        const raw = await this.transport.request(this.config, input.scope, 'tts', { input: { text, voice: input.voiceId ?? this.config.voice, language_type: this.config.language, instructions: input.expression.delivery || `用${input.expression.emotion}的情绪自然表达。`, optimize_instructions: false } }, signal, billedCharacters(text));
        checkAbort(signal);
        const audio = object(object(raw.output).audio);
        const bytes = await this.transport.downloadAudio(audioDownloadUrl(string(audio.url)), signal);
        checkAbort(signal); inspectPcmWav(bytes); clips.push(bytes);
      }
      const bytes = joinPcmWav(clips); checkAbort(signal);
      const audio = await this.store.put(input.scope, bytes, 'audio/wav');
      try { checkAbort(signal); } catch (error) { await this.store.releaseScope(input.scope); throw error; }
      return { scope: input.scope, audio, expression: input.expression, durationMs: inspectPcmWav(bytes).durationMs, synchronization: 'amplitude' };
    } finally { clips.forEach(clip => clip.fill(0)); }
  }
}
