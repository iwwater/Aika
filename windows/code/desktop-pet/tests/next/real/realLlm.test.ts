// NEXT-03 / NEXT-08 08-D real replay: fixed single-turn QA and a two-turn context probe against
// the real OpenAI-compatible provider (DeepSeek) through the production ProviderTransport +
// OpenAiCompatibleDialogueProvider + NextTurnPort + SqliteLifecycleMemoryPort + AikaTimelineStore.
// What is real: the HTTPS SSE dialogue call, the turn chain, memory persistence and the timeline.
// What is replaced (annotated): the budget CallAuthorizer (recording double; paid-call approval is
// the user's explicit replay authorization) and the memory plan provider (noPlan; context flows
// through the recent-message stream). Credentials come from the environment or the gitignored
// .next-real.local.json — never from the repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../../../memory/sqlite-lifecycle-port.js';
import { MemoryMediaStore } from '../../../media/store.js';
import { NextTurnPort, type TurnPortEvent } from '../../../core/turn-port.js';
import { OpenAiCompatibleDialogueProvider } from '../../../providers/aika-dialogue.js';
import { ProviderTransport } from '../../../providers/transport.js';
import { AikaTimelineRecorder, AikaTimelineStore } from '../../../management/aika-timeline.js';
import type { DialogueRequest, MemoryMaintenanceInput, TurnScope } from '../../../contracts/index.js';
import type { MemoryTurnInput, MemoryTurnPlan } from '../../../contracts/memory-lifecycle.js';
import { confirmedInvitationPolicy } from '../../../companion/invitations.js';

const NOW = '2026-09-20T00:00:00.000Z';
const SYSTEM_PROMPT = '你是Aika，简洁自然地回答。';

interface RealLlmConfig { endpoint: string; model: string; apiKey: string }

async function loadConfig(): Promise<RealLlmConfig | null> {
  const env = process.env;
  if (env.NEXT_REAL_LLM_KEY) {
    return {
      endpoint: env.NEXT_REAL_LLM_ENDPOINT ?? 'https://api.deepseek.com/chat/completions',
      model: env.NEXT_REAL_LLM_MODEL ?? 'deepseek-flash',
      apiKey: env.NEXT_REAL_LLM_KEY
    };
  }
  try {
    const local = JSON.parse(await readFile(resolve(process.cwd(), '.next-real.local.json'), 'utf8')) as Partial<RealLlmConfig>;
    if (typeof local.apiKey === 'string' && local.apiKey) {
      return {
        endpoint: local.endpoint ?? 'https://api.deepseek.com/chat/completions',
        model: local.model ?? 'deepseek-flash',
        apiKey: local.apiKey
      };
    }
  } catch { /* no local credential file */ }
  return null;
}

const noPlan = (input: MemoryTurnInput): MemoryTurnPlan =>
  ({ scope: input.scope, request: 'none', changes: [], suppressSources: [], clarification: null, reason: '无记忆相关内容' });

interface Chain {
  port: NextTurnPort;
  events: TurnPortEvent[];
  requests: DialogueRequest[];
  outcomes: string[];
  timeline: AikaTimelineStore;
  submit(text: string): Promise<TurnScope>;
  waitForTerminal(scope: TurnScope): Promise<Extract<TurnPortEvent, { type: 'terminal' }>>;
  cleanup(): Promise<void>;
}

async function makeChain(config: RealLlmConfig): Promise<Chain> {
  const dir = await mkdtemp(join(tmpdir(), 'next-real-llm-'));
  const store = new SqliteMemoryStore({ filename: resolve(dir, 'companion.sqlite'), retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const lifecycle = new SqliteLifecycleMemoryPort(store, {
    context: { summaryLimit: 1000, inputTokenBudget: 5000, maxRecentMessages: 20, maxMemories: 5, countTokens: () => 0, relevance: () => 0 },
    turn: { inputTokenBudget: 4000, countTokens: () => 0, provider: { plan: async input => noPlan(input) }, maxSupplementaryPlans: 0 },
    summary: { inputTokenBudget: 4000, countTokens: () => 0, minMessages: 50, maxMessages: 100, provider: { summarize: async input => ({ scope: input.scope, text: '摘要', sourceVersions: [] }) } }
  }, { propose: async (_input: MemoryMaintenanceInput) => [] });

  const outcomes: string[] = [];
  const authorizer = {
    async authorize() {
      return { async settle(outcome: { status: string }) { outcomes.push(outcome.status); } };
    }
  };
  const transport = new ProviderTransport();
  const provider = new OpenAiCompatibleDialogueProvider(transport, { endpoint: config.endpoint, model: config.model, apiKey: () => config.apiKey, authorizer }, SYSTEM_PROMPT);
  const requests: DialogueRequest[] = [];
  const media = new MemoryMediaStore();
  const port = new NextTurnPort({
    outputMode: 'text',
    perception: { perceive: async () => { throw new Error('perception unused in this replay'); } },
    dialogue: {
      reply: async (request, signal) => {
        requests.push(request);
        return provider.reply(request, signal);
      }
    },
    tts: { synthesize: async () => { throw new Error('tts unused in this replay'); } },
    playback: { play: async () => {}, stop: async () => {} },
    memory: lifecycle,
    memoryLifecycle: lifecycle,
    mediaStore: { put: (scope, bytes, mimeType) => media.put(scope, bytes, mimeType), read: (scope, asset) => media.read(scope, asset), releaseScope: async () => {} }
  });
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
    port, events, requests, outcomes, timeline,
    submit: text => port.submit({ text }),
    waitForTerminal,
    cleanup: async () => {
      stopRecorder();
      store.close();
      await timeline.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

test('08-D real LLM: fixed single-turn QA returns a valid reply with a unique terminal', { timeout: 180000 }, async t => {
  const config = await loadConfig();
  if (!config) return t.skip('NEXT-REAL LLM credentials not configured (see CORPUS_MANIFEST §4); fixture evidence cannot substitute');
  console.log(`[real-llm] endpoint=${config.endpoint} model=${config.model}`);
  const chain = await makeChain(config);
  try {
    const scope = await chain.submit('请用一句话介绍你自己。');
    const terminal = await chain.waitForTerminal(scope);
    assert.equal(terminal.status, 'completed');
    assert.ok(terminal.replyText && terminal.replyText.length > 0, 'real reply must be non-empty');
    const terminals = chain.events.filter(event => event.type === 'terminal' && event.scope.turnId === scope.turnId);
    assert.equal(terminals.length, 1);
    assert.ok(chain.outcomes.includes('success'), `authorizer outcomes: ${chain.outcomes.join(',')}`);
    const page = await chain.timeline.list({ sessionId: scope.sessionId, limit: 10 });
    assert.deepEqual(page.items.map(item => item.kind), ['userMessage', 'assistantTerminal']);
    assert.equal(page.items[1]!.status, 'completed');
  } finally {
    await chain.cleanup();
  }
});

test('08-D real LLM: the previous turn actually reaches the next request as context', { timeout: 240000 }, async t => {
  const config = await loadConfig();
  if (!config) return t.skip('NEXT-REAL LLM credentials not configured (see CORPUS_MANIFEST §4); fixture evidence cannot substitute');
  const chain = await makeChain(config);
  try {
    const scopeA = await chain.submit('记住：我的代号是北斗七号。收到请回答"已记录"。');
    const terminalA = await chain.waitForTerminal(scopeA);
    assert.equal(terminalA.status, 'completed');

    const scopeB = await chain.submit('我的代号是什么？只回答代号本身，不要任何其他字。');
    const terminalB = await chain.waitForTerminal(scopeB);
    assert.equal(terminalB.status, 'completed');
    assert.match(terminalB.replyText ?? '', /北斗七号/, `multi-turn context did not reach the request; reply=${JSON.stringify(terminalB.replyText)}`);

    const recentTexts = chain.requests[1]!.context.recent.map(message => message.text);
    assert.ok(recentTexts.some(text => text.includes('北斗七号')), 'the previous user message must be part of the second request context');
  } finally {
    await chain.cleanup();
  }
});
