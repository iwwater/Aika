import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const group = process.argv[2] || 'default';
const paths = [];
async function collect(dir, accepts) {
  for (const file of (await readdir(resolve(root, dir))).sort()) if (accepts(file)) paths.push(resolve(root, dir, file));
}
if (group === 'windows') await collect('tests/windows', name => name.endsWith('.test.mjs'));
else if (group === 'release') {
  await collect('dist/tests/memory', name => name === 'import-49.test.js' || name === 'context-continuity.test.js' || /^dynamics.*\.test\.js$/.test(name));
  await collect('dist/tests/providers', name => ['qwen-asr.test.js', 'minimax-tts.test.js', 'registered-voices.test.js'].includes(name));
  await collect('dist/tests/wechat', name => name === 'conversation.test.js');
  await collect('dist/tests/integration', name => name === 'memory-import-49.test.js');
  await collect('dist/tests/management', name => name === 'memory-import.test.js');
} else if (group === 'default') {
  for (const dir of ['memory', 'providers']) await collect('dist/tests/' + dir, name => name.endsWith('.test.js'));
} else if (group === 'next') {
  await collect('dist/tests/next', name => name.endsWith('.test.js'));
  if (!paths.length) {
    console.error('NEXT contract tests missing after build; refusing a passWithNoTests run.');
    process.exit(2);
  }
} else if (group === 'next-real') {
  if (process.env.PET_NEXT_REAL !== '1') {
    console.error('NEXT-REAL BLOCKED: real-service replay requires PET_NEXT_REAL=1 plus authorized credentials and recorded fixtures. Fixture tests (npm run test:next) do not substitute for real replay.');
    process.exit(2);
  }
  await collect('dist/tests/next/real', name => name.endsWith('.test.js')).catch(() => {});
  if (!paths.length) {
    console.error('NEXT-REAL BLOCKED: no real replay cases are registered yet (see docs/next/0.6/CORPUS_MANIFEST.md).');
    process.exit(2);
  }
} else throw Error('Unknown test group');
const child = spawn(process.execPath, ['--test', ...paths], { stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
