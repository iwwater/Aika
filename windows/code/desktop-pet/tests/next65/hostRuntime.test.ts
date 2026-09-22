/** K65-02: real installed-copy discovery, lazy activation, single-flight and rollback. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { computeManifestHash } from '../../plugins/manifest.js';
import { importPackageHost, setPackageEnablement } from '../../plugins/host-config.js';
import { createPackageHost, discoverInstalledPackages, PluginRequestError } from '../../plugins/host-runtime.js';
import type { PackageManifest } from '../../contracts/plugin.js';

declare global {
  var __k65HostActivations: number | undefined;
  var __k65HostReleases: number | undefined;
  var __k65HostDeactivations: number | undefined;
}

let testDirectory = new URL('.', import.meta.url).pathname.replace(/^\/+([A-Za-z]):/, '$1:').replace(/\//g, '\\');
if (testDirectory.endsWith('dist\\tests\\next65\\')) testDirectory = resolve(testDirectory, '..', '..', '..', 'tests', 'next65') + '\\';
const fixtureRoot = resolve(testDirectory, 'fixtures', 'packages');

function makePackage(options: { readonly failing?: boolean } = {}): { readonly source: string; readonly packageId: string } {
  const source = mkdtempSync(resolve(tmpdir(), 'k65-02-source-'));
  cpSync(resolve(fixtureRoot, 'normal'), source, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(source, 'manifest.json'), 'utf8')) as PackageManifest;
  const capability = manifest.plugins[0]!.capabilities[0]!;
  const entry = `
const capability = ${JSON.stringify(capability)};
export const activation = {
  async activate(host) {
    globalThis.__k65HostActivations = (globalThis.__k65HostActivations || 0) + 1;
    host.resources.register('timer', 'fixture.timer', () => { globalThis.__k65HostReleases = (globalThis.__k65HostReleases || 0) + 1; });
    host.capabilities.register({ ...capability, provide: { capabilityId: capability.capabilityId, adapterId: capability.adapterId, adapterVersion: capability.adapterVersion, pluginId: host.pluginId, packageId: host.packageId } });
    ${options.failing ? "throw new Error('fixture activation failure');" : ''}
    return { pluginId: host.pluginId, packageId: host.packageId, packageVersion: '1.0.0', apiVersion: '1.0.0', state: 'active', capabilityIds: [capability.capabilityId] };
  },
  async deactivate() { globalThis.__k65HostDeactivations = (globalThis.__k65HostDeactivations || 0) + 1; }
};
`;
  writeFileSync(resolve(source, 'entry.mjs'), entry, 'utf8');
  const files = manifest.files.map(file => file.path === 'entry.mjs'
    ? { ...file, bytes: Buffer.byteLength(entry), hash: `sha256-${requireHash(entry)}` }
    : file);
  const next = { ...manifest, files, manifestHash: '' };
  next.manifestHash = computeManifestHash(next);
  writeFileSync(resolve(source, 'manifest.json'), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { source, packageId: next.packageId };
}

function requireHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function setup(options: { readonly failing?: boolean } = {}): { readonly source: string; readonly hostRoot: string; readonly packageId: string; readonly cleanup: () => void } {
  const fixture = makePackage(options);
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'k65-02-host-'));
  const imported = importPackageHost({ sourceRoot: fixture.source, hostRoot });
  assert.equal(imported.ok, true, JSON.stringify(imported.issues));
  assert.equal(setPackageEnablement({ hostRoot, packageId: fixture.packageId, enabled: true }).ok, true);
  return { ...fixture, hostRoot, cleanup: () => { rmSync(fixture.source, { recursive: true, force: true }); rmSync(hostRoot, { recursive: true, force: true }); } };
}

function secrets() {
  return { has: () => false, resolve: () => null, list: () => [] };
}

test('02-A: discovery and enablement never import the entry; first request activates the installed copy', async () => {
  const fixture = setup();
  try {
    globalThis.__k65HostActivations = 0;
    const discovery = discoverInstalledPackages(fixture.hostRoot);
    assert.equal(discovery.issues.length, 0, JSON.stringify(discovery.issues));
    assert.equal(globalThis.__k65HostActivations, 0);
    const host = createPackageHost({ hostRoot: fixture.hostRoot, secrets: secrets() });
    const request = { pluginId: 'normal.plugin', capabilityId: 'presentation.render' } as const;
    const result = await host.resolve(request);
    assert.equal(result.length, 1);
    assert.equal(globalThis.__k65HostActivations, 1);
    await host.close();
  } finally { fixture.cleanup(); }
});

test('02-A: concurrent first requests share one activation flight and close releases the resource', async () => {
  const fixture = setup();
  try {
    globalThis.__k65HostActivations = 0;
    globalThis.__k65HostReleases = 0;
    const host = createPackageHost({ hostRoot: fixture.hostRoot, secrets: secrets() });
    const request = { pluginId: 'normal.plugin', capabilityId: 'presentation.render' } as const;
    const results = await Promise.all([host.resolve(request), host.resolve(request), host.resolve(request)]);
    assert.deepEqual(results.map(result => result.length), [1, 1, 1]);
    assert.equal(globalThis.__k65HostActivations, 1);
    assert.deepEqual(host.outstanding(), ['com.aika.fixture.normal/normal.plugin:fixture.timer']);
    const closed = await host.close();
    assert.equal(globalThis.__k65HostReleases, 1);
    assert.equal(closed.plugins.length, 1);
    assert.deepEqual(host.outstanding(), []);
  } finally { fixture.cleanup(); }
});

test('02-A: an installed but disabled package never executes and reports a lifecycle refusal', async () => {
  const fixture = makePackage();
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'k65-02-disabled-'));
  try {
    const imported = importPackageHost({ sourceRoot: fixture.source, hostRoot });
    assert.equal(imported.ok, true);
    globalThis.__k65HostActivations = 0;
    const host = createPackageHost({ hostRoot, secrets: secrets() });
    await assert.rejects(host.resolve({ pluginId: 'normal.plugin', capabilityId: 'presentation.render' }), (error: unknown) => error instanceof PluginRequestError && error.category === 'lifecycle_violation');
    assert.equal(globalThis.__k65HostActivations, 0);
    await host.close();
  } finally { rmSync(fixture.source, { recursive: true, force: true }); rmSync(hostRoot, { recursive: true, force: true }); }
});

test('02-C: activation failure releases resources and leaves no active host state', async () => {
  const fixture = setup({ failing: true });
  try {
    globalThis.__k65HostReleases = 0;
    const host = createPackageHost({ hostRoot: fixture.hostRoot, secrets: secrets() });
    await assert.rejects(host.resolve({ pluginId: 'normal.plugin', capabilityId: 'presentation.render' }), /fixture activation failure/);
    assert.equal(globalThis.__k65HostReleases, 1);
    assert.deepEqual(host.outstanding(), []);
    assert.deepEqual(host.assertCleanState(), []);
    await host.close();
  } finally { fixture.cleanup(); }
});
