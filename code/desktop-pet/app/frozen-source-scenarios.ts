/** Original synthetic read states, not historical transaction or process replay. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import type { MemoryTurnInput } from '../contracts/memory-lifecycle.js';
import type { MemoryRecord } from '../memory/ledger.js';
import { SqliteLedgerBacking } from '../memory/sqlite-backing.js';
import type { SourceCaseFactory } from './source-regression-scenarios.js';

const scenes = [
  { id: 'mixed-long-memory-forget', index: 7 },
  { id: 'mixed-raw-only-forget', index: 9 },
  { id: 'mixed-summary-only-forget', index: 11 },
  { id: 'echo-forget', index: 14 },
] as const;
const ordered = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
function normalized(input: MemoryTurnInput) {
  return { ...input, sources: ordered(input.sources), messages: ordered(input.messages), relevantMemories: ordered(input.relevantMemories) };
}

export async function runFrozenSourceScenarios(out: string, original: string, createCase: SourceCaseFactory, countTokens: (input: MemoryTurnInput) => number): Promise<void> {
  const review = JSON.parse(await readFile(`${original}/review.json`, 'utf8')) as { fingerprints: Record<string, string> };
  const fingerprints: Record<string, string> = {};
  async function frozen(name: string) {
    const bytes = await readFile(`${original}/${name}`), digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, review.fingerprints[name], `Original source evidence changed: ${name}`);
    fingerprints[name] = digest;
    return JSON.parse(bytes.toString('utf8'));
  }
  const plans = await frozen('plan-traces.json') as { input: MemoryTurnInput }[];
  const responses = (await frozen('model-responses.json') as { operation: string; scope: unknown; modelText: string }[]).filter(row => row.operation === 'memory_turn');
  const expired = (await frozen('mixed-summary-only-before.json')).raw as MemoryRecord;
  assert.equal(expired.state, 'expired'); assert.equal(expired.text, '');
  // Verify every selected original before creating a case or allowing generation.
  const fixtures = await Promise.all(scenes.map(async item => {
    const scene = await frozen(`${item.id}.json`), input = plans[item.index]!.input;
    assert.equal(scene.synthetic, true); assert.deepEqual(scene.scope, input.scope);
    assert.deepEqual(responses[item.index]!.scope, input.scope);
    const current = input.sources.find(source => source.id === input.currentMessageId);
    assert.ok(current && current.messageRole === 'user' && current.text === scene.text);
    const records: MemoryRecord[] = [...scene.sourcesBefore, ...(item.id === 'mixed-summary-only-forget' ? [expired] : [])];
    assert.equal(new Set(records.map(record => record.id)).size, records.length);
    assert.ok(records.every(record => record.characterId === input.scope.characterId));
    return { ...item, input, current, records, previousModelText: responses[item.index]!.modelText };
  }));
  await mkdir(out, { recursive: false });
  const cases: { fixture: typeof fixtures[number]; value: ReturnType<SourceCaseFactory> }[] = [];
  const checks: Record<string, unknown>[] = [];
  const kinds = ['transcript', 'memory', 'summary', 'keyword_index', 'vector_index', 'context_cache'] as const;
  try {
    // Validate all restored selections before the first model call. The factory must
    // create its fresh database at out/id.sqlite, with the same fixed evaluation policy.
    for (const fixture of fixtures) {
      const value = createCase(fixture.id, { now: fixture.current.createdAt });
      cases.push({ fixture, value });
      assert.ok(kinds.every(kind => value.store.visible(fixture.input.scope, kind).length === 0));
      const db = new Database(`${out}/${fixture.id}.sqlite`, { fileMustExist: true });
      try {
        const backing = new SqliteLedgerBacking(db, fixture.input.scope.characterId);
        db.transaction(() => { for (const record of fixture.records) backing.records.set(record.id, record); })();
      } finally { db.close(); }
      for (const record of fixture.records) assert.deepEqual(value.store.inspect(fixture.input.scope, record.id), record);
      const ticket = value.store.lifecycle.readTurn(fixture.input.scope, fixture.current.id, fixture.current.text, {
        maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, inputTokenBudget: 32768, countTokens,
      });
      try { assert.deepEqual(normalized(ticket.input), normalized(fixture.input), 'Selected source/message contents differ from frozen original'); }
      finally { value.store.lifecycle.discardTurn(ticket); }
    }
    for (const { fixture, value } of cases) {
      const record: Record<string, unknown> = { id: fixture.id, synthetic: true, originalInput: fixture.input,
        sourcesBefore: fixture.records, previousModelText: fixture.previousModelText,
        originalSelectedContentsVerified: true, historicalTransactionReplay: false, semanticAcceptance: false };
      const started = performance.now();
      try {
        const outcome = await value.memory.prepareTurn(fixture.input.scope, fixture.current.id, fixture.current.text, AbortSignal.timeout(60_000));
        record.outcome = outcome;
        if (outcome.status === 'applied') {
          const probeScope = { ...fixture.input.scope, turnId: `${fixture.input.scope.turnId}:read-probe` };
          const context = await value.memory.context(probeScope, '我那只猫叫什么名字？', null, new AbortController().signal);
          value.memory.assertContextCurrent(context); record.readOnlyContextAfter = context;
        }
        record.completed = true;
      } catch (error) { record.completed = false; record.errorName = error instanceof Error ? error.name : 'unknown'; }
      const active = kinds.flatMap(kind => value.store.visible(fixture.input.scope, kind));
      const ids = new Set([...fixture.records.map(source => source.id), ...active.map(source => source.id)]);
      record.sourcesAfter = [...ids].map(id => value.store.inspect(fixture.input.scope, id));
      record.physicallyMissingSourceIds = [...ids].filter(id => !value.store.inspect(fixture.input.scope, id));
      record.active = active;
      record.targetSearch = value.store.search(fixture.input.scope, '面试失败', 32, 'lexical');
      record.elapsedMs = Math.round(performance.now() - started);
      await writeFile(`${out}/${fixture.id}.json`, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
      checks.push({ id: fixture.id, completed: record.completed, outcome: record.outcome ?? null });
    }
    for (const name of Object.keys(fingerprints)) await frozen(name);
  } finally {
    for (const { value } of cases) if (!value.store.closed) value.store.close();
    await writeFile(`${out}/scenarios.json`, JSON.stringify({ fingerprints, checks, synthetic: true,
      limitations: 'Exact selected content and versioned record restoration; ordering is recorded by actual provider trace. No historical operation ledger, process replay, dialogue generation, summary generation, playback or whole acceptance. Retain restored databases and original traces.' }, null, 2) + '\n', { flag: 'wx' });
  }
}
