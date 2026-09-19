/** Bounded synthetic acceptance probe. Criteria are independent of model reasons. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import type { DialogueContext } from '../contracts/index.js';
import type { MemoryTurnInput, MemoryTurnOutcome } from '../contracts/memory-lifecycle.js';
import type { MemoryRecord } from '../memory/ledger.js';
import { SqliteLedgerBacking } from '../memory/sqlite-backing.js';
import type { SourceCaseFactory } from './source-regression-scenarios.js';

export interface MemoryTrialCase {
  id: string; input: MemoryTurnInput; records: MemoryRecord[]; maxPlans: 1 | 2;
  criteria: {
    kind: 'preserve' | 'unchanged' | 'closure' | 'merge' | 'retire';
    query: string; absentText?: string; presentText?: string;
    unchangedIds: string[]; deletedMemoryIds: string[];
    retainedParentIds: string[]; memoryCount: number | number[];
  };
}
export interface MemoryTrialBundle {
  stage: 'known' | 'holdout'; cases: MemoryTrialCase[];
  sourceFingerprints: Record<string, string>;
}
export class MemoryTrialCallGuard {
  private readonly used = new Map<string, number>();
  private total = 0;
  constructor(private readonly bundle: MemoryTrialBundle) {}
  beforeRequest(scope: MemoryTurnInput['scope']): number {
    const fixture = this.bundle.cases.find(item => item.input.scope.characterId === scope.characterId && item.input.scope.sessionId === scope.sessionId && item.input.scope.turnId === scope.turnId && item.input.scope.generation === scope.generation);
    assert.ok(fixture, 'Unexpected trial scope');
    const used = this.used.get(fixture.id) ?? 0;
    assert.ok(used < fixture.maxPlans, 'Per-case generation limit reached');
    assert.ok(this.total < (this.bundle.stage === 'known' ? 9 : 3), 'Stage generation limit reached');
    this.used.set(fixture.id, used + 1);
    return ++this.total;
  }
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const ordered = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const normalized = (input: MemoryTurnInput) => ({ ...input, sources: ordered(input.sources), messages: ordered(input.messages), relevantMemories: ordered(input.relevantMemories) });
const kinds = ['transcript', 'memory', 'summary', 'keyword_index', 'vector_index', 'context_cache'] as const;

export async function loadMemoryTrial(root: string, stage: 'known' | 'holdout'): Promise<MemoryTrialBundle> {
  const directory = `${root}/.local/prompt-trial-inputs`;
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  const bytes = await readFile(`${directory}/${stage}.json`);
  assert.equal(hash(bytes), manifest[`${stage}Sha256`], 'Frozen trial bundle changed');
  const bundle = JSON.parse(bytes.toString()) as MemoryTrialBundle;
  assert.equal(bundle.stage, stage);
  assert.equal(bundle.cases.length, stage === 'known' ? 8 : 3);
  assert.equal(new Set(bundle.cases.map(item => item.id)).size, bundle.cases.length);
  assert.ok(bundle.cases.every(item => item.maxPlans === 1 || item.maxPlans === 2));
  assert.equal(bundle.cases.reduce((sum, item) => sum + item.maxPlans, 0), stage === 'known' ? 9 : 3);
  for (const [path, digest] of Object.entries(bundle.sourceFingerprints)) {
    assert.ok(path.startsWith('.local/') && !path.split('/').includes('..'));
    assert.equal(hash(await readFile(`${root}/${path}`)), digest, `Trial source changed: ${path}`);
  }
  return bundle;
}

/** A new process may advance one case only after explicit integration review of the prior case. */
export async function reviewedTrialCount(root: string, bundle: MemoryTrialBundle, promptSha256: string): Promise<number> {
  const directory = `${root}/.local/prompt-trial-inputs`;
  let approvals: { caseId: string; runId: string; reviewedBy: string; passed: boolean; promptSha256: string; fingerprints: Record<string, string> }[];
  try { approvals = JSON.parse(await readFile(`${directory}/${bundle.stage}-approvals.json`, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  assert.ok(Array.isArray(approvals) && approvals.length <= bundle.cases.length);
  const files = ['manifest.json', 'scenarios.json', 'review.json', 'model-responses.json', 'plan-traces.json'].sort();
  for (const [index, approval] of approvals.entries()) {
    assert.equal(approval.caseId, bundle.cases[index]!.id, 'Trial order cannot change');
    assert.equal(approval.reviewedBy, 'W0-I'); assert.equal(approval.passed, true); assert.equal(approval.promptSha256, promptSha256);
    assert.match(approval.runId, /^lifecycle-[a-z0-9-]+$/);
    assert.deepEqual(Object.keys(approval.fingerprints).sort(), files, 'Complete per-case review fingerprints required');
    const run = `${root}/.local/${approval.runId}`;
    for (const name of files) assert.equal(hash(await readFile(`${run}/${name}`)), approval.fingerprints[name], 'Reviewed trial evidence changed');
    const result = JSON.parse(await readFile(`${run}/scenarios.json`, 'utf8'));
    const manifest = JSON.parse(await readFile(`${run}/manifest.json`, 'utf8'));
    const claim = JSON.parse(await readFile(`${directory}/${bundle.stage}-${approval.caseId}-call-owner.json`, 'utf8'));
    assert.equal(result.selectedCaseId, approval.caseId);
    assert.deepEqual(result.checks, [{ id: approval.caseId, passed: true }]);
    assert.equal(manifest.trialPromptHash, promptSha256); assert.equal(manifest.memoryWireMode, 'quoted-v2');
    assert.ok(manifest.generationCalls >= 1 && manifest.generationCalls <= bundle.cases[index]!.maxPlans);
    assert.equal(claim.runId, approval.runId); assert.equal(claim.promptSha256, promptSha256);
  }
  return approvals.length;
}

/** Applied is only a transport/storage outcome; preservation is checked separately. */
export function assertMemoryTrialResult(fixture: MemoryTrialCase, outcome: MemoryTurnOutcome, after: MemoryRecord[], active: MemoryRecord[], context: DialogueContext): void {
  assert.ok(outcome.status === 'applied' || outcome.status === 'unchanged', `Unsuccessful outcome: ${outcome.status}`);
  const criteria = fixture.criteria, byId = new Map(after.map(record => [record.id, record]));
  for (const id of criteria.unchangedIds) assert.deepEqual(byId.get(id), fixture.records.find(record => record.id === id), `Unrelated source changed: ${id}`);
  const activeText = active.map(record => record.text).join('\n');
  const contextText = JSON.stringify({ recent: context.recent, summary: context.summary, memories: context.memories });
  if (criteria.absentText) {
    assert.ok(!activeText.includes(criteria.absentText), 'Target remains in active sources');
    assert.ok(!contextText.includes(criteria.absentText), 'Target remains in issued context');
  }
  if (criteria.presentText) assert.ok(contextText.includes(criteria.presentText), 'Required fact missing from issued context');
  const memories = active.filter(record => record.kind === 'memory');
  const counts = Array.isArray(criteria.memoryCount) ? criteria.memoryCount : [criteria.memoryCount];
  assert.ok(counts.includes(memories.length), 'Unexpected active memory count');
  if (Array.isArray(criteria.memoryCount) && criteria.presentText) assert.ok(memories.every(memory => memory.text.includes(criteria.presentText!)), 'Optional new memory does not preserve the required fact');
  for (const id of criteria.deletedMemoryIds) assert.equal(byId.get(id)?.state, 'deleted', 'Expected memory was not soft-deleted');
  for (const parentId of criteria.retainedParentIds) {
    const original = fixture.records.find(record => record.id === parentId)!;
    const fragments = active.filter(record => record.fragment?.parent.id === parentId);
    assert.equal(fragments.length, 1, 'Expected one preserved fragment for each source');
    if (criteria.kind === 'closure') {
      assert.equal(fragments[0]!.text, original.text, 'Unrelated assistant content was lost');
      const independentUser = original.sources.find(ref => criteria.unchangedIds.includes(ref.id));
      assert.ok(independentUser && fragments[0]!.sources.some(ref => ref.id === independentUser.id && ref.version === independentUser.version), 'Assistant fragment lost its independent support');
    }
  }
  if (criteria.kind === 'unchanged') {
    assert.equal(outcome.status, 'unchanged');
    assert.deepEqual(ordered(after), ordered(fixture.records));
  } else assert.equal(outcome.status, 'applied');
  if (criteria.kind === 'merge') {
    const oldIds = new Set(fixture.records.filter(record => record.kind === 'memory').map(record => record.id));
    assert.ok(active.filter(record => record.kind === 'memory').every(record => !oldIds.has(record.id)), 'Duplicate records were not replaced by a merge');
    for (const id of oldIds) assert.notEqual(byId.get(id)?.state, 'active');
  }
}

/** Every selection is checked before the first plan. Stop permanently at the first failure. */
export async function runMemoryTrial(out: string, bundle: MemoryTrialBundle, createCase: SourceCaseFactory, countTokens: (input: MemoryTurnInput) => number, selectedCaseId?: string): Promise<void> {
  if (selectedCaseId !== undefined) assert.ok(bundle.cases.some(item => item.id === selectedCaseId), 'Unknown selected trial case');
  await mkdir(out, { recursive: false });
  const opened: { fixture: MemoryTrialCase; value: ReturnType<SourceCaseFactory> }[] = [];
  const checks: { id: string; passed: boolean }[] = [];
  let preflightPassed = false;
  try {
    for (const fixture of bundle.cases) {
      assert.match(fixture.id, /^[a-z0-9-]+$/);
      const current = fixture.input.sources.find(source => source.id === fixture.input.currentMessageId);
      assert.ok(current && current.messageRole === 'user');
      assert.equal(new Set(fixture.records.map(record => record.id)).size, fixture.records.length);
      assert.ok(fixture.records.every(record => record.characterId === fixture.input.scope.characterId));
      const value = createCase(fixture.id, { now: current.createdAt }); opened.push({ fixture, value });
      assert.ok(kinds.every(kind => !value.store.visible(fixture.input.scope, kind).length));
      const database = new Database(`${out}/${fixture.id}.sqlite`, { fileMustExist: true });
      try {
        const backing = new SqliteLedgerBacking(database, fixture.input.scope.characterId);
        database.transaction(() => { for (const record of fixture.records) backing.records.set(record.id, record); })();
      } finally { database.close(); }
      for (const record of fixture.records) assert.deepEqual(value.store.inspect(fixture.input.scope, record.id), record);
      const ticket = value.store.lifecycle.readTurn(fixture.input.scope, current.id, current.text, { maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, inputTokenBudget: 32768, countTokens });
      try { assert.deepEqual(normalized(ticket.input), normalized(fixture.input), 'Trial selected contents differ from frozen input'); }
      finally { value.store.lifecycle.discardTurn(ticket); }
    }
    preflightPassed = true;
    for (const { fixture, value } of opened) {
      if (selectedCaseId !== undefined && fixture.id !== selectedCaseId) continue;
      const started = performance.now(), scope = fixture.input.scope;
      const record: Record<string, unknown> = { id: fixture.id, input: fixture.input, sourcesBefore: fixture.records, synthetic: true, historicalTransactionReplay: false };
      let passed = false;
      try {
        const current = fixture.input.sources.find(source => source.id === fixture.input.currentMessageId)!;
        const outcome = await value.memory.prepareTurn(scope, current.id, current.text, AbortSignal.timeout(60_000));
        record.outcome = outcome;
        const context = await value.memory.context({ ...scope, turnId: `${scope.turnId}:trial-read` }, fixture.criteria.query, null, new AbortController().signal);
        value.memory.assertContextCurrent(context); record.readOnlyContextAfter = context;
        const active = kinds.flatMap(kind => value.store.visible(scope, kind));
        const ids = new Set([...fixture.records.map(source => source.id), ...active.map(source => source.id)]);
        const after = [...ids].map(id => value.store.inspect(scope, id)).filter((source): source is MemoryRecord => source !== null && source !== undefined);
        assertMemoryTrialResult(fixture, outcome, after, active, context);
        passed = true;
      } catch (error) { record.errorName = error instanceof Error ? error.name : 'unknown'; record.errorMessage = error instanceof Error ? error.message : String(error); }
      const active = kinds.flatMap(kind => value.store.visible(scope, kind));
      const ids = new Set([...fixture.records.map(source => source.id), ...active.map(source => source.id)]);
      record.sourcesAfter = [...ids].map(id => value.store.inspect(scope, id)); record.active = active;
      record.physicallyMissingSourceIds = [...ids].filter(id => !value.store.inspect(scope, id));
      record.passed = passed; record.elapsedMs = Math.round(performance.now() - started);
      await writeFile(`${out}/${fixture.id}.json`, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
      checks.push({ id: fixture.id, passed });
      if (!passed) break;
    }
  } finally {
    for (const { value } of opened) if (!value.store.closed) value.store.close();
    await writeFile(`${out}/scenarios.json`, JSON.stringify({ stage: bundle.stage, selectedCaseId: selectedCaseId ?? null, preflightPassed, checks, allPassed: preflightPassed && checks.length === bundle.cases.length && checks.every(check => check.passed), unexecuted: bundle.cases.filter(item => !checks.some(check => check.id === item.id)).map(item => item.id), humanReviewRequired: true, wholeAcceptance: false, limits: 'Synthetic read-state restoration, independent semantic assertions plus human review; no historical transaction replay, dialogue, summary, restart or device acceptance.' }, null, 2) + '\n', { flag: 'wx' });
  }
}
