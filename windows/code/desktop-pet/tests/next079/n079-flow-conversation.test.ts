import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { FlowProfile } from '../../contracts/flow-profile.js';
import { importPackageHost, setPackageEnablement } from '../../plugins/host-config.js';
import { createPackageHost } from '../../plugins/host-runtime.js';
import { computeManifestHash } from '../../plugins/manifest.js';
import { Next65Management } from '../../management/next65-management.js';
import { startManagementServer } from '../../management/server.js';
import type { PackageManifest } from '../../contracts/plugin.js';
import { execFileSync } from 'node:child_process';

const sourceRoot = resolve(process.cwd(), 'tests/next65/fixtures/packages/normal');
const capability = {
  adapterVersion: '1.0.0', contractVersion: '1.0.0', auth: 'none', sideEffect: 'local_read', execution: ['unary'],
  capabilityId: 'context.source', category: 'context_source', adapterId: 'fixture.context.source', parameters: ['scope'],
  inputs: [{ name: 'scope', type: 'scope', required: true, description: '当前会话范围' }],
  outputs: [{ name: 'text', type: 'string', required: true, description: '引用资料' }],
};
const networkCapability = { ...capability, adapterId: 'fixture.network.source', auth: 'credentialRef', sideEffect: 'network_egress' };

function buildContextPackage(source: string): void {
  cpSync(sourceRoot, source, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(source, 'manifest.json'), 'utf8')) as PackageManifest;
  const entry = `
const capabilities = ${JSON.stringify([capability, networkCapability])};
export const activation = {
  activate(host) {
    for (const capability of capabilities) host.capabilities.register({ ...capability, provide: {
      capabilityId: capability.capabilityId, adapterId: capability.adapterId, adapterVersion: capability.adapterVersion,
      pluginId: host.pluginId, packageId: host.packageId,
      execute: async input => ({ text: 'fixture-context:' + input.scope.turnId })
    } });
    return { pluginId: host.pluginId, packageId: host.packageId, packageVersion: '1.0.0', apiVersion: '1.0.0', state: 'active', capabilityIds: capabilities.map(capability => capability.capabilityId) };
  },
  deactivate() {}
};
`;
  writeFileSync(resolve(source, 'entry.mjs'), entry, 'utf8');
  const hash = createHash('sha256').update(entry).digest('hex');
  const next = {
    ...manifest,
    plugins: [{ ...manifest.plugins[0]!, capabilities: [capability, networkCapability] }],
    files: manifest.files.map(file => file.path === 'entry.mjs' ? { ...file, bytes: Buffer.byteLength(entry), hash: `sha256-${hash}` } : file),
    manifestHash: '',
  };
  next.manifestHash = computeManifestHash(next as unknown as PackageManifest);
  writeFileSync(resolve(source, 'manifest.json'), JSON.stringify(next, null, 2) + '\n', 'utf8');
}

function profile(profileId = 'conversation.fixture', sideEffect: FlowProfile['nodes'][number]['sideEffect'] = 'local_read', bindingId = 'fixture.context.source'): FlowProfile {
  return {
    schemaVersion: 1, profileId, revision: 1, label: '对话本地来源',
    nodes: [{ nodeId: 'local-context', kind: 'capability', capabilityId: 'context.source', bindingId,
      inputs: [{ name: 'scope', from: null, required: true }], outputs: [{ name: 'text', required: true }],
      sideEffect, condition: null, dependsOn: [] }],
    failurePolicy: { onStageFailure: 'fail_turn', retrySideEffects: false, maxAttempts: 1 }, joinOrder: ['local-context'],
  };
}

const childRunner = resolve(process.cwd(), 'tests/next079/flow-replay-child.mjs');

test('N079-09 admin-saved Host/Flow is consumed by 100 real conversation turns across process restart', async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'n079-flow-replay-'));
  const packageSource = resolve(directory, 'context-source');
  const hostRoot = resolve(directory, 'host');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  buildContextPackage(packageSource);
  const imported = importPackageHost({ sourceRoot: packageSource, hostRoot });
  assert.equal(imported.ok, true, JSON.stringify(imported.issues));
  assert.equal(setPackageEnablement({ hostRoot, packageId: 'com.aika.fixture.normal', enabled: true }).ok, true);

  const host = createPackageHost({ hostRoot, secrets: { has: () => false, resolve: () => null, list: () => [] } });
  const management = new Next65Management({ hostRoot, host });
  const server = await startManagementServer({
    uiRoot: resolve(process.cwd(), 'management/ui'), settings: { async drain() {} } as never,
    memory: {} as never, snapshot: () => ({} as never), next65: management,
  });
  t.after(() => server.close());
  const managementRequest = (path: string, method = 'GET', value?: unknown) => fetch(`${server.origin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${server.token}`, ...(method === 'GET' ? {} : { Origin: server.origin, 'Content-Type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const savedResponse = await managementRequest('/api/next65/profiles', 'PUT', { profile: profile(), expectedRevision: 0 });
  assert.equal(savedResponse.status, 200, await savedResponse.text());
  const savedPayload = await (await managementRequest('/api/next65/profiles')).json() as { profiles: unknown[]; active: unknown };
  assert.equal(savedPayload.profiles.length, 1);
  assert.equal(savedPayload.active, null);
  const activatedResponse = await managementRequest('/api/next65/profiles/conversation.fixture/activate', 'POST', { expectedRevision: 1 });
  assert.equal(activatedResponse.status, 200, await activatedResponse.text());
  management.saveProfile(profile('unsafe-network', 'network_egress'), 0);
  assert.throws(() => management.activateProfile('unsafe-network', 1), /only allows context.source/);
  management.saveProfile(profile('misdeclared-network', 'local_read', 'fixture.network.source'), 0);
  assert.throws(() => management.activateProfile('misdeclared-network', 1), /not declared as a matching local-read/);
  assert.equal(management.activeProfile()?.profileId, 'conversation.fixture');
  await host.close();

  const run = (turns: number) => {
    const output = execFileSync(process.execPath, [childRunner, hostRoot, String(turns)], { cwd: process.cwd(), encoding: 'utf8', timeout: 120_000 });
    return JSON.parse(output.trim()) as { turns: number; flowCalls: number; profileId: string; first: string; last: string };
  };
  const firstProcess = run(80);
  assert.equal(firstProcess.turns, 80); assert.equal(firstProcess.flowCalls, 80); assert.equal(firstProcess.profileId, 'conversation.fixture');
  assert.match(firstProcess.first, /^fixture-context:/); assert.match(firstProcess.last, /^fixture-context:/); assert.notEqual(firstProcess.first, firstProcess.last);
  const restartedProcess = run(20);
  assert.equal(restartedProcess.turns, 20); assert.equal(restartedProcess.flowCalls, 20); assert.equal(restartedProcess.profileId, 'conversation.fixture');
  assert.match(restartedProcess.first, /^fixture-context:/); assert.match(restartedProcess.last, /^fixture-context:/); assert.notEqual(restartedProcess.first, restartedProcess.last);
});
