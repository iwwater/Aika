// FIX61-08 08-E: the full automatic integration over the production composition root. Real modules:
// BackendSession, DesktopRuntime, DialoguePipeline, DesktopDeviceBridge, LiveVoiceTurn, LiveVoiceBridge,
// NextSpeechInput and the genuine local sherpa-onnx streaming recognizer. Faked external services,
// annotated: the dialogue provider (scripted text), TTS, playback and the memory store (in-memory),
// plus the renderer peer that owns the microphone. The legacy batch perception provider is a spy that
// fails loudly if a voice turn ever calls it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BackendSession, type BackendPorts } from '../../app/backend-session.js';
import { SherpaStreamingAsr } from '../../providers/sherpa-streaming-asr.js';
import { MemoryMediaStore } from '../../media/store.js';
import { inspectPcmWav, pcm16Wav } from '../../media/wav.js';
import { PcmFrameAggregator } from '../../media/voice-input-session.js';
import type { BackendToDesktop, DesktopToBackend } from '../../contracts/desktop-bridge.js';
import type { ConversationMessage, DialogueContext, DesktopEvent, PerceptionResult, TurnScope } from '../../contracts/index.js';
import { COMPANION_ID } from '../../contracts/character.js';

const MODEL_DIRECTORY = process.env.NEXT_REAL_SHERPA_DIR ?? 'F:/AIVoice/toolchains/sherpa-streaming-asr/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';
const hop = () => new Promise<void>(done => setImmediate(done));

interface Sent { readonly message: BackendToDesktop; readonly generation: number }

/**
 * The renderer peer: owns the microphone, frames the same PCM with production framing, and answers
 * each voice_frame request with exactly that payload — i.e. the real bridge round trip.
 */
function rendererPeer(pcm: Int16Array, sampleRate: number) {
  const frames = new Map<number, Uint8Array>();
  const aggregator = new PcmFrameAggregator();
  let pending = 0;
  const feed = (block: Float32Array) => { for (const frame of aggregator.push(block)) frames.set(pending++, frame); };
  return {
    feed,
    framesSent: () => pending,
    /** The production renderer only answers a frame it has already captured. */
    hasFrame: (index: number) => frames.has(index),
    /** Answers the backend's frame requests; returns how many were answered. */
    answer(sent: Sent[], generation: number, reply: (message: DesktopToBackend, generation: number) => void): void {
      for (const { message, generation: at } of sent.splice(0)) {
        if (message.channel === 'capture_start') { reply({ channel: 'ack', requestId: message.requestId }, at); continue; }
        if (message.channel === 'capture_stop' || message.channel === 'stop') { reply({ channel: 'ack', requestId: message.requestId }, at); continue; }
        if (message.channel === 'play') {
          // Production playback device: audible start, then normal completion.
          reply({ channel: 'playback', requestId: message.requestId, event: { scope: message.tts.scope, at: new Date().toISOString(), type: 'started', audioId: message.tts.audio.id } }, at);
          reply({ channel: 'playback', requestId: message.requestId, event: { scope: message.tts.scope, at: new Date().toISOString(), type: 'ended' } }, at);
          continue;
        }
        if (message.channel === 'capture_finish') {
          const wav = pcm16Wav(new Float32Array(pcm.length), sampleRate);
          const view = new DataView(wav.buffer);
          for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i]!, true);
          reply({ channel: 'capture', requestId: message.requestId, result: { scope: message.scope,
            audio: { id: 'wav', mimeType: 'audio/wav', base64: Buffer.from(wav).toString('base64') }, images: [],
            inputEndedAt: new Date().toISOString(), captureStoppedAt: new Date().toISOString() } }, at);
          continue;
        }
        if (message.channel === 'voice_frame') {
          const frame = frames.get(message.index);
          // The production renderer answers a frame it has not captured yet with an empty payload
          // (see desktop/main.mjs answerVoiceFrame); the backend then asks again later.
          if (!frame) {
            reply({ channel: 'voice_chunk', requestId: message.requestId, inputSessionId: message.inputSessionId,
              generation: message.generation, index: message.index, sampleRate: message.sampleRate,
              sampleCount: 0, pcm: '' }, at);
            continue;
          }
          frames.delete(message.index);
          reply({ channel: 'voice_chunk', requestId: message.requestId, inputSessionId: message.inputSessionId,
            generation: message.generation, index: message.index, sampleRate: message.sampleRate,
            sampleCount: message.sampleCount, pcm: Buffer.from(frame).toString('base64') }, at);
        }
      }
    },
    sampleRate,
  };
}

/** In-memory production memory port; the memory store is an external service and is faked. */
function memoryDouble() {
  const appended: ConversationMessage[][] = [];
  const contexts: string[] = [];
  return {
    appended, contexts,
    port: {
      context: async (scope: TurnScope, text: string): Promise<DialogueContext> => {
        contexts.push(text);
        return { scope, characterPrompt: '朋友角色', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 5000 };
      },
      append: async (_scope: TurnScope, messages: readonly ConversationMessage[]) => { appended.push([...messages]); },
      maintain: async () => [],
    },
  };
}

test('08-E PCM → bridge → real streaming ASR → production pipeline → UI, with no batch ASR call', { timeout: 300000 }, async t => {
  let wav: Uint8Array;
  try { wav = await readFile(`${MODEL_DIRECTORY}/test_wavs/0.wav`); }
  catch { return t.skip(`local streaming model package missing: ${MODEL_DIRECTORY}`); }
  const parsed = inspectPcmWav(wav);
  const samples = new Int16Array(parsed.data.buffer, parsed.data.byteOffset, parsed.data.length / 2);

  const sent: Sent[] = [];
  const events: DesktopEvent[] = [];
  const turns: string[] = [];
  let batchAsrCalls = 0;
  const memory = memoryDouble();
  const mediaStore = new MemoryMediaStore();
  const asr = new SherpaStreamingAsr({ encoder: `${MODEL_DIRECTORY}/encoder-epoch-99-avg-1.int8.onnx`,
    decoder: `${MODEL_DIRECTORY}/decoder-epoch-99-avg-1.onnx`, joiner: `${MODEL_DIRECTORY}/joiner-epoch-99-avg-1.int8.onnx`,
    tokens: `${MODEL_DIRECTORY}/tokens.txt` });

  const ports: BackendPorts = {
    memory: memory.port as never,
    mediaStore,
    // fake: the dialogue provider is an external LLM service.
    dialogue: { reply: async request => { turns.push(request.text); return { scope: request.scope, text: '我在听。',
      expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } }; } },
    // fake: batch perception must never run for a live voice turn. The call counter proves it.
    perception: { perceive: async (): Promise<PerceptionResult> => { batchAsrCalls++; throw new Error('batch ASR must not run for a live voice turn'); } },
    // fake: TTS is an external service. Playback stays the production device bridge, answered by the
    // renderer peer below, so the UI leg is exercised too.
    tts: { synthesize: async input => ({ scope: input.scope, audio: await mediaStore.put(input.scope, pcm16Wav(new Float32Array(160), 16000), 'audio/wav'),
      expression: input.expression, durationMs: 10, synchronization: 'none' }) },
    outputMode: 'voice',
    createStreamingAsr: () => asr,
  };
  const session = new BackendSession(ports, message => {
    sent.push({ message, generation: 0 });
    if (message.channel === 'event') events.push(message.event);
  }, () => {});
  t.after(async () => { await session.close(); await asr.close(); });

  const reply = (message: DesktopToBackend, generation: number) => session.receiveLine(JSON.stringify(message));
  const peer = rendererPeer(samples, parsed.sampleRate);
  // The real recognizer decodes in a worker thread and needs real time to answer; a pure
  // setImmediate loop would starve it. Yielding to timers keeps the exchange honest.
  const yieldTo = () => new Promise<void>(done => setTimeout(done, 1));
  /** One exchange with the renderer: answer everything it was asked for, then let the backend react. */
  const pump = async (limit = 200): Promise<void> => {
    for (let i = 0; i < limit; i++) {
      const batch = sent.splice(0);
      if (!batch.length) { await yieldTo(); continue; }
      for (const { message, generation } of batch) {
        if (message.channel === 'backend_ready') continue;
        peer.answer([{ message, generation }], generation, reply);
      }
      await yieldTo();
    }
  };

  await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'start_voice', clientRequestId: 'voice-1' } }));
  await pump(20);
  const turn = events.find(event => event.type === 'turn');
  assert.ok(turn && turn.type === 'turn' && turn.input.kind === 'voice', 'the voice turn was accepted');

  // Feed the real recording at its true cadence; the backend pulls frames over the bridge.
  const frame = 1600;
  const feeding = (async () => {
    for (let offset = 0; offset < samples.length; offset += frame) {
      const length = Math.min(frame, samples.length - offset);
      peer.feed(Float32Array.from(samples.subarray(offset, offset + length), value => value / 32768));
      await pump(40);
    }
  })();
  await feeding;
  await pump(60);

  const interim = events.filter((event): event is Extract<DesktopEvent, { type: 'transcript' }> => event.type === 'transcript' && event.interim === true);
  assert.ok(interim.length >= 3, `live partials reached the UI while recording (got ${interim.length})`);
  assert.ok(peer.framesSent() > 0, 'the renderer produced wired frames');
  assert.equal(batchAsrCalls, 0, 'no batch ASR call happened before release');

  await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'finish_voice' } }));
  await pump(400);

  const final = events.filter((event): event is Extract<DesktopEvent, { type: 'transcript' }> => event.type === 'transcript' && !event.interim);
  assert.equal(final.length, 1, 'exactly one authoritative transcript reached the UI');
  assert.match(final[0]!.text, /对我做了介绍/, `unexpected transcript: ${JSON.stringify(final[0]!.text)}`);
  assert.equal(batchAsrCalls, 0, 'the voice turn never called the batch ASR');
  assert.deepEqual(turns, [final[0]!.text], 'exactly one dialogue turn was started with the verified transcript');
  assert.equal(events.filter(event => event.type === 'reply').length, 1, 'exactly one reply');
  assert.equal(events.filter(event => event.type === 'playback' && event.playback.type === 'ended').length, 1, 'audio played');
  assert.equal(memory.appended.flat().filter(message => message.role === 'user').length, 1, 'exactly one user message was written');
  assert.equal(memory.appended.flat().find(message => message.role === 'user')?.text, final[0]!.text);
  // The interim text never reached memory: the only user message is the final transcript.
  assert.ok(!memory.appended.flat().some(message => message.role === 'user' && message.text.includes('对我做了') === false), 'no interim text was persisted');
});
