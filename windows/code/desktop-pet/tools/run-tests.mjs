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
} else if (group === 'next61') {
  // FIX61-10: the repair-round suite. Explicit discovery of the compiled next61 cases; a missing or empty
  // collection exits non-zero instead of quietly reporting success with no tests.
  await collect('dist/tests/next61', name => name.endsWith('.test.js'));
  // MJS cases are not compiled by tsc, so the repair-round suite also runs the sources directly.
  await collect('tests/next61', name => name.endsWith('.test.mjs'));
  if (!paths.length) {
    console.error('FIX61 test cases missing after build; refusing a passWithNoTests run.');
    process.exit(2);
  }
} else if (group === 'next65') {
  // K65-00 00-D: the kernel/package migration suite. Same discipline as next/next61: explicit discovery of the
  // compiled cases plus the uncompiled .test.mjs sources. A suite that discovers nothing is not evidence of
  // anything, so a missing directory and an empty collection are reported distinctly and both exit non-zero
  // (2) rather than surfacing a bare ENOENT stack or quietly passing.
  const compiled = await collect('dist/tests/next65', name => name.endsWith('.test.js')).then(() => true, () => false);
  const sources = await collect('tests/next65', name => name.endsWith('.test.mjs')).then(() => true, () => false);
  if (!compiled || !sources) {
    console.error('K65 test directories missing (' + [!compiled && 'dist/tests/next65', !sources && 'tests/next65'].filter(Boolean).join(', ') + '); build first, then re-run. Refusing a passWithNoTests run.');
    process.exit(2);
  }
  if (!paths.length) {
    console.error('K65 test collection is empty; refusing a passWithNoTests run.');
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
