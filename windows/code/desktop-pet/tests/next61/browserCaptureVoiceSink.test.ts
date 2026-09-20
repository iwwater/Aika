// FIX61-08 08-A/08-B capture leg: the production BrowserCaptureDriver must hand every worklet flush to
// the live voice sink while recording. Browser APIs are doubled (no real microphone); the driver, the
// Worklet contract and the framing are production code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserCaptureDriver } from '../../media/browser-capture.js';
import { inspectPcmWav, pcm16Wav } from '../../media/wav.js';

/** The exact PCM16 bytes the WAV path must produce for a known sample sequence. */
const pcm16 = (samples: number[]) => Array.from(pcm16Wav(Float32Array.from(samples), 48000).subarray(44));

function replace(name: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name); };
}
const tick = () => new Promise<void>(done => setImmediate(done));
const round = (block: Float32Array) => Array.from(block, value => Number(value.toFixed(4)));
type Handler = (event: { data: Record<string, unknown> }) => void;

function environment() {
  let node: { port: { onmessage: Handler | null; close(): void; postMessage(value: unknown): void } };
  const seen = { trackStops: 0, finishPosts: 0 };
  const tracks = [{ stop() { seen.trackStops++; } }];
  const restores = [
    replace('navigator', { mediaDevices: { async getUserMedia() { return { getTracks: () => tracks, getAudioTracks: () => [tracks[0]], getVideoTracks: () => [] }; } } }),
    replace('AudioContext', class {
      state = 'running'; sampleRate = 48000; destination = {};
      audioWorklet = { async addModule() {} };
      async resume() {}
      async close() { this.state = 'closed'; }
      createMediaStreamSource() { return { connect() {} }; }
      createGain() { return { gain: { value: 0 }, connect() {} }; }
    }),
    replace('AudioWorkletNode', class {
      port = { onmessage: null as Handler | null, close() {}, postMessage(value: unknown) { if (value === 'finish') { seen.finishPosts++; this.onmessage?.({ data: { samples: Float32Array.of(0.1, 0.3), finished: true } }); } } };
      constructor() { node = this as never; }
      connect() { queueMicrotask(() => node.port.onmessage?.({ data: { started: true, sampleCount: 128 } })); }
      disconnect() {}
    }),
  ];
  return { seen, get node() { return node; }, deliver: (data: Record<string, unknown>) => node.port.onmessage?.({ data }), restore() { restores.reverse().forEach(restore => restore()); } };
}

test('08-A every worklet flush reaches the live voice sink while recording, including the finish tail', async () => {
  const h = environment();
  try {
    const blocks: Float32Array[] = [];
    const diagnostics: string[] = [];
    const driver = new BrowserCaptureDriver({ cameraWidth: 320, jpegQuality: 0.7, maxBufferedSamples: 24000 * 30,
      onDiagnostic: event => diagnostics.push(event.phase),
      voiceSink: block => { blocks.push(Float32Array.from(block)); } });
    const session = await driver.open(new AbortController().signal);
    h.deliver({ samples: Float32Array.of(0.1, 0.2) });
    h.deliver({ samples: Float32Array.of(0.3) });
    assert.deepEqual(blocks.map(block => block.length), [2, 1], 'each flush is forwarded in order, before finish');
    assert.deepEqual(round(blocks[0]!), [0.1, 0.2]);

    const captured = await session.finish();
    assert.equal(h.seen.finishPosts, 1);
    assert.equal(blocks.length, 3, 'the worklet tail flush emitted during finish is forwarded too');
    assert.deepEqual(round(blocks[2]!), [0.1, 0.3]);
    assert.deepEqual(round(blocks[0]!), [0.1, 0.2], 'the live sink never sees mutated buffers');
    const wav = inspectPcmWav(captured.audio);
    assert.equal(wav.durationMs, 5 / 48000 * 1000, 'the recorded WAV carries all five captured samples');
    assert.deepEqual(Array.from(wav.data), pcm16([0.1, 0.2, 0.3, 0.1, 0.3]));
    assert.ok(diagnostics.includes('audio_flushed'));
  } finally { h.restore(); }
});

test('08-A a sink failure is reported and never corrupts the recording', async () => {
  const h = environment();
  try {
    const errors: unknown[] = [];
    const driver = new BrowserCaptureDriver({ cameraWidth: 320, jpegQuality: 0.7, maxBufferedSamples: 24000 * 30,
      voiceSink: () => { throw new Error('sink closed'); }, onVoiceSinkError: error => errors.push(error) });
    const session = await driver.open(new AbortController().signal);
    h.deliver({ samples: Float32Array.of(0.25) });
    assert.equal(errors.length, 1);
    const wav = inspectPcmWav((await session.finish()).audio);
    // The rejected live frame (0.25) plus the worklet tail frame (0.1, 0.3) both stay in the WAV copy.
    assert.equal(wav.durationMs, 3 / 48000 * 1000, 'the WAV copy still contains the sample the sink rejected');
    assert.deepEqual(Array.from(wav.data), pcm16([0.25, 0.1, 0.3]));
  } finally { h.restore(); }
});

test('08-B a stopped capture forwards nothing further', async () => {
  const h = environment();
  try {
    const blocks: Float32Array[] = [];
    // The stop() path zeroes the blocks it still owns, so compare the copy the sink already took.
    const observed: number[][] = [];
    const driver = new BrowserCaptureDriver({ cameraWidth: 320, jpegQuality: 0.7, maxBufferedSamples: 24000 * 30,
      voiceSink: block => { observed.push(round(block)); blocks.push(block); } });
    const opened = await driver.open(new AbortController().signal);
    h.deliver({ samples: Float32Array.of(0.5) });
    assert.equal(blocks.length, 1);
    assert.deepEqual(observed, [[0.5]]);
    opened.stop();
    // Stopping detaches the port handler; replaying the same worklet message must not reach the sink.
    const handler = (h.node.port as { onmessage: Handler | null }).onmessage;
    handler?.({ data: { samples: Float32Array.of(0.6) } });
    assert.equal(blocks.length, 1, 'no audio leaves the device after stop');
    assert.deepEqual(observed, [[0.5]]);
    await tick();
  } finally { h.restore(); }
});
