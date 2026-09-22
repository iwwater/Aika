/** K65-10: verify the clean local 0.65 distribution and write a reproducible release manifest. */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'dist/next65');
const hash = async path => `sha256-${createHash('sha256').update(await readFile(path)).digest('hex')}`;
const walk = async (dir, prefix = '') => { const out = []; for (const entry of await readdir(resolve(dir, prefix), { withFileTypes: true })) { const relative = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) out.push(...await walk(dir, relative)); else out.push(relative); } return out; };
const files = [];
for (const relative of await walk(output)) {
  if (relative === 'RELEASE_MANIFEST.md' || relative === 'release-manifest.json') continue;
  const path = resolve(output, ...relative.split('/')); files.push({ path: relative, bytes: (await readFile(path)).byteLength, hash: await hash(path) });
}
const packageRoots = ['packages/normal', 'packages/compatibility', 'packages/tts', 'packages/stt', 'packages/test-harness'];
const manifests = [];
for (const packageRoot of packageRoots) manifests.push(JSON.parse(await readFile(resolve(output, ...packageRoot.split('/'), 'manifest.json'), 'utf8')));
const forbidden = files.filter(file => /(^|\/)(?:.*\.key|.*\.pem|.*\.onnx|.*\.bin)$/i.test(file.path));
if (forbidden.length) throw new Error(`forbidden distribution files: ${forbidden.map(file => file.path).join(', ')}`);
const release = { schemaVersion: 1, generatedAt: new Date().toISOString(), kernel: { path: 'kernel/index.js', hash: await hash(resolve(output, 'kernel/index.js')) }, packages: manifests.map(manifest => ({ packageId: manifest.packageId, version: manifest.version, manifestHash: manifest.manifestHash, path: `packages/${manifest.packageId === 'com.aika.fixture.test' ? 'test-harness' : manifest.packageId.replace('com.aika.product.', '')}` })), files };
await writeFile(resolve(output, 'release-manifest.json'), `${JSON.stringify(release, null, 2)}\n`, 'utf8');
await writeFile(resolve(output, 'RELEASE_MANIFEST.md'), `# Aika 0.65 本地分发清单\n\n- kernel: \`${release.kernel.path}\` (${release.kernel.hash})\n- packages: ${release.packages.map(item => `\`${item.packageId}@${item.version}\``).join(', ')}\n- files: ${files.length}\n- external network/model credentials: none\n`, 'utf8');
console.log(JSON.stringify({ output, packages: release.packages.length, files: files.length, kernel: release.kernel.hash }));
