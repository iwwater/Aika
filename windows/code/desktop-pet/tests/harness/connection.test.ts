import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HarnessConnection } from '../../harness/connection.js';
import { randomUUID } from 'node:crypto';

test('paged cold history binds an exact request to its failed turn, never an unrelated latest completion', async t => {
  const first = randomUUID(), other = randomUUID(), sessionId = 'session-' + randomUUID();
  const records = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user', rpcId: first }, content: 'private task' } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'sensitive provider body' } } } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'user/message', data: { source: { kind: 'user', rpcId: other } } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ type: 'event', event: { ...event, seq } }));
  let pages = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/?token=synthetic') { res.writeHead(303, { Location: '/', 'Set-Cookie': 'dsh_session=synthetic.cookie' }); res.end(); return; }
    assert.equal(req.url, '/api/session/page');
    const parts = []; for await (const part of req) parts.push(part); const body = JSON.parse(Buffer.concat(parts).toString()), input = body.payload.args.request;
    assert.deepEqual(input.address, { kind: 'session', sessionId }); assert.equal(input.throughSeq, 5); pages++;
    // Deliberately cut the earlier page between turn/start and user/message.
    const range = input.beforeSeq === undefined ? [2, 6] : input.beforeSeq === 2 ? [1, 2] : [0, 1];
    const value = { records: records.slice(range[0], range[1]), hasMore: range[0] !== 0 };
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connection = new HarnessConnection(async () => `http://127.0.0.1:${address.port}/?token=synthetic`);
  assert.deepEqual(await connection.requestTerminal(sessionId, first, 5), { status: 'ended', turn: 1, reason: 'error', errorCode: 'MISSING_CREDENTIAL' }); assert.equal(pages, 3);
  assert.deepEqual(await connection.requestTerminal(sessionId, other, 5), { status: 'ended', turn: 2, reason: 'completed' });
  assert.deepEqual(await connection.requestTerminal(sessionId, randomUUID(), 5), { status: 'unknown' });
});

test('relay creation freezes preset/model and submits only the confirmed operation identifier', async t => {
  const sessionId = 'session-' + randomUUID(), requestId = randomUUID(), operationId = randomUUID();
  const seen: any[] = [];
  const usage = { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5 };
  const model = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
  const server = createServer(async (req, res) => {
    if (req.url === '/?token=synthetic') { res.writeHead(303, { Location: '/', 'Set-Cookie': 'dsh_session=synthetic.cookie' }); res.end(); return; }
    const parts = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString()); seen.push(body);
    const value = body.method === 'session/create' ? { sessionId } : body.method === 'session/rename' ? { title: body.payload.args.request.title, seq: 3 } : body.method === 'session/selectModel' ? { selected: model } : body.method === 'session/prompt' ? { accepted: true } : { items: [
      { sessionId: 'unrelated-private-session', title: 'Private', projections: { values: { tokenUsage: { ...usage, outputTokens: 99999 } } } },
      { sessionId, running: false, projections: { values: { tokenUsage: usage, agentPreset: 'desktop-pet-relay-v1', modelSelection: { lastUsed: model }, title: 'Private title' } } },
    ] };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connection = new HarnessConnection(async () => `http://127.0.0.1:${address.port}/?token=synthetic`);
  await connection.createRelaySession(sessionId, 'desktop-pet-relay-v1', '/synthetic/workspace');
  await connection.submitConfirmedOperation(sessionId, requestId, operationId);
  assert.deepEqual(seen.map(x => x.method), ['session/create', 'session/rename', 'session/selectModel', 'session/prompt']);
  assert.deepEqual(seen[0].payload.args, { request: { sessionId, agentPreset: 'desktop-pet-relay-v1', cwd: '/synthetic/workspace' } });
  assert.deepEqual(seen[1].payload.args, { request: { sessionId, title: 'Desktop pet relay ' + sessionId.slice(-8) } });
  assert.deepEqual(seen[2].payload.args, { request: { sessionId, ...model } });
  assert.equal(seen[3].payload.args.request.requestId, requestId); assert.equal(seen[3].payload.args.request.mode, 'queue');
  assert.ok(seen[3].payload.args.request.content[0].text.includes(operationId));
  assert.deepEqual(await connection.relayMetrics(sessionId), { sessionId, running: false, preset: 'desktop-pet-relay-v1', model, usage });
});

test('real HTTP authentication uses root exchange and exact cold list, with private response discarded', async t => {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url!);
    if (req.url === '/?token=synthetic-secret') {
      res.writeHead(303, { Location: '/', 'Set-Cookie': 'dsh_session=synthetic.cookie; HttpOnly; SameSite=Strict' }); res.end(); return;
    }
    assert.equal(req.url, '/api/session/list'); assert.equal(req.method, 'POST');
    assert.equal(req.headers.cookie, 'dsh_session=synthetic.cookie');
    assert.equal(req.headers.authorization, undefined);
    const parts = []; for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    assert.equal(body.method, 'session/list'); assert.deepEqual(body.payload, { args: { _request: {} } });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items: [{ title: 'synthetic-private-title', history: 'synthetic-private-history' }] } } }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const snapshot = await new HarnessConnection(async () => `http://127.0.0.1:${address.port}/?token=synthetic-secret`).probe();
  assert.equal(snapshot.state, 'ready'); assert.equal(snapshot.codexDelivery, 'unverified');
  assert.equal(JSON.stringify(snapshot).includes('synthetic'), false); assert.equal(requests.length, 2);
});

test('untrusted host, duplicate tokens and error text cannot expose launcher credentials', async () => {
  for (const url of ['https://example.invalid/?token=synthetic-secret', 'http://localhost/?token=synthetic-secret', 'http://127.0.0.1/?token=a&token=b', 'http://127.0.0.1/api/file?token=a']) {
    assert.equal((await new HarnessConnection(async () => url).probe()).state, 'authentication_required');
  }
  const result = await new HarnessConnection(async () => { throw Error('synthetic-secret'); }).probe();
  assert.equal(result.state, 'unavailable'); assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});

for (const mode of ['redirect', 'mismatch', 'unauthorized', 'slow'] as const) test(`connection ${mode} remains unverified without repeat or redirect`, async t => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (mode === 'slow') return;
    if (req.url?.startsWith('/?')) {
      res.writeHead(303, { Location: mode === 'redirect' ? 'http://example.invalid/' : '/', 'Set-Cookie': 'dsh_session=test.cookie' }); res.end(); return;
    }
    if (mode === 'unauthorized') { res.writeHead(401); res.end('private-error'); return; }
    res.end(JSON.stringify({ type: 'server-response', rpcId: 'wrong-request', result: { ok: true, value: { items: [] } } }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const result = await new HarnessConnection(async () => `http://127.0.0.1:${address.port}/?token=test`, mode === 'slow' ? 30 : 5000).probe();
  assert.equal(result.state, mode === 'mismatch' ? 'incompatible' : mode === 'slow' ? 'unavailable' : 'authentication_required');
  assert.equal(result.codexDelivery, 'unverified'); assert.equal(requests, mode === 'redirect' || mode === 'slow' ? 1 : 2);
});
