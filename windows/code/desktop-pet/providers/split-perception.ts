import { MAX_CAPTURE_IMAGES, type AsrProvider, type CapturedInput, type PerceivedEmotion, type PerceptionProvider,
  type PerceptionResult, type VisualPerceptionProvider, type VisualPerceptionResult } from '../contracts/index.js';
import { abortable, assertScope, checkAbort } from '../media/scope.js';

export interface SplitPerceptionOptions { readonly visualTimeoutMs: number }
const validEmotion = (value: unknown): value is PerceivedEmotion => typeof value === 'string'
  && ['neutral', 'happy', 'sad', 'angry', 'fear', 'disgust', 'surprise'].includes(value);
/** ASR owns text. Optional visual work has a deadline measured from parallel dispatch. */
export class SplitPerceptionProvider implements PerceptionProvider {
  private readonly visualTimeoutMs: number;
  constructor(private readonly asr: AsrProvider, private readonly visual: VisualPerceptionProvider,
    options: SplitPerceptionOptions) {
    if (!Number.isFinite(options.visualTimeoutMs) || options.visualTimeoutMs <= 0) throw Error('Explicit positive visual timeout required');
    this.visualTimeoutMs = options.visualTimeoutMs;
  }
  async perceive(input: CapturedInput, signal: AbortSignal): Promise<PerceptionResult> {
    checkAbort(signal);
    const scope = Object.freeze({ ...input.scope }), audio = Object.freeze({ ...input.audio });
    const images = Object.freeze(input.images.map(image => Object.freeze({ ...image })));
    if (images.length > MAX_CAPTURE_IMAGES) throw Error('Capture exceeds three actual frames');
    const asrAbort = new AbortController(), visualAbort = new AbortController();
    const cancel = () => { asrAbort.abort(); visualAbort.abort(); };
    signal.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unavailable = (status: 'missing' | 'failed'): VisualPerceptionResult => ({ scope, status: 'partial',
      modalities: [{ modality: 'image', status, inputIds: images.map(image => image.id),
        detail: status === 'missing' ? 'No frames available for this turn.' : 'Visual perception unavailable or timed out.' }] });
    try {
      if (images.length) timer = setTimeout(() => visualAbort.abort(), this.visualTimeoutMs);
      const asrWork = abortable(Promise.resolve().then(() => {
        checkAbort(asrAbort.signal); return this.asr.transcribe({ scope, audio }, asrAbort.signal);
      }), asrAbort.signal);
      const visualWork = images.length ? abortable(Promise.resolve().then(() => {
        checkAbort(visualAbort.signal); return this.visual.perceive({ scope, images }, visualAbort.signal);
      }), visualAbort.signal).then(result => {
        checkAbort(visualAbort.signal); assertScope(scope, result.scope);
        return result.status === 'failed' ? unavailable('failed') : result;
      }).catch(() => unavailable('failed')).finally(() => { clearTimeout(timer); })
        : Promise.resolve(unavailable('missing'));
      const recognized = await asrWork;
      checkAbort(signal); assertScope(scope, recognized.scope);
      if (typeof recognized.transcript !== 'string') throw Error('Invalid authoritative ASR transcript');
      const seen = await abortable(visualWork, signal); checkAbort(signal);
      const audioEmotion = validEmotion(recognized.audioEmotion) ? recognized.audioEmotion : undefined;
      const visualEmotion = validEmotion(seen.emotion) ? seen.emotion : undefined;
      const emotion = audioEmotion ?? visualEmotion;
      const imageStatus = seen.modalities.find(m => m.modality === 'image')?.status ?? 'failed';
      return { scope, transcript: recognized.transcript, cues: [],
        ...(emotion === undefined ? {} : { emotion }),
        ...(audioEmotion === undefined ? {} : { audioEmotion }),
        ...(visualEmotion === undefined ? {} : { visualEmotion }),
        status: seen.status === 'complete' ? 'complete' : 'partial', modalities: [
          { modality: 'audio', status: 'used', inputIds: [audio.id], detail: 'Dedicated ASR received audio; audio emotion is present only for a valid returned annotation.' },
          { modality: 'image', status: imageStatus, inputIds: images.map(image => image.id), detail: 'Visual-only prediction; no audio or transcript supplied.' },
          { modality: 'text', status: 'not_requested', inputIds: [], detail: 'Original text comes only from dedicated ASR.' },
        ] };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); cancel(); }
  }
}
