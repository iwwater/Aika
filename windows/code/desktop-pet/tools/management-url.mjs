import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { isPrivateFileSync } from '../dist/core/platform-files.js';
export async function managementUrl(configFile, fetcher = fetch) {
  if (!configFile) throw Error('Start the configured desktop first.');
  const file = resolve(dirname(configFile), 'management-session.json');
  if (!isPrivateFileSync(file)) throw Error('Management session file is not private.');
  const descriptor = JSON.parse(await readFile(file, 'utf8'));
  const url = new URL(descriptor.url);
  if (descriptor.version !== 1 || !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || !/^#token=[a-f0-9]{64}$/.test(url.hash)) throw Error('Invalid local management session');
  const response = await fetcher(url.origin + '/api/snapshot', { headers: { authorization: 'Bearer ' + url.hash.slice(7) }, signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!response.ok) throw Error('Management backend is unavailable');
  const { runtime } = await response.json();
  if (runtime?.pid !== descriptor.pid || runtime?.instanceId !== descriptor.instanceId || runtime?.sourceRevision !== descriptor.sourceRevision) throw Error('Management session changed');
  return url.href;
}
