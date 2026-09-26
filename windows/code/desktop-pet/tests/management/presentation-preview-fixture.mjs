import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { presentationAssetRoutes } from '../../dist/management/presentation-assets.js';

const desktopRoot = resolve(import.meta.dirname, '../..');
const windowsRoot = resolve(desktopRoot, '../..');

export async function startPresentationPreviewFixture() {
  const routes = await presentationAssetRoutes(windowsRoot);
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>Presentation preview integration</title><script src="/presentation-runtime/core.js"></script><style>html,body{margin:0;background:#20242c;color:#fff}canvas{display:block;width:640px;height:480px}</style><canvas id="preview" aria-label="presentation preview"></canvas><output id="result">running</output><script type="module" src="/scenario.mjs"></script>');
      return;
    }
    let file;
    if (pathname === '/scenario.mjs') file = new URL('./presentation-preview-scenario.mjs', import.meta.url);
    else if (pathname === '/presentation-preview.js') file = new URL('../../management/ui/presentation-preview.js', import.meta.url);
    else if (pathname === '/presentation-runtime/core.js' || pathname.startsWith('/presentation-assets/') || pathname.startsWith('/presentation-shaders/')) file = routes.get(pathname);
    if (!file || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(file);
      const extension = String(file).split('.').at(-1).toLowerCase();
      const types = { js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', png: 'image/png', moc3: 'application/octet-stream', frag: 'text/plain', vert: 'text/plain' };
      res.setHeader('Content-Type', types[extension] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolveClose => { server.closeAllConnections(); server.close(resolveClose); }) };
}
