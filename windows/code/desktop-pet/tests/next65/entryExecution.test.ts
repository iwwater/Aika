/**
 * K65-01 · 01-B: validating a package whose ENTRY HAS AN OBSERVABLE TOP-LEVEL SIDE EFFECT executes
 * that entry ZERO times.
 *
 * TESTING.md forbids proving "not loaded" from a source string, so the discriminator here is real:
 * `side-effect/entry.mjs` appends exactly one heartbeat line to a log file at module top level. The
 * proof runs in two REAL child processes:
 *
 *   1. the validator process — `validate-driver.mjs` (a thin wrapper around the real
 *      `validateManifestFile`) runs with AIKA_SIDE_EFFECT_LOG pointed at a temp file;
 *   2. the positive control — `node <entry>` runs with the SAME env var, and MUST produce a heartbeat.
 *
 * Case (1) leaving zero heartbeats while case (2) produces some is the execution-count claim. Case (2)
 * is what keeps (1) from being vacuous: without it, a validator AND an entry that both did nothing
 * would look identical.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkModuleGraph } from '../../plugins/esm-graph.mjs';

// Compiled to dist/tests/next65 but the fixtures live beside the source; walk out of `dist` the same
// way tests/next65/packageManifest.test.ts does.
let testDirectory = dirname(fileURLToPath(import.meta.url));
if (basename(testDirectory) === 'next65' && basename(dirname(dirname(testDirectory))) === 'dist') {
  testDirectory = resolve(dirname(dirname(testDirectory)), '..', 'tests', 'next65');
}
const repositoryRoot = resolve(testDirectory, '..', '..');
const sideEffectPackage = resolve(testDirectory, 'fixtures', 'packages', 'side-effect');
const validateDriver = resolve(testDirectory, 'fixtures', 'packages', 'validate-driver.mjs');

/** Counts heartbeat lines in the artifact, or 0 when the artifact was never created. */
function heartbeatCount(artifactPath: string): number {
  if (!existsSync(artifactPath)) return 0;
  return readFileSync(artifactPath, 'utf8').split('\n').filter(line => line.startsWith('heartbeat')).length;
}

/** Runs `node <argv...>` with AIKA_SIDE_EFFECT_LOG set, and fails loudly on a crashed child. */
function runNode(args: readonly string[], artifact: string, cwd: string): { status: number; stdout: string; stderr: string } {
  const spawned = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, AIKA_SIDE_EFFECT_LOG: artifact },
  });
  if (spawned.error) assert.fail(`could not start the child process: ${String(spawned.error)}`);
  return { status: spawned.status ?? -1, stdout: spawned.stdout ?? '', stderr: spawned.stderr ?? '' };
}

test('01-B: the side-effect fixture exists and really declares a top-level side effect entry', () => {
  assert.equal(existsSync(sideEffectPackage), true, 'run tests/next65/fixtures/packages/make-side-effect-fixture.mjs first');
  assert.equal(existsSync(resolve(sideEffectPackage, 'entry.mjs')), true);
  assert.equal(existsSync(resolve(sideEffectPackage, 'manifest.json')), true);

  // Fixture self-description, not the claim: the manifest points at the side-effecting module.
  const manifest = JSON.parse(readFileSync(resolve(sideEffectPackage, 'manifest.json'), 'utf8')) as { plugins: { entry: string }[] };
  assert.equal(manifest.plugins[0]!.entry, 'entry.mjs');
  assert.match(readFileSync(resolve(sideEffectPackage, 'entry.mjs'), 'utf8'), /appendFileSync/);
});

test('01-B: POSITIVE CONTROL — running the entry directly executes its top-level side effect', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'k65-01b-control-'));
  try {
    const artifact = resolve(root, 'heartbeat.log');
    const run = runNode([resolve(sideEffectPackage, 'entry.mjs')], artifact, repositoryRoot);

    assert.equal(run.status, 0, `the entry must be runnable: ${run.stderr || run.stdout}`);
    assert.equal(existsSync(artifact), true, 'the artifact file must be created by running the entry');
    assert.ok(heartbeatCount(artifact) >= 1, `the direct run must leave at least one heartbeat, got ${heartbeatCount(artifact)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('01-B: the real validateManifestFile in a real child process executes the entry ZERO times', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'k65-01b-validate-'));
  try {
    const artifact = resolve(root, 'heartbeat.log');
    const run = runNode([validateDriver, sideEffectPackage], artifact, repositoryRoot);

    assert.equal(run.status, 0, `the validator driver must exit cleanly: ${run.stderr || run.stdout}`);

    // The validator itself must accept the package — otherwise "nothing executed" would just mean
    // "it bailed out before reaching anything".
    const report = JSON.parse(run.stdout.trim().split('\n').pop()!) as { ok: boolean; issues: unknown[]; entries: string[] };
    assert.equal(report.ok, true, `the fixture must validate; issues: ${JSON.stringify(report.issues, null, 2)}`);
    assert.deepEqual(report.issues, []);
    assert.deepEqual(report.entries, ['entry.mjs'], 'the side-effecting entry is the one being validated');

    // THE CLAIM: execution count zero.
    assert.equal(existsSync(artifact), false, `validation must not create the side-effect artifact at ${artifact}`);
    assert.equal(heartbeatCount(artifact), 0, 'the entry top level ran 0 times: zero heartbeats');

    // And the same process could have written it — otherwise the missing artifact proves nothing.
    const control = runNode([resolve(sideEffectPackage, 'entry.mjs')], artifact, repositoryRoot);
    assert.equal(control.status, 0, control.stderr || control.stdout);
    assert.ok(heartbeatCount(artifact) >= 1, 'the positive control must prove this artifact path is writable and counted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('01-B: validation leaves no stray heartbeat anywhere under the fixture root', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'k65-01b-stray-'));
  try {
    const artifact = resolve(root, 'heartbeat.log');
    const run = runNode([validateDriver, sideEffectPackage], artifact, repositoryRoot);
    assert.equal(run.status, 0, run.stderr || run.stdout);

    // A heartbeat written into the PACKAGE itself would additionally have made every fixture file
    // undeclared: the host re-walks the directory, so it would show up as package_forbidden_content.
    const after = JSON.parse(run.stdout.trim().split('\n').pop()!) as { ok: boolean; issues: { category: string }[] };
    assert.equal(after.ok, true, `no new content may appear during validation: ${JSON.stringify(after.issues)}`);
    assert.deepEqual(after.issues, []);
    assert.equal(existsSync(resolve(sideEffectPackage, 'heartbeat.log')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('01-B: the same runner twice multiplies heartbeats, so a heartbeat counts executions', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'k65-01b-multiply-'));
  try {
    const artifact = resolve(root, 'heartbeat.log');
    assert.equal(runNode([resolve(sideEffectPackage, 'entry.mjs')], artifact, repositoryRoot).status, 0);
    const afterFirst = heartbeatCount(artifact);
    assert.equal(runNode([resolve(sideEffectPackage, 'entry.mjs')], artifact, repositoryRoot).status, 0);
    const afterSecond = heartbeatCount(artifact);

    assert.equal(afterFirst, 1, 'one top-level run appends exactly one heartbeat');
    assert.equal(afterSecond, 2, 'a second run appends a second heartbeat: the artifact counts executions');

    // Which is what makes the validator's zero mean zero, not "unmeasurable".
    const validation = runNode([validateDriver, sideEffectPackage], resolve(root, 'validation.log'), repositoryRoot);
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);
    assert.equal(heartbeatCount(resolve(root, 'validation.log')), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('01-B: the validator reads manifest.json only — no module named by an entry is ever in its graph', () => {
  // Static support, never the load claim: the shared scanner's walk of the real validateManifestFile
  // implementation contains no path to any package entry.
  const graph = walkModuleGraph(resolve(repositoryRoot, 'dist', 'plugins', 'manifest.js'));
  const entryTargets = graph.files
    .flatMap(file => file.specifiers)
    .filter(specifier => /entry|fixtures/.test(specifier));
  assert.deepEqual(entryTargets, [], `the validator's import graph must never reach a fixture entry: ${JSON.stringify(entryTargets)}`);
  assert.ok(graph.files.length > 0, 'the graph walk must really have walked the validator');
});
