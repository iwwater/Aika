/** K65-04: optional compatibility package, one writer, migration backup and revocation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { CompatibilityRuntime, CompatibilityRuntimeError } from '../../plugins/compatibility-runtime.js';
import { createPackageHost } from '../../plugins/host-runtime.js';
import { importPackageHost, setPackageEnablement } from '../../plugins/host-config.js';

const root = resolve(process.cwd());
const compatibilityRoot = resolve(root, 'dist/next65/packages/compatibility');
const secrets = () => ({ has: () => false, resolve: () => null, list: () => [] });

test('04-A/B: compatibility package declares only context/background and is loaded through the public host', async () => {
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'k65-04-host-'));
  try {
    const imported = importPackageHost({ sourceRoot: compatibilityRoot, hostRoot });
    assert.equal(imported.ok, true, JSON.stringify(imported.issues));
    assert.equal(setPackageEnablement({ hostRoot, packageId: 'com.aika.product.compatibility', enabled: true }).ok, true);
    const host = createPackageHost({ hostRoot, secrets: secrets() });
    const context = await host.resolve({ pluginId: 'compatibility.product', capabilityId: 'context.source' });
    const background = await host.resolve({ pluginId: 'compatibility.product', capabilityId: 'background.lifecycle' });
    assert.deepEqual(context.map(provider => provider.adapterId), ['compatibility.memory']);
    assert.deepEqual(background.map(provider => provider.adapterId), ['compatibility.lifecycle']);
    await host.close();
  } finally { rmSync(hostRoot, { recursive: true, force: true }); }
});

test('04-A/C: one compatibility writer owns stable record IDs and repeated migration keeps one backup', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'k65-04-state-'));
  try {
    const runtime = CompatibilityRuntime.open(directory);
    const release = runtime.registerWriter('sqlite-lifecycle-port');
    assert.throws(() => runtime.registerWriter('duplicate-memory-port'), (error: unknown) => error instanceof CompatibilityRuntimeError && error.code === 'writer_conflict');
    runtime.append({ id: 'message-1', version: 1, sourceId: 'conversation', value: { text: '保留原消息' } });
    runtime.append({ id: 'message-1', version: 1, sourceId: 'conversation', value: { text: '保留原消息' } });
    const source = resolve(directory, 'legacy.json');
    writeFileSync(source, JSON.stringify({ version: 0, messages: [{ id: 'message-1', text: '保留原消息' }] }), 'utf8');
    const first = runtime.migrateJson(source, value => ({ ...(value as object), version: 1 }));
    const second = runtime.migrateJson(source, value => ({ ...(value as object), version: 1 }));
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(runtime.backupFingerprints().length, 1);
    assert.equal(JSON.parse(readFileSync(source, 'utf8')).version, 1);
    const nestedA = resolve(directory, 'nested-a.json');
    const nestedB = resolve(directory, 'nested-b.json');
    writeFileSync(nestedA, JSON.stringify({ meta: { body: 'A' } }), 'utf8');
    writeFileSync(nestedB, JSON.stringify({ meta: { body: 'B' } }), 'utf8');
    const nestedFirst = runtime.migrateJson(nestedA, value => value);
    const nestedSecond = runtime.migrateJson(nestedB, value => value);
    assert.notEqual(nestedFirst.fingerprint, nestedSecond.fingerprint, 'nested migration content must affect the backup fingerprint');
    assert.equal(runtime.backupFingerprints().length, 3);
    release(); runtime.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('04-D: revoking a source invalidates frozen snapshots and prevents stale background writeback', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'k65-04-revoke-'));
  try {
    const runtime = CompatibilityRuntime.open(directory);
    const release = runtime.registerWriter('sqlite-lifecycle-port');
    runtime.append({ id: 'a', version: 1, sourceId: 'knowledge-A', value: { text: 'old fact' } });
    runtime.append({ id: 'b', version: 1, sourceId: 'knowledge-B', value: { text: 'other fact' } });
    runtime.snapshot('turn-1', ['knowledge-A', 'knowledge-B']);
    runtime.revokeSource('knowledge-A');
    assert.throws(() => runtime.assertSnapshot('turn-1'), (error: unknown) => error instanceof CompatibilityRuntimeError && error.code === 'snapshot_revoked');
    assert.throws(() => runtime.append({ id: 'late', version: 1, sourceId: 'knowledge-A', value: { text: 'late write' } }), (error: unknown) => error instanceof CompatibilityRuntimeError && error.code === 'snapshot_revoked');
    const next = runtime.snapshot('turn-2', ['knowledge-B']);
    assert.deepEqual(next.records.map(record => record.id), ['b']);
    release(); runtime.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('04-C: a failed migration leaves the original source untouched and keeps the backup recoverable', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'k65-04-failure-'));
  try {
    const runtime = CompatibilityRuntime.open(directory);
    const source = resolve(directory, 'legacy.json');
    writeFileSync(source, JSON.stringify({ version: 0, payload: 'original' }), 'utf8');
    assert.throws(() => runtime.migrateJson(source, () => { throw new Error('invalid legacy shape'); }), (error: unknown) => error instanceof CompatibilityRuntimeError && error.code === 'migration_failed');
    assert.equal(JSON.parse(readFileSync(source, 'utf8')).payload, 'original');
    assert.equal(existsSync(resolve(directory, 'migration-backups')), true);
    runtime.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
