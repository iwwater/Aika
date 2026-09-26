// FIX61-08: the sherpa-onnx OnlineRecognizer runs in this worker thread so decoding never blocks the
// Node main event loop. Audio arrives as Int16 frames, one stream per input session, and the worker
// owns the segment index/revision pair: a partial is a replacement of the current segment text until
// the recognizer reports an endpoint, which publishes an immutable final and opens the next segment.
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const require = createRequire(import.meta.url);

interface StreamState {
  stream: { acceptWaveform(value: { samples: Float32Array; sampleRate: number }): void; inputFinished(): void };
  samples: number;
  sampleRate: number;
  segmentIndex: number;
  revision: number;
  lastText: string;
  finalized: boolean;
  cancelled: boolean;
}

try {
  const sherpa = require('sherpa-onnx-node');
  const { config, tailPaddingSec } = workerData as { config: Record<string, unknown>; tailPaddingSec: number };
  const recognizer = new sherpa.OnlineRecognizer(config);
  const streams = new Map<number, StreamState>();

  const post = (message: Record<string, unknown>) => parentPort!.postMessage(message);

  function newStream(sampleRate: number): StreamState {
    return { stream: recognizer.createStream(), samples: 0, sampleRate, segmentIndex: 0, revision: 0, lastText: '', finalized: false, cancelled: false };
  }
  function publish(state: StreamState, streamId: number, audioEndMs: number, type: 'partial' | 'final'): void {
    const text = String(recognizer.getResult(state.stream).text ?? '');
    if (type === 'partial') {
      if (text === state.lastText) return;
      state.lastText = text;
      state.revision += 1;
      post({ streamId, type: 'partial', text, segmentId: String(state.segmentIndex), index: state.segmentIndex, revision: state.revision, audioEndMs });
      return;
    }
    post({ streamId, type: 'final', text, segmentId: String(state.segmentIndex), index: state.segmentIndex, revision: state.revision + 1, audioEndMs });
    state.segmentIndex += 1;
    state.revision = 0;
    state.lastText = '';
    recognizer.reset(state.stream);
  }
  function decode(state: StreamState, streamId: number): void {
    while (recognizer.isReady(state.stream)) {
      recognizer.decode(state.stream);
      if (recognizer.isEndpoint(state.stream)) { publish(state, streamId, state.samples / state.sampleRate * 1000, 'final'); }
    }
    publish(state, streamId, state.samples / state.sampleRate * 1000, 'partial');
  }

  parentPort!.on('message', message => {
    const samples: Int16Array | undefined = message.samples;
    try {
      if (message.type === 'open') {
        streams.set(message.streamId, newStream(message.sampleRate));
        post({ id: message.id, streamId: message.streamId, ready: true });
      } else if (message.type === 'push') {
        const state = streams.get(message.streamId);
        if (!state || !samples) throw Error('Unknown voice stream');
        const floats = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) floats[i] = samples[i]! / 32768;
        state.stream.acceptWaveform({ samples: floats, sampleRate: message.sampleRate ?? state.sampleRate });
        state.samples += floats.length;
        decode(state, message.streamId);
        post({ id: message.id, streamId: message.streamId });
      } else if (message.type === 'finish') {
        const state = streams.get(message.streamId);
        if (!state) throw Error('Unknown voice stream');
        // Trailing silence lets the transducer emit the words that were still in the encoder window.
        const padding = new Float32Array(Math.round(tailPaddingSec * state.sampleRate));
        state.stream.acceptWaveform({ samples: padding, sampleRate: state.sampleRate });
        state.samples += padding.length;
        state.stream.inputFinished();
        decode(state, message.streamId);
        publish(state, message.streamId, state.samples / state.sampleRate * 1000, 'final');
        streams.delete(message.streamId);
        post({ id: message.id, streamId: message.streamId, finished: true });
      } else if (message.type === 'cancel') {
        streams.delete(message.streamId);
        post({ id: message.id, streamId: message.streamId });
      } else throw Error('Invalid voice worker message');
    } catch {
      post({ id: message.id, streamId: message.streamId, failed: true });
    } finally { samples?.fill(0); }
  });
  post({ ready: true });
} catch { parentPort!.postMessage({ failed: true }); }
