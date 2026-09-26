#!/usr/bin/env node
/**
 * tools/run-next08-electron.mjs
 *
 * Runs the 0.8 Electron acceptance scenarios that need a real Chromium/Electron window.
 * Each scenario prints a single `<NAME>_RESULT={json}` line; this runner aggregates the verdicts so a
 * failure is visible as a non-zero exit code rather than buried in Electron's own log noise.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const electron = createRequire(import.meta.url)('electron');

const scenarios = [
  { name: '08-04 invitation bubble and auto-dismiss', file: 'tests/next08/invitation-bubble-electron.mjs', marker: 'INVITATION_BUBBLE_RESULT=' },
];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let failed = 0;
for (const scenario of scenarios) {
  const child = spawn(electron, [resolve(root, scenario.file)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exitCode = await new Promise((done, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(Error(`${scenario.name} timed out`)); }, 90_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); done(code ?? 1); });
  }).catch(error => { console.error(error.message); return 1; });

  const line = stdout.split(/\r?\n/).find(value => value.startsWith(scenario.marker));
  if (!line) {
    failed++;
    console.log(`FAIL ${scenario.name}: no result line (exit=${exitCode})`);
    if (stderr.trim()) console.log(stderr.trim().split(/\r?\n/).slice(-5).join('\n'));
    continue;
  }
  const payload = JSON.parse(line.slice(scenario.marker.length));
  if (payload.error) {
    failed++;
    console.log(`FAIL ${scenario.name}: ${payload.error}`);
    continue;
  }
  const bad = (payload.results ?? []).filter(entry => entry.status !== 'PASS');
  if (bad.length === 0 && exitCode === 0) {
    console.log(`PASS ${scenario.name}: ${payload.results.length}/${payload.results.length} checks`);
  } else {
    failed++;
    console.log(`FAIL ${scenario.name}: exit=${exitCode}`);
    for (const entry of bad) console.log(`  - ${entry.id}: ${entry.detail}`);
  }
}

console.log(failed === 0 ? '\nNEXT08_ELECTRON_OK' : `\nNEXT08_ELECTRON_FAILED=${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
