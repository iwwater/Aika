import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { CodexAppConnection, CodexAppError } from '../../harness/codex-app.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  // Darwin Unix sockets have a short path limit; this owned temporary directory is removed after each case.
  const home = await mkdtemp('/tmp/desktop-pet-ipc-'); await mkdir(join(home, 'ipc'), { mode: 0o700 }); await mkdir(join(home, 'sessions'));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}
for (const mode of ['success', 'lost-response'] as const) test(`existing App ${mode}: exact owner, inherited settings and no duplicate send`, async t => {
  const home = await fixture(t), threadId = randomUUID(), turnId = randomUUID(), requestId = randomUUID(); let writes = 0;
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const size = buffer.readUInt32LE(); const msg = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4);
        let result: object = { clientId: 'probe' }, owner = 'probe';
        if (msg.method === 'thread-owner-discovery') {
          assert.equal(msg.version, 1); assert.deepEqual(msg.params, { hostId: 'local', conversationId: threadId });
          result = { supportsUntrustedAppInput: true }; owner = 'actual-owner';
        } else if (msg.method === 'thread-follower-start-turn') {
          writes++; assert.equal(msg.requestId, requestId); assert.equal(msg.targetClientId, 'actual-owner'); assert.equal(msg.version, 2); assert.equal(msg.hostId, undefined);
          assert.deepEqual(msg.params.turnStart, { request: { threadId, input: [{ type: 'text', text: 'Confirmed synthetic text', text_elements: [] }] }, context: { inheritThreadSettings: true } });
          if (mode === 'lost-response') { socket.destroy(); return; }
          result = { result: { turn: { id: turnId } } }; owner = 'actual-owner';
        }
        const bytes = Buffer.from(JSON.stringify({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: owner, result }));
        const frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4);
        // Fragmented prefix and payload are normal socket behavior.
        socket.write(frame.subarray(0, 2)); socket.write(frame.subarray(2, 9)); socket.write(frame.subarray(9));
      }
    });
  });
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const path = join(home, 'ipc/ipc.sock'); await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(path, done); }); await chmod(path, 0o600);
  const client = new CodexAppConnection(home, async () => true, 150);
  if (mode === 'success') assert.deepEqual(await client.send(threadId, 'Confirmed synthetic text', requestId), { requestId, threadId, turnId });
  else await assert.rejects(client.send(threadId, 'Confirmed synthetic text', requestId), { code: 'unknown_delivery' });
  assert.equal(writes, 1);
});

test('incompatible App is refused before a socket or task write', async t => {
  const home = await fixture(t); const client = new CodexAppConnection(home, async () => false);
  await assert.rejects(client.send(randomUUID(), 'test', randomUUID()), { code: 'incompatible' });
});

test('receipt uses exact task identity and turn completion, never the newest unrelated answer', async t => {
  const home = await fixture(t), threadId = randomUUID(), turnId = randomUUID(), other = randomUUID(), file = join(home, 'sessions/selected.jsonl');
  const db = new Database(join(home, 'state_5.sqlite')); db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,title TEXT,cwd TEXT,archived INT,updated_at INT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,0,1)').run(threadId, file, 'Synthetic task', '/synthetic-project'); db.exec("ALTER TABLE threads ADD COLUMN name TEXT; ALTER TABLE threads ADD COLUMN source TEXT DEFAULT 'vscode'; ALTER TABLE threads ADD COLUMN thread_source TEXT DEFAULT 'user'; ALTER TABLE threads ADD COLUMN agent_path TEXT; ALTER TABLE threads ADD COLUMN agent_nickname TEXT");db.close();
  const events = [{ type: 'session_meta', payload: { id: threadId } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: 'exact answer', duration_ms: 7 } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: other, last_agent_message: 'unrelated later answer' } }];
  await writeFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  const client = new CodexAppConnection(home);
  assert.equal((await client.receipt(threadId, turnId)).reply, 'exact answer');
  assert.equal((await client.receipt(threadId, randomUUID())).status, 'unknown');
  events[0] = { type: 'session_meta', payload: { id: other } }; await writeFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  assert.equal((await client.receipt(threadId, turnId)).status, 'unknown');
  assert.equal(client.list('Synthetic')[0]?.threadId, threadId);
});

test('real user names and project directories are filtered before limits; internal tasks never get owner recovery',async t=>{
 const home=await fixture(t),db=new Database(join(home,'state_5.sqlite'));
 db.exec('CREATE TABLE threads(id TEXT,name TEXT,title TEXT,cwd TEXT,archived INT,updated_at INT,source TEXT,thread_source TEXT,agent_path TEXT,agent_nickname TEXT)');
 const main=randomUUID(),hidden=randomUUID(),q=db.prepare('INSERT INTO threads VALUES(?,?,?,?,0,?,?,?,?,?)');
 q.run(main,'Actual display name','PRIVATE LONG PROMPT MUST NOT BE THE LABEL',home,1,'vscode','user',null,null);
 for(let i=0;i<80;i++)q.run(i?randomUUID():hidden,'Internal','private subagent prompt',home,100+i,JSON.stringify({subagent:{other:'guardian'}}),'user',null,null);
 db.close();let opened=0;const client=new CodexAppConnection(home,async()=>true,10,async id=>{assert.equal(id,main);opened++;});
 assert.equal(client.list('',1)[0]?.threadId,main);assert.equal(client.list('Actual')[0]?.title,'Actual display name');assert.equal(client.list(home)[0]?.threadId,main);
 client.discover=async()=>{if(!opened)throw new CodexAppError('unavailable','owner_discovery','timeout');return {available:true};};
 await assert.rejects(client.ensureAvailable(hidden),{code:'invalid_target'});assert.equal(opened,0);
 assert.deepEqual(await client.ensureAvailable(main),{available:true});assert.equal(opened,1);
});

for (const scenario of ['same-turn-restart','aborted','later-turn','no-original-evidence','earlier-other-turn','invalid-later-id','late-exact-completion'] as const)
test('receipt restart boundary: '+scenario, async t => {
  const home=await fixture(t), threadId=randomUUID(), turnId=randomUUID(), other=randomUUID(), file=join(home,'sessions/restart.jsonl');
  const db=new Database(join(home,'state_5.sqlite'));db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?)').run(threadId,file);db.close();
  const event=(type:string,id:string)=>({type:'event_msg',payload:{type,turn_id:id,last_agent_message:id===turnId?'exact original result':'unrelated result'}});
  const rows:any[]=[{type:'session_meta',payload:{id:threadId}}];
  if(scenario==='earlier-other-turn')rows.push(event('task_started',other));
  if(scenario!=='no-original-evidence')rows.push(event('task_started',turnId));
  if(['aborted','late-exact-completion'].includes(scenario))rows.push(event('turn_aborted',turnId));
  if(['later-turn','no-original-evidence','late-exact-completion'].includes(scenario))rows.push(event('task_started',other),event('task_complete',other));
  if(scenario==='invalid-later-id')rows.push(event('task_started',''));
  if(scenario==='same-turn-restart')rows.push(event('task_started',turnId),event('task_complete',turnId));
  const save=()=>writeFile(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');await save();
  const before=await new CodexAppConnection(home).receipt(threadId,turnId);
  if(scenario==='same-turn-restart'){
    assert.equal(before.status,'completed');assert.equal(before.reply,'exact original result');
  }else{
    assert.equal(before.status,'unknown');assert.equal(before.reply,undefined);
    assert.equal(before.reason,['aborted','late-exact-completion'].includes(scenario)?'interrupted':scenario==='later-turn'?'continued_elsewhere':undefined);
  }
  if(scenario==='late-exact-completion'){
    rows.push(event('task_complete',turnId));await save();
    // A new reader after restart still uses the original turn, never the later turn's reply.
    const after=await new CodexAppConnection(home).receipt(threadId,turnId);
    assert.equal(after.status,'completed');assert.equal(after.reply,'exact original result');assert.equal(after.reason,undefined);
  }
});
