import { MAX_CAPTURE_IMAGES, type CapturedInput, type MediaStorePort } from '../contracts/index.js';
import { checkAbort } from '../media/scope.js';
import { inspectPcmWav } from '../media/wav.js';
import { parseModelJson, type JsonRecord } from './transport.js';

export const OMNI_SEVEN_EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'] as const;
export type OmniEmotion = typeof OMNI_SEVEN_EMOTIONS[number];
export interface OmniEmotionResponse { transcript: string; emotion: OmniEmotion }
export const OMNI_SEVEN_EMOTION_PROMPT = '请逐字转录音频，保留原语言。根据本段音频及提供的图像（如有），将说话者的整体情绪分类为neutral、happy、sad、angry、fearful、disgusted、surprised之一。只返回一个JSON对象，且仅包含transcript和emotion两个字段。transcript为逐字转录字符串，emotion为上述七个英文值之一。不要输出解释、依据、置信度或其他字段。';
export function isOmniEmotion(value: unknown): value is OmniEmotion {
  return typeof value === 'string' && (OMNI_SEVEN_EMOTIONS as readonly string[]).includes(value);
}
export function parseOmniEmotion(text: unknown): OmniEmotionResponse {
  if (typeof text !== 'string') throw new Error('Omni response text required');
  let parsed: JsonRecord;
  try { parsed = parseModelJson(text); } catch { throw new Error('Omni response must be a JSON object'); }
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes('transcript') || !keys.includes('emotion')
    || typeof parsed.transcript !== 'string' || !isOmniEmotion(parsed.emotion)) throw new Error('Invalid two-field Omni response');
  return { transcript: parsed.transcript, emotion: parsed.emotion };
}

/** Production accepts only actual frames available at release, including audio-only turns. */
export async function omniEmotionRequest(input: CapturedInput, store: MediaStorePort, signal: AbortSignal,
  maxOutputTokens?: number): Promise<JsonRecord> {
  checkAbort(signal);
  if (input.images.length > MAX_CAPTURE_IMAGES) throw new Error('Omni requires zero to three actual frames');
  return encodeOmniRequest(input, store, signal, maxOutputTokens);
}

/** Frozen public-sample evaluation only; never called by the production perception provider. */
export async function historicalNineFrameOmniRequest(input: CapturedInput, store: MediaStorePort, signal: AbortSignal,
  maxOutputTokens?: number): Promise<JsonRecord> {
  checkAbort(signal);
  if (![0, 9].includes(input.images.length)) throw new Error('Historical Omni evaluation requires zero or nine frames');
  return encodeOmniRequest(input, store, signal, maxOutputTokens);
}

/** Labels, filenames and expected transcripts never enter the model request. */
async function encodeOmniRequest(input: CapturedInput, store: MediaStorePort, signal: AbortSignal,
  maxOutputTokens?: number): Promise<JsonRecord> {
  checkAbort(signal);
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)) throw new Error('Invalid output token bound');
  if (input.audio.mimeType !== 'audio/wav') throw new Error('Omni requires WAV audio');
  const content: unknown[] = [];
  const encode = async (asset: CapturedInput['audio'], audio: boolean): Promise<string> => {
    const bytes = await store.read(input.scope, asset);
    try {
      checkAbort(signal); if (audio) inspectPcmWav(bytes);
      const encoded = Buffer.from(bytes).toString('base64');
      if (encoded.length >= 10 * 1024 * 1024) throw new Error('Omni inline media limit exceeded');
      return encoded;
    } finally { bytes.fill(0); }
  };
  content.push({ type: 'input_audio', input_audio: { data: 'data:;base64,' + await encode(input.audio, true), format: 'wav' } });
  for (const image of input.images) {
    if (!['image/jpeg', 'image/png'].includes(image.mimeType)) throw new Error('Unsupported Omni image');
    content.push({ type: 'image_url', image_url: { url: 'data:' + image.mimeType + ';base64,' + await encode(image, false) } });
  }
  checkAbort(signal); content.push({ type: 'text', text: OMNI_SEVEN_EMOTION_PROMPT });
  return { messages: [{ role: 'user', content }], stream: true, stream_options: { include_usage: true }, modalities: ['text'],
    ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }) };
}
