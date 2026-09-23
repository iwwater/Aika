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
import { CompanionEventHub } from '../../core/companion-event-hub.js';
import {
  WorkDispatchManager,
  AcpProtocolAdapter,
  McpToolProtocolAdapter,
} from '../../core/work-protocol-adapter.js';
import { productionPairing } from '../../contracts/character-pack.js';
import type { CompanionEventEnvelope } from '../../contracts/perception.js';

test('AC-0805-1: Idempotent dispatch (duplicate confirmation only dispatches once)', async () => {
  const hub = new CompanionEventHub();
  let remoteCallCount = 0;

  const acpAdapter = new AcpProtocolAdapter(
    { protocolVersion: '2024-11-05' },
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
    manager.dispatch('op-idem-1', pairing),
    manager.dispatch('op-idem-1', pairing),
  ]);

  assert.equal(remoteCallCount, 1, 'Remote adapter must only be invoked once');
  assert.equal(manager.getDispatchCount('op-idem-1'), 1);
  assert.equal(res1.status, 'succeeded');
  assert.equal(res2.status, 'succeeded');
  assert.equal(res1.remoteTaskId, res2.remoteTaskId);

  // 2. Re-dispatching an already settled operation returns existing receipt without calling remote
  const res3 = await manager.dispatch('op-idem-1', pairing);
  assert.equal(remoteCallCount, 1, 'Settled operation must never invoke remote adapter again');
  assert.equal(res3.status, 'succeeded');
});

test('AC-0805-2: Target revision updates unconfirmed draft; settled draft cannot be revised', async () => {
  const hub = new CompanionEventHub();
  const acpAdapter = new AcpProtocolAdapter();
  const mcpAdapter = new McpToolProtocolAdapter();
  const manager = new WorkDispatchManager(hub, acpAdapter, mcpAdapter);
  const pairing = productionPairing('companion', 'inst-alpha');

  manager.prepareRequest({
    operationId: 'op-rev-1',
    protocol: 'acp',
    executorId: 'codex',
    target: { title: 'Draft Target V1' },
    instruction: 'git status',
    permissionGrant: [],
  });

  // Revise before dispatch
  const revised = manager.reviseRequest('op-rev-1', {
    target: { title: 'Draft Target V2', directory: '/packages/core' },
    instruction: 'npm test',
  });
  assert.equal(revised.target.title, 'Draft Target V2');
  assert.equal(revised.instruction, 'npm test');

  // Dispatch the revised request
  const receipt = await manager.dispatch('op-rev-1', pairing);
  assert.equal(receipt.status, 'succeeded');

  // Attempting to revise an already-dispatched operation must throw
  assert.throws(
    () => manager.reviseRequest('op-rev-1', { instruction: 'should fail' }),
    /cannot revise an operation that is already dispatched/,
  );
});

test('AC-0805-3: Timeout or unknown remote response marked as uncertain without blind re-dispatch', async () => {
  const hub = new CompanionEventHub();
  let invocationCount = 0;

  const flakyAcp = new AcpProtocolAdapter(
    { protocolVersion: '2024-11-05' },
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
  const receipt = await manager.dispatch('op-timeout-1', pairing);
  assert.equal(receipt.status, 'uncertain', 'Timeout must settle as uncertain status');
  assert.equal(receipt.error?.code, 'remote_uncertain');
  assert.equal(receipt.error?.retryable, false, 'Uncertain side-effecting operations are strictly not retryable');
  assert.equal(invocationCount, 1);

  // Subsequent dispatch returns the existing uncertain receipt, refusing blind auto-retry
  const receipt2 = await manager.dispatch('op-timeout-1', pairing);
  assert.equal(invocationCount, 1, 'Must not blindly re-dispatch after uncertain failure');
  assert.equal(receipt2.status, 'uncertain');
});

test('AC-0805-4: ACP adapter lifecycle (handshake, task dispatch, cancellation, unsupported version)', async () => {
  // 1. Unsupported version
  const badAdapter = new AcpProtocolAdapter({ protocolVersion: '99.0' });
  await assert.rejects(
    async () => badAdapter.connect(),
    /unsupported_protocol_version/,
  );

  // 2. Cancellation during in-flight dispatch
  const acp = new AcpProtocolAdapter(
    { protocolVersion: '2024-11-05' },
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

  const mcp = new McpToolProtocolAdapter({ protocolVersion: '2025-03-26' }, tools);

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
});

test('AC-0805-6: Work domain isolation (events published strictly with domain work)', async () => {
  const hub = new CompanionEventHub();
  const acpAdapter = new AcpProtocolAdapter();
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

  await manager.dispatch('op-domain-1', pairing);

  assert.ok(receivedEnvelopes.length >= 1);
  for (const env of receivedEnvelopes) {
    assert.equal(env.domain, 'work', 'All work execution envelopes must strictly have domain = work');
    assert.notEqual(env.domain, 'companion', 'Work events must never impersonate companion memory');
  }
});
