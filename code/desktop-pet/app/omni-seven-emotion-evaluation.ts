import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CapturedInput } from '../contracts/index.js';
import { MemoryMediaStore } from '../media/store.js';
import { inspectPcmWav } from '../media/wav.js';
import { checkAbort } from '../media/scope.js';
import { type EndpointConfig, type JsonRecord, type ProviderTransport } from '../providers/transport.js';
import { OMNI_SEVEN_EMOTIONS, OMNI_SEVEN_EMOTION_PROMPT, isOmniEmotion, historicalNineFrameOmniRequest, parseOmniEmotion,
  type OmniEmotion, type OmniEmotionResponse } from '../providers/omni-seven-emotion.js';

export const OMNI_EVALUATION_MODEL = 'qwen3.5-omni-flash-2026-03-15';
export const OMNI_EVALUATION_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
export const OMNI_EVALUATION_MAX_TOKENS = 512;
export interface OmniEvaluationSample {
  id: string; label: OmniEmotion; actor: string; expectedTranscript: string;
  sourcePath: string; sourceSha256: string; sourceArchive: string; sourceMember: string;
  audioPath: string; audioSha256: string; durationSeconds: number;
  images: { path: string; sha256: string; atSeconds: number }[];
}
export interface OmniEvaluationManifest {
  schemaVersion: 1; status: 'ready'; dataset: unknown; sampling: unknown; samples: OmniEvaluationSample[];
}
export type OmniCondition = 'audio' | 'av';
export interface OmniCaseRecord {
  id: string; condition: OmniCondition; expected: OmniEmotion;
  status: 'valid' | 'failed'; prediction: OmniEmotionResponse | null; correct: boolean | null;
  requestElapsedMs: number | null; rawResponse: JsonRecord | null;
  failure: { stage: string; name: string } | null;
}
export interface OmniEvaluationOptions {
  config: EndpointConfig; transport: Pick<ProviderTransport, 'request'>; signal: AbortSignal;
  writeRecord(record: { type: 'started'; id: string; condition: OmniCondition; requestSha256: string; promptSha256: string }
    | { type: 'case'; record: OmniCaseRecord } | { type: 'finished'; report: OmniEvaluationReport }): Promise<void>;
}
export interface OmniEvaluationReport {
  status: 'completed' | 'failed_stopped_no_retry'; planned: number; cases: OmniCaseRecord[];
  unrun: { id: string; condition: OmniCondition }[];
  metrics: ReturnType<typeof omniEvaluationMetrics>;
  prompt: string; promptSha256: string; maxOutputTokens: number; model: string;
  latencyDefinition: string; limitation: string;
}
const hash = (v: Uint8Array | string): string => createHash('sha256').update(v).digest('hex');
const invalid = (): never => { throw new Error('Invalid frozen Omni evaluation manifest'); };
async function bytesAt(path: string, expected: string): Promise<Uint8Array> {
  if (typeof path !== 'string' || !isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expected)) invalid();
  const bytes = await readFile(path);
  if (hash(bytes) !== expected) { bytes.fill(0); throw new Error('Frozen Omni media hash mismatch'); }
  const copy = new Uint8Array(bytes); bytes.fill(0); return copy;
}
interface Prepared { sample: OmniEvaluationSample; audio: Uint8Array; images: Uint8Array[] }
async function prepare(manifest: OmniEvaluationManifest, signal: AbortSignal): Promise<Prepared[]> {
  if (manifest.schemaVersion !== 1 || manifest.status !== 'ready' || !Array.isArray(manifest.samples) || manifest.samples.length !== 14) invalid();
  const counts = new Map<OmniEmotion, number>(); const prepared: Prepared[] = [];
  for (const [i, sample] of manifest.samples.entries()) {
    if (sample.id !== 's' + String(i + 1).padStart(2, '0') || !isOmniEmotion(sample.label)
      || !Array.isArray(sample.images) || sample.images.length !== 9 || !Number.isFinite(sample.durationSeconds) || sample.durationSeconds <= 0) invalid();
    counts.set(sample.label, (counts.get(sample.label) ?? 0) + 1);
    for (const [j, image] of sample.images.entries())
      if (!Number.isFinite(image.atSeconds) || Math.abs(image.atSeconds - sample.durationSeconds * (j + .5) / 9) > .00001) invalid();
  }
  if (OMNI_SEVEN_EMOTIONS.some(label => counts.get(label) !== 2)) invalid();
  try {
    for (const sample of manifest.samples) {
      checkAbort(signal);
      const source = await bytesAt(sample.sourcePath, sample.sourceSha256); source.fill(0);
      const audio = await bytesAt(sample.audioPath, sample.audioSha256), item = { sample, audio, images: [] as Uint8Array[] };
      prepared.push(item);
      const wav = inspectPcmWav(audio);
      if (wav.sampleRate !== 16000 || wav.channels !== 1 || Math.abs(wav.durationMs / 1000 - sample.durationSeconds) > .25) invalid();
      for (const image of sample.images) {
        const bytes = await bytesAt(image.path, image.sha256); item.images.push(bytes);
        if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) invalid();
      }
    }
    checkAbort(signal); return prepared;
  } catch (error) { prepared.forEach(p => { p.audio.fill(0); p.images.forEach(b => b.fill(0)); }); throw error; }
}
export function omniEvaluationOrder(samples: readonly OmniEvaluationSample[]): { id: string; condition: OmniCondition }[] {
  return samples.flatMap((sample, i) => (i % 2 ? ['av', 'audio'] as const : ['audio', 'av'] as const).map(condition => ({ id: sample.id, condition })));
}
export function omniEvaluationMetrics(cases: readonly OmniCaseRecord[]) {
  return Object.fromEntries((['audio', 'av'] as const).map(condition => {
    const attempted = cases.filter(c => c.condition === condition), valid = attempted.filter(c => c.status === 'valid');
    const matrix = OMNI_SEVEN_EMOTIONS.map(label => OMNI_SEVEN_EMOTIONS.map(prediction => valid.filter(c => c.expected === label && c.prediction?.emotion === prediction).length));
    const durations = valid.map(c => c.requestElapsedMs!).sort((a, b) => a - b), n = durations.length;
    return [condition, {
      planned: 14, attempted: attempted.length, formatSuccess: valid.length,
      formatSuccessRate: attempted.length ? valid.length / attempted.length : null,
      correct: valid.filter(c => c.correct).length, accuracy: valid.length ? valid.filter(c => c.correct).length / valid.length : null,
      classes: OMNI_SEVEN_EMOTIONS.map((label, i) => {
        const completed = matrix[i]!.reduce((a, b) => a + b, 0), correct = matrix[i]![i]!;
        return { label, planned: 2, completed, correct, recall: completed ? correct / completed : null };
      }),
      confusion: { labels: [...OMNI_SEVEN_EMOTIONS], rows: 'expected', columns: 'predicted', counts: matrix },
      latency: { n, rawMs: valid.map(c => c.requestElapsedMs), medianMs: n ? (durations[Math.floor((n - 1) / 2)]! + durations[Math.floor(n / 2)]!) / 2 : null,
        p95Ms: n ? durations[Math.ceil(n * .95) - 1] : null, method: 'Median midpoint; P95 nearest rank; valid responses only, failures retain individual elapsed time.' },
    }];
  }));
}
/** I supplies the sole shared-ledger authorizer, key closure and raw-SSE recording transport.
 * No credentials, ledger paths, device APIs, command execution or automatic CLI in this module. */
export async function evaluateOmniSevenEmotion(input: OmniEvaluationManifest, options: OmniEvaluationOptions): Promise<OmniEvaluationReport> {
  const manifest = structuredClone(input), config = Object.freeze({ ...options.config });
  if (config.model !== OMNI_EVALUATION_MODEL || config.endpoint !== OMNI_EVALUATION_ENDPOINT) throw new Error('Unregistered Omni evaluation endpoint/model');
  const prepared = await prepare(manifest, options.signal), order = omniEvaluationOrder(manifest.samples);
  const report: OmniEvaluationReport = { status: 'completed', planned: order.length, cases: [], unrun: [...order], metrics: {},
    prompt: OMNI_SEVEN_EMOTION_PROMPT, promptSha256: hash(OMNI_SEVEN_EMOTION_PROMPT), maxOutputTokens: OMNI_EVALUATION_MAX_TOKENS, model: config.model,
    latencyDefinition: 'Transport request invocation through resolution/rejection, including authorization, network, SSE parsing and settlement; excludes media preparation; not first-audible latency.',
    limitation: '14 fixed acted English clips from two actors; not Chinese conversation, continuous-video reasoning or product acceptance. Accuracy/recall denominators include only valid completed classifications.' };
  try {
    for (const item of order) {
      const media = prepared.find(p => p.sample.id === item.id)!, store = new MemoryMediaStore();
      const scope = Object.freeze({ characterId: 'companion', sessionId: 'omni-seven-emotion-evaluation', turnId: item.id + '-' + item.condition, generation: 1 });
      const record: OmniCaseRecord = { ...item, expected: media.sample.label, status: 'failed', prediction: null, correct: null,
        requestElapsedMs: null, rawResponse: null, failure: null };
      let stage = 'prepare', started: number | undefined;
      try {
        checkAbort(options.signal);
        const audio = await store.put(scope, media.audio, 'audio/wav'), images = [];
        if (item.condition === 'av') for (const bytes of media.images) images.push(await store.put(scope, bytes, 'image/jpeg'));
        const captured: CapturedInput = { scope, audio, images, inputEndedAt: '2000-01-01T00:00:00.000Z', captureStoppedAt: '2000-01-01T00:00:00.000Z' };
        const body = await historicalNineFrameOmniRequest(captured, store, options.signal, OMNI_EVALUATION_MAX_TOKENS);
        stage = 'started_record';
        await options.writeRecord({ type: 'started', ...item, requestSha256: hash(JSON.stringify({ ...body, model: config.model })), promptSha256: report.promptSha256 });
        stage = 'request'; started = performance.now();
        record.rawResponse = await options.transport.request(config, scope, 'perception', body, options.signal);
        record.requestElapsedMs = performance.now() - started;
        stage = 'parse'; checkAbort(options.signal); record.prediction = parseOmniEmotion(record.rawResponse.text);
        record.correct = record.prediction.emotion === media.sample.label; record.status = 'valid';
      } catch (error) {
        if (started !== undefined && record.requestElapsedMs === null) record.requestElapsedMs = performance.now() - started;
        record.failure = { stage, name: error instanceof Error ? error.name : 'unknown' }; report.status = 'failed_stopped_no_retry';
      } finally { await store.releaseScope(scope); }
      report.cases.push(record); report.unrun = order.slice(report.cases.length);
      await options.writeRecord({ type: 'case', record: structuredClone(record) });
      if (record.status === 'failed') break;
    }
    report.metrics = omniEvaluationMetrics(report.cases);
    await options.writeRecord({ type: 'finished', report: structuredClone(report) }); return report;
  } finally { prepared.forEach(p => { p.audio.fill(0); p.images.forEach(b => b.fill(0)); }); }
}
