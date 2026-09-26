/** K65-09: metadata-only management projection, guarded profile editing and redacted diagnostics. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { importPackageHost } from '../../plugins/host-config.js';
import { FlowRuntime } from '../../kernel/flow-runtime.js';
import { Next65Management } from '../../management/next65-management.js';

const root = resolve(process.cwd()); const tts = resolve(root, 'dist/next65/packages/tts');
const profile = { schemaVersion: 1 as const, profileId: 'management.fixture', revision: 1, label: '管理 fixture', nodes: [], failurePolicy: { onStageFailure: 'fail_turn' as const, retrySideEffects: false as const, maxAttempts: 1 }, joinOrder: [] };

test('09-A/B/C: package list is metadata-only, profile preview has no handlers, and save uses revision checks', () => {
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'k65-09-host-'));
  try {
    assert.equal(importPackageHost({ sourceRoot: tts, hostRoot }).ok, true);
    const management = new Next65Management(hostRoot, new FlowRuntime([]));
    const listed = management.packages(); assert.equal(listed[0]!.loaded, false); assert.equal(listed[0]!.manifestLabels.length, 1);
    assert.deepEqual(management.previewProfile(profile), []);
    management.saveProfile(profile, 1); assert.equal(management.profiles()[0]!.profile.profileId, 'management.fixture');
    assert.throws(() => management.saveProfile({ ...profile, revision: 2 }, 0), /revision conflict/);
  } finally { rmSync(hostRoot, { recursive: true, force: true }); }
});

test('09-D/E: diagnostics are bounded and redact credentials while preserving stage/profile/package identity', () => {
  const hostRoot = mkdtempSync(resolve(tmpdir(), 'k65-09-diag-'));
  try {
    const management = new Next65Management(hostRoot);
    for (let i = 0; i < 205; i += 1) management.recordDiagnostic({ scopeId: `scope-${i}`, profileId: 'p', profileRevision: 2, packageVersions: { 'com.aika.product.tts': '0.65.0' }, stageId: 'tts', status: i === 204 ? 'failed' : 'completed', detail: `apiKey=secret-${i}` });
    const diagnostics = management.diagnostics(); assert.equal(diagnostics.length, 200); assert.equal(diagnostics.at(-1)!.detail.includes('secret-204'), false); assert.match(diagnostics.at(-1)!.detail, /redacted/); assert.equal(diagnostics.at(-1)!.profileRevision, 2);
  } finally { rmSync(hostRoot, { recursive: true, force: true }); }
});
