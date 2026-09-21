// FIX61-11 shell token: one loopback origin that serves BOTH things the chain needs.
//
// It is a real origin, exactly like the backend's. The management session file points at it; the host
// validates that session against `/api/snapshot` through the real `tools/management-url.mjs`; and the URL
// the host then hands to the shell is loaded back from this same origin, so the console runs on the origin
// the session was published for — the REAL `management/ui` page with its REAL modules. Only the network
// transport inside that page is replaced, by the same scenario the FIX61-11 deep-link test already uses.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const ui = new URL('../../management/ui/', import.meta.url);
const STATIC = {
  '/app.mjs': 'app.mjs', '/api.mjs': 'api.mjs', '/dom.mjs': 'dom.mjs', '/style.css': 'style.css',
  '/skin-view.mjs': 'skin-view.mjs', '/health-view.mjs': 'health-view.mjs',
  '/views.mjs': 'views.mjs', '/presentation-view.mjs': 'presentation-view.mjs',
  '/emotion-view.mjs': 'emotion-view.mjs', '/self-setup-view.mjs': 'self-setup-view.mjs',
  '/balances-view.mjs': 'balances-view.mjs', '/memory-import-view.mjs': 'memory-import-view.mjs',
  '/wake-view.mjs': 'wake-view.mjs', '/wechat-view.mjs': 'wechat-view.mjs',
  '/pending-memory-view.mjs': 'pending-memory-view.mjs', '/projects-view.mjs': 'projects-view.mjs',
  '/tasks-view.mjs': 'tasks-view.mjs', '/memory-dynamics-view.mjs': 'memory-dynamics-view.mjs',
  '/aika-view.mjs': 'aika-view.mjs', '/knowledge-view.mjs': 'knowledge-view.mjs'
};

/**
 * Serves the real console page, plus the live-identity probe the real opener performs.
 *
 * `/api/snapshot` answers with the identity recorded in the session descriptor and refuses any request that
 * does not present the session token, so a composition that lost the token cannot complete here. The
 * descriptor is read back from disk on every request on purpose: only the real opener can write it, and it
 * refuses to write an unusable one.
 */
export async function startSessionOrigin({ descriptorFile, token, scenarioFile }) {
  const page = (await readFile(new URL('index.html', ui), 'utf8'))
    .replace('<script type="module" src="./app.mjs"></script>', '<script type="module" src="/scenario.mjs"></script><script type="module" src="./app.mjs"></script>');
  if (!page.includes('/scenario.mjs')) throw new Error('the console page no longer loads app.mjs the expected way');
  const probes = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/api/snapshot') {
      const authorization = req.headers.authorization ?? '';
      probes.push(authorization);
      // Exactly the contract tools/management-url.mjs checks: the session token, and a runtime identity
      // that matches the descriptor the host accepted.
      if (authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(); return; }
      const descriptor = JSON.parse(await readFile(descriptorFile, 'utf8'));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ runtime: { pid: descriptor.pid, instanceId: descriptor.instanceId, sourceRevision: descriptor.sourceRevision } }));
      return;
    }
    if (path === '/' || path === '/index.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page); return; }
    const file = path === '/scenario.mjs' ? new URL(scenarioFile, import.meta.url) : STATIC[path] ? new URL(STATIC[path], ui) : null;
    if (!file || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
    try { res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + server.address().port, probes,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
