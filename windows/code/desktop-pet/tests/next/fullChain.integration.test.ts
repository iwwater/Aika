// NEXT-08 08-B/08-C: the full automatic chain over production components — NextTurnPort +
// DialoguePipeline + SqliteLifecycleMemoryPort + AikaTimelineRecorder on real temp SQLite.
// Faked external dependencies, annotated: the dialogue provider (scripted replies/gates), the
// TTS and playback ports (text/voice output), and the memory plan provider (noPlan). Real-service
// replay lives in tests/next/real; cross-session turn scoping is covered by
// turnController.contract.test.ts and memory.contract.test.ts and is not duplicated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DialogueReply, DialogueRequest, MemoryMaintenanceInput, TurnScope } from '../../contracts/index.js';
import type { MemoryTurnInput, MemoryTurnPlan } from '../../contracts/memory-lifecycle.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { DialoguePorts } from '../../core/dialogue-pipeline.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../../memory/sqlite-lifecycle-port.js';
import { MemoryMediaStore } from '../../media/store.js';
import { NextTurnPort, type TurnPortEvent } from '../../core/turn-port.js';
import { NextSpeechInput } from '../../core/speech-bridge.js';
import { AikaTimelineRecorder, AikaTimelineStore } from '../../management/aika-timeline.js';
import { deferred, tick } from './harness.js';

const NEUTRAL = { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } as const;
const noPlan = (input: MemoryTurnInput): MemoryTurnPlan =>
  ({ scope: input.scope, request: 'none', changes: [], suppressSources: [], clarification: null, reason: '无记忆相关内容' });

interface ReplyPlan { gate?: ReturnType<typeof deferred<void>>; text?: string; failure?: Error }

interface Chain {
  port: NextTurnPort;
  events: TurnPortEvent[];
  requests: DialogueRequest[];
  plans: Map<string, ReplyPlan>;
  timeline: AikaTimelineStore;
  submit(text: string): Promise<TurnScope>;
  waitForTerminal(scope: TurnScope): Promise<Extract<TurnPortEvent, { type: 'terminal' }>>;
  cleanup(): Promise<void>;
}

async function makeChain(): Promise<Chain> {
  const dir = await mkdtemp(join(tmpdir(), 'next-fullchain-'));
  const store = new SqliteMemoryStore({ filename: resolve(dir, 'companion.sqlite'), retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const lifecycle = new SqliteLifecycleMemoryPort(store, {
    context: { summaryLimit: 1000, inputTokenBudget: 5000, maxRecentMessages: 20, maxMemories: 5, countTokens: () => 0, relevance: () => 0 },
    turn: { inputTokenBudget: 4000, countTokens: () => 0, provider: { plan: async input => noPlan(input) }, maxSupplementaryPlans: 0 },
    summary: { inputTokenBudget: 4000, countTokens: () => 0, minMessages: 50, maxMessages: 100, provider: { summarize: async input => ({ scope: input.scope, text: '摘要', sourceVersions: [] }) } }
  }, { propose: async (_input: MemoryMaintenanceInput) => [] });

  const plans = new Map<string, ReplyPlan>();
  const requests: DialogueRequest[] = [];
  const media = new MemoryMediaStore();
  const ports: DialoguePorts = {
    outputMode: 'text',
    // fake: perception is unused in text mode
    perception: { perceive: async () => { throw new Error('perception unused in this suite'); } },
    dialogue: {
      // fake: scripted dialogue provider keyed by the submitted text (plans must be set before submit)
      reply: async (request, _signal) => {
        requests.push(request);
        const plan = plans.get(request.text);
        if (plan?.gate) await plan.gate.promise;
        if (plan?.failure) throw plan.failure;
        const reply: DialogueReply = { scope: request.scope, text: plan?.text ?? `回复：${request.text}`, expression: { ...NEUTRAL } };
        return reply;
      }
    },
    // fake: no real synthesis or playback in text mode
    tts: { synthesize: async () => { throw new Error('tts unused in this suite'); } },
    playback: { play: async () => {}, stop: async () => {} },
    memory: lifecycle,
    memoryLifecycle: lifecycle,
    mediaStore: { put: (scope, bytes, mimeType) => media.put(scope, bytes, mimeType), read: (scope, asset) => media.read(scope, asset), releaseScope: async () => {} }
  };
  const port = new NextTurnPort(ports);
  const events: TurnPortEvent[] = [];
  port.subscribe(event => events.push(event));
  const timeline = await AikaTimelineStore.open(resolve(dir, 'timeline.sqlite'));
  const timelineErrors: string[] = [];
  const stopRecorder = new AikaTimelineRecorder(port, timeline, { onError: error => timelineErrors.push(String(error)) }).start();

  const waitForTerminal = (scope: TurnScope) => new Promise<Extract<TurnPortEvent, { type: 'terminal' }>>(done => {
    const seen = events.find(event => event.type === 'terminal' && event.scope.turnId === scope.turnId);
    if (seen) return done(seen as Extract<TurnPortEvent, { type: 'terminal' }>);
    const unsubscribe = port.subscribe(event => {
      if (event.type === 'terminal' && event.scope.turnId === scope.turnId) { unsubscribe(); done(event); }
    });
  });

  return {
    port, events, requests, plans, timeline,
    submit: text => port.submit({ text }),
    waitForTerminal,
    cleanup: async () => { stopRecorder(); store.close(); await timeline.close(); await rm(dir, { recursive: true, force: true }); }
  };
}

test('08-B full chain: multi-turn context flows and the timeline records each turn once', async () => {
  const chain = await makeChain();
  try {
    const scopeA = await chain.submit('我叫小明，请记住这个名字。');
    const terminalA = await chain.waitForTerminal(scopeA);
    assert.equal(terminalA.status, 'completed');

    const scopeB = await chain.submit('我刚才说我叫什么？');
    const terminalB = await chain.waitForTerminal(scopeB);
    assert.equal(terminalB.status, 'completed');

    const recentTexts = chain.requests[1]!.context.recent.map(message => message.text);
    assert.ok(recentTexts.includes('我叫小明，请记住这个名字。'), 'turn-A user message must be in turn-B context');
    assert.ok(recentTexts.some(text => text.includes('回复：我叫小明')), 'turn-A assistant reply must be in turn-B context');

    const page = await chain.timeline.list({ sessionId: scopeA.sessionId, limit: 10 });
    assert.deepEqual(page.items.map(item => item.kind), ['userMessage', 'assistantTerminal', 'userMessage', 'assistantTerminal']);
    assert.equal(page.items[1]!.status, 'completed');
    assert.equal(page.items[3]!.status, 'completed');
    assert.equal(chain.events.filter(event => event.type === 'terminal').length, 2);
  } finally {
    await chain.cleanup();
  }
});

test('08-B full chain: a cancelled turn records a cancelled terminal, the late reply is dropped, the next turn is unaffected', async () => {
  const chain = await makeChain();
  try {
    const gate = deferred<void>();
    chain.plans.set('慢慢回答我。', { gate, text: '迟到的回复' });
    const scope = await chain.submit('慢慢回答我。');
    chain.port.cancel(scope);
    const terminal = await chain.waitForTerminal(scope);
    assert.equal(terminal.status, 'cancelled');
    gate.resolve();
    await tick();
    await tick();

    assert.equal(chain.events.filter(event => event.type === 'terminal' && event.scope.turnId === scope.turnId).length, 1);
    const replyEvent = chain.events.find(event => event.type === 'reply' && event.scope.turnId === scope.turnId);
    assert.equal(replyEvent, undefined, 'the late reply must not be distributed after cancellation');

    const page = await chain.timeline.list({ sessionId: scope.sessionId, limit: 10 });
    const cancelled = page.items.find(item => item.kind === 'assistantTerminal');
    assert.ok(cancelled && cancelled.status === 'cancelled');

    chain.plans.delete('慢慢回答我。');
    const scopeNext = await chain.submit('再来一条。');
    const terminalNext = await chain.waitForTerminal(scopeNext);
    assert.equal(terminalNext.status, 'completed');
  } finally {
    await chain.cleanup();
  }
});

test('08-C voice input leg: out-of-order ASR segments submit once and record exactly one user message', async () => {
  const chain = await makeChain();
  try {
    const submits: string[] = [];
    const input = new NextSpeechInput(async text => {
      submits.push(text);
      return chain.port.submit({ text });
    });
    input.feed({ inputSessionId: 'in-1', segmentId: 's1', index: 1, text: '，世界', audioEndMs: 900, timeSource: 'audio' });
    input.feed({ inputSessionId: 'in-1', segmentId: 's0', index: 0, text: '你好', audioEndMs: 500, timeSource: 'audio' });
    input.feed({ inputSessionId: 'in-1', segmentId: 's0', index: 0, text: '你好', audioEndMs: 500, timeSource: 'audio' });
    input.feed({ inputSessionId: 'in-1', segmentId: 's2', index: 2, text: '   ', audioEndMs: 950, timeSource: 'audio' });
    await input.stop();

    assert.deepEqual(submits, ['你好，世界']);
    const accepted = chain.events.find(event => event.type === 'accepted');
    assert.ok(accepted && accepted.type === 'accepted' && accepted.text === '你好，世界');

    const scope = accepted.scope;
    const terminal = await chain.waitForTerminal(scope);
    assert.equal(terminal.status, 'completed');

    const page = await chain.timeline.list({ sessionId: scope.sessionId, limit: 10 });
    const userMessages = page.items.filter(item => item.kind === 'userMessage');
    assert.equal(userMessages.length, 1);
    assert.equal(userMessages[0]!.text, '你好，世界');
    assert.equal(page.items.filter(item => item.kind === 'assistantTerminal').length, 1);
  } finally {
    await chain.cleanup();
  }
});
