/**
 * K65-01 · 01-D: package build output (manifest + artifacts + dependency manifest), byte-level
 * reproducibility, and the refusal of keys and model weights at BUILD time — driven by the real
 * `buildPackage`, not by a reimplementation of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { buildPackage, isForbiddenContent, packageDigest, type PackageBuildRequest } from '../../plugins/package-build.js';
import { validateManifestFile } from '../../plugins/manifest.js';
import { PLUGIN_API_VERSION, type PackageManifest } from '../../contracts/plugin.js';
import type { PackageDependencyManifest } from '../../plugins/package-build.js';

/** Temp roots are created under the OS temp dir and removed by `withTemp`. */
function withTemp<T>(body: (root: string) => T): T {
  const root = mkdtempSync(resolve(tmpdir(), 'k65-01d-'));
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const capabilities = [{
  capabilityId: 'tts.synthesize',
  category: 'output',
  adapterId: 'tts.local',
  adapterVersion: '1.0.0',
  contractVersion: '1.0.0',
  auth: 'none',
  sideEffect: 'none',
  parameters: ['voiceId', 'streaming'],
  execution: ['unary', 'streaming'],
  inputs: [{ name: 'voiceId', type: 'string', required: true, description: '音色标识' }],
  outputs: [{ name: 'audio', type: 'bytes', required: true, description: '合成音频' }],
}];

/** A source tree with a compiled .mjs entry, an asset and a README, all ordinary content. */
function writeSource(root: string): void {
  mkdirSync(resolve(root, 'assets'), { recursive: true });
  writeFileSync(resolve(root, 'entry.mjs'), 'export const activation = { pluginId: "build.plugin" };\n', 'utf8');
  writeFileSync(resolve(root, 'assets/voice.json'), '{ "voice": "aika-default" }\n', 'utf8');
  writeFileSync(resolve(root, 'README.md'), '# built package\n', 'utf8');
}

const request = (sourceRoot: string, outputRoot: string, epochSeconds: number): PackageBuildRequest => ({
  sourceRoot,
  outputRoot,
  packageId: 'com.aika.fixture.build',
  version: '1.0.0',
  label: '构建产物包',
  epochSeconds,
  plugins: [{ pluginId: 'build.plugin', entry: 'entry.mjs', label: '构建插件', capabilities }],
  dependencies: [{ packageId: 'com.aika.fixture.core', range: '>=1.0.0 <2.0.0', reason: '共享能力契约' }],
  optionalDependencies: [{ packageId: 'com.aika.fixture.extra', range: '^0.9.0', reason: '可选音色' }],
});

test('01-D: a built package contains manifest.json, the copied artifacts and dependency-manifest.json', () => {
  withTemp(root => {
    const source = resolve(root, 'source');
    writeSource(source);
    const result = buildPackage(request(source, resolve(root, 'out'), 1_700_000_000));
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));

    assert.equal(existsSync(resolve(result.outputRoot, 'manifest.json')), true);
    assert.equal(existsSync(resolve(result.outputRoot, 'dependency-manifest.json')), true);
    assert.equal(existsSync(resolve(result.outputRoot, 'entry.mjs')), true, 'the compiled entry artifact is copied');
    assert.equal(existsSync(resolve(result.outputRoot, 'assets/voice.json')), true, 'the asset artifact is copied');
    assert.equal(existsSync(resolve(result.outputRoot, 'README.md')), true);
    assert.equal(readFileSync(resolve(result.outputRoot, 'entry.mjs'), 'utf8'), readFileSync(resolve(source, 'entry.mjs'), 'utf8'));

    const manifest = JSON.parse(readFileSync(resolve(result.outputRoot, 'manifest.json'), 'utf8')) as PackageManifest;
    assert.equal(manifest.packageId, 'com.aika.fixture.build');
    assert.deepEqual([...manifest.files].map(file => file.path).sort(), ['README.md', 'assets/voice.json', 'entry.mjs']);
    assert.equal(result.manifestHash, manifest.manifestHash);
    assert.ok(manifest.manifestHash.startsWith('sha256-'));
  });
});

test('01-D: the dependency-manifest carries the package identity, required/optional sets and entry list', () => {
  withTemp(root => {
    const source = resolve(root, 'source');
    writeSource(source);
    const result = buildPackage(request(source, resolve(root, 'out'), 1_700_000_000));
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));

    const dependency = JSON.parse(readFileSync(result.dependencyManifestPath, 'utf8')) as PackageDependencyManifest;
    assert.equal(dependency.schemaVersion, 1);
    assert.equal(dependency.packageId, 'com.aika.fixture.build');
    assert.equal(dependency.version, '1.0.0');
    assert.equal(dependency.hostApiVersion, PLUGIN_API_VERSION);
    assert.deepEqual(dependency.required, [{ packageId: 'com.aika.fixture.core', range: '>=1.0.0 <2.0.0', reason: '共享能力契约' }]);
    assert.deepEqual(dependency.optional, [{ packageId: 'com.aika.fixture.extra', range: '^0.9.0', reason: '可选音色' }]);
    assert.deepEqual(dependency.entries, ['entry.mjs']);
    assert.equal(dependency.manifestHash, result.manifestHash);
    assert.equal(dependency.fileCount, 3);
    assert.equal(dependency.builtAtEpochSeconds, 1_700_000_000);
    assert.ok(dependency.totalBytes > 0);
  });
});

test('01-D: two builds of identical content with the same epochSeconds are verifiably identical', () => {
  withTemp(root => {
    const source = resolve(root, 'source');
    writeSource(source);
    const first = buildPackage(request(source, resolve(root, 'out-a'), 1_700_000_123));
    const second = buildPackage(request(source, resolve(root, 'out-b'), 1_700_000_123));
    assert.equal(first.ok, true, JSON.stringify(first.issues, null, 2));
    assert.equal(second.ok, true, JSON.stringify(second.issues, null, 2));

    assert.equal(first.manifestHash, second.manifestHash, 'the manifest hash must not depend on the output path');
    assert.equal(packageDigest(first.outputRoot), packageDigest(second.outputRoot), 'same content → same package digest');
    assert.equal(
      readFileSync(resolve(first.outputRoot, 'manifest.json'), 'utf8'),
      readFileSync(resolve(second.outputRoot, 'manifest.json'), 'utf8'),
      'the manifest bytes must be identical, not just equivalent',
    );
    assert.equal(
      readFileSync(first.dependencyManifestPath, 'utf8'),
      readFileSync(second.dependencyManifestPath, 'utf8'),
    );
    assert.ok(packageDigest(first.outputRoot).startsWith('sha256-'));
  });
});

test('01-D: a different epochSeconds changes the dependency manifest but not the content digest', () => {
  withTemp(root => {
    const source = resolve(root, 'source');
    writeSource(source);
    const early = buildPackage(request(source, resolve(root, 'out-early'), 1_700_000_000));
    const late = buildPackage(request(source, resolve(root, 'out-late'), 1_700_000_999));
    assert.equal(early.ok, true);
    assert.equal(late.ok, true);
    assert.equal(packageDigest(early.outputRoot), packageDigest(late.outputRoot), 'content digest covers content, not build time');
    const earlyDep = JSON.parse(readFileSync(early.dependencyManifestPath, 'utf8')) as PackageDependencyManifest;
    const lateDep = JSON.parse(readFileSync(late.dependencyManifestPath, 'utf8')) as PackageDependencyManifest;
    assert.equal(earlyDep.builtAtEpochSeconds, 1_700_000_000);
    assert.equal(lateDep.builtAtEpochSeconds, 1_700_000_999);
  });
});

test('01-D: a .key file in the source is refused at build time, not silently dropped', () => {
  withTemp(root => {
    const source = resolve(root, 'source');
    writeSource(source);
    mkdirSync(resolve(source, 'secrets'), { recursive: true });
    writeFileSync(resolve(source, 'secrets/service.key'), 'PRIVATE KEY\n', 'utf8');
    assert.equal(isForbiddenContent('secrets/service.key'), true, '.key is a forbidden extension');

    const result = buildPackage(request(source, resolve(root, 'out'), 1_700_000_000));
    assert.equal(result.ok, false, 'a build that would carry a key must fail');
    const categories = result.issues.map(issue => issue.category);
    assert.deepEqual([...new Set(categories)], ['package_forbidden_content'], JSON.stringify(result.issues, null, 2));
    assert.equal(result.issues[0]!.path, 'secrets/service.key');
    assert.match(result.issues[0]!.detail, /a private key or a model weight must never enter a package/);
    assert.equal(existsSync(resolve(result.outputRoot, 'manifest.json')), false, 'the refused build writes no package');
  });
});

test('01-D: a model weight (.onnx) in the source is refused at build time', () => {
  withTemp(root => {
    const source = resolve(root, 'source');
    writeSource(source);
    mkdirSync(resolve(source, 'models'), { recursive: true });
    writeFileSync(resolve(source, 'models/vits.onnx'), '\u0000\u0001\u0002weights', 'utf8');
    assert.equal(isForbiddenContent('models/vits.onnx'), true, '.onnx is a forbidden extension');

    const result = buildPackage(request(source, resolve(root, 'out'), 1_700_000_000));
    assert.equal(result.ok, false);
    assert.deepEqual([...new Set(result.issues.map(issue => issue.category))], ['package_forbidden_content']);
    assert.equal(result.issues[0]!.path, 'models/vits.onnx');
    assert.equal(existsSync(resolve(result.outputRoot, 'manifest.json')), false);
  });
});

test('01-D: the forbidden-name patterns catch a key without a telling extension', () => {
  assert.equal(isForbiddenContent('deploy/id_rsa'), true);
  assert.equal(isForbiddenContent('config/.env.local'), true);
  assert.equal(isForbiddenContent('config/credentials.json'), true);
  assert.equal(isForbiddenContent('secrets.json'), true);
  assert.equal(isForbiddenContent('deploy/id_rsa.pub'), true);
  assert.equal(isForbiddenContent('entry.mjs'), false);
  assert.equal(isForbiddenContent('assets/voice.json'), false);
});

test('01-D: a package that declares weights as an EXTERNAL resource still builds (weights stay a reference)', () => {
  withTemp(root => {
    const source = resolve(root, 'source');
    writeSource(source);
    const result = buildPackage({
      ...request(source, resolve(root, 'out'), 1_700_000_000),
      resources: [{
        id: 'vits-weights',
        kind: 'model',
        reference: 'external://models/vits.onnx',
        required: true,
        readiness: null,
        external: true,
      }],
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as PackageManifest;
    assert.deepEqual(manifest.resources.map(resource => ({ id: resource.id, external: resource.external })), [{ id: 'vits-weights', external: true }]);
    assert.equal(existsSync(resolve(result.outputRoot, 'models/vits.onnx')), false, 'the weight is referenced, never packed');
  });
});

test('01-D: a built package passes the host validator on the built output', () => {
  withTemp(root => {
    const source = resolve(root, 'source');
    writeSource(source);
    const result = buildPackage(request(source, resolve(root, 'out'), 1_700_000_000));
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));

    const validation = validateManifestFile(result.outputRoot);
    assert.equal(validation.ok, true, JSON.stringify(validation.issues, null, 2));
    assert.deepEqual(validation.issues, []);
    const manifest = validation.manifest as PackageManifest;
    assert.equal(manifest.packageId, 'com.aika.fixture.build');
    for (const file of manifest.files) {
      assert.equal(existsSync(resolve(result.outputRoot, file.path)), true, file.path);
    }
    const present = readdirSync(result.outputRoot).sort();
    assert.deepEqual(present, ['README.md', 'assets', 'dependency-manifest.json', 'entry.mjs', 'manifest.json']);
    assert.equal(dirname(result.manifestPath), result.outputRoot);
  });
});

test('01-D: a source tree is never mutated by a build', () => {
  withTemp(root => {
    const source = resolve(root, 'source');
    writeSource(source);
    const before = readFileSync(resolve(source, 'entry.mjs'), 'utf8');
    buildPackage(request(source, resolve(root, 'out'), 1_700_000_000));
    assert.equal(readFileSync(resolve(source, 'entry.mjs'), 'utf8'), before);
    assert.equal(existsSync(resolve(source, 'manifest.json')), false, 'the build writes into the output, never back into the source');
  });
});
