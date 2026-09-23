#!/usr/bin/env node
// Read-only: report whether specific trace-privacy runtime artifacts match the active trial pin.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const dir = resolve(root, '.local/model-evaluation/trial/user-trial');
const config = JSON.parse(await readFile(resolve(dir, 'config.json'), 'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');

const targets = process.argv.slice(2);
const out = [];
for (const target of targets) {
  const pinned = config.runtimeFiles[target];
  if (pinned === undefined) { out.push({ target, pinned: null, status: 'not-pinned' }); continue; }
  let actual;
  try { actual = hash(await readFile(resolve(root, target))); }
  catch (error) { out.push({ target, pinned: pinned.slice(0, 12), status: 'missing', reason: error.code }); continue; }
  out.push({
    target,
    pinned: pinned.slice(0, 12),
    actual: actual.slice(0, 12),
    status: pinned === actual ? 'in-sync' : 'drifted',
  });
}
console.log(JSON.stringify(out, null, 2));
