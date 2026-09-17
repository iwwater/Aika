// An explicit local development step. Preserve all data and the existing activation status.
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { validateTrialConfiguration } from '../dist/app/trial-config.js';
import { readPresentationCatalog } from '../dist/management/presentation.js';
import { isPrivateFileSync } from '../dist/core/platform-files.js';
const root = fileURLToPath(new URL('../../..', import.meta.url));
const dir = resolve(root, '.local/model-evaluation/trial/user-trial');
const configFile = resolve(dir, 'config.json'), activationFile = resolve(dir, 'activation.json');
const hash = b => createHash('sha256').update(b).digest('hex');
const raw = await readFile(configFile), config = validateTrialConfiguration(JSON.parse(raw));
const activation = JSON.parse(await readFile(activationFile, 'utf8'));
if (resolve(config.projectRoot) !== resolve(root) || activation.configSha256 !== hash(raw) || activation.phaseId !== config.phaseId || !['prepared','active','stopped'].includes(activation.status)) throw Error('Existing configuration changed or belongs to another directory.');
try { const lock = JSON.parse(await readFile(resolve(dir, '../../backend.lock'), 'utf8')); process.kill(lock.pid, 0); throw Error('Quit the desktop before refreshing its runtime.'); }
catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
await readPresentationCatalog(root);
for (const model of Object.values(config.models)) if (!isPrivateFileSync(model.credentialFile)) throw Error('An external credential is missing or not private.');
const runtimeFiles = {};
async function pin(base) {
  for (const entry of (await readdir(base, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = resolve(base, entry.name);
    if (entry.isSymbolicLink()) throw Error('Runtime symlinks are not supported');
    if (entry.isDirectory()) { if (!['.cache', '.git', 'node_modules'].includes(entry.name)) await pin(path); }
    else runtimeFiles[relative(root, path).replaceAll('\\', '/')] = hash(await readFile(path));
  }
}
for (const name of ['dist','desktop','tools']) await pin(resolve(root, 'code/desktop-pet', name));
const updated = validateTrialConfiguration({ ...config, runtimeFiles, sourceRevision: hash(JSON.stringify(runtimeFiles)).slice(0,40) });
const next = JSON.stringify(updated, null, 2) + '\n';
// Keep a recoverable pair; a partial update fails closed at the activation hash check.
const stamp = randomUUID();
await writeFile(configFile + '.' + stamp + '.backup', raw, { flag: 'wx', mode: 0o600 });
await writeFile(activationFile + '.' + stamp + '.backup', JSON.stringify(activation) + '\n', { flag: 'wx', mode: 0o600 });
await writeFile(configFile + '.next', next, { flag: 'wx', mode: 0o600 });
await writeFile(activationFile + '.next', JSON.stringify({ ...activation, configSha256: hash(next) }) + '\n', { flag: 'wx', mode: 0o600 });
await rename(configFile + '.next', configFile); await rename(activationFile + '.next', activationFile);
console.log('Current build registered. Existing activation status and personal data preserved.');
