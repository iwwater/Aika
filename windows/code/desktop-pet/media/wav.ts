const ascii = (bytes: Uint8Array, offset: number, size: number) => String.fromCharCode(...bytes.subarray(offset, offset + size));
export function pcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || !samples.length) throw new Error('Invalid PCM audio');
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const tag = (offset: number, text: string) => out.set(new TextEncoder().encode(text), offset);
  tag(0, 'RIFF'); view.setUint32(4, out.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    if (!Number.isFinite(sample)) throw new Error('Non-finite audio sample');
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  });
  return out;
}
export function inspectPcmWav(bytes: Uint8Array): { sampleRate: number; channels: number; bits: number; data: Uint8Array; durationMs: number } {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') throw new Error('Expected WAV audio');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sampleRate = 0, channels = 0, bits = 0, data: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = v.getUint32(offset + 4, true);
    if (offset + 8 + length > bytes.length) throw new Error('Truncated WAV');
    const name = ascii(bytes, offset, 4);
    if (name === 'fmt ') {
      if (length < 16 || v.getUint16(offset + 8, true) !== 1) throw new Error('Only PCM WAV is supported');
      channels = v.getUint16(offset + 10, true); sampleRate = v.getUint32(offset + 12, true); bits = v.getUint16(offset + 22, true);
    }
    if (name === 'data') data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + (length % 2);
  }
  if (!data?.length || !channels || !sampleRate || bits !== 16 || data.length % (channels * 2)) throw new Error('Invalid PCM WAV');
  return { sampleRate, channels, bits, data, durationMs: data.length / (sampleRate * channels * 2) * 1000 };
}
/** Preserve every segment; refuse format mismatch rather than silently losing speech. */
export function joinPcmWav(clips: readonly Uint8Array[]): Uint8Array {
  if (!clips.length) throw new Error('No speech audio');
  const parsed = clips.map(inspectPcmWav), first = parsed[0]!;
  if (parsed.some(p => p.sampleRate !== first.sampleRate || p.channels !== first.channels)) throw new Error('TTS segments have inconsistent formats');
  const dataLength = parsed.reduce((n, p) => n + p.data.length, 0);
  const result = pcm16Wav(new Float32Array(dataLength / 2), first.sampleRate);
  const view = new DataView(result.buffer);
  view.setUint16(22, first.channels, true); view.setUint32(28, first.sampleRate * first.channels * 2, true); view.setUint16(32, first.channels * 2, true);
  let offset = 44;
  for (const clip of parsed) { result.set(clip.data, offset); offset += clip.data.length; }
  return result;
}
