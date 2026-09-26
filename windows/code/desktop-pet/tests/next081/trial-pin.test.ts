/**
 * tests/next081/trial-pin.test.ts
 *
 * N081-06 acceptance: 实机放行的环境前置可判定，且不会被静默绕过。
 *
 * AC-08106-7: pin 检查只读、给出可行动结论、区分"环境不可行"与"配置缺失"
 * AC-08106-8: 检查不提供绕过 verifyTrialRuntime 的通道
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..', '..', '..');
const script = resolve(projectRoot, 'tools/check-next081-trial-pin.mjs');

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 300_000 });
}

test('AC-08106-7: the pin check reports a machine-readable verdict with actionable detail', () => {
  const result = run([]);
  // Exit 0 = satisfiable, 3 = environment cannot satisfy the pin. Both are legitimate states; what
  // must hold in either case is that the verdict is machine-readable and internally consistent.
  assert.ok(result.status === 0 || result.status === 3,
    `expected a pin verdict (0 or 3), got ${result.status}: ${result.stderr}`);

  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(typeof report.launchable, 'boolean');
  assert.equal(typeof report.pinnedSourceRevision, 'string');
  assert.ok(report.pinnedFiles > 0, 'the configuration must declare pinned files');
  // The three counts must partition the pinned set exactly; no file may be unaccounted for.
  assert.equal(report.matched + report.diverged + report.missing, report.pinnedFiles,
    'every pinned file must be classified exactly once');

  // Categorisation must add up to the divergence count.
  const area = report.divergenceByArea;
  assert.equal(area.compiledOutput + area.shippedDesktop + area.tools + area.other, report.diverged);

  // The exit code must agree with the reported verdict; a mismatch would let a caller act on a lie.
  assert.equal(report.launchable, report.diverged === 0 && report.missing === 0,
    'launchable must mean exactly "no divergence and nothing missing"');
  assert.equal(result.status, report.launchable ? 0 : 3, 'exit code must match the verdict');

  if (!report.launchable) {
    // When it refuses, it must explain itself and forbid the tempting shortcut.
    assert.match(result.stderr, /NOT_RUN/);
    assert.match(result.stderr, /Do NOT bypass verifyTrialRuntime/);
  } else {
    assert.match(result.stderr, /OK: this checkout satisfies the trial pin/);
  }
});

test('AC-08106-8: the check is read-only and offers no bypass path', () => {
  const source = readFileSync(script, 'utf8');
  // It must never start the product, rewrite the pin or relax verification. `verifyTrialRuntime`
  // appears only inside the refusal text telling readers NOT to bypass it — so assert it is never
  // *imported*, rather than asserting the bare word is absent.
  for (const forbidden of ['writeFileSync', 'rmSync', 'unlinkSync', "from '../app/trial-launcher.js'", 'spawn(']) {
    assert.equal(source.includes(forbidden), false, `the pin check must not use ${forbidden}`);
  }
  assert.equal(/import[^;]*verifyTrialRuntime/.test(source), false,
    'the pin check must not import the runtime verifier it is advising against bypassing');
  assert.match(source, /Do NOT bypass verifyTrialRuntime/, 'the refusal must name the guard it refuses to bypass');
  // It reports; it does not repair.
  assert.equal(source.includes('launchable'), true);
  assert.equal(source.includes('sourceRevision'), true);

  // A missing configuration is a different failure from an unsatisfiable pin.
  const empty = mkdtempSync(join(tmpdir(), 'aika-08106-pin-'));
  const missing = run(['--config', join(empty, 'absent.json')]);
  assert.equal(missing.status, 2, 'a missing configuration must exit 2, not 3');
  assert.match(missing.stderr, /no trial configuration/);

  // Invalid JSON is also exit 2, and must not crash with a stack trace.
  const invalid = join(empty, 'invalid.json');
  writeFileSync(invalid, '{ not json');
  const bad = run(['--config', invalid]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /not valid JSON/);

  // An unknown argument is refused rather than ignored, so no flag can silently relax the check.
  const unknown = run(['--force']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown argument/);
});
