// FIX61-02 RED->GREEN: production model discovery for the two protocols this build implements.
// The supplier side is a fake fetch; the code under test is the production discovery path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelDiscovery, resolveModelsUrl, ModelDiscoveryError } from '../../management/model-discovery.js';

const KEY = 'sk-fix6102-secret-value';
const OPENAI_ENDPOINT = 'https://gw.example.com/v1/chat/completions';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function recorder(handler: (url: string, init: RequestInit, round: number) => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const credentials = { key: (ref: string) => { if (ref !== 'ref-a') throw new Error('unknown credential reference'); return KEY; } };
const discovery = (fetcher: typeof fetch, options: { credentialRefs?: readonly string[] } = {}) => new ModelDiscovery({
  credentials: options.credentialRefs ? { key: ref => { if (!options.credentialRefs!.includes(ref)) throw new Error('unknown credential reference'); return KEY; } } : credentials,
  fetch: fetcher
});
const headerOf = (init: RequestInit, name: string) => (init.headers as Record<string, string> | undefined)?.[name];

// 02-A ---------------------------------------------------------------------------------------------
test('02-A openai-compatible reads the models resource of an explicit apiBase and never guesses the inference path', async () => {
  const { fetcher, calls } = recorder(() => json({ object: 'list', data: [{ id: 'custom-chat-2026', object: 'model', owned_by: 'gw' }, { id: 'custom-embed' }] }));
  const result = await discovery(fetcher).list({ protocol: 'openai-compatible', endpoint: OPENAI_ENDPOINT, credentialRef: 'ref-a' });

  assert.equal(calls.length, 1, 'one page is one request');
  assert.equal(calls[0]!.url, 'https://gw.example.com/v1/models', 'the models resource is derived from the apiBase, not by appending /v1/models to the inference URL');
  assert.equal(calls[0]!.init.method, 'GET');
  assert.equal(calls[0]!.init.redirect, 'error', 'a redirect must never carry the credential elsewhere');
  assert.equal(headerOf(calls[0]!.init, 'Authorization'), 'Bearer ' + KEY);
  assert.deepEqual(result.items.map(item => item.id), ['custom-chat-2026', 'custom-embed']);
  assert.equal(result.items[0]!.label, 'custom-chat-2026');
  assert.equal(result.items[0]!.capabilities.evidence, 'unknown', 'the OpenAI model object carries no capability data, so capabilities stay unknown');
  assert.deepEqual(result.items[0]!.capabilities.methods, []);
  assert.equal(result.protocol, 'openai-compatible');
  assert.equal(result.truncated, false);
  assert.equal(result.nextCursor, undefined);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)), 'checkedAt is a real timestamp');
});

test('02-A an unambiguous inference URL is refused instead of appending /v1/models to it', () => {
  assert.throws(() => resolveModelsUrl('openai-compatible', 'https://gw.example.com/custom/infer'), (error: unknown) =>
    error instanceof ModelDiscoveryError && error.code === 'invalid_request' && /modelsEndpoint/.test(error.message));
  // The documented OpenAI-compatible suffixes and version markers are unambiguous and stay supported.
  assert.equal(resolveModelsUrl('openai-compatible', 'https://gw.example.com/v1/chat/completions'), 'https://gw.example.com/v1/models');
  assert.equal(resolveModelsUrl('openai-compatible', 'https://api.deepseek.com/chat/completions'), 'https://api.deepseek.com/models');
  assert.equal(resolveModelsUrl('openai-compatible', 'https://gw.example.com/v1'), 'https://gw.example.com/v1/models');
  assert.equal(resolveModelsUrl('openai-compatible', 'https://gw.example.com/models'), 'https://gw.example.com/models');
  // An explicit modelsEndpoint always wins and may be any allowed origin.
  assert.equal(resolveModelsUrl('openai-compatible', 'https://gw.example.com/custom/infer', 'https://gw.example.com/openai/models'), 'https://gw.example.com/openai/models');
  assert.equal(resolveModelsUrl('gemini', GEMINI_ENDPOINT), 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.equal(resolveModelsUrl('gemini', 'https://generativelanguage.googleapis.com/v1beta'), 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.throws(() => resolveModelsUrl('gemini', 'https://gw.example.com/chat'), (error: unknown) =>
    error instanceof ModelDiscoveryError && error.code === 'invalid_request');
});

test('02-A gemini models.list paginates with a page token and reports declared methods without inventing capabilities', async () => {
  const { fetcher, calls } = recorder((url, init) => url.includes('pageToken=next-1')
    ? json({ models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent', 'countTokens'] }] })
    : json({ models: [
        { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] }
      ], nextPageToken: 'next-1' }));
  const result = await discovery(fetcher).list({ protocol: 'gemini', endpoint: GEMINI_ENDPOINT, credentialRef: 'ref-a' });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.match(calls[1]!.url, /pageToken=next-1/);
  assert.equal(headerOf(calls[0]!.init, 'x-goog-api-key'), KEY, 'the key rides in a header, never in the request URL');
  assert.ok(calls.every(call => !call.url.includes(KEY)), 'no request URL may embed the credential');
  assert.deepEqual(result.items.map(item => item.id), ['gemini-2.0-flash', 'text-embedding-004', 'gemini-2.5-pro']);
  assert.equal(result.items[0]!.label, 'Gemini 2.0 Flash');
  assert.deepEqual(result.items[1]!.capabilities.methods, ['embedContent'], 'capabilities come from supportedGenerationMethods only');
  assert.equal(result.items[1]!.capabilities.evidence, 'declared');
  assert.equal(result.nextCursor, undefined, 'the last page has no cursor');
});

test('02-A an empty model list is a normal result, not a failure', async () => {
  const { fetcher } = recorder(() => json({ object: 'list', data: [] }));
  const result = await discovery(fetcher).list({ protocol: 'openai-compatible', endpoint: OPENAI_ENDPOINT, credentialRef: 'ref-a' });
  assert.deepEqual(result.items, []);
  assert.equal(result.truncated, false);
});

test('02-A duplicate ids are reported once across pages', async () => {
  const { fetcher } = recorder((url) => url.includes('pageToken=1')
    ? json({ models: [{ name: 'models/dup' }, { name: 'models/second' }] })
    : json({ models: [{ name: 'models/dup' }, { name: 'models/first' }], nextPageToken: '1' }));
  const result = await discovery(fetcher).list({ protocol: 'gemini', endpoint: GEMINI_ENDPOINT, credentialRef: 'ref-a' });
  assert.deepEqual(result.items.map(item => item.id), ['dup', 'first', 'second']);
});

test('02-A a repeating page token stops discovery instead of looping', async () => {
  const { fetcher, calls } = recorder(() => json({ models: [{ name: 'models/loop' }], nextPageToken: 'same-token' }));
  const result = await discovery(fetcher).list({ protocol: 'gemini', endpoint: GEMINI_ENDPOINT, credentialRef: 'ref-a' });
  assert.equal(calls.length, 2, 'the repeated token is detected on the second page');
  assert.equal(result.truncated, true);
  assert.equal(result.items.length, 1);
});

test('02-A page and item counts stay bounded', async () => {
  let round = 0;
  const paged = recorder(() => { round++; return json({ models: Array.from({ length: 60 }, (_, i) => ({ name: `models/m${round}-${i}` })), nextPageToken: 'token-' + round }); });
  const bounded = await discovery(paged.fetcher).list({ protocol: 'gemini', endpoint: GEMINI_ENDPOINT, credentialRef: 'ref-a' });
  assert.ok(paged.calls.length <= 20, 'at most twenty pages are requested');
  assert.equal(bounded.items.length, 1000, 'at most one thousand models are returned');
  assert.equal(bounded.truncated, true);

  const endless = recorder(() => json({ models: [{ name: 'models/again' }], nextPageToken: 'token-' + Math.random() }));
  const pageBound = await discovery(endless.fetcher).list({ protocol: 'gemini', endpoint: GEMINI_ENDPOINT, credentialRef: 'ref-a' });
  assert.equal(endless.calls.length, 20, 'an endless token chain stops at the page bound');
  assert.equal(pageBound.truncated, true);
});

test('02-A supplier failures are typed, sanitized and recoverable', async () => {
  const cases: readonly { status: number; body: string; code: string }[] = [
    { status: 401, body: JSON.stringify({ error: { message: 'invalid api key sk-fix6102-secret-value' } }), code: 'unauthorized' },
    { status: 403, body: JSON.stringify({ error: { message: 'forbidden' } }), code: 'unauthorized' },
    { status: 404, body: '<html>not found</html>', code: 'not_found' },
    { status: 429, body: JSON.stringify({ error: { message: 'slow down' } }), code: 'rate_limited' }
  ];
  for (const item of cases) {
    const { fetcher } = recorder(() => new Response(item.body, { status: item.status, headers: { 'content-type': 'application/json' } }));
    const failure = await discovery(fetcher).list({ protocol: 'openai-compatible', endpoint: OPENAI_ENDPOINT, credentialRef: 'ref-a' }).then(() => null, (error: unknown) => error as ModelDiscoveryError);
    assert.ok(failure, `HTTP ${item.status} must fail`);
    assert.equal(failure.code, item.code, `HTTP ${item.status} maps to ${item.code}`);
    assert.equal(failure.status, item.status);
    assert.ok(!failure.message.includes(KEY), 'a supplier echo of the key must never reach the caller');
    assert.ok(!failure.message.includes('sk-fix6102'), 'no key fragment may be echoed');
    assert.match(failure.message, /型号/, 'the message tells the user that manual entry is still available');
  }

  const nonJson = recorder(() => new Response('<html>gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  const malformed = await discovery(nonJson.fetcher).list({ protocol: 'openai-compatible', endpoint: OPENAI_ENDPOINT, credentialRef: 'ref-a' }).then(() => null, (error: unknown) => error as ModelDiscoveryError);
  assert.equal(malformed!.code, 'invalid_response');
  assert.ok(!malformed!.message.includes(KEY));

  const junk = recorder(() => json({ object: 'list', data: 'not-an-array' }));
  const wrongShape = await discovery(junk.fetcher).list({ protocol: 'openai-compatible', endpoint: OPENAI_ENDPOINT, credentialRef: 'ref-a' }).then(() => null, (error: unknown) => error as ModelDiscoveryError);
  assert.equal(wrongShape!.code, 'invalid_response');
});

test('02-A a slow supplier times out at ten seconds and a cancelled discovery stops', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hanging = (async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  })) as unknown as typeof fetch;

  const slow = discovery(hanging).list({ protocol: 'openai-compatible', endpoint: OPENAI_ENDPOINT, credentialRef: 'ref-a' }).then(() => null, (error: unknown) => error as ModelDiscoveryError);
  await flush();
  t.mock.timers.tick(9_999);
  await flush();
  t.mock.timers.tick(1);
  const timedOut = await slow;
  assert.ok(timedOut, 'a hanging supplier must not hang the management request');
  assert.equal(timedOut.code, 'timeout');
  assert.ok(!timedOut.message.includes(KEY));

  const controller = new AbortController();
  const cancelled = discovery(hanging).list({ protocol: 'openai-compatible', endpoint: OPENAI_ENDPOINT, credentialRef: 'ref-a', signal: controller.signal })
    .then(() => null, (error: unknown) => error as ModelDiscoveryError);
  await flush();
  controller.abort();
  const stopped = await cancelled;
  assert.equal(stopped?.code, 'cancelled');
  t.mock.timers.reset();
});

test('02-A an unknown credential reference or an unsupported protocol is refused before any network access', async () => {
  const { fetcher, calls } = recorder(() => json({ data: [] }));
  const unknownRef = await discovery(fetcher).list({ protocol: 'openai-compatible', endpoint: OPENAI_ENDPOINT, credentialRef: 'ref-missing' })
    .then(() => null, (error: unknown) => error as ModelDiscoveryError);
  assert.equal(unknownRef?.code, 'invalid_request');
  assert.equal(calls.length, 0, 'an unresolvable credential never reaches the network');

  const unsupported = await discovery(fetcher).list({ protocol: 'anthropic' as 'gemini', endpoint: OPENAI_ENDPOINT, credentialRef: 'ref-a' })
    .then(() => null, (error: unknown) => error as ModelDiscoveryError);
  assert.equal(unsupported?.code, 'invalid_request');
  assert.equal(calls.length, 0);

  const insecure = await discovery(fetcher).list({ protocol: 'openai-compatible', endpoint: 'https://gw.example.com/v1', modelsEndpoint: 'http://gw.example.com/v1/models', credentialRef: 'ref-a' })
    .then(() => null, (error: unknown) => error as ModelDiscoveryError);
  assert.equal(insecure?.code, 'invalid_request', 'a non-HTTPS models endpoint is refused');
  assert.equal(calls.length, 0);
});

test('02-A the production timeout branch is reachable without waiting the full deadline', async () => {
  // The real deadline above is exercised end to end; this case proves the same branch decides by its own
  // clock rather than by whatever the supplier does, using the injectable production timeout.
  const hanging = (async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  })) as unknown as typeof fetch;
  const quick = new ModelDiscovery({ credentials, fetch: hanging, timeoutMs: 25 });
  const failure = await quick.list({ protocol: 'gemini', endpoint: GEMINI_ENDPOINT, credentialRef: 'ref-a' })
    .then(() => null, (error: unknown) => error as ModelDiscoveryError);
  assert.equal(failure?.code, 'timeout');
  const other = await quick.list({ protocol: 'openai-compatible', endpoint: 'https://gw.example.com/v1', credentialRef: 'ref-a', modelsEndpoint: 'https://gw.example.com/v1/models' })
    .then(() => null, (error: unknown) => error as ModelDiscoveryError);
  assert.equal(other?.code, 'timeout');
});
