/** Synthetic, silent acceptance evidence. Caller supplies the explicitly authorized real adapters. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { DialogueProvider, TurnScope } from '../contracts/index.js';
import type { AssistantMemoryPort, MemoryTurnPort, SummaryPort } from '../contracts/memory-lifecycle.js';
import type { SqliteMemoryStore } from '../memory/sqlite-store.js';

export interface LifecycleScenarioCase {
  store: SqliteMemoryStore;
  memory: MemoryTurnPort & SummaryPort & AssistantMemoryPort;
  dialogue: DialogueProvider;
}
export async function runLifecycleScenarios(out: string, createCase: (name: string) => LifecycleScenarioCase): Promise<void> {
  await mkdir(out, { recursive: false });
  const cases: LifecycleScenarioCase[] = [];
  const records: Record<string, unknown>[] = [];
  const create = (name: string) => { const value = createCase(name); cases.push(value); return value; };
  const scope = (): TurnScope => ({ characterId: 'friend', sessionId: 'synthetic-lifecycle', turnId: randomUUID(), generation: 1 });
  const user = (owned: TurnScope, text: string) => ({ characterId: owned.characterId, id: `${owned.turnId}:user`, role: 'user' as const, text, createdAt: new Date().toISOString() });
  const save = async (id: string, record: Record<string, unknown>) => { records.push({ id, ...record }); await writeFile(`${out}/${id}.json`, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); };
  async function turn(value: LifecycleScenarioCase, id: string, text: string) {
    const owned = scope(), signal = AbortSignal.timeout(60_000), message = user(owned, text), started = performance.now();
    await value.memory.append(owned, [message]);
    const beforeSources = ['transcript', 'memory', 'summary', 'keyword_index', 'context_cache'] as const;
    const sourceSnapshot = beforeSources.flatMap(kind => value.store.visible(owned, kind));
    const record: Record<string, unknown> = { scope: owned, text, synthetic: true, before: value.store.visible(owned, 'memory'), sourcesBefore: sourceSnapshot };
    try {
      const outcome = await value.memory.prepareTurn(owned, message.id, text, signal);
      record.outcome = outcome;
      if (outcome.status === 'rejected' || outcome.request !== 'none' && outcome.status === 'unchanged') throw new Error('not_ready_to_reply');
      const context = await value.memory.context(owned, text, null, signal);
      value.memory.assertContextCurrent(context); record.contextBeforeReply = context;
      const reply = outcome.status === 'needs_clarification'
        ? { scope: owned, text: outcome.clarification ?? '', expression: { emotion: 'neutral', intensity: 0, delivery: 'natural', gesture: null } }
        : await value.dialogue.reply({ scope: owned, text, context, memoryOutcome: outcome }, signal);
      value.memory.assertContextCurrent(context);
      record.reply = reply;
      await value.memory.appendAssistant(owned, { characterId: owned.characterId, id: `${owned.turnId}:assistant`, role: 'assistant', text: reply.text, createdAt: new Date().toISOString() }, context, message.id, signal);
      record.after = value.store.visible(owned, 'memory');
      record.otherRoleContext = await value.memory.context({ ...owned, characterId: 'sweetheart' }, '猫 名字 面试', null, signal);
      record.completed = true;
    } catch (error) {
      record.completed = false;
      // Detailed provider/model data, if needed, is captured by the synthetic-only transport, never an error dump.
      record.errorName = error instanceof Error ? error.name : 'unknown';
    }
    const sourceIds = new Set([...sourceSnapshot.map(source => source.id), ...beforeSources.flatMap(kind => value.store.visible(owned, kind).map(source => source.id))]);
    record.sourcesAfter = [...sourceIds].map(id => value.store.inspect(owned, id));
    record.elapsedMs = Math.round(performance.now() - started);
    await save(id, record); return record;
  }
  try {
    const natural = create('natural');
    const initial = await turn(natural, '01-natural-add', '我养了一只猫，名字叫团子。');
    if (!initial.completed) throw new Error('Initial lifecycle scenario failed; stop before further paid calls');
    await turn(natural, '02-related-recall', '我那只猫叫什么名字？');
    await turn(natural, '03-natural-correction', '记错了，猫咪现在叫糯米，不叫团子。');
    await turn(natural, '04-explicit-forget', '忘记我养猫和猫咪名字这件事。');
    await turn(natural, '05-after-forget', '我以前告诉过你猫的名字吗？如果现在不知道就直接说不知道。');

    const raw = create('raw-only'), rawScope = scope();
    const rawMessage = user(rawScope, '后天我约了一个临时项目的面试。');
    await raw.memory.append(rawScope, [rawMessage]);
    raw.store.recordDerived(rawScope, { id: 'raw-summary', kind: 'summary', text: '用户后天有临时项目面试。', sourceIds: [rawMessage.id], createdAt: new Date().toISOString() });
    raw.store.recordDerived(rawScope, { id: 'raw-index', kind: 'keyword_index', text: '临时项目 面试 后天', sourceIds: [rawMessage.id], createdAt: new Date().toISOString() });
    await turn(raw, '06-raw-only-forget', '忘记刚才那个临时项目面试的事情。');
    await save('07-raw-paths-after', { raw: raw.store.inspect(rawScope, rawMessage.id), summary: raw.store.inspect(rawScope, 'raw-summary'), index: raw.store.inspect(rawScope, 'raw-index'), retrieval: raw.store.search(rawScope, '面试', 32, 'lexical') });

    const ambiguous = create('ambiguous'), ambiguousScope = scope();
    await ambiguous.memory.append(ambiguousScope, [user(ambiguousScope, '我下周一有面试。')]);
    const secondScope = scope();
    await ambiguous.memory.append(secondScope, [user(secondScope, '我下周二去体检。')]);
    await turn(ambiguous, '08-ambiguous-request', '我之前提的两个安排，帮我忘掉其中一个。');

    const summary = create('summary'), summaryScope = scope();
    for (const text of ['我每周五去练吉他。', '我的老师叫李老师。', '我在准备年底的演出。', '演出曲目里有一首民谣。']) {
      const next = scope(); await summary.memory.append(next, [user(next, text)]);
    }
    const result = await summary.memory.summarizePending(summaryScope, AbortSignal.timeout(60_000));
    await save('09-summary', { result, summaries: summary.store.visible(summaryScope, 'summary'), otherRole: summary.store.visible({ ...summaryScope, characterId: 'sweetheart' }, 'summary') });
  } finally {
    for (const value of cases) value.store.close();
    await writeFile(`${out}/scenarios.json`, JSON.stringify({ synthetic: true, physicalDevices: false, ttsRequested: false, checks: records.map(r => ({ id: r.id, completed: r.completed ?? null })), limitations: 'Evidence for model decisions, persistence and dialogue text only. Manual semantic review required; no complete native/device/playback acceptance.' }, null, 2) + '\n', { flag: 'wx' });
  }
}
