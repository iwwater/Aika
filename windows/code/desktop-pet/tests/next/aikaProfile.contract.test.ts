// NEXT-02 contract tests: Aika static identity, prompt single-injection, persistence durability and key isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_CHARACTER_PROMPTS } from '../../companion/prompts.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { ManagementError } from '../../contracts/management.js';
import { applyAikaProfile, AikaProfileStore, defaultAikaProfile, fallbackAikaProfile, validateAikaProviderConfigs } from '../../management/aika-profile.js';
import { nextScope, tempStore } from './harness.js';

test('fresh install uses the Aika static identity with the upstream default prompt', async t => {
  const temp = await tempStore();
  t.after(() => temp.cleanup());
  const store = new SqliteMemoryStore({ filename: temp.filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const result = fallbackAikaProfile(undefined);
  assert.equal(result.status, 'fallback', 'no stored profile means the default identity');
  assert.equal(result.profile.displayName, 'Aika');
  applyAikaProfile(store, result.profile);
  assert.equal(store.prompt(nextScope('probe')), DEFAULT_CHARACTER_PROMPTS.companion, 'default prompt equals the upstream sanctioned companion prompt');
  store.close();
});

test('edited profile survives save/reopen and reaches a brand-new session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'aika-profile.json');

  const first = await AikaProfileStore.open(file);
  const saved = await first.save(0, { schemaVersion: 1, id: 'aika', displayName: 'Aika', systemPrompt: '你叫Aika，语气简洁坦率。' }, []);
  assert.equal(saved.revision, 1);

  const second = await AikaProfileStore.open(file);
  const profile = second.loadProfile();
  assert.equal(profile.displayName, 'Aika');
  assert.equal(profile.systemPrompt, '你叫Aika，语气简洁坦率。');

  const temp = await tempStore();
  t.after(() => temp.cleanup());
  const freshSession = new SqliteMemoryStore({ filename: temp.filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  applyAikaProfile(freshSession, profile);
  assert.equal(freshSession.prompt(nextScope('probe')), '你叫Aika，语气简洁坦率。', 'a new session reads exactly the saved prompt');
  freshSession.close();
});

test('wrong schemaVersion is reported clearly, not silently accepted or crashing at import', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'aika-profile.json');
  const store = await AikaProfileStore.open(file);
  await assert.rejects(
    store.save(0, { schemaVersion: 2, id: 'aika', displayName: 'Aika', systemPrompt: 'x' }, []),
    (error: unknown) => error instanceof ManagementError && /schemaVersion/.test(error.message)
  );
  await writeFile(file, JSON.stringify({ version: 1, revision: 3, profile: { schemaVersion: 2, id: 'aika', displayName: 'Aika', systemPrompt: 'x' }, providers: [] }), 'utf8');
  const reopened = await AikaProfileStore.open(file);
  assert.throws(() => reopened.loadProfile(), (error: unknown) => error instanceof ManagementError && /schemaVersion/.test(error.message) && /2/.test(error.message));
});

test('empty or invalid stored config falls back to the default identity without breaking startup', async t => {
  const temp = await tempStore();
  t.after(() => temp.cleanup());
  const store = new SqliteMemoryStore({ filename: temp.filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  for (const raw of [null, {}, { schemaVersion: 1, displayName: '', systemPrompt: 'x' }, { schemaVersion: 1, id: 'aika', displayName: 'Aika', systemPrompt: '   ' }]) {
    const result = fallbackAikaProfile(raw);
    assert.equal(result.status, 'fallback');
    assert.ok(result.error, 'the fallback reason must be observable');
    assert.doesNotThrow(() => applyAikaProfile(store, result.profile));
  }
  assert.equal(store.prompt(nextScope('probe')), DEFAULT_CHARACTER_PROMPTS.companion);
  store.close();
});

test('provider configs keep only credentialRef/credentialConfigured; key material is rejected everywhere', async t => {
  const valid = [{ id: 'p1', protocol: 'openai-compatible', endpoint: 'https://api.example.com/v1', model: 'm1', credentialRef: 'deepseek-0123abcd', credentialConfigured: true }];
  assert.deepEqual(validateAikaProviderConfigs(valid), valid);
  assert.throws(() => validateAikaProviderConfigs([{ ...valid[0], apiKey: 'sk-secret-value' }]), /credential/);
  assert.throws(() => validateAikaProviderConfigs([{ ...valid[0], protocol: 'anthropic' }]), /protocol/);
  assert.throws(() => validateAikaProviderConfigs([{ ...valid[0], credentialConfigured: 'yes' }]), /credentialConfigured/);

  const dir = await mkdtemp(join(tmpdir(), 'next-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'aika-profile.json');
  const store = await AikaProfileStore.open(file);
  await store.save(0, defaultAikaProfile(), valid);
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('sk-'), 'no key material may reach the settings JSON');
  assert.ok(raw.includes('credentialRef'), 'the ref itself is stored');
});

test('persistence failures are visible: revision conflict and unwritable target both reject', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'next-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'aika-profile.json');
  const store = await AikaProfileStore.open(file);
  await store.save(0, defaultAikaProfile(), []);
  await assert.rejects(
    store.save(0, defaultAikaProfile(), []),
    (error: unknown) => error instanceof ManagementError && error.code === 'version_conflict',
    'stale expectedRevision must not overwrite'
  );

  const asDirectory = join(dir, 'blocked');
  await mkdir(asDirectory);
  // A hostile path fails visibly at open (EISDIR), before any save could claim success.
  await assert.rejects(AikaProfileStore.open(asDirectory), Error, 'unwritable/foreign target must fail loudly');
});

test('profile prompt is injected only through the upstream system-context position', async t => {
  const temp = await tempStore();
  t.after(() => temp.cleanup());
  const store = new SqliteMemoryStore({ filename: temp.filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const edited = { schemaVersion: 1 as const, id: 'aika', displayName: 'Aika', systemPrompt: '注入一次的角色设定。' };
  applyAikaProfile(store, edited);
  assert.equal(store.promptSnapshot(nextScope('probe')).text, '注入一次的角色设定。');
  assert.throws(() => store.setPrompt(nextScope('probe'), '   '), /empty_prompt/, 'the upstream guard stays authoritative for empty prompts');
  store.close();
});
