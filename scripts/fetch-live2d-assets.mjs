/**
 * Fetches the Live2D Cubism Core runtime and the official sample models used by the
 * Live2D renderer (MVP-11).
 *
 * Assets are deliberately **not** vendored into the repository: they are licensed
 * material, and the fork is a personal-use build (see MVP-07 AC-C). They land in
 * `public/live2d/`, which Vite copies into `dist/` and `.gitignore` excludes from git.
 *
 * Usage: node scripts/fetch-live2d-assets.mjs [modelId ...]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = join(ROOT, 'public', 'live2d');

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
  const target = join(OUT_ROOT, 'models', id);
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

  const core = await fetchToFile(CORE_URL, join(OUT_ROOT, 'core', 'live2dcubismcore.min.js'));
  console.log(`core            live2dcubismcore.min.js  ${core} bytes`);

  for (const id of ids) {
    const result = await fetchModel(id);
    console.log(`${id.padEnd(15)} ${String(result.files).padStart(3)} files  ${result.bytes} bytes`);
  }

  console.log(`\nassets -> ${OUT_ROOT} (git-ignored; copied into dist/ by Vite)`);
}

main().catch((error) => {
  console.error(`fetch failed: ${error.message}`);
  process.exitCode = 1;
});
