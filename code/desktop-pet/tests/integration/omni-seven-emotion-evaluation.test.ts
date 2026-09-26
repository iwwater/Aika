import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pcm16Wav } from '../../media/wav.js';
import { ProviderTransport, type CallOutcome } from '../../providers/transport.js';
import { OMNI_SEVEN_EMOTIONS } from '../../providers/omni-seven-emotion.js';
import { evaluateOmniSevenEmotion, omniEvaluationOrder, omniEvaluationMetrics, OMNI_EVALUATION_MODEL, OMNI_EVALUATION_ENDPOINT,
  type OmniEvaluationManifest, type OmniEvaluationOptions, type OmniCaseRecord } from '../../app/omni-seven-emotion-evaluation.js';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function fixture(t: TestContext) {
  const parent = resolve('../../.local/ptt-onset-01/test-runs'); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'case-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = Uint8Array.of(1, 2, 3, 4), audio = pcm16Wav(new Float32Array(1600).fill(.1), 16000), image = Uint8Array.of(255, 216, 0, 0, 255, 217);
  await writeFile(join(dir, 'source.mp4'), source); await writeFile(join(dir, 'audio.wav'), audio); await writeFile(join(dir, 'image.jpg'), image);
  const manifest: OmniEvaluationManifest = { schemaVersion: 1, status: 'ready', dataset: { name: 'synthetic only' }, sampling: {}, samples: Array.from({ length: 14 }, (_, i) => ({
    id: 's' + String(i + 1).padStart(2, '0'), label: OMNI_SEVEN_EMOTIONS[i % 7]!, actor: i < 7 ? '01' : '02',
    expectedTranscript: 'EXPECTED_TRANSCRIPT_MUST_NOT_LEAK', sourcePath: join(dir, 'source.mp4'), sourceSha256: sha(source),
    sourceArchive: 'SOURCE_URL_MUST_NOT_LEAK', sourceMember: 'EMOTION_FILENAME_MUST_NOT_LEAK', audioPath: join(dir, 'audio.wav'), audioSha256: sha(audio), durationSeconds: .1,
    images: Array.from({ length: 9 }, (_, j) => ({ path: join(dir, 'image.jpg'), sha256: sha(image), atSeconds: .1 * (j + .5) / 9 })),
  })) };
  const events: Parameters<OmniEvaluationOptions['writeRecord']>[0][] = [], outcomes: CallOutcome[] = [];
  let network = 0, keys = 0, deny = false;
  const config = { model: OMNI_EVALUATION_MODEL, endpoint: OMNI_EVALUATION_ENDPOINT, apiKey: () => { keys++; return 'SYNTHETIC_KEY'; },
    authorizer: { async authorize() { if (deny) throw new Error('Synthetic budget denial'); return { async settle(outcome: CallOutcome) { outcomes.push(outcome); } }; } } };
  let response = (i: number) => ({ text: 'Hello.', emotion: manifest.samples.find(s => s.id === events.filter(e => e.type === 'started').at(-1)!.id)!.label as string, bad: false, http: 200 });
  const transport = new ProviderTransport(async (_url, init) => {
    const starts = events.filter(e => e.type === 'started'); assert.equal(starts.length, network + 1, 'checkpoint before every POST');
    const body = JSON.parse(String(init?.body)), input = body.messages[0].content;
    assert.equal(body.max_tokens, 512); assert.equal(body.model, OMNI_EVALUATION_MODEL);
    // Fixed on input 265ef6c before the production three-frame change, using this synthetic fixture.
    const expectedHash = starts.at(-1)!.condition === 'av'
      ? 'af203481250ea7408d233cb2f502f1dfa8f9a8363df47ca676966013307b4aab'
      : '6852cbcc1015e026ae1602fb64bdbb4ba9c3401a3d9386cdfa5c7326c5796c9b';
    assert.equal(createHash('sha256').update(String(init?.body)).digest('hex'), expectedHash, 'historical request protocol is unchanged');
    assert.ok(!String(init?.body).includes('MUST_NOT_LEAK')); assert.ok(!String(init?.body).includes(dir));
    assert.deepEqual(new Uint8Array(Buffer.from(input[0].input_audio.data.split(',')[1], 'base64')), audio, 'paired audio remains intact after previous calls');
    assert.equal(input.length, starts.at(-1)!.condition === 'av' ? 11 : 2);
    const result = response(network++); if (result.http !== 200) return new Response('controlled HTTP failure', { status: result.http });
    const text = JSON.stringify({ transcript: result.text, emotion: result.emotion, ...(result.bad ? { cues: [] } : {}) });
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 }, id: 'synthetic-' + network }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const options: OmniEvaluationOptions = { config, transport, signal: new AbortController().signal, async writeRecord(e) { events.push(e); } };
  return { manifest, options, events, outcomes, network: () => network, keys: () => keys, deny: () => { deny = true; }, response: (r: typeof response) => { response = r; } };
}
test('28 paired conditions run in fixed alternating order, preserve labels locally and continue wrong classifications', async t => {
  const f = await fixture(t);
  f.response(i => ({ text: 'Hello.', emotion: i === 0 ? 'sad' : f.manifest.samples.find(s => s.id === f.events.filter(e => e.type === 'started').at(-1)!.id)!.label, bad: false, http: 200 }));
  const report = await evaluateOmniSevenEmotion(f.manifest, f.options);
  assert.equal(f.network(), 28); assert.equal(report.status, 'completed'); assert.equal(report.unrun.length, 0);
  assert.deepEqual(report.cases.map(c => c.id + '-' + c.condition), omniEvaluationOrder(f.manifest.samples).map(c => c.id + '-' + c.condition));
  assert.deepEqual(report.cases.slice(0, 4).map(c => c.condition), ['audio', 'av', 'av', 'audio']);
  assert.equal(report.metrics.audio!.correct, 13); assert.equal(report.metrics.av!.correct, 14);
  assert.equal(report.metrics.audio!.accuracy, 13 / 14); assert.equal(report.metrics.audio!.classes[0]!.recall, .5);
  assert.equal(report.metrics.audio!.confusion.counts[0]![2], 1);
  assert.ok(report.cases.every(c => c.rawResponse?.text && c.requestElapsedMs! >= 0)); assert.equal(f.outcomes.length, 28);
});
test('protocol failure preserves raw output and stops after earlier valid misclassification without retry', async t => {
  const f = await fixture(t); f.response(i => ({ text: 'Hello.', emotion: 'sad', bad: i === 1, http: 200 }));
  const report = await evaluateOmniSevenEmotion(f.manifest, f.options);
  assert.equal(report.status, 'failed_stopped_no_retry'); assert.equal(f.network(), 2); assert.equal(report.unrun.length, 26);
  assert.equal(report.cases[0]!.correct, false); assert.equal(report.cases[1]!.failure!.stage, 'parse');
  assert.match(String(report.cases[1]!.rawResponse!.text), /cues/); assert.equal(report.metrics.av!.formatSuccess, 0);
  assert.equal(report.metrics.av!.accuracy, null);
});
test('HTTP errors stop after one actual request; no model JSON is invented', async t => {
  const f = await fixture(t); f.response(() => ({ text: '', emotion: 'neutral', bad: false, http: 503 }));
  const report = await evaluateOmniSevenEmotion(f.manifest, f.options);
  assert.equal(f.network(), 1); assert.equal(report.cases[0]!.rawResponse, null); assert.equal(report.cases[0]!.failure!.stage, 'request');
  assert.equal(report.unrun.length, 27); assert.equal(f.outcomes[0]!.status, 'failed');
});
test('budget rejection prevents network access and stops, even with a prepared started record', async t => {
  const f = await fixture(t); f.deny(); const report = await evaluateOmniSevenEmotion(f.manifest, f.options);
  assert.equal(f.network(), 0); assert.equal(report.status, 'failed_stopped_no_retry'); assert.equal(report.cases[0]!.failure!.stage, 'request');
});
test('entire frozen manifest is checked before any key or request, including the last frame', async t => {
  const f = await fixture(t); f.manifest.samples[13]!.images[8]!.sha256 = '0'.repeat(64);
  await assert.rejects(evaluateOmniSevenEmotion(f.manifest, f.options), /hash mismatch/);
  assert.equal(f.keys(), 0); assert.equal(f.events.length, 0); assert.equal(f.network(), 0);
});
test('unbalanced labels, non-nine timing and unregistered models fail before any request', async t => {
  const f = await fixture(t), wrongLabels = structuredClone(f.manifest); wrongLabels.samples[0]!.label = 'happy';
  await assert.rejects(evaluateOmniSevenEmotion(wrongLabels, f.options), /manifest/);
  const wrongTime = structuredClone(f.manifest); wrongTime.samples[0]!.images[0]!.atSeconds = 0;
  await assert.rejects(evaluateOmniSevenEmotion(wrongTime, f.options), /manifest/);
  await assert.rejects(evaluateOmniSevenEmotion(f.manifest, { ...f.options, config: { ...f.options.config, model: 'other' } }), /Unregistered/);
  assert.equal(f.keys(), 0);
});
test('a failed pre-request checkpoint cannot be bypassed to invoke the model', async t => {
  const f = await fixture(t), report = await evaluateOmniSevenEmotion(f.manifest, { ...f.options, async writeRecord(e) { if (e.type === 'started') throw new Error('controlled disk error'); } });
  assert.equal(f.network(), 0); assert.equal(f.keys(), 0); assert.equal(report.cases[0]!.failure!.stage, 'started_record');
});
test('metric denominators, median and nearest-rank P95 use completed classifications, not skipped samples', () => {
  const records: OmniCaseRecord[] = [10, 20, 30, 40].map(ms => ({ id: 'synthetic', condition: 'audio', expected: 'neutral', status: 'valid',
    prediction: { transcript: '', emotion: 'neutral' }, correct: true, requestElapsedMs: ms, rawResponse: null, failure: null }));
  records.push({ ...records[0]!, status: 'failed', prediction: null, correct: null, requestElapsedMs: 100 });
  const metrics = omniEvaluationMetrics(records);
  assert.equal(metrics.audio!.formatSuccessRate, .8); assert.equal(metrics.audio!.latency.medianMs, 25); assert.equal(metrics.audio!.latency.p95Ms, 40);
  assert.equal(metrics.av!.accuracy, null); assert.equal(metrics.av!.classes[0]!.recall, null);
});
