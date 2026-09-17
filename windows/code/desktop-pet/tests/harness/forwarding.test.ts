import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, rmdir, writeFile, readFile, unlink, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ForwardReceipts } from '../../harness/receipts.js';
import { HarnessForwarding } from '../../harness/forwarding.js';
import { CodexAppError, type CodexAppReceipt } from '../../harness/codex-app.js';
import { SqliteProjectIndex } from '../../projects/sqlite-project-index.js';
import { EvaluationBudget } from '../../core/evaluation-budget.js';
import { harnessAccounting } from '../../harness/accounting.js';
import type { RelayMetrics, RelayTerminal } from '../../harness/connection.js';
import { isPrivateFileSync } from '../../core/platform-files.js';

async function fixture(t: TestContext) {
  const parent = resolve('../../.local/direct-forward-20/tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'forward-')), projectRoot = join(root, 'project'); await mkdir(projectRoot); await writeFile(join(projectRoot, 'AGENTS.md'), 'Synthetic project entry.');
  const protectedFile = join(root, 'companion.sqlite'); await writeFile(protectedFile, 'Protected synthetic companion payload');
  const projects = new SqliteProjectIndex(join(root, 'project-index.sqlite'));
  const state = { targetReads: [] as {query:string;limit:number|undefined}[], hostCalls: 0, sends: [] as string[], fail: false, completed: false, preset: true, discoverFails: false, metrics: [] as RelayMetrics[], metricsReads: 0, receiptOverride: undefined as undefined|(() => Promise<CodexAppReceipt>), recorded: [] as RelayMetrics[], terminal: { status: 'ended', turn: 1, reason: 'completed' } as RelayTerminal };
  const threadId = randomUUID(), turnId = randomUUID(), file = join(root, 'harness-relay.sqlite');
  const open = () => new HarnessForwarding({ receipts: new ForwardReceipts(file), projects, presetId: 'desktop-pet-relay-v1', workspace: projectRoot,
    compatible: async () => true, presetReady: async () => state.preset,
    harness: { async probe() { return { state: 'ready', observedAt: 'now', codexDelivery: 'unverified' }; },
      async createRelaySession() { state.hostCalls++; }, async submitConfirmedOperation() { state.hostCalls++; }, async relayMetricsBatch(ids) { state.metricsReads++; return state.metrics.filter(row => ids.includes(row.sessionId)); }, async requestTerminal() { return state.terminal; } },
    async recordMetrics(value) { state.recorded.push(value); },
    codex: { list: (query='',limit) => {state.targetReads.push({query,limit});return [{ threadId, hostId: 'local', title: 'Synthetic task', projectPath: projectRoot }];},
      discover: async () => { if (state.discoverFails) throw new CodexAppError('unavailable'); return { available: true }; },
      async send(target, text) { assert.equal(target, threadId); state.sends.push(text); if (state.fail) throw new CodexAppError('unknown_delivery'); return { requestId: randomUUID(), threadId, turnId }; },
      receipt: async (target, turn) => { assert.equal(target, threadId); assert.equal(turn, turnId); if(state.receiptOverride)return state.receiptOverride(); return { threadId, turnId, status: state.completed ? 'completed' : 'unknown', reply: 'Synthetic engineering result only for the task page' }; },
    } });
  const services: HarnessForwarding[] = []; const service = () => { const value = open(); services.push(value); return value; };
  t.after(async () => { for (const s of services) await s.close(); await projects.close(); await rm(root, { recursive: true, force: true }); });
  const legacyConfirm=(id:string)=>{const old=new ForwardReceipts(file);try{return old.mutate(id,row=>{row.phase='forwarding';row.confirmedAt=new Date().toISOString();row.harnessSessionId='session-'+randomUUID();});}finally{old.close();}};
  return { root, projectRoot, protectedFile, projects, state, threadId, service, legacyConfirm };
}

test('no send before confirmation; concurrent/repeated confirm and MCP calls forward immutable text exactly once', async t => {
  const f = await fixture(t), service = f.service();
  const request = await service.prepare({ text: 'User original task', target: { hostId: 'local', threadId: f.threadId } });
  await assert.rejects(service.sendConfirmed(request.id), { code: 'forbidden' });
  await assert.rejects(service.toolStatus(request.id), { code: 'forbidden' });
  assert.equal(f.state.hostCalls, 0); assert.equal(f.state.sends.length, 0);
  await Promise.all([service.confirm(request.id, 1), service.confirm(request.id, 1)]);
  assert.equal(f.state.hostCalls, 0);
  await Promise.all([service.sendConfirmed(request.id), service.sendConfirmed(request.id)]);
  assert.deepEqual(f.state.sends,['User original task']);assert.equal(service.record(request.id).harnessSessionId,undefined);
  await service.confirm(request.id, 1); assert.equal(f.state.hostCalls, 0);
  f.state.completed = true; const final = await service.refresh(request.id);
  assert.equal(final.phase, 'completed'); assert.match(final.result!, /engineering/);
  assert.equal(await readFile(f.protectedFile, 'utf8'), 'Protected synthetic companion payload');
});

test('unknown App response survives restart and cannot cause automatic redelivery', async t => {
  const f = await fixture(t), service = f.service();
  const request = await service.prepare({ text: 'Confirmed task', target: { hostId: 'local', threadId: f.threadId } });
  f.state.fail = true; await service.confirm(request.id, 1);
  assert.equal((await service.sendConfirmed(request.id)).phase, 'unknown'); await service.close();
  const restarted = f.service();
  assert.equal((await restarted.sendConfirmed(request.id)).phase, 'unknown'); await restarted.refresh(request.id);
  assert.equal(f.state.sends.length, 1); assert.equal(f.state.hostCalls, 0);
});

test('project version change prevents stale confirmation; a later escaping entry link prevents App delivery', async t => {
  const f = await fixture(t), service = f.service();
  const entryDirectory = join(f.projectRoot, 'entry'), entry = join(entryDirectory, 'companion.sqlite');
  await mkdir(entryDirectory); await writeFile(entry, 'Synthetic in-project reference');
  const project = await f.projects.save({ expectedVersion: 0, name: 'Selected', abstract: 'Short', detailRef: { rootPath: f.projectRoot, entryFile: 'entry/companion.sqlite' } });
  const request = await service.prepare({ text: 'Use selected project', target: { hostId: 'local', threadId: f.threadId }, projectId: project.id, projectVersion: 1 });
  await f.projects.save({ id: project.id, expectedVersion: 1, name: 'Changed', abstract: '', detailRef: project.detailRef });
  await assert.rejects(service.confirm(request.id, 1), { code: 'version_conflict' }); assert.equal(f.state.hostCalls, 0);
  const next = await service.prepare({ text: 'Use current project', target: { hostId: 'local', threadId: f.threadId }, projectId: project.id, projectVersion: 2 });
  f.legacyConfirm(next.id);
  await unlink(entry); await rmdir(entryDirectory);
  // A directory junction exercises a real escape without Windows symlink privilege.
  await symlink(f.root, entryDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await service.sendConfirmed(next.id)).phase, 'unavailable'); assert.equal(f.state.sends.length, 0);
  assert.equal(await readFile(f.protectedFile, 'utf8'), 'Protected synthetic companion payload');
});

test('Codex works without Harness preset; unavailable App still refuses confirmation', async t => {
  const f = await fixture(t), service = f.service(); f.state.preset = false;
  const request = await service.prepare({ text: 'Task', target: { hostId: 'local', threadId: f.threadId } });
  assert.equal((await service.confirm(request.id,1)).phase,'accepted');assert.equal(f.state.hostCalls,0);assert.equal(f.state.sends.length,1);
  f.state.discoverFails=true;const next=await service.prepare({text:'Next',target:{hostId:'local',threadId:f.threadId}});
  await assert.rejects(service.confirm(next.id, 1), { code: 'unavailable' }); assert.equal(f.state.hostCalls, 0);
  const current = await service.refresh(next.id); assert.equal(current.phase, 'awaiting_confirmation'); assert.equal(current.confirmedAt, undefined); assert.equal(current.harnessSessionId, undefined);
});

test('cumulative Harness usage is recorded once under repeated/out-of-order reads and preserves original ledger entries', async t => {
  const f = await fixture(t), file = join(f.root, 'budget.json'), budget = new EvaluationBudget(file, 'synthetic', null);
  await budget.reserve('original', 'original-model', 9); await budget.settle('original', null);
  const original = (await budget.snapshot()).entries[0]; const record = harnessAccounting(budget);
  const base = { sessionId: 'session-synthetic', running: false, preset: 'desktop-pet-relay-v1', model: { provider: 'deepseek-official', model: 'deepseek-flash' } };
  const usage = { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5 };
  await record({ ...base, usage }); await record({ ...base, usage });
  await record({ ...base, usage: { ...usage, outputTokens: 10 } }); await record({ ...base, usage });
  const entries = (await budget.snapshot()).entries;
  assert.deepEqual(entries[0], original); assert.equal(entries.filter(x => x.operationId.startsWith('harness-relay:')).reduce((n, x) => n + x.reservedMicros, 0), 140);
  assert.ok(entries.every(entry => entry.actualMicros === null));
});

test('read-only usage reconciliation resumes after restart and never submits or retries an engineering task', async t => {
  const f = await fixture(t), service = f.service();
  await service.observeUsage(); assert.equal(f.state.metricsReads, 0);
  const request = await service.prepare({ text: 'Task', target: { hostId: 'local', threadId: f.threadId } });
  const accepted = f.legacyConfirm(request.id); await service.close();
  f.state.metrics = [{ sessionId: accepted.harnessSessionId!, throughSeq: 10, running: false, preset: 'desktop-pet-relay-v1', model: { provider: 'deepseek-official', model: 'deepseek-flash' }, usage: { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 } }];
  const restarted = f.service(); await restarted.observeUsage(); await restarted.observeUsage();
  assert.equal(f.state.recorded.length, 1); assert.equal(f.state.metricsReads, 1);
  assert.equal(f.state.hostCalls, 0); assert.equal(f.state.sends.length, 0);
  assert.equal((await restarted.refresh(request.id)).phase, 'unknown');
});

test('exact Harness failure with missing usage exits forwarding without retry or pretending engineering completion', async t => {
  const f = await fixture(t), service = f.service();
  const request = await service.prepare({ text: 'Task', target: { hostId: 'local', threadId: f.threadId } });
  const accepted = f.legacyConfirm(request.id);
  f.state.metrics = [{ sessionId: accepted.harnessSessionId!, throughSeq: 17, running: false, preset: 'desktop-pet-relay-v1', model: null, usage: null }];
  f.state.terminal = { status: 'unknown' }; await service.observeUsage(); assert.equal((await service.refresh(request.id)).phase, 'forwarding');
  f.state.terminal = { status: 'ended', turn: 1, reason: 'error', errorCode: 'MISSING_CREDENTIAL' }; await service.observeUsage();
  assert.equal((await service.refresh(request.id)).phase, 'unknown'); assert.equal(f.state.recorded.length, 0); assert.equal(f.state.hostCalls, 0); assert.equal(f.state.sends.length, 0);
  const next = await service.prepare({ text: 'Next task', target: { hostId: 'local', threadId: f.threadId } });
  const forwarded = f.legacyConfirm(next.id); await service.sendConfirmed(next.id);
  f.state.metrics.push({ ...f.state.metrics[0]!, sessionId: forwarded.harnessSessionId! });
  f.state.terminal = { status: 'ended', turn: 1, reason: 'completed' }; await service.observeUsage();
  assert.equal((await service.refresh(next.id)).phase, 'accepted'); assert.equal(f.state.sends.length, 1);
});

test('new receipt database is owner-only and a future schema is refused without mutation', async t => {
  const f = await fixture(t), service = f.service(), file = join(f.root, 'harness-relay.sqlite');
  assert.equal(isPrivateFileSync(file), true); await service.close();
  const bytes = await readFile(file); await f.service().close(); assert.deepEqual(await readFile(file), bytes);
  bytes.writeUInt32BE(3, 60); await writeFile(file, bytes);
  assert.throws(() => f.service(), { code: 'invalid_request' }); assert.deepEqual(await readFile(file), bytes);
});

test('late unknown observation cannot downgrade a concurrent exact completion', async t => {
 const f=await fixture(t),service=f.service();
 const request=await service.prepare({text:'Synthetic task',target:{hostId:'local',threadId:f.threadId}});
 await service.confirm(request.id,request.version);const turnId=service.record(request.id).appTurnId!;
 let release!:(value:CodexAppReceipt)=>void,reads=0;
 f.state.receiptOverride=()=>++reads===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({threadId:f.threadId,turnId,status:'completed',reply:'Exact final result'});
 const slow=service.refreshReceipt(request.id);assert.ok(release);
 assert.equal((await service.refreshReceipt(request.id)).phase,'completed');
 release({threadId:f.threadId,turnId,status:'unknown',reason:'interrupted'});
 const final=await slow;assert.equal(final.phase,'completed');assert.equal(final.result,'Exact final result');
 assert.equal(service.record(request.id).phase,'completed');assert.equal(service.record(request.id).detail,undefined);
 assert.equal(f.state.sends.length,1);assert.equal(f.state.hostCalls,0);
});

test('target search advertises and requests the same 1000-item UI contract',async t=>{
 const f=await fixture(t),service=f.service();const result=await service.targets('synthetic search');assert.equal(result.limit,1000);assert.deepEqual(f.state.targetReads,[{query:'synthetic search',limit:1000}]);assert.equal(result.items.length,1);assert.equal(f.state.sends.length,0);
});
