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
  await collect('dist/tests/memory', name => name === 'context-continuity.test.js' || /^dynamics.*\.test\.js$/.test(name));
  await collect('dist/tests/providers', name => ['qwen-asr.test.js', 'minimax-tts.test.js', 'registered-voices.test.js'].includes(name));
  await collect('dist/tests/wechat', name => name === 'conversation.test.js');
} else if (group === 'default') {
  for (const dir of ['memory', 'providers']) await collect('dist/tests/' + dir, name => name.endsWith('.test.js'));
} else throw Error('Unknown test group');
const child = spawn(process.execPath, ['--test', ...paths], { stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
