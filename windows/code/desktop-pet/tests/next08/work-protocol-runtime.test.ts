import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../management/helpers.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { UnifiedTimelineService } from '../../memory/unified-timeline.js';
import { CompanionEventHub } from '../../core/companion-event-hub.js';
import { WorkProtocolRuntime } from '../../management/work-protocol-runtime.js';
import { SqliteWorkProtocolJournal } from '../../core/work-protocol-journal.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { startManagementServer } from '../../management/server.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';

const mcpServer = String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
function send(m){process.stdout.write(JSON.stringify(m)+'\n')}
rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='server/discover')send({jsonrpc:'2.0',id:m.id,result:{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}}}});
else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{resultType:'complete',tools:[{name:'write_file',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}}},annotations:{readOnlyHint:true}}]}});
else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{resultType:'complete',content:[{type:'text',text:'private-mcp-result'}],structuredContent:{received:m.params.arguments}}})});
`;

const acpServer = String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
function send(m){process.stdout.write(JSON.stringify(m)+'\n')}
rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'runtime-fixture-session'}});
else if(m.method==='session/prompt'){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'private-acp-result'}}}});send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})}});
`;

test('authenticated management API configures, confirms, persists, and forgets production ACP/MCP work', async t => {
  const f = await fixture(t);
  const uiRoot = join(f.c.projectRoot, 'ui'); await mkdir(uiRoot, { recursive: true });
  const memoryStore = new SqliteMemoryStore({ filename: f.c.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const packs = await CharacterPackStore.open(memoryStore);
  const pairing = productionPairing('companion', 'companion-default');
  const timeline = new UnifiedTimelineService(memoryStore.rawDatabaseForKnowledge(), packs);
  const eventHub = new CompanionEventHub();
  eventHub.subscribeDomain(['work'], envelope => { timeline.recordEventSync(envelope); }, pairing);
  const profileFile = join(f.c.projectRoot, '.local/data/work-protocol-profiles.json');
  const journalFile = join(f.c.projectRoot, '.local/data/work-protocol.sqlite');
  let service = await WorkProtocolRuntime.open({ profileFile, journalFile, eventHub, pairing, characterPacks: packs });
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const memory: ManagementMemoryPort = {
    characters: () => [], list(query) { return { ...query, revision: 0, records: [], total: 0 }; },
    edit() { throw new Error('unused'); }, context() { throw new Error('unused'); }, prompt() { throw new Error('unused'); }, savePrompt() { throw new Error('unused'); },
  };
  let server = await startManagementServer({ uiRoot, settings, memory, workProtocol: service,
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: runtime.modules(), events: [], settings: settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  const headers = { Authorization: `Bearer ${server.token}`, Origin: server.origin, 'Content-Type': 'application/json' };
  const call = (path: string, method = 'GET', value?: unknown) => fetch(server.origin + path, { method, headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  try {
    assert.equal((await call('/api/work-protocol')).status, 200);
    const saved = await call('/api/work-protocol/profiles', 'PUT', { expectedRevision: 0, profiles: {
      acp: { executorId: 'fixture-acp', label: 'ACP fixture', command: process.execPath, args: ['-e', acpServer], cwd: process.cwd(), env: { PRIVATE_FIXTURE_KEY: 'secret-profile-value' }, requestTimeoutMs: 5000 },
      mcp: { executorId: 'fixture-mcp', label: 'MCP fixture', command: process.execPath, args: ['-e', mcpServer], cwd: process.cwd(), requestTimeoutMs: 5000,
        trustedToolPolicies: { write_file: { readOnly: false, requiredGrant: 'file:write' } } },
    } });
    assert.equal(saved.status, 200);
    const publicSnapshot = await (await call('/api/work-protocol')).text();
    assert.equal(publicSnapshot.includes('secret-profile-value'), false, 'profile secrets never return through management API');
    assert.match(publicSnapshot, /PRIVATE_FIXTURE_KEY/);
    const tools = await (await call('/api/work-protocol/tools')).json() as { tools: { name: string; readOnly: boolean; requiredGrant?: string }[] };
    assert.deepEqual(tools.tools.map(({ name, readOnly, requiredGrant }) => ({ name, readOnly, requiredGrant })),
      [{ name: 'write_file', readOnly: false, requiredGrant: 'file:write' }], 'remote read-only annotations do not override local trust policy');

    const acpPrepared = await call('/api/work-protocol/prepare', 'POST', { protocol: 'acp', executorId: 'fixture-acp',
      target: { title: 'Private ACP project', directory: process.cwd() }, instruction: 'private-acp-instruction', permissionGrant: [] });
    assert.equal(acpPrepared.status, 200);
    const acp = (await acpPrepared.json() as { request: { operationId: string; revision: number } }).request;
    const revised = await call('/api/work-protocol/revise', 'POST', { operationId: acp.operationId, expectedRevision: acp.revision,
      updates: { instruction: 'private-acp-instruction-v2' } });
    assert.equal(revised.status, 200);
    assert.equal((await call('/api/work-protocol/confirm', 'POST', { operationId: acp.operationId, expectedRevision: acp.revision })).status, 409,
      'old confirmation revision is rejected by the real HTTP route');
    const acpReceipt = await call('/api/work-protocol/confirm', 'POST', { operationId: acp.operationId, expectedRevision: 2 });
    assert.equal(acpReceipt.status, 200);
    assert.equal(((await acpReceipt.json()) as { receipt: { status: string; summary: string } }).receipt.status, 'succeeded');

    const mcpPrepared = await call('/api/work-protocol/prepare', 'POST', { protocol: 'mcp', executorId: 'fixture-mcp',
      target: { title: 'Private MCP action' }, instruction: 'Write the reviewed content',
      toolCall: { name: 'write_file', arguments: { path: 'private-path', content: 'private-mcp-content' } }, permissionGrant: ['file:write'] });
    const mcpPreparedText = await mcpPrepared.text();
    assert.equal(mcpPrepared.status, 200, mcpPreparedText);
    const mcp = (JSON.parse(mcpPreparedText) as { request: { operationId: string; revision: number } }).request;
    const mcpReceipt = await call('/api/work-protocol/confirm', 'POST', { operationId: mcp.operationId, expectedRevision: mcp.revision });
    assert.equal(mcpReceipt.status, 200);
    assert.equal(((await mcpReceipt.json()) as { receipt: { status: string } }).receipt.status, 'succeeded');
    assert.equal((await timeline.queryTimeline({ pairing, domains: ['work'] })).items.length, 2);

    const stalePreparedResponse = await call('/api/work-protocol/prepare', 'POST', { protocol: 'acp', executorId: 'fixture-acp',
      target: { title: 'Must not run after reconfiguration' }, instruction: 'stale profile instruction', permissionGrant: [] });
    assert.equal(stalePreparedResponse.status, 200);
    const stalePrepared = (await stalePreparedResponse.json() as { request: { operationId: string; revision: number } }).request;
    const reconfigured = await call('/api/work-protocol/profiles', 'PUT', { expectedRevision: 1, profiles: {
      acp: { executorId: 'fixture-acp', label: 'ACP fixture updated', command: process.execPath, args: ['-e', acpServer], cwd: process.cwd(), requestTimeoutMs: 5000 },
      mcp: { executorId: 'fixture-mcp', label: 'MCP fixture', command: process.execPath, args: ['-e', mcpServer], cwd: process.cwd(), requestTimeoutMs: 5000,
        trustedToolPolicies: { write_file: { readOnly: false, requiredGrant: 'file:write' } } },
    } });
    assert.equal(reconfigured.status, 200);
    assert.equal((await call('/api/work-protocol/confirm', 'POST', { operationId: stalePrepared.operationId, expectedRevision: stalePrepared.revision })).status, 409,
      'a prepared request cannot silently switch to a newer executable profile');

    for (const operationId of [acp.operationId, mcp.operationId, stalePrepared.operationId]) {
      const forgottenResponse = await call('/api/work-protocol/forget', 'POST', { operationId });
      const forgottenText = await forgottenResponse.text();
      assert.equal(forgottenResponse.status, 200, forgottenText);
      const raw = memoryStore.rawDatabaseForKnowledge().prepare('SELECT title,instruction,result_summary FROM work_timeline_events WHERE source_id=?').get(operationId) as { title: string; instruction: string; result_summary: string } | undefined;
      if (raw) assert.deepEqual(raw, { title: '已遗忘的工作任务', instruction: '', result_summary: '' }, 'source revocation scrubs the existing Timeline projection');
    }
    assert.equal((await timeline.queryTimeline({ pairing, domains: ['work'] })).items.length, 0);
    const forgottenState = service.snapshot().requests;
    assert.ok(forgottenState.every(row => row.forgotten && row.request.instruction === '已按要求遗忘。'));
    assert.equal(JSON.stringify(forgottenState).includes('private-mcp-content'), false);
    const forgottenConfirm = await call('/api/work-protocol/confirm', 'POST', { operationId: mcp.operationId, expectedRevision: 1 });
    const forgottenConfirmText = await forgottenConfirm.text();
    assert.equal(forgottenConfirm.status, 409, forgottenConfirmText);

    // Simulate a crash after the durable journal tombstone but before source revocation,
    // with an outbox acknowledgement also lost after the original projection.
    const crashWindowResponse = await call('/api/work-protocol/prepare', 'POST', { protocol: 'acp', executorId: 'fixture-acp',
      target: { title: 'Crash-window private title' }, instruction: 'crash-window-private-instruction', permissionGrant: [] });
    assert.equal(crashWindowResponse.status, 200);
    const crashWindow = (await crashWindowResponse.json() as { request: { operationId: string; revision: number } }).request;
    const crashWindowReceipt = await call('/api/work-protocol/confirm', 'POST', { operationId: crashWindow.operationId, expectedRevision: crashWindow.revision });
    assert.equal(crashWindowReceipt.status, 200);
    assert.equal((await timeline.queryTimeline({ pairing, domains: ['work'] })).items.length, 1);

    const storedProfile = await readFile(profileFile, 'utf8');
    assert.match(storedProfile, /secret-profile-value/);
    await server.close(); await service.close();

    const crashJournal = new SqliteWorkProtocolJournal(journalFile);
    crashJournal.forget(crashWindow.operationId, pairing);
    crashJournal.close();
    const beforeRecovery = memoryStore.rawDatabaseForKnowledge().prepare('SELECT title,instruction,result_summary FROM work_timeline_events WHERE source_id=?')
      .get(crashWindow.operationId) as { title: string; instruction: string; result_summary: string };
    assert.equal(beforeRecovery.instruction, 'crash-window-private-instruction', 'test reproduces the gap before timeline revocation commits');
    const crashAckDb = new Database(journalFile);
    crashAckDb.prepare('UPDATE protocol_operations SET event_published=0 WHERE operation_id=?').run(crashWindow.operationId);
    crashAckDb.close();

    service = await WorkProtocolRuntime.open({ profileFile, journalFile, eventHub, pairing, characterPacks: packs });
    const afterRecovery = memoryStore.rawDatabaseForKnowledge().prepare('SELECT title,instruction,result_summary FROM work_timeline_events WHERE source_id=?')
      .get(crashWindow.operationId) as { title: string; instruction: string; result_summary: string };
    assert.deepEqual(afterRecovery, { title: '已遗忘的工作任务', instruction: '', result_summary: '' },
      'recovery applies the forget tombstone before replaying a pending timeline outbox item');
    assert.equal(service.snapshot().requests.find(row => row.request.operationId === crashWindow.operationId)?.eventPublished, true,
      'the scrubbed outbox replay is acknowledged after restart');
    assert.equal((await timeline.queryTimeline({ pairing, domains: ['work'] })).items.length, 0);
    server = await startManagementServer({ uiRoot, settings, memory, workProtocol: service,
      snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: runtime.modules(), events: [], settings: settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
    const reopenedHeaders = { Authorization: `Bearer ${server.token}`, Origin: server.origin, 'Content-Type': 'application/json' };
    const reopened = await fetch(server.origin + '/api/work-protocol', { headers: reopenedHeaders });
    const reopenedText = await reopened.text();
    assert.equal(reopened.status, 200);
    assert.equal(reopenedText.includes('secret-profile-value'), false);
    assert.equal(reopenedText.includes('private-mcp-content'), false);
    assert.equal(JSON.stringify(service.snapshot().requests.map(row => row.receipt)).includes('private-mcp-result'), false);
  } finally {
    await server.close().catch(() => {});
    await service.close().catch(() => {});
    await settings.close();
    memoryStore.close();
  }
});
