import type { PlaybackDriver, PlaybackSample, PlaybackSession } from './playback.js';
import { abortable, checkAbort } from './scope.js';

/** Output timestamps describe rendered device frames; physical audibility still requires a listening check. */
export class BrowserPlaybackDriver implements PlaybackDriver {
  async open(bytes: Uint8Array, audioId: string, emit: (event: PlaybackSample) => void, signal: AbortSignal): Promise<PlaybackSession> {
    checkAbort(signal);
    const context = new AudioContext();
    let source: AudioBufferSourceNode | undefined, timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false, resolveDone: () => void = () => {};
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (source) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
      if (context.state !== 'closed') void context.close().catch(() => {});
      signal.removeEventListener('abort', stop); resolveDone();
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      const buffer = await abortable(context.decodeAudioData(bytes.slice().buffer), signal); checkAbort(signal);
      let firstFrame = buffer.length;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < firstFrame; i++) if (data[i] !== 0) { firstFrame = i; break; }
      }
      if (firstFrame === buffer.length) throw new Error('Speech audio contains only silence');
      await abortable(context.resume(), signal); checkAbort(signal);
      const analyser = context.createAnalyser(); analyser.fftSize = 256;
      source = context.createBufferSource(); source.buffer = buffer; source.connect(analyser); analyser.connect(context.destination);
      const startTime = context.currentTime, onset = startTime + firstFrame / buffer.sampleRate, end = startTime + buffer.duration;
      const wallOrigin = Date.now() - performance.now();
      let started = false;
      const level = new Float32Array(analyser.fftSize);
      const poll = () => {
        if (stopped || signal.aborted) return;
        const timestamp = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : undefined;
        const validOutput = timestamp && Number.isFinite(timestamp.contextTime) && Number.isFinite(timestamp.performanceTime) && timestamp.performanceTime! > 0;
        const position = validOutput ? timestamp.contextTime! : context.currentTime - (context.outputLatency || 0) - (context.baseLatency || 0);
        const basis = validOutput ? 'audio_output_timestamp' as const : 'audio_context_estimate' as const;
        if (!started && position >= onset) {
          started = true;
          const onsetPerformance = validOutput ? timestamp.performanceTime! + (onset - timestamp.contextTime!) * 1000 : performance.now() - (position - onset) * 1000;
          emit({ type: 'started', audioId, at: new Date(wallOrigin + onsetPerformance).toISOString(), timingBasis: basis });
        }
        if (started) {
          const at = new Date().toISOString();
          analyser.getFloatTimeDomainData(level);
          const rms = Math.sqrt(level.reduce((sum, value) => sum + value * value, 0) / level.length);
          emit({ type: 'amplitude', value: Math.min(1, rms), at });
          emit({ type: 'progress', positionMs: Math.min(buffer.duration, Math.max(0, position - startTime)) * 1000, durationMs: buffer.duration * 1000, at });
          if (position >= end) { emit({ type: 'ended', at }); stop(); }
        }
      };
      source.start(startTime); timer = setInterval(poll, 16);
      // onended is a render-graph event; wait for the output position before declaring playback ended.
      source.onended = poll;
      return { done, stop };
    } catch (error) { stop(); throw error; }
  }
}
