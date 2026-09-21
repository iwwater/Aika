// K65-00 00-B/00-D: the frozen 0.61 text/cancel/voice/memory feature cases, re-pinned on the real
// production chain, plus the executable CER gate that K65-00 registers before any 0.65 code exists.
//
// Why this file exists at all: FIX61-08 §6 registered CER ≤ 0.20 / keywords 3/3 / first-partial ≤ 1500 ms
// / final ≤ 10000 ms as the real streaming-ASR thresholds, but the measuring script (_metrics08.mjs) was
// deleted and NO surviving test asserts them — the real-model case in tests/next61/liveVoicePath.test.ts
// asserts only self-consistency and would pass on a garbage transcript. TESTING.md requires the corpus and
// thresholds to be frozen before the first implementation, so K65-00 builds the missing executable gate
// here rather than carrying a documentation-only threshold into 0.65.
//
// The chain under test is production: DesktopRuntime -> DialoguePipeline -> TurnController, and for the
// speech leg the real SherpaStreamingAsr adapter with its worker thread. Only the external provider
// boundaries (LLM, TTS, device capture) are doubles, which the SPEC permits; the local model is real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopRuntime } from '../../core/desktop-runtime.js';
import { TurnController } from '../../core/turn-controller.js';
import { NextSpeechInput } from '../../core/speech-bridge.js';
import { LiveVoiceBridge } from '../../core/live-voice-bridge.js';
import { inspectPcmWav } from '../../media/wav.js';
import { MemoryMediaStore } from '../../media/store.js';
import { COMPANION_ID } from '../../contracts/character.js';
import type { DesktopEvent, DialogueContext, TurnScope } from '../../contracts/index.js';
import { deferred, tick } from '../next/harness.js';

const packageRoot = (() => {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolvePath(directory, 'package.json'))) return directory + '/';
    directory = dirname(directory);
  }
  throw new Error('could not locate the desktop-pet package root from ' + import.meta.url);
})();

// --- 00-D frozen corpus and thresholds ------------------------------------------------------------
// Registered by K65-00 BEFORE the 0.65 implementation. Values come from FIX61-08 §6 (measured
// 2026-09-21) and are NOT relaxed afterwards: they are the acceptance line, not a report of whatever
// the machine happens to produce.
const MODEL_DIR = process.env.NEXT_REAL_SHERPA_DIR
  ?? 'F:/AIVoice/toolchains/sherpa-streaming-asr/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';
const FIXTURE_WAV = `${MODEL_DIR}/test_wavs/0.wav`;
/** Frozen reference transcript of the fixture, taken from the model package's own published sample. */
const FIXTURE_REFERENCE = '对我做了介绍那么我想说的是大家如果对我的研究感兴趣';
/** SHA-256 of 0.wav on this machine; pinned here because it was pinned nowhere before K65-00. */
const FIXTURE_WAV_SHA256 = '668BF8DF51A10027B84D5D8816A1CE11AE93545538DC05CFE2AA6811D399C250';
const THRESHOLDS = { cer: 0.20, keywords: ['介绍', '研究', '感兴趣'], firstPartialMs: 1500, finalMs: 10000 } as const;

/** Levenshtein character distance over the normalized transcript, giving CER = distance / reference length. */
function characterErrorRate(reference: string, hypothesis: string): number {
  const a = [...reference], b = [...hypothesis];
  if (!a.length) return b.length ? 1 : 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]! / a.length;
}

// --- A minimal production-port double for the non-provider boundaries ------------------------------
interface Hold { call: number; gate?: ReturnType<typeof deferred<void>>; text?: string; failure?: Error }
interface Harness {
  runtime: DesktopRuntime;
  events: DesktopEvent[];
  appended: { scope: TurnScope; roles: string[]; texts: string[] }[];
  released: string[];
  replyTexts: string[];
  /** Behaviour injected into the Nth dialogue call (1-based), decided before that call is made. */
  hold: Hold;
  captureStopped: TurnScope[];
}

/** Replacements for the external boundaries only; DesktopRuntime/DialoguePipeline/TurnController are real. */
function runtimeHarness(): Harness {
  const events: DesktopEvent[] = [];
  const appended: Harness['appended'] = [];
  const released: string[] = [];
  const replyTexts: string[] = [];
  const captureStopped: TurnScope[] = [];
  const hold: Hold = { call: 0 };
  const media = new MemoryMediaStore();
  const playbackGate = deferred<void>();
  let replyCalls = 0;
  const context = (scope: TurnScope): DialogueContext =>
    ({ scope, characterPrompt: '朋友角色', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 5000 });

  const runtime = new DesktopRuntime({
    outputMode: 'text',
    perception: { perceive: async input => ({ scope: input.scope, transcript: '批量转写', modalities: [], cues: [], status: 'complete' }) },
    dialogue: { reply: async request => {
      replyCalls += 1;
      replyTexts.push(request.text);
      // The hold is consulted per call so a test can inject lateness or failure into a specific turn,
      // including one whose scope id is only known after the controller generated it.
      const applies = hold.call === replyCalls;
      if (applies && hold.gate) await hold.gate.promise;
      if (applies && hold.failure) throw hold.failure;
      const text = applies && hold.text ? hold.text : `回复：${request.text}`;
      return { scope: request.scope, text, expression: { emotion: 'calm', intensity: 0.3, delivery: '温和自然', gesture: null } };
    } },
    tts: { synthesize: async input => ({ scope: input.scope, audio: await media.put(input.scope, new Uint8Array([0, 0, 0, 0]), 'audio/wav'), expression: input.expression, durationMs: 1000, synchronization: 'amplitude' }) },
    playback: { play: async () => { await playbackGate.promise; }, stop: async () => {} },
    memory: {
      context: async scope => context(scope),
      append: async (scope, messages) => { appended.push({ scope, roles: messages.map(m => m.role), texts: messages.map(m => m.text) }); },
      maintain: async () => []
    },
    mediaStore: {
      put: (scope, bytes, mimeType) => media.put(scope, bytes, mimeType),
      read: (scope, asset) => media.read(scope, asset),
      releaseScope: async scope => { released.push(scope.turnId); }
    },
    capture: {
      start: async () => {},
      finish: async scope => ({ scope, audio: { id: 'a', uri: 'mem://a', mimeType: 'audio/wav', temporary: true }, images: [],
        inputEndedAt: '2026-09-21T00:00:00.000Z', captureStoppedAt: '2026-09-21T00:00:00.000Z' }),
      stop: async scope => { captureStopped.push(scope); }
    }
  }, event => events.push(event));

  return { runtime, events, appended, released, replyTexts, hold, captureStopped };
}

const settle = async (predicate: () => boolean, limit = 500): Promise<void> => {
  for (let hop = 0; hop < limit && !predicate(); hop += 1) await tick();
};

let controllerSequence = 0;
function controllerScope(): TurnScope {
  controllerSequence += 1;
  return { characterId: COMPANION_ID, sessionId: 'session-k65', turnId: `turn-k65-${controllerSequence}`, generation: 1 };
}

// --- 00-B: the frozen text / cancel / memory cases on the production runtime ----------------------

test('a text turn through the production DesktopRuntime persists both sides and releases the turn scope', async () => {
  const harness = runtimeHarness();
  await harness.runtime.dispatch({ type: 'submit_text', text: '今天好吗' });
  await harness.runtime.drain();

  assert.deepEqual(harness.appended.map(entry => entry.roles), [['user'], ['assistant']]);
  assert.equal(harness.appended[0]!.texts[0], '今天好吗');
  assert.equal(harness.appended[1]!.texts[0], '回复：今天好吗');
  assert.equal(harness.appended[0]!.scope.turnId, harness.appended[1]!.scope.turnId, 'both records share the turn scope');
  assert.equal(harness.released.length, 1, 'cleanup releases the turn media exactly once on success');
  assert.ok(!harness.runtime.isBusy());
  await harness.runtime.close();
});

test('a newer submit cancels the in-flight turn and the late reply never reaches memory', async () => {
  const harness = runtimeHarness();
  // The first dialogue call is held open BEFORE it is made, so the turn is genuinely in flight.
  const gate = deferred<void>();
  harness.hold.call = 1; harness.hold.gate = gate; harness.hold.text = '迟到的回复';

  await harness.runtime.dispatch({ type: 'submit_text', text: '第一条' });
  await settle(() => harness.replyTexts.length === 1);
  const firstTurnId = harness.appended[0]!.scope.turnId;
  assert.ok(harness.runtime.isBusy(), 'the first turn is genuinely still in flight');

  await harness.runtime.dispatch({ type: 'submit_text', text: '第二条' });
  gate.resolve();
  await harness.runtime.drain();

  const firstTurnAppends = harness.appended.filter(entry => entry.scope.turnId === firstTurnId);
  assert.deepEqual(firstTurnAppends.map(entry => entry.roles), [['user']],
    'the cancelled turn must not write its assistant reply');
  const lateReply = harness.events.some(event => event.type === 'reply' && event.reply.scope.turnId === firstTurnId);
  assert.ok(!lateReply, 'no reply event escapes for the cancelled turn');
  assert.ok(harness.appended.some(entry => entry.texts.includes('回复：第二条')), 'the newer turn still completed');
  await harness.runtime.close();
});

test('an explicit cancel aborts the active turn and still cleans up its resources', async () => {
  const harness = runtimeHarness();
  const gate = deferred<void>();
  harness.hold.call = 1; harness.hold.gate = gate; harness.hold.text = '不应出现';

  await harness.runtime.dispatch({ type: 'submit_text', text: '会被取消' });
  await settle(() => harness.replyTexts.length === 1);
  const turnId = harness.appended[0]!.scope.turnId;

  await harness.runtime.dispatch({ type: 'cancel' });
  gate.resolve();
  await harness.runtime.drain();

  assert.ok(!harness.appended.some(entry => entry.texts.includes('不应出现')), 'a cancelled turn writes nothing further');
  assert.ok(harness.released.includes(turnId), 'cancelling still releases the media scope');
  assert.ok(!harness.runtime.isBusy());
  await harness.runtime.close();
});

test('a provider failure is visible, writes no assistant side, and still releases the scope', async () => {
  const harness = runtimeHarness();
  harness.hold.call = 1; harness.hold.failure = new Error('controlled provider failure');

  await harness.runtime.dispatch({ type: 'submit_text', text: '触发故障' });
  await harness.runtime.drain();

  assert.deepEqual(harness.appended.map(entry => entry.roles), [['user']],
    'the assistant side is not written when the provider fails');
  const error = harness.events.find(event => event.type === 'error');
  assert.ok(error, 'the failure is surfaced to the UI');
  assert.equal(harness.released.length, 1, 'a failed turn still releases its media scope');
  await harness.runtime.close();
});

test('the turn controller remains the single authority: text and voice turns never interleave scopes', () => {
  const controller = new TurnController();
  const text = controller.begin('text', '文字轮');
  const voice = controller.begin('voice');
  assert.equal(text.input.scope.characterId, COMPANION_ID);
  assert.ok(text.signal.aborted, 'starting a voice turn cancels the text turn');
  assert.ok(!controller.accepts(text.input.scope));
  assert.ok(controller.accepts(voice.input.scope));
  assert.equal(voice.input.scope.sessionId, text.input.scope.sessionId, 'one session, one controller');
  controller.resetSession();
  assert.ok(!controller.accepts(voice.input.scope), 'resetSession invalidates the old scope');
});

test('the production voice-input framing constants the CER gate depends on are unchanged', () => {
  const source = readFileSync(packageRoot + 'media/voice-input-session.ts', 'utf8');
  assert.match(source, /export const VOICE_FRAME_SAMPLES = 1600;/);
  assert.match(source, /export const VOICE_MAX_UTTERANCE_MS = 120_000;/);
  assert.match(source, /export const VOICE_FINISH_TIMEOUT_MS = 10_000;/);
});

test('the ASR adapter keeps one worker-based recognizer with configuration-only model paths', async () => {
  const { SherpaStreamingAsr, SHERPA_STREAMING_SAMPLE_RATE } = await import('../../providers/sherpa-streaming-asr.js');
  assert.equal(SHERPA_STREAMING_SAMPLE_RATE, 16000);
  assert.throws(() => new SherpaStreamingAsr({ encoder: '', decoder: 'd', joiner: 'j', tokens: 't' }),
    /Streaming ASR requires a configured encoder path/, 'missing model paths must be refused, not silently defaulted');
  const source = readFileSync(packageRoot + 'providers/sherpa-streaming-asr.ts', 'utf8');
  assert.match(source, /new Worker\(this\.#config\.workerUrl \?\? new URL\('\.\/sherpa-streaming-asr-worker\.js', import\.meta\.url\)/,
    'the recognizer must still run in its own worker thread');
  assert.match(source, /modelType: config\.modelType \?\? 'zipformer'/, 'model paths and type stay configuration, not a whitelist');
});

// --- 00-D: the executable real-model CER gate the 0.61 docs never had -----------------------------

test('00-D real streaming ASR gate: the frozen corpus meets the registered CER, keyword and latency thresholds',
  { timeout: 300000 }, async t => {
    if (!existsSync(FIXTURE_WAV)) {
      return t.skip(`BLOCKED: local streaming model package missing at ${FIXTURE_WAV}; set NEXT_REAL_SHERPA_DIR to a compatible sherpa-onnx streaming package. This is a missing-resource BLOCKED, not a pass.`);
    }
    const bytes = new Uint8Array(readFileSync(FIXTURE_WAV));
    const parsed = inspectPcmWav(bytes);
    assert.equal(parsed.sampleRate, 16000, 'the frozen fixture must be 16 kHz mono PCM16');

    // The fixture must be the registered corpus, not merely a file at the registered path.
    const digest = createHash('sha256').update(bytes).digest('hex').toUpperCase();
    assert.equal(digest, FIXTURE_WAV_SHA256,
      `${FIXTURE_WAV} does not match the pinned digest; a changed corpus invalidates the registered CER threshold`);

    const { SherpaStreamingAsr } = await import('../../providers/sherpa-streaming-asr.js');
    const finals: string[] = [];
    const partialTimes: number[] = [];
    const submissions: string[] = [];
    const input = new NextSpeechInput(async text => { submissions.push(text); return controllerScope(); }, {
      onSegmentFinal: segment => finals.push(segment.text),
    });
    const startedAt = Date.now();
    const asr = new SherpaStreamingAsr({
      encoder: `${MODEL_DIR}/encoder-epoch-99-avg-1.int8.onnx`,
      decoder: `${MODEL_DIR}/decoder-epoch-99-avg-1.onnx`,
      joiner: `${MODEL_DIR}/joiner-epoch-99-avg-1.int8.onnx`,
      tokens: `${MODEL_DIR}/tokens.txt`,
    });
    const bridge = new LiveVoiceBridge({ asr, input, onInterim: () => partialTimes.push(Date.now() - startedAt) });
    const scope: TurnScope = { characterId: COMPANION_ID, sessionId: 'session-k65', turnId: 'turn-k65-cer', generation: 1 };
    try {
      await bridge.start(scope, parsed.sampleRate);
      const samples = new Int16Array(parsed.data.buffer, parsed.data.byteOffset, parsed.data.length / 2);
      const frame = 1600;
      for (let offset = 0; offset < samples.length; offset += frame) {
        const slice = Buffer.from(samples.buffer, samples.byteOffset + offset * 2, Math.min(frame, samples.length - offset) * 2);
        await bridge.push(new Uint8Array(slice), parsed.sampleRate);
      }
      assert.ok(partialTimes.length > 0, 'a partial must arrive while the utterance is still being fed');
      const finishing = Date.now();
      await bridge.finish(scope, new AbortController().signal);
      const finalMs = Date.now() - finishing;
      await input.stop();

      const transcript = finals.join('').trim();
      const normalized = transcript.replace(/[\s，。、？！,.]/g, '');
      const cer = characterErrorRate(FIXTURE_REFERENCE, normalized);
      const missing = THRESHOLDS.keywords.filter(keyword => !normalized.includes(keyword));
      t.diagnostic(`[k65-cer] parts=${partialTimes.length} firstPartialMs=${partialTimes[0]} finalMs=${finalMs} cer=${cer.toFixed(4)} text=${JSON.stringify(transcript)}`);

      assert.ok(cer <= THRESHOLDS.cer, `CER ${cer.toFixed(4)} exceeds the registered maximum ${THRESHOLDS.cer} (reference: ${FIXTURE_REFERENCE}; got: ${normalized})`);
      assert.deepEqual(missing, [], `required keywords missing from the transcript: ${missing.join(', ')}`);
      assert.ok(partialTimes[0]! <= THRESHOLDS.firstPartialMs, `first partial at ${partialTimes[0]} ms exceeds the registered ${THRESHOLDS.firstPartialMs} ms`);
      assert.ok(finalMs <= THRESHOLDS.finalMs, `final at ${finalMs} ms exceeds the registered ${THRESHOLDS.finalMs} ms`);
      assert.deepEqual(submissions, [transcript], 'the release submits exactly one turn carrying the real transcript');
    } finally {
      await bridge.cancel();
      await asr.close().catch(() => {});
    }
  });
