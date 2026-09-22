/** K65-10: release manifest and clean artifact inventory. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('10-A/B/D: release manifest lists kernel and five independently validated packages without forbidden payloads', async () => {
  const root = resolve(process.cwd(), 'dist/next65');
  const release = JSON.parse(await readFile(resolve(root, 'release-manifest.json'), 'utf8')) as { kernel: { path: string; hash: string }; packages: readonly { packageId: string; version: string; manifestHash: string; path: string }[]; files: readonly { path: string }[] };
  assert.equal(release.packages.length, 5);
  assert.deepEqual(release.packages.map(item => item.packageId).sort(), ['com.aika.fixture.test', 'com.aika.product.compatibility', 'com.aika.product.normal', 'com.aika.product.stt', 'com.aika.product.tts'].sort());
  assert.ok(release.kernel.hash.startsWith('sha256-')); assert.ok(release.files.every(file => !/(\.key|\.pem|\.onnx|\.bin)$/i.test(file.path)));
  assert.ok(await readFile(resolve(root, 'RELEASE_MANIFEST.md'), 'utf8').then(text => text.includes('com.aika.product.tts')));
});
