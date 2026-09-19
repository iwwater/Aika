/** Silent synthetic regressions retain the original failure state and inspect actual selected context. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { TurnScope } from '../contracts/index.js';
import type { MemoryTurnInput } from '../contracts/memory-lifecycle.js';
import type { LifecycleScenarioCase } from './lifecycle-scenarios.js';

export interface SourceCaseOptions { readonly seedDatabase?: string; readonly reopen?: boolean; readonly now?: string }
export type SourceCaseFactory = (name: string, options?: SourceCaseOptions) => LifecycleScenarioCase;
const DAY = 86_400_000;
export async function runSourceRegressionScenarios(out: string, originalFailureDatabase: string, createCase: SourceCaseFactory, closureFixture: { database: string; input: MemoryTurnInput }, selection: 'all' | 'closure-and-maintenance' = 'all'): Promise<void> {
  if (!['all', 'closure-and-maintenance'].includes(selection)) throw new Error('Unknown source scenario selection');
  await mkdir(out, { recursive: false });
  const cases: LifecycleScenarioCase[] = [], checks: Record<string, unknown>[] = [];
  const scope = (sessionId = 'source-regression'): TurnScope => ({ characterId: 'friend', sessionId, turnId: randomUUID(), generation: 1 });
  const create = (name: string, options?: SourceCaseOptions) => { const value = createCase(name, options); cases.push(value); return value; };
  const save = async (id: string, record: Record<string, unknown>) => {
    checks.push({ id, completed: record.completed ?? null });
    await writeFile(`${out}/${id}.json`, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  };
  const state = (value: LifecycleScenarioCase, owned: TurnScope) => ({
    memories: value.store.visible(owned, 'memory'), raw: value.store.visible(owned, 'transcript'),
    summaries: value.store.visible(owned, 'summary'), indexes: value.store.visible(owned, 'keyword_index'),
    caches: value.store.visible(owned, 'context_cache'),
    transcriptBytes: value.store.transcriptBytes(),
  });
  async function turn(value: LifecycleScenarioCase, id: string, text: string, sessionId?: string, existing?: MemoryTurnInput) {
    const owned = existing ? structuredClone(existing.scope) : scope(sessionId), signal = AbortSignal.timeout(60_000), started = performance.now();
    const current = existing ? value.store.inspect(owned, existing.currentMessageId)?.message
      : { characterId: owned.characterId, id: `${owned.turnId}:user`, role: 'user' as const, text, createdAt: value.store.now() };
    if (!current || current.role !== 'user' || current.text !== text || current.characterId !== owned.characterId) throw new Error('saved_turn_fixture_mismatch');
    const record: Record<string, unknown> = { scope: owned, text, synthetic: true, before: state(value, owned) };
    const sourceKinds = ['transcript', 'memory', 'summary', 'keyword_index', 'context_cache'] as const;
    let sourceSnapshot = sourceKinds.flatMap(kind => value.store.visible(owned, kind));
    try {
      if (!existing) await value.memory.append(owned, [current]);
      sourceSnapshot = sourceKinds.flatMap(kind => value.store.visible(owned, kind));
      const outcome = await value.memory.prepareTurn(owned, current.id, text, signal); record.outcome = outcome;
      if (outcome.status === 'rejected' || outcome.request !== 'none' && outcome.status === 'unchanged') throw new Error('not_ready_to_reply');
      const context = await value.memory.context(owned, text, null, signal); record.contextBeforeReply = context;
      value.memory.assertContextCurrent(context);
      const reply = outcome.status === 'needs_clarification'
        ? { scope: owned, text: outcome.clarification ?? '', expression: { emotion: 'neutral', intensity: 0, delivery: 'natural', gesture: null } }
        : await value.dialogue.reply({ scope: owned, text, context, memoryOutcome: outcome }, signal);
      value.memory.assertContextCurrent(context); record.reply = reply;
      await value.memory.appendAssistant(owned, { characterId: owned.characterId, id: `${owned.turnId}:assistant`, role: 'assistant', text: reply.text, createdAt: value.store.now() }, context, current.id, signal);
      record.completed = true;
    } catch (error) { record.completed = false; record.errorName = error instanceof Error ? error.name : 'unknown'; }
    record.sourcesBefore = sourceSnapshot;
    const sourceIds = new Set([...sourceSnapshot.map(source => source.id), ...sourceKinds.flatMap(kind => value.store.visible(owned, kind).map(source => source.id))]);
    record.sourcesAfter = [...sourceIds].map(id => value.store.inspect(owned, id));
    record.physicallyMissingSourceIds = [...sourceIds].filter(id => !value.store.inspect(owned, id));
    record.after = state(value, owned);
    record.targetSearch = value.store.search(owned, '面试失败', 32, 'lexical');
    record.catSearch = value.store.search(owned, '我那只猫叫什么名字？', 32, 'lexical');
    record.otherRole = state(value, { ...owned, characterId: 'sweetheart' });
    record.elapsedMs = Math.round(performance.now() - started);
    await save(id, record); return record;
  }
  async function pushOutsideRecent(value: LifecycleScenarioCase) {
    for (let index = 0; index < 30; index++) {
      const owned = scope();
      await value.memory.append(owned, [{ characterId: owned.characterId, id: `${owned.turnId}:user`, role: 'user', text: `这是一条普通问候，第${index + 1}条。`, createdAt: value.store.now() }]);
    }
  }
  try {
    if (selection === 'all') {
    // Copy the actual failed database, including duplicate memories and historical rejected commands.
    const duplicate = create('original-duplicate-state', { seedDatabase: originalFailureDatabase });
    const original = duplicate.store.visible(scope(), 'memory');
    if (original.length !== 2 || original.some(memory => memory.version !== 2 || !memory.text.includes('糯米'))) throw new Error('original_failure_state_changed');
    await save('01-original-state', { memories: original, sourceDatabase: originalFailureDatabase, originalIsModified: false });
    const forgotten = await turn(duplicate, '02-original-forget', '忘记我养猫和猫咪名字这件事。');
    const after = await turn(duplicate, '03-original-follow-up', '我以前告诉过你猫的名字吗？如果现在不知道就直接说不知道。');
    await save('04-forget-interpretation', { predecessorCompleted: forgotten.completed, followUpCompleted: after.completed, rule: 'Only a successfully committed predecessor permits a post-forget acceptance claim.' });

    const recalled = create('cross-session');
    const initial = await turn(recalled, '05-cross-session-seed', '我养了一只猫，名字叫团子。');
    if (initial.completed) {
      await pushOutsideRecent(recalled); recalled.store.close();
      const restarted = create('cross-session', { reopen: true });
      await turn(restarted, '06-after-restart', '我那只猫叫什么名字？', 'new-session-after-restart');
      const future = new Date(Date.now() + 31 * DAY).toISOString(); restarted.store.close();
      const expired = create('cross-session', { reopen: true, now: future });
      await save('07-raw-expiry', { cleanup: expired.store.cleanup(), remaining: state(expired, scope()), syntheticClock: future });
      await turn(expired, '08-raw-expired-recall', '我之前告诉过你，我的猫叫什么名字？', 'new-session-after-raw-expiry');
    }

    }
    // Use the exact complete 20-turn SQLite workload and its already-saved current turn.
    // No extra historical forget is introduced, and the canonical snapshot remains immutable.
    const closure = create('complete-closure', { seedDatabase: closureFixture.database });
    const closureCurrent = closureFixture.input.sources.find(source => source.id === closureFixture.input.currentMessageId);
    if (!closureCurrent || closureFixture.input.sources.length !== 43) throw new Error('complete_closure_fixture_mismatch');
    for (const source of closureFixture.input.sources) {
      const actual = closure.store.inspect(closureFixture.input.scope, source.id);
      if (!actual || actual.state !== 'active' || actual.kind !== source.kind || actual.version !== source.version || actual.text !== source.text
        || actual.createdAt !== source.createdAt || (actual.message?.role ?? null) !== source.messageRole || actual.evidenceEligible !== source.evidenceEligible
        || JSON.stringify(actual.sources) !== JSON.stringify(source.sourceVersions)) throw new Error('complete_closure_database_changed');
    }
    await save('closure-before', { state: state(closure, closureFixture.input.scope), sourceDatabase: closureFixture.database, originalScope: closureFixture.input.scope });
    const closureResult = await turn(closure, 'closure-forget', closureCurrent.text, undefined, closureFixture.input);
    const closureFollowUp = selection === 'all' || closureResult.completed
      ? await turn(closure, 'closure-follow-up', '我以前告诉过你猫的名字吗？如果现在不知道就直接说不知道。')
      : { completed: false };
    await save('closure-interpretation', { predecessorCompleted: closureResult.completed, followUpCompleted: closureFollowUp.completed, rule: 'Only the final complete committed plan can establish successful forgetting; the first planning call is not an applied result.' });

    if (selection === 'all') {
    for (const mode of ['long-memory', 'raw-only', 'summary-only'] as const) {
      const name = `mixed-${mode}`, value = create(name), owned = scope();
      const rawId = 'mixed-user', rawText = '那次面试失败让我很难过。另外，我养的猫叫团子。';
      await value.memory.append(owned, [{ characterId: owned.characterId, id: rawId, role: 'user', text: rawText, createdAt: value.store.now() }]);
      if (mode === 'long-memory') {
        for (const [id, text] of [['interview', '用户经历一次面试失败并感到难过。'], ['cat', '用户养的猫叫团子。']]) {
          const result = value.store.apply({ scope: owned, operationId: `seed-${id}`, createdAt: value.store.now(), reason: 'Synthetic fixture from confirmed user utterance', operation: { type: 'add', id: id!, text: text!, sourceIds: [rawId] } });
          if (result.status !== 'applied') throw new Error('synthetic_seed_rejected');
        }
      }
      if (mode !== 'raw-only') value.store.recordDerived(owned, { id: 'mixed-summary', kind: 'summary', text: '用户面试失败感到难过；用户的猫叫团子。', sourceIds: [rawId], createdAt: value.store.now() });
      value.store.recordDerived(owned, { id: 'mixed-index', kind: 'keyword_index', text: '面试 失败 猫 团子', sourceIds: [mode === 'summary-only' ? 'mixed-summary' : rawId], createdAt: value.store.now() });
      let active = value;
      if (mode === 'summary-only') {
        value.store.close(); active = create(name, { reopen: true, now: new Date(Date.now() + 31 * DAY).toISOString() });
      }
      await save(`${name}-before`, { state: state(active, owned), raw: active.store.inspect(owned, rawId) });
      await turn(active, `${name}-forget`, '忘记那次面试失败的事情，我养猫的事情还要保留。');
      await turn(active, `${name}-cat`, '我那只猫叫什么名字？');
    }

    const echo = create('bound-echo');
    const echoInitial = await turn(echo, 'echo-seed', '那次面试失败让我很难过。另外，我养的猫叫团子。');
    if (echoInitial.completed) {
      await pushOutsideRecent(echo);
      const result = await turn(echo, 'echo-forget', '忘记那次面试失败的事情，我养猫的事情还要保留。');
      if (result.completed) {
        const summary = await echo.memory.summarizePending(scope(), AbortSignal.timeout(60_000));
        await save('echo-summary-after', { result: summary, state: state(echo, scope()) });
        echo.store.close(); const reopened = create('bound-echo', { reopen: true });
        await turn(reopened, 'echo-recall-restart', '我那只猫叫什么名字？', 'echo-new-session');
        await turn(reopened, 'echo-cat-correction', '记错了，猫咪现在叫糯米，不叫团子。');
        await turn(reopened, 'echo-cat-forget', '忘记我养猫和猫咪名字这件事。');
      }
    }

    }
    // A19 also requires maintenance without an explicit instruction to edit memory.
    // Seeds deliberately remain controlled evidence; decisions and subsequent dialogue use the real adapters.
    const maintenanceCases = [
      { name: 'automatic-merge', raw: '我每周五晚上练吉他。', memories: ['用户每周五晚上练吉他。', '用户的固定吉他练习时间是周五晚。'], current: '周五练吉他之前，有什么简单的热身建议？', query: '我一般什么时候练吉他？', expected: 'Consolidate duplicate records without adding a third copy; preserve the user-supported schedule.' },
      { name: 'automatic-update', raw: '我在晨星公司做设计。', memories: ['用户在晨星公司做设计。'], current: '我这周刚入职青禾，开始做产品设计了，周末想好好休息。', query: '我现在在哪家公司工作？', expected: 'Recognize the naturally stated job change and replace the obsolete current-employment fact; no explicit edit command.' },
      { name: 'automatic-retire', raw: '我今天下午要去取一个普通快递。', memories: ['用户今天下午计划去取一个普通快递。'], current: '那个普通快递我下午已经取回来了，纸箱也随手扔了。', query: '那个取快递的安排还没办完吗？', expected: 'Retire the obsolete pending plan automatically; inspect actual delete/update policy and avoid a false pending task. A19 deletion still requires an observed delete, not just a completed reply.' },
    ];
    for (const item of maintenanceCases) {
      if (selection !== 'all' && item.name === 'automatic-update') continue;
      const value = create(item.name), owned = scope(), rawId = `${item.name}:seed-user`;
      await value.memory.append(owned, [{ characterId: owned.characterId, id: rawId, role: 'user', text: item.raw, createdAt: value.store.now() }]);
      for (const [index, text] of item.memories.entries()) {
        const seeded = value.store.apply({ scope: owned, operationId: `${item.name}:seed-${index}`, createdAt: value.store.now(), reason: 'Controlled user-supported A19 fixture', operation: { type: 'add', id: `${item.name}:memory-${index}`, text, sourceIds: [rawId] } });
        if (seeded.status !== 'applied') throw new Error('autonomous_fixture_seed_rejected');
      }
      await save(`${item.name}-before`, { state: state(value, owned), expected: item.expected, fixtureSeedsAreControlled: true });
      const changed = await turn(value, `${item.name}-decision`, item.current);
      const followUp = selection === 'all' || changed.completed
        ? await turn(value, `${item.name}-recall`, item.query) : { completed: false };
      await save(`${item.name}-interpretation`, { predecessorCompleted: changed.completed, followUpCompleted: followUp.completed, expected: item.expected, semanticAcceptance: 'Manual review of exact model operation, before/after storage and selected context is required.' });
    }
  } finally {
    for (const value of cases) if (!value.store.closed) value.store.close();
    await writeFile(`${out}/scenarios.json`, JSON.stringify({ selection, synthetic: true, physicalDevices: false, ttsRequested: false, checks, limitations: 'Structural fixtures and actual model text evidence; every semantic claim needs review. No native or audible acceptance.' }, null, 2) + '\n', { flag: 'wx' });
  }
}
