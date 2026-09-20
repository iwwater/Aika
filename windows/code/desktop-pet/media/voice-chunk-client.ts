// FIX61-08: the renderer half of the live voice leg. The browser capture frames 100 ms PCM16 mono
// chunks (VoiceInputSession); this sink puts each one on the bridge as voice_chunk and resolves when
// the backend acknowledges it. That ack — not a timer — is the backpressure signal: an unacknowledged
// frame stays in flight, and after VOICE_MAX_FRAMES_IN_FLIGHT the recorder stops instead of buffering.
import type { VoiceFrameHeader, VoiceFrameSink } from './voice-input-session.js';

export interface VoiceChunkTransport {
  /** Sends one frame; false means the bridge is not writable and the frame failed. */
  send(frame: { readonly channel: 'voice_chunk'; readonly inputSessionId: string; readonly generation: number;
    readonly index: number; readonly sampleRate: number; readonly sampleCount: number; readonly pcm: string }): boolean;
  /** Encodes PCM16 bytes; injectable so the boundary is testable without a browser. */
  encode?(pcm: Uint8Array): string;
}

const base64 = (pcm: Uint8Array): string => {
  let text = '';
  for (let at = 0; at < pcm.length; at += 32768) text += String.fromCharCode(...pcm.subarray(at, at + 32768));
  return btoa(text);
};

/**
 * One live sender. acks are matched by (inputSessionId, generation, index); a foreign ack is ignored,
 * and finish()/cancel() release every waiter so a dead shell can never wedge the recorder.
 */
export function createVoiceChunkSink(transport: VoiceChunkTransport): VoiceFrameSink & {
  /** Applies one backend acknowledgement; returns false when it belongs to no pending frame. */
  acknowledge(message: { readonly inputSessionId: string; readonly generation: number; readonly index: number }): boolean;
  /** Fails every pending frame (bridge reconnect, capture stop). */
  reset(error?: Error): void;
} {
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const key = (sessionId: string, generation: number, index: number) => `${sessionId}:${generation}:${index}`;
  return {
    push(header: VoiceFrameHeader, pcm: Uint8Array): Promise<void> {
      const id = key(header.inputSessionId, header.generation, header.index);
      const settled = new Promise<void>((resolve, reject) => { pending.set(id, { resolve, reject }); });
      const sent = transport.send({ channel: 'voice_chunk', inputSessionId: header.inputSessionId, generation: header.generation,
        index: header.index, sampleRate: header.sampleRate, sampleCount: header.sampleCount,
        pcm: (transport.encode ?? base64)(pcm) });
      if (!sent) { pending.delete(id); return Promise.reject(new Error('Desktop bridge write failed')); }
      return settled;
    },
    async finish(): Promise<void> { /* The release is a command, not a frame. */ },
    acknowledge(message): boolean {
      const id = key(message.inputSessionId, message.generation, message.index);
      const waiter = pending.get(id);
      if (!waiter) return false;
      pending.delete(id);
      waiter.resolve();
      return true;
    },
    reset(error = new Error('Voice capture session ended')): void {
      for (const [id, waiter] of [...pending]) { pending.delete(id); waiter.reject(error); }
    },
  };
}
