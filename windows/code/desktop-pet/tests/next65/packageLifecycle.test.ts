/** K65-08: restart-boundary package updates, impact reporting, rollback and uninstall. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { computeManifestHash } from '../../plugins/manifest.js';
import { importPackageHost, setPackageEnablement } from '../../plugins/host-config.js';
import { PackageLifecycleManager, LifecycleError } from '../../plugins/package-lifecycle.js';
import { readPackageRegistry } from '../../plugins/package-import.js';

const root = resolve(process.cwd());
const source = resolve(root, 'dist/next65/packages/tts');

test('08-A/E: active consumer impact blocks disable and releases only after the final lease', async () => {
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'k65-08-host-'));
  try {
    assert.equal(importPackageHost({ sourceRoot: source, hostRoot }).ok, true);
    assert.equal(setPackageEnablement({ hostRoot, packageId: 'com.aika.product.tts', enabled: true }).ok, true);
    const manager = new PackageLifecycleManager(hostRoot);
    manager.registerConsumer('com.aika.product.tts', { consumerId: 'binding-1', kind: 'binding' });
    assert.equal(manager.impact('com.aika.product.tts').consumers.length, 1);
    assert.throws(() => manager.disable('com.aika.product.tts'), LifecycleError);
    manager.releaseConsumer('com.aika.product.tts', 'binding-1');
    assert.equal(manager.disable('com.aika.product.tts').enabled, false);
  } finally { rmSync(hostRoot, { recursive: true, force: true }); }
});

test('08-B/C: update stages a new immutable version, switches atomically at restart, and rolls back without deleting old content', async () => {
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'k65-08-update-'));
  const sourceCopy = mkdtempSync(resolve(tmpdir(), 'k65-08-source-'));
  try {
    assert.equal(importPackageHost({ sourceRoot: source, hostRoot }).ok, true);
    assert.equal(setPackageEnablement({ hostRoot, packageId: 'com.aika.product.tts', enabled: true }).ok, true);
    const before = readPackageRegistry(hostRoot); assert.equal(before.ok, true); const oldDirectory = before.ok ? before.registry.packages[0]!.installedDirectory : '';
    await cp(source, sourceCopy, { recursive: true });
    const manifestPath = resolve(sourceCopy, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.version = '0.65.1'; manifest.manifestHash = computeManifestHash(manifest as never);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const manager = new PackageLifecycleManager(hostRoot);
    const staged = manager.stageUpdate(sourceCopy);
    assert.equal(staged.pendingVersion, '0.65.1');
    const beforeApply = readPackageRegistry(hostRoot); assert.equal(beforeApply.ok, true);
    if (beforeApply.ok) assert.deepEqual(beforeApply.registry.packages.map(item => item.version), ['0.65.0'], 'staging must not publish a second live version');
    const applied = manager.applyPendingOnRestart('com.aika.product.tts');
    assert.equal(applied.activeVersion, '0.65.1');
    const registry = readPackageRegistry(hostRoot); assert.equal(registry.ok, true); assert.deepEqual(registry.registry.packages.map(item => item.version), ['0.65.1']);
    assert.equal(existsSync(resolve(hostRoot, ...oldDirectory.split('/'))), true);
    const rolled = manager.rollback('com.aika.product.tts'); assert.equal(rolled.activeVersion, '0.65.0');
    const restored = readPackageRegistry(hostRoot); assert.equal(restored.ok, true); if (restored.ok) assert.deepEqual(restored.registry.packages.map(item => item.version), ['0.65.0']);
  } finally { rmSync(hostRoot, { recursive: true, force: true }); rmSync(sourceCopy, { recursive: true, force: true }); }
});

test('08-D: uninstall removes the package registration and code while refusing live consumers', async () => {
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'k65-08-uninstall-'));
  try {
    assert.equal(importPackageHost({ sourceRoot: source, hostRoot }).ok, true);
    const manager = new PackageLifecycleManager(hostRoot);
    manager.registerConsumer('com.aika.product.tts', { consumerId: 'flow-1', kind: 'flow' });
    assert.throws(() => manager.uninstall('com.aika.product.tts'), LifecycleError);
    manager.releaseConsumer('com.aika.product.tts', 'flow-1'); manager.uninstall('com.aika.product.tts');
    assert.equal(manager.impact('com.aika.product.tts').installed.length, 0);
  } finally { rmSync(hostRoot, { recursive: true, force: true }); }
});
