import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HarnessConnection } from '../../harness/connection.js';

type Event = { type: string; data?: any };
const sessionId = 'session-native-test', requestId = 'request-native-test';
const start = (turn = 1): Event => ({ type: 'turn/start', data: { turn } });
const user = (rpcId = requestId): Event => ({ type: 'user/message', data: { source: { kind: 'user', rpcId }, content: [{ type: 'text', text: 'private input' }] } });
const end = (kind = 'completed', turn = 1): Event => ({ type: 'turn/end', data: { turn, reason: { kind, error: { message: 'private error' } } } });
const answer = (text = 'done', turn = 1): Event => ({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'thinking', text: 'private thoughts' }, { type: 'text', text }] } } });
const asked = (id = 'approval-1'): Event => ({ type: 'approval/asked', data: { id, toolName: 'bash', callId: 'call-1', reason: 'private reason' } });
const decided = (id = 'approval-1'): Event => ({ type: 'approval/decided', data: { id, outcome: 'allowed-once' } });
async function fixture(t: TestContext, events: Event[], options: { running?: boolean; inbox?: unknown; pageSize?: number; gap?: boolean; fail?: boolean; missing?: boolean; slowPrompt?: boolean } = {}) {
  const seen: any[] = [];
  const records = events.map((event, seq) => ({ type: 'event', event: { ...event, seq } }));
  const server = createServer(async (req, res) => {
    if (req.url === '/?token=synthetic-secret') { res.writeHead(303, { Location: '/', 'Set-Cookie': 'dsh_session=synthetic.cookie' }); res.end(); return; }
    const chunks = []; for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks).toString()); seen.push(body);
    if (options.fail) { res.writeHead(500); res.end('private host failure'); return; }
    const request = body.payload.args.request;
    let value: any;
    switch (body.method) {
      case 'session/list': value = { items: options.missing ? [] : [{ sessionId, running: options.running ?? false,
        projections: { asOfSeq: records.length - 1, values: { agentPreset: 'desktop-pet-work-v1', inbox: options.inbox } } }] }; break;
      case 'session/page': {
        assert.deepEqual(request.address, { kind: 'session', sessionId });
        assert.equal(request.throughSeq, records.length - 1);
        const stop = request.beforeSeq ?? records.length, from = Math.max(0, stop - (options.pageSize ?? 50));
        value = { records: records.slice(from, stop), hasMore: from > 0 };
        if (options.gap) value.records = value.records.filter((row: any) => row.event.seq !== 2);
        break;
      }
      case 'session/create': value = { sessionId, agentPreset: 'desktop-pet-work-v1' }; break;
      case 'session/rename': value = { title: request.title, seq: 3 }; break;
      case 'session/selectModel': value = { selected: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } }; break;
      case 'session/prompt': if (options.slowPrompt) return; value = { accepted: true }; break;
      default: throw Error('Unexpected RPC: ' + body.method);
    }
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { seen, connection: new HarnessConnection(async () => `http://127.0.0.1:${address.port}/?token=synthetic-secret`, options.slowPrompt ? 80 : 2000) };
}

test('native creation fixes bounded native preset, title and route before a single exact confirmed prompt', async t => {
  const f = await fixture(t, []), text = '  保留完整正文。\nDo this in the chosen directory.  ';
  await f.connection.createWorkSession(sessionId, '/synthetic/workspace');
  assert.deepEqual(f.seen.map(x => x.method), ['session/create', 'session/rename', 'session/selectModel']);
  assert.deepEqual(f.seen[0].payload.args.request, { sessionId, agentPreset: 'desktop-pet-work-v1', cwd: '/synthetic/workspace' });
  assert.deepEqual(f.seen[1].payload.args.request, { sessionId, title: 'Desktop pet work ' + sessionId.slice(-8) });
  assert.deepEqual(f.seen[2].payload.args.request, { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' });
  await f.connection.submitWork(sessionId, requestId, text);
  assert.deepEqual(f.seen[3].payload.args.request, { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] });
});

test('invalid IDs, empty input and nonabsolute cwd cannot reach host', async () => {
  let calls = 0; const c = new HarnessConnection(async () => { calls++; throw Error('must not run'); });
  await assert.rejects(c.createWorkSession('bad/id', '/tmp'));
  await assert.rejects(c.createWorkSession(sessionId, 'relative'));
  await assert.rejects(c.submitWork(sessionId, requestId, ' \n'));
  await assert.rejects(c.submitWork(sessionId, '../other', 'text'));
  assert.equal((await c.workReceipt('bad?id', requestId)).status, 'unknown');
  assert.equal(calls, 0);
});

test('completion crosses pages and ignores newer unrelated successful turn and private model internals', async t => {
  const f = await fixture(t, [start(), user(), answer('正确结果'), end(), start(2), user('other'), answer('wrong private result', 2), end('completed', 2)], { pageSize: 1 });
  const result = await f.connection.workReceipt(sessionId, requestId);
  assert.deepEqual(result, { status: 'completed', result: '正确结果', detail: '原生任务已完成。' });
  assert.ok(f.seen.length > 2);
  assert.ok(f.seen.every(x => ['session/list', 'session/page'].includes(x.method)));
});

test('failed exact turn is never replaced by a newer completion or raw error', async t => {
  for (const kind of ['error', 'aborted', 'blocked', 'max-tokens', 'interrupted']) {
    const f = await fixture(t, [start(), user(), answer('not final'), end(kind), start(2), user('other'), answer('unrelated', 2), end('completed', 2)]);
    const result = await f.connection.workReceipt(sessionId, requestId);
    assert.equal(result.status, 'failed'); assert.equal(result.result, undefined); assert.ok(!JSON.stringify(result).includes('private'));
  }
});

test('pending native approval requires exact open turn and running snapshot; observing never approves', async t => {
  const pending = await fixture(t, [start(), user(), asked()], { running: true, pageSize: 1 });
  const receipt = await pending.connection.workReceipt(sessionId, requestId);
  assert.equal(receipt.status, 'approval'); assert.ok(!JSON.stringify(receipt).includes('private'));
  assert.ok(pending.seen.every(x => ['session/list', 'session/page'].includes(x.method)));
  const done = await fixture(t, [start(), user(), asked(), decided()], { running: true });
  assert.equal((await done.connection.workReceipt(sessionId, requestId)).status, 'working');
  const cold = await fixture(t, [start(), user(), asked()], { running: false });
  assert.equal((await cold.connection.workReceipt(sessionId, requestId)).status, 'unknown');
  const foreign = await fixture(t, [start(), user('other'), asked()], { running: true });
  assert.equal((await foreign.connection.workReceipt(sessionId, requestId)).status, 'unknown');
});

test('terminal complete and approval history close correctly, unclosed or inconsistent approval stays unknown', async t => {
  for (const tail of [[asked(), end()], [decided(), end()], [asked(), asked(), end()]]) {
    const f = await fixture(t, [start(), user(), ...tail]);
    assert.equal((await f.connection.workReceipt(sessionId, requestId)).status, 'unknown');
  }
  const f = await fixture(t, [start(), user(), asked(), decided(), answer(), end()]);
  assert.equal((await f.connection.workReceipt(sessionId, requestId)).status, 'completed');
});

test('native queue identity is observed without sending again, and running alone never identifies a request', async t => {
  const queue = { 'next-turn': [{ source: { kind: 'user', rpcId: requestId } }], 'next-step': [] };
  const f = await fixture(t, [start(), user('other')], { running: true, inbox: queue });
  assert.deepEqual(await f.connection.workReceipt(sessionId, requestId), { status: 'working', detail: '请求已在原生 Harness 中排队。' });
  const unrelated = await fixture(t, [start(), user('other')], { running: true });
  assert.equal((await unrelated.connection.workReceipt(sessionId, requestId)).status, 'unknown');
});

test('same-turn foreign input, duplicate request identity, incomplete pages and missing session fail closed', async t => {
  const scenarios: [Event[], Parameters<typeof fixture>[2]][] = [
    [[start(), user(), user('other'), answer(), end()], {}],
    [[start(), user(), end(), start(2), user(), end('completed', 2)], {}],
    [[start(), user(), answer(), end()], { gap: true }],
    [[user(), answer(), end()], {}],
    [[start(), user(), end('unexpected')], {}],
    [[start(), user(), { type: 'turn/end', data: { turn: 1 } }], { running: true }],
    [[start(), user(), end()], { missing: true }],
  ];
  for (const [events, options] of scenarios) {
    const f = await fixture(t, events, options);
    assert.equal((await f.connection.workReceipt(sessionId, requestId)).status, 'unknown');
  }
});

test('only bounded text of the bound turn is a result; terminal without text invents nothing', async t => {
  const f = await fixture(t, [start(), user(), answer('x'.repeat(5000)), end()]);
  const receipt = await f.connection.workReceipt(sessionId, requestId);
  assert.equal(receipt.result?.length, 4000);
  const empty = await fixture(t, [start(), user(), end()]);
  assert.deepEqual(await empty.connection.workReceipt(sessionId, requestId), { status: 'completed', detail: '原生任务已完成。' });
});

test('connection errors and ambiguous submit timeout do not retry or cancel work', async t => {
  const f = await fixture(t, [], { fail: true });
  assert.equal((await f.connection.workReceipt(sessionId, requestId)).status, 'unknown');
  assert.equal(f.seen.length, 1);
  const slow = await fixture(t, [], { slowPrompt: true });
  await assert.rejects(slow.connection.submitWork(sessionId, requestId, 'confirmed'), /unavailable/);
  assert.deepEqual(slow.seen.map(x => x.method), ['session/prompt']);
});


test('native Host opening returns a credential-free real root without claiming a session deep link', async () => {
  const c = new HarnessConnection(async () => 'http://127.0.0.1:39999/?token=synthetic-secret');
  assert.equal(await c.workHostUrl(), 'http://127.0.0.1:39999/');
  for (const value of ['http://remote.invalid/?token=secret', 'http://127.0.0.1/?token=one&token=two', 'http://127.0.0.1/?token=secret#session']) {
    await assert.rejects(new HarnessConnection(async () => value).workHostUrl(), /authentication_required/);
  }
  await assert.rejects(new HarnessConnection(async () => { throw Error('private secret'); }).workHostUrl(), error => error instanceof Error && error.message === 'unavailable');
});

test('B37 exact pending approvals expose allowlisted tool name, never reason/args; decided tools disappear',async t=>{
 const f=await fixture(t,[start(),user(),{type:'approval/asked',data:{id:'a1',toolName:'bash',reason:'secret command and scope',args:{token:'private-token'}}}],{running:true});
 const receipt=await f.connection.workReceipt(sessionId,requestId);assert.deepEqual((receipt as any).approvalTools,['bash']);assert.ok(!JSON.stringify(receipt).includes('secret'));assert.ok(!JSON.stringify(receipt).includes('private'));
 const multi=await fixture(t,[start(),user(),{type:'approval/asked',data:{id:'a1',toolName:'bash'}},{type:'approval/asked',data:{id:'a2',toolName:'write_file'}},decided('a1')],{running:true});assert.deepEqual((await multi.connection.workReceipt(sessionId,requestId) as any).approvalTools,['write_file']);
 const missing=await fixture(t,[start(),user(),{type:'approval/asked',data:{id:'a1',reason:'private',toolName:'private-token-as-name'}}],{running:true});assert.deepEqual((await missing.connection.workReceipt(sessionId,requestId) as any).approvalTools,[]);
 assert.ok([...f.seen,...multi.seen,...missing.seen].every(x=>['session/list','session/page'].includes(x.method)));
});
