import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { installWorkPreset } from '../dist/harness/preset.js';
import { isPrivateFileSync, restrictPrivatePathSync } from '../dist/core/platform-files.js';

const [dshHome, serviceHome, ...extra] = process.argv.slice(2);
if (!dshHome || !serviceHome || extra.length || !isAbsolute(dshHome) || !isAbsolute(serviceHome)) {
  throw Error('Usage: node tools/prepare-harness.mjs <absolute DSH_HOME> <absolute PET_HARNESS_HOME>');
}
await mkdir(serviceHome, { recursive: true });
await mkdir(join(serviceHome, 'workspace'), { recursive: true });
const log = join(serviceHome, 'web.log');
try {
  const info = await lstat(log);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Launch log must be a regular file.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const handle = await open(log, 'wx', 0o600); await handle.close();
}
if (!isPrivateFileSync(log)) restrictPrivatePathSync(log);
await installWorkPreset({ dshHome });
console.log('Native work preset and private launch log are ready. Start dsh web with the same DSH_HOME.');
