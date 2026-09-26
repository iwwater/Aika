#!/usr/bin/env node
// Read-only check: does the activated trial configuration still match the current build?
// Prints counts, digests and statuses only. Never prints user data.
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const dir = resolve(root, '.local/model-evaluation/trial/user-trial');
const config = JSON.parse(await readFile(resolve(dir, 'config.json'), 'utf8'));
const activation = JSON.parse(await readFile(resolve(dir, 'activation.json'), 'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');
const codeRoot = await realpath(resolve(root, 'code/desktop-pet'));

const drift = [];
const missing = [];
let matched = 0;
for (const [path, digest] of Object.entries(config.runtimeFiles)) {
  try {
    const actual = await realpath(resolve(root, path));
    const local = relative(codeRoot, actual);
    if (!local || local.startsWith('..')) { drift.push({ path, reason: 'outside-runtime' }); continue; }
    const actualDigest = hash(await readFile(actual));
    if (actualDigest === digest) matched++;
    else drift.push({ path, expected: digest.slice(0, 12), actual: actualDigest.slice(0, 12) });
  } catch (error) {
    missing.push({ path, reason: error.code ?? String(error) });
  }
}

const activationValid = activation.configSha256 === hash(await readFile(resolve(dir, 'config.json')))
  && activation.status === 'active' && activation.phaseId === config.phaseId;

console.log(JSON.stringify({
  pinnedFiles: Object.keys(config.runtimeFiles).length,
  matched,
  driftedCount: drift.length,
  missingCount: missing.length,
  driftSample: drift.slice(0, 15),
  missingSample: missing.slice(0, 15),
  configSourceRevision: config.sourceRevision,
  activationStatus: activation.status,
  activationConfigHashValid: activationValid,
  database: config.database,
  loadsCurrentBuild: drift.length === 0 && missing.length === 0,
}, null, 2));
