// NEXT-06 06-E real replay: the official whisper.cpp server (hash-pinned binaries and model, see
// CORPUS_MANIFEST §4) transcribes the frozen sample and the silence negative; the recognition
// result flows through the legacy-derived cleaning rules and the production NextSpeechInput →
// NextTurnPort chain, so the turn only exists when real speech was recognized. The multipart
// request and the cleaning port are harness (ported from Legacy whisperClient.ts@30269c6, blob
// eb13848c52e67592f6adfa77f7ed08460a5aa4f0); the recognition service, the input adapter and the
// turn chain are production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextSpeechInput } from '../../../core/speech-bridge.js';
import { NextTurnPort, type TurnPortEvent } from '../../../core/turn-port.js';
import { offlinePorts } from '../harness.js';

const ENDPOINT = (process.env.NEXT_REAL_WHISPER_ENDPOINT ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const SAMPLE = process.env.NEXT_REAL_ASR_SAMPLE ?? 'F:/AIVoice/toolchains/whisper-b5130/jfk.wav';
/** Frozen allowed transcription of the official jfk.wav (normalized, from the 2026-09-20 replay). */
const FROZEN_TEXT = 'and so my fellow americans ask not what your country can do for you ask what you can do for your country';

// --- Ported from Legacy aika-crossplatform/src/services/voice/whisperClient.ts@30269c6 ---
// whisper.cpp renders non-speech as [BLANK_AUDIO]/(music) markers and silence can produce fixed
// hallucinations; the same cleaning rules apply before anything reaches the turn chain.
const HALLUCINATIONS = [
  'ご視聴ありがとうございました',
  'ご清聴ありがとうございました',
  '字幕by',
  '字幕製作',
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  '訂閱',
  '谢谢观看',
  '謝謝觀看'
];

export function stripMarkers(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\*[^*]*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isLikelyHallucination(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[\s。．，、.,!！?？~〜-]/g, '');
  if (!normalized) return true;
  return HALLUCINATIONS.some(phrase => normalized === phrase.toLowerCase().replace(/\s/g, ''));
}

function cleanAsrText(text: string): string {
  const cleaned = stripMarkers(text);
  return isLikelyHallucination(cleaned) ? '' : cleaned;
}

const normalize = (text: string): string => text.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();

async function probe(): Promise<boolean> {
  try {
    const response = await fetch(`${ENDPOINT}/`, { signal: AbortSignal.timeout(2000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function transcribe(bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'turn.wav');
  form.append('language', 'auto');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  form.append('no_context', 'true');
  const response = await fetch(`${ENDPOINT}/inference`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`whisper-server returned ${response.status}`);
  const data = await response.json() as { text?: unknown };
  return typeof data.text === 'string' ? data.text : '';
}

function makeChain(): { port: NextTurnPort; events: TurnPortEvent[]; submits: string[]; waitForTerminal(): Promise<Extract<TurnPortEvent, { type: 'terminal' }>> } {
  const events: TurnPortEvent[] = [];
  const submits: string[] = [];
  const port = new NextTurnPort(offlinePorts(async request => ({
    scope: request.scope,
    text: `回复：${request.text}`,
    expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null }
  })));
  port.subscribe(event => events.push(event));
  const waitForTerminal = () => new Promise<Extract<TurnPortEvent, { type: 'terminal' }>>(done => {
    const seen = events.find(event => event.type === 'terminal');
    if (seen) return done(seen);
    const unsubscribe = port.subscribe(event => {
      if (event.type === 'terminal') { unsubscribe(); done(event); }
    });
  });
  return { port, events, submits, waitForTerminal };
}

test('06-E real: the frozen sample transcribes and submits exactly once through the input chain', { timeout: 180000 }, async t => {
  if (!(await probe())) return t.skip(`whisper-server not reachable at ${ENDPOINT} (see CORPUS_MANIFEST §4 for the toolchain)`);
  let bytes: Uint8Array;
  try { bytes = await readFile(SAMPLE); } catch { return t.skip(`frozen sample missing: ${SAMPLE}`); }

  const raw = await transcribe(bytes);
  const text = cleanAsrText(raw);
  assert.equal(normalize(text), FROZEN_TEXT, `unexpected transcription: ${JSON.stringify(raw)}`);

  const chain = makeChain();
  const input = new NextSpeechInput(async value => {
    chain.submits.push(value);
    return chain.port.submit({ text: value });
  });
  input.feed({ inputSessionId: 'in-1', segmentId: 's1', index: 0, text, audioEndMs: 1000, timeSource: 'audio' });
  await input.stop();

  assert.deepEqual(chain.submits, [text]);
  const accepted = chain.events.find(event => event.type === 'accepted');
  assert.ok(accepted && accepted.type === 'accepted' && accepted.text === text);
  const terminal = await chain.waitForTerminal();
  assert.equal(terminal.status, 'completed');
  const terminals = chain.events.filter(event => event.type === 'terminal');
  assert.equal(terminals.length, 1);
  console.log(`[real-asr] sample=${SAMPLE} bytes=${bytes.length} raw=${JSON.stringify(raw.trim())}`);
});

test('06-E real: silence produces no user message', { timeout: 60000 }, async t => {
  if (!(await probe())) return t.skip(`whisper-server not reachable at ${ENDPOINT} (see CORPUS_MANIFEST §4 for the toolchain)`);
  const dir = await mkdtemp(join(tmpdir(), 'next-real-asr-'));
  try {
    // Deterministic 2 s of digital silence at 16 kHz mono 16-bit (hash recorded in the report).
    const silence = new Uint8Array(32000 * 2);
    const view = new DataView(silence.buffer);
    const tag = (offset: number, text: string) => silence.set(new TextEncoder().encode(text), offset);
    tag(0, 'RIFF'); view.setUint32(4, silence.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    tag(36, 'data'); view.setUint32(40, silence.length - 44, true);
    const silencePath = join(dir, 'silence.wav');
    await writeFile(silencePath, silence);

    const raw = await transcribe(silence);
    const text = cleanAsrText(raw);
    assert.equal(text, '', `whisper rendered silence as ${JSON.stringify(raw)}; the negative case must not become a user message`);

    const chain = makeChain();
    const input = new NextSpeechInput(async value => {
      chain.submits.push(value);
      return chain.port.submit({ text: value });
    });
    if (text) input.feed({ inputSessionId: 'in-1', segmentId: 's1', index: 0, text, audioEndMs: 1000, timeSource: 'audio' });
    await input.stop();
    assert.equal(chain.submits.length, 0);
    assert.equal(chain.events.length, 0);
    console.log(`[real-asr] silence raw=${JSON.stringify(raw.trim())} cleaned='' submits=0`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
