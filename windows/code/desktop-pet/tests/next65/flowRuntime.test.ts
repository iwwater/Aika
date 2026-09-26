/** K65-07: constrained profile validation, read-only parallelism and source freshness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowProfileError, FlowRuntime, type FlowStageHandler } from '../../kernel/flow-runtime.js';
import type { FlowProfile } from '../../contracts/flow-profile.js';

const base = (overrides: Partial<FlowProfile> = {}): FlowProfile => ({
  schemaVersion: 1, profileId: 'fixture.flow', revision: 1, label: 'fixture',
  nodes: [
    { nodeId: 'cloud', kind: 'capability', capabilityId: 'context.source', bindingId: 'source.a', inputs: [], outputs: [{ name: 'text', required: true }], sideEffect: 'local_read', condition: null, dependsOn: [] },
    { nodeId: 'local', kind: 'capability', capabilityId: 'context.source', bindingId: 'source.b', inputs: [], outputs: [{ name: 'text', required: true }], sideEffect: 'local_read', condition: null, dependsOn: [] },
    { nodeId: 'merge', kind: 'capability', capabilityId: 'llm.chat', bindingId: 'llm.fixture', inputs: [{ name: 'cloud', from: 'cloud.text', required: true }, { name: 'local', from: 'local.text', required: true }], outputs: [{ name: 'text', required: true }], sideEffect: 'none', condition: null, dependsOn: ['cloud', 'local'] },
  ],
  failurePolicy: { onStageFailure: 'fail_turn', retrySideEffects: false, maxAttempts: 1 }, joinOrder: ['cloud', 'local', 'merge'], ...overrides,
});

test('07-A/B: invalid graph/binding is rejected and two read-only sources merge in declared order', async () => {
  let calls = 0;
  const handlers: FlowStageHandler[] = [
    { capabilityId: 'context.source', bindingId: 'source.a', async execute() { calls += 1; await new Promise(resolve => setTimeout(resolve, 20)); return { text: 'A' }; } },
    { capabilityId: 'context.source', bindingId: 'source.b', async execute() { calls += 1; await new Promise(resolve => setTimeout(resolve, 1)); return { text: 'B' }; } },
    { capabilityId: 'llm.chat', bindingId: 'llm.fixture', async execute(context) { return { text: `${context.inputs.cloud}+${context.inputs.local}` }; } },
  ];
  const runtime = new FlowRuntime(handlers);
  const preview = runtime.preview(base()); assert.equal(calls, 0); assert.deepEqual(preview.map(node => node.nodeId), ['cloud', 'local', 'merge']);
  const result = await runtime.run(base());
  assert.equal(result.status, 'completed'); assert.equal(result.outputs.merge?.text, 'A+B'); assert.equal(calls, 2);
  assert.deepEqual(result.diagnostics.filter(item => item.status === 'started').map(item => item.nodeId), ['cloud', 'local', 'merge']);
  const invalid = base({ nodes: [{ ...base().nodes[0]!, nodeId: 'bad', bindingId: 'missing' }] });
  assert.throws(() => runtime.preview(invalid), FlowProfileError);
});

test('07-C/F: a source revision change invalidates the fixed run and never falls back to another handler', async () => {
  let current = true; let fallbackCalls = 0;
  const runtime = new FlowRuntime([
    { capabilityId: 'context.source', bindingId: 'source.a', async execute(context) { context.assertSourcesCurrent(); current = false; return { text: 'A' }; } },
    { capabilityId: 'context.source', bindingId: 'source.b', async execute() { fallbackCalls += 1; return { text: 'B' }; } },
    { capabilityId: 'llm.chat', bindingId: 'llm.fixture', async execute() { return { text: 'should-not-run' }; } },
  ]);
  await assert.rejects(runtime.run(base(), { sourceRevisions: new Map([['source-1', 3]]), isSourceCurrent: () => current }), /stale context source/);
  assert.equal(fallbackCalls, 0);
});

test('07-A/E: optional failure reports a partial result without retrying a side-effecting stage', async () => {
  let effectCalls = 0;
  const profile = base({ failurePolicy: { onStageFailure: 'report_partial', retrySideEffects: false, maxAttempts: 1 }, nodes: [
    { nodeId: 'optional', kind: 'capability', capabilityId: 'context.source', bindingId: 'optional', inputs: [], outputs: [{ name: 'text', required: false }], sideEffect: 'local_read', condition: null, dependsOn: [] },
    { nodeId: 'effect', kind: 'capability', capabilityId: 'audio.playback', bindingId: 'effect', inputs: [], outputs: [{ name: 'done', required: true }], sideEffect: 'user_visible_output', condition: null, dependsOn: ['optional'] },
  ], joinOrder: ['optional', 'effect'] });
  const runtime = new FlowRuntime([
    { capabilityId: 'context.source', bindingId: 'optional', async execute() { throw new Error('fixture source unavailable'); } },
    { capabilityId: 'audio.playback', bindingId: 'effect', async execute() { effectCalls += 1; return { done: true }; } },
  ]);
  const result = await runtime.run(profile); assert.equal(result.status, 'partial'); assert.equal(effectCalls, 1);
  assert.equal(result.diagnostics.filter(item => item.status === 'failed').length, 1);
});

test('07-A: skip_optional never invokes a downstream stage whose required input is missing', async () => {
  let downstreamCalls = 0;
  const profile = base({ failurePolicy: { onStageFailure: 'skip_optional', retrySideEffects: false, maxAttempts: 1 }, nodes: [
    { nodeId: 'source', kind: 'capability', capabilityId: 'context.source', bindingId: 'source', inputs: [], outputs: [{ name: 'text', required: false }], sideEffect: 'local_read', condition: null, dependsOn: [] },
    { nodeId: 'llm', kind: 'capability', capabilityId: 'llm.chat', bindingId: 'llm', inputs: [{ name: 'text', from: 'source.text', required: true }], outputs: [{ name: 'text', required: true }], sideEffect: 'network_egress', condition: null, dependsOn: ['source'] },
  ], joinOrder: ['source', 'llm'] });
  const runtime = new FlowRuntime([
    { capabilityId: 'context.source', bindingId: 'source', async execute() { throw new Error('source unavailable'); } },
    { capabilityId: 'llm.chat', bindingId: 'llm', async execute() { downstreamCalls += 1; return { text: 'must not run' }; } },
  ]);
  await assert.rejects(runtime.run(profile), /source unavailable|required input/i);
  assert.equal(downstreamCalls, 0);
});

test('07-A: restricted condition groups honor all/any without evaluating code', async () => {
  const profile = base({ nodes: [{ nodeId: 'guarded', kind: 'capability', capabilityId: 'context.source', bindingId: 'guarded', inputs: [], outputs: [{ name: 'ok', required: true }], sideEffect: 'none', condition: { mode: 'any', rules: [{ left: 'flags.enabled', operator: 'equals', right: true }, { left: 'flags.missing', operator: 'exists' }] }, dependsOn: [] }], joinOrder: ['guarded'] });
  const runtime = new FlowRuntime([{ capabilityId: 'context.source', bindingId: 'guarded', async execute() { return { ok: true }; } }]);
  const result = await runtime.run(profile, { values: { flags: { enabled: true } } });
  assert.equal(result.outputs.guarded?.ok, true);
});
