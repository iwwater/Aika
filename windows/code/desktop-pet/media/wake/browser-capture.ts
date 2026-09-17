import type { CaptureSession, CapturedBytes } from '../capture.js';
import type { CaptureLevel } from '../browser-capture.js';
import { TemporalFrames } from '../temporal-frames.js';
import { pcm16Wav } from '../wav.js';
import { abortable } from '../scope.js';
import { PcmRing } from './buffer.js';

export interface BrowserWakeCaptureOptions {
  /** Receiver owns this independent 16kHz mono PCM array and must clear it. */
  onPCM(samples: Float32Array): void;
  onLevel?(level: CaptureLevel): void;
  onError?(error: Error): void;
  workletModuleUrl?: string | URL;
}
type Clip = { parts: Float32Array[]; count: number; live: boolean; cameraRequested: boolean; frames: TemporalFrames; camera?: MediaStream; video?: HTMLVideoElement; canvas?: HTMLCanvasElement; timer?: ReturnType<typeof setInterval> };
/** Explicit opt-in only: AEC wake stream and each post-hit clip have separate lifetimes. */
export class BrowserWakeCapture {
  private readonly ring = new PcmRing();
  private readonly lifecycle = new AbortController();
  private stream: MediaStream | undefined;
  private context: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private clip: Clip | undefined;
  private opened = false;
  private closed = false;
  private ready = false;
  private detach: (() => void) | undefined;
  private rejectReady: ((e: Error) => void) | undefined;
  private levelSamples = 0;
  constructor(private readonly options: BrowserWakeCaptureOptions) {}
  async open(signal: AbortSignal): Promise<{ echoCancellation: true }> {
    if (this.opened || this.closed || signal.aborted) throw Error('Wake capture unavailable');
    this.opened = true;
    const abort = () => this.close(); signal.addEventListener('abort', abort, { once: true });
    this.detach = () => signal.removeEventListener('abort', abort);
    let resolveReady!: () => void;
    const firstPCM = new Promise<void>((resolve, reject) => { resolveReady = resolve; this.rejectReady = reject; });
    // Observe early permission/worklet failures before awaiting the first sample.
    void firstPCM.catch(() => {});
    try {
      const pending = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false }).then(stream => {
        if (this.closed || signal.aborted) { stream.getTracks().forEach(t => t.stop()); throw Error('Wake capture closed'); }
        this.stream = stream;
        const tracks = stream.getAudioTracks();
        if (!tracks.length || tracks.some(t => t.getSettings().echoCancellation !== true)) throw Error('Wake echo cancellation unavailable');
        for (const track of tracks) track.addEventListener('ended', () => this.fail('Wake microphone ended'), { once: true });
        return stream;
      });
      void pending.catch(() => {});
      const context = this.context = new AudioContext({ sampleRate: 16000 });
      if (context.sampleRate !== 16000) throw Error('Wake sample rate unavailable');
      const worklet = async () => {
        await context.audioWorklet.addModule(this.options.workletModuleUrl ?? new URL('./recorder-worklet.mjs', import.meta.url));
        if (this.closed) throw Error('Wake capture closed');
        const node = this.node = new AudioWorkletNode(context, 'pet-wake-recorder');
        node.onprocessorerror = () => this.fail('Wake audio processor failed');
        node.port.onmessage = (e: MessageEvent<{ samples?: Float32Array; error?: boolean }>) => {
          const samples = e.data.samples;
          if (this.closed) { samples?.fill(0); return; }
          if (e.data.error || !(samples instanceof Float32Array) || !samples.length || samples.length > 3200 || samples.some(s => !Number.isFinite(s) || Math.abs(s) > 1)) { samples?.fill(0); this.fail('Invalid wake PCM'); return; }
          this.ring.push(samples);
          const clip = this.clip;
          if (clip?.live) {
            if (clip.count + samples.length > 16000 * 120) { samples.fill(0); this.fail('Wake utterance exceeded limit'); return; }
            clip.parts.push(samples.slice()); clip.count += samples.length;
          }
          this.levelSamples += samples.length;
          if (!this.ready || this.levelSamples >= 800) {
            let sum = 0, peak = 0; for (const sample of samples) { sum += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
            this.levelSamples = 0;
            try { this.options.onLevel?.({ rms: Math.min(peak, Math.sqrt(sum / samples.length)), peak }); } catch {}
          }
          if (!this.ready) { this.ready = true; resolveReady(); }
          try { this.options.onPCM(samples); } catch { samples.fill(0); this.fail('Wake PCM receiver failed'); }
          if(!this.closed)node.port.postMessage({ack:true});
        };
        const mute = context.createGain(); mute.gain.value = 0; node.connect(mute); mute.connect(context.destination);
      };
      const resume = context.resume();
      await abortable(Promise.all([pending, worklet(), resume]), this.lifecycle.signal);
      if (this.closed || signal.aborted) throw Error('Wake capture closed');
      context.createMediaStreamSource(this.stream!).connect(this.node!);
      await abortable(firstPCM, this.lifecycle.signal);
      if (this.closed || signal.aborted) throw Error('Wake capture closed');
      return { echoCancellation: true };
    } catch (error) { this.close(); throw error; }
  }
  private fail(message: string): void {
    if (this.closed) return;
    this.close(); try { this.options.onError?.(new Error(message)); } catch {}
  }
  private clearClip(clip: Clip): void {
    clip.live = false; clearInterval(clip.timer); clip.camera?.getTracks().forEach(t => t.stop());
    if (clip.video) { clip.video.pause(); clip.video.srcObject = null; }
    if (clip.canvas) { clip.canvas.width = 0; clip.canvas.height = 0; }
    clip.frames.clear(); clip.parts.forEach(p => p.fill(0)); clip.parts.length = 0;
    if (this.clip === clip) this.clip = undefined;
  }
  /** Camera starts only for this activated voice clip, and never gates microphone readiness. */
  private async camera(clip: Clip): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 } } });
      if (this.closed || !clip.live || this.clip !== clip) { stream.getTracks().forEach(t => t.stop()); return; }
      clip.camera = stream;
      const video = clip.video = document.createElement('video'); video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      if (this.closed || !clip.live) return;
      let pending = false, previous = -1; const started = performance.now();
      const sample = () => {
        const atMs = performance.now() - started;
        if (!clip.live || pending || video.currentTime === previous || !video.videoWidth || !video.videoHeight || !clip.frames.reserve(atMs)) return;
        previous = video.currentTime; pending = true;
        const canvas = clip.canvas ??= document.createElement('canvas'); canvas.width = Math.min(640, video.videoWidth); canvas.height = Math.max(1, Math.round(video.videoHeight * canvas.width / video.videoWidth));
        const paint = canvas.getContext('2d'); if (!paint) { pending = false; return; } paint.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          if (!blob) { pending = false; return; }
          void blob.arrayBuffer().then(buffer => { const bytes = new Uint8Array(buffer); if (!clip.live || this.closed) bytes.fill(0); else clip.frames.add(atMs, bytes); }).catch(() => {}).finally(() => { pending = false; });
        }, 'image/jpeg', 0.8);
      };
      clip.timer = setInterval(sample, 1000); sample();
    } catch { clip.camera?.getTracks().forEach(t => t.stop()); }
  }
  /** Called by renderer only after native start_voice has authorized this clip's camera. */
  authorizeCaptureCamera(): void {
    const clip = this.clip;
    if (!clip?.live || clip.cameraRequested || this.closed) return;
    clip.cameraRequested = true; void this.camera(clip);
  }
  beginCapture(): CaptureSession {
    if (!this.ready || this.closed || this.clip) throw Error('Wake clip unavailable');
    const prefix = this.ring.takeCopy();
    const clip: Clip = { parts: [prefix], count: prefix.length, live: true, cameraRequested: false, frames: new TemporalFrames() };
    this.clip = clip;
    return {
      stop: () => this.clearClip(clip),
      finish: async (): Promise<CapturedBytes> => {
        if (!clip.live || this.clip !== clip || this.closed) throw Error('Wake clip closed');
        clip.live = false; clearInterval(clip.timer); clip.camera?.getTracks().forEach(t => t.stop());
        const stoppedAt = new Date().toISOString();
        const pcm = new Float32Array(clip.count); let offset = 0;
        for (const part of clip.parts) { pcm.set(part, offset); offset += part.length; }
        try { return { audio: pcm16Wav(pcm, 16000), images: clip.frames.take().map(f => ({ bytes: f.bytes, mimeType: 'image/jpeg' })), captureStoppedAt: stoppedAt }; }
        finally { pcm.fill(0); this.clearClip(clip); }
      },
    };
  }
  close(): void {
    if (this.closed) return; this.closed = true; this.lifecycle.abort();
    this.rejectReady?.(new Error('Wake capture closed')); this.detach?.(); this.ring.clear();
    if (this.clip) this.clearClip(this.clip);
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined;
    if (this.node) { this.node.port.postMessage('close'); this.node.port.onmessage = null; this.node.port.close(); this.node.disconnect(); }
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
  }
}
