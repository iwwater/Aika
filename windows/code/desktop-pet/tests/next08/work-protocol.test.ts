/**
 * tests/next08/work-protocol.test.ts
 *
 * 08-05 Acceptance Test Suite:
 * Validates Work execution manager, ACP adapter, MCP adapter, idempotency,
 * uncertain timeout handling, revision invalidation, and domain isolation.
 *
 * AC-0805-1: Idempotent dispatch (duplicate confirmation only dispatches once)
 * AC-0805-2: Target revision invalidates unconfirmed draft
 * AC-0805-3: Timeout or unknown remote response marked as 'uncertain' without blind re-dispatch
 * AC-0805-4: ACP adapter lifecycle (handshake, task dispatch, cancellation, unsupported version)
 * AC-0805-5: MCP adapter tools list and execution with permission boundary
 * AC-0805-6: Work domain isolation (events published strictly with domain 'work')
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanionEventHub } from '../../core/companion-event-hub.js';
import {
  WorkDispatchManager,
  AcpProtocolAdapter,
  McpToolProtocolAdapter,
} from '../../core/work-protocol-adapter.js';
import { SqliteWorkProtocolJournal } from '../../core/work-protocol-journal.js';
import { restrictPrivatePathSync } from '../../core/platform-files.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { CompanionEventEnvelope } from '../../contracts/perception.js';

async function dispatchCurrent(manager: WorkDispatchManager, operationId: string, pairing: ReturnType<typeof productionPairing>, signal?: AbortSignal) {
  const request = manager.getRequest(operationId, pairing);
  assert.ok(request, `request ${operationId} should exist`);
  return manager.dispatch(operationId, pairing, request.revision, signal);
}

async function cancelCurrent(manager: WorkDispatchManager, operationId: string, pairing: ReturnType<typeof productionPairing>) {
  const request = manager.getRequest(operationId, pairing);
  assert.ok(request, `request ${operationId} should exist`);
  return manager.cancel(operationId, pairing, request.revision);
}

test('AC-0805-1: Idempotent dispatch (duplicate confirmation only dispatches once)', async () => {
  const hub = new CompanionEventHub();
  let remoteCallCount = 0;

  const acpAdapter = new AcpProtocolAdapter(
    { protocolVersion: 1 },
    async req => {
      remoteCallCount++;
      // Artificial delay to allow concurrent dispatch
      await new Promise(r => setTimeout(r, 20));
      return `Executed ${req.instruction}`;
    },
  );
  const mcpAdapter = new McpToolProtocolAdapter();
  const manager = new WorkDispatchManager(hub, acpAdapter, mcpAdapter);
  const pairing = productionPairing('companion', 'inst-alpha');

  manager.prepareRequest({
    operationId: 'op-idem-1',
    protocol: 'acp',
    executorId: 'codex',
    target: { title: 'Repo Alpha', directory: '/src' },
    instruction: 'run build',
    permissionGrant: ['read'],
  });

  // 1. Two concurrent dispatches for the exact same operationId
  const [res1, res2] = await Promise.all([
    dispatchCurrent(manager, 'op-idem-1', pairing),
    dispatchCurrent(manager, 'op-idem-1', pairing),
  ]);

  assert.equal(remoteCallCount, 1, 'Remote adapter must only be invoked once');
  assert.equal(manager.getDispatchCount('op-idem-1'), 1);
  assert.equal(res1.status, 'succeeded');
  assert.equal(res2.status, 'succeeded');
  assert.equal(res1.remoteTaskId, res2.remoteTaskId);

  // 2. Re-dispatching an already settled operation returns existing receipt without calling remote
  const res3 = await dispatchCurrent(manager, 'op-idem-1', pairing);
  assert.equal(remoteCallCount, 1, 'Settled operation must never invoke remote adapter again');
  assert.equal(res3.status, 'succeeded');
});

test('AC-0805-2: Target revision updates unconfirmed draft; settled draft cannot be revised', async () => {
  const hub = new CompanionEventHub();
  const acpAdapter = new AcpProtocolAdapter({ protocolVersion: 1 }, async req => `Executed ${req.instruction}`);
  const mcpAdapter = new McpToolProtocolAdapter();
  const manager = new WorkDispatchManager(hub, acpAdapter, mcpAdapter);
  const pairing = productionPairing('companion', 'inst-alpha');

  const prepared = manager.prepareRequest({
    operationId: 'op-rev-1',
    protocol: 'acp',
    executorId: 'codex',
    target: { title: 'Draft Target V1' },
    instruction: 'git status',
    permissionGrant: [],
  });

  // Revise before dispatch
  const revised = manager.reviseRequest('op-rev-1', prepared.revision, {
    target: { title: 'Draft Target V2', directory: '/packages/core' },
    instruction: 'npm test',
  });
  assert.equal(revised.target.title, 'Draft Target V2');
  assert.equal(revised.instruction, 'npm test');
  assert.equal(revised.revision, prepared.revision + 1);

  // A confirmation rendered for the old draft must not dispatch the revised contents.
  await assert.rejects(
    () => manager.dispatch('op-rev-1', pairing, prepared.revision),
    /request_revision_conflict/,
  );

  // Dispatch the revised request
  const receipt = await manager.dispatch('op-rev-1', pairing, revised.revision);
  assert.equal(receipt.status, 'succeeded');

  // Attempting to revise an already-dispatched operation must throw
  assert.throws(
    () => manager.reviseRequest('op-rev-1', revised.revision, { instruction: 'should fail' }),
    /cannot revise an operation that is already dispatched/,
  );
});

test('AC-0805-3: Timeout or unknown remote response marked as uncertain without blind re-dispatch', async () => {
  const hub = new CompanionEventHub();
  let invocationCount = 0;

  const flakyAcp = new AcpProtocolAdapter(
    { protocolVersion: 1 },
    async () => {
      invocationCount++;
      throw new Error('Connection timeout waiting for remote host response');
    },
  );
  const mcpAdapter = new McpToolProtocolAdapter();
  const manager = new WorkDispatchManager(hub, flakyAcp, mcpAdapter);
  const pairing = productionPairing('companion', 'inst-alpha');

  manager.prepareRequest({
    operationId: 'op-timeout-1',
    protocol: 'acp',
    executorId: 'codex',
    target: { title: 'Critical Deployment' },
    instruction: 'deploy production',
    permissionGrant: ['write'],
  });

  // Dispatch encounters timeout
  const receipt = await dispatchCurrent(manager, 'op-timeout-1', pairing);
  assert.equal(receipt.status, 'uncertain', 'Timeout must settle as uncertain status');
  assert.equal(receipt.error?.code, 'remote_uncertain');
  assert.equal(receipt.error?.retryable, false, 'Uncertain side-effecting operations are strictly not retryable');
  assert.equal(invocationCount, 1);

  // Subsequent dispatch returns the existing uncertain receipt, refusing blind auto-retry
  const receipt2 = await dispatchCurrent(manager, 'op-timeout-1', pairing);
  assert.equal(invocationCount, 1, 'Must not blindly re-dispatch after uncertain failure');
  assert.equal(receipt2.status, 'uncertain');
});

test('AC-0805-4: ACP adapter lifecycle (handshake, task dispatch, cancellation, unsupported version)', async () => {
  // 1. Unsupported version
  const badAdapter = new AcpProtocolAdapter({ protocolVersion: 99 });
  await assert.rejects(
    async () => badAdapter.connect(),
    /unsupported_protocol_version/,
  );

  // 2. Cancellation during in-flight dispatch
  const acp = new AcpProtocolAdapter(
    { protocolVersion: 1 },
    async (_req, signal) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve('Done'), 100);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
  );

  const controller = new AbortController();
  const dispatchPromise = acp.dispatchTask(
    {
      operationId: 'op-abort-1',
      revision: 1,
      protocol: 'acp',
      executorId: 'codex',
      target: { title: 'Test' },
      instruction: 'slow task',
      permissionGrant: [],
      requestedAt: new Date().toISOString(),
    },
    controller.signal,
  );

  // Abort mid-flight
  controller.abort();
  const receipt = await dispatchPromise;
  assert.equal(receipt.status, 'cancelled');
  assert.equal(receipt.error?.code, 'cancelled');
});

test('AC-0805-4a: Cancellation waits for the executor result and never overwrites success', async () => {
  const hub = new CompanionEventHub();
  let finishTask!: (summary: string) => void;
  const acp = new AcpProtocolAdapter({ protocolVersion: 1 }, async () => new Promise(resolve => {
    finishTask = resolve;
  }));
  const manager = new WorkDispatchManager(hub, acp, new McpToolProtocolAdapter());
  const pairing = productionPairing('companion', 'inst-alpha');
  manager.prepareRequest({ operationId: 'op-cancel-race', protocol: 'acp', executorId: 'fixture',
    target: { title: 'Cancellation race' }, instruction: 'slow operation', permissionGrant: [] });

  const dispatch = dispatchCurrent(manager, 'op-cancel-race', pairing);
  await new Promise(resolve => setImmediate(resolve));
  const cancel = cancelCurrent(manager, 'op-cancel-race', pairing);
  finishTask('Completed despite the cancellation request');

  const [dispatchReceipt, cancelReceipt] = await Promise.all([dispatch, cancel]);
  assert.equal(dispatchReceipt.status, 'succeeded');
  assert.equal(cancelReceipt.status, 'succeeded', 'Cancellation must return the executor’s settled result');
  assert.equal(manager.getReceipt('op-cancel-race')?.status, 'succeeded');
});

test('AC-0805-4b: Unconfirmed cancellation settles uncertain and late success cannot overwrite it', async () => {
  const hub = new CompanionEventHub();
  let finishTask!: (summary: string) => void;
  const acp = new AcpProtocolAdapter({ protocolVersion: 1 }, async () => new Promise(resolve => {
    finishTask = resolve;
  }));
  const manager = new WorkDispatchManager(hub, acp, new McpToolProtocolAdapter(), undefined, 10);
  const pairing = productionPairing('companion', 'inst-alpha');
  manager.prepareRequest({ operationId: 'op-cancel-timeout', protocol: 'acp', executorId: 'fixture',
    target: { title: 'Cancellation timeout' }, instruction: 'unresponsive operation', permissionGrant: [] });

  const dispatch = dispatchCurrent(manager, 'op-cancel-timeout', pairing);
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = await cancelCurrent(manager, 'op-cancel-timeout', pairing);
  assert.equal(cancelled.status, 'uncertain');
  assert.equal(cancelled.error?.code, 'cancel_unconfirmed');

  finishTask('Late success');
  const dispatchReceipt = await dispatch;
  assert.equal(dispatchReceipt.status, 'uncertain');
  assert.equal(manager.getReceipt('op-cancel-timeout')?.status, 'uncertain');
  const repeatedCancel = await cancelCurrent(manager, 'op-cancel-timeout', pairing);
  assert.equal(repeatedCancel.status, 'uncertain', 'A repeated cancel must preserve the uncertain terminal receipt');
});

test('AC-0805-4c: Executor failure after cancellation request is uncertain, not a false failure', async () => {
  const hub = new CompanionEventHub();
  let rejectTask!: (error: Error) => void;
  const acp = new AcpProtocolAdapter({ protocolVersion: 1 }, async () => new Promise((_resolve, reject) => {
    rejectTask = reject;
  }));
  const manager = new WorkDispatchManager(hub, acp, new McpToolProtocolAdapter(), undefined, 1_000);
  const pairing = productionPairing('companion', 'inst-alpha');
  manager.prepareRequest({ operationId: 'op-cancel-error', protocol: 'acp', executorId: 'fixture',
    target: { title: 'Cancellation error' }, instruction: 'remote side effect', permissionGrant: [] });

  const dispatch = dispatchCurrent(manager, 'op-cancel-error', pairing);
  await new Promise(resolve => setImmediate(resolve));
  const cancel = cancelCurrent(manager, 'op-cancel-error', pairing);
  rejectTask(new Error('executor rejected stop request'));

  const [dispatchReceipt, cancelReceipt] = await Promise.all([dispatch, cancel]);
  assert.equal(dispatchReceipt.status, 'uncertain');
  assert.equal(dispatchReceipt.error?.code, 'cancel_unconfirmed');
  assert.equal(cancelReceipt.status, 'uncertain');
  assert.equal(manager.getReceipt('op-cancel-error')?.status, 'uncertain');
});

test('AC-0805-5: MCP adapter tools list and execution with permission boundary', async () => {
  const tools = [
    {
      name: 'fs_read',
      description: 'Read file contents',
      readOnly: true,
      inputSchema: { type: 'object' },
      handler: (args: Record<string, unknown>) => `file-content-of-${args.path}`,
    },
    {
      name: 'fs_write',
      description: 'Write file contents',
      readOnly: false,
      requiredGrant: 'write',
      inputSchema: { type: 'object' },
      handler: (args: Record<string, unknown>) => `wrote-${args.path}`,
    },
  ];

  const mcp = new McpToolProtocolAdapter({ protocolVersion: '2025-11-25' }, tools);

  // 1. List tools: returns read-only metadata
  const list = await mcp.listTools();
  assert.equal(list.length, 2);
  assert.equal(list[0]?.name, 'fs_read');
  assert.equal(list[0]?.readOnly, true);
  assert.equal(list[1]?.name, 'fs_write');
  assert.equal(list[1]?.readOnly, false);

  // 2. Call read-only tool: succeeds without special grants
  const readRes = await mcp.callTool('fs_read', { path: '/tmp/test.txt' }, []);
  assert.equal(readRes, 'file-content-of-/tmp/test.txt');

  // 3. Call write tool without required 'write' grant: rejected
  await assert.rejects(
    async () => mcp.callTool('fs_write', { path: '/tmp/test.txt' }, ['read']),
    /permission_denied/,
  );

  // 4. Call write tool with 'write' grant: succeeds
  const writeRes = await mcp.callTool('fs_write', { path: '/tmp/test.txt' }, ['write']);
  assert.equal(writeRes, 'wrote-/tmp/test.txt');

  const missingHandler = new McpToolProtocolAdapter({ protocolVersion: '2025-11-25' }, [{
    name: 'missing', description: 'No executor', readOnly: true, inputSchema: { type: 'object' },
  }]);
  await assert.rejects(() => missingHandler.callTool('missing', {}, []), /tool_unavailable/);
});

test('ACP and MCP adapters without real executors fail closed', async () => {
  const acp = new AcpProtocolAdapter();
  await assert.rejects(() => acp.connect(), /transport_unavailable/);
  const mcp = new McpToolProtocolAdapter();
  await assert.rejects(() => mcp.callTool('unknown', {}, []), /tool_not_found/);
});

test('AC-0805-6: Work domain isolation (events published strictly with domain work)', async () => {
  const hub = new CompanionEventHub();
  const acpAdapter = new AcpProtocolAdapter({ protocolVersion: 1 }, async req => `Executed ${req.instruction}`);
  const mcpAdapter = new McpToolProtocolAdapter();
  const manager = new WorkDispatchManager(hub, acpAdapter, mcpAdapter);
  const pairing = productionPairing('companion', 'inst-alpha');

  const receivedEnvelopes: CompanionEventEnvelope[] = [];
  hub.subscribeDomain(['work', 'companion', 'canon'], env => {
    receivedEnvelopes.push(env);
  });

  manager.prepareRequest({
    operationId: 'op-domain-1',
    protocol: 'acp',
    executorId: 'codex',
    target: { title: 'Domain Isolation Check' },
    instruction: 'run verification',
    permissionGrant: [],
  });

  await dispatchCurrent(manager, 'op-domain-1', pairing);

  assert.ok(receivedEnvelopes.length >= 1);
  for (const env of receivedEnvelopes) {
    assert.equal(env.domain, 'work', 'All work execution envelopes must strictly have domain = work');
    assert.notEqual(env.domain, 'companion', 'Work events must never impersonate companion memory');
  }
  const completion = receivedEnvelopes.find(env => env.type === 'work.task.completed');
  assert.equal((completion?.payload as Record<string, unknown> | undefined)?.executorId, 'codex');
  assert.equal((completion?.payload as Record<string, unknown> | undefined)?.title, 'Domain Isolation Check');
  assert.equal((completion?.payload as Record<string, unknown> | undefined)?.status, 'succeeded');
});

test('AC-0805-7: restart recovers an attempted dispatch as uncertain and never retries it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'aika-work-journal-'));
  const filename = join(directory, 'work-protocol.sqlite');
  let journal: SqliteWorkProtocolJournal | undefined;
  t.after(() => {
    journal?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  journal = new SqliteWorkProtocolJournal(filename);
  const pairing = productionPairing('companion', 'inst-alpha');
  let executorStarted!: () => void;
  const started = new Promise<void>(resolve => { executorStarted = resolve; });
  let firstExecutorCalls = 0;
  const firstManager = new WorkDispatchManager(
    new CompanionEventHub(),
    new AcpProtocolAdapter({ protocolVersion: 1 }, async () => {
      firstExecutorCalls++;
      executorStarted();
      return new Promise<string>(() => {}); // Simulates losing the process before a remote terminal receipt.
    }),
    new McpToolProtocolAdapter(),
    () => '2026-09-24T10:00:00.000Z',
    5_000,
    journal,
  );
  const originalRequest = firstManager.prepareRequest({
    operationId: 'op-crash-recovery', protocol: 'acp', executorId: 'fixture',
    target: { title: 'Crash recovery' }, instruction: 'run exactly once', permissionGrant: [],
  }, pairing);
  const revisedRequest = firstManager.reviseRequest('op-crash-recovery', originalRequest.revision,
    { instruction: 'run exactly once after review' }, pairing);
  await assert.rejects(
    () => firstManager.dispatch('op-crash-recovery', pairing, originalRequest.revision),
    /request_revision_conflict/,
  );

  const firstDispatch = firstManager.dispatch('op-crash-recovery', pairing, revisedRequest.revision);
  await started;
  assert.equal(firstExecutorCalls, 1);
  assert.equal(journal.entries()[0]?.dispatchStarted, true);

  // Closing and reopening the journal models a new process after a lost remote response.
  journal.close();
  journal = new SqliteWorkProtocolJournal(filename);
  const recoveryHub = new CompanionEventHub();
  const recoveredEvents: CompanionEventEnvelope[] = [];
  recoveryHub.subscribeDomain(['work'], event => { recoveredEvents.push(event); });
  let restartedExecutorCalls = 0;
  const restartedManager = new WorkDispatchManager(
    recoveryHub,
    new AcpProtocolAdapter({ protocolVersion: 1 }, async () => {
      restartedExecutorCalls++;
      return 'must never be called';
    }),
    new McpToolProtocolAdapter(),
    () => '2026-09-24T10:01:00.000Z',
    5_000,
    journal,
  );

  await restartedManager.ready();
  await assert.rejects(
    () => restartedManager.dispatch('op-crash-recovery', pairing, originalRequest.revision),
    /request_revision_conflict/,
  );
  const receipt = restartedManager.getReceipt('op-crash-recovery', pairing);
  assert.equal(receipt?.status, 'uncertain');
  assert.equal(receipt?.error?.code, 'process_restarted_after_dispatch');
  assert.equal(receipt?.error?.retryable, false);
  assert.equal((await dispatchCurrent(restartedManager, 'op-crash-recovery', pairing)).status, 'uncertain');
  await assert.rejects(() => dispatchCurrent(restartedManager, 'op-crash-recovery', productionPairing('other', 'inst-alpha')), /pairing_mismatch/);
  await assert.rejects(() => cancelCurrent(restartedManager, 'op-crash-recovery', productionPairing('other', 'inst-alpha')), /pairing_mismatch/);
  assert.throws(() => restartedManager.getReceipt('op-crash-recovery'), /pairing_required_for_durable_work/);
  assert.throws(() => restartedManager.getReceipt('op-crash-recovery', productionPairing('other', 'inst-alpha')), /pairing_mismatch/);
  assert.equal(restartedExecutorCalls, 0);
  assert.equal(recoveredEvents.length, 1);
  assert.equal(recoveredEvents[0]?.domain, 'work');
  assert.equal((recoveredEvents[0]?.payload as { status?: string } | undefined)?.status, 'uncertain');
  const recoveredEntry = journal.entries()[0];
  assert.equal(recoveredEntry?.eventPublished, true);
  assert.equal(recoveredEntry?.receipt?.status, 'uncertain');

  // The abandoned promise models the crashed process and must not affect the recovered result.
  void firstDispatch;

  // Journal v1 entries predate request revisions; migration assigns their original reviewed state revision 1.
  const legacyDirectory = join(directory, 'legacy');
  mkdirSync(legacyDirectory);
  const legacyFilename = join(legacyDirectory, 'work-protocol.sqlite');
  const legacyDb = new Database(legacyFilename);
  legacyDb.pragma('application_id=0x50545731');
  legacyDb.pragma('user_version=1');
  legacyDb.exec(`CREATE TABLE protocol_operations(
    operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    pairing_json TEXT,
    dispatch_started INTEGER NOT NULL CHECK(dispatch_started IN (0,1)),
    receipt_json TEXT,
    event_published INTEGER NOT NULL CHECK(event_published IN (0,1))
  )`);
  legacyDb.prepare('INSERT INTO protocol_operations VALUES(?,?,?,0,NULL,0)').run(
    'op-legacy-revision', JSON.stringify({
      operationId: 'op-legacy-revision', protocol: 'acp', executorId: 'fixture',
      target: { title: 'Legacy request' }, instruction: 'legacy instruction', permissionGrant: [],
      requestedAt: '2026-09-24T12:00:00.000Z',
    }), JSON.stringify(pairing),
  );
  legacyDb.close();
  restrictPrivatePathSync(legacyFilename);
  const migratedJournal = new SqliteWorkProtocolJournal(legacyFilename);
  assert.equal(migratedJournal.entries()[0]?.request.revision, 1);
  migratedJournal.close();

  // A production journal written before privacy tombstones uses schema v2.
  const v2Directory = join(directory, 'v2');
  mkdirSync(v2Directory);
  const v2Filename = join(v2Directory, 'work-protocol.sqlite');
  const v2Db = new Database(v2Filename);
  v2Db.pragma('application_id=0x50545731');
  v2Db.pragma('user_version=2');
  v2Db.exec(`CREATE TABLE protocol_operations(
    operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    pairing_json TEXT,
    dispatch_started INTEGER NOT NULL CHECK(dispatch_started IN (0,1)),
    receipt_json TEXT,
    event_published INTEGER NOT NULL CHECK(event_published IN (0,1))
  )`);
  v2Db.prepare('INSERT INTO protocol_operations VALUES(?,?,?,0,NULL,0)').run(
    'op-v2-privacy-migration', JSON.stringify({ operationId: 'op-v2-privacy-migration', revision: 2, protocol: 'acp',
      executorId: 'fixture', target: { title: 'V2 request' }, instruction: 'V2 instruction', permissionGrant: [],
      requestedAt: '2026-09-24T12:00:00.000Z' }), JSON.stringify(pairing),
  );
  v2Db.close();
  restrictPrivatePathSync(v2Filename);
  const v2Migrated = new SqliteWorkProtocolJournal(v2Filename);
  assert.equal(v2Migrated.entries()[0]?.forgotten, false);
  assert.equal(v2Migrated.entries()[0]?.request.revision, 2);
  v2Migrated.close();
});

test('AC-0805-8: failed Timeline delivery keeps the receipt outbox pending and replays with a stable event ID', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'aika-work-outbox-'));
  const filename = join(directory, 'work-protocol.sqlite');
  let journal: SqliteWorkProtocolJournal | undefined;
  t.after(() => {
    journal?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  journal = new SqliteWorkProtocolJournal(filename);
  const pairing = productionPairing('companion', 'inst-alpha');
  const failingHub = new CompanionEventHub();
  const firstDelivery: CompanionEventEnvelope[] = [];
  failingHub.subscribeDomain(['work'], event => {
    firstDelivery.push(event);
    throw new Error('timeline unavailable');
  });
  const manager = new WorkDispatchManager(
    failingHub,
    new AcpProtocolAdapter({ protocolVersion: 1 }, async () => 'completed'),
    new McpToolProtocolAdapter(),
    () => '2026-09-24T11:00:00.000Z',
    5_000,
    journal,
  );
  manager.prepareRequest({
    operationId: 'op-outbox-replay', protocol: 'acp', executorId: 'fixture',
    target: { title: 'Outbox replay' }, instruction: 'record result', permissionGrant: [],
  }, pairing);
  assert.equal((await dispatchCurrent(manager, 'op-outbox-replay', pairing)).status, 'succeeded');
  assert.equal(firstDelivery.length, 1);
  assert.equal(journal.entries()[0]?.eventPublished, false, 'A rejected Timeline write must not be acknowledged');

  journal.close();
  journal = new SqliteWorkProtocolJournal(filename);
  const recoveryHub = new CompanionEventHub();
  const replayed: CompanionEventEnvelope[] = [];
  recoveryHub.subscribeDomain(['work'], event => { replayed.push(event); });
  const recoveredManager = new WorkDispatchManager(
    recoveryHub,
    new AcpProtocolAdapter({ protocolVersion: 1 }, async () => { throw new Error('must not redispatch'); }),
    new McpToolProtocolAdapter(),
    () => '2026-09-24T11:01:00.000Z',
    5_000,
    journal,
  );
  await recoveredManager.ready();
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0]?.eventId, firstDelivery[0]?.eventId);
  assert.equal(replayed[0]?.occurredAt, firstDelivery[0]?.occurredAt, 'replay keeps the receipt occurrence time stable');
  assert.equal(journal.entries()[0]?.eventPublished, true);
  assert.equal((await dispatchCurrent(recoveredManager, 'op-outbox-replay', pairing)).status, 'succeeded');
});

test('forgotten Work requests erase journal content, retain the execution tombstone, and stay erased after restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'aika-work-forget-'));
  const filename = join(directory, 'work-protocol.sqlite');
  let journal: SqliteWorkProtocolJournal | undefined = new SqliteWorkProtocolJournal(filename);
  t.after(() => { journal?.close(); rmSync(directory, { recursive: true, force: true }); });
  const pairing = productionPairing('companion', 'inst-forget');
  let executorCalls = 0;
  const manager = new WorkDispatchManager(new CompanionEventHub(), new AcpProtocolAdapter({ protocolVersion: 1 }, async () => {
    executorCalls++;
    return { summary: 'private-result', remoteTaskId: 'private-remote-id' };
  }), new McpToolProtocolAdapter(), undefined, 5_000, journal);
  const request = manager.prepareRequest({ operationId: 'op-forget-content', protocol: 'acp', executorId: 'private-executor',
    target: { title: 'private-project', directory: 'C:\\private\\path' }, instruction: 'private-instruction', permissionGrant: ['private-grant'] }, pairing);
  manager.forgetRequest(request.operationId, pairing);
  assert.equal(manager.getRequest(request.operationId, pairing)?.instruction, '已按要求遗忘。');
  await assert.rejects(() => manager.dispatch(request.operationId, pairing, request.revision), /operation_forgotten/);
  assert.equal(executorCalls, 0);
  assert.throws(() => manager.forgetRequest(request.operationId, productionPairing('other', 'inst-forget')), /pairing_mismatch/);
  const raw = journal.entries()[0]!;
  assert.equal(raw.forgotten, true);
  assert.equal(raw.request.instruction, '已按要求遗忘。');
  assert.equal(raw.request.target.title, '已遗忘的工作任务');
  journal.close();
  journal = new SqliteWorkProtocolJournal(filename);
  const recovered = new WorkDispatchManager(new CompanionEventHub(), new AcpProtocolAdapter({ protocolVersion: 1 }, async () => {
    executorCalls++;
    return 'must-not-run';
  }), new McpToolProtocolAdapter(), undefined, 5_000, journal);
  assert.equal(recovered.getRequest(request.operationId, pairing)?.instruction, '已按要求遗忘。');
  await assert.rejects(() => recovered.dispatch(request.operationId, pairing, request.revision), /operation_forgotten/);
  assert.equal(executorCalls, 0);
  assert.deepEqual(journal.entries()[0]?.receipt, undefined);
  journal.close();
  journal = undefined;
});
