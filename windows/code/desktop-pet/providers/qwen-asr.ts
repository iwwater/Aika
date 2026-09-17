import type { AsrInput, AsrProvider, AsrResult, MediaStorePort, PerceivedEmotion } from '../contracts/index.js';
import { abortable, checkAbort } from '../media/scope.js';
import { inspectPcmWav } from '../media/wav.js';
import { isOmniEmotion, type OmniEmotion } from './omni-seven-emotion.js';
import { object, ProviderTransport, type EndpointConfig, type JsonRecord } from './transport.js';

export const QWEN_ASR_MODEL = 'qwen3-asr-flash-2026-02-10';
const mapped: Record<OmniEmotion, PerceivedEmotion> = {
  neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry', fearful: 'fear', disgusted: 'disgust', surprised: 'surprise',
};
/** Optional annotations never repair, translate or invalidate the authoritative transcript. */
export function parseAsrResponse(raw: JsonRecord): Omit<AsrResult, 'scope'> {
  if (!Array.isArray(raw.choices) || raw.choices.length !== 1) throw Error('Invalid ASR completion');
  const choice = object(raw.choices[0]), message = object(choice.message);
  if (choice.finish_reason !== 'stop' || typeof message.content !== 'string') throw Error('Incomplete ASR transcript');
  const emotions = new Set<PerceivedEmotion>(), languages = new Set<string>();
  for (const value of Array.isArray(message.annotations) ? message.annotations : []) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'audio_info') continue;
    const emotion: unknown = value.emotion;
    if (isOmniEmotion(emotion)) emotions.add(mapped[emotion]);
    if (typeof value.language === 'string' && /^[a-z]{2,3}(?:-[a-zA-Z0-9]+)*$/.test(value.language)) languages.add(value.language);
  }
  return { transcript: message.content,
    ...(emotions.size === 1 ? { audioEmotion: [...emotions][0]! } : {}),
    ...(languages.size === 1 ? { language: [...languages][0]! } : {}) };
}
export class QwenAsrProvider implements AsrProvider {
  private readonly config: EndpointConfig;
  constructor(config: EndpointConfig, private readonly store: MediaStorePort,
    private readonly transport: Pick<ProviderTransport, 'request'> = new ProviderTransport()) {
    this.config = Object.freeze({ ...config });
    if (config.model !== QWEN_ASR_MODEL) throw Error('Explicit reviewed Qwen ASR snapshot required');
  }
  async transcribe(input: AsrInput, signal: AbortSignal): Promise<AsrResult> {
    checkAbort(signal);
    const scope = Object.freeze({ ...input.scope }), audio = Object.freeze({ ...input.audio });
    if (audio.mimeType !== 'audio/wav') throw Error('ASR requires PCM WAV audio');
    const bytes = await this.store.read(scope, audio);
    let body: JsonRecord, audioSeconds: number;
    try {
      checkAbort(signal); audioSeconds = inspectPcmWav(bytes).durationMs / 1000;
      const encoded = Buffer.from(bytes).toString('base64');
      if (encoded.length >= 10 * 1024 * 1024) throw Error('ASR inline media limit exceeded');
      // No system role, context, language override or translation instruction; retain mixed speech and number words.
      body = { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + encoded } }] }],
        stream: false, asr_options: { enable_itn: false } };
    } finally { bytes.fill(0); }
    const raw = await abortable(this.transport.request(this.config, scope, 'asr', body, signal, undefined, audioSeconds), signal);
    checkAbort(signal);
    return { scope, ...parseAsrResponse(raw) };
  }
}
