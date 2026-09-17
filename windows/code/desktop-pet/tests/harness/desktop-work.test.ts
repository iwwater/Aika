import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { ForwardReceipts } from '../../harness/receipts.js';
import { HarnessForwarding } from '../../harness/forwarding.js';
import { DesktopWork } from '../../harness/desktop-work.js';
import type { WorkStatusNotice } from '../../core/work-speech.js';
import { SqliteProjectIndex } from '../../projects/sqlite-project-index.js';
import { DesktopRuntime, type RuntimePorts } from '../../core/desktop-runtime.js';
import { MemoryMediaStore } from '../../media/store.js';
import type { DesktopWorkState, WorkIntent, WorkContinuationIntent, WorkInputBinding, PendingWorkContext } from '../../contracts/desktop-work.js';
import type { DesktopEvent, TurnScope } from '../../contracts/index.js';
import { parseWorkAction } from '../../app/backend-session.js';

const scope: TurnScope = { characterId: 'companion', sessionId: 'session', turnId: 'turn', generation: 1 };
const tick = () => new Promise<void>(yes => setImmediate(yes));
async function fixture(t: TestContext, automatic=false, continuation=false) {
  const parent = resolve('../../.local/direct-forward-20/tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'work-')); const file = join(root, 'harness-relay.sqlite');
  const receipts = new ForwardReceipts(file), projects = new SqliteProjectIndex(join(root, 'project-index.sqlite'));
  const task = randomUUID(), turn = randomUUID(), states: DesktopWorkState[] = [], notices: WorkStatusNotice[] = [];
  const observation = { executor: 'codex' as 'codex'|'harness', nativePrompts:0, nativeCompleted:false, prompts: 0, sends: 0, completed: false, owner: true, intent: { kind: 'work' } as WorkIntent, continuation: {kind:'confirm'} as WorkContinuationIntent, receiptReason:undefined as undefined|'interrupted'|'continued_elsewhere', plans:0, contexts:[] as PendingWorkContext[], interpretWait:undefined as undefined|(()=>Promise<void>), ownerWait:undefined as undefined|(()=>Promise<void>) };
  const forwarding = new HarnessForwarding({ receipts, projects, compatible: async () => true, presetReady: async () => true, presetId: 'desktop-pet-relay-v1', workspace: root,workPresetReady:async()=>true,
    nativeWork:{createWorkSession:async()=>{},submitWork:async()=>{observation.nativePrompts++;},workReceipt:async()=>({status:observation.nativeCompleted?'completed':'working',result:'native small task result'})},
    harness: { probe: async () => ({ state: 'ready', observedAt: 'now', codexDelivery: 'unverified' }), createRelaySession: async () => {}, submitConfirmedOperation: async () => { observation.prompts++; } },
    codex: { list: () => [{ threadId: task, hostId: 'local', title: 'Existing synthetic task', projectPath: root }],
      discover: async () => {await observation.ownerWait?.();return { available: observation.owner };}, send: async () => { observation.sends++; return { threadId: task, turnId: turn, requestId: randomUUID() }; },
      receipt: async () => ({ threadId: task, turnId: turn, status: observation.completed ? 'completed' : 'unknown', reply: 'Independent engineering output', ...(observation.receiptReason?{reason:observation.receiptReason}:{}) }) } });
  const work = new DesktopWork({ receipts, projects, forwarding, notify: notice => notices.push(notice), classify: async () => observation.intent,
    ...(continuation?{interpret:async (_s:TurnScope,_text:string,context:PendingWorkContext)=>{observation.contexts.push(context);await observation.interpretWait?.();return observation.continuation;}}:{}),
    ...(automatic?{plan:async (_s:TurnScope,text:string,catalog:import('../../contracts/desktop-work.js').WorkPlanCatalog)=>{observation.plans++;return {kind:'ready' as const,executor:observation.executor,title:'Prepared task',text:text.replace('um ','').trim(),reason:'Explicit executor',...(observation.executor==='codex'?{targetId:task}:{}),...(catalog.projects[0]?{projectId:catalog.projects[0].id,projectVersion:catalog.projects[0].version}:{})};}}:{}),emit: state => states.push(state) });
  await work.start(60000);
  t.after(async () => { await work.close(); await forwarding.close(); await projects.close(); await rm(root, { recursive: true, force: true }); });
  const choose = async () => { const draft = states.at(-1)?.draft; assert.ok(draft); await work.action({ type: 'select', draftId: draft.id, expectedVersion: draft.version, target: { hostId: 'local', threadId: task } }); const row = states.at(-1)?.confirmation; assert.ok(row); return row; };
  return { root, file, receipts, projects, forwarding, work, task, states, observation, choose, notices };
}
test('semantic work drafts and final confirmation stay isolated; duplicate confirmation/MCP cannot resend', async t => {
  const f = await fixture(t);
  await f.work.route(scope, 'Implement a synthetic login page', new AbortController().signal);
  assert.equal(f.observation.prompts, 0); assert.equal(f.receipts.list().length, 0); assert.equal(f.receipts.drafts().length, 1);
  const row = await f.choose();
  assert.equal(f.observation.prompts, 0);
  await Promise.all([f.work.action({ type: 'confirm', id: row.id, expectedVersion: row.version }), f.work.action({ type: 'confirm', id: row.id, expectedVersion: row.version })]);
  await Promise.all([f.forwarding.sendConfirmed(row.id), f.forwarding.sendConfirmed(row.id)]);
  assert.equal(f.observation.prompts, 0); assert.equal(f.observation.sends, 1); assert.equal(f.observation.sends, 1);
  f.observation.completed = true; await f.work.observe(); assert.equal(f.states.at(-1)?.focus, 'companion'); assert.equal(f.states.at(-1)?.stage, 'completed');
  await f.work.close();
  const reopened = new DesktopWork({ receipts: f.receipts, projects: f.projects, forwarding: f.forwarding, classify: async () => ({ kind: 'companion' }), emit: state => f.states.push(state) });
  await reopened.start(60000); await reopened.action({ type: 'confirm', id: row.id, expectedVersion: row.version }); await reopened.action({ type: 'refresh', id: row.id }); await reopened.close();
  assert.equal(f.observation.prompts, 0); assert.equal(f.observation.sends, 1); assert.equal(f.observation.sends, 1);
});
test('ordinary input/Space restores companion focus without cancelling work; completion needs exact receipt', async t => {
  const f = await fixture(t); await f.work.route(scope, 'Do concrete work', new AbortController().signal); const row = await f.choose();
  await f.work.action({ type: 'confirm', id: row.id, expectedVersion: row.version }); await f.forwarding.sendConfirmed(row.id);
  f.work.onInput(); f.observation.intent = { kind: 'companion' };
  assert.equal(await f.work.route({ ...scope, turnId: 'chat' }, 'Today coding was tiring', new AbortController().signal), 'companion');
  await f.work.observe(); assert.equal(f.states.at(-1)?.focus, 'companion'); assert.equal(f.receipts.get(row.id).phase, 'accepted');
  f.observation.completed = true; await f.work.observe();
  assert.equal(f.receipts.get(row.id).phase, 'completed'); assert.equal(f.states.at(-1)?.focus, 'companion'); assert.equal(f.states.at(-1)?.stage, 'completed');
  assert.equal(f.observation.sends, 1); assert.equal(f.observation.prompts, 0); assert.equal(f.observation.sends, 1);
});
test('dismissed or stale draft cannot be confirmed; missing owner stays before model prompt', async t => {
  const f = await fixture(t); await f.work.route(scope, 'Do work', new AbortController().signal); const row = await f.choose();
  f.observation.owner = false; await f.work.action({ type: 'confirm', id: row.id, expectedVersion: row.version });
  assert.equal(f.observation.prompts, 0); assert.equal(f.receipts.get(row.id).confirmedAt, undefined); assert.equal(f.states.at(-1)?.stage, 'confirming');
  await f.work.action({ type: 'dismiss' }); f.observation.owner = true;
  await f.work.action({ type: 'confirm', id: row.id, expectedVersion: row.version }); assert.equal(f.observation.prompts, 0);
});
test('late classifier result after cancellation creates no draft and does not change focus', async t => {
  const f = await fixture(t); await f.work.close();
  let release!: (v: WorkIntent) => void;
  const work = new DesktopWork({ receipts: f.receipts, projects: f.projects, forwarding: f.forwarding,
    classify: () => new Promise(resolve => { release = resolve; }), emit: state => f.states.push(state) });
  await work.start(60000); const signal = new AbortController();
  const run = work.route(scope, 'Late task', signal.signal); await tick(); signal.abort(); work.onInput(); release({ kind: 'work' });
  await assert.rejects(run); assert.equal(f.receipts.drafts().length, 0); assert.equal(f.states.at(-1)?.focus, 'companion'); await work.close();
});
for (const kind of ['text', 'voice'] as const) test(kind + ' routes before all companion append, context, maintenance and TTS; media cleans without fake playback', async t => {
  const f = await fixture(t), media = new MemoryMediaStore(), events: DesktopEvent[] = [], saved: string[] = [], order: string[] = [];
  const ports: RuntimePorts = {
    work: f.work, mediaStore: media, onInputRoute: (_scope, route) => order.push(route),
    capture: { start: async () => {}, stop: async () => {}, finish: async scope => ({ scope, audio: await media.put(scope, Uint8Array.of(1), 'audio/wav'), images: [], inputEndedAt: 'now', captureStoppedAt: 'now' }) },
    perception: { perceive: async input => ({ scope: input.scope, status: 'complete', transcript: 'Implement synthetic feature', modalities: [], cues: [] }) },
    memory: { append: async (_scope, rows) => { order.push('append'); saved.push(...rows.map(r => r.text)); }, maintain: async () => { throw Error('Work must not maintain'); },
      context: async scope => ({ scope, characterPrompt: 'Synthetic companion', recent: [], memories: [], summary: '', perception: null, inputTokenBudget: 1000 }) },
    dialogue: { reply: async request => ({ scope: request.scope, text: 'Normal companion reply', expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } }) },
    tts: { synthesize: async reply => ({ scope: reply.scope, expression: reply.expression, audio: await media.put(reply.scope, Uint8Array.of(1), 'audio/wav'), durationMs: 1, synchronization: 'amplitude' }) },
    playback: { stop: async () => {}, play: async (audio, emit) => { emit({ type: 'started', scope: audio.scope, at: 'now', audioId: audio.audio.id }); emit({ type: 'ended', scope: audio.scope, at: 'now' }); } },
  };
  const runtime = new DesktopRuntime(ports, e => events.push(e), () => order.push('maintenance'));
  await runtime.dispatch(kind === 'text' ? { type: 'submit_text', text: 'Implement synthetic feature' } : { type: 'start_voice' });
  if (kind === 'voice') await runtime.dispatch({ type: 'finish_voice' }); await runtime.drain();
  assert.deepEqual(saved, []); assert.deepEqual(order, ['work']); assert.equal(events.some(e => e.type === 'playback' || e.type === 'reply'), false); assert.equal(media.count, 0);
  f.observation.intent = { kind: 'companion' }; order.length = 0;
  await runtime.dispatch({ type: 'submit_text', text: 'I am tired today' }); await runtime.drain();
  assert.equal(order[0], 'companion'); assert.deepEqual(saved, ['I am tired today', 'Normal companion reply']); assert.equal(media.count, 0); await runtime.close();
});
test('version1 receipt migration preserves every confirmation and existing permissions; reopen is byte-stable', async t => {
  const f = await fixture(t); await f.work.close(); await f.forwarding.close();
  const db = new Database(f.file); db.exec('DROP TABLE work_drafts'); db.pragma('user_version=1');
  const payload = JSON.stringify({ id: randomUUID(), text: 'Original receipt sentinel', phase: 'unknown', custom: 'preserve' });
  db.prepare('INSERT INTO confirmations VALUES(?,?,?)').run('old', 'before', payload); db.close();
  const upgraded = new ForwardReceipts(f.file); upgraded.close();
  const check = new Database(f.file, { readonly: true }); assert.equal(check.pragma('user_version', { simple: true }), 2);
  assert.equal((check.prepare('SELECT payload FROM confirmations').get() as {payload:string}).payload, payload); check.close();
  const bytes = await readFile(f.file); const again = new ForwardReceipts(f.file); again.close(); assert.deepEqual(await readFile(f.file), bytes);
});
test('work action parser rejects forged targets, empty text and invalid versions', () => {
  assert.throws(() => parseWorkAction({ type: 'confirm', id: randomUUID(), expectedVersion: -1 }));
  assert.throws(() => parseWorkAction({ type: 'select', draftId: randomUUID(), expectedVersion: 1, target: { hostId: 'remote', threadId: randomUUID() } }));
  assert.throws(() => parseWorkAction({ type: 'revise', draftId: randomUUID(), expectedVersion: 1, text: '' }));
});

test('bounded observation rotates fairly across more than five active tasks and beyond the recent fifty display records', async t => {
  const f = await fixture(t); const pending: string[] = [];
  for (let n = 0; n < 60; n++) {
    const row = f.receipts.create({ text: 'Synthetic historical work ' + n, target: { hostId: 'local', threadId: f.task } });
    f.receipts.mutate(row.id, r => { r.phase = n < 6 ? 'accepted' : 'completed'; r.confirmedAt = 'now'; r.appTurnId = 'exact-' + n; });
    if (n < 6) pending.push(row.id);
  }
  const seen: string[] = [];
  const original = f.forwarding.refreshReceipt.bind(f.forwarding);
  f.forwarding.refreshReceipt = async id => { seen.push(id); return original(id); };
  f.observation.completed = true; await f.work.observe(); assert.equal(seen.length, 5);
  await f.work.observe(); assert.equal(seen.length, 6);
  assert.deepEqual(new Set(seen), new Set(pending));
  assert.ok(pending.every(id => f.receipts.get(id).phase === 'completed')); assert.equal(f.forwarding.pendingCount(), 0);
  assert.ok(f.states.at(-1)?.requests.some(row => pending.includes(row.id)));
  assert.equal(f.observation.prompts, 0); assert.equal(f.observation.sends, 0);
});
test('restored prepared card focuses as confirming and unchanged actions emit an acknowledgement state', async t => {
  const f = await fixture(t); await f.work.route(scope, 'Concrete work', new AbortController().signal); const request = await f.choose(); await f.work.close();
  const work = new DesktopWork({ receipts: f.receipts, projects: f.projects, forwarding: f.forwarding, classify: async () => ({ kind: 'companion' }), emit: state => f.states.push(state) });
  await work.start(60000); await work.action({ type: 'focus' }); assert.equal(f.states.at(-1)?.stage, 'confirming'); assert.equal(f.states.at(-1)?.confirmation?.id, request.id);
  const sequence = f.states.at(-1)!.sequence; await work.action({ type: 'refresh' }); assert.ok(f.states.at(-1)!.sequence > sequence); await work.close();
});

test('automatic card is complete without selection; editing replaces old confirmation atomically and never executes',async t=>{
 const f=await fixture(t,true);await f.work.route(scope,'um do synthetic work',new AbortController().signal);
 const state=f.states.at(-1)!;assert.equal(state.stage,'confirming');assert.ok(state.draft);assert.ok(state.confirmation);
 assert.equal(state.confirmation.text,'do synthetic work');assert.equal(state.confirmation.target?.title,'Existing synthetic task');assert.ok(state.confirmation.project);
 assert.equal(f.observation.prompts,0);const old=state.confirmation;
 await f.work.action({type:'reprepare',draftId:state.draft.id,expectedVersion:state.draft.version,text:'revised small task',executor:'harness',projectId:old.project!.id,projectVersion:old.project!.version});
 const current=f.states.at(-1)!;assert.equal(current.confirmation?.executor,'harness');assert.equal(current.confirmation?.target,undefined);
 assert.equal(f.receipts.get(old.id).phase,'unavailable');assert.equal(f.observation.prompts+f.observation.nativePrompts,0);
 await f.forwarding.confirm(old.id,old.version);assert.equal(f.observation.prompts,0);
 const fresh=current.confirmation!;await Promise.all([f.work.action({type:'confirm',id:fresh.id,expectedVersion:fresh.version}),f.work.action({type:'confirm',id:fresh.id,expectedVersion:fresh.version})]);
 assert.equal(f.observation.nativePrompts,1);assert.equal(f.observation.prompts,0);
 await assert.rejects(f.forwarding.sendConfirmed(fresh.id),{code:'forbidden'});
 f.work.onInput();f.observation.nativeCompleted=true;await f.work.observe();
 assert.equal(f.forwarding.record(fresh.id).phase,'completed');assert.equal(f.states.at(-1)?.focus,'companion');
});
test('invalid reprepare retains the exact old frozen card and stale edit cannot dispatch',async t=>{
 const f=await fixture(t,true);await f.work.route(scope,'task',new AbortController().signal);const before=f.states.at(-1)!;
 await f.work.action({type:'reprepare',draftId:before.draft!.id,expectedVersion:before.draft!.version,text:'bad',executor:'codex',target:{hostId:'local',threadId:randomUUID()}});
 assert.equal(f.states.at(-1)?.confirmation?.id,before.confirmation!.id);assert.equal(f.receipts.get(before.confirmation!.id).phase,'awaiting_confirmation');
 assert.equal(f.observation.nativePrompts+f.observation.prompts,0);
});

for (const outcome of ['ready', 'clarify', 'failure'] as const) test('restored invalid unsent card replans only on explicit action: ' + outcome, async t => {
  const f = await fixture(t); await f.work.route(scope, 'Original synthetic request', new AbortController().signal);
  const old = await f.choose();
  f.receipts.mutate(old.id, row => { row.target = { hostId: 'local', threadId: randomUUID() }; });
  const before = f.receipts.get(old.id); await f.work.close(); let plans = 0;
  const work = new DesktopWork({ receipts: f.receipts, projects: f.projects, forwarding: f.forwarding,
    classify: async () => ({ kind: 'companion' }), plan: async () => {
      plans++; if (outcome === 'failure') throw Error('Synthetic provider failure');
      return outcome === 'clarify' ? { kind: 'clarify', question: 'Which synthetic scope?' }
        : { kind: 'ready', executor: 'codex', title: 'Rebuilt task', text: 'Original synthetic request', reason: 'Verified actual target', targetId: f.task };
    }, emit: state => f.states.push(state) });
  await work.start(60000); await work.action({ type: 'focus' });
  assert.equal(plans, 0); assert.deepEqual(f.receipts.get(old.id), before);
  const d = f.states.at(-1)!.draft!;
  await work.action({ type: 'replan', draftId: d.id, expectedVersion: d.version, text: d.text });
  assert.equal(plans, 1); assert.equal(f.receipts.get(old.id).phase, 'unavailable');
  assert.equal(f.receipts.get(old.id).text, before.text); assert.deepEqual(f.receipts.get(old.id).target, before.target);
  assert.equal(f.receipts.get(old.id).confirmedAt, undefined);
  await work.action({ type: 'confirm', id: old.id, expectedVersion: before.version });
  assert.equal(f.observation.prompts + f.observation.nativePrompts + f.observation.sends, 0);
  if (outcome === 'ready') {
    const fresh = f.states.at(-1)!.confirmation!; assert.ok(fresh); assert.notEqual(fresh.id, old.id);
    assert.equal(fresh.target?.threadId, f.task);
    await work.action({ type: 'confirm', id: fresh.id, expectedVersion: fresh.version });
    assert.equal(f.observation.prompts, 0); assert.equal(f.observation.sends, 1);
  } else {
    assert.equal(f.receipts.draft(d.id).status, 'open'); assert.equal(f.states.at(-1)!.confirmation, undefined);
    assert.equal(f.receipts.draft(d.id).text, d.text);
  }
  await work.close();
});

test('replanning never changes confirmed, unknown, partially dispatched or stale cards', async t => {
  const f = await fixture(t);
  for (const risk of ['confirmed', 'unknown', 'dispatch', 'session', 'appTurn', 'stale'] as const) {
    const d = f.receipts.createDraft(scope, 'Synthetic guarded record');
    const row = f.receipts.prepareDraft(d.id, d.version, { text: d.text, target: { hostId: 'local', threadId: f.task } });
    f.receipts.mutate(row.id, r => {
      if (risk === 'confirmed') r.confirmedAt = 'now';
      if (risk === 'unknown') r.phase = 'unknown';
      if (risk === 'dispatch') r.dispatchAttempted = true;
      if (risk === 'session') r.harnessSessionId = 'synthetic-native-session';
      if (risk === 'appTurn') r.appTurnId = 'synthetic-app-turn';
    });
    const original = f.receipts.get(row.id), draft = f.receipts.draft(d.id);
    assert.throws(() => f.receipts.reopenDraft(d.id, risk === 'stale' ? d.version : draft.version, d.text));
    assert.deepEqual(f.receipts.get(row.id), original); assert.deepEqual(f.receipts.draft(d.id), draft);
  }
  assert.equal(f.observation.prompts + f.observation.nativePrompts + f.observation.sends, 0);
});

test('new raw input survives planning/edit/reopen and source recovery selects the exact operation',async t=>{
 const f=await fixture(t,true);await f.work.route(scope,'um first verbatim input',new AbortController().signal);
 const first=f.states.at(-1)!;assert.equal(first.confirmation!.text,'first verbatim input');assert.equal(first.sourceInput!.text,'um first verbatim input');assert.equal(first.sourceInput!.provenance,'original_input');
 assert.throws(()=>f.receipts.mutateDraft(first.draft!.id,first.draft!.version,row=>{row.originalText='overwrite';}));
 await f.work.action({type:'reprepare',draftId:first.draft!.id,expectedVersion:first.draft!.version,text:'edited plan',executor:'harness'});
 const edited=f.states.at(-1)!;assert.equal(edited.sourceInput!.text,'um first verbatim input');const exactId=edited.confirmation!.id;
 await f.work.route({...scope,turnId:'second',generation:2},'um second unrelated input',new AbortController().signal);
 await f.work.action({type:'focus',id:exactId});assert.equal(f.states.at(-1)!.sourceInput!.text,'um first verbatim input');assert.equal(f.states.at(-1)!.sourceInput!.draftId,first.draft!.id);
 assert.equal(f.receipts.draftForOperation('missing'),undefined);
 await f.work.close();const reopened=new DesktopWork({receipts:f.receipts,projects:f.projects,forwarding:f.forwarding,classify:async()=>({kind:'companion'}),emit:state=>f.states.push(state)});await reopened.start(60000);await reopened.action({type:'focus',id:exactId});assert.equal(f.states.at(-1)!.sourceInput!.text,'um first verbatim input');await reopened.close();
});
test('legacy stored plan is recoverable but never labeled as verbatim ASR',async t=>{
 const f=await fixture(t,true);await f.work.route(scope,'um legacy original',new AbortController().signal);const state=f.states.at(-1)!;
 // Synthetic pre-upgrade row: old releases stored no immutable raw input.
 const db=new Database(f.file);db.prepare("UPDATE work_drafts SET payload=json_remove(payload,'$.originalText') WHERE id=?").run(state.draft!.id);db.close();
 await f.work.action({type:'focus',id:state.confirmation!.id});const source=f.states.at(-1)!.sourceInput!;
 assert.equal(source.text,'legacy original');assert.equal(source.provenance,'legacy_saved_input');assert.equal(source.draftId,state.draft!.id);
});


test('spoken work notices follow actual new receipts once, never restored snapshots or repeated polls', async t => {
  const f = await fixture(t, true);
  await f.work.route(scope, 'um private synthetic engineering content', new AbortController().signal);
  const row = f.states.at(-1)!.confirmation!;
  assert.deepEqual(f.notices.map(n => n.kind), ['arrangement']);
  await Promise.all([f.work.action({type:'confirm',id:row.id,expectedVersion:row.version}), f.work.action({type:'confirm',id:row.id,expectedVersion:row.version})]);
  assert.equal(f.notices.filter(n => n.kind === 'confirmed').length, 1);
  await f.forwarding.sendConfirmed(row.id);
  await f.work.observe(); await f.work.observe();
  assert.ok(f.receipts.get(row.id).appTurnId);
  assert.equal(f.notices.filter(n => n.kind === 'transferred').length, 1);
  assert.equal(f.notices.some(n => n.kind === 'completed'), false);
  f.observation.completed = true;
  await f.work.observe(); await f.work.observe();
  assert.equal(f.notices.filter(n => n.kind === 'completed').length, 1);
  assert.equal(JSON.stringify(f.notices.filter(n=>n.kind!=='arrangement')).includes('private synthetic'), false);
  await f.work.close();
  const restored: WorkStatusNotice[] = [];
  const reopened = new DesktopWork({receipts:f.receipts,projects:f.projects,forwarding:f.forwarding,classify:async()=>({kind:'companion'}),emit:()=>{},notify:n=>restored.push(n)});
  await reopened.start(60000); await reopened.action({type:'focus',id:row.id});
  await reopened.action({type:'refresh',id:row.id}); await reopened.observe(); await reopened.close();
  assert.deepEqual(restored, []);
});

function binding(f:Awaited<ReturnType<typeof fixture>>):WorkInputBinding {
 const s=f.states.at(-1)!,d=s.draft!,r=s.confirmation;
 return {draftId:d.id,draftVersion:d.version,...(r?{requestId:r.id,requestVersion:r.version}:{})};
}
function begin(f:Awaited<ReturnType<typeof fixture>>,n:number,b:WorkInputBinding|undefined=binding(f)){
 const s={...scope,turnId:'voice-'+n,generation:n};f.work.onInput();f.work.beginInput(s,b);return s;
}
const signal=()=>new AbortController().signal;
test('bound voice confirmation dispatches once and never replans',async t=>{
 const f=await fixture(t,true,true);await f.work.route(scope,'Original task',signal());const b=binding(f);
 await f.work.route(begin(f,2),'确认',signal());assert.equal(f.observation.prompts, 0); assert.equal(f.observation.sends, 1);assert.equal(f.observation.plans,1);
 await f.work.route(begin(f,3,b),'确认执行',signal());await f.forwarding.sendConfirmed(b.requestId!);await f.forwarding.sendConfirmed(b.requestId!);
 assert.equal(f.observation.prompts, 0); assert.equal(f.observation.sends, 1);assert.equal(f.observation.sends,1);assert.equal(f.receipts.drafts().length,1);
 assert.equal(f.receipts.draft(b.draftId).conversation?.at(-1)?.text,'确认');
});
test('clarification voice answer retains original draft and exact task-only question/answer recovery',async t=>{
 const f=await fixture(t,true,true);f.observation.intent={kind:'clarify',question:'是整理文献吗？'};
 await f.work.route(scope,'在合成项目做同样任务',signal());const d=binding(f).draftId;
 f.observation.continuation={kind:'supplement',text:'在合成项目整理文献',executionAuthorized:false};
 await f.work.route(begin(f,2),'是的，整理文献',signal());const ready=f.states.at(-1)!;
 assert.equal(ready.draft!.id,d);assert.equal(f.receipts.drafts().length,1);assert.equal(ready.sourceInput!.text,'在合成项目做同样任务');
 assert.deepEqual(ready.sourceInput!.conversation?.map(m=>m.text),['是整理文献吗？','是的，整理文献']);assert.equal(f.observation.prompts,0);
 assert.equal(f.observation.contexts[0]!.question,'是整理文献吗？');f.observation.continuation={kind:'confirm'};
 await f.work.route(begin(f,3),'确认',signal());assert.equal(f.observation.prompts, 0); assert.equal(f.observation.sends, 1);
 await f.work.action({type:'focus',id:ready.confirmation!.id});assert.equal(f.states.at(-1)!.sourceInput!.draftId,d);
 assert.deepEqual(f.states.at(-1)!.sourceInput!.conversation?.map(m=>m.text),['是整理文献吗？','是的，整理文献','确认']);
});
test('changed arrangement requires fresh confirmation even when semantic answer authorizes execution',async t=>{
 const f=await fixture(t,true,true);await f.work.route(scope,'Original task',signal());const old=binding(f);
 f.observation.continuation={kind:'supplement',text:'Changed task',executionAuthorized:true};await f.work.route(begin(f,2),'改成只读分析，直接发',signal());
 assert.equal(f.observation.prompts,0);assert.equal(f.receipts.get(old.requestId!).phase,'unavailable');assert.equal(binding(f).draftId,old.draftId);
 f.observation.continuation={kind:'confirm'};await f.work.route(begin(f,3,old),'确认',signal());assert.equal(f.observation.prompts,0);
 await f.work.route(begin(f,4),'确认',signal());assert.equal(f.observation.prompts, 0); assert.equal(f.observation.sends, 1);
});
test('unpresented arrangement must be presented before a bound confirmation can execute',async t=>{
 const f=await fixture(t,true,true);await f.work.route(scope,'Synthetic task',signal());const s={...scope,turnId:'hidden',generation:2};
 f.work.onInput();f.work.beginInput(s);await f.work.route(s,'确认',signal());assert.equal(f.observation.prompts,0);assert.equal(f.receipts.drafts().length,1);
 assert.match(f.notices.at(-1)!.spokenText!,/Existing synthetic task/);assert.ok(f.notices.at(-1)?.workBinding);
 await f.work.route(begin(f,3),'确认',signal());assert.equal(f.observation.prompts, 0); assert.equal(f.observation.sends, 1);
});
for(const change of ['cancel','revise'] as const)test('late continuation after '+change+' cannot dispatch or append stale answer',async t=>{
 const f=await fixture(t,true,true);await f.work.route(scope,'Synthetic task',signal());const b=binding(f);let release!:()=>void;
 f.observation.interpretWait=()=>new Promise<void>(r=>release=r);const stop=new AbortController();const run=f.work.route(begin(f,2),'就按这个发',stop.signal);await tick();
 if(change==='cancel'){stop.abort();f.work.onInput();}else await f.work.action({type:'reprepare',draftId:b.draftId,expectedVersion:b.draftVersion,text:'New plan',executor:'harness'});
 release();if(change==='cancel')await assert.rejects(run);else await run;
 assert.equal(f.observation.prompts+f.observation.nativePrompts,0);assert.equal(f.receipts.draft(b.draftId).conversation?.some(m=>m.text==='就按这个发')??false,false);
});
test('owner lookup cancellation is checked before durable confirmation',async t=>{
 const f=await fixture(t,true,true);await f.work.route(scope,'Synthetic task',signal());const b=binding(f);let release!:()=>void;
 f.observation.ownerWait=()=>new Promise<void>(r=>release=r);const stop=new AbortController();const run=f.work.route(begin(f,2),'确认',stop.signal);
 try {
  // Disk-backed validation can outlast many event-loop ticks on Windows.
  const deadline=Date.now()+5000;
  while(!release&&Date.now()<deadline)await new Promise<void>(done=>setTimeout(done,5));
  assert.ok(release,'owner lookup must reach its controlled wait');stop.abort();f.work.onInput();release();await run.catch(()=>{});
  assert.equal(f.receipts.get(b.requestId!).confirmedAt,undefined);assert.equal(f.observation.prompts,0);assert.equal(f.receipts.draft(b.draftId).status,'prepared');
 } finally {
  // A failed assertion must not strand fixture teardown behind this mock gate.
  stop.abort();f.observation.ownerWait=undefined;release?.();await run.catch(()=>{});
 }
});
test('failed interpretation saves raw answer; empty input is not reported as storage corruption',async t=>{
 const f=await fixture(t,true,true);f.observation.intent={kind:'clarify',question:'Which scope?'};await f.work.route(scope,'Original',signal());const b=binding(f);
 f.observation.interpretWait=async()=>{throw Error('Synthetic unavailable provider');};await f.work.route(begin(f,2),'My raw answer',signal());
 const d=f.receipts.draft(b.draftId);assert.equal(d.originalText,'Original');assert.equal(d.conversation?.at(-1)?.text,'My raw answer');assert.equal(f.receipts.drafts().length,1);
 assert.match(f.states.at(-1)!.detail!,/回答已保留/);const before=f.receipts.drafts();await assert.rejects(f.work.route(scope,' ',signal()),/没有听清/);assert.deepEqual(f.receipts.drafts(),before);
 assert.throws(()=>f.receipts.createDraft(scope,''),/没有听清/);
});
test('explicitly authorized complete initial answer can execute once without another round',async t=>{
 const f=await fixture(t,true,true);f.observation.intent={kind:'clarify',question:'做什么任务？'};await f.work.route(scope,'在合成项目做个任务',signal());
 f.observation.continuation={kind:'supplement',text:'在合成项目只读整理文献目录',executionAuthorized:true};await f.work.route(begin(f,2),'只读整理文献目录，确认直接开始',signal());
 assert.equal(f.observation.prompts, 0); assert.equal(f.observation.sends, 1);assert.equal(f.receipts.drafts().length,1);assert.equal(f.receipts.drafts()[0]!.status,'confirmed');
});
test('voice cancel dismisses the unsent card without dispatch',async t=>{
 const f=await fixture(t,true,true);await f.work.route(scope,'Synthetic task',signal());const b=binding(f);
 f.observation.continuation={kind:'cancel'};await f.work.route(begin(f,2),'不要发了',signal());assert.equal(f.receipts.draft(b.draftId).status,'dismissed');
 assert.equal(f.observation.prompts,0);assert.equal(f.notices.at(-1)?.kind,'cancelled');
});

for (const reason of ['interrupted','continued_elsewhere'] as const) test('lost original completion marks '+reason+' once and accepts late exact completion', async t => {
 const f=await fixture(t,true);await f.work.route(scope,'Synthetic work',signal());
 const row=f.states.at(-1)!.confirmation!;await f.work.action({type:'confirm',id:row.id,expectedVersion:row.version});
 const turn=f.receipts.get(row.id).appTurnId;assert.ok(turn);
 f.observation.receiptReason=reason;await f.work.observe();
 const marked=f.receipts.get(row.id);assert.equal(marked.phase,'unknown');assert.equal(marked.appTurnId,turn);
 assert.match(marked.detail!,reason==='interrupted'?/已中断/:/完成回执未找到/);
 const mutate=f.receipts.mutate.bind(f.receipts);let writes=0;
 f.receipts.mutate=(id,update)=>{writes++;return mutate(id,update);};
 await f.work.observe();await f.work.observe();assert.equal(writes,0);
 assert.equal(f.notices.filter(n=>n.kind==='unknown').length,1);assert.equal(f.notices.filter(n=>n.kind==='completed').length,0);
 await f.forwarding.confirm(row.id,row.version);assert.equal(f.observation.sends,1);assert.equal(f.observation.prompts,0);
 f.observation.completed=true;await f.work.observe();await f.work.observe();
 assert.equal(f.receipts.get(row.id).phase,'completed');assert.equal(f.receipts.get(row.id).detail,undefined);
 assert.equal(f.notices.filter(n=>n.kind==='completed').length,1);assert.equal(f.observation.sends,1);
});

test('dismissed erroneous everyday draft stays historical across reopen; new everyday input neither rewrites nor revives it',async t=>{
 const f=await fixture(t,true,true);f.observation.executor='harness';
 await f.work.route(scope,'下午好，现在帮我查一下现在是几点了',signal());const b=binding(f),old=f.receipts.draft(b.draftId);
 await f.work.action({type:'dismiss',draftId:b.draftId});const dismissed=f.receipts.draft(b.draftId);assert.equal(dismissed.status,'dismissed');assert.equal(dismissed.text,old.text);
 const before=JSON.stringify([f.receipts.drafts(),f.receipts.list()]);await f.work.close();
 const states:DesktopWorkState[]=[];const reopened=new DesktopWork({receipts:f.receipts,projects:f.projects,forwarding:f.forwarding,classify:async()=>({kind:'companion'}),emit:s=>states.push(s)});
 await reopened.start(60000);assert.equal(states.at(-1)?.draft,undefined);
 assert.equal(await reopened.route({...scope,turnId:'fresh'},'下午好，现在帮我查一下现在是几点了',signal()),'companion');
 assert.equal(JSON.stringify([f.receipts.drafts(),f.receipts.list()]),before);assert.equal(f.observation.nativePrompts,0);assert.equal(f.observation.sends,0);await reopened.close();
});
