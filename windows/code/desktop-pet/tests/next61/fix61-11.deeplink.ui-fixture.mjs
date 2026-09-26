// FIX61-11 deep-link fixture: the REAL console page, opened at a REAL route hash.
//
// This is the same production page the FIX61-11 11-E scenario uses (`management/ui/index.html` plus the
// real `app.mjs`/`views.mjs`/`skin-view.mjs`), served with only the network transport replaced. It exists
// because the desktop function panel does not load the console at `/` — it opens `/#page=skins` — so the
// console must be able to start on a page named by its own hash.
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
  '/aika-view.mjs': 'aika-view.mjs', '/knowledge-view.mjs': 'knowledge-view.mjs', '/icons.mjs': 'icons.mjs', '/routes.mjs': 'routes.mjs', '/modern-overview.mjs': 'modern-overview.mjs'
};

/**
 * Serves the production console page and returns the origin the windows are opened against.
 *
 * `origin + '/#page=skins'` is exactly the URL the desktop shell hands to the browser, so the hash — not a
 * click — is the only thing that can select the page under test.
 */
export async function startConsoleFixture(scenarioFile) {
  const page = (await readFile(new URL('index.html', ui), 'utf8'))
    .replace('<script type="module" src="./app.mjs"></script>', '<script type="module" src="/scenario.mjs"></script><script type="module" src="./app.mjs"></script>');
  if (!page.includes('/scenario.mjs')) throw new Error('the console page no longer loads app.mjs the expected way');
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/' || path === '/index.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page); return; }
    const file = path === '/scenario.mjs' ? new URL(scenarioFile, import.meta.url) : STATIC[path] ? new URL(STATIC[path], ui) : null;
    if (!file || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
    try { res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { origin, urlFor: hash => origin + (hash ?? ''), close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
