import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, cp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fixture } from './helpers.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteManagementMemoryPort } from '../../memory/management-port.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { CharacterPackStore } from '../../memory/character-pack-store.js';
import { productionPairing } from '../../contracts/character-pack.js';
import { restrictPrivatePathSync } from '../../core/platform-files.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { startRuntimeManagement } from '../../management/bootstrap.js';
import { lifecycle } from '../memory/lifecycle-fixture.js';
import { scope, seed, NOW } from '../memory/sqlite-fixture.js';
import { ForwardReceipts } from '../../harness/receipts.js';

const runtimeAcpFixture = String.raw`
require('node:fs').appendFileSync(process.env.RUNTIME_MARKER,'started\n');
const rl=require('node:readline').createInterface({input:process.stdin});
function send(m){process.stdout.write(JSON.stringify(m)+'\n')}
rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'trial-backend-acp-session'}});
else if(m.method==='session/prompt'){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'trial-backend ACP fixture completed'}}}});send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})}});
`;

const runtimeMcpFixture = String.raw`
const fs=require('node:fs');fs.appendFileSync(process.env.RUNTIME_MARKER,'started\n');
const rl=require('node:readline').createInterface({input:process.stdin});
function send(m){process.stdout.write(JSON.stringify(m)+'\n')}
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='server/discover')send({jsonrpc:'2.0',id:m.id,result:{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}}}});
else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{resultType:'complete',tools:[{name:'write_fixture',description:'write reviewed fixture',inputSchema:{type:'object',properties:{value:{type:'string'}}},annotations:{readOnlyHint:true}}]}});
else if(m.method==='tools/call'){fs.appendFileSync(process.env.CALL_MARKER,JSON.stringify(m.params.arguments)+'\\n');send({jsonrpc:'2.0',id:m.id,result:{resultType:'complete',content:[{type:'text',text:'trial-backend MCP fixture completed'}],structuredContent:{received:m.params.arguments}}})}
});
`;

test('actual HTTP management edits the injected SQLite store, invalidates context and survives reopen without provider calls', async t => {
  const f = await fixture(t);
  const uiRoot = join(f.c.projectRoot, 'code/desktop-pet/management/ui'); await mkdir(uiRoot, { recursive: true });
  const assets = ['index.html', 'app.mjs', 'api.mjs', 'dom.mjs', 'views.mjs', 'style.css'];
  for (const asset of assets) await copyFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../management/ui', asset), join(uiRoot, asset));
  let store = new SqliteMemoryStore({ filename: f.c.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => NOW });
  t.after(() => store.close());
  seed(store);
  for (const kind of ['summary', 'keyword_index', 'vector_index', 'context_cache'] as const)
    store.recordDerived(scope(), { id: kind, kind, text: '海风公司旧派生', sourceIds: ['job'], createdAt: NOW });
  let providerCalls = 0;
  const memory = lifecycle(store, async () => { providerCalls++; throw new Error('No management provider call'); },
    async () => { providerCalls++; throw new Error('No management provider call'); });
  const port = new SqliteManagementMemoryPort(store, memory), runtime = new ManagementRuntime(f.c.sourceRevision);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const server = await startRuntimeManagement(f.c, f.configFile, settings, runtime, port);
  t.after(() => server.close().catch(() => {}));
  const headers = { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json' };
  const get = (path: string) => fetch(server.origin + path, { headers });
  for (const asset of assets) {
    const result = await get('/' + asset); assert.equal(result.status, 200);
    assert.equal(await result.text(), await readFile(join(uiRoot, asset), 'utf8'));
  }
  const revisionBeforeReads = store.revision(scope());
  for (const path of ['/api/snapshot', '/api/prompt?characterId=companion', '/api/records?characterId=companion&kind=memory', '/api/context?characterId=companion&query=工作'])
    assert.equal((await get(path)).status, 200);
  assert.equal(store.revision(scope()), revisionBeforeReads); assert.equal(providerCalls, 0);
  const oldContext = await memory.context(scope(), '工作', null, new AbortController().signal);
  const edit = { characterId: 'companion', id: 'job', expectedVersion: 1, operationId: 'web-edit', text: '现在在山川公司工作', reason: 'synthetic user edit' };
  const postEdit = (data: typeof edit) => fetch(server.origin + '/api/records/edit', { method: 'POST', headers, body: JSON.stringify(data) });
  const response = await postEdit(edit); assert.equal(response.status, 200);
  const saved = await response.json() as { record: { version: number; origin: string }; invalidatedIds: string[] };
  assert.equal(saved.record.version, 2); assert.equal(saved.record.origin, 'manual');
  assert.ok(['summary', 'keyword_index', 'vector_index', 'context_cache'].every(id => saved.invalidatedIds.includes(id)));
  assert.equal(store.search(scope(), '山川公司', 10)[0]!.id, 'job');
  assert.equal(store.search(scope(), '海风公司', 10).length, 0);
  assert.throws(() => memory.assertContextCurrent(oldContext), /stale_context/);
  assert.equal((await postEdit({ ...edit, operationId: 'stale-tab' })).status, 409);
  assert.equal((await postEdit(edit)).status, 200);
  const context = await (await get('/api/context?characterId=companion&query=山川公司')).json() as { memories: { text: string; origin: string }[] };
  assert.equal(context.memories[0]!.text, edit.text); assert.equal(context.memories[0]!.origin, 'manual');
  assert.equal((await get('/api/context?characterId=sweetheart&query=海风公司')).status,400);
  assert.throws(()=>store.search(scope('sweetheart'),'海风公司',10),/unknown_character/);
  const prompt = await (await get('/api/prompt?characterId=companion')).json() as { revision: number };
  const body = JSON.stringify({ characterId: 'companion', expectedRevision: prompt.revision, text: '人工设置的角色提示', operationId: 'prompt-web-edit' });
  assert.equal((await fetch(server.origin + '/api/prompt', { method: 'PUT', headers, body })).status, 200);
  assert.equal((await fetch(server.origin + '/api/prompt', { method: 'PUT', headers, body: JSON.stringify({ characterId: 'companion', expectedRevision: prompt.revision, text: 'stale', operationId: 'prompt-stale' }) })).status, 409);
  assert.equal((await port.context('companion', '')).prompt, '人工设置的角色提示');
  const descriptor = JSON.parse(await readFile(join(f.c.projectRoot, 'management-session.json'), 'utf8'));
  assert.equal(descriptor.instanceId, runtime.instanceId); assert.equal(descriptor.pid, process.pid);
  await server.close();
  await assert.rejects(readFile(join(f.c.projectRoot, 'management-session.json')), /ENOENT/);
  store.close();
  store = new SqliteMemoryStore({ filename: f.c.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => NOW });
  const reopened = new SqliteManagementMemoryPort(store, lifecycle(store));
  assert.equal((await reopened.context('companion', '山川公司')).memories[0]!.text, edit.text);
  assert.equal(reopened.prompt('companion').text, '人工设置的角色提示'); assert.equal(providerCalls, 0);
  // FIX61-10: t.after hooks run in registration order — the fixture rm (registered first) runs before
  // these closes, and on Windows it deletes an open SQLite file (EBUSY). Close explicitly here; the
  // after-hooks remain for the failure paths and are idempotent.
  await server.close(); store.close();
  (reopened as unknown as { store: { close(): void } }).store.close();
});

test('actual trial backend process recovers, queries and forgets Unified Timeline across restarts', { timeout: 600_000 }, async t => {
  const children: { child: ReturnType<typeof spawn>; exited: Promise<number | null> }[] = [];
  // Register before fixture cleanup so every backend is stopped before its project directory,
  // SQLite files, and node_modules junction are removed on Windows.
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode !== null) continue;
      child.stdin?.end();
      const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>(done => setTimeout(() => done(false), 3000))]);
      if (!graceful && child.exitCode === null) {
        child.kill();
        await Promise.race([exited.then(() => true), new Promise<boolean>(done => setTimeout(() => done(false), 3000))]);
      }
      if (child.exitCode === null) { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
    }
  });
  const f = await fixture(t), source = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), project = join(f.c.projectRoot, 'code/desktop-pet');
  const credentialFile = join(tmpdir(), `timeline-runtime-${process.pid}-${Date.now()}.key`);
  await writeFile(credentialFile, 'sk-test-only-no-network-call', { mode: 0o600 });
  restrictPrivatePathSync(credentialFile);
  t.after(() => rm(credentialFile, { force: true }));
  const turnId = 'runtime-timeline-turn', sessionId = 'runtime-timeline-session', userText = '我喜欢合成红茶';
  const occurredAt = new Date().toISOString();
  const seededStore = new SqliteMemoryStore({ filename: f.c.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const turnScope = { characterId: 'companion' as const, sessionId, turnId, generation: 1 };
  seededStore.append(turnScope, [
    { characterId: 'companion', id: `${turnId}:user`, role: 'user', text: userText, createdAt: occurredAt },
    { characterId: 'companion', id: `${turnId}:assistant`, role: 'assistant', text: '收到，我会记住这条合成对话。', createdAt: occurredAt },
  ]);
  seededStore.apply({ scope: turnScope, operationId: 'runtime-timeline-memory', reason: 'synthetic timeline integration fixture', createdAt: occurredAt,
    operation: { type: 'add', id: 'runtime-timeline-memory', text: userText, sourceIds: [`${turnId}:user`] } });
  seededStore.invitations.register(turnScope, { id: 'runtime-voice-invitation', eventId: 'runtime-timeline-memory',
    text: '愿意聊聊刚才提到的红茶吗？', gesture: 'wave', eligibleAt: occurredAt,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  assert.equal(seededStore.invitations.showNext(turnScope)?.status, 'shown', 'the process fixture starts with one explicitly shown persisted invitation');
  const seededPacks = await CharacterPackStore.open(seededStore);
  const canonSource = await seededPacks.importSource('companion', {
    sourceName: 'runtime-canon-fixture.txt',
    text: '沈砚在临海城经营一间旧书店。',
  });
  const canonDraft = await seededPacks.saveDraft({
    characterId: 'companion',
    payload: {
      schemaVersion: '0.7-draft-1',
      character: { name: '沈砚', soul: '重诺守信的观察者' },
      canonFacts: [{ id: 'runtime-canon-fact', text: '沈砚在临海城经营一间旧书店。', status: 'explicit', evidenceIds: [canonSource.snapshot.blocks[0]!.id] }],
      gaps: [],
    },
    sourceIds: [canonSource.snapshot.id],
    validation: { valid: true, errors: [], validatedAt: occurredAt },
  });
  const activeCanonPack = await seededPacks.activateDraft({
    characterId: 'companion', draftId: canonDraft.id, userId: 'local-user', instanceId: 'companion-default', packVersion: 'runtime-test-v1',
  });
  seededPacks.stageCompanionProjection({ pairing: productionPairing('companion', 'companion-default'), sessionId, turnId, createdAt: occurredAt });
  seededStore.close();
  await mkdir(project, { recursive: true });
  await cp(join(source, 'dist'), join(project, 'dist'), { recursive: true });
  await cp(join(source, 'management/ui'), join(project, 'management/ui'), { recursive: true });
  await cp(join(source, 'desktop/assets/local-model'), join(project, 'desktop/assets/local-model'), { recursive: true });
  await cp(join(source, 'desktop/vendor/cubism'), join(project, 'desktop/vendor/cubism'), { recursive: true });
  // Isolated runtime fixture reuses installed dependencies; no native process/device is launched.
  // FIX61-10: 'junction' needs no administrator/Developer-Mode privilege on Windows (a plain symlink
  // fails with EPERM there) and behaves like a directory symlink for the spawned backend.
  await symlink(join(source, 'node_modules'), join(project, 'node_modules'), 'junction');
  await writeFile(join(project, 'package.json'), '{"type":"module"}');
  const hash = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
  const runtimeFiles: Record<string, string> = {};
  for (const path of Object.keys(f.c.runtimeFiles)) {
    const destination = join(f.c.projectRoot, path); await mkdir(dirname(destination), { recursive: true });
    // FIX61-10: the electron-host runtime files live outside dist/ and must be copied too.
    await copyFile(join(source, path.slice('code/desktop-pet/'.length)), destination);
    runtimeFiles[path] = hash(await readFile(destination));
  }
  const config = { ...f.c, models: Object.fromEntries(Object.entries(f.c.models).map(([operation, model]) => [operation, { ...model, credentialFile }])) as typeof f.c.models, runtimeFiles };
  const activeConfig = JSON.stringify(config);
  await writeFile(f.configFile, activeConfig);
  await writeFile(f.activationFile, JSON.stringify({ version: 1, status: 'active', phaseId: config.phaseId, configSha256: hash(activeConfig) }));
  const providerStub = join(f.c.projectRoot, 'trial-provider-stub.mjs');
  await writeFile(providerStub, [
    "const wav = Buffer.alloc(44 + 480);",
    "wav.write('RIFF',0); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVE',8); wav.write('fmt ',12); wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22); wav.writeUInt32LE(24000,24); wav.writeUInt32LE(48000,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(wav.length-44,40);",
    "globalThis.fetch = async (input, init = {}) => {",
    "  if (String(input).endsWith('/timeline-test-audio.wav')) return new Response(wav, {status:200, headers:{'content-type':'audio/wav'}});",
    "  const request = JSON.parse(String(init.body ?? '{}'));",
    "  if (request.input && typeof request.input.text === 'string') return new Response(JSON.stringify({output:{audio:{url:'https://dashscope.aliyuncs.com/timeline-test-audio.wav'}}}), {status:200,headers:{'content-type':'application/json'}});",
    "  const system = String(request.messages?.[0]?.content ?? ''), user = String(request.messages?.[1]?.content ?? '');",
    "  let content;",
    "  if (system.includes('Classify the memory action requested by the CURRENT user turn')) { const value=JSON.parse(user); content={scope:value.hostScope,request:'none',reason:'ordinary synthetic conversation'}; }",
    "  else if (system.includes('Classify ONLY the current utterance')) content={kind:'companion',question:''};",
    "  else if (system.includes('Decide whether the current turn can be answered independently')) { const value=JSON.parse(user); content={scope:value.hostScope,decision:'independent',reason:'self-contained synthetic conversation'}; }",
    "  else if (system.includes('You decide memory semantics for one character')) content={request:'none',erase:[],facts:[],assessments:[],reason:'no durable fact change requested',unresolved:null};",
    "  else content={text:'自动化对话已写入统一时间线。',expression:{emotion:'warm',intensity:0.2,delivery:'自然温和',gesture:null}};",
    "  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}), {status:200,headers:{'content-type':'application/json'}});",
    "};",
  ].join('\n'));
  const workReceipts = new ForwardReceipts(join(f.c.projectRoot, '.local/data/harness-relay.sqlite'));
  const preparedWorkReceipt = workReceipts.create({ text: 'isolated persisted work receipt', plan: { title: 'Synthetic work timeline fixture', reason: 'isolated runtime projection test' } });
  const confirmedWorkReceipt = workReceipts.mutate(preparedWorkReceipt.id, row => {
    row.executor = 'harness'; row.confirmedAt = new Date().toISOString(); row.phase = 'completed'; row.nativeStatus = 'completed';
  });
  workReceipts.close();
  const descriptor = join(f.c.projectRoot, 'management-session.json');
  const start = async () => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(providerStub).href, join(project, 'dist/app/trial-backend.js')], { env: { ...process.env, PET_TRIAL_CONFIG: f.configFile, PET_TRIAL_ACTIVATION: f.activationFile }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', stdout = ''; child.stderr.on('data', chunk => { stderr += String(chunk); }); child.stdout.on('data', chunk => { stdout += String(chunk); });
    const exited = new Promise<number | null>(done => child.once('exit', done));
    children.push({ child, exited });
    // The isolated fixture boots the complete production composition root and can take
    // longer than a module server when the Windows runner is under CPU/disk pressure.
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      try {
        const session = JSON.parse(await readFile(descriptor, 'utf8'));
        if (session.pid === child.pid) {
          const url = new URL(session.url), headers = { Authorization: 'Bearer ' + url.hash.slice(7), Origin: url.origin, 'Content-Type': 'application/json' };
          return { child, exited, url, headers, messages: () => stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)) };
        }
      } catch {}
      if (child.exitCode !== null) throw new Error('Isolated backend failed: ' + stderr);
      await new Promise(done => setTimeout(done, 20));
    }
    throw new Error(`Isolated backend did not publish its descriptor; stderr=${stderr}; stdout=${stdout}`);
  };
  const first = await start();
  const initial = first.messages();
  // FIX61-10: startup progress records precede backend_ready; presentation_policy and a final
  // progress record follow it. Assert the real production ordering instead of an unreachable
  // "ready is last": ready exists, is preceded only by startup progress, and policy arrives after.
  assert.equal(initial[0].channel, 'backend_startup');
  assert.ok(initial.some(m => m.channel === 'backend_ready'), 'backend_ready must be present');
  assert.ok(initial.findIndex(m => m.channel === 'backend_ready') < initial.findIndex(m => m.channel === 'presentation_policy'),
    'only startup progress may precede backend_ready: ' + JSON.stringify(initial.map(m => m.channel)));
  const startupInvitation = initial.find(m => m.channel === 'event' && m.event?.type === 'invitation');
  assert.equal(startupInvitation?.channel === 'event' && startupInvitation.event.type === 'invitation'
    ? startupInvitation.event.invitation.id : undefined, 'runtime-voice-invitation',
  'the production process must restore a still-shown persisted invitation to the desktop');
  // FIX61-10: the enabled-count depends on the licensed model's preset catalog (built via
  // configure-model + manual mapping on the licensed machine). This machine's catalog is the
  // un-mapped placeholder (single unavailable item), so pin the MECHANISM, not the licensed count:
  // the backend publishes the store's own default-enabled set before any edit.
  const initialPolicy = initial.find(m => m.channel === 'presentation_policy')!.policy;
  assert.ok(Array.isArray(initialPolicy.enabledIds));
  assert.equal((await fetch(first.url.origin + '/api/unified-timeline?domains=companion')).status, 401,
    'the production timeline query requires the management session token');
  const proactivePath = '/api/proactive/policy';
  const proactivePairing = productionPairing('companion', 'companion-default');
  assert.equal((await fetch(first.url.origin + proactivePath, { method: 'POST', headers: first.headers,
    body: JSON.stringify({ pairing: proactivePairing }) })).status, 200);
  const proactiveInitial = await (await fetch(first.url.origin + proactivePath, { method: 'POST', headers: first.headers,
    body: JSON.stringify({ pairing: proactivePairing }) })).json() as { policy: {
      revision: number; enabled: boolean; dailyMax: number; minIntervalMs: number; timezone: string;
      dndStartHour: number; dndEndHour: number; sourceKinds: ['continuity_fact'];
    } };
  assert.equal(proactiveInitial.policy.enabled, false, 'the formal process keeps proactive invitations off by default');
  const proactiveEnabled = await fetch(first.url.origin + proactivePath, { method: 'PUT', headers: first.headers,
    body: JSON.stringify({ pairing: proactivePairing, expectedRevision: proactiveInitial.policy.revision,
      policy: { ...proactiveInitial.policy, enabled: true, dndStartHour: 0, dndEndHour: 0 } }) });
  assert.equal(proactiveEnabled.status, 200, 'the authenticated management API can explicitly opt in');
  const proactiveSaved = await proactiveEnabled.json() as { policy: { revision: number; enabled: boolean } };
  assert.equal(proactiveSaved.policy.enabled, true);
  assert.equal(proactiveSaved.policy.revision, proactiveInitial.policy.revision + 1);
  const rejectedSource = await fetch(first.url.origin + proactivePath, { method: 'PUT', headers: first.headers,
    body: JSON.stringify({ pairing: proactivePairing, expectedRevision: proactiveSaved.policy.revision,
      policy: { ...proactiveInitial.policy, enabled: true, sourceKinds: ['observation'] } }) });
  assert.equal(rejectedSource.status, 400, 'unsupported sources cannot be enabled through the production API');
  const timelinePath = '/api/unified-timeline?domains=companion&limit=20';
  const timelineBeforeRestart = await fetch(first.url.origin + timelinePath, { headers: first.headers });
  assert.equal(timelineBeforeRestart.status, 200);
  const firstTimeline = await timelineBeforeRestart.json() as { items: { eventId: string; sourceRef: { id: string }; companionDetails?: { userText: string; assistantText: string } }[] };
  assert.equal(firstTimeline.items.length, 1, 'startup drains the durable History projection outbox into Unified Timeline');
  assert.equal(firstTimeline.items[0]!.eventId, `cte-turn-${turnId}`);
  assert.equal(firstTimeline.items[0]!.sourceRef.id, `history:${turnId}:user`, 'the timeline links to the exact source message');
  assert.equal(firstTimeline.items[0]!.companionDetails?.userText, userText);
  assert.equal(firstTimeline.items[0]!.companionDetails?.assistantText, '收到，我会记住这条合成对话。');
  const canonPath = '/api/unified-timeline?domains=canon&limit=20';
  const canonResponse = await fetch(first.url.origin + canonPath, { headers: first.headers });
  assert.equal(canonResponse.status, 200);
  const canonTimeline = await canonResponse.json() as { items: { eventId: string; domain: string; summary: string; canonDetails?: { awareness: string } }[] };
  assert.deepEqual(canonTimeline.items.map(item => ({ eventId: item.eventId, domain: item.domain, summary: item.summary, awareness: item.canonDetails?.awareness })), [
    { eventId: 'ce-runtime-canon-fact', domain: 'canon', summary: '沈砚在临海城经营一间旧书店。', awareness: 'experienced' },
  ], 'the production query reads the active Canon pack for the fixed pairing');
  const workPath = '/api/unified-timeline?domains=work&limit=20';
  const workTimelineResponse = await fetch(first.url.origin + workPath, { headers: first.headers });
  assert.equal(workTimelineResponse.status, 200);
  const workTimeline = await workTimelineResponse.json() as { items: { eventId: string; workDetails?: { executorId: string; status: string; targetTitle: string } }[] };
  assert.equal(workTimeline.items.length, 1, 'the formal Work receipt store is projected into the Work-only view');
  assert.equal(workTimeline.items[0]!.eventId, `work-receipt-${preparedWorkReceipt.id}-v${confirmedWorkReceipt.version}`);
  assert.deepEqual(workTimeline.items[0]!.workDetails, { executorId: 'harness', status: 'succeeded', targetTitle: 'Synthetic work timeline fixture', instruction: '' });

  const acpMarker = join(f.c.projectRoot, 'trial-acp-started.log');
  const mcpMarker = join(f.c.projectRoot, 'trial-mcp-started.log');
  const mcpCallMarker = join(f.c.projectRoot, 'trial-mcp-call.log');
  const saveProtocol = await fetch(first.url.origin + '/api/work-protocol/profiles', { method: 'PUT', headers: first.headers,
    body: JSON.stringify({ expectedRevision: 0, profiles: {
      acp: { executorId: 'trial-acp-fixture', label: 'trial process fixture', command: process.execPath,
        args: ['-e', runtimeAcpFixture], cwd: project, env: { RUNTIME_MARKER: acpMarker }, requestTimeoutMs: 5000 },
      mcp: { executorId: 'trial-mcp-fixture', label: 'trial tool fixture', command: process.execPath,
        args: ['-e', runtimeMcpFixture], cwd: project, env: { RUNTIME_MARKER: mcpMarker, CALL_MARKER: mcpCallMarker }, requestTimeoutMs: 5000,
        trustedToolPolicies: { write_fixture: { readOnly: false, requiredGrant: 'fixture:write' } } },
    } }) });
  assert.equal(saveProtocol.status, 200);
  await assert.rejects(readFile(acpMarker), /ENOENT/, 'saving an executor profile does not launch an external process');
  await assert.rejects(readFile(mcpMarker), /ENOENT/, 'saving an MCP profile does not launch an external process');
  const discoveredToolsResponse = await fetch(first.url.origin + '/api/work-protocol/tools', { headers: first.headers });
  assert.equal(discoveredToolsResponse.status, 200);
  const discoveredTools = await discoveredToolsResponse.json() as { tools: { name: string; readOnly: boolean; requiredGrant?: string }[] };
  assert.deepEqual(discoveredTools.tools.map(({ name, readOnly, requiredGrant }) => ({ name, readOnly, requiredGrant })),
    [{ name: 'write_fixture', readOnly: false, requiredGrant: 'fixture:write' }],
    'the production composition root applies its local MCP trust policy instead of the remote readOnlyHint');
  assert.equal((await readFile(mcpMarker, 'utf8')).trim(), 'started', 'MCP metadata discovery starts its configured stdio service');
  await assert.rejects(readFile(mcpCallMarker), /ENOENT/, 'tool discovery does not invoke the tool');
  const prepareAcp = await fetch(first.url.origin + '/api/work-protocol/prepare', { method: 'POST', headers: first.headers,
    body: JSON.stringify({ protocol: 'acp', executorId: 'trial-acp-fixture', target: { title: 'Production composition fixture' },
      instruction: 'run only after explicit confirmation', permissionGrant: [] }) });
  assert.equal(prepareAcp.status, 200);
  const preparedAcp = (await prepareAcp.json()) as { request: { operationId: string; revision: number } };
  const confirmAcp = await fetch(first.url.origin + '/api/work-protocol/confirm', { method: 'POST', headers: first.headers,
    body: JSON.stringify({ operationId: preparedAcp.request.operationId, expectedRevision: preparedAcp.request.revision }) });
  assert.equal(confirmAcp.status, 200);
  assert.equal(((await confirmAcp.json()) as { receipt: { status: string; summary?: string } }).receipt.status, 'succeeded');
  assert.equal((await readFile(acpMarker, 'utf8')).trim().split('\n').length, 1, 'the confirmed ACP action launches one stdio process');
  const acpTimeline = await (await fetch(first.url.origin + workPath, { headers: first.headers })).json() as {
    items: { eventId: string; sourceRef: { id: string }; workDetails?: { status: string; resultSummary?: string } }[] };
  const acpTimelineItem = acpTimeline.items.find(item => item.sourceRef.id === preparedAcp.request.operationId);
  assert.equal(acpTimelineItem?.workDetails?.status, 'succeeded', 'the actual trial-backend runtime projects the ACP receipt to the authenticated Work timeline');
  assert.equal(acpTimelineItem?.workDetails?.resultSummary, 'trial-backend ACP fixture completed');
  const prepareMcp = await fetch(first.url.origin + '/api/work-protocol/prepare', { method: 'POST', headers: first.headers,
    body: JSON.stringify({ protocol: 'mcp', executorId: 'trial-mcp-fixture', target: { title: 'Production MCP fixture' },
      instruction: 'write the reviewed fixture value', toolCall: { name: 'write_fixture', arguments: { value: 'approved-value' } },
      permissionGrant: ['fixture:write'] }) });
  assert.equal(prepareMcp.status, 200);
  const preparedMcp = await prepareMcp.json() as { request: { operationId: string; revision: number } };
  const confirmMcp = await fetch(first.url.origin + '/api/work-protocol/confirm', { method: 'POST', headers: first.headers,
    body: JSON.stringify({ operationId: preparedMcp.request.operationId, expectedRevision: preparedMcp.request.revision }) });
  assert.equal(confirmMcp.status, 200);
  assert.equal((await confirmMcp.json() as { receipt: { status: string } }).receipt.status, 'succeeded');
  assert.match(await readFile(mcpCallMarker, 'utf8'), /approved-value/, 'the explicitly granted confirmed MCP tool receives the reviewed arguments');
  const mcpTimeline = await (await fetch(first.url.origin + workPath, { headers: first.headers })).json() as {
    items: { eventId: string; sourceRef: { id: string }; workDetails?: { status: string; resultSummary?: string } }[] };
  const mcpTimelineItem = mcpTimeline.items.find(item => item.sourceRef.id === preparedMcp.request.operationId);
  assert.equal(mcpTimelineItem?.workDetails?.status, 'succeeded');
  assert.match(mcpTimelineItem?.workDetails?.resultSummary ?? '', /trial-backend MCP fixture completed/);

  first.child.stdin.write(JSON.stringify({ channel: 'command', command: { type: 'click_invitation', invitationId: 'runtime-voice-invitation' } }) + '\n');
  const invitationControls = new Set<string>();
  let invitationCaptureStarted = false;
  let invitationVoiceTurn = false;
  let acceptedInvitationTimelineItem: { eventId: string; type: string; sourceRef: { id: string; version: number }; companionDetails?: unknown;
    companionActivityDetails?: { invitationId: string; actionKind: string; status: string } } | undefined;
  const invitationDeadline = Date.now() + 15000;
  while (Date.now() < invitationDeadline) {
    for (const message of first.messages()) {
      if (message.channel === 'capture_start') invitationCaptureStarted = true;
      if (message.channel === 'event' && message.event?.type === 'turn' && message.event.input?.kind === 'voice') invitationVoiceTurn = true;
      if (['capture_start', 'capture_stop', 'stop'].includes(message.channel) && typeof message.requestId === 'string' && !invitationControls.has(message.requestId)) {
        invitationControls.add(message.requestId);
        first.child.stdin.write(JSON.stringify({ channel: 'ack', requestId: message.requestId }) + '\n');
      }
    }
    const acceptedResponse = await fetch(first.url.origin + timelinePath, { headers: first.headers });
    const acceptedTimeline = await acceptedResponse.json() as { items: typeof firstTimeline.items };
    acceptedInvitationTimelineItem = acceptedTimeline.items.find(item => item.eventId === 'invitation-accepted-runtime-voice-invitation') as typeof acceptedInvitationTimelineItem;
    if (invitationCaptureStarted && invitationVoiceTurn && acceptedInvitationTimelineItem) break;
    await new Promise(done => setTimeout(done, 40));
  }
  assert.ok(invitationVoiceTurn, 'an explicit invitation click must enter the existing voice TurnScope');
  assert.ok(invitationCaptureStarted, 'only the explicit click enters the microphone capture authorization path');
  assert.equal(acceptedInvitationTimelineItem?.type, 'companion.invitation.accepted');
  assert.equal(acceptedInvitationTimelineItem?.companionDetails, undefined, 'an invitation audit must not be projected as conversation text');
  assert.deepEqual(acceptedInvitationTimelineItem?.companionActivityDetails,
    { invitationId: 'runtime-voice-invitation', actionKind: 'voice_start', status: 'accepted' });
  assert.deepEqual(acceptedInvitationTimelineItem?.sourceRef, { id: 'runtime-timeline-memory', version: 1 });
  first.child.stdin.write(JSON.stringify({ channel: 'command', command: { type: 'cancel' } }) + '\n');
  const cancelDeadline = Date.now() + 10000;
  let invitationCaptureStopped = false;
  while (Date.now() < cancelDeadline && !invitationCaptureStopped) {
    for (const message of first.messages()) {
      if (message.channel === 'capture_stop') invitationCaptureStopped = true;
      if (['capture_start', 'capture_stop', 'stop'].includes(message.channel) && typeof message.requestId === 'string' && !invitationControls.has(message.requestId)) {
        invitationControls.add(message.requestId);
        first.child.stdin.write(JSON.stringify({ channel: 'ack', requestId: message.requestId }) + '\n');
      }
    }
    if (!invitationCaptureStopped) await new Promise(done => setTimeout(done, 40));
  }
  assert.ok(invitationCaptureStopped, 'cancel must stop capture through the same runtime and device bridge');

  const liveText = '请把这条合成消息也写入正式时间线';
  first.child.stdin.write(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: liveText } }) + '\n');
  const acknowledgedPlayback = new Set<string>();
  let timelineAfterConversation: typeof firstTimeline | undefined;
  const conversationDeadline = Date.now() + 30000;
  while (Date.now() < conversationDeadline) {
    for (const raw of first.messages()) {
      if (raw.channel !== 'play') continue;
      const playback = raw as { channel: 'play'; requestId: string; tts: { scope: { characterId: string; sessionId: string; turnId: string; generation: number }; audio: { id: string } } };
      if (acknowledgedPlayback.has(playback.requestId)) continue;
      acknowledgedPlayback.add(playback.requestId);
      const event = (type: 'started' | 'ended') => ({ channel: 'playback', requestId: playback.requestId,
        event: { type, scope: playback.tts.scope, at: new Date().toISOString(), ...(type === 'started' ? { audioId: playback.tts.audio.id } : {}) } });
      first.child.stdin.write(JSON.stringify(event('started')) + '\n');
      first.child.stdin.write(JSON.stringify(event('ended')) + '\n');
    }
    const response = await fetch(first.url.origin + timelinePath, { headers: first.headers });
    assert.equal(response.status, 200);
    const result = await response.json() as typeof firstTimeline;
    if (result.items.some(item => item.companionDetails?.userText === liveText)) { timelineAfterConversation = result; break; }
    await new Promise(done => setTimeout(done, 50));
  }
  assert.ok(timelineAfterConversation, 'a real submit_text turn through BackendSession is projected by the production saved-conversation hook; backend messages: ' + JSON.stringify(first.messages()));
  assert.equal(timelineAfterConversation.items.length, 3);
  const liveItem = timelineAfterConversation.items.find(item => item.companionDetails?.userText === liveText)!;
  const liveTurnId = liveItem.sourceRef.id.replace(/^history:/, '').replace(/:user$/, '');
  assert.ok(liveTurnId && liveTurnId !== liveItem.sourceRef.id);
  let liveReply = first.messages().find(message => message.channel === 'event' && message.event?.type === 'reply'
    && message.event.reply?.scope?.turnId === liveTurnId);
  const replyDeadline = Date.now() + 5000;
  while (!liveReply && Date.now() < replyDeadline) {
    await new Promise(done => setTimeout(done, 20));
    liveReply = first.messages().find(message => message.channel === 'event' && message.event?.type === 'reply'
      && message.event.reply?.scope?.turnId === liveTurnId);
  }
  const tracesResponse = await fetch(first.url.origin + '/api/traces?limit=100', { headers: first.headers });
  const traces = tracesResponse.ok ? await tracesResponse.json() as { traces: { turnId: string; status: string; stages: unknown[] }[] } : { traces: [] };
  assert.ok(liveReply, 'the submitted turn did not emit a reply event for ' + liveTurnId + '; backend messages: '
    + JSON.stringify(first.messages()) + '; turn trace: ' + JSON.stringify(traces.traces.find(trace => trace.turnId === liveTurnId)));
  assert.equal(liveReply.event.reply?.scope?.turnId, liveTurnId, 'the projected source points back to the actual submitted turn');
  const presentationResponse = await fetch(first.url.origin + '/api/presentation', { headers: first.headers });
  const presentation = await presentationResponse.json() as { catalog: { modelId: string }; policy: { revision: number } };
  const policySaved = await fetch(first.url.origin + '/api/presentation', { method: 'PUT', headers: first.headers,
    body: JSON.stringify({ modelId: presentation.catalog.modelId, expectedRevision: presentation.policy.revision, enabledIds: [] }) });
  assert.equal(policySaved.status, 200);
  await new Promise(done => setTimeout(done, 20));
  assert.deepEqual(first.messages().filter(m => m.channel === 'presentation_policy').at(-1).policy.enabledIds, []);
  const snapshot = await (await fetch(first.url.origin + '/api/snapshot', { headers: first.headers })).json() as { runtime: { pid: number }; settings: { saved: import('../../contracts/management.js').ManagedSettings; revision: number; effectiveRevision: number } };
  assert.equal(snapshot.runtime.pid, first.child.pid);
  snapshot.settings.saved.context.maxRecentMessages = 7; snapshot.settings.saved.providers.tts.voice = 'Serena';
  const result = await fetch(first.url.origin + '/api/settings', { method: 'PUT', headers: first.headers, body: JSON.stringify({ expectedRevision: 0, settings: snapshot.settings.saved }) });
  assert.equal(result.status, 200);
  const saved = await result.json() as { pending: boolean; effectiveRevision: number }; assert.equal(saved.pending, true); assert.equal(saved.effectiveRevision, 0);
  first.child.stdin.end(); assert.equal(await first.exited, 0); await assert.rejects(readFile(descriptor), /ENOENT/);
  const recoveredInvitationStore = new SqliteMemoryStore({ filename: config.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  assert.equal(recoveredInvitationStore.invitations.inspect(turnScope, 'runtime-voice-invitation')?.status, 'clicked',
    'the explicit acceptance state survives a full backend process restart');
  const restoredPolicy = recoveredInvitationStore.invitations.policy();
  recoveredInvitationStore.invitations.configure({ ...restoredPolicy, minIntervalMs: 0 });
  recoveredInvitationStore.invitations.register(turnScope, { id: 'runtime-restart-invitation', eventId: 'runtime-timeline-memory',
    text: '重启后继续这段尚未处理的邀请？', gesture: 'wave', eligibleAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  assert.equal(recoveredInvitationStore.invitations.showNext(turnScope)?.id, 'runtime-restart-invitation');
  recoveredInvitationStore.invitations.configure(restoredPolicy);
  recoveredInvitationStore.close();
  const second = await start();
  const proactiveAfterRestart = await (await fetch(second.url.origin + proactivePath, { method: 'POST', headers: second.headers,
    body: JSON.stringify({ pairing: proactivePairing }) })).json() as { policy: { enabled: boolean; revision: number } };
  assert.equal(proactiveAfterRestart.policy.enabled, true, 'the opted-in policy survives a real trial-backend process restart');
  assert.equal(proactiveAfterRestart.policy.revision, proactiveSaved.policy.revision);
  const resumedInvitation = second.messages().find(m => m.channel === 'event' && m.event?.type === 'invitation');
  assert.equal(resumedInvitation?.channel === 'event' && resumedInvitation.event.type === 'invitation'
    ? resumedInvitation.event.invitation.id : undefined, 'runtime-restart-invitation',
  'a shown invitation from the previous backend lifetime is restored exactly through the production startup path');
  assert.deepEqual(second.messages().find(m => m.channel === 'presentation_policy').policy.enabledIds, []);
  assert.equal(second.messages().find(m => m.channel === 'presentation_policy').policy.revision, 1);
  const next = await (await fetch(second.url.origin + '/api/snapshot', { headers: second.headers })).json() as { settings: { effective: import('../../contracts/management.js').ManagedSettings; pending: boolean; effectiveRevision: number } };
  assert.equal(next.settings.pending, false); assert.equal(next.settings.effectiveRevision, 1);
  assert.equal(next.settings.effective.providers.tts.voice, 'Serena'); assert.equal(next.settings.effective.context.maxRecentMessages, 7);
  const timelineAfterRestart = await fetch(second.url.origin + timelinePath, { headers: second.headers });
  assert.equal(timelineAfterRestart.status, 200);
  assert.equal((await timelineAfterRestart.json() as { items: unknown[] }).items.length, 3,
    'the startup-recovered event, accepted invitation activity, and submitted conversation remain queryable after a full backend process restart');
  const acpSnapshot = await (await fetch(second.url.origin + '/api/work-protocol', { headers: second.headers })).json() as {
    requests: { request: { operationId: string }; receipt?: { status: string } }[] };
  assert.equal(acpSnapshot.requests.find(row => row.request.operationId === preparedAcp.request.operationId)?.receipt?.status, 'succeeded',
    'the real composition root restores protocol request and receipt state from its private journal');
  assert.equal(acpSnapshot.requests.find(row => row.request.operationId === preparedMcp.request.operationId)?.receipt?.status, 'succeeded');
  const repeatedAcpConfirm = await fetch(second.url.origin + '/api/work-protocol/confirm', { method: 'POST', headers: second.headers,
    body: JSON.stringify({ operationId: preparedAcp.request.operationId, expectedRevision: preparedAcp.request.revision }) });
  assert.equal(repeatedAcpConfirm.status, 200, 'a repeated confirmation after process restart returns the durable receipt');
  assert.equal((await readFile(acpMarker, 'utf8')).trim().split('\n').length, 1, 'restart and repeated confirmation do not re-run the executor');
  const repeatedMcpConfirm = await fetch(second.url.origin + '/api/work-protocol/confirm', { method: 'POST', headers: second.headers,
    body: JSON.stringify({ operationId: preparedMcp.request.operationId, expectedRevision: preparedMcp.request.revision }) });
  assert.equal(repeatedMcpConfirm.status, 200);
  assert.equal((await readFile(mcpMarker, 'utf8')).trim().split('\n').length, 1, 'repeated confirmation does not relaunch MCP after restart');
  assert.equal((await readFile(mcpCallMarker, 'utf8')).trim().split('\n').length, 1, 'repeated confirmation does not re-run the MCP tool');
  second.child.stdin.write(JSON.stringify({ channel: 'command', command: { type: 'ignore_invitation', invitationId: 'runtime-restart-invitation' } }) + '\n');
  let dismissalTimeline: { items: { eventId: string; type: string; companionActivityDetails?: { invitationId: string; status: string } }[] } | undefined;
  const dismissalDeadline = Date.now() + 10000;
  while (Date.now() < dismissalDeadline) {
    const response = await fetch(second.url.origin + timelinePath, { headers: second.headers });
    dismissalTimeline = await response.json() as typeof dismissalTimeline;
    if (dismissalTimeline?.items.some(item => item.eventId === 'invitation-dismissed-runtime-restart-invitation')) break;
    await new Promise(done => setTimeout(done, 40));
  }
  const dismissal = dismissalTimeline?.items.find(item => item.eventId === 'invitation-dismissed-runtime-restart-invitation');
  assert.equal(dismissal?.type, 'companion.invitation.dismissed', 'the production ignore command writes an independent activity event');
  assert.deepEqual(dismissal?.companionActivityDetails, { invitationId: 'runtime-restart-invitation', actionKind: 'voice_start', status: 'dismissed' });
  second.child.stdin.end(); assert.equal(await second.exited, 0);
  const third = await start();
  const dismissalAfterRestart = await fetch(third.url.origin + timelinePath, { headers: third.headers });
  assert.equal(dismissalAfterRestart.status, 200);
  const dismissalRecovered = (await dismissalAfterRestart.json() as typeof dismissalTimeline)?.items
    .find(item => item.eventId === 'invitation-dismissed-runtime-restart-invitation');
  assert.equal(dismissalRecovered?.type, 'companion.invitation.dismissed', 'the dismissed activity survives a full backend restart');
  assert.deepEqual(dismissalRecovered?.companionActivityDetails, { invitationId: 'runtime-restart-invitation', actionKind: 'voice_start', status: 'dismissed' });
  const canonAfterRestart = await fetch(third.url.origin + canonPath, { headers: third.headers });
  assert.equal(canonAfterRestart.status, 200);
  assert.deepEqual((await canonAfterRestart.json() as typeof canonTimeline).items.map(item => item.eventId), [
    ...activeCanonPack.canonTimeline.map(item => item.eventId),
  ], 'the active Canon pack remains available to the production query after a full process restart');
  const workTimelineAfterRestart = await fetch(third.url.origin + workPath, { headers: third.headers });
  assert.equal(workTimelineAfterRestart.status, 200);
  const recoveredWork = await workTimelineAfterRestart.json() as { items: { eventId: string; sourceRef: { id: string } }[] };
  assert.deepEqual(recoveredWork.items.map(item => item.eventId).sort(), [
    `work-receipt-${preparedWorkReceipt.id}-v${confirmedWorkReceipt.version}`,
    acpTimelineItem!.eventId,
    mcpTimelineItem!.eventId,
  ].sort(), 'startup replay of the durable Harness, ACP, and MCP receipts is idempotent across process restart');
  const actualTurn = first.messages().find(message => message.channel === 'event' && message.event?.type === 'turn'
    && message.event.input?.scope?.turnId === liveTurnId) as { event: { input: { scope: import('../../contracts/index.js').TurnScope } } } | undefined;
  assert.ok(actualTurn, 'the projected turn can be correlated to the command scope');
  const liveForgetScope = actualTurn.event.input.scope;
  const liveStore = new SqliteMemoryStore({ filename: config.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  liveStore.apply({ scope: liveForgetScope, operationId: 'runtime-live-memory-add', reason: 'synthetic forget linkage', createdAt: new Date().toISOString(),
    operation: { type: 'add', id: 'runtime-live-memory', text: liveText, sourceIds: [`${liveTurnId}:user`] } });
  const liveForgetRecord = liveStore.inspect(liveForgetScope, 'runtime-live-memory');
  assert.ok(liveForgetRecord);
  const liveForgetResult = liveStore.apply({ scope: liveForgetScope, operationId: 'runtime-live-forget', reason: 'synthetic exact-source forgetting', createdAt: new Date().toISOString(),
    operation: { type: 'soft_delete', id: liveForgetRecord.id, expectedVersion: liveForgetRecord.version } }, [`${liveTurnId}:user`]);
  assert.equal(liveForgetResult.status, 'applied');
  liveStore.close();
  const afterLiveForget = await (await fetch(third.url.origin + timelinePath, { headers: third.headers })).json() as { items: { companionDetails?: { userText: string } }[] };
  assert.equal(afterLiveForget.items.length, 3);
  assert.ok(afterLiveForget.items.some(item => item.companionDetails?.userText === userText),
    'forgetting the actual submitted turn removes only that History-linked timeline event');
  const forget = await fetch(third.url.origin + '/api/memory/forget', { method: 'POST', headers: third.headers,
    body: JSON.stringify({ characterId: 'companion', id: 'runtime-timeline-memory', expectedVersion: 1,
      operationId: 'runtime-timeline-forget', reason: 'forget the synthetic timeline fixture' }) });
  assert.equal(forget.status, 200, await forget.text());
  assert.equal((await (await fetch(third.url.origin + timelinePath, { headers: third.headers })).json() as { items: unknown[] }).items.length, 0,
    'forgetting the invitation source also hides its activity and the linked History event from the production query');
  const forgetAcp = await fetch(third.url.origin + '/api/work-protocol/forget', { method: 'POST', headers: third.headers,
    body: JSON.stringify({ operationId: preparedAcp.request.operationId }) });
  assert.equal(forgetAcp.status, 200, await forgetAcp.text());
  const forgetMcp = await fetch(third.url.origin + '/api/work-protocol/forget', { method: 'POST', headers: third.headers,
    body: JSON.stringify({ operationId: preparedMcp.request.operationId }) });
  assert.equal(forgetMcp.status, 200, await forgetMcp.text());
  const workAfterAcpForget = await (await fetch(third.url.origin + workPath, { headers: third.headers })).json() as { items: { sourceRef: { id: string } }[] };
  assert.deepEqual(workAfterAcpForget.items.map(item => item.sourceRef.id), [`work-request:${preparedWorkReceipt.id}`],
    'work forget revokes its source and removes only the ACP operation from the formal Timeline query');
  const forgottenConfirm = await fetch(third.url.origin + '/api/work-protocol/confirm', { method: 'POST', headers: third.headers,
    body: JSON.stringify({ operationId: preparedAcp.request.operationId, expectedRevision: preparedAcp.request.revision }) });
  assert.equal(forgottenConfirm.status, 409, 'the forgotten ACP operation cannot be re-dispatched');
  third.child.stdin.end(); assert.equal(await third.exited, 0);
  // Earlier invitation fixtures belong to the previous local day, so this final process can
  // exercise a proactive delivery without changing the shared production quota rules.
  const quotaResetStore = new SqliteMemoryStore({ filename: config.database, retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  quotaResetStore.rawDatabaseForKnowledge().prepare('UPDATE invitation_deliveries SET shown_ms=?').run(Date.now() - 36 * 60 * 60 * 1000);
  quotaResetStore.close();
  const fourth = await start();
  assert.equal((await (await fetch(fourth.url.origin + timelinePath, { headers: fourth.headers })).json() as { items: unknown[] }).items.length, 0,
    'a later process restart must not revive forgotten timeline content');
  const forgottenAcpAfterRestart = await (await fetch(fourth.url.origin + '/api/work-protocol', { headers: fourth.headers })).json() as {
    requests: { forgotten: boolean; request: { operationId: string; instruction: string } }[] };
  const forgottenAcpState = forgottenAcpAfterRestart.requests.find(row => row.request.operationId === preparedAcp.request.operationId);
  assert.equal(forgottenAcpState?.forgotten, true);
  assert.equal(forgottenAcpState?.request.instruction, '已按要求遗忘。');
  assert.equal(forgottenAcpAfterRestart.requests.find(row => row.request.operationId === preparedMcp.request.operationId)?.forgotten, true);
  const workAfterRestartForget = await (await fetch(fourth.url.origin + workPath, { headers: fourth.headers })).json() as { items: { sourceRef: { id: string } }[] };
  assert.deepEqual(workAfterRestartForget.items.map(item => item.sourceRef.id), [`work-request:${preparedWorkReceipt.id}`],
    'a new production process keeps the forgotten ACP source hidden from Timeline');

  // End-to-end continuity → proactive invitation path in the real trial-backend composition root.
  const proactiveSourceText = '我喜欢画画。';
  fourth.child.stdin.write(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: proactiveSourceText } }) + '\n');
  const proactivePlaybackAcks = new Set<string>();
  let proactiveSource: { sourceRef: { id: string }; companionDetails?: { userText: string } } | undefined;
  const proactiveSourceDeadline = Date.now() + 30000;
  while (Date.now() < proactiveSourceDeadline && !proactiveSource) {
    for (const message of fourth.messages()) {
      if (message.channel !== 'play' || proactivePlaybackAcks.has(message.requestId)) continue;
      proactivePlaybackAcks.add(message.requestId);
      const event = (type: 'started' | 'ended') => ({ channel: 'playback', requestId: message.requestId,
        event: { type, scope: message.tts.scope, at: new Date().toISOString(), ...(type === 'started' ? { audioId: message.tts.audio.id } : {}) } });
      fourth.child.stdin.write(JSON.stringify(event('started')) + '\n');
      fourth.child.stdin.write(JSON.stringify(event('ended')) + '\n');
    }
    const rows = await (await fetch(fourth.url.origin + timelinePath, { headers: fourth.headers })).json() as {
      items: { sourceRef: { id: string }; companionDetails?: { userText: string } }[] };
    proactiveSource = rows.items.find(item => item.companionDetails?.userText === proactiveSourceText);
    if (!proactiveSource) await new Promise(done => setTimeout(done, 50));
  }
  assert.ok(proactiveSource, 'the source for the invitation must be an actually saved user message');
  assert.match(proactiveSource.sourceRef.id, /^history:.+:user$/);
  let recordedCandidate: { id: string; version: number; status: string; kind: string; text: string; sourceIds: string[] } | undefined;
  const candidateDeadline = Date.now() + 10000;
  while (Date.now() < candidateDeadline && !recordedCandidate) {
    const candidateSnapshot = await fetch(fourth.url.origin + '/api/continuity/snapshot', { method: 'POST', headers: fourth.headers,
      body: JSON.stringify({ pairing: proactivePairing, includeCandidates: true }) });
    assert.equal(candidateSnapshot.status, 200);
    const value = await candidateSnapshot.json() as { candidates: { id: string; version: number; status: string; kind: string;
      text: string; sourceIds: string[] }[] };
    recordedCandidate = value.candidates.find(candidate => candidate?.text === proactiveSourceText
      && candidate.sourceIds.includes(proactiveSource!.sourceRef.id));
    if (!recordedCandidate) await new Promise(done => setTimeout(done, 50));
  }
  assert.ok(recordedCandidate, 'the production conversation candidate writer extracts a source-linked candidate');
  assert.equal(recordedCandidate.kind, 'fact');
  assert.equal(recordedCandidate.status, 'candidate', 'a saved message creates a candidate, never an automatically active fact');
  const idlePresence = JSON.stringify({ channel: 'presence', isTyping: false, isSpeaking: false, isTurnActive: false, isWorkPendingConfirmation: false }) + '\n';
  fourth.child.stdin.write(idlePresence);
  await new Promise(done => setTimeout(done, 250));
  assert.equal(fourth.messages().some(message => message.channel === 'event' && message.event?.type === 'invitation'
    && message.event.invitation?.sourceKind === 'continuity_fact'), false, 'unpromoted facts cannot produce invitations');
  const promotedResponse = await fetch(fourth.url.origin + '/api/continuity/promote', { method: 'POST', headers: fourth.headers,
    body: JSON.stringify({ pairing: proactivePairing, operationId: 'trial-proactive-promote', targetId: recordedCandidate.id,
      expectedVersion: recordedCandidate.version }) });
  assert.equal(promotedResponse.status, 200);
  const promoted = await promotedResponse.json() as { fact: { id: string; version: number; status: string } };
  assert.equal(promoted.fact.status, 'active');

  let proactiveInvitation: { id: string; eventId: string; sourceKind?: string; sourceVersion?: number; actionKind?: string;
    responseText?: string; text: string; status: string } | undefined;
  const proactiveDeliveryDeadline = Date.now() + 45000;
  while (Date.now() < proactiveDeliveryDeadline && !proactiveInvitation) {
    fourth.child.stdin.write(idlePresence);
    proactiveInvitation = fourth.messages().find(message => message.channel === 'event' && message.event?.type === 'invitation'
      && message.event.invitation?.sourceKind === 'continuity_fact')?.event.invitation;
    if (!proactiveInvitation) await new Promise(done => setTimeout(done, 500));
  }
  assert.ok(proactiveInvitation, 'an active fact reaches the durable candidate, idle arbiter and desktop invitation path');
  assert.equal(proactiveInvitation.eventId, promoted.fact.id);
  assert.equal(proactiveInvitation.sourceVersion, promoted.fact.version);
  assert.equal(proactiveInvitation.actionKind, 'text');
  assert.equal(proactiveInvitation.status, 'shown');
  assert.equal(proactiveInvitation.text, '想继续聊聊你之前整理的一个重要节点吗？');
  assert.equal(proactiveInvitation.responseText, '我想继续聊聊之前整理的重要节点。');
  assert.ok(!JSON.stringify(proactiveInvitation).includes('下周绘画计划'), 'invitation and response do not reveal the saved fact text');

  const captureStartsBeforeTextAcceptance = fourth.messages().filter(message => message.channel === 'capture_start').length;
  fourth.child.stdin.write(JSON.stringify({ channel: 'command', command: { type: 'click_invitation', invitationId: proactiveInvitation.id } }) + '\n');
  let proactiveTextTurn = false, proactiveAcceptedActivity = false;
  const acceptanceDeadline = Date.now() + 15000;
  while (Date.now() < acceptanceDeadline && !(proactiveTextTurn && proactiveAcceptedActivity)) {
    proactiveTextTurn ||= fourth.messages().some(message => message.channel === 'event' && message.event?.type === 'turn'
      && message.event.input?.kind === 'text' && message.event.input?.text === proactiveInvitation!.responseText);
    const activityTimeline = await (await fetch(fourth.url.origin + timelinePath, { headers: fourth.headers })).json() as {
      items: { type: string; sourceRef: { id: string }; companionActivityDetails?: { actionKind: string; status: string; sourceKind?: string } }[] };
    proactiveAcceptedActivity = activityTimeline.items.some(item => item.type === 'companion.invitation.accepted'
      && item.sourceRef.id === promoted.fact.id && item.companionActivityDetails?.actionKind === 'text'
      && item.companionActivityDetails.status === 'accepted' && item.companionActivityDetails.sourceKind === 'continuity_fact');
    if (!(proactiveTextTurn && proactiveAcceptedActivity)) await new Promise(done => setTimeout(done, 50));
  }
  assert.ok(proactiveTextTurn, 'explicit acceptance enters the ordinary text TurnScope');
  assert.ok(proactiveAcceptedActivity, 'acceptance is projected with its real continuity source');
  assert.equal(fourth.messages().filter(message => message.channel === 'capture_start').length, captureStartsBeforeTextAcceptance,
    'text acceptance never starts microphone capture');
  const forgottenProactiveSource = await fetch(fourth.url.origin + '/api/continuity/forget', { method: 'POST', headers: fourth.headers,
    body: JSON.stringify({ pairing: proactivePairing, operationId: 'trial-proactive-forget', targetId: promoted.fact.id,
      expectedVersion: promoted.fact.version, reason: 'automated source-forgetting propagation' }) });
  assert.equal(forgottenProactiveSource.status, 200);
  const afterProactiveForget = await (await fetch(fourth.url.origin + timelinePath, { headers: fourth.headers })).json() as {
    items: { sourceRef: { id: string }; type: string }[] };
  assert.equal(afterProactiveForget.items.some(item => item.sourceRef.id === promoted.fact.id
    && item.type.startsWith('companion.invitation.')), false, 'source forgetting hides presentation and acceptance audits from future queries');

  fourth.child.stdin.end(); assert.equal(await fourth.exited, 0);
  assert.equal(await readFile(f.configFile, 'utf8'), activeConfig);
});
