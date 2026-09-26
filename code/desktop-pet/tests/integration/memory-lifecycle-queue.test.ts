import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleMemoryLifecycleQueue } from '../../core/memory-lifecycle-queue.js';
import type { TurnScope } from '../../contracts/index.js';
import type { AssistantMemoryPort, BackgroundMemoryPort, MemoryTurnPort, SummaryPort } from '../../contracts/memory-lifecycle.js';
const scope = (characterId: TurnScope['characterId'], turnId: string): TurnScope => ({ characterId, turnId, sessionId: characterId, generation: 1 });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const seen: string[] = []; const failures: unknown[] = [];
  const memory: MemoryTurnPort & SummaryPort & AssistantMemoryPort = {
    async append() {}, async appendAssistant() {}, async maintain() { return []; },
    async context() { throw new Error('unused'); }, assertContextCurrent() {},
    async prepareTurn(scope, id, text, signal) { signal.throwIfAborted(); seen.push(`${scope.characterId}:${id}:${text}`); return { scope, request: 'none', status: 'unchanged', results: [], affectedIds: [], retrievalInvalidated: false, clarification: null }; },
    async summarizePending(scope) { seen.push(`summary:${scope.characterId}`); return { scope, status: 'unchanged', summaryId: null, reason: null }; },
  };
  return { memory, seen, failures, queue: new RoleMemoryLifecycleQueue(memory, (_scope, error) => failures.push(error)) };
}
test('pending observations isolate roles, count queued/running work and reject returned-to-zero snapshots', async () => {
  const f = fixture(), entered = deferred(), release = deferred(), original = f.memory.prepareTurn;
  f.memory.prepareTurn = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const empty = f.queue.observePending('friend'), other = f.queue.observePending('sweetheart');
  assert.deepEqual(empty.snapshot, { characterId: 'friend', revision: 0, queued: 0, running: 0 });
  const first = f.queue.prepareTurn(scope('friend', 'first'), 'one', 'held', new AbortController().signal);
  assert.equal(f.queue.observePending('friend').snapshot.queued, 1);
  assert.throws(empty.assertCurrent, /stale_memory_pending_state/);
  await entered.promise;
  const running = f.queue.observePending('friend');
  assert.equal(running.snapshot.running, 1); assert.equal(running.snapshot.queued, 0);
  const second = f.queue.prepareTurn(scope('friend', 'second'), 'two', 'queued', new AbortController().signal);
  assert.deepEqual([f.queue.observePending('friend').snapshot.queued, f.queue.observePending('friend').snapshot.running], [1, 1]);
  other.assertCurrent(); assert.equal(other.snapshot.running + other.snapshot.queued, 0);
  release.resolve(); await Promise.all([first, second]); await f.queue.drain();
  const done = f.queue.observePending('friend');
  assert.equal(done.snapshot.queued + done.snapshot.running, 0);
  assert.throws(empty.assertCurrent, /stale_memory_pending_state/);
  assert.throws(running.assertCurrent, /stale_memory_pending_state/);
  other.assertCurrent(); await f.queue.close();
  assert.throws(done.assertCurrent);
});
test('frontend cancellation detaches immediately while accepted maintenance retains its original role', async () => {
  const f = fixture(), entered = deferred(), release = deferred(), foreground = new AbortController();
  let heldSignal: AbortSignal | undefined; const original = f.memory.prepareTurn;
  f.memory.prepareTurn = async (...args) => { heldSignal = args[3]; entered.resolve(); await release.promise; return original(...args); };
  const owned = scope('friend', 'first');
  const pending = f.queue.prepareTurn(owned, 'u1', 'fact', foreground.signal); await entered.promise;
  foreground.abort(new Error('switched')); await assert.rejects(pending, /switched/);
  assert.equal(heldSignal?.aborted, false);
  release.resolve(); await f.queue.drain(); assert.deepEqual(f.seen, ['friend:u1:fact']); await f.queue.close();
});
test('same-role jobs and summaries serialize while the other role proceeds independently', async () => {
  const f = fixture(), entered = deferred(), release = deferred(); const original = f.memory.prepareTurn;
  f.memory.prepareTurn = async (...args) => { if (args[1] === 'held') { entered.resolve(); await release.promise; } return original(...args); };
  const first = f.queue.prepareTurn(scope('friend', 'a'), 'held', 'first', new AbortController().signal); await entered.promise;
  f.queue.afterConversationSaved(scope('friend', 'a'));
  const next = f.queue.prepareTurn(scope('friend', 'b'), 'next', 'second', new AbortController().signal);
  await f.queue.prepareTurn(scope('sweetheart', 'c'), 'other', 'private', new AbortController().signal);
  assert.deepEqual(f.seen, ['sweetheart:other:private']); release.resolve(); await Promise.all([first, next]);
  assert.deepEqual(f.seen, ['sweetheart:other:private', 'friend:held:first', 'summary:friend', 'friend:next:second']); await f.queue.close();
});
test('failed summary is reported without poisoning the next foreground memory job', async () => {
  const f = fixture(); f.memory.summarizePending = async () => { throw new Error('summary failed'); };
  f.queue.afterConversationSaved(scope('friend', 'a'));
  await f.queue.prepareTurn(scope('friend', 'b'), 'next', 'fact', new AbortController().signal);
  assert.equal(f.failures.length, 1); assert.deepEqual(f.seen, ['friend:next:fact']); await f.queue.close();
});
test('shutdown aborts active backend work and prevents queued jobs from starting', async () => {
  const f = fixture(), entered = deferred();
  f.memory.prepareTurn = async (_scope, _id, _text, signal) => { entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const active = f.queue.prepareTurn(scope('friend', 'a'), 'held', 'fact', new AbortController().signal); await entered.promise;
  f.queue.afterConversationSaved(scope('friend', 'a'));
  const rejection = assert.rejects(active); await f.queue.close(); await rejection;
  assert.deepEqual(f.seen, []); assert.equal(f.failures.length, 0);
});

test('lifecycle construction rejects a legacy memory port before any model request', () => {
  const f = fixture();
  const { appendAssistant: _unused, ...legacy } = f.memory;
  assert.throws(() => new RoleMemoryLifecycleQueue(legacy, () => {}), /assistant_memory_provenance_not_implemented/);
});
test('queued assistant keeps issued context identity and aborts before writing after a role switch', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  f.memory.prepareTurn = async () => { entered.resolve(); await release.promise; throw new Error('held'); };
  const owned = scope('friend', 'a');
  const held = f.queue.prepareTurn(owned, 'user', 'fact', new AbortController().signal).catch(() => {});
  await entered.promise;
  const context = { scope: owned, characterPrompt: '', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 1000 };
  const message = { characterId: owned.characterId, id: 'assistant', role: 'assistant' as const, text: 'reply', createdAt: new Date().toISOString() };
  let writes = 0;
  f.memory.appendAssistant = async (_scope, _message, issued, currentId) => { assert.equal(issued, context); assert.equal(currentId, 'user'); writes++; };
  const cancelled = new AbortController();
  const pending = f.queue.appendAssistant(owned, message, context, 'user', cancelled.signal);
  const rejected = assert.rejects(pending, /switched/); cancelled.abort(new Error('switched'));
  await rejected; assert.equal(writes, 0); // The held background job has not been released yet.
  release.resolve(); await Promise.all([held, rejected]); assert.equal(writes, 0);
  await f.queue.appendAssistant(owned, message, context, 'user', new AbortController().signal); assert.equal(writes, 1);
  await f.queue.close();
});

test('background rejection and exception each report memory once, summary remains separate and later jobs proceed', async () => {
  const f=fixture();
  const memory:BackgroundMemoryPort & SummaryPort={...f.memory,
    async prepareBackgroundTurn(owned,id,text,signal) {
      if(id==='throw')throw new Error('planning_failed');
      const outcome=await f.memory.prepareTurn(owned,id,text,signal);
      return id==='reject'?{...outcome,status:'rejected',rejectionCode:'stale_lifecycle_epoch'}:outcome;
    },
    async foregroundContext(){throw new Error('unused');},
    async summarizePending(){throw new Error('summary_failed');},
  };
  const failures:{scope:TurnScope;error:unknown;kind:string|undefined}[]=[];
  const queue=new RoleMemoryLifecycleQueue(memory,(owned,error,kind)=>{failures.push({scope:owned,error,kind});});
  const owned=scope('friend','first');
  const rejected=await queue.enqueueTurn(owned,'reject','fact');
  assert.equal(rejected.status,'rejected'); assert.equal(rejected.rejectionCode,'stale_lifecycle_epoch');
  await assert.rejects(queue.enqueueTurn(owned,'throw','fact'),/planning_failed/);
  queue.afterConversationSaved(owned);
  assert.equal((await queue.enqueueTurn(scope('friend','next'),'valid','fact')).status,'unchanged');
  await queue.drain(); assert.deepEqual(failures.map(f=>f.kind),['memory','memory','summary']);
  assert.ok(failures.every(f=>f.scope.characterId==='friend'));
  await queue.close();
  const badSink=new RoleMemoryLifecycleQueue(memory,()=>{throw new Error('sink_failed');});
  assert.equal((await badSink.enqueueTurn(owned,'reject','fact')).status,'rejected');
  await badSink.close();
});

test('legacy capability remains usable but new background API fails explicitly instead of returning a fake outcome', async () => {
  const f=fixture();
  await assert.rejects(f.queue.enqueueTurn(scope('friend','first'),'first','fact'),/background_memory_not_implemented/);
  await assert.rejects(()=>f.queue.foregroundContext(scope('friend','first'),'first','fact',null,new AbortController().signal),/background_memory_not_implemented/);
  assert.equal((await f.queue.prepareTurn(scope('friend','next'),'next','fact',new AbortController().signal)).status,'unchanged');
  assert.equal(f.failures.length,1); await f.queue.close();
});

test('immediate foreground work preserves context identity, joins drain and receives frontend or shutdown cancellation', async () => {
  const f=fixture(), release=deferred(); const owned=scope('friend','foreground');
  const context={scope:owned,characterPrompt:'',recent:[],summary:'',memories:[],perception:null,inputTokenBudget:1000};
  const message={characterId:owned.characterId,id:'assistant',role:'assistant' as const,text:'original',createdAt:new Date().toISOString()};
  let heldSignal:AbortSignal|undefined;
  const memory:BackgroundMemoryPort & SummaryPort={...f.memory,
    prepareBackgroundTurn:(...args)=>f.memory.prepareTurn(...args),
    async foregroundContext(_scope,_id,_text,_perception,signal) {
      heldSignal=signal;
      return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    },
    async appendAssistant(captured,capturedMessage,issued) {
      await release.promise; assert.equal(issued,context); assert.equal(captured.characterId,'friend'); assert.equal(capturedMessage.text,'original');
    },
  };
  const queue=new RoleMemoryLifecycleQueue(memory,()=>{});
  const saved=queue.appendForegroundAssistant(owned,message,context,'user',new AbortController().signal);
  Object.assign(owned,{characterId:'sweetheart'}); message.text='changed';
  let drained=false; const drain=queue.drain().then(()=>{drained=true;});
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(drained,false);
  release.resolve(); await saved; await drain; assert.equal(drained,true);
  const frontend=new AbortController();
  const read=queue.foregroundContext(scope('friend','read'),'user','fact',null,frontend.signal);
  const rejection=assert.rejects(read,/switched/); frontend.abort(new Error('switched')); await rejection;
  assert.equal(heldSignal?.aborted,true);
  const closing=queue.foregroundContext(scope('friend','closing'),'user','fact',null,new AbortController().signal);
  const closed=assert.rejects(closing); await queue.close(); await closed; assert.equal(heldSignal?.aborted,true);
});
