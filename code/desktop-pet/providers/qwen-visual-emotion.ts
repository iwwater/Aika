import { MAX_CAPTURE_IMAGES, type MediaStorePort, type PerceivedEmotion, type VisualPerceptionInput,
  type VisualPerceptionProvider, type VisualPerceptionResult } from '../contracts/index.js';
import { abortable, checkAbort } from '../media/scope.js';
import { isOmniEmotion, type OmniEmotion } from './omni-seven-emotion.js';
import { parseModelJson, ProviderTransport, type EndpointConfig } from './transport.js';

export const VISUAL_EMOTION_PROMPT = '仅根据提供的本轮图像，判断人物可见表情所属情绪：neutral、happy、sad、angry、fearful、disgusted、surprised。只返回一个JSON对象，仅含emotion字段；没有可判断的人脸或表情时emotion为null。不要转录、翻译、描述画面、推断声音或输出其他字段。';
const mapped: Record<OmniEmotion, PerceivedEmotion> = {
  neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry', fearful: 'fear', disgusted: 'disgust', surprised: 'surprise',
};
export function parseVisualEmotion(text: unknown): PerceivedEmotion | undefined {
  if (typeof text !== 'string') throw Error('Visual emotion response text required');
  const value = parseModelJson(text);
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'emotion') || (value.emotion !== null && !isOmniEmotion(value.emotion))) throw Error('Invalid visual emotion response');
  return value.emotion === null ? undefined : mapped[value.emotion as OmniEmotion];
}
export class QwenVisualEmotionProvider implements VisualPerceptionProvider {
  private readonly config: EndpointConfig;
  constructor(config: EndpointConfig, private readonly store: MediaStorePort,
    private readonly transport: Pick<ProviderTransport, 'request'> = new ProviderTransport()) {
    this.config = Object.freeze({ ...config });
    if (!/^qwen3\.5-omni-(flash|plus)(-\d{4}-\d{2}-\d{2})?$/.test(config.model)) throw Error('Visual provider requires Qwen3.5-Omni');
  }
  async perceive(input: VisualPerceptionInput, signal: AbortSignal): Promise<VisualPerceptionResult> {
    checkAbort(signal);
    const scope = Object.freeze({ ...input.scope }), images = input.images.map(image => Object.freeze({ ...image }));
    if (images.length > MAX_CAPTURE_IMAGES) throw Error('Visual input exceeds three actual frames');
    if (!images.length) return { scope, status: 'partial', modalities: [{ modality: 'image', status: 'missing', inputIds: [] }] };
    const content: unknown[] = [];
    for (const image of images) {
      if (!['image/jpeg', 'image/png'].includes(image.mimeType)) throw Error('Unsupported visual image');
      const bytes = await this.store.read(scope, image);
      try {
        checkAbort(signal);
        const encoded = Buffer.from(bytes).toString('base64');
        if (encoded.length >= 10 * 1024 * 1024) throw Error('Visual inline media limit exceeded');
        content.push({ type: 'image_url', image_url: { url: 'data:' + image.mimeType + ';base64,' + encoded } });
      } finally { bytes.fill(0); }
    }
    content.push({ type: 'text', text: VISUAL_EMOTION_PROMPT });
    const raw = await abortable(this.transport.request(this.config, scope, 'perception', {
      messages: [{ role: 'user', content }], stream: true, stream_options: { include_usage: true }, modalities: ['text'],
    }, signal), signal);
    checkAbort(signal); const emotion = parseVisualEmotion(raw.text);
    return { scope, ...(emotion === undefined ? {} : { emotion }), status: emotion === undefined ? 'partial' : 'complete',
      modalities: [{ modality: 'image', status: 'used', inputIds: images.map(image => image.id),
        detail: 'Visual-only model received these frames; expression classification is a prediction.' }] };
  }
}
