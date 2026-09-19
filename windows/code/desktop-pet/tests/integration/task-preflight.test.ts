import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const checker = fileURLToPath(new URL('../../../tools/check-task.py', import.meta.url));
function fixture(run: (root: string, check: () => {status: number | null; errors: string[]}) => void, released = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pet-preflight-')));
  try {
    mkdirSync(join(root, 'docs/agent/blackboard'), {recursive: true});
    mkdirSync(join(root, 'owned'));
    writeFileSync(join(root, 'BASE.md'), 'current base');
    function git(...args: string[]) {const r = spawnSync('git', ['-C', root, ...args], {encoding: 'utf8'}); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();}
    git('init', '-b', 'work/test'); git('add', 'BASE.md');
    git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'test baseline');
    const codeBase = git('rev-parse', 'HEAD');
    const task = {task_id: 'TEST', worktree: root, branch: 'work/test', base_version: '1', contract_version: '1', workspace_ready: true, implementation_authorized: released, code_base: codeBase, writable_paths: ['owned/']};
    writeFileSync(join(root, 'docs/agent/blackboard/OWNERSHIP.json'), JSON.stringify({canonical_root: root, tasks: [task]}));
    writeFileSync(join(root, 'docs/agent/blackboard/CURRENT.json'), JSON.stringify({revision: 1, publication_pending: false, base_version: '1', contract_version: '1', ownership_registry: 'docs/agent/blackboard/OWNERSHIP.json', sources: [{path: 'BASE.md', sha256: createHash('sha256').update('current base').digest('hex')}]}));
    writeFileSync(join(root, '.git/info/exclude'), '/docs/\n');
    const check = () => {const r = spawnSync('python3', [checker, '--canonical-root', root, '--task', 'TEST'], {encoding: 'utf8'}); return {status: r.status, errors: JSON.parse(r.stdout).errors as string[]};};
    run(root, check);
  } finally {rmSync(root, {recursive: true, force: true});}
}
test('submission check accepts assigned changes and rejects an outside file without deleting it', () => fixture((root, check) => {
  writeFileSync(join(root, 'owned/module.ts'), 'export const value = 1;');
  assert.equal(check().status, 0);
  writeFileSync(join(root, 'public-contract.ts'), 'outside');
  assert.equal(check().status, 1);
  assert.ok(check().errors.includes('outside assigned scope: public-contract.ts'));
}));
test('submission check rejects stale canonical input independently of branch state', () => fixture((root, check) => {
  writeFileSync(join(root, 'BASE.md'), 'changed elsewhere');
  assert.ok(check().errors.includes('source fingerprint changed: BASE.md'));
}));
test('ready workspace is insufficient when the implementation slot has not been released', () => fixture((_root, check) => {
  assert.ok(check().errors.includes('task implementation is not released'));
}, false));
