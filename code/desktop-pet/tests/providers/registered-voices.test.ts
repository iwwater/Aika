import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { RegisteredVoiceStore, assertRegisteredVoiceBinding, type RegisteredVoice, type VoiceBindingKey } from '../../providers/registered-voices.js';
import { QWEN_AUDIO_TTS_ENDPOINT, QWEN_AUDIO_TTS_PLUS_MODEL } from '../../providers/qwen-audio-tts.js';

const record = (voiceId = 'dania-synthetic-001'): RegisteredVoice => ({ voiceId, label: 'example-voice 合成测试记录', provider: 'dashscope',
  endpoint: QWEN_AUDIO_TTS_ENDPOINT, targetModel: QWEN_AUDIO_TTS_PLUS_MODEL, credentialRef: 'dashscope-123456abcdef',
  referenceSha256: 'a'.repeat(64), createdAt: '2026-09-11T00:00:00.000Z' });
const key = (voice = record()): VoiceBindingKey => ({ voiceId: voice.voiceId, provider: voice.provider,
  endpoint: voice.endpoint, targetModel: voice.targetModel, credentialRef: voice.credentialRef });
async function setup(t: TestContext) {
  const parent = resolve('../../.local/minimax-default-01/test-runs'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'registry-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'registered-voices.json'); return { file, directory, store: await RegisteredVoiceStore.open(file) };
}

test('a missing registry is empty and remains absent until a successful registration', async t => {
  const run = await setup(t); assert.deepEqual(run.store.snapshot(), { version: 1, revision: 0, voices: [] });
  await assert.rejects(stat(run.file), { code: 'ENOENT' });
  assert.throws(() => run.store.resolve(key()), { code: 'unregistered_voice' });
  await run.store.drain(); assert.deepEqual(await readdir(run.directory), []);
});

test('append persists exact safe metadata with restrictive permissions and restores bindings on reopen', async t => {
  const run = await setup(t), voice = record(), saved = await run.store.register(0, voice);
  assert.equal(saved.revision, 1); assert.deepEqual(saved.voices, [voice]);
  const serialized = JSON.parse(await readFile(run.file, 'utf8'));
  assert.deepEqual(serialized, saved); assert.equal((await stat(run.file)).mode & 0o777, 0o600);
  const restored = await RegisteredVoiceStore.open(run.file);
  assert.deepEqual(restored.snapshot(), saved); assertRegisteredVoiceBinding(restored.resolve(key()), key());
  await run.store.drain(); assert.deepEqual(await readdir(run.directory), ['registered-voices.json']);
});

test('returned snapshots and issued bindings are immutable; only store-issued identity passes', async t => {
  const run = await setup(t); const before = run.store.snapshot(); await run.store.register(0, record());
  const current = run.store.snapshot(), binding = run.store.resolve(key());
  assert.deepEqual(before.voices, []); assert.equal(before.revision, 0);
  assert.throws(() => Object.assign(current, { revision: 8 }), TypeError);
  assert.throws(() => (current.voices as RegisteredVoice[]).push(record('other')), TypeError);
  assert.throws(() => Object.assign(current.voices[0]!, { voiceId: 'other' }), TypeError);
  assert.throws(() => Object.assign(binding, { credentialRef: 'dashscope-abcdef123456' }), TypeError);
  for (const candidate of [record(), { ...binding }, JSON.parse(JSON.stringify(binding)), null])
    assert.throws(() => assertRegisteredVoiceBinding(candidate, key()), { code: 'unregistered_voice' });
  assertRegisteredVoiceBinding(binding, key());
});

test('every binding dimension is exact; unknown and cross-model/endpoint/credential voices reject', async t => {
  const run = await setup(t); await run.store.register(0, record()); const binding = run.store.resolve(key());
  for (const changed of [{ voiceId: 'dania-synthetic-unknown' }, { provider: 'deepseek' },
    { endpoint: 'https://other.invalid/tts' }, { targetModel: 'qwen-audio-3.0-tts-flash' }, { credentialRef: 'dashscope-abcdef123456' }]) {
    const mismatch = { ...key(), ...changed } as VoiceBindingKey;
    assert.throws(() => run.store.resolve(mismatch), /Registered voice/);
    assert.throws(() => assertRegisteredVoiceBinding(binding, mismatch), { code: 'binding_mismatch' });
  }
});

test('record shape rejects secrets, URLs, unsupported provider/model/endpoint and malformed metadata', async t => {
  const run = await setup(t);
  for (const changed of [{ apiKey: 'synthetic-secret-not-written' }, { signedUrl: 'https://synthetic.invalid/?Signature=x' },
    { voiceId: 'https://synthetic.invalid/voice' }, { provider: 'deepseek' }, { targetModel: 'unknown-model' },
    { endpoint: QWEN_AUDIO_TTS_ENDPOINT + '?Signature=x' }, { credentialRef: '/synthetic/key/path' },
    { referenceSha256: 'wrong' }, { createdAt: 'yesterday' }, { label: 'bad\nlabel' }]) {
    await assert.rejects(run.store.register(0, { ...record(), ...changed } as RegisteredVoice), { code: 'invalid_registry' });
  }
  assert.equal(run.store.snapshot().revision, 0); assert.deepEqual(await readdir(run.directory), []);
});

test('invalid file versions, extra fields, duplicate IDs and inconsistent revisions fail closed without rewriting', async t => {
  const run = await setup(t);
  const valid = { version: 1, revision: 1, voices: [record()] };
  for (const value of [{ ...valid, version: 2 }, { ...valid, revision: -1 }, { ...valid, revision: 2 },
    { ...valid, revision: 2, voices: [record(), record()] }, { ...valid, secret: 'synthetic' },
    { ...valid, voices: [{ ...record(), referenceSha256: 'invalid' }] }, null]) {
    const original = JSON.stringify(value); await writeFile(run.file, original);
    await assert.rejects(RegisteredVoiceStore.open(run.file), { code: 'invalid_registry' });
    assert.equal(await readFile(run.file, 'utf8'), original);
  }
  await writeFile(run.file, '{unfinished'); await assert.rejects(RegisteredVoiceStore.open(run.file), { code: 'invalid_registry' });
  assert.equal(await readFile(run.file, 'utf8'), '{unfinished');
});

test('stale expected revisions and duplicate registrations cannot overwrite the previous immutable record', async t => {
  const run = await setup(t); const saved = await run.store.register(0, record()), bytes = await readFile(run.file, 'utf8');
  await assert.rejects(run.store.register(0, record('second')), { code: 'version_conflict' });
  await assert.rejects(run.store.register(1, { ...record(), label: 'replacement' }), { code: 'duplicate_voice' });
  assert.equal(await readFile(run.file, 'utf8'), bytes); assert.deepEqual(run.store.snapshot(), saved);
  assert.equal((await run.store.register(1, record('second'))).revision, 2);
});

test('concurrent local handles serialize and reject a stale writer; reopen can append the next revision', async t => {
  const run = await setup(t), other = await RegisteredVoiceStore.open(run.file);
  const results = await Promise.allSettled([run.store.register(0, record()), other.register(0, record('second'))]);
  assert.equal(results[0]!.status, 'fulfilled'); assert.equal(results[1]!.status, 'rejected');
  if (results[1]!.status === 'rejected') assert.equal(results[1].reason.code, 'version_conflict');
  const reopened = await RegisteredVoiceStore.open(run.file);
  assert.deepEqual((await reopened.register(1, record('second'))).voices.map(v => v.voiceId), ['dania-synthetic-001', 'second']);
});

test('finishing an earlier same-handle save cannot release the queue held by its pending successor', async t => {
  // Controlled in-memory filesystem schedules the second rename; real disk persistence
  // is covered above. All other operations settle as microtasks, with no timing guesses.
  const file = resolve('../../.local/minimax-default-01/test-runs/controlled-interleave.json');
  const files = new Map<string, string>(); let release!: () => void, reached!: () => void;
  const blocked = new Promise<void>(r => { release = r; }), secondAtRename = new Promise<void>(r => { reached = r; });
  const missing = () => Object.assign(new Error('controlled missing'), { code: 'ENOENT' });
  const mocks = [
    t.mock.method(fs, 'readFile', async (path: string) => { if (!files.has(path)) throw missing(); return files.get(path)!; }),
    t.mock.method(fs, 'mkdir', async () => undefined),
    t.mock.method(fs, 'writeFile', async (path: string, text: string) => { files.set(path, text); }),
    t.mock.method(fs, 'unlink', async (path: string) => { if (!files.delete(path)) throw missing(); }),
    t.mock.method(fs, 'rename', async (from: string, to: string) => {
      const content = files.get(from)!;
      if (JSON.parse(content).voices.at(-1).voiceId === 'second') { reached(); await blocked; }
      files.set(to, content); files.delete(from);
    }),
  ];
  syncBuiltinESMExports();
  t.after(() => { release(); mocks.forEach(mock => mock.mock.restore()); syncBuiltinESMExports(); });
  const firstHandle = await RegisteredVoiceStore.open(file);
  const first = firstHandle.register(0, record()), second = firstHandle.register(1, record('second'));
  await first; await secondAtRename;
  const other = await RegisteredVoiceStore.open(file);
  let thirdSettled = false;
  const third = other.register(1, record('third'));
  const rejected = assert.rejects(third, { code: 'version_conflict' });
  void third.then(() => { thirdSettled = true; }, () => { thirdSettled = true; });
  await new Promise<void>(r => setImmediate(r));
  try { assert.equal(thirdSettled, false, 'the third handle must wait while the second rename is pending'); }
  finally { release(); }
  await second; await rejected;
  assert.deepEqual((await RegisteredVoiceStore.open(file)).snapshot().voices.map(v => v.voiceId), ['dania-synthetic-001', 'second']);
});

test('caller mutation after registration starts cannot alter the record being persisted', async t => {
  const run = await setup(t), value = record(), saved = run.store.register(0, value);
  Object.assign(value, { voiceId: 'mutated', credentialRef: 'dashscope-abcdef123456' });
  assert.deepEqual((await saved).voices, [record()]);
});

test('an external same-revision rewrite is detected before append and does not overwrite either state', async t => {
  const run = await setup(t); const saved = await run.store.register(0, record());
  const external = { ...saved, voices: [{ ...record(), label: 'external edit' }] };
  await writeFile(run.file, JSON.stringify(external));
  await assert.rejects(run.store.register(1, record('second')), { code: 'version_conflict' });
  assert.deepEqual(run.store.snapshot(), saved); assert.deepEqual(JSON.parse(await readFile(run.file, 'utf8')), external);
});

test('I/O failure never advances in-memory revision or creates a binding', async t => {
  const run = await setup(t); await mkdir(run.file);
  await assert.rejects(run.store.register(0, record()));
  assert.equal(run.store.snapshot().revision, 0); assert.throws(() => run.store.resolve(key()), { code: 'unregistered_voice' });
});

test('MiniMax Turbo and HD restore alongside Qwen with the unchanged eight-field record schema', async t => {
  const run = await setup(t), qwen = record(), minimax = { ...record('minimax-synthetic-001'),
    targetModel: 'MiniMax/speech-2.8-turbo', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' };
  const hd = { ...minimax, voiceId: "minimax-hd-synthetic", targetModel: "MiniMax/speech-2.8-hd" };
  await run.store.register(0, qwen); await run.store.register(1, minimax); await run.store.register(2, hd);
  const reopened = await RegisteredVoiceStore.open(run.file);
  assert.deepEqual(reopened.snapshot().voices, [qwen, minimax, hd]); assert.equal(Object.keys(minimax).length, 8);
  assertRegisteredVoiceBinding(reopened.resolve(key(hd)), key(hd));
  assert.throws(() => reopened.resolve({ ...key(hd), targetModel: minimax.targetModel }), { code: "binding_mismatch" });
  assertRegisteredVoiceBinding(reopened.resolve(key(minimax)), key(minimax));
  assertRegisteredVoiceBinding(reopened.resolve(key(qwen)), key(qwen));
  assert.throws(() => reopened.resolve({ ...key(minimax), targetModel: qwen.targetModel }), { code: 'binding_mismatch' });
  assert.throws(() => reopened.resolve({ ...key(qwen), endpoint: minimax.endpoint }), { code: 'binding_mismatch' });
});

test('supported models and endpoints cannot be recombined; unreviewed MiniMax models stay unregistered', async t => {
  const run = await setup(t), generation = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  for (const pair of [
    { targetModel: 'MiniMax/speech-2.8-turbo', endpoint: QWEN_AUDIO_TTS_ENDPOINT },
    { targetModel: QWEN_AUDIO_TTS_PLUS_MODEL, endpoint: generation },
    { targetModel: 'MiniMax/speech-2.9-hd', endpoint: generation },
    { targetModel: 'MiniMax/speech-02-turbo', endpoint: generation },
    { targetModel: '__proto__', endpoint: generation },
  ]) await assert.rejects(run.store.register(0, { ...record(), ...pair }), { code: 'invalid_registry' });
  assert.equal(run.store.snapshot().revision, 0); assert.deepEqual(await readdir(run.directory), []);
});
