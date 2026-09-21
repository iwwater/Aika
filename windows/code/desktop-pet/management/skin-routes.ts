// FIX61-11 wiring: the HTTP plane for the FIX61-05 model-pack (skin) registry.
//
// Why this file exists: `SkinStore` was complete but imported by nothing in production, so 换肤 had no
// route and no UI — a dead entry in the FIX61-04 function panel. This route is the single management
// authority for skins; the console page is a thin client over it.
//
// Boundary rules kept from the SPEC and the store:
//  * A skin changes APPEARANCE ONLY. Nothing here reads or writes characterId, identity, voice, the
//    knowledge library or Memory, and the response never contains them.
//  * The store is the only path resolver. An asset is served only when `routes()`/`asset()` already
//    registered it, so `..`, a drive letter, a percent escape or an absolute path can never reach disk.
//  * `apiVersion` is published so the renderer can detect the capability instead of guessing.
//  * Import validation belongs to the store, not to this route and not to `tools/configure-model.mjs`.
//    `SkinStore` checks every model-relative reference itself (`skin-store.ts` `referencePath()`, which
//    also refuses a percent escape); `validateModelDirectory()` is a separate, narrower validator that no
//    production module imports. This route therefore adds path checks of its own (`assetPath`) and never
//    claims the two validators are one. `tools/configure-model.mjs` stays the single binding authority for
//    the BUILT-IN rig; this route never writes a presets.json or a parameter map, it only imports a
//    self-contained pack directory.
import { ManagementError } from '../contracts/management.js';
import { realpath } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import type { SkinManagement, SkinRoute } from '../contracts/skin.js';

/** Published capability version. A renderer that does not see this must not offer the skin entry. */
export const SKIN_API_VERSION = 1;

interface SkinView {
  readonly apiVersion: number;
  readonly state: ReturnType<SkinManagement['state']>;
}

function view(port: SkinManagement): SkinView {
  return { apiVersion: SKIN_API_VERSION, state: port.state() };
}

const text = (value: unknown, max: number, message: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', message);
  return value;
};
const revision = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ManagementError('invalid_request', '修订号无效。');
  return parsed;
};
/** Asset ids are the pack's own registered relative paths; anything else is refused before the store. */
const assetPath = (value: string): string => {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new ManagementError('invalid_request', '资源路径无效。'); }
  if (!decoded || decoded.includes('\\') || decoded.includes(':') || decoded.includes('\0') || decoded.startsWith('/')) throw new ManagementError('invalid_request', '资源路径无效。');
  if (decoded.split('/').some(part => !part || part === '.' || part === '..')) throw new ManagementError('invalid_request', '资源路径无效。');
  return decoded;
};

export interface SkinAssetResponse { readonly bytes: Buffer; readonly mime: string }
type AssetResult = SkinAssetResponse | null;

/** Turn one registered route entry into bytes. A synthesized manifest body is served as-is. */
async function routeBytes(route: SkinRoute | undefined): Promise<SkinAssetResponse | null> {
  if (route === undefined) return null;
  if (typeof route !== 'string') return { bytes: Buffer.from(route.body, 'utf8'), mime: route.type };
  const bytes = await readFile(route).catch(() => null);
  if (!bytes) return null;
  const mime = route.endsWith('.json') ? 'application/json' : route.endsWith('.png') ? 'image/png'
    : route.endsWith('.moc3') ? 'application/octet-stream' : route.endsWith('.webp') ? 'image/webp' : 'application/octet-stream';
  return { bytes, mime };
}

/**
 * /api/skins/*  — the skin registry, behind the same local management session as every other route.
 *
 *  GET  /api/skins                     registry state (revision, active skin, descriptors)
 *  POST /api/skins/import              import one self-contained pack directory
 *  POST /api/skins/:id/activate        switch appearance (expectedRevision)
 *  POST /api/skins/:id/remove          remove an unused pack (expectedRevision)
 *  GET  /api/skins/:id/asset/<path>    one registered asset, resolved by the store only
 */
export async function skinRoute(req: { readonly method?: string | undefined }, port: SkinManagement | undefined, pathname: string,
  body: () => Promise<Record<string, unknown>>, send: (value: SkinAssetResponse) => void): Promise<boolean> {
  if (!pathname.startsWith('/api/skins')) return false;
  if (!port) throw new ManagementError('unavailable', '当前版本尚未接入外观换肤。');
  const asset = /^\/api\/skins\/([A-Za-z0-9][A-Za-z0-9-]{1,48})\/asset\/(.+)$/.exec(pathname);
  if (asset) {
    if (req.method !== 'GET') throw new ManagementError('not_found', '资源只读。');
    const skinId = asset[1]!, path = assetPath(asset[2]!);
    // routes() is the registry's own resolution: an unknown id, an unregistered path or an unsafe path
    // simply is not there, so a 404 is answered without ever touching the filesystem.
    const resolved = await routeBytes(port.routes(skinId).get(path));
    if (!resolved) throw new ManagementError('not_found', '没有这个外观资源。');
    send(resolved); return true;
  }
  if (pathname === '/api/skins') {
    if (req.method !== 'GET') throw new ManagementError('not_found', '没有这个外观操作。');
    send({ bytes: Buffer.from(JSON.stringify(view(port)), 'utf8'), mime: 'application/json' }); return true;
  }
  if (pathname === '/api/skins/import') {
    if (req.method !== 'POST') throw new ManagementError('not_found', '没有这个外观操作。');
    const payload = await body();
    const source = text(payload.source, 4096, '请选择要导入的模型包目录。');
    // Resolve first: importing through a link would make the stored directory a second, unmanaged
    // identity for the same bytes.
    const directory = await realpath(source).catch(() => { throw new ManagementError('not_found', '模型包目录不存在。'); });
    const input: { skinId?: string; label?: string; entry?: string } = {};
    if (payload.skinId !== undefined && payload.skinId !== null) input.skinId = text(payload.skinId, 48, '模型包标识无效。');
    if (payload.label !== undefined && payload.label !== null) input.label = text(payload.label, 80, '模型包名称无效。');
    if (payload.entry !== undefined && payload.entry !== null) input.entry = text(payload.entry, 184, '入口模型文件无效。');
    await port.import(directory, input);
    send({ bytes: Buffer.from(JSON.stringify(view(port)), 'utf8'), mime: 'application/json' }); return true;
  }
  const action = /^\/api\/skins\/([A-Za-z0-9][A-Za-z0-9-]{1,48})\/(activate|remove)$/.exec(pathname);
  if (action) {
    if (req.method !== 'POST') throw new ManagementError('not_found', '没有这个外观操作。');
    const payload = await body(), skinId = action[1]!;
    const expected = revision(payload.expectedRevision);
    if (action[2] === 'activate') await port.activate(expected, skinId);
    else await port.remove(expected, skinId);
    send({ bytes: Buffer.from(JSON.stringify(view(port)), 'utf8'), mime: 'application/json' }); return true;
  }
  throw new ManagementError('not_found', '没有这个外观接口。');
}
