import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendSession, type BackendPorts } from '../../app/backend-session.js';
import { compileMemoryPrototype, prototypeSnapshot, type SemanticDeclaration } from '../../app/memory-planning-prototype.js';
import type { DialogueRequest, TurnScope } from '../../contracts/index.js';
import type { MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import type { MemoryRecord } from '../../memory/ledger.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { MemoryMediaStore } from '../../media/store.js';
import { TrialAdmission } from '../../app/trial-admission.js';
import { ProviderTransport } from '../../providers/transport.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const firstText = '我每周五练吉他。', secondText = '今天的阳光不错。';
const receipts: unknown[] = [];
after(() => {
  if (process.env.W0_I_BACKGROUND_RECEIPT) writeFileSync(process.env.W0_I_BACKGROUND_RECEIPT,
    JSON.stringify({ evidence: 'Controlled semantic annotations, actual compiler, BackendSession and SQLite; synthetic silent playback', receipts }, null, 2) + '\n');
});

for (const independent of [true, false]) {
  test(`actual SQLite foreground never waits for strict writer: classifier=${independent}`, { timeout: 10_000 }, async t => {
    const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../.local/memory-background-local-v1/tmp');
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(join(parent, 'integration-'));
    const store = new SqliteMemoryStore({ filename: join(directory, 'state.sqlite'), retention: CONFIRMED_RETENTION,
      invitations: confirmedInvitationPolicy('Asia/Shanghai') });
    const entered = deferred<void>(), release = deferred<void>(), playedFirst = deferred<void>(), playedSecond = deferred<void>();
    const calls: string[] = [], replies: DialogueRequest[] = [], failures: string[] = [], compilerTrace: unknown[] = [];
    let firstScope: TurnScope | undefined, plans = 0, session: BackendSession | undefined;
    t.after(async () => {
      release.resolve();
      try { await session?.close(); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
    });
    const all = (scope: TurnScope) => (['transcript', 'memory', 'summary', 'keyword_index', 'vector_index', 'context_cache', 'emotion'] as MemoryRecord['kind'][])
      .flatMap(kind => store.visible(scope, kind));
    const memory = new SqliteLifecycleMemoryPort(store, {
      context: { inputTokenBudget: 30_000, maxRecentMessages: 12, maxMemories: 8, summaryLimit: 4,
        countTokens: (context, text) => JSON.stringify(context).length + text.length, relevance: () => 1 },
      turn: { inputTokenBudget: 30_000, countTokens: input => JSON.stringify(input).length, provider: {
        async plan(input: MemoryTurnInput, signal: AbortSignal) {
          plans++;
          const snapshot = prototypeSnapshot(input, all(input.scope));
          const source = input.sources.find(item => item.id === input.currentMessageId)!;
          const evidence = { source: { id: source.id, version: source.version }, quote: { text: source.text } };
          const declaration: SemanticDeclaration = { annotationSource: 'human_controlled', scope: input.scope,
            request: 'none', erase: [], assessments: [], reason: 'Explicit synthetic annotation, no real model',
            facts: source.text === firstText ? [{ intent: 'remember', statement: source.text, evidence: [evidence], basis: [evidence] }] : [] };
          if (source.text === firstText) {
            firstScope = input.scope; calls.push('planning-held'); entered.resolve(); await release.promise;
          }
          signal.throwIfAborted();
          const compiled = compileMemoryPrototype(snapshot, declaration, signal);
          compilerTrace.push({ snapshot, declaration, compiled });
          assert.equal(compiled.status, 'ready');
          if (compiled.status !== 'ready') throw new Error('Controlled declaration did not compile');
          calls.push('compiled'); return compiled.plan;
        },
      } },
      summary: { minMessages: 100, maxMessages: 100, inputTokenBudget: 30_000, countTokens: input => JSON.stringify(input).length,
        provider: { async summarize() { throw new Error('This bounded fixture must not reach summary generation'); } } },
    });
    const media = new MemoryMediaStore();
    const admissionInputs: {currentInput:string;hostScope:TurnScope}[] = [];
    const admission = new TrialAdmission({ endpoint: 'https://example.invalid/admission', model: 'controlled-judge', apiKey: () => 'controlled-key',
      authorizer: { async authorize() { return { async settle() {} }; } } }, new ProviderTransport(async (_url, options) => {
        const body = JSON.parse(String(options?.body)), input = JSON.parse(body.messages[1].content);
        admissionInputs.push(input);
        assert.equal(input.hostScope.characterId, 'companion');
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ scope: input.hostScope,
          request: 'none', reason: 'Explicit controlled semantic annotation, no real model' }) } }] });
      }), (scope, text, signal) => memory.context(scope, text, null, signal));
    const ports: BackendPorts = { memory, backgroundMemory: memory, mediaStore: media,
      ...(independent ? { classifyMemoryRequest: admission.foregroundRequest.bind(admission) } : {}),
      perception: { async perceive() { throw new Error('No device in this controlled text test'); } },
      dialogue: { async reply(request) {
        replies.push(request); calls.push('reply');
        return { scope: request.scope, text: '听到了。', expression: { emotion: 'neutral', intensity: 0, delivery: '自然', gesture: null } };
      } },
      tts: { async synthesize(reply) { return { ...reply, audio: await media.put(reply.scope, Uint8Array.of(1, 2), 'audio/wav'), durationMs: 10, synchronization: 'amplitude' }; } },
    };
    session = new BackendSession(ports, message => {
      // A new command can arrive before the previous pipeline's final microtask.
      // The real renderer acknowledges both cleanup requests in this situation.
      if (message.channel === 'stop' || message.channel === 'capture_stop') queueMicrotask(() => {
        void session!.receiveLine(JSON.stringify({ channel: 'ack', requestId: message.requestId }));
      });
      if (message.channel === 'play') queueMicrotask(() => {
        const current = session!;
        for (const type of ['started', 'ended'] as const) void current.receiveLine(JSON.stringify({ channel: 'playback', requestId: message.requestId,
          event: { type, scope: message.tts.scope, at: new Date().toISOString(), ...(type === 'started' ? { audioId: message.tts.audio.id } : {}) } }));
      });
      if (message.channel === 'event' && message.event.type === 'playback' && message.event.playback.type === 'ended') {
        if (replies.length === 1) playedFirst.resolve(); else playedSecond.resolve();
      }
    }, () => store.close(), (_scope, kind) => failures.push(kind));
    // Extra desktop fields cannot choose trusted host scheduling.
    await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: firstText, isMemoryIndependent: true } }));
    await entered.promise;
    {
      await playedFirst.promise;
      assert.equal(replies[0]?.memoryOutcome, undefined, 'Pending work must not be called unchanged or completed');
      await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: secondText } }));
      await playedSecond.promise;
      assert.equal(plans, 1, 'The same-role second heavy job remains queued');
      assert.equal(store.visible(firstScope!, 'memory').length, 0);
      assert.equal(store.visible(firstScope!, 'transcript').filter(row => row.message?.role === 'assistant').length, 2,
        'Foreground assistant writes must finish before releasing the heavy plan');
      assert.equal(calls.includes('compiled'), false);
    }
    release.resolve();
    await session.drain();
    const memories = store.visible(firstScope!, 'memory');
    assert.equal(memories.length, 1); assert.equal(memories[0]!.text, firstText);
    assert.throws(() => store.visible({ ...firstScope!, characterId: 'sweetheart' }, 'memory'), /unknown_character/);
    assert.equal(failures.length, 0); assert.equal(media.count, 0);
    assert.equal(replies.length, 2);
    assert.equal(admissionInputs.length,independent?2:0);
    if(independent)assert.deepEqual(admissionInputs.map(i=>i.currentInput),[firstText,secondText]);
    receipts.push({ independent, admissionInputs, calls, compilerTrace, replies, actualRecords: all(firstScope!),
      legacyRoleRejected: true, failures, mediaCount: media.count });
  });
}
