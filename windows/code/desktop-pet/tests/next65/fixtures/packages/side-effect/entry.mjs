/**
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
appendFileSync(artifactPath, 'heartbeat ' + new Date().toISOString() + '\n', 'utf8');

export const HEARTBEAT_ARTIFACT = artifactPath;

/** How many times this module's top level has run, counted from the artifact itself. */
export function heartbeatCount() {
  try {
    return readFileSync(artifactPath, 'utf8').split('\n').filter(line => line.startsWith('heartbeat')).length;
  } catch {
    return 0;
  }
}

export const activation = { pluginId: 'side.effect.plugin' };
