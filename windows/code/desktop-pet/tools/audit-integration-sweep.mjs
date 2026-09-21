// 0.61 quiet-tree re-verification audit (Task 2): run every dist/tests/integration/*.test.js
// strictly sequentially, one node --test process per file, with a per-test timeout and a
// wall-clock SIGKILL so known-hanging files (pending-memory-management, memory-dynamics-http)
// cannot stall the sweep. Results land in tools/audit-integration-sweep.results.json and the
// raw TAP transcript in tools/audit-integration-sweep.tap.txt.
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, appendFileSync } from 'node:fs';

const TEST_TIMEOUT_MS = 90000;   // node --test per-test timeout
const WALL_MS = 150000;          // hard wall-clock kill per file
const dir = fileURLToPath(new URL('../dist/tests/integration/', import.meta.url));
// NOTE: pass plain absolute paths — node v24 on Windows rejects file:/// URL arguments here
// ("Could not find 'file:///…'") even when the target exists.
const files = (await readdir(dir)).filter(f => f.endsWith('.test.js')).sort();
const rows = [];
appendFileSync(new URL('./audit-integration-sweep.tap.txt', import.meta.url),
  `# sweep start ${new Date().toISOString()} files=${files.length}\n`);
for (const file of files) {
  const filePath = resolve(dir, file);
  const startedAt = new Date().toISOString();
  const r = spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', `--test-timeout=${TEST_TIMEOUT_MS}`, filePath],
    { encoding: 'utf8', timeout: WALL_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  const out = (r.stdout || '') + '\n' + (r.stderr || '');
  const parse = tag => { const m = out.match(new RegExp('^# ' + tag + ' (\\d+)', 'm')); return m ? Number(m[1]) : 0; };
  const killed = Boolean(r.error && r.error.killed);
  const row = {
    file,
    startedAt,
    endedAt: new Date().toISOString(),
    exit: killed ? null : r.status,
    signal: r.signal || null,
    status: killed ? 'WALL_KILLED' : (r.status === 0 ? 'ok' : 'fail'),
    tests: parse('tests'), pass: parse('pass'), fail: parse('fail'), skipped: parse('skipped'), todo: parse('todo'),
    note: killed ? `killed after wall clock ${WALL_MS} ms` : String(r.error ? r.error.code || r.error.message : ''),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  appendFileSync(new URL('./audit-integration-sweep.tap.txt', import.meta.url),
    `\n===== ${file} =====\n` + out.slice(-30000));
}
writeFileSync(new URL('./audit-integration-sweep.results.json', import.meta.url), JSON.stringify(rows, null, 2));
const totals = rows.reduce((a, r) => ({ tests: a.tests + r.tests, pass: a.pass + r.pass, fail: a.fail + r.fail, skipped: a.skipped + r.skipped, todo: a.todo + r.todo }), { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 });
console.log('FILES ' + rows.length);
console.log('TOTALS ' + JSON.stringify(totals));
