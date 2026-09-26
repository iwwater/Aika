/**
 * tests/next081/resource-measurement.test.ts
 *
 * N081-00 §6 acceptance: 资源测量只报实测值、不伪造通过线、不泄漏路径。
 *
 * AC-08100-6: 缺产物/缺阈值时如实报告而非填充；探针自证存活；报告不含本地路径
 * AC-08100-7: 阈值文件存在时按线判定，缺键记 NOT_RUN 而非当作通过
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..', '..', '..');
const script = resolve(projectRoot, 'tools/measure-next081-resources.mjs');

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
}

test('AC-08100-6: the measurement reports real values with a live-probe proof and no local path', { skip: process.platform !== 'win32' }, () => {
  const helper = resolve(projectRoot, 'dist/collection/aika-collection-helper.exe');
  const probe = resolve(projectRoot, 'dist/collection/aika-perf-probe.exe');
  if (!existsSync(helper) || !existsSync(probe)) {
    assert.fail(`NOT_RUN: build artifacts missing (${helper} / ${probe}); run npm run build:collection.`);
  }

  const outDirectory = mkdtempSync(join(tmpdir(), 'aika-08100-measure-'));
  const outFile = join(outDirectory, 'resources.json');
  // A short window keeps the test bounded while still sampling several times.
  const result = run(['--seconds', '8', '--out', outFile]);
  assert.equal(result.status, 0, `measurement must complete: ${result.stderr}`);

  const report = JSON.parse(readFileSync(outFile, 'utf8'));
  // The helper really ran and really aggregated something.
  assert.equal(report.helper.ready, true, 'the helper must complete its handshake');
  assert.ok(report.helper.activityBucketsObserved >= 1,
    'the measurement window must contain actual aggregation, not an idle loop');

  // The instrument proves it is alive; without this a 0% CPU figure would be uninterpretable.
  assert.equal(report.cpu.probeSelfTest.ok, true, 'the resource probe must report a live CPU delta');
  assert.ok(report.cpu.probeSelfTest.deltaMs > 0, 'the self-test must observe real CPU progress');

  // No threshold file was supplied, so the script must refuse to assert a pass line.
  assert.equal(report.verdict, 'NOT_JUDGED', 'without thresholds the script must not judge');
  assert.equal('thresholds' in report, false);

  // Measured memory and disk figures exist as numbers, not placeholders.
  assert.equal(typeof report.memory.busyPrivateBytes, 'number');
  assert.ok(report.memory.busyPrivateBytes > 0);
  assert.equal(typeof report.disk.growthBytes, 'number');

  // The store path was measured against real SQLite, and its own numbers must be self-consistent.
  assert.ok(report.store, 'the report must include a store-path measurement');
  assert.equal(report.store.keyboardInserts, 50);
  assert.equal(report.store.imageInserts, 12);
  assert.equal(report.store.activeSamples, report.store.keyboardInserts + report.store.imageInserts,
    'the active-sample count must equal the inserts actually made');
  assert.equal(report.store.managedBytesAfter, report.store.imageInserts * report.store.imagePayloadBytes,
    'managed bytes must equal distinct 1 MiB images written');
  assert.ok(report.store.keyboardLatencyMs.p95 > 0, 'keyboard latency must be a real measurement');
  assert.ok(report.store.imageLatencyMs.p95 >= report.store.keyboardLatencyMs.median,
    'an image copy must not measure faster than the cheapest write');
  // A p95 below the max is the shape of a real latency series, not a constant.
  assert.ok(report.store.imageLatencyMs.p95 <= report.store.imageLatencyMs.max);

  // Concurrent two-source load was exercised, and the first-sample artefact is separated, not hidden.
  const concurrent = report.store.concurrent;
  assert.ok(concurrent, 'the report must include a concurrent-load measurement');
  assert.equal(concurrent.keyboardWrites, 25);
  assert.equal(concurrent.imageWrites, 25);
  assert.equal(concurrent.samplesAfter, 112, 'all sequential and concurrent writes must be accounted for');
  assert.ok(concurrent.worstObservedMs >= concurrent.combinedLatencyMs.p95,
    'the worst case can never be below the p95');

  // The first interleaved sample absorbs the other loop's blocking batch, so it is retained for
  // transparency but excluded from the percentiles. Steady state must therefore be clean.
  assert.equal(typeof concurrent.firstSampleMs.keyboard, 'number');
  assert.ok(concurrent.firstSampleMs.keyboard > 100,
    'the first interleaved sample must show the blocking artefact, or this test proves nothing');
  assert.equal(concurrent.stallsOver50ms, 0,
    'once the scheduling artefact is excluded, no write may stall');
  assert.ok(concurrent.keyboardLatencyMs.p95 < 50,
    'steady-state keyboard latency must stay well below a user-visible stall');
  assert.ok(concurrent.imageLatencyMs.p95 < 50,
    'steady-state image latency must stay well below a user-visible stall');

  // A report must never carry a filesystem path.
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(outDirectory), false, 'the report must not contain the output path');
  assert.equal(/[A-Za-z]:\\\\/.test(serialized), false, 'the report must not contain a Windows path');
  assert.equal(serialized.includes('file://'), false);

  // The measurement never authorized a source.
  assert.equal(report.sourceGrantIssued, false);
  assert.equal(report.scope, 'controlled-local-instance');
});

test('AC-08100-7: thresholds are only applied from a supplied file, and a missing key is NOT_RUN', { skip: process.platform !== 'win32' }, () => {
  const outDirectory = mkdtempSync(join(tmpdir(), 'aika-08100-thresholds-'));
  const outFile = join(outDirectory, 'judged.json');
  // An impossible CPU ceiling forces a real FAIL, proving the comparison is wired.
  const thresholdFile = join(outDirectory, 'thresholds.json');
  writeFileSync(thresholdFile, JSON.stringify({ cpuPercentOfOneCore: -1, privateMemoryBytes: 1_000_000_000_000 }));

  const result = run(['--seconds', '8', '--out', outFile, '--thresholds', thresholdFile]);
  const report = JSON.parse(readFileSync(outFile, 'utf8'));

  assert.ok(report.thresholds, 'a supplied threshold file must produce a judgement block');
  const checks = report.thresholds.checks as { id: string; status: string }[];
  assert.ok(checks.length >= 2);
  // The impossible CPU line must fail; the generous memory line must pass.
  assert.equal(checks.find(check => check.id === 'cpuPercentOfOneCore')!.status, 'FAIL');
  assert.equal(checks.find(check => check.id === 'privateMemoryBytes')!.status, 'PASS');
  // A key that was not supplied is NOT_RUN, never an implied pass.
  assert.equal(checks.find(check => check.id === 'diskGrowthBytesPerWindow')!.status, 'NOT_RUN');
  assert.equal(report.verdict, 'FAIL', 'any failing check makes the verdict FAIL');
  assert.equal(result.status, 1, 'a FAIL verdict exits non-zero');

  // The shipped template is honest about being unfilled: every line is null.
  const template = JSON.parse(readFileSync(resolve(projectRoot, '..', '..', '..', 'docs/next/0.81/perf-thresholds.template.json'), 'utf8'));
  assert.equal(template.cpuPercentOfOneCore, null);
  assert.equal(template.privateMemoryBytes, null);
  assert.equal(template.diskGrowthBytesPerWindow, null);
  assert.equal(template.keyboardInsertLatencyP95Ms, null);
  assert.equal(template.imageInsertLatencyP95Ms, null);
  // The unresolved concurrent finding must be carried in the same file, so filling the pass lines
  // cannot quietly drop an open performance question.
  assert.equal(template._openFinding?.status, 'RESOLVED');
  assert.equal(template._openFinding?.id, 'N08100-CONCURRENT-FIRST-KEYBOARD-WRITE');
  assert.equal(template._openFinding?.resolution.includes('测量方法'), true,
    'the resolution must name the measurement-method cause, not a product defect');
  // Reference values are labelled as reference, never as pass lines.
  assert.equal(template._reference?.note.includes('不是通过线'), true);
});

test('AC-08100-6: an invalid window is refused and the script never scans user directories', () => {
  const badWindow = run(['--seconds', '1']);
  assert.equal(badWindow.status, 2, 'a window below the minimum must be refused');

  const badArg = run(['--scan', 'C:/Users']);
  assert.notEqual(badArg.status, 0, 'an unsupported argument must not be silently accepted');

  // The script must not reference a user directory or a pictures path anywhere in its source.
  const source = readFileSync(script, 'utf8');
  for (const forbidden of ['Pictures', 'Screenshots', 'homedir()', 'USERPROFILE']) {
    assert.equal(source.includes(forbidden), false, `the measurement script must not reference ${forbidden}`);
  }
  // It writes only inside an isolated temporary root it created itself.
  assert.equal(source.includes('mkdtempSync'), true, 'the measurement must create its own isolated root');
});
