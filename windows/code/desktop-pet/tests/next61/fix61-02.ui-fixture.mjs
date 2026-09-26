import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const ui = new URL('../../management/ui/', import.meta.url);
const STATIC = { '/aika-view.mjs': 'aika-view.mjs', '/api.mjs': 'api.mjs', '/dom.mjs': 'dom.mjs', '/style.css': 'style.css' };

/**
 * Serves the REAL console page and the REAL view modules; only the document is rewired so the scenario
 * module is evaluated before the production view boots.
 */
export async function startAikaUiFixture() {
  const page = (await readFile(new URL('aika.html', ui), 'utf8'))
    .replace('<script type="module" src="./aika-view.mjs"></script>', '<script type="module" src="/scenario.mjs"></script><script type="module" src="./aika-view.mjs"></script>');
  if (!page.includes('/scenario.mjs')) throw new Error('aika.html no longer loads its view module the expected way');
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/' || path === '/aika.html') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page); return; }
    const file = path === '/scenario.mjs' ? new URL('./fix61-02.ui-scenario.mjs', import.meta.url) : STATIC[path] ? new URL(STATIC[path], ui) : null;
    if (!file || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
    try { res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // The console is opened with its session token in the fragment, exactly like the real entry point.
  return { url: 'http://127.0.0.1:' + server.address().port + '/aika.html#token=synthetic-session-token', close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
