// FIX61-11 11-E: the two console pages in a real Windows Chromium window.
//
// The REAL console shell (`app.mjs`), the REAL view modules and the REAL `dom.mjs` are served; only the
// document's entry point is rewired so the scenario runs first and the backend transport is replaced by a
// recording fetch. The pages under test are therefore the production ones, and the scenario asserts the
// two things this wiring exists for: the sidebar reaches 外观/换肤 and 模块状态, and each page renders its
// data from the route it is supposed to call.
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
 * Serves the real console page. The scenario module is inserted BEFORE `app.mjs`, so it can replace the
 * transport while the production shell still boots normally.
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
  return { url: 'http://127.0.0.1:' + server.address().port + '/#token=synthetic-session-token',
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
