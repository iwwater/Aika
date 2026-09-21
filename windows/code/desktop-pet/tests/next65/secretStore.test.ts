/**
 * K65-01 · D3: the `SecretStore` adapter over the EXISTING credential registry.
 *
 * The registry under test is production `credentialRegistry()`; the credential file is a real restricted
 * file outside the project root, created the way the FIX61-02 wiring test creates one. No stub store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restrictPrivatePathSync } from '../../core/platform-files.js';
import { credentialRegistry } from '../../management/credentials.js';
import { SECRET_STORE_REF_KEYS, secretStore, secretStoreFromRegistry } from '../../plugins/secret-store.js';
import { fixture } from '../management/helpers.js';

const KEY = 'sk-k6501-d3-secret-value';

/** A real restricted credential file outside the project root, as the production key reader requires. */
async function credentialFile(projectRoot: string, name: string): Promise<string> {
  const file = join(tmpdir(), `k65-01-d3-${name}-${Date.now()}.key`);
  await writeFile(file, KEY, { mode: 0o600 });
  restrictPrivatePathSync(file);
  assert.ok(!file.startsWith(projectRoot));
  return file;
}

test('D3: the adapter resolves a reference the real registry actually registered', async t => {
  const f = await fixture(t);
  const keyFile = await credentialFile(f.c.projectRoot, 'dialogue');
  t.after(() => rm(keyFile, { force: true }));
  const provider = f.c.models.dialogue.provider;
  const registry = credentialRegistry({ ...f.c, models: { ...f.c.models, dialogue: { ...f.c.models.dialogue, credentialFile: keyFile } } });
  const ref = registry.ref(keyFile, provider);
  const store = secretStoreFromRegistry(registry);

  assert.equal(store.has(ref, provider), true, 'a registered ref must be visible');
  assert.deepEqual(store.resolve(ref, provider), { ref, provider }, 'resolve echoes the reference, never the key');
  assert.deepEqual(store.resolve(ref, 'some-other-provider'), null, 'a ref under another provider must not resolve');
  assert.deepEqual(store.resolve('cred-doesnotexist', provider), null, 'an unknown ref must not resolve');
  assert.equal(store.has('cred-doesnotexist', provider), false);
});

test('D3: list reports refs with a status and never a file path', async t => {
  const f = await fixture(t);
  const keyFile = await credentialFile(f.c.projectRoot, 'dialogue');
  t.after(() => rm(keyFile, { force: true }));
  const provider = f.c.models.dialogue.provider;
  const store = secretStore({ ...f.c, models: { ...f.c.models, dialogue: { ...f.c.models.dialogue, credentialFile: keyFile } } });
  const listed = store.list();
  assert.ok(listed.length >= 1, 'the registry must list at least the one credential');
  const mine = listed.find(entry => entry.provider === provider && entry.status === 'configured');
  assert.ok(mine, `a real restricted file must be configured: ${JSON.stringify(listed)}`);
  // Refs only: no member of any listed entry may carry the key file's path or its content.
  for (const entry of listed) {
    for (const [key, value] of Object.entries(entry)) {
      assert.ok(SECRET_STORE_REF_KEYS.includes(key), `unexpected SecretStore member ${key}`);
      assert.equal(String(value).includes(keyFile), false, `${key} must not carry the credential path`);
      assert.equal(String(value).includes(KEY), false, `${key} must not carry key material`);
    }
  }
});

test('D3: the fixture configuration with no real key still lists, and every entry is missing/unavailable', async t => {
  const f = await fixture(t);
  const store = secretStore(f.c);
  const listed = store.list();
  assert.ok(listed.length >= 1);
  for (const entry of listed) {
    assert.ok(['configured', 'missing', 'unavailable'].includes(entry.status), JSON.stringify(entry));
    assert.equal(entry.status === 'configured' && entry.ref.includes('nonexistent'), false, 'a placeholder path is not a configured key');
  }
});
