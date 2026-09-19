import type { CapturedInput, MediaStorePort, PerceivedEmotion, PerceptionProvider, PerceptionResult } from '../contracts/index.js';
import { checkAbort } from '../media/scope.js';
import { type EndpointConfig, ProviderTransport } from './transport.js';
import { omniEmotionRequest, parseOmniEmotion, type OmniEmotion } from './omni-seven-emotion.js';

// Retained constructor field for existing callers; the new class result has no cue lifetime.
export interface QwenPerceptionConfig extends EndpointConfig { cueLifetimeMs: number }
const productEmotion: Record<OmniEmotion, PerceivedEmotion> = {
  neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry', fearful: 'fear', disgusted: 'disgust', surprised: 'surprise',
};
export class QwenPerceptionProvider implements PerceptionProvider {
  private readonly config: QwenPerceptionConfig;
  constructor(config: QwenPerceptionConfig, private readonly store: MediaStorePort,
    private readonly transport: Pick<ProviderTransport, 'request'> = new ProviderTransport()) {
    this.config = Object.freeze({ ...config });
    if (!/^qwen3\.5-omni-(flash|plus)(-\d{4}-\d{2}-\d{2})?$/.test(config.model)) throw new Error('Combined audio/image requires Qwen3.5-Omni');
  }
  async perceive(input: CapturedInput, signal: AbortSignal): Promise<PerceptionResult> {
    checkAbort(signal);
    const captured = { ...input, scope: Object.freeze({ ...input.scope }), audio: { ...input.audio }, images: input.images.map(image => ({ ...image })) };
    const body = await omniEmotionRequest(captured, this.store, signal);
    const raw = await this.transport.request(this.config, captured.scope, 'perception', body, signal);
    checkAbort(signal); const parsed = parseOmniEmotion(raw.text);
    return { scope: captured.scope, transcript: parsed.transcript, emotion: productEmotion[parsed.emotion], cues: [],
      status: captured.images.length ? 'complete' : 'partial', modalities: [
        { modality: 'audio', status: 'used', inputIds: [captured.audio.id], detail: 'Supplied to model; utilization is not independently verified.' },
        { modality: 'image', status: captured.images.length ? 'used' : 'missing', inputIds: captured.images.map(image => image.id), detail: 'Input availability only, not proof of visual reasoning.' },
        { modality: 'text', status: 'not_requested', inputIds: [], detail: 'Transcript is generated from the supplied audio.' },
      ] };
  }
}
