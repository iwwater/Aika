/**
 * Fetches the Live2D Cubism Core runtime and the official sample models used by the
 * Live2D renderer (MVP-11).
 *
 * **分发边界（MVP-14 处置 DEF-1）——两件事不要混**：
 *
 * - **Cubism Core 是 SDK 运行时，留在包内**：下到 `public/live2d/core/`，Vite 会把它
 *   复制进 `dist/` 并嵌入可执行文件（同源脚本，`script-src 'self'` 即可，无需放宽 CSP）。
 * - **官方示例模型不入包**：下到应用数据目录的 `live2d/models/`，由 shell 自己的回环
 *   HTTP 按需提供（CSP 的 `connect-src` / `img-src` 本就放行 `http://127.0.0.1:*`）。
 *
 * Assets are deliberately **not** vendored into the repository: they are licensed
 * material, and the fork is a personal-use build (see MVP-07 AC-C).
 *
 * Usage: node scripts/fetch-live2d-assets.mjs [modelId ...]
 *   PET_SHELL_LIVE2D_MODELS_DIR  覆盖模型输出目录（默认按平台推导）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTIFIER = 'dev.aiki.petshell';
/** Core 留在包里：这里就是 Vite 的 `public/` 目录。 */
const CORE_OUT_ROOT = join(ROOT, 'public', 'live2d');

/** Tauri 的 app_data_dir：与应用的 `app.path().app_data_dir()` 口径一致。 */
function appDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, IDENTIFIER);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', IDENTIFIER);
  }
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, IDENTIFIER);
}

/** 模型不入包：目标是应用数据目录下的 `live2d/models`。 */
const MODELS_OUT_ROOT =
  process.env.PET_SHELL_LIVE2D_MODELS_DIR ?? join(appDataDir(), 'live2d', 'models');

const SAMPLES_BASE = 'https://raw.githubusercontent.com/Live2D/CubismWebSamples/master';
const CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';

/** Official sample models. Two of them are the first-version appearance set. */
const MODELS = {
  hiyori: { dir: 'Hiyori', file: 'Hiyori' },
  mao: { dir: 'Mao', file: 'Mao' },
};

const DEFAULT_MODELS = ['hiyori', 'mao'];

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchToFile(url, target) {
  const bytes = await fetchBytes(url);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return bytes.length;
}

function collectModelFiles(manifest, modelDir) {
  /** @type {Set<string>} */
  const files = new Set();
  const refs = manifest?.FileReferences ?? {};
  if (typeof refs.Moc === 'string') files.add(refs.Moc);
  for (const texture of refs.Textures ?? []) files.add(texture);
  for (const key of ['Physics', 'Pose', 'UserData', 'DisplayInfo', 'CDI']) {
    if (typeof refs[key] === 'string') files.add(refs[key]);
  }
  for (const group of Object.values(refs.Motions ?? {})) {
    for (const motion of group) if (typeof motion?.File === 'string') files.add(motion.File);
  }
  for (const expression of refs.Expressions ?? []) {
    if (typeof expression?.File === 'string') files.add(expression.File);
  }
  return [...files].map((relative) => ({
    // Manifest paths are relative to the model directory and use forward slashes.
    remote: posix.join('Samples/Resources', modelDir, relative),
    relative,
  }));
}

async function fetchModel(id) {
  const spec = MODELS[id];
  if (!spec) throw new Error(`unknown model '${id}' (known: ${Object.keys(MODELS).join(', ')})`);

  const manifestName = `${spec.file}.model3.json`;
  const target = join(MODELS_OUT_ROOT, id);
  const manifestUrl = `${SAMPLES_BASE}/Samples/Resources/${spec.dir}/${manifestName}`;
  const manifestText = new TextDecoder().decode(await fetchBytes(manifestUrl));
  await mkdir(target, { recursive: true });
  await writeFile(join(target, manifestName), manifestText);

  const manifest = JSON.parse(manifestText);
  const files = collectModelFiles(manifest, spec.dir);
  let total = manifestText.length;
  for (const file of files) {
    const written = await fetchToFile(
      `${SAMPLES_BASE}/${file.remote}`,
      join(target, ...file.relative.split('/')),
    );
    total += written;
  }
  return { id, files: files.length + 1, bytes: total };
}

async function main() {
  const requested = process.argv.slice(2);
  const ids = requested.length ? requested : DEFAULT_MODELS;

  const core = await fetchToFile(
    CORE_URL,
    join(CORE_OUT_ROOT, 'core', 'live2dcubismcore.min.js'),
  );
  console.log(`core            live2dcubismcore.min.js  ${core} bytes`);

  for (const id of ids) {
    const result = await fetchModel(id);
    console.log(`${id.padEnd(15)} ${String(result.files).padStart(3)} files  ${result.bytes} bytes`);
  }

  console.log(`\ncore   -> ${CORE_OUT_ROOT}/core        (留包内：Vite 复制进 dist/)`);
  console.log(`models -> ${MODELS_OUT_ROOT}  (不入包：shell 从应用数据目录经回环 HTTP 提供)`);
}

main().catch((error) => {
  console.error(`fetch failed: ${error.message}`);
  process.exitCode = 1;
});
