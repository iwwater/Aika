// FIX61-05: authoritative .moc3 validation for the skin registry.
//
// A file name or the four magic bytes prove nothing: the registry must know that a candidate rig
// can actually be built before it becomes selectable. Byte-level checks (magic, reserved byte,
// section table, SHA-256 closure) are necessary but not sufficient, so this module runs the same
// vendored Live2D Cubism Core the renderer uses, in the backend process, and asks it to build the
// model. Whatever the Core refuses is refused here too, and whatever it builds yields the real
// parameter count the registry records.
//
// The Core ships as an Emscripten browser bundle. It needs only a tiny DOM surface to initialise,
// and it finishes initialising asynchronously, so the first call polls until `csmGetVersion`
// answers. The Core is loaded lazily and only when a pack is imported or activated.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

interface CubismMoc { _release(): void }
interface CubismModel { parameters: { ids: string[] }; release(): void }
interface CubismCore {
  Version: { csmGetVersion(): number; csmGetLatestMocVersion(): number };
  Moc: { fromArrayBuffer(bytes: ArrayBuffer): CubismMoc | null };
  Model: { fromMoc(moc: CubismMoc): CubismModel | null };
}
export interface MocInspection { readonly parameterCount: number; readonly parameterIds: readonly string[]; readonly coreVersion: number }

let loading: Promise<CubismCore> | null = null;

/** The vendored Core is not a TypeScript input, so it stays in the source tree beside `dist`. */
function coreFile(): URL {
  for (const candidate of ['../desktop/vendor/cubism/Core/live2dcubismcore.js', '../../desktop/vendor/cubism/Core/live2dcubismcore.js']) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(url)) return url;
  }
  throw new Error('找不到随程序发布的 Live2D 运行库。');
}

/** Minimal DOM surface so the Emscripten bundle can locate and instantiate itself outside a browser. */
function domShim() {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.window ??= scope;
  scope.self ??= scope;
  scope.document ??= {
    currentScript: { src: 'live2dcubismcore.js' },
    createElement: () => ({ getContext: () => null, style: {}, setAttribute() {} }),
    getElementById: () => null, addEventListener() {}, removeEventListener() {},
    documentElement: { style: {} }, head: { appendChild() {} },
  };
}

async function core(): Promise<CubismCore> {
  if (loading) return loading;
  loading = (async () => {
    domShim();
    const source = await readFile(coreFile(), 'utf8');
    // FIX61-10: the Emscripten banner goes through console.log, which on the backend would corrupt
    // the JSON protocol on stdout (backend_ready and startup records share that stream). Evaluate
    // with console.log redirected to stderr so stdout stays protocol-only.
    const evaluate = new Function('window', 'globalThis', 'document', 'navigator', 'self', 'exports', 'module', 'define', 'console',
      source + '\n;return typeof Live2DCubismCore !== "undefined" ? Live2DCubismCore : null;');
    const scope = globalThis as unknown as Record<string, unknown>;
    const stderrLog = (...parts: unknown[]) => process.stderr.write(parts.map(String).join(' ') + '\n');
    const instance = evaluate(scope.window, globalThis, scope.document, navigator, scope.self, undefined, undefined, undefined,
      { log: stderrLog, warn: (...parts: unknown[]) => process.stderr.write(parts.map(String).join(' ') + '\n') }) as CubismCore | null;
    if (!instance?.Version) throw new Error('Cubism Core 未能初始化。');
    // Emscripten finishes its own runtime asynchronously; the first successful call is the barrier.
    for (let attempt = 0; ; attempt++) {
      try { instance.Version.csmGetVersion(); break; }
      catch (error) { if (attempt >= 400) throw error; await new Promise(done => setTimeout(done, 10)); }
    }
    return instance;
  })().catch(error => { loading = null; throw error; });
  return loading;
}

/**
 * Build the rig with the real Core. Returns the real parameter table, or throws a caller-supplied
 * rejection when the Core refuses the bytes.
 */
export async function inspectMoc(bytes: Buffer, reject: (message: string) => never): Promise<MocInspection> {
  const instance = await core().catch((error: unknown) => reject('模型校验组件不可用，无法确认这个 moc3 是否可用。' + (error instanceof Error ? '（' + error.message + '）' : '')));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let moc: CubismMoc | null = null;
  try {
    moc = instance.Moc.fromArrayBuffer(buffer);
    if (!moc) return reject('模型 moc 文件不可用，Live2D 运行库拒绝解析。');
    const model = instance.Model.fromMoc(moc);
    if (!model) return reject('模型 moc 文件不可用，Live2D 运行库无法建立模型。');
    try {
      const ids = [...model.parameters.ids];
      if (!ids.length) return reject('模型 moc 文件没有可用的参数表。');
      return { parameterCount: ids.length, parameterIds: ids, coreVersion: instance.Version.csmGetVersion() };
    } finally { model.release(); }
  } finally { try { moc?._release(); } catch { /* the Core owns its own memory */ } }
}
