/** Isolated synthetic-state evaluator. Test response annotations are never loaded by this module. */
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import type { DialogueContext } from '../contracts/index.js';
import type { MemoryTurnInput, MemoryTurnOutcome } from '../contracts/memory-lifecycle.js';
import type { MemoryRecord } from '../memory/ledger.js';
import { SqliteLedgerBacking } from '../memory/sqlite-backing.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../memory/sqlite-lifecycle-port.js';
import { SqliteMemoryPort } from '../memory/sqlite-port.js';
import type { TurnTicket, TurnExpansion } from '../memory/sqlite-lifecycle-state.js';
import { confirmedInvitationPolicy } from '../companion/invitations.js';
import { contextInputUpperBound } from './input-budgets.js';
import { assertMemoryTrialResult, loadMemoryTrial, type MemoryTrialCase } from './memory-trial.js';
import { prototypeSnapshot, type PrototypeSnapshot, type PrototypeResult, type SemanticDeclaration } from './memory-planning-prototype.js';
import { normalizedSemanticInput, semanticHash, semanticInputHash, type SemanticExpansionProof,
  beginSemanticCase, loadSemanticPhase, semanticOrder, SEMANTIC_DIRECTORY, SEMANTIC_PHASE, SEMANTIC_MODEL, SEMANTIC_ENDPOINT, SEMANTIC_PARAMETERS, type SemanticPhaseConfig,
  SEMANTIC_RECHECK_PHASE, semanticPhaseProfile, readSemanticPinnedFile, type SemanticPhaseId,
  type SemanticBatchId, isSemanticBatch, SEMANTIC_BATCH_ROOT, SEMANTIC_POLICY, SEMANTIC_SHARED_LIMIT, readSemanticPolicy, checkSemanticCases,
  SEMANTIC_PRO_MODEL, semanticModelProfile, readSemanticModelComparison, assertSemanticModelOnlyRequest,
  SEMANTIC_THINKING_PARAMETERS, assertSemanticThinkingOnlyRequest, assertSemanticSystemOnlyRequest } from './memory-semantic-phase.js';
import { ProviderTransport } from '../providers/transport.js';
import { buildMemorySemanticFormat } from './memory-semantic-format.js';
import { runMemorySemanticAttempt, buildSemanticRequestBody, type SemanticAttemptEvent } from './memory-semantic-adapter.js';

export interface SemanticFixture {
  id: string; input: MemoryTurnInput; records: MemoryRecord[]; query: string;
  criteria?: MemoryTrialCase['criteria']; expectClarification?: boolean;
}
export async function loadOriginalSemanticCases(root: string): Promise<{ cases: SemanticFixture[]; expanded: MemoryTurnInput; inputPins: Record<string, string> }> {
  const known = await loadMemoryTrial(root, 'known');
  const inputPins: Record<string, string> = { ...known.sourceFingerprints };
  const read = async (path: string, expected?: string) => {
    const bytes = await readFile(`${root}/${path}`), sha = semanticHash(bytes);
    if (expected) assert.equal(sha, expected, `Original input changed: ${path}`);
    inputPins[path] = sha; return JSON.parse(bytes.toString());
  };
  await read('.local/prompt-trial-inputs/known.json');
  const prior = '.local/lifecycle-sources-v1', review = await read(`${prior}/review.json`);
  const original = (name: string) => read(`${prior}/${name}`, review.fingerprints[name]);
  const update = await original('automatic-update-decision.json'), plans = await original('plan-traces.json'), recall = await original('automatic-update-recall.json');
  const updateInput: MemoryTurnInput = plans.find((entry: { input?: MemoryTurnInput }) => entry.input?.scope.turnId === update.scope.turnId).input;
  assert.equal(updateInput.sources.find(source => source.id === updateInput.currentMessageId)?.text, update.text);
  const manifest = await read('.local/deepseek-comparison/inputs-manifest.json');
  const expanded: MemoryTurnInput = await read('.local/source-budget-v2/complete-input.json', manifest.expandedInputSha256);
  return { cases: [...known.cases.map(fixture => ({ id: fixture.id, input: fixture.input, records: fixture.records, query: fixture.criteria.query, criteria: fixture.criteria })),
    { id: 'natural-update', input: updateInput, records: update.sourcesBefore, query: recall.text }], expanded, inputPins };
}
type Tables = Record<string, Record<string, unknown>[]>;
export function semanticDatabaseTables(db: Database.Database): Tables {
  return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(({ name }) => {
    assert.match(name, /^[a-z_]+$/);
    const rows = db.prepare(`SELECT * FROM ${name}`).all() as Record<string, unknown>[];
    return [name, rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))];
  }));
}
function verifyReopen(before: Tables, after: Tables): object {
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const name of Object.keys(before)) if (name !== 'memory_search_data') assert.deepEqual(after[name], before[name], `Reopen changed ${name}`);
  const oldRows = before.memory_search_data!, newRows = after.memory_search_data!;
  assert.deepEqual(newRows.filter(row => row.id !== 10), oldRows.filter(row => row.id !== 10));
  const oldBlock = oldRows.find(row => row.id === 10)?.block, newBlock = newRows.find(row => row.id === 10)?.block;
  assert.ok(Buffer.isBuffer(oldBlock) && Buffer.isBuffer(newBlock));
  assert.equal(newBlock.readUInt32BE(0), oldBlock.readUInt32BE(0) + 1); assert.deepEqual(newBlock.subarray(4), oldBlock.subarray(4));
  return { businessAndLogicalIndexUnchanged: true, physicalChanged: ['memory_search_data'], beforeStructure: oldBlock, afterStructure: newBlock,
    limitation: 'Observed FTS structure counter changes on open; not byte-identical database reopening.' };
}
export interface SemanticCaseResult {
  id: string; passed: boolean; syntheticReadState: true; historicalTransactionReplay: false; wholeAcceptance: false;
  origin: 'controlled_stub' | 'real_provider'; attempts: number; traces: Record<string, unknown>[];
  [key: string]: unknown;
}
export interface SemanticCaseOptions {
  filename: string; fixture: SemanticFixture; expanded?: MemoryTurnInput; signal: AbortSignal;
  origin: 'controlled_stub' | 'real_provider'; countInput: (input: MemoryTurnInput) => number;
  attempt: (snapshot: PrototypeSnapshot, ordinal: number, expansion?: SemanticExpansionProof) => Promise<{ declaration: SemanticDeclaration; compiled: PrototypeResult }>;
}
/** Calls only the supplied attempt function. Each attempt sees the read snapshot, never fixture criteria or gold responses. */
export async function runSemanticCase(options: SemanticCaseOptions): Promise<SemanticCaseResult> {
  const { fixture, signal, filename } = options, owned = fixture.input.scope;
  const result: SemanticCaseResult = { id: fixture.id, passed: false, syntheticReadState: true, historicalTransactionReplay: false,
    origin: options.origin, attempts: 0, traces: [], wholeAcceptance: false };
  let store: SqliteMemoryStore | undefined, db: Database.Database | undefined, ticket: TurnTicket | undefined;
  const now = fixture.input.sources.find(source => source.id === fixture.input.currentMessageId)?.createdAt;
  assert.ok(now);
  const openStore = () => new SqliteMemoryStore({ filename, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => now });
  const turnOptions = { maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, inputTokenBudget: 32768, countTokens: options.countInput };
  const port = (activeStore: SqliteMemoryStore) => new SqliteLifecycleMemoryPort(activeStore, {
    context: { ...turnOptions, countTokens: contextInputUpperBound, relevance: () => 1 },
    turn: { ...turnOptions, provider: { async plan() { throw Error('No extra semantic model call is allowed'); } } },
    summary: { minMessages: 4, maxMessages: 4, inputTokenBudget: 32768, countTokens: () => 1, provider: { async summarize() { throw Error('No summary generation in semantic evaluation'); } } },
  });
  try {
    signal.throwIfAborted();
    // Exclusive empty file creation prevents restoring a fixture over any existing database.
    await writeFile(filename, '', { flag: 'wx' });
    store = openStore(); db = new Database(filename);
    let backing = new SqliteLedgerBacking(db, owned.characterId);
    assert.equal(backing.records.select().length, 0);
    assert.ok(fixture.records.every(record => record.characterId === owned.characterId));
    db.transaction(() => { for (const record of fixture.records) backing.records.set(record.id, record); })();
    result.sourcesBefore = backing.records.select(); result.wholeDatabaseBefore = semanticDatabaseTables(db);
    for (const record of fixture.records) assert.deepEqual(store.inspect(owned, record.id), record);
    const current = fixture.input.sources.find(source => source.id === fixture.input.currentMessageId)!;
    ticket = store.lifecycle.readTurn(owned, current.id, current.text, turnOptions);
    assert.deepEqual(normalizedSemanticInput(ticket.input), normalizedSemanticInput(fixture.input), 'Actual first ticket differs from frozen original');
    assert.deepEqual(semanticDatabaseTables(db), result.wholeDatabaseBefore, 'Reading the ticket mutated a table');
    let expansionProof: SemanticExpansionProof | undefined, initialRequest: SemanticDeclaration['request'] | undefined;
    for (let ordinal = 1; ordinal <= (fixture.id === 'closure' ? 2 : 1); ordinal++) {
      signal.throwIfAborted(); assert.ok(ticket);
      const before = semanticDatabaseTables(db), snapshot = prototypeSnapshot(ticket.input, backing.records.select());
      const trace: Record<string, unknown> = { ordinal, input: structuredClone(ticket.input), graph: snapshot.graph, inputUpperBound: options.countInput(ticket.input),
        ticketEpoch: ticket.epoch, ticketTextHash: ticket.textHash, wholeDatabaseBefore: before };
      result.traces.push(trace); result.attempts++;
      const started = performance.now();
      let answer: Awaited<ReturnType<SemanticCaseOptions['attempt']>>;
      try { answer = await options.attempt(snapshot, ordinal, expansionProof); }
      finally {
        trace.modelAndCompileMs = performance.now() - started; trace.wholeDatabaseAfterAttempt = semanticDatabaseTables(db);
        assert.deepEqual(trace.wholeDatabaseAfterAttempt, before, 'Model/decoder/compiler mutated a database table');
      }
      signal.throwIfAborted();
      trace.declaration = answer.declaration; trace.compiled = answer.compiled;
      if (ordinal === 1) initialRequest = answer.declaration.request;
      else assert.equal(answer.declaration.request, initialRequest, 'Supplementary request kind changed');
      const compiled = answer.compiled;
      if (compiled.status === 'needs_sources') {
        assert.equal(fixture.id, 'closure', 'Only original closure may expand'); assert.equal(ordinal, 1, 'No third declaration');
        assert.ok(compiled.readProbe && compiled.sources.length && options.expanded, 'No valid necessary expansion probe');
        const expansionStarted = performance.now();
        const expansion: TurnExpansion = store.lifecycle.expandTurn(ticket, compiled.readProbe, turnOptions);
        trace.expansion = expansion; trace.expansionMs = performance.now() - expansionStarted;
        assert.deepEqual(semanticDatabaseTables(db), before, 'Necessary expansion mutated a table');
        assert.equal(expansion.status, 'expanded'); if (expansion.status !== 'expanded') throw Error('Expansion failed');
        ticket = expansion.ticket;
        assert.equal(ticket.epoch, trace.ticketEpoch); assert.equal(ticket.textHash, trace.ticketTextHash);
        assert.deepEqual(normalizedSemanticInput(ticket.input), normalizedSemanticInput(options.expanded), 'Expanded ticket differs from original full input');
        assert.equal(ticket.input.sources.length, 43); assert.equal(snapshot.input.sources.length, 25);
        expansionProof = { firstAttempt: 1, status: 'needs_sources', zeroTableWrites: true, requiredSources: compiled.sources.length, expandedInputSha256: semanticInputHash(ticket.input) };
        continue;
      }
      assert.equal(compiled.status, 'ready', 'Missing semantic decisions stop without another call');
      if (compiled.status !== 'ready') throw Error('No executable plan');
      signal.throwIfAborted();
      const commitStarted = performance.now(), outcome = store.lifecycle.commitTurn(ticket, compiled.plan);
      trace.commitMs = performance.now() - commitStarted; result.outcome = outcome;
      store.lifecycle.registerCurrent(owned, current.id, current.text, outcome);
      if (compiled.plan.clarification !== null) {
        assert.equal(outcome.status, 'needs_clarification'); assert.deepEqual(semanticDatabaseTables(db), before, 'Clarification must write no tables');
        result.unresolvedZeroTableWrites = true;
        assert.equal(fixture.expectClarification, true, 'Clarification did not satisfy the original case action criteria');
      } else assert.ok(outcome.status === 'applied' || outcome.status === 'unchanged', `Store rejected final plan: ${JSON.stringify(outcome)}`);
      const memory = port(store), contextStarted = performance.now();
      const context = await memory.context({ ...owned, turnId: `${owned.turnId}:semantic-read` }, fixture.query, null, signal);
      memory.assertContextCurrent(context); result.contextAfter = context; result.contextMs = performance.now() - contextStarted;
      result.sourcesAfter = backing.records.select(); const active = backing.records.select().filter(record => record.state === 'active'); result.activeAfter = active;
      if (fixture.criteria) assertMemoryTrialResult({ id: fixture.id, input: fixture.input, records: fixture.records, maxPlans: fixture.id === 'closure' ? 2 : 1, criteria: fixture.criteria }, outcome, [...backing.records.select()], active, context);
      else if (fixture.id === 'natural-update') {
        assert.equal(outcome.status, 'applied'); const updated = store.inspect(owned, 'automatic-update:memory-0');
        assert.equal(updated?.version, 2); assert.equal(updated.text, '用户这周入职青禾，开始做产品设计。');
        assert.equal(store.inspect(owned, 'automatic-update:seed-user')?.state, 'invalidated'); assert.equal(store.inspect(owned, current.id)?.state, 'active');
        const isolatedContext = await new SqliteMemoryPort(store, { ...turnOptions, maxRecentMessages: 0, countTokens: contextInputUpperBound, relevance: () => 1 })
          .context({ ...owned, sessionId: `${owned.sessionId}:new-session`, turnId: 'original-natural-query' }, fixture.query, null, signal);
        assert.equal(isolatedContext.recent.length, 0); assert.ok(!isolatedContext.summary);
        assert.ok(isolatedContext.memories.some(item => item.id === updated.id && item.version === 2 && item.text === updated.text));
        assert.ok(!JSON.stringify(isolatedContext).includes('晨星')); result.newSessionMemoryOnlyContext = isolatedContext;
      }
      result.wholeDatabaseAfter = semanticDatabaseTables(db);
      if (outcome.status !== 'needs_clarification') {
        const replay = await memory.prepareTurn(owned, current.id, current.text, signal);
        assert.deepEqual(replay, outcome); assert.deepEqual(semanticDatabaseTables(db), result.wholeDatabaseAfter); result.idempotentZeroTableWrites = true;
      }
      const committed = semanticDatabaseTables(db), consumed = store.lifecycle.commitTurn(ticket, compiled.plan);
      assert.equal(consumed.status, 'rejected'); assert.equal(consumed.rejectionCode, 'unknown_or_consumed_turn');
      assert.deepEqual(semanticDatabaseTables(db), committed); result.consumedTicketRejectedWithoutWrite = true;
      db.close(); store.close(); ticket = undefined;
      store = openStore(); db = new Database(filename); backing = new SqliteLedgerBacking(db, owned.characterId);
      result.reopenedWholeDatabase = semanticDatabaseTables(db); result.reopen = verifyReopen(committed, result.reopenedWholeDatabase as Tables);
      const reopened = await port(store).context({ ...owned, sessionId: `${owned.sessionId}:reopen`, turnId: 'reopen-read' }, fixture.query, null, signal);
      const payload = (c: DialogueContext) => ({ recent: c.recent, summary: c.summary, memories: c.memories });
      assert.deepEqual(payload(reopened), payload(context)); result.reopenedContext = reopened;
      result.passed = true; break;
    }
    assert.equal(result.passed, true, 'Case did not complete');
  } catch (error) { result.error = { name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : 'Unknown evaluation failure', aborted: signal.aborted }; }
  finally {
    if (ticket && store) store.lifecycle.discardTurn(ticket);
    if (db?.open) { result.finalWholeDatabase = semanticDatabaseTables(db); result.finalSources = new SqliteLedgerBacking(db, owned.characterId).records.select(); db.close(); }
    if (store && !store.closed) store.close(); result.allStoresClosed = true;
  }
  return result;
}

/** Offline preparation only: freeze actual messages and source/runtime pins before requesting any paid approval. */
export async function prepareSemanticEvaluation(root: string, offlineRunId = 'originals-final'): Promise<object> {
  assert.match(offlineRunId, /^[a-z0-9-]+$/);
  const originals = await loadOriginalSemanticCases(root), directory = `${root}/${SEMANTIC_DIRECTORY}`;
  const verifiedPath = `.local/memory-semantic-offline-v1/${offlineRunId}`;
  const verification = JSON.parse(await readFile(`${root}/${verifiedPath}/manifest.json`, 'utf8'));
  const ticketBytes = await readFile(`${root}/${verifiedPath}/ticket-inputs.json`);
  assert.equal(semanticHash(ticketBytes), verification.ticketInputsSha256); assert.equal(verification.originalCasesPassed, 9);
  assert.equal(verification.modelCalls, 0); assert.equal(verification.actualNetwork, false); assert.equal(verification.origin, 'controlled_stub');
  assert.deepEqual(verification.results.map((r: { id: string; passed: boolean }) => [r.id, r.passed]), originals.cases.map(f => [f.id, true]));
  const tickets: Record<string, MemoryTurnInput> = JSON.parse(ticketBytes.toString());
  const samples = [...originals.cases.map(f => ({ id: f.id, input: f.input })), { id: 'closure:expanded', input: originals.expanded }];
  const requests = samples.map(({ id, input }) => {
    const actual = tickets[id]; assert.ok(actual);
    assert.deepEqual(normalizedSemanticInput(actual), normalizedSemanticInput(input), `Actual ticket changed original ${id} content`);
    const format = buildMemorySemanticFormat(actual);
    assert.ok(format.inputUpperBound <= 32768, `Original ${id} exceeds semantic input budget`);
    const request = { ...format.body, model: SEMANTIC_MODEL };
    return { id, input: actual, inputSha256: semanticInputHash(actual), inputUpperBound: format.inputUpperBound, system: format.system, systemSha256: semanticHash(format.system),
      body: request, requestBytes: Buffer.byteLength(JSON.stringify(request)), requestSha256: semanticHash(JSON.stringify(request)) };
  });
  assert.equal(new Set(requests.map(r => r.systemSha256)).size, 1, 'One fixed semantic system required');
  const registration = JSON.parse(await readFile(`${root}/.local/memory-semantic-offline-v1/registration.json`, 'utf8'));
  const tracked = execFileSync('git', ['ls-files', '-z', 'code/desktop-pet'], { cwd: root }).toString().split('\0').filter(Boolean);
  const paths = new Set<string>([...tracked, ...Object.keys(registration.fileOwners)]);
  const compiled: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(`${root}/${path}`, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, 'Compiled runtime cannot follow symlinks');
      const next = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(next); else if (entry.name.endsWith('.js')) compiled.push(next);
    }
  };
  await walk('code/desktop-pet/dist'); assert.ok(compiled.length > 0, 'Build the reviewed candidate first');
  for (const path of compiled) paths.add(path);
  const sourcePins = Object.fromEntries(await Promise.all([...paths].sort().map(async path => [path, semanticHash(await readFile(`${root}/${path}`))])));
  const pricing = JSON.parse(await readFile(`${root}/.local/memory-semantic-validation-plan/pricing-and-budget.json`, 'utf8'));
  const budgetBytes = await readFile(`${root}/.local/model-evaluation/budget.json`);
  assert.equal(semanticHash(budgetBytes), pricing.sharedBudgetReadonly.sha256, 'Shared budget changed since pricing review');
  const budget = JSON.parse(budgetBytes.toString()); assert.equal(budget.blocked, false); assert.ok(budget.entries.every((entry: { status: string }) => entry.status === 'settled'));
  const artifactPins = { ...originals.inputPins };
  artifactPins[`${verifiedPath}/manifest.json`] = semanticHash(await readFile(`${root}/${verifiedPath}/manifest.json`));
  artifactPins[`${verifiedPath}/ticket-inputs.json`] = semanticHash(ticketBytes);
  for (const path of ['.local/prompt-trial-inputs/STOPPED.json', '.local/deepseek-comparison/STOPPED.json', '.local/deepseek-comparison/config.json']) {
    artifactPins[path] = semanticHash(await readFile(`${root}/${path}`)); assert.equal(artifactPins[path], pricing.protectedReferences[path]);
  }
  const config: SemanticPhaseConfig = { phaseId: SEMANTIC_PHASE, model: SEMANTIC_MODEL, endpoint: SEMANTIC_ENDPOINT, parameters: SEMANTIC_PARAMETERS,
    maxAttempts: 6, phaseLimitMicros: 5_000_000, sharedLimitMicros: 10_000_000, reservationMicros: 3_700_000, inputLimit: 32768,
    promptSha256: requests[0]!.systemSha256, inputHashes: Object.fromEntries(requests.filter(row => [...semanticOrder, 'closure:expanded'].includes(row.id)).map(row => [row.id, row.inputSha256])),
    artifactPins, sourcePins, priorBudget: { count: budget.entries.length, entriesSha256: semanticHash(JSON.stringify(budget.entries)) }, cases: semanticOrder.map(id => ({ id, maxAttempts: id === 'closure' ? 2 : 1 })) };
  await mkdir(directory, { recursive: true });
  const save = (name: string, value: unknown) => writeFile(`${directory}/${name}`, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await save('requests.json', requests); await writeFile(`${directory}/system.txt`, requests[0]!.system, { flag: 'wx' });
  artifactPins[`${SEMANTIC_DIRECTORY}/requests.json`] = semanticHash(await readFile(`${directory}/requests.json`));
  artifactPins[`${SEMANTIC_DIRECTORY}/system.txt`] = semanticHash(await readFile(`${directory}/system.txt`));
  await save('config.json', config);
  const checked = await loadSemanticPhase(root, false);
  const receipt = { status: 'prepared_offline_only_not_paid_authorization', configSha256: checked.configSha256, promptSha256: config.promptSha256,
    requests: requests.map(({ id, inputUpperBound, requestBytes, requestSha256 }) => ({ id, inputUpperBound, requestBytes, requestSha256 })),
    sourceAndRuntimeFiles: paths.size, sharedPriorEntries: budget.entries.length, paidCalls: 0, credentialsRead: false, wholeAcceptance: false };
  await save('preparation.json', receipt); return receipt;
}

/** Prepare only the registered one-case candidate. No approval, credential, Store or ledger transaction is created. */
export async function prepareSemanticRawRecheck(root: string): Promise<object> {
  const profile = semanticPhaseProfile(SEMANTIC_RECHECK_PHASE), directory = `${root}/${profile.directory}`;
  const support = '.local/semantic-recheck-support-v1';
  const bytes = (path: string) => readSemanticPinnedFile(root, path);
  const read = async (path: string) => JSON.parse((await bytes(path)).toString());
  const registration = await read(`${support}/registration.json`);
  assert.equal(registration.package_id, 'I-SEMANTIC-RECHECK-SUPPORT-01');
  const allowed = ['code/desktop-pet/app/memory-semantic-phase.ts', 'code/desktop-pet/app/evaluate-memory-semantics.ts', 'code/desktop-pet/tests/integration/memory-semantic-evaluation.test.ts'];
  assert.deepEqual(registration.source_files, allowed);
  for (const [path, sha] of Object.entries(registration.source_pins)) if (!allowed.includes(path)) assert.equal(semanticHash(await bytes(path)), sha, `Unregistered source changed: ${path}`);
  for (const [path, sha] of Object.entries(registration.protected_artifact_pins)) assert.equal(semanticHash(await bytes(path)), sha, `Protected evidence changed: ${path}`);
  assert.equal(semanticHash(await bytes(registration.proposal)), registration.proposal_sha256);
  const proposal = await read(registration.proposal), candidate = proposal.proposed_phase;
  assert.equal(candidate.id, profile.phaseId); assert.equal(candidate.directory, profile.directory);
  assert.equal(candidate.max_attempts, profile.maxAttempts); assert.equal(candidate.phase_limit_micros, profile.phaseLimitMicros);
  assert.equal(candidate.shared_active_limit_micros, 10_000_000); assert.equal(candidate.reservation_micros, 3_700_000);
  assert.equal(candidate.input_limit, 32768); assert.equal(candidate.model, SEMANTIC_MODEL); assert.equal(candidate.endpoint, SEMANTIC_ENDPOINT);
  assert.deepEqual(candidate.parameters, SEMANTIC_PARAMETERS); assert.deepEqual(candidate.cases, [{ id: 'raw-only', max_attempts: 1 }]);
  const codeRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'code/desktop-pet'], { cwd: root, encoding: 'utf8' }).trim(), '', 'Commit reviewed sources before freezing');
  const verification = await read(`${support}/verification.json`);
  assert.equal(verification.status, 'passed'); assert.equal(verification.codeRef, codeRef);
  assert.equal(verification.actualNetworkCalls, 0); assert.equal(verification.credentialsRead, 0);
  assert.ok(verification.passed > 0); assert.equal(verification.failed, 0);
  for (const [path, sha] of Object.entries(verification.filePins)) assert.equal(semanticHash(await bytes(path)), sha, `Local verification changed: ${path}`);
  const originals = await loadOriginalSemanticCases(root), fixture = originals.cases.find(item => item.id === 'raw-only'); assert.ok(fixture);
  const frozen = (await read(`${SEMANTIC_DIRECTORY}/requests.json`)).find((item: { id: string }) => item.id === 'raw-only'); assert.ok(frozen);
  assert.deepEqual(normalizedSemanticInput(frozen.input), normalizedSemanticInput(fixture.input));
  const format = buildMemorySemanticFormat(frozen.input), request = { ...format.body, model: SEMANTIC_MODEL };
  assert.equal(semanticHash(format.system), candidate.system_sha256); assert.equal(format.systemBytes, candidate.system_bytes);
  assert.equal(semanticHash(JSON.stringify(request)), candidate.request_sha256);
  assert.equal(Buffer.byteLength(JSON.stringify(request)), candidate.request_bytes);
  assert.equal(format.inputUpperBound, candidate.input_upper_bound); assert.ok(format.inputUpperBound <= 32768);
  const currentSystemRequest = structuredClone(frozen.body); currentSystemRequest.messages[0].content = format.system;
  assert.deepEqual(request, currentSystemRequest, 'Original request changed beyond reviewed system');
  const reviewedPair = await read('.local/semantic-field-scope-v1/main-paired/manifest.json');
  assert.equal(reviewedPair.modelCalls, 0); assert.equal(reviewedPair.actualNetwork, false);
  assert.deepEqual(reviewedPair.outcomes.map((item: { mode: string; passed: boolean }) => [item.mode, item.passed]), [['preserved-failure', false], ['valid-original', true]]);
  const measured = await read('.local/semantic-field-scope-v1/main-payload-check.json');
  assert.equal(measured.entries.find((item: { id: string }) => item.id === 'raw-only').requestSha256, candidate.request_sha256);
  // Pricing remains a historical reference. Its obsolete 116-entry ledger SHA is deliberately not reused.
  const budgetBytes = await bytes('.local/model-evaluation/budget.json'), budget = JSON.parse(budgetBytes.toString());
  assert.equal(semanticHash(budgetBytes), proposal.ledger_readonly.sha256); assert.equal(budget.entries.length, 117);
  assert.equal(budget.batchId, 'D09-S1-20260906-01'); assert.equal(budget.limitMicros, 10_000_000); assert.equal(budget.blocked, false);
  assert.ok(budget.entries.every((entry: { status: string; actualMicros: number }) => entry.status === 'settled' && Number.isSafeInteger(entry.actualMicros) && entry.actualMicros >= 0));
  assert.equal(semanticHash(JSON.stringify(budget.entries)), proposal.ledger_readonly.entries_sha256);
  const used = budget.entries.reduce((sum: number, entry: { actualMicros: number }) => sum + entry.actualMicros, 0);
  assert.equal(used, proposal.ledger_readonly.used_micros); assert.ok(used + 3_700_000 <= 10_000_000);
  const paths = execFileSync('git', ['ls-files', '-z', 'code/desktop-pet'], { cwd: root }).toString().split('\0').filter(Boolean);
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(`${root}/${path}`, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false); const next = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(next); else if (entry.name.endsWith('.js')) paths.push(next);
    }
  };
  await walk('code/desktop-pet/dist');
  const sourcePins = Object.fromEntries(await Promise.all([...new Set(paths)].sort().map(async path => [path, semanticHash(await bytes(path))])));
  const artifactPins: Record<string, string> = { ...originals.inputPins };
  const references = [...profile.protectedPaths, `${support}/registration.json`, `${support}/verification.json`, registration.proposal,
    '.local/memory-semantic-validation-plan/pricing-and-budget.json', '.local/semantic-field-scope-v1/review.json',
    '.local/semantic-field-scope-v1/main-paired/manifest.json', '.local/semantic-field-scope-v1/main-payload-check.json'];
  for (const path of references) artifactPins[path] = semanticHash(await bytes(path));
  const requests = [{ id: 'raw-only', input: frozen.input, inputSha256: semanticInputHash(frozen.input), systemSha256: semanticHash(format.system),
    systemBytes: format.systemBytes, inputUpperBound: format.inputUpperBound, body: request, requestBytes: Buffer.byteLength(JSON.stringify(request)), requestSha256: semanticHash(JSON.stringify(request)) }];
  // All validation precedes exclusive candidate creation; an existing phase is never overwritten or resumed.
  await mkdir(directory);
  const save = (name: string, value: unknown) => writeFile(`${directory}/${name}`, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await writeFile(`${directory}/prior-budget.json`, budgetBytes, { flag: 'wx' });
  await writeFile(`${directory}/system.txt`, format.system, { flag: 'wx' }); await save('requests.json', requests);
  for (const name of ['prior-budget.json', 'system.txt', 'requests.json']) artifactPins[`${profile.directory}/${name}`] = semanticHash(await bytes(`${profile.directory}/${name}`));
  const config: SemanticPhaseConfig = { phaseId: profile.phaseId, model: SEMANTIC_MODEL, endpoint: SEMANTIC_ENDPOINT, parameters: SEMANTIC_PARAMETERS,
    maxAttempts: profile.maxAttempts, phaseLimitMicros: profile.phaseLimitMicros, sharedLimitMicros: 10_000_000, reservationMicros: 3_700_000, inputLimit: 32768,
    promptSha256: semanticHash(format.system), inputHashes: { 'raw-only': semanticInputHash(frozen.input) }, artifactPins, sourcePins,
    priorBudget: { count: budget.entries.length, entriesSha256: semanticHash(JSON.stringify(budget.entries)) }, cases: [{ id: 'raw-only', maxAttempts: 1 }] };
  await save('config.json', config);
  const checked = await loadSemanticPhase(root, false, profile.phaseId);
  assert.deepEqual(await bytes('.local/model-evaluation/budget.json'), budgetBytes);
  const receipt = { status: 'prepared_inactive_not_paid_authorization', phaseId: profile.phaseId, codeRef, configSha256: checked.configSha256,
    promptSha256: config.promptSha256, requestSha256: requests[0]!.requestSha256, priorBudgetSha256: semanticHash(budgetBytes), priorEntries: 117,
    sourceRuntimePins: Object.keys(sourcePins).length, artifactPins: Object.keys(artifactPins).length, maxAttempts: 1, phaseLimitMicros: 4_000_000,
    sharedLimitMicros: 10_000_000, reservationMicros: 3_700_000, modelCalls: 0, credentialsRead: 0, sharedLedgerBytesUnchanged: true, wholeAcceptance: false };
  await save('preparation.json', receipt); return receipt;
}

/** A batch is registered data, not a new hardcoded execution profile. This never opens Store, a key or the ledger for writing. */
export async function prepareRegisteredSemanticBatch(root: string, phaseId: SemanticBatchId): Promise<object> {
  assert.ok(isSemanticBatch(phaseId), 'Unknown semantic batch');
  const profile = semanticPhaseProfile(phaseId), registrationPath = `${SEMANTIC_BATCH_ROOT}/registrations/${phaseId}.json`;
  const bytes = (path: string) => readSemanticPinnedFile(root, path);
  const read = async (path: string) => JSON.parse((await bytes(path)).toString());
  const board = await read('docs/agent/blackboard/CURRENT.json'), registered = board.semantic_batch_preparation;
  assert.equal(board.publication_pending, false); assert.equal(registered?.status, 'registered');
  assert.equal(registered.phase_id, phaseId); assert.equal(registered.executor, 'W0-I'); assert.equal(registered.coordinator, 'W0-C');
  assert.equal(registered.registration, registrationPath);
  const registrationBytes = await bytes(registrationPath); assert.equal(semanticHash(registrationBytes), registered.sha256);
  const registration = JSON.parse(registrationBytes.toString());
  const systemComparison = registration.version === 4, thinking = registration.version === 3 || systemComparison, comparison = registration.version === 2 || thinking;
  assert.deepEqual(Object.keys(registration).sort(), ['version', 'phaseId', 'cases', 'phaseLimitMicros', 'policySha256', 'verification', 'priorBudget', 'promptSha256', 'requestHashes', 'justification', ...(comparison ? ['model', 'comparison', 'pricingEvidence'] : [])].sort());
  assert.equal(registration.version, systemComparison ? 4 : thinking ? 3 : comparison ? 2 : 1); assert.equal(registration.phaseId, phaseId); checkSemanticCases(registration.cases);
  const model = comparison ? registration.model : SEMANTIC_MODEL;
  assert.equal(model, comparison ? SEMANTIC_PRO_MODEL : SEMANTIC_MODEL);
  const modelProfile = semanticModelProfile(model);
  const baseline = comparison ? await readSemanticModelComparison(root, registration.comparison, thinking ? SEMANTIC_PRO_MODEL : SEMANTIC_MODEL,
    systemComparison ? SEMANTIC_THINKING_PARAMETERS : SEMANTIC_PARAMETERS) : null;
  if (comparison) {
    assert.notEqual(registration.comparison.phaseId, phaseId);
    assert.deepEqual(registration.cases, [{ id: 'raw-only', maxAttempts: 1 }]);
    assert.deepEqual(Object.keys(registration.pricingEvidence).sort(), ['path', 'sha256']);
    assert.ok(registration.pricingEvidence.path.startsWith('.local/'));
    assert.equal(semanticHash(await bytes(registration.pricingEvidence.path)), registration.pricingEvidence.sha256);
  }
  assert.ok(typeof registration.justification === 'string' && registration.justification.trim());
  await readSemanticPolicy(root, registration.policySha256);
  assert.ok(Number.isSafeInteger(registration.phaseLimitMicros) && registration.phaseLimitMicros >= modelProfile.reservationMicros && registration.phaseLimitMicros <= SEMANTIC_SHARED_LIMIT);
  const codeRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'code/desktop-pet'], { cwd: root, encoding: 'utf8' }).trim(), '', 'Commit reviewed sources before freezing');
  assert.ok(registration.verification.path.startsWith('.local/'));
  assert.equal(semanticHash(await bytes(registration.verification.path)), registration.verification.sha256);
  const verification = await read(registration.verification.path);
  assert.equal(verification.status, 'passed'); assert.equal(verification.codeRef, codeRef);
  assert.equal(verification.actualNetworkCalls, 0); assert.equal(verification.credentialsRead, 0);
  assert.ok(verification.passed > 0); assert.equal(verification.failed, 0);
  for (const [path, sha] of Object.entries(verification.filePins)) assert.equal(semanticHash(await bytes(path)), sha, `Local verification changed: ${path}`);
  const originals = await loadOriginalSemanticCases(root), verifiedPath = '.local/memory-semantic-offline-v1/originals-final';
  const originalVerification = await read(`${verifiedPath}/manifest.json`), ticketBytes = await bytes(`${verifiedPath}/ticket-inputs.json`);
  assert.equal(semanticHash(ticketBytes), originalVerification.ticketInputsSha256);
  assert.equal(originalVerification.originalCasesPassed, 9); assert.equal(originalVerification.modelCalls, 0); assert.equal(originalVerification.actualNetwork, false);
  assert.equal(originalVerification.origin, 'controlled_stub');
  assert.deepEqual(originalVerification.results.map((r: { id: string; passed: boolean }) => [r.id, r.passed]), originals.cases.map(f => [f.id, true]));
  const tickets: Record<string, MemoryTurnInput> = JSON.parse(ticketBytes.toString());
  const cases: SemanticPhaseConfig['cases'] = registration.cases;
  const ids = [...cases.map(item => item.id), ...(cases.some(item => item.id === 'closure') ? ['closure:expanded'] : [])];
  assert.deepEqual(Object.keys(registration.requestHashes).sort(), [...ids].sort());
  const requests = ids.map(id => {
    const original = id === 'closure:expanded' ? originals.expanded : originals.cases.find(item => item.id === id)?.input, actual = tickets[id];
    assert.ok(original && actual); assert.deepEqual(normalizedSemanticInput(actual), normalizedSemanticInput(original));
    const format = buildMemorySemanticFormat(actual), body = { ...buildSemanticRequestBody(format, thinking ? 'high' : undefined), model };
    if (baseline) { assert.deepEqual(actual, baseline.original.input); (systemComparison ? assertSemanticSystemOnlyRequest : thinking ? assertSemanticThinkingOnlyRequest : assertSemanticModelOnlyRequest)(baseline.original.body, body); }
    assert.ok(format.inputUpperBound <= 32768); assert.equal(semanticHash(format.system), registration.promptSha256);
    const requestSha256 = semanticHash(JSON.stringify(body)); assert.equal(requestSha256, registration.requestHashes[id]);
    return { id, input: actual, inputSha256: semanticInputHash(actual), inputUpperBound: format.inputUpperBound, systemSha256: semanticHash(format.system),
      body, requestBytes: Buffer.byteLength(JSON.stringify(body)), requestSha256 };
  });
  const budgetBytes = await bytes('.local/model-evaluation/budget.json'), budget = JSON.parse(budgetBytes.toString());
  assert.equal(semanticHash(budgetBytes), registration.priorBudget.ledgerSha256);
  assert.equal(budget.entries.length, registration.priorBudget.count); assert.equal(semanticHash(JSON.stringify(budget.entries)), registration.priorBudget.entriesSha256);
  assert.equal(budget.batchId, 'D09-S1-20260906-01'); assert.equal(budget.currency, 'CNY'); assert.equal(budget.limitMicros, SEMANTIC_SHARED_LIMIT); assert.equal(budget.blocked, false);
  const operations = new Set<string>(); let used = 0;
  for (const entry of budget.entries) {
    assert.equal(entry.status, 'settled', 'Unsettled prior cost prevents preparation');
    assert.ok(entry.operationId && !operations.has(entry.operationId)); operations.add(entry.operationId);
    assert.ok(Number.isSafeInteger(entry.actualMicros) && entry.actualMicros >= 0 && Number.isSafeInteger(entry.reservedMicros) && entry.reservedMicros > 0); used += entry.actualMicros;
  }
  assert.ok(used + modelProfile.reservationMicros <= SEMANTIC_SHARED_LIMIT, 'Shared budget cannot reserve next call');
  const paths = execFileSync('git', ['ls-files', '-z', 'code/desktop-pet'], { cwd: root }).toString().split('\0').filter(Boolean);
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(`${root}/${path}`, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false); const next = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(next); else if (entry.name.endsWith('.js')) paths.push(next);
    }
  };
  await walk('code/desktop-pet/dist');
  const sourcePins: Record<string, string> = {};
  for (const path of [...new Set(paths)].sort()) {
    sourcePins[path] = semanticHash(await bytes(path)); assert.equal(sourcePins[path], verification.filePins[path], `Source/runtime lacks reviewed evidence: ${path}`);
  }
  const artifactPins = { ...originals.inputPins };
  if (baseline) { Object.assign(artifactPins, baseline.pins); artifactPins[registration.pricingEvidence.path] = registration.pricingEvidence.sha256; }
  for (const [path, sha] of Object.entries(verification.filePins)) if (path.startsWith('.local/')) artifactPins[path] = sha as string;
  for (const path of [...profile.protectedPaths, registrationPath, registration.verification.path, SEMANTIC_POLICY, `${verifiedPath}/manifest.json`, `${verifiedPath}/ticket-inputs.json`]) artifactPins[path] = semanticHash(await bytes(path));
  // Exclusive creation follows every read-only validation. No stage or old stopped record is overwritten.
  await mkdir(`${root}/${profile.directory}`);
  const save = (name: string, value: unknown) => writeFile(`${root}/${profile.directory}/${name}`, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await writeFile(`${root}/${profile.directory}/prior-budget.json`, budgetBytes, { flag: 'wx' });
  await writeFile(`${root}/${profile.directory}/system.txt`, buildMemorySemanticFormat(requests[0]!.input).system, { flag: 'wx' }); await save('requests.json', requests);
  for (const name of ['prior-budget.json', 'requests.json', 'system.txt']) artifactPins[`${profile.directory}/${name}`] = semanticHash(await bytes(`${profile.directory}/${name}`));
  const config: SemanticPhaseConfig = { phaseId, batchVersion: systemComparison ? 4 : thinking ? 3 : comparison ? 2 : 1, policySha256: registration.policySha256, model, endpoint: SEMANTIC_ENDPOINT, parameters: thinking ? SEMANTIC_THINKING_PARAMETERS : SEMANTIC_PARAMETERS,
    ...(comparison ? { comparison: registration.comparison, pricingEvidence: registration.pricingEvidence } : {}),
    maxAttempts: cases.reduce((sum, item) => sum + item.maxAttempts, 0), phaseLimitMicros: registration.phaseLimitMicros, sharedLimitMicros: SEMANTIC_SHARED_LIMIT, reservationMicros: modelProfile.reservationMicros, inputLimit: 32768,
    promptSha256: registration.promptSha256, inputHashes: Object.fromEntries(requests.map(item => [item.id, item.inputSha256])), sourcePins, artifactPins,
    priorBudget: { count: budget.entries.length, entriesSha256: semanticHash(JSON.stringify(budget.entries)) }, cases };
  await save('config.json', config); const checked = await loadSemanticPhase(root, false, phaseId);
  assert.deepEqual(await bytes('.local/model-evaluation/budget.json'), budgetBytes);
  const receipt = { status: 'prepared_inactive', phaseId, codeRef, configSha256: checked.configSha256, priorEntries: budget.entries.length, priorEstimatedMicros: used,
    modelCalls: 0, credentialsRead: 0, sourceRuntimePins: Object.keys(sourcePins).length, artifactPins: Object.keys(artifactPins).length, requests: requests.map(({ id, requestSha256, requestBytes, inputUpperBound }) => ({ id, requestSha256, requestBytes, inputUpperBound })) };
  await save('preparation.json', receipt); return receipt;
}

export function semanticEvidenceFetcher(fetcher: typeof fetch, capture: (record: object) => Promise<void>): typeof fetch {
  let ordinal = 0;
  return async (...args) => {
    ordinal++;
    const response = await fetcher(...args);
    // Preserve successful HTTP bytes before JSON parsing or usage settlement can throw.
    // Error bodies and request headers can contain supplier diagnostics; retain status only.
    const bytes = response.ok ? Buffer.from(await response.clone().arrayBuffer()) : null;
    await capture({ ordinal, status: response.status, requestId: response.headers.get('x-request-id'),
      rawText: bytes?.toString('utf8') ?? null, rawBase64: bytes?.toString('base64') ?? null,
      rawSha256: bytes === null ? null : semanticHash(bytes), errorBodyRetained: false });
    return response;
  };
}

/** One future approved case. The caller supplies a lazy credential callback only after explicit paid approval. */
export async function evaluateMemorySemantics(root: string, runId: string, credential: () => string, signal: AbortSignal, phaseId: SemanticPhaseId = SEMANTIC_PHASE): Promise<SemanticCaseResult> {
  // No key callback, claims, shared budget transaction or fetch before these independent gates.
  const profile = semanticPhaseProfile(phaseId), approved = await loadSemanticPhase(root, true, phaseId);
  const originals = await loadOriginalSemanticCases(root);
  for (const [path, sha] of Object.entries(originals.inputPins)) assert.equal(approved.config.artifactPins[path], sha, 'Loaded original was not approved');
  const pinnedRequests: { id: string; requestSha256: string }[] = JSON.parse(await readFile(`${root}/${profile.directory}/requests.json`, 'utf8'));
  const session = await beginSemanticCase(root, runId, signal, phaseId);
  const events: SemanticAttemptEvent[] = [], wireResponses: object[] = [];
  let posts = 0, result: SemanticCaseResult | undefined, completed = false;
  try {
    const fixture = originals.cases.find(f => f.id === session.caseId); assert.ok(fixture);
    const capturedFetch = semanticEvidenceFetcher(fetch, async captured => {
      wireResponses.push(captured);
      await appendFile(`${session.runPath}/wire-responses.jsonl`, JSON.stringify(captured) + '\n', { mode: 0o600 });
    });
    const transport = new ProviderTransport(async (...args) => { posts++; return capturedFetch(...args); });
    result = await runSemanticCase({ filename: `${session.runPath}/state.sqlite`, fixture, expanded: originals.expanded, signal, origin: 'real_provider',
      countInput: input => buildMemorySemanticFormat(input).inputUpperBound,
      attempt: async (snapshot, ordinal, proof) => {
        const format = buildMemorySemanticFormat(snapshot.input);
        const config = await session.prepareAttempt(snapshot.input, semanticHash(format.system), format.inputUpperBound, credential, proof);
        return runMemorySemanticAttempt({ snapshot, config, transport, ...(session.config.batchVersion === 3 || session.config.batchVersion === 4 ? { reasoningEffort: 'high' as const } : {}),
          provenance: { kind: 'real_provider', runId, attemptId: `${session.caseId}:${ordinal}` }, signal,
          evidence: async event => {
            events.push(structuredClone(event));
            await appendFile(`${session.runPath}/events.jsonl`, JSON.stringify(event) + '\n', { mode: 0o600 });
            if (event.type === 'request') {
              const refreshed = await loadSemanticPhase(root, true, phaseId); assert.equal(refreshed.configSha256, session.configSha256);
              const expected = pinnedRequests.find(row => row.id === (ordinal === 1 ? session.caseId : 'closure:expanded')); assert.ok(expected);
              assert.equal((event.data as { requestSha256: string }).requestSha256, expected.requestSha256, 'Actual serialized request differs from approved ticket wire');
              signal.throwIfAborted(); // The awaited evidence sink must not reopen a stopped/changed phase before apiKey().
            }
            if (event.type === 'response') assert.equal((event.data as { raw: { model?: string } }).raw.model, session.config.model, 'Returned model differs from configured model');
          },
        });
      },
    });
    assert.equal(result.passed, true, JSON.stringify(result.error)); assert.equal(posts, session.attempts);
    completed = true; return result;
  } finally {
    try {
      const readSettlements = async () => {
        try { return (await readFile(`${session.runPath}/settlements.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      };
      const settlements = await readSettlements();
      const manifest = { phaseId, caseId: session.caseId, runId, origin: 'real_provider', model: session.config.model,
        configSha256: session.configSha256, promptSha256: session.config.promptSha256,
        codeRef: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), attempts: session.attempts, networkPosts: posts,
        passed: completed, humanReviewRequired: true, wholeAcceptance: false, allStoresClosed: result?.allStoresClosed ?? true, devices: 0 };
      await writeFile(`${session.runPath}/attempts.json`, JSON.stringify({ events, wireResponses, settlements }, null, 2) + '\n', { flag: 'wx' });
      await writeFile(`${session.runPath}/result.json`, JSON.stringify(result ?? { id: session.caseId, passed: false, error: 'Failed before case result' }, null, 2) + '\n', { flag: 'wx' });
      await writeFile(`${session.runPath}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    } catch (error) { completed = false; throw error; }
    finally { await session.finish(completed); }
  }
}
