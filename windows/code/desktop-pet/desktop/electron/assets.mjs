import { realpath, readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
export async function assetResponse(root, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'pet:' || url.host !== 'app' || url.username || url.password) return new Response(null, { status: 403 });
    const name = decodeURIComponent(url.pathname).slice(1) || 'index.html';
    if (name.includes('\\') || name.includes(':') || name.includes('\0') || name.split('/').some(p => p === '..' || p === '.')) return new Response(null, { status: 403 });
    const base = await realpath(root), file = await realpath(resolve(base, name)), part = relative(base, file);
    if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) return new Response(null, { status: 403 });
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream';
    return new Response(await readFile(file), { headers: { 'content-type': mime, 'cache-control': 'no-store' } });
  } catch { return new Response(null, { status: 404 }); }
}
