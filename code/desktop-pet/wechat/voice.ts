import { createDecipheriv } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { WeChatVoiceItem } from './api.js';

// Wire conventions: Tencent/openclaw-weixin 7c04adc, docs/protocol.md and src/cdn/.
const CDN = 'https://novac2c.cdn.weixin.qq.com';
export const WECHAT_VOICE_LIMITS = Object.freeze({ downloadBytes: 2 * 1024 * 1024, durationMs: 120_000, timeoutMs: 15_000, sampleRate: 24_000, pcmBytes: 5_760_000 });
export class WeChatVoiceError extends Error {
  constructor(readonly kind: 'invalid_media' | 'download' | 'decode' | 'limit' | 'cancelled' | 'timeout') { super(`wechat_voice_${kind}`); }
}
type Decoded = { data: Uint8Array; duration: number };
export interface WeChatVoiceOptions {
  fetch?: typeof fetch;
  /** Test seam; takes ownership of input, must honor signal and clear internal copies. */
  decode?: (silk: Uint8Array, sampleRate: number, signal: AbortSignal) => Promise<Decoded>;
  /** May only shorten the production deadline. */
  timeoutMs?: number;
}
function fail(kind: WeChatVoiceError['kind']): never { throw new WeChatVoiceError(kind); }
function check(signal: AbortSignal): void { if (signal.aborted) throw signal.reason; }
function mediaUrl(item: WeChatVoiceItem): URL {
  const media = item?.media;
  let url: URL;
  if (media?.full_url) {
    if (typeof media.full_url !== 'string' || media.full_url.length > 8192) fail('invalid_media');
    try { url = new URL(media.full_url); } catch { return fail('invalid_media'); }
  } else {
    const query = media?.encrypt_query_param;
    if (typeof query !== 'string' || !query || query.length > 4096) fail('invalid_media');
    url = new URL(`${CDN}/c2c/download?encrypted_query_param=${encodeURIComponent(query)}`);
  }
  if (url.origin !== CDN || url.username || url.password || url.hash || url.pathname !== '/c2c/download') fail('invalid_media');
  return url;
}
function aesKey(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 48 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('invalid_media');
  const bytes = Buffer.from(value, 'base64');
  try {
    if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) fail('invalid_media');
    if (bytes.length === 16) return Buffer.from(bytes);
    if (bytes.length === 32 && bytes.every(b => b >= 48 && b <= 57 || b >= 65 && b <= 70 || b >= 97 && b <= 102)) {
      const key = Buffer.alloc(16);
      const nibble = (b: number) => b <= 57 ? b - 48 : (b | 32) - 87;
      for (let i = 0; i < 16; i++) key[i] = nibble(bytes[i * 2]!) * 16 + nibble(bytes[i * 2 + 1]!);
      return key;
    }
    return fail('invalid_media');
  } finally { bytes.fill(0); }
}
/** Reject late results even for an injected dependency which ignores cancellation. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal, discard: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let ended = false;
    const abort = () => { if (!ended) { ended = true; reject(signal.reason); } };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (ended) { discard(value); return; }
      ended = true; resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      if (!ended) { ended = true; reject(error); }
    });
  });
}
async function download(url: URL, signal: AbortSignal, transport: typeof fetch): Promise<Uint8Array> {
  const response = await abortable(transport(url, { method: 'GET', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal }), signal,
    late => { void late.body?.cancel().catch(() => {}); });
  const chunks: Uint8Array[] = [];
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    check(signal);
    if (!response.ok || response.redirected || response.url && new URL(response.url).href !== url.href) fail('download');
    const size = response.headers.get('content-length');
    if (size !== null && (!/^\d+$/.test(size) || Number(size) > WECHAT_VOICE_LIMITS.downloadBytes)) fail('limit');
    if (!response.body) fail('download');
    reader = response.body.getReader();
    let total = 0;
    while (true) {
      const part = await abortable(reader.read(), signal, late => late.value?.fill(0));
      if (part.done) break;
      total += part.value.byteLength;
      if (total > WECHAT_VOICE_LIMITS.downloadBytes) { part.value.fill(0); fail('limit'); }
      chunks.push(part.value);
    }
    check(signal);
    if (!total || total % 16) fail('invalid_media');
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    // Cancellation need not wait for a broken injected stream's cancel promise.
    if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    else { void response.body?.cancel().catch(() => {}); }
  }
}
/** Validate the packet container before entering the native codec compiled to WASM. */
function validatedSilk(bytes: Uint8Array): Uint8Array {
  const header = Buffer.from('#!SILK_V3');
  const start = bytes[0] === 2 ? 1 : 0;
  if (bytes.length < start + 9 || !header.every((b, i) => bytes[start + i] === b)) fail('decode');
  let offset = start + 9, packets = 0;
  let end = bytes.length;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) fail('decode');
    const size = bytes[offset]! | bytes[offset + 1]! << 8;
    if (size === 65535) {
      if (offset + 2 !== bytes.length) fail('decode');
      end = offset; offset += 2; break;
    }
    // SDK maximum: 250 bytes/frame, up to five 20 ms frames per packet.
    if (!size || size > 1250 || offset + 2 + size > bytes.length) fail('decode');
    if (++packets > WECHAT_VOICE_LIMITS.durationMs / 20) fail('limit');
    offset += size + 2;
  }
  // The bundled decoder initially reads a two-packet jitter buffer.
  if (packets < 2) fail('decode');
  // Normalize standard SILK header and append the explicit terminal marker to avoid EOF overread.
  const normalized = new Uint8Array(1 + end - start + 2);
  normalized[0] = 2; normalized.set(bytes.subarray(start, end), 1);
  normalized[normalized.length - 2] = 255; normalized[normalized.length - 1] = 255;
  return normalized;
}
function validPcm(result: Decoded): void {
  if (!(result?.data instanceof Uint8Array) || !result.data.length || result.data.length % 2 || !Number.isFinite(result.duration) || result.duration <= 0) fail('decode');
  // PCM byte count is authoritative; codec-reported duration can include jitter-buffer padding.
  if (result.data.length > WECHAT_VOICE_LIMITS.pcmBytes) fail('limit');
}
function wav(pcm: Uint8Array): Uint8Array {
  const output = Buffer.alloc(44 + pcm.length);
  output.write('RIFF', 0); output.writeUInt32LE(output.length - 8, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(24_000, 24); output.writeUInt32LE(48_000, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(pcm.length, 40); output.set(pcm, 44);
  return output;
}
async function workerDecode(silk: Uint8Array, sampleRate: number, signal: AbortSignal): Promise<Decoded> {
  check(signal);
  const worker = new Worker(new URL(import.meta.url), { workerData: { wechatVoiceDecode: true, silk, sampleRate }, resourceLimits: { maxOldGenerationSizeMb: 64 }, stdout: true, stderr: true });
  // Codec errors/logs must not reach the product logs. Worker lifetime also bounds its WASM copies.
  worker.stdout.resume(); worker.stderr.resume();
  let delivered = false;
  try {
    return await new Promise<Decoded>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      worker.once('message', (value: { result?: Decoded }) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) { value.result?.data?.fill(0); reject(signal.reason); return; }
        if (!value.result) { reject(new WeChatVoiceError('decode')); return; }
        delivered = true; resolve(value.result);
      });
      worker.once('error', () => { signal.removeEventListener('abort', abort); reject(new WeChatVoiceError('decode')); });
      worker.once('exit', () => { signal.removeEventListener('abort', abort); if (!delivered) reject(new WeChatVoiceError('decode')); });
      if (signal.aborted) abort();
    });
  } finally { await worker.terminate(); }
}
if (!isMainThread && workerData?.wechatVoiceDecode === true) {
  let result: Decoded | undefined;
  try {
    const { decode } = await import('silk-wasm');
    result = await decode(workerData.silk, workerData.sampleRate);
    validPcm(result);
    parentPort!.postMessage({ result });
  } catch { parentPort!.postMessage({ failed: true }); }
  finally { workerData.silk.fill(0); result?.data.fill(0); parentPort!.close(); }
}

/** Bound-user admission/dedup belongs to the service. Caller owns returned WAV and must clear it. */
export async function decodeWeChatVoice(item: WeChatVoiceItem, signal: AbortSignal, options: WeChatVoiceOptions = {}): Promise<Uint8Array> {
  const controller = new AbortController();
  const cancelled = () => controller.abort(new WeChatVoiceError('cancelled'));
  signal.addEventListener('abort', cancelled, { once: true });
  if (signal.aborted) cancelled();
  const timeoutMs = options.timeoutMs ?? WECHAT_VOICE_LIMITS.timeoutMs;
  const timer = setTimeout(() => controller.abort(new WeChatVoiceError('timeout')), Math.max(1, Math.min(Number.isFinite(timeoutMs) ? timeoutMs : 1, WECHAT_VOICE_LIMITS.timeoutMs)));
  const active = controller.signal;
  let key: Buffer | undefined, encrypted: Uint8Array | undefined, plaintext: Buffer | undefined, tail: Buffer | undefined, silk: Uint8Array | undefined, pcm: Uint8Array | undefined;
  try {
    check(active);
    if (item?.encode_type !== undefined && item.encode_type !== 6) fail('invalid_media');
    if (item?.playtime !== undefined && (!Number.isFinite(item.playtime) || item.playtime < 0 || item.playtime > WECHAT_VOICE_LIMITS.durationMs)) fail('limit');
    const url = mediaUrl(item);
    key = aesKey(item.media?.aes_key);
    encrypted = await download(url, active, options.fetch ?? fetch);
    check(active);
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    plaintext = decipher.update(encrypted); tail = decipher.final();
    const combined = Buffer.concat([plaintext, tail]);
    try { silk = validatedSilk(combined); } finally { combined.fill(0); }
    encrypted.fill(0); key.fill(0); plaintext.fill(0); tail.fill(0);
    const result = await abortable((options.decode ?? workerDecode)(silk, WECHAT_VOICE_LIMITS.sampleRate, active), active, late => late.data?.fill(0));
    pcm = result.data;
    check(active); validPcm(result);
    return wav(pcm);
  } catch (error) {
    if (active.aborted) throw active.reason;
    if (error instanceof WeChatVoiceError) throw error;
    throw new WeChatVoiceError('decode'); // No URL, key, response body, transcript or codec error detail.
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancelled);
    key?.fill(0); encrypted?.fill(0); plaintext?.fill(0); tail?.fill(0); silk?.fill(0); pcm?.fill(0);
  }
}
