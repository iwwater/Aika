// NEXT-03: one behavioral contract, two wire protocols (OpenAI-compatible SSE, Gemini generateContent).
// Protocol fixtures re-express the legacy provider conformance scenarios (cumulative deltas, byte-split
// UTF-8, unified failures, cancellation) against the upstream DialogueProvider port.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DialogueContext, DialogueProvider, DialogueRequest } from '../../contracts/index.js';
import { ProviderHttpError, ProviderTransport, denyPaidCalls } from '../../providers/transport.js';
import { createAikaDialogueProvider, GeminiDialogueProvider, OpenAiCompatibleDialogueProvider } from '../../providers/aika-dialogue.js';
import { nextScope, tick } from './harness.js';

const API_KEY = 'test-only-key';
const SYSTEM_PROMPT = '你是Aika。';
const FULL_TEXT = 'こんにちは、我是Aika。😊';
const DASHES = ['こんに', 'ちは、我是A', 'ika。', '😊'];

interface CallRecord { url: string; init: RequestInit }

interface Fixture {
  provider: DialogueProvider;
  calls: CallRecord[];
  outcomes: string[];
  authorizeCount(): number;
}

function recordingAuthorizer() {
  const outcomes: string[] = [];
  let authorizeCount = 0;
  return {
    outcomes,
    get count() { return authorizeCount; },
    authorizer: {
      async authorize() {
        authorizeCount++;
        return { async settle(outcome: { status: string }) { outcomes.push(outcome.status); } };
      }
    }
  };
}

function buildFixture(protocol: 'openai-compatible' | 'gemini', handler: (url: string, init: RequestInit) => Promise<Response> | Response): Fixture {
  const calls: CallRecord[] = [];
  const { outcomes, authorizer } = recordingAuthorizer();
  const fetcher = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    const record: CallRecord = { url: String(url), init: init ?? {} };
    calls.push(record);
    return handler(record.url, record.init);
  }) as unknown as typeof fetch;
  const transport = new ProviderTransport(fetcher);
  const recording = recordingAuthorizer();
  const config = {
    endpoint: protocol === 'openai-compatible' ? 'https://unit.invalid/chat/completions' : 'https://unit.invalid/v1beta/models/gemini-2.0-flash:generateContent',
    model: protocol === 'openai-compatible' ? 'deepseek-chat' : 'gemini-2.0-flash',
    apiKey: () => API_KEY,
    authorizer: recording.authorizer
  };
  const provider = protocol === 'openai-compatible'
    ? new OpenAiCompatibleDialogueProvider(transport, config, SYSTEM_PROMPT)
    : new GeminiDialogueProvider(transport, config, SYSTEM_PROMPT);
  return { provider, calls, outcomes: recording.outcomes, authorizeCount: () => recording.count };
}

function sseResponse(frames: string[], finish: 'stop' | 'length' | null = 'stop'): Response {
  const wire = [
    ...frames.map(text => JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })),
    ...(finish ? [JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })] : []),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 5 } }),
    '[DONE]'
  ];
  const payload = wire.map(frame => `data: ${frame}\r\n\r\n`).join('');
  const encoded = new TextEncoder().encode(payload);
  return new Response(new ReadableStream({
    start(controller) {
      // Byte-by-byte enqueuing splits multi-byte UTF-8 and CRLF across transport chunks.
      for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function geminiResponse(parts: string[], finish = 'STOP'): Response {
  const payload = JSON.stringify({ candidates: [{ content: { parts: parts.map(text => ({ text })), role: 'model' }, finishReason: finish }], usageMetadata: { totalTokenCount: 8 } });
  const encoded = new TextEncoder().encode(payload);
  return new Response(new ReadableStream({
    start(controller) {
      for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function dialogueRequest(turnId = 'turn-a'): DialogueRequest {
  const scope = nextScope(turnId);
  const context: DialogueContext = {
    scope,
    characterPrompt: SYSTEM_PROMPT,
    recent: [
      { characterId: scope.characterId, id: 'prev:user', role: 'user', text: '早上好', createdAt: '2026-09-19T00:00:00.000Z' },
      { characterId: scope.characterId, id: 'prev:assistant', role: 'assistant', text: '早。', createdAt: '2026-09-19T00:00:00.000Z' }
    ],
    summary: '',
    memories: [],
    perception: null,
    inputTokenBudget: 5000
  };
  return { scope, text: '今天穿什么好看', context };
}

interface ProtocolHarness {
  name: 'openai-compatible' | 'gemini';
  happy(): Fixture;
  broken(): Fixture;
  empty(): Fixture;
  malformed(): Fixture;
  neverEnding(controller: AbortController): Fixture;
}

function harnessFor(name: 'openai-compatible' | 'gemini'): ProtocolHarness {
  return {
    name,
    happy: () => buildFixture(name, () => name === 'openai-compatible' ? sseResponse(DASHES) : geminiResponse(DASHES)),
    broken: () => buildFixture(name, () => new Response('upstream exploded', { status: name === 'openai-compatible' ? 500 : 503 })),
    empty: () => buildFixture(name, () => name === 'openai-compatible' ? sseResponse([], 'stop') : geminiResponse([], 'STOP')),
    malformed: () => buildFixture(name, () => name === 'openai-compatible' ? sseResponse(['碎片'], 'length') : geminiResponse(['文本'], 'MAX_TOKENS')),
    neverEnding: (controller: AbortController) => buildFixture(name, () => new Response(new ReadableStream({
      start(controller2) {
        // A stalled upstream: the body errors when the caller aborts, mirroring connection teardown.
        controller.signal.addEventListener('abort', () => controller2.error(new Error('connection aborted')), { once: true });
      }
    }), { status: 200 }))
  };
}

for (const harness of [harnessFor('openai-compatible'), harnessFor('gemini')]) {
  test(`[${harness.name}] happy path: full text, single request, endpoint/model/headers as configured`, async () => {
    const fixture = harness.happy();
    const request = dialogueRequest();
    const reply = await fixture.provider.reply(request, new AbortController().signal);
    assert.equal(reply.text, FULL_TEXT);
    assert.equal(reply.scope.turnId, request.scope.turnId);
    assert.equal(fixture.authorizeCount(), 1);
    assert.deepEqual(fixture.outcomes, ['success']);
    assert.equal(fixture.calls.length, 1);
    const call = fixture.calls[0]!;
    if (harness.name === 'openai-compatible') {
      assert.equal(call.url, 'https://unit.invalid/chat/completions');
      const body = JSON.parse(String(call.init.body)) as { model: string; stream: boolean; messages: { role: string; content: string }[] };
      assert.equal(body.model, 'deepseek-chat', 'configured model is actually sent');
      assert.equal(body.stream, true);
      assert.equal(body.messages[0]!.role, 'system');
      assert.equal(body.messages[0]!.content, SYSTEM_PROMPT, 'the profile prompt is the system context');
      assert.equal(body.messages.at(-1)!.role, 'user');
      assert.equal(body.messages.at(-1)!.content, '今天穿什么好看');
      assert.ok(JSON.stringify(body.messages).includes('早上好'), 'previous turns are part of the request');
      const headers = call.init.headers as Record<string, string>;
      assert.equal(headers.Authorization, `Bearer ${API_KEY}`);
    } else {
      assert.ok(call.url.includes('models/gemini-2.0-flash:generateContent'), 'configured model is part of the Gemini URL');
      const body = JSON.parse(String(call.init.body)) as { model?: string; contents: { role: string; parts: { text: string }[] }[]; systemInstruction: { parts: { text: string }[] } };
      assert.equal(body.model, undefined, 'Gemini body must not carry a model field (the URL carries it)');
      assert.equal(body.systemInstruction.parts[0]!.text, SYSTEM_PROMPT);
      assert.equal(body.contents.at(-1)!.role, 'user');
      assert.equal(body.contents.at(-1)!.parts[0]!.text, '今天穿什么好看');
      const headers = call.init.headers as Record<string, string>;
      assert.equal(headers['x-goog-api-key'], API_KEY);
      assert.equal(headers.Authorization, undefined, 'no bearer header is sent for the key');
    }
  });

  test(`[${harness.name}] selected memories are included in the provider input exactly once`, async () => {
    const fixture = harness.happy();
    const base = dialogueRequest();
    const memories: DialogueContext['memories'] = [
      { origin: 'conversation', characterId: base.scope.characterId, id: 'mem-1', version: 1, text: '去年夏天我们去了海边', sourceIds: [] },
      { origin: 'manual', characterId: base.scope.characterId, id: 'mem-2', version: 2, text: '她不喜欢下雨天', sourceIds: ['mem-1'] }
    ];
    const request: DialogueRequest = { ...base, context: { ...base.context, memories } };
    const reply = await fixture.provider.reply(request, new AbortController().signal);
    assert.equal(reply.text, FULL_TEXT);
    assert.equal(fixture.calls.length, 1);
    const call = fixture.calls[0]!;
    const serialized = String(call.init.body);
    assert.ok(serialized.includes('去年夏天我们去了海边'), 'first memory text reaches the provider');
    assert.ok(serialized.includes('她不喜欢下雨天'), 'second memory text reaches the provider');
    assert.equal((serialized.match(/相关记忆/g) ?? []).length, 1, 'the memory block appears exactly once');
  });

  test(`[${harness.name}] non-2xx maps to a clear provider error without leaking the key`, async () => {
    const fixture = harness.broken();
    await assert.rejects(
      fixture.provider.reply(dialogueRequest(), new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error instanceof ProviderHttpError || /Provider HTTP/.test(error.message));
        assert.ok(!String(error.message).includes(API_KEY));
        return true;
      }
    );
    assert.equal(fixture.calls.length, 1, 'no retry loop');
    assert.deepEqual(fixture.outcomes, ['failed']);
  });

  test(`[${harness.name}] in-flight abort rejects deterministically; late stream data has no effect`, async () => {
    const controller = new AbortController();
    const fixture = harness.neverEnding(controller);
    const pending = fixture.provider.reply(dialogueRequest(), controller.signal);
    while (fixture.calls.length === 0) await tick();
    controller.abort();
    await assert.rejects(pending);
    await tick();
    assert.equal(fixture.calls.length, 1, 'exactly one request, no infinite retry');
    assert.deepEqual(fixture.outcomes, ['cancelled']);
  });

  test(`[${harness.name}] pre-aborted signal never reaches the network`, async () => {
    const fixture = harness.happy();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fixture.provider.reply(dialogueRequest(), controller.signal));
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.authorizeCount(), 0, 'the authorizer is not even consulted');
  });

  test(`[${harness.name}] empty replies are rejected`, async () => {
    const fixture = harness.empty();
    await assert.rejects(
      fixture.provider.reply(dialogueRequest(), new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(/Incomplete|empty|no candidates|Invalid/i.test(error.message));
        assert.ok(!error.message.includes(API_KEY));
        return true;
      }
    );
  });

  test(`[${harness.name}] non-stop terminations are rejected, never passed off as complete`, async () => {
    const fixture = harness.malformed();
    await assert.rejects(
      fixture.provider.reply(dialogueRequest(), new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(/truncated|finish reason|MAX_TOKENS/i.test(error.message));
        return true;
      }
    );
  });
}

test('selection factory maps protocols without pipeline branching', () => {
  const transport = new ProviderTransport();
  const config = (protocol: 'openai-compatible' | 'gemini') => ({ protocol, endpoint: 'https://unit.invalid/x', model: 'm', apiKey: () => API_KEY, authorizer: denyPaidCalls });
  assert.ok(createAikaDialogueProvider(config('openai-compatible'), transport, SYSTEM_PROMPT) instanceof OpenAiCompatibleDialogueProvider);
  assert.ok(createAikaDialogueProvider(config('gemini'), transport, SYSTEM_PROMPT) instanceof GeminiDialogueProvider);
  assert.throws(() => createAikaDialogueProvider({ protocol: 'anthropic' as 'gemini', endpoint: 'https://unit.invalid/x', model: 'm', apiKey: () => API_KEY, authorizer: denyPaidCalls }, transport, SYSTEM_PROMPT), /protocol/i);
});
