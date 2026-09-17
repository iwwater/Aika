import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
await build({ entryPoints: [root + 'main.mjs'], bundle: true, format: 'esm', platform: 'browser', target: 'safari17', outfile: root + 'build/renderer.js', sourcemap: true, legalComments: 'eof' });

await copyFile(new URL('../media/recorder-worklet.mjs', import.meta.url), new URL('./build/recorder-worklet.js', import.meta.url));

await copyFile(new URL('../media/wake/recorder-worklet.mjs', import.meta.url), new URL('./build/wake-recorder-worklet.js', import.meta.url));
