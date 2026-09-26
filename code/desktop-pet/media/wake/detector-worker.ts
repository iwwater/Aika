import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { PcmRing } from './buffer.js';
// The npm wrapper supplies JSDoc only. Keep the untyped native boundary inside this worker.
const require = createRequire(import.meta.url);
try {
  const sherpa = require('sherpa-onnx-node');
  const { modelDirectory: directory, settings, keywordLine } = workerData;
  const paths = (name: string) => join(directory, name);
  const threshold = { sensitive: 0.18, standard: 0.25, strict: 0.4 }[settings.sensitivity as 'sensitive' | 'standard' | 'strict'];
  const kws = new sherpa.KeywordSpotter({ featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder: paths('encoder.onnx'), decoder: paths('decoder.onnx'), joiner: paths('joiner.onnx') }, tokens: paths('tokens.txt'), numThreads: 1, provider: 'cpu', debug: 0 },
    keywordsBuf: keywordLine, keywordsBufSize: Buffer.byteLength(keywordLine), keywordsThreshold: threshold, keywordsScore: 1, numTrailingBlanks: 1, maxActivePaths: 4 });
  let stream = kws.createStream();
  // No VAD input in waiting mode; no continuous utterance retained before a keyword.
  const vad = new sherpa.Vad({ sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0,
    sileroVad: { model: paths('silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.05, minSpeechDuration: 0.1, windowSize: 512, maxSpeechDuration: 120 } }, 122);
  const ring = new PcmRing();
  let capturing = false, captureSamples = 0, streamSamples = 0;
  function feedVad(samples: Float32Array): boolean {
    vad.acceptWaveform(samples);
    const speech = vad.isDetected();
    while (!vad.isEmpty()) vad.pop();
    return speech;
  }
  function setCapturing(active: boolean): void {
    if (capturing === active) return;
    vad.reset(); capturing = active; captureSamples = 0;
    if (active) { const prefix = ring.takeCopy(); try { feedVad(prefix); } finally { prefix.fill(0); } }
  }
  parentPort!.on('message', message => {
    const samples: Float32Array | undefined = message.samples;
    try {
      let result: { speech: boolean; keyword?: string } | undefined;
      if (message.type === 'capture') setCapturing(message.active === true);
      else if (message.type === 'reset') { setCapturing(false); vad.reset(); ring.clear(); stream = kws.createStream(); streamSamples = 0; }
      else if (message.type === 'pcm' && samples) {
        if (!samples.length || samples.length > 3200) throw Error('Invalid frame');
        ring.push(samples); stream.acceptWaveform({ sampleRate: 16000, samples }); streamSamples += samples.length;
        let keyword: string | undefined;
        while (kws.isReady(stream)) {
          kws.decode(stream);
          const value = kws.getResult(stream).keyword;
          if (value) { kws.reset(stream); if (!capturing && value === settings.keyword) { keyword = value; setCapturing(true); } }
        }
        // Reset old feature history periodically; replay only the bounded overlapping PCM.
        if (streamSamples >= 16000 * 60 && !capturing) {
          stream = kws.createStream(); streamSamples = 0; const overlap = ring.takeCopy();
          try { stream.acceptWaveform({ sampleRate: 16000, samples: overlap }); while (kws.isReady(stream)) { kws.decode(stream); if (kws.getResult(stream).keyword) kws.reset(stream); } } finally { overlap.fill(0); }
        }
        const speech = capturing ? (keyword ? vad.isDetected() : feedVad(samples)) : false;
        if (capturing && (captureSamples += samples.length) > 16000 * 120) throw Error('Wake utterance limit');
        result = { speech, ...(keyword ? { keyword } : {}) };
      } else throw Error('Invalid wake worker message');
      parentPort!.postMessage({ id: message.id, result });
    } catch { parentPort!.postMessage({ id: message.id, failed: true }); }
    finally { samples?.fill(0); }
  });
  parentPort!.postMessage({ ready: true });
} catch { parentPort!.postMessage({ failed: true }); }
