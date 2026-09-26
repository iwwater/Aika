/**
 * K65-01 · 01-A: directory-package manifest acceptance and refusal, exercised through the REAL
 * `validateManifestFile` on real directory packages under tests/next65/fixtures/packages/.
 *
 * No validator stub, no mock filesystem: every legal case has a manifest.json plus its declared files
 * on disk, every illegal case is a real directory whose manifest.json is written and re-read, and the
 * Windows case uses a junction created by the OS, not by a hand-rolled symlink mock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeManifestHash, validateManifestFile } from '../../plugins/manifest.js';
import { detectReparsePoints, findPackagePathIssues } from '../../plugins/paths.js';
import { PLUGIN_ERROR_CATEGORIES, type PackageManifest, type PluginErrorCategory, type PluginIssue } from '../../contracts/plugin.js';

// The suite is compiled into dist/tests/next65 but the fixtures live beside the source, so walk up
// out of `dist` the same way tests/next65/baselineSurface.test.ts does.
let testDirectory = dirname(fileURLToPath(import.meta.url));
if (basename(testDirectory) === 'next65' && basename(dirname(dirname(testDirectory))) === 'dist') {
  testDirectory = resolve(dirname(dirname(testDirectory)), '..', 'tests', 'next65');
}
const fixtureRoot = resolve(testDirectory, 'fixtures', 'packages');
const fixture = (name: string): string => resolve(fixtureRoot, name);

/** A temporary package directory seeded from a fixture, cleaned up by the caller. */
function scratchPackage(fromFixture: string): string {
  const root = mkdtempSync(resolve(tmpdir(), 'k65-01a-'));
  cpSync(fixture(fromFixture), root, { recursive: true });
  return root;
}

function readManifest(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * Rewrites manifest.json from a mutated copy. `rehash` recomputes the self digest so the ONLY new
 * rejection is the one the case is about — otherwise every case would also report hash_mismatch.
 */
function writeManifest(root: string, mutate: (manifest: Record<string, unknown>) => void, rehash = true): void {
  const manifest = readManifest(root);
  mutate(manifest);
  if (rehash) manifest.manifestHash = computeManifestHash(manifest as unknown as PackageManifest);
  writeFileSync(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

const categories = (issues: readonly PluginIssue[]): readonly PluginErrorCategory[] =>
  issues.map(issue => issue.category);

function expectCategories(issues: readonly PluginIssue[], expected: readonly PluginErrorCategory[]): void {
  for (const category of expected) assert.ok(PLUGIN_ERROR_CATEGORIES.includes(category), `${category} is not a frozen error category`);
  for (const category of categories(issues)) assert.ok(PLUGIN_ERROR_CATEGORIES.includes(category), `${category} is not a frozen error category`);
  assert.deepEqual([...new Set(categories(issues))].sort(), [...new Set(expected)].sort(), `issues: ${JSON.stringify(issues, null, 2)}`);
}

const cleanup = (root: string): void => { rmSync(root, { recursive: true, force: true }); };

// --- 01-A legal: the four package kinds -----------------------------------------------------------

for (const [name, label] of [
  ['normal', '普通包'],
  ['tts', 'TTS 包'],
  ['stt', 'STT 包'],
  ['test-harness', '测试包'],
] as const) {
  test(`01-A legal: the ${label} fixture passes the real validator with zero issues`, () => {
    const root = fixture(name);
    const result = validateManifestFile(root);
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
    assert.deepEqual(result.issues, []);
    const manifest = result.manifest as { readonly files: readonly { readonly path: string }[] };
    for (const file of manifest.files) {
      const own = findPackagePathIssues(root, file.path, { requireFile: true });
      assert.deepEqual(own, [], `${file.path} must exist inside the package as a regular file`);
    }
  });
}

test('01-A legal: the four fixtures are distinct packages with all four required file sets present', () => {
  for (const name of ['normal', 'tts', 'stt', 'test-harness']) {
    const manifest = readManifest(fixture(name));
    assert.ok((manifest.files as readonly unknown[]).length >= 2, `${name} must ship more than a manifest`);
    assert.equal(typeof manifest.manifestHash, 'string');
    assert.ok((manifest.manifestHash as string).startsWith('sha256-'));
  }
  const ids = ['normal', 'tts', 'stt', 'test-harness'].map(name => readManifest(fixture(name)).packageId);
  assert.equal(new Set(ids).size, 4, 'the four legal packages declare four distinct package ids');
});

// --- 01-A illegal -----------------------------------------------------------------------------------

test('01-A illegal: an unknown manifest schemaVersion is refused as schema_version_unsupported', () => {
  const root = scratchPackage('normal');
  try {
    writeManifest(root, manifest => { manifest.schemaVersion = 99; }, false);
    const result = validateManifestFile(root);
    assert.equal(result.ok, false);
    expectCategories(result.issues, ['schema_version_unsupported']);
    const issue = result.issues[0]!;
    assert.equal(issue.path, 'schemaVersion');
    assert.match(issue.detail, /unsupported manifest schemaVersion 99/);
  } finally {
    cleanup(root);
  }
});

test('01-A illegal: a declared file hash that does not match disk is refused as hash_mismatch', () => {
  const root = scratchPackage('normal');
  try {
    writeManifest(root, manifest => {
      const files = manifest.files as { readonly hash: string; readonly path: string }[];
      const entry = files.find(file => file.path === 'entry.mjs') as { hash: string };
      entry.hash = 'sha256-' + '1'.repeat(64);
    });
    const result = validateManifestFile(root);
    assert.equal(result.ok, false);
    expectCategories(result.issues, ['hash_mismatch']);
    const issue = result.issues[0]!;
    assert.equal(issue.path, 'files[entry.mjs].hash');
    assert.match(issue.detail, /hashes to sha256-/);
  } finally {
    cleanup(root);
  }
});

test('01-A illegal: a hash that is not even the sha256-hex shape is refused as manifest_invalid', () => {
  const root = scratchPackage('normal');
  try {
    writeManifest(root, manifest => {
      const files = manifest.files as { readonly hash: string; readonly path: string }[];
      const entry = files.find(file => file.path === 'entry.mjs') as { hash: string };
      entry.hash = 'md5-deadbeef';
    });
    const result = validateManifestFile(root);
    assert.equal(result.ok, false);
    expectCategories(result.issues, ['manifest_invalid']);
    assert.match(result.issues[0]!.detail, /hash must be sha256-<64 lowercase hex>/);
  } finally {
    cleanup(root);
  }
});

test('01-A illegal: a duplicate adapter identity with different content is refused as capability_conflict', () => {
  const root = scratchPackage('tts');
  try {
    writeManifest(root, manifest => {
      const plugins = manifest.plugins as { readonly capabilities: unknown[] }[];
      const first = (plugins[0]!.capabilities[0] as Record<string, unknown>);
      const clone = structuredClone(first) as Record<string, unknown>;
      clone.capabilityId = 'audio.playback';
      // In-vocabulary names for audio.playback: the case is about identity, so the only new issue may
      // be capability_conflict; an out-of-vocabulary name would add unsupported_parameter.
      clone.parameters = ['deviceId', 'volume'];
      clone.inputs = [{ name: 'stream', type: 'stream', required: true, description: '音频流' }];
      plugins[0]!.capabilities.push(clone);
    });
    const result = validateManifestFile(root);
    assert.equal(result.ok, false);
    expectCategories(result.issues, ['capability_conflict']);
    const issue = result.issues[0]!;
    assert.equal(issue.path, 'plugins[0].capabilities[1]');
    assert.match(issue.detail, /adapter identity tts\.local@1\.0\.0 is declared twice with different content/);
  } finally {
    cleanup(root);
  }
});

test('01-A illegal: a duplicate pluginId is refused as identity_conflict', () => {
  const root = scratchPackage('normal');
  try {
    writeManifest(root, manifest => {
      const plugins = manifest.plugins as unknown[];
      plugins.push(structuredClone(plugins[0]));
    });
    const result = validateManifestFile(root);
    assert.equal(result.ok, false);
    expectCategories(result.issues, ['identity_conflict']);
    const issue = result.issues[0]!;
    assert.equal(issue.path, 'plugins[1].pluginId');
    assert.match(issue.detail, /duplicate pluginId normal\.plugin in one manifest/);
  } finally {
    cleanup(root);
  }
});

test('01-A illegal: an entry that escapes the package root is refused as entry_out_of_bounds', () => {
  const root = scratchPackage('normal');
  try {
    writeManifest(root, manifest => {
      const plugin = (manifest.plugins as { entry: string }[])[0]!;
      plugin.entry = '../outside/escape.mjs';
    });
    const result = validateManifestFile(root);
    assert.equal(result.ok, false);
    expectCategories(result.issues, ['entry_out_of_bounds']);
    const issue = result.issues[0]!;
    assert.equal(issue.path, 'plugins[0].entry');
    assert.match(issue.detail, /escapes the package root with "\.\."/);
  } finally {
    cleanup(root);
  }
});

test('01-A illegal: a real Windows junction inside the package is refused as reparse_point_rejected', () => {
  assert.equal(process.platform, 'win32', 'the junction case is the Windows-only half of 01-A');
  const root = scratchPackage('stt');
  // The junction points somewhere OUTSIDE the package, which is exactly the escape the check exists for.
  const outside = mkdtempSync(resolve(tmpdir(), 'k65-01a-outside-'));
  writeFileSync(resolve(outside, 'smuggled.mjs'), 'export const stolen = 1;\n', 'utf8');
  const link = resolve(root, 'models');
  try {
    const created = spawnSync('cmd', ['/c', 'mklink', '/J', link, outside], { encoding: 'utf8' });
    assert.equal(created.status, 0, `mklink /J failed: ${created.stderr || created.stdout}`);

    // Proof this is a real junction created by Windows, not a mocked path:
    //  1. lstat reports a link (Windows reports a directory junction as a link);
    //  2. realpath of the junction resolves to the outside directory, not to the lexical path;
    //  3. reading THROUGH the junction really reaches the outside content.
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'the junction must be a reparse point on disk');
    assert.notEqual(resolve(realpathSync(link)), resolve(link), 'the junction must resolve outside the package');
    assert.equal(readFileSync(resolve(link, 'smuggled.mjs'), 'utf8'), 'export const stolen = 1;\n');

    const detected = detectReparsePoints(root, 'models/smuggled.mjs');
    assert.ok(detected.length >= 1, 'the junction component must be detected');
    assert.ok(detected.some(entry => entry.replace(/\\/g, '/').endsWith('models')), JSON.stringify(detected));

    const issues = findPackagePathIssues(root, 'models/smuggled.mjs', { requireFile: true });
    expectCategories(issues, ['reparse_point_rejected']);
    assert.match(issues[0]!.detail, /reparse point in the package path chain/);

    writeManifest(root, manifest => {
      const files = manifest.files as unknown[];
      files.push({
        path: 'models/smuggled.mjs',
        bytes: 25,
        hash: 'sha256-' + '0'.repeat(64),
        role: 'data',
        executable: false,
      });
    });
    const result = validateManifestFile(root);
    assert.equal(result.ok, false);
    assert.ok(
      categories(result.issues).includes('reparse_point_rejected'),
      `the validator must refuse the junction: ${JSON.stringify(result.issues, null, 2)}`,
    );
  } finally {
    rmSync(link, { recursive: true, force: true });
    cleanup(root);
    cleanup(outside);
  }
});

test('01-A: an ordinary nested directory is NOT treated as a reparse point (the check has a true negative)', () => {
  const root = fixture('tts'); // ships voices/default.json under a real directory
  assert.deepEqual(detectReparsePoints(root, 'voices/default.json'), []);
  assert.deepEqual(findPackagePathIssues(root, 'voices/default.json', { requireFile: true }), []);
});

test('01-A: every refusal this suite asserts uses one of the frozen PluginErrorCategory values', () => {
  assert.equal(PLUGIN_ERROR_CATEGORIES.length, 16);
  for (const category of ['schema_version_unsupported', 'hash_mismatch', 'manifest_invalid', 'capability_conflict', 'identity_conflict', 'entry_out_of_bounds', 'reparse_point_rejected'] as const) {
    assert.ok(PLUGIN_ERROR_CATEGORIES.includes(category), category);
  }
});
