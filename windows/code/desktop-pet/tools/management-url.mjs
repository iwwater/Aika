import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { isPrivateFileSync } from '../dist/core/platform-files.js';

let lastVerified = null;

export async function managementUrl(configFile, fetcher = fetch) {
  if (!configFile) throw Error('Start the configured desktop first.');
  const file = resolve(dirname(configFile), 'management-session.json');

  let stat;
  try { stat = statSync(file); } catch { throw Error('Start the configured desktop first.'); }

  if (lastVerified && lastVerified.file === file && lastVerified.mtimeMs === stat.mtimeMs && lastVerified.size === stat.size) {
    if (Date.now() - lastVerified.checkedAt < 30000) {
      try {
        process.kill(lastVerified.pid, 0);
        return lastVerified.url;
      } catch {}
    }
  }

  if (!isPrivateFileSync(file)) throw Error('Management session file is not private.');
  const descriptor = JSON.parse(await readFile(file, 'utf8'));
  const url = new URL(descriptor.url);
  if (descriptor.version !== 1 || !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || !url.port || url.username || url.password || url.pathname !== '/' || url.search || !/^#token=[a-f0-9]{64}$/.test(url.hash)) throw Error('Invalid local management session');
  const response = await fetcher(url.origin + '/api/snapshot', { headers: { authorization: 'Bearer ' + url.hash.slice(7) }, signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!response.ok) throw Error('Management backend is unavailable');
  const { runtime } = await response.json();
  if (runtime?.pid !== descriptor.pid || runtime?.instanceId !== descriptor.instanceId || runtime?.sourceRevision !== descriptor.sourceRevision) throw Error('Management session changed');
  lastVerified = { file, mtimeMs: stat.mtimeMs, size: stat.size, pid: descriptor.pid, url: url.href, checkedAt: Date.now() };
  return url.href;
}
// FIX61-11: the console URL for one panel entry. The session URL already carries `#token=…` and an entry
// names a ROUTE (`/#page=skins`, `/#section=records`), but the WHATWG URL constructor REPLACES the whole
// fragment — `new URL('/#page=skins', session)` returns a token-less URL, so the console opened its page
// in the locked state. The two fragments are merged here instead: the session fragment keeps its exact
// bytes and comes first, because `management/ui/app.mjs` reads the FIRST `token` value, so a route that
// also named a token can never downgrade the real session.
export function managementTarget(session, route) {
  const base = new URL(session);
  const target = new URL(route ?? '/', base);
  // Merging the session fragment into another origin's URL would hand it to that host instead of keeping
  // it local. A protocol-relative route (`//host/x`) is refused rather than rewritten.
  if (target.origin !== base.origin) throw Error('The console route must stay on the local management origin.');
  const sessionFragment = base.hash.slice(1), routeFragment = target.hash.slice(1);
  if (sessionFragment || routeFragment) target.hash = sessionFragment && routeFragment ? sessionFragment + '&' + routeFragment : sessionFragment || routeFragment;
  return target.href;
}
