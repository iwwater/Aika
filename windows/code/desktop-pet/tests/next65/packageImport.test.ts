/**
 * K65-01 · 01-F（spec §1 目标清单「导入复制到宿主管理目录、校验后原子登记」）：
 * the host-side directory-package import. The registry data structure is K65-01's; discovery and
 * load execution are K65-02's, so this module never imports an entry and never runs anything.
 *
 * Every case runs the REAL `importPackage` against REAL directories under the OS temp root: the
 * source packages are the real fixtures (and mutated copies of them), the host root is a real
 * directory tree, and every "nothing was written" claim is checked against the actual filesystem.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPackage, readPackageRegistry, type InstalledPackageRecord } from '../../plugins/package-import.js';
import { computeManifestHash, contentHash, validateManifestFile } from '../../plugins/manifest.js';
import type { PackageManifest } from '../../contracts/plugin.js';

let testDirectory = dirname(fileURLToPath(import.meta.url));
if (basename(testDirectory) === 'next65' && basename(dirname(dirname(testDirectory))) === 'dist') {
  testDirectory = resolve(dirname(dirname(testDirectory)), '..', 'tests', 'next65');
}
const fixtureRoot = resolve(testDirectory, 'fixtures', 'packages');

/** A fresh host-managed root plus a pristine copy of a fixture package, both cleaned up. */
function withRoots(fixtureName: string, body: (source: string, host: string) => void): void {
  const root = mkdtempSync(resolve(tmpdir(), 'k65-01f-'));
  const source = resolve(root, 'source');
  const host = resolve(root, 'host');
  cpSync(resolve(fixtureRoot, fixtureName), source, { recursive: true });
  try {
    body(source, host);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A source package with one bad file hash; rehashed manifest so hash_mismatch is the ONLY issue. */
function withBadFileHash(source: string): string {
  const broken = resolve(dirname(source), 'source-bad-hash');
  cpSync(source, broken, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(broken, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const files = manifest.files as { path: string; hash: string }[];
  files.find(file => file.path === 'entry.mjs')!.hash = 'sha256-' + '1'.repeat(64);
  writeFileSync(resolve(broken, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return broken;
}

const registryPath = (host: string): string => resolve(host, 'packages', 'registry.json');

/** Unwraps the registry reader: a test that cannot read the registry back should fail loudly. */
function readRegistry(host: string) {
  const read = readPackageRegistry(host);
  if (!read.ok) throw new Error(`registry unreadable: ${read.issue.detail}`);
  return read.registry;
}

test('01-F: a valid package is copied into the host-managed tree and atomically registered', () => {
  withRoots('normal', (source, host) => {
    const result = importPackage({ sourceRoot: source, hostRoot: host });
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));

    const record = result.record as InstalledPackageRecord;
    const manifest = JSON.parse(readFileSync(resolve(source, 'manifest.json'), 'utf8')) as PackageManifest;
    assert.equal(record.packageId, manifest.packageId);
    assert.equal(record.version, manifest.version);
    assert.equal(record.manifestHash, manifest.manifestHash);
    assert.match(record.installedDirectory, /packages\//, 'the installed copy lives under the host-managed packages tree');

    // The installed copy is a real directory on disk whose manifest revalidates.
    const installed = resolve(host, ...record.installedDirectory.split('/'));
    assert.equal(existsSync(resolve(installed, 'manifest.json')), true);
    const revalidated = validateManifestFile(installed);
    assert.equal(revalidated.ok, true, JSON.stringify(revalidated.issues, null, 2));

    // The registry is a real file with exactly one record.
    const registry = readRegistry(host);
    assert.equal(registry.packages.length, 1);
    assert.equal(registry.packages[0]!.packageId, manifest.packageId);
    assert.equal(registry.packages[0]!.manifestHash, manifest.manifestHash);

    // No staging residue: an aborted import must never leave half a package behind.
    assert.deepEqual(readdirSync(resolve(host, 'packages')).filter(name => name.startsWith('.staging-')), []);
  });
});

test('01-F: an invalid package is refused with ZERO writes into the host-managed tree', () => {
  withRoots('normal', (source, host) => {
    const broken = withBadFileHash(source);
    const result = importPackage({ sourceRoot: broken, hostRoot: host });
    assert.equal(result.ok, false);
    assert.deepEqual([...new Set(result.issues.map(issue => issue.category))], ['hash_mismatch']);
    assert.equal(result.record, null);
    assert.equal(existsSync(resolve(host, 'packages')), false, 'validation happens before any copy: no packages tree is created');
    assert.equal(existsSync(registryPath(host)), false, 'no registry is written for a refused package');
  });
});

test('01-F: importing the same content twice is idempotent — one registry record, no duplicate', () => {
  withRoots('normal', (source, host) => {
    const first = importPackage({ sourceRoot: source, hostRoot: host });
    assert.equal(first.ok, true, JSON.stringify(first.issues, null, 2));
    const second = importPackage({ sourceRoot: source, hostRoot: host });
    assert.equal(second.ok, true, JSON.stringify(second.issues, null, 2));
    assert.equal(second.record!.installedDirectory, first.record!.installedDirectory, 'the same content resolves to the same install directory');
    assert.equal(readRegistry(host).packages.length, 1, 'the registry does not grow on a re-import');
  });
});

test('01-F: the same packageId+version with DIFFERENT content is refused and the installed copy is untouched', () => {
  withRoots('normal', (source, host) => {
    const first = importPackage({ sourceRoot: source, hostRoot: host });
    assert.equal(first.ok, true, JSON.stringify(first.issues, null, 2));

    // Different content, same identity: change the README, update its declared hash, rehash the
    // manifest — so identity_conflict is the ONLY refusal, not a hash_mismatch side effect.
    const mutated = resolve(dirname(source), 'source-mutated');
    cpSync(source, mutated, { recursive: true });
    writeFileSync(resolve(mutated, 'README.md'), '# a different package with the same identity\n', 'utf8');
    const manifest = JSON.parse(readFileSync(resolve(mutated, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const readme = (manifest.files as { path: string; hash: string; bytes: number }[]).find(file => file.path === 'README.md')!;
    const readmeBytes = readFileSync(resolve(mutated, 'README.md'));
    readme.hash = contentHash(readmeBytes);
    readme.bytes = readmeBytes.byteLength;
    manifest.manifestHash = computeManifestHash(manifest as unknown as PackageManifest);
    writeFileSync(resolve(mutated, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    const second = importPackage({ sourceRoot: mutated, hostRoot: host });
    assert.equal(second.ok, false, 'a version is immutable: different content under the same identity is refused');
    assert.deepEqual([...new Set(second.issues.map(issue => issue.category))], ['identity_conflict']);

    // The refusal did not touch the already-installed copy.
    const installed = resolve(host, ...first.record!.installedDirectory.split('/'));
    const installedManifest = JSON.parse(readFileSync(resolve(installed, 'manifest.json'), 'utf8')) as PackageManifest;
    assert.equal(installedManifest.manifestHash, first.record!.manifestHash);
    assert.equal(readRegistry(host).packages.length, 1);
  });
});

test('01-F: a package declaring a key or weight file is refused at import, before anything is copied', () => {
  withRoots('normal', (source, host) => {
    // A smuggled key declared as a normal file, with a correct hash: the manifest-level checks alone
    // would accept it, so the import gate needs the forbidden-content rule to fire.
    writeFileSync(resolve(source, 'secrets.key'), 'PRIVATE KEY\n', 'utf8');
    const manifest = JSON.parse(readFileSync(resolve(source, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    (manifest.files as unknown[]).push({
      path: 'secrets.key', bytes: 12, hash: contentHash(readFileSync(resolve(source, 'secrets.key'))),
      role: 'data', executable: false,
    });
    manifest.manifestHash = computeManifestHash(manifest as unknown as PackageManifest);
    writeFileSync(resolve(source, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    const result = importPackage({ sourceRoot: source, hostRoot: host });
    assert.equal(result.ok, false);
    assert.deepEqual([...new Set(result.issues.map(issue => issue.category))], ['package_forbidden_content']);
    assert.equal(existsSync(resolve(host, 'packages')), false, 'forbidden content is refused before any copy');
  });
});

test('01-F: a corrupt host registry is refused, never silently overwritten', () => {
  withRoots('normal', (source, host) => {
    const first = importPackage({ sourceRoot: source, hostRoot: host });
    assert.equal(first.ok, true, JSON.stringify(first.issues, null, 2));
    writeFileSync(registryPath(host), '{ not json', 'utf8');

    const again = importPackage({ sourceRoot: source, hostRoot: host });
    assert.equal(again.ok, false, 'a registry the host cannot parse must stop the import');
    assert.deepEqual([...new Set(again.issues.map(issue => issue.category))], ['manifest_invalid']);
    // The corrupt file itself is left for the operator, not clobbered behind their back.
    assert.equal(readFileSync(registryPath(host), 'utf8'), '{ not json');
  });
});

test('01-F: the import path never imports the entry — validation + copy only (structural, like 01-B)', () => {
  withRoots('side-effect', (source, host) => {
    const result = importPackage({ sourceRoot: source, hostRoot: host });
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
    // The side-effect fixture writes a heartbeat ONLY when its entry executes; the import wrote it
    // nowhere because nothing ran. (01-B proves the zero with child processes; here the copy is in
    // the same process, so a heartbeat in the host tree would be visible where it landed.)
    assert.equal(existsSync(resolve(host, 'heartbeat.log')), false);
    const installed = resolve(host, ...result.record!.installedDirectory.split('/'));
    assert.equal(existsSync(resolve(installed, 'heartbeat.log')), false);
    assert.equal(existsSync(resolve(installed, 'entry.mjs')), true, 'the entry file is copied as content, not executed');
  });
});
