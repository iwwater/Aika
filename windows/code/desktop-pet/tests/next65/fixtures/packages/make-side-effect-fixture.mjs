/**
 * K65-01 (01-B) fixture builder: writes ONE real directory package,
 * tests/next65/fixtures/packages/side-effect/, whose ENTRY HAS A GENUINE TOP-LEVEL SIDE EFFECT
 * (it appends one heartbeat line to an artifact file at module top level). That artifact is the
 * discriminator for 01-B: "校验带可观察顶层副作用的测试入口时，该入口执行次数为零" is then a count of
 * heartbeat lines, not a claim about the source.
 *
 * The manifest.json hash is computed by the production `contentHash` / `computeManifestHash`, so the
 * committed fixture is what the host validator accepts.
 *
 * Excluded from the host compile (tsconfig excludes tests/next65/fixtures/**), so the entry is .mjs.
 *
 * Run: node tests/next65/fixtures/packages/make-side-effect-fixture.mjs (needs `npm run build` first).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeManifestHash, contentHash } from '../../../../dist/plugins/manifest.js';

const here = dirname(fileURLToPath(import.meta.url));

const ENTRY = `/**
 * K65-01 (01-B): a package entry with a GENUINE, OBSERVABLE top-level side effect.
 *
 * Importing this module appends exactly one line to the artifact file, so "the validator executed
 * the entry" and "the validator did not execute the entry" differ by a line count on disk. The
 * artifact path comes from AIKA_SIDE_EFFECT_LOG so the test can point both the validator run and the
 * positive-control run at the same file inside a temp root; it never lands inside the package, so a
 * heartbeat can never be mistaken for undeclared package content.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname as dirnameOf, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifactPath = process.env.AIKA_SIDE_EFFECT_LOG
  ? resolvePath(process.env.AIKA_SIDE_EFFECT_LOG)
  : resolvePath(tmpdir(), 'aika-fixture-heartbeat.log');

// >>> THE SIDE EFFECT: one append per top-level module execution. <<<
mkdirSync(dirnameOf(artifactPath), { recursive: true });
appendFileSync(artifactPath, 'heartbeat ' + new Date().toISOString() + '\\n', 'utf8');

export const HEARTBEAT_ARTIFACT = artifactPath;

/** How many times this module's top level has run, counted from the artifact itself. */
export function heartbeatCount() {
  try {
    return readFileSync(artifactPath, 'utf8').split('\\n').filter(line => line.startsWith('heartbeat')).length;
  } catch {
    return 0;
  }
}

export const activation = { pluginId: 'side.effect.plugin' };
`;

const README = '# 副作用探针包\n\nK65-01 01-B fixture：entry.mjs 在模块顶层追加一行 heartbeat，用于证明校验入口执行次数为零。\n';

const files = [
  { path: 'entry.mjs', body: ENTRY, role: 'entry' },
  { path: 'README.md', body: README, role: 'documentation' },
];

const root = resolve(here, 'side-effect');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
for (const file of files) writeFileSync(resolve(root, file.path), file.body, 'utf8');

const declared = files
  .map(file => ({ path: file.path, bytes: Buffer.byteLength(file.body, 'utf8'), hash: contentHash(file.body), role: file.role, executable: false }))
  .sort((left, right) => (left.path < right.path ? -1 : 1));

const manifest = {
  schemaVersion: 1,
  formatVersion: 1,
  hostApiRange: '>=1.0.0 <2.0.0',
  packageId: 'com.aika.fixture.sideeffect',
  version: '1.0.0',
  label: '副作用探针包',
  dependencies: [],
  optionalDependencies: [],
  resources: [],
  platform: { platform: ['any'], arch: ['any'], runtimeVersion: '22.0.0', features: [] },
  plugins: [{
    pluginId: 'side.effect.plugin',
    entry: 'entry.mjs',
    label: '顶层副作用探针插件',
    capabilities: [{
      capabilityId: 'background.lifecycle',
      category: 'background_lifecycle',
      adapterId: 'sideeffect.local',
      adapterVersion: '1.0.0',
      contractVersion: '1.0.0',
      auth: 'none',
      sideEffect: 'local_write',
      execution: ['unary'],
      parameters: ['pollIntervalMs'],
      inputs: [{ name: 'pollIntervalMs', type: 'string', required: true, description: '探针间隔' }],
      outputs: [{ name: 'status', type: 'string', required: true, description: '探针状态' }],
    }],
  }],
  permissions: [],
  files: declared,
  manifestHash: 'sha256-' + '0'.repeat(64),
};
manifest.manifestHash = computeManifestHash(manifest);
writeFileSync(resolve(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`side-effect: ${declared.length} files, manifestHash ${manifest.manifestHash.slice(0, 20)}…`);
