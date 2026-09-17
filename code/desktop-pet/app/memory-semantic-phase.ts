/** Independent evaluation phase. Merely importing this module never reads a key or writes the shared ledger. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { MemoryTurnInput } from '../contracts/memory-lifecycle.js';
import { EvaluationBudget, type BudgetState } from '../core/evaluation-budget.js';
import type { CallOutcome, EndpointConfig } from '../providers/transport.js';

export const SEMANTIC_PHASE = 'memory-semantic-validation-v1';
export const SEMANTIC_DIRECTORY = '.local/memory-semantic-offline-v1/phase';
export const SEMANTIC_RECHECK_PHASE = 'memory-semantic-raw-recheck-v1';
export type SemanticBatchId = `memory-semantic-batch-${string}`;
export type SemanticPhaseId = typeof SEMANTIC_PHASE | typeof SEMANTIC_RECHECK_PHASE | SemanticBatchId;
export const SEMANTIC_BATCH_ROOT = '.local/semantic-batches';
export const SEMANTIC_POLICY = '.local/model-evaluation/authorization-20-v1.json';
export const SEMANTIC_SHARED_LIMIT = 20_000_000;
export const isSemanticBatch = (id: string): id is SemanticBatchId => /^memory-semantic-batch-[0-9]{8}-[0-9]{2,4}$/.test(id);
export const SEMANTIC_MODEL = 'deepseek-v4-flash';
export const SEMANTIC_PRO_MODEL = 'deepseek-v4-pro';
export type SemanticModel = typeof SEMANTIC_MODEL | typeof SEMANTIC_PRO_MODEL;
/** Peak, cache-miss CNY micro-units; official pricing evidence is pinned by Pro batches. */
export function semanticModelProfile(model: SemanticModel) {
  assert.ok(model === SEMANTIC_MODEL || model === SEMANTIC_PRO_MODEL, 'Unknown semantic model');
  return Object.freeze(model === SEMANTIC_PRO_MODEL
    ? { inputRate: 9, outputRate: 27, maximumOutputTokens: 393_216, reservationMicros: 11_000_000 }
    : { inputRate: 3, outputRate: 9, maximumOutputTokens: 393_216, reservationMicros: 3_700_000 });
}
export const SEMANTIC_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const SEMANTIC_RESERVATION = 3_700_000;
export const SEMANTIC_PHASE_LIMIT = 5_000_000;
export const SEMANTIC_INPUT_LIMIT = 32_768;
export const SEMANTIC_PARAMETERS = { stream: false, thinking: { type: 'disabled' }, response_format: { type: 'json_object' } } as const;
export const SEMANTIC_THINKING_PARAMETERS = { ...SEMANTIC_PARAMETERS, thinking: { type: 'enabled' }, reasoning_effort: 'high' } as const;
export const semanticOrder = ['raw-only', 'closure', 'merge', 'retire', 'natural-update'] as const;
export type SemanticCaseId = typeof semanticOrder[number];
const ledgerPath = '.local/model-evaluation/budget.json';
const oldProtected = ['.local/prompt-trial-inputs/STOPPED.json', '.local/deepseek-comparison/STOPPED.json', '.local/deepseek-comparison/config.json'];
/** Historical defaults stay fixed. Registered batch limits come only from validated frozen configuration. */
export function semanticPhaseProfile(phaseId: SemanticPhaseId = SEMANTIC_PHASE) {
  assert.ok(phaseId === SEMANTIC_PHASE || phaseId === SEMANTIC_RECHECK_PHASE || isSemanticBatch(phaseId), 'Unknown semantic phase');
  const recheck = phaseId === SEMANTIC_RECHECK_PHASE;
  return Object.freeze({ phaseId, directory: isSemanticBatch(phaseId) ? `${SEMANTIC_BATCH_ROOT}/${phaseId}` : recheck ? '.local/semantic-raw-recheck-v1' : SEMANTIC_DIRECTORY,
    maxAttempts: recheck ? 1 as const : 6 as const, phaseLimitMicros: recheck ? 4_000_000 as const : 5_000_000 as const,
    order: Object.freeze(recheck ? ['raw-only'] as const : [...semanticOrder]),
    protectedPaths: Object.freeze(recheck || isSemanticBatch(phaseId) ? [...oldProtected, ...['STOPPED.json', 'config.json', 'system.txt', 'requests.json', 'review.json', 'manifest-all.json'].map(name => `${SEMANTIC_DIRECTORY}/${name}`),
      ...(isSemanticBatch(phaseId) ? ['STOPPED.json', 'config.json', 'system.txt', 'requests.json', 'review.json', 'manifest-all.json'].map(name => `.local/semantic-raw-recheck-v1/${name}`) : [])] : [...oldProtected]),
  });
}
export const semanticHash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function normalizedSemanticInput(input: MemoryTurnInput): MemoryTurnInput {
  const sort = <T extends { id: string }>(items: readonly T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  return { ...input, sources: sort(input.sources), messages: sort(input.messages), relevantMemories: sort(input.relevantMemories) };
}
export const semanticInputHash = (input: MemoryTurnInput): string => semanticHash(JSON.stringify(normalizedSemanticInput(input)));
export interface SemanticPhaseConfig {
  phaseId: SemanticPhaseId; model: SemanticModel; endpoint: typeof SEMANTIC_ENDPOINT;
  parameters: typeof SEMANTIC_PARAMETERS | typeof SEMANTIC_THINKING_PARAMETERS; maxAttempts: number; phaseLimitMicros: number;
  sharedLimitMicros: 10_000_000 | 20_000_000; reservationMicros: number; inputLimit: 32_768;
  batchVersion?: 1 | 2 | 3 | 4; policySha256?: string;
  comparison?: SemanticModelComparison; pricingEvidence?: { path: string; sha256: string };
  promptSha256: string; inputHashes: Record<string, string>; artifactPins: Record<string, string>; sourcePins: Record<string, string>;
  priorBudget: { count: number; entriesSha256: string }; cases: { id: SemanticCaseId; maxAttempts: number }[];
}
export interface SemanticModelComparison { phaseId: SemanticBatchId; configSha256: string; requestSha256: string }
const keys = (value: object) => Object.keys(value).sort();
const hashPattern = /^[a-f0-9]{64}$/;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export function checkSemanticCases(cases: SemanticPhaseConfig['cases']): void {
  assert.ok(Array.isArray(cases) && cases.length > 0 && cases.length <= semanticOrder.length, 'Nonempty original case subset required');
  let previous = -1;
  for (const item of cases) {
    assert.deepEqual(keys(item), ['id', 'maxAttempts']);
    const index = semanticOrder.indexOf(item.id);
    assert.ok(index > previous, 'Unknown, duplicate or unordered semantic case'); previous = index;
    assert.equal(item.maxAttempts, item.id === 'closure' ? 2 : 1, 'Original case attempt bound required');
  }
}
async function absent(path: string): Promise<void> {
  try { await lstat(path); } catch (error) { if (isMissing(error)) return; throw error; }
  throw new Error('Semantic phase is stopped, completed, or already claimed');
}
/** Every pinned file stays inside its project root and must be a regular file, without symlink ancestors. */
async function pinnedRead(root: string, relative: string): Promise<Buffer> {
  assert.ok(relative && !isAbsolute(relative) && !relative.split('/').some(part => !part || part === '.' || part === '..'));
  let path = root;
  for (const part of relative.split('/')) { path += `/${part}`; assert.equal((await lstat(path)).isSymbolicLink(), false, 'Pinned path cannot follow a symlink'); }
  assert.ok((await lstat(path)).isFile()); return readFile(path);
}
export { pinnedRead as readSemanticPinnedFile };
/** A model comparison never supplies semantic content or changes any other request parameter. */
export function assertSemanticModelOnlyRequest(baseline: object, candidate: object): void {
  assert.equal((baseline as { model?: unknown }).model, SEMANTIC_MODEL);
  assert.deepEqual(candidate, { ...baseline, model: SEMANTIC_PRO_MODEL }, 'Comparison must change only model');
}
export function assertSemanticThinkingOnlyRequest(baseline: object, candidate: object): void {
  assert.equal((baseline as { model?: unknown }).model, SEMANTIC_PRO_MODEL);
  assert.deepEqual((baseline as { thinking?: unknown }).thinking, { type: 'disabled' });
  assert.equal(Object.hasOwn(baseline, 'reasoning_effort'), false);
  assert.deepEqual(candidate, { ...baseline, thinking: { type: 'enabled' }, reasoning_effort: 'high' }, 'Comparison must change only thinking mode and effort');
}
/** Version4 compares reviewed system text against a prior Pro high request; all other fields are fixed. */
export function assertSemanticSystemOnlyRequest(baseline: object, candidate: object): void {
  const prior = baseline as { model?: unknown; thinking?: unknown; reasoning_effort?: unknown; stream?: unknown; response_format?: unknown; messages?: { role: string; content: string }[] };
  const next = candidate as { messages?: { role: string; content: string }[] };
  assert.equal(prior.model, SEMANTIC_PRO_MODEL); assert.deepEqual(prior.thinking, { type: 'enabled' });
  assert.equal(prior.reasoning_effort, 'high'); assert.equal(prior.stream, false); assert.deepEqual(prior.response_format, { type: 'json_object' });
  assert.ok(Array.isArray(prior.messages) && prior.messages.length === 2);
  assert.equal(prior.messages[0]!.role, 'system'); assert.equal(prior.messages[1]!.role, 'user');
  assert.ok(typeof prior.messages[0]!.content === 'string' && prior.messages[0]!.content.trim());
  assert.equal(typeof prior.messages[1]!.content, 'string');
  assert.ok(Array.isArray(next.messages) && next.messages.length === 2);
  const system = next.messages[0]!.content;
  assert.ok(typeof system === 'string' && system.trim()); assert.notEqual(system, prior.messages[0]!.content, 'System comparison requires an actual prompt change');
  assert.deepEqual(candidate, { ...baseline, messages: [{ ...prior.messages[0], content: system }, prior.messages[1]] }, 'Comparison must change only system content');
}
export async function readSemanticModelComparison(root: string, comparison: SemanticModelComparison, baselineModel: SemanticModel = SEMANTIC_MODEL,
  baselineParameters: typeof SEMANTIC_PARAMETERS | typeof SEMANTIC_THINKING_PARAMETERS = SEMANTIC_PARAMETERS) {
  semanticModelProfile(baselineModel);
  assert.deepEqual(keys(comparison), ['configSha256', 'phaseId', 'requestSha256']);
  assert.ok(isSemanticBatch(comparison.phaseId));
  assert.match(comparison.configSha256, hashPattern); assert.match(comparison.requestSha256, hashPattern);
  const directory = semanticPhaseProfile(comparison.phaseId).directory;
  const configPath = `${directory}/config.json`, requestsPath = `${directory}/requests.json`;
  const configBytes = await pinnedRead(root, configPath); assert.equal(semanticHash(configBytes), comparison.configSha256);
  const config = JSON.parse(configBytes.toString());
  assert.equal(config.phaseId, comparison.phaseId); assert.equal(config.model, baselineModel);
  assert.deepEqual(config.parameters, baselineParameters);
  if (baselineParameters.thinking.type === 'enabled') assert.ok(config.batchVersion === 3 || config.batchVersion === 4, 'System comparison requires a prior high-mode version');
  const requestBytes = await pinnedRead(root, requestsPath); assert.equal(semanticHash(requestBytes), config.artifactPins[requestsPath]);
  const requests = JSON.parse(requestBytes.toString());
  assert.ok(Array.isArray(requests)); const originals = requests.filter(item => item.id === 'raw-only'); assert.equal(originals.length, 1);
  const original = originals[0]; assert.equal(original.requestSha256, comparison.requestSha256);
  assert.equal(semanticHash(JSON.stringify(original.body)), comparison.requestSha256);
  assert.equal(semanticHash(original.body.messages[0].content), config.promptSha256);
  return { original, pins: { [configPath]: comparison.configSha256, [requestsPath]: semanticHash(requestBytes) } };
}
/** The canonical board binds the already-authorized policy, never a caller-supplied credential or ceiling. */
export async function readSemanticPolicy(root: string, expectedSha256: string): Promise<void> {
  assert.match(expectedSha256, hashPattern);
  const board = JSON.parse((await pinnedRead(root, 'docs/agent/blackboard/CURRENT.json')).toString());
  assert.equal(board.publication_pending, false);
  assert.equal(board.model_budget_policy?.status, 'approved');
  assert.equal(board.model_budget_policy.record, SEMANTIC_POLICY);
  assert.equal(board.model_budget_policy.sha256, expectedSha256, 'Policy fingerprint differs');
  assert.equal(board.model_budget_policy.project_total_limit_micros, SEMANTIC_SHARED_LIMIT);
  const bytes = await pinnedRead(root, SEMANTIC_POLICY); assert.equal(semanticHash(bytes), expectedSha256, 'Policy bytes changed');
  const policy = JSON.parse(bytes.toString());
  assert.equal(policy.version, 1); assert.equal(policy.status, 'approved'); assert.equal(policy.currency, 'CNY');
  assert.equal(policy.executor, 'W0-I'); assert.equal(policy.coordinator, 'W0-C'); assert.equal(policy.project_total_limit_micros, SEMANTIC_SHARED_LIMIT);
}

/** Explicit one-time metadata migration under both existing locks. Historical entries are not rewritten. */
export async function migrateSemanticBudget20(root: string): Promise<object> {
  const directory = '.local/model-evaluation/limit-20-v1';
  const board = JSON.parse((await pinnedRead(root, 'docs/agent/blackboard/CURRENT.json')).toString());
  await readSemanticPolicy(root, board.model_budget_policy?.sha256);
  assert.ok(['stopped_after_declaration_compile_failure', 'stopped_after_first_semantic_failure', 'completed_reviewed'].includes(board.semantic_model_evaluation?.status), 'An active or unreviewed batch prevents migration');
  const backendPath = `${root}/.local/model-evaluation/backend.lock`, budgetLockPath = `${root}/${ledgerPath}.lock`;
  const backend = await open(backendPath, 'wx');
  try {
    const lock = await open(budgetLockPath, 'wx');
    try {
      await absent(`${root}/${directory}`);
      assert.deepEqual(JSON.parse((await pinnedRead(root, 'docs/agent/blackboard/CURRENT.json')).toString()), board, 'Formal state changed during migration');
      const before = await pinnedRead(root, ledgerPath), state: BudgetState = JSON.parse(before.toString());
      validatedBudget(state, { phaseId: SEMANTIC_PHASE, model: SEMANTIC_MODEL, reservationMicros: SEMANTIC_RESERVATION, sharedLimitMicros: 10_000_000, priorBudget: { count: state.entries.length, entriesSha256: semanticHash(JSON.stringify(state.entries)) }, cases: [] });
      assert.ok(state.entries.reduce((sum, entry) => sum + entry.actualMicros!, 0) <= 10_000_000);
      const afterState = { ...state, limitMicros: SEMANTIC_SHARED_LIMIT }, after = Buffer.from(JSON.stringify(afterState, null, 2) + '\n');
      assert.deepEqual({ ...afterState, limitMicros: state.limitMicros }, state);
      // Keep recoverable original bytes before an atomic rename. Interrupted migration never silently restarts.
      await mkdir(`${root}/${directory}`);
      await writeFile(`${root}/${directory}/before.json`, before, { flag: 'wx', mode: 0o600 });
      await writeFile(`${root}/${directory}/after.json`, after, { flag: 'wx', mode: 0o600 });
      const next = `${root}/${ledgerPath}.limit-20-next`, output = await open(next, 'wx', 0o600);
      try { await output.writeFile(after); await output.sync(); } finally { await output.close(); }
      await rename(next, `${root}/${ledgerPath}`);
      assert.deepEqual(await pinnedRead(root, ledgerPath), after);
      const receipt = { version: 1, policySha256: board.model_budget_policy.sha256, beforeSha256: semanticHash(before), afterSha256: semanticHash(after),
        entriesSha256: semanticHash(JSON.stringify(state.entries)), entryCount: state.entries.length, changedFields: ['limitMicros'], from: 10_000_000, to: SEMANTIC_SHARED_LIMIT,
        entriesAndOtherMetadataUnchanged: true, realCalls: 0 };
      await writeFile(`${root}/${directory}/receipt.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); return receipt;
    } finally { await lock.close(); await unlink(budgetLockPath); }
  } finally { await backend.close(); await unlink(backendPath); }
}
function checkConfig(config: SemanticPhaseConfig, phaseId: SemanticPhaseId): void {
  const profile = semanticPhaseProfile(phaseId);
  const batch = isSemanticBatch(phaseId);
  const systemComparison = batch && config.batchVersion === 4;
  const thinking = batch && (config.batchVersion === 3 || systemComparison);
  const comparison = batch && (config.batchVersion === 2 || thinking), model = semanticModelProfile(config.model);
  assert.deepEqual(keys(config), ['phaseId', 'model', 'endpoint', 'parameters', 'maxAttempts', 'phaseLimitMicros', 'sharedLimitMicros', 'reservationMicros', 'inputLimit', 'promptSha256', 'inputHashes', 'artifactPins', 'sourcePins', 'priorBudget', 'cases', ...(batch ? ['batchVersion', 'policySha256'] : []), ...(comparison ? ['comparison', 'pricingEvidence'] : [])].sort());
  assert.equal(config.phaseId, phaseId, 'Configuration belongs to another semantic phase'); assert.equal(config.model, comparison ? SEMANTIC_PRO_MODEL : SEMANTIC_MODEL); assert.equal(config.endpoint, SEMANTIC_ENDPOINT);
  assert.deepEqual(config.parameters, thinking ? SEMANTIC_THINKING_PARAMETERS : SEMANTIC_PARAMETERS);
  if (batch) {
    assert.equal(config.batchVersion, systemComparison ? 4 : thinking ? 3 : comparison ? 2 : 1); assert.match(config.policySha256!, hashPattern); checkSemanticCases(config.cases);
    assert.equal(config.maxAttempts, config.cases.reduce((sum, item) => sum + item.maxAttempts, 0)); assert.ok(config.maxAttempts <= 6);
    assert.ok(Number.isSafeInteger(config.phaseLimitMicros) && config.phaseLimitMicros >= model.reservationMicros && config.phaseLimitMicros <= SEMANTIC_SHARED_LIMIT);
    assert.equal(config.sharedLimitMicros, SEMANTIC_SHARED_LIMIT);
    for (const name of ['prior-budget.json', 'requests.json', 'system.txt']) assert.match(config.artifactPins[`${profile.directory}/${name}`]!, hashPattern);
    assert.equal(config.artifactPins[SEMANTIC_POLICY], config.policySha256);
    assert.match(config.artifactPins[`${SEMANTIC_BATCH_ROOT}/registrations/${phaseId}.json`]!, hashPattern);
    if (comparison) {
      assert.deepEqual(config.cases, [{ id: 'raw-only', maxAttempts: 1 }]);
      assert.ok(config.comparison && config.comparison.phaseId !== phaseId);
      assert.deepEqual(keys(config.pricingEvidence!), ['path', 'sha256']);
      assert.ok(config.pricingEvidence!.path.startsWith('.local/'));
      assert.match(config.pricingEvidence!.sha256, hashPattern);
      assert.equal(config.artifactPins[config.pricingEvidence!.path], config.pricingEvidence!.sha256);
    }
  } else {
    assert.equal(config.maxAttempts, profile.maxAttempts, 'Phase attempt limit differs from fixed profile');
    assert.equal(config.phaseLimitMicros, profile.phaseLimitMicros, 'Phase budget differs from fixed profile'); assert.equal(config.sharedLimitMicros, 10_000_000);
    assert.deepEqual(config.cases, profile.order.map(id => ({ id, maxAttempts: id === 'closure' ? 2 : 1 })));
  }
  assert.equal(config.reservationMicros, model.reservationMicros); assert.equal(config.inputLimit, SEMANTIC_INPUT_LIMIT);
  assert.match(config.promptSha256, hashPattern);
  assert.deepEqual(keys(config.inputHashes), [...config.cases.map(item => item.id), ...(config.cases.some(item => item.id === 'closure') ? ['closure:expanded'] : [])].sort());
  for (const sha of Object.values(config.inputHashes)) assert.match(sha, hashPattern);
  assert.deepEqual(keys(config.priorBudget), ['count', 'entriesSha256']);
  assert.ok(Number.isSafeInteger(config.priorBudget.count) && config.priorBudget.count >= 0); assert.match(config.priorBudget.entriesSha256, hashPattern);
  if (phaseId === SEMANTIC_RECHECK_PHASE) { assert.equal(config.priorBudget.count, 117); assert.match(config.artifactPins[`${profile.directory}/prior-budget.json`]!, hashPattern); }
  for (const path of profile.protectedPaths) assert.match(config.artifactPins[path]!, hashPattern, 'Old stopped records must be pinned');
  assert.ok(Object.keys(config.sourcePins).length > 0, 'Source pins required');
  for (const [path, sha] of Object.entries(config.sourcePins)) { assert.ok(path.startsWith('code/desktop-pet/')); assert.match(sha, hashPattern); }
  for (const [path, sha] of Object.entries(config.artifactPins)) { assert.ok(path.startsWith('.local/') && path !== ledgerPath); assert.match(sha, hashPattern); }
  assert.ok(SEMANTIC_INPUT_LIMIT * model.inputRate + model.maximumOutputTokens * model.outputRate <= config.reservationMicros);
}
export async function loadSemanticPhase(root: string, requirePaidApproval = true, phaseId: SemanticPhaseId = SEMANTIC_PHASE): Promise<{ config: SemanticPhaseConfig; configSha256: string }> {
  assert.ok(isAbsolute(root) && resolve(root) === root);
  const profile = semanticPhaseProfile(phaseId);
  for (const name of ['STOPPED.json', 'COMPLETED.json']) await absent(`${root}/${profile.directory}/${name}`);
  const bytes = await pinnedRead(root, `${profile.directory}/config.json`);
  const config: SemanticPhaseConfig = JSON.parse(bytes.toString()); checkConfig(config, phaseId);
  const configSha256 = semanticHash(bytes);
  if (requirePaidApproval) {
    const board = JSON.parse((await pinnedRead(root, 'docs/agent/blackboard/CURRENT.json')).toString());
    assert.equal(board.publication_pending, false);
    assert.equal(board.semantic_model_evaluation?.status, 'approved_for_bounded_evaluation', 'Paid semantic evaluation is not authorized');
    assert.equal(board.semantic_model_evaluation.config_sha256, configSha256, 'Approved configuration fingerprint differs');
    assert.equal(board.semantic_model_evaluation.phase_id, phaseId, 'Blackboard phase does not match selected semantic phase');
    assert.ok(typeof board.semantic_model_evaluation.authorization_record === 'string' && board.semantic_model_evaluation.authorization_record.trim(), 'Explicit user authorization record required');
    if (phaseId === SEMANTIC_RECHECK_PHASE || isSemanticBatch(phaseId)) {
      assert.equal(board.semantic_model_evaluation.executor, 'W0-I');
      assert.equal(board.semantic_model_evaluation.authorization_record, `${profile.directory}/authorization.json`);
      const approval = JSON.parse((await pinnedRead(root, board.semantic_model_evaluation.authorization_record)).toString());
      assert.equal(approval.status, 'approved'); assert.equal(approval.phase_id, phaseId, 'Approval belongs to another semantic phase'); assert.equal(approval.config_sha256, configSha256);
      assert.equal(approval.executor, 'W0-I'); assert.equal(approval.max_attempts, config.maxAttempts);
      assert.equal(approval.phase_limit_micros, config.phaseLimitMicros); assert.equal(approval.active_shared_limit_micros, config.sharedLimitMicros);
      if (isSemanticBatch(phaseId)) {
        await readSemanticPolicy(root, config.policySha256!);
        assert.equal(approval.coordinator, 'W0-C'); assert.equal(approval.project_policy, SEMANTIC_POLICY);
        assert.equal(approval.project_policy_sha256, config.policySha256); assert.deepEqual(approval.order, config.cases.map(item => item.id));
      }
    }
  }
  for (const [path, sha] of Object.entries({ ...config.artifactPins, ...config.sourcePins })) assert.equal(semanticHash(await pinnedRead(root, path)), sha, `Frozen input or source changed: ${path}`);
  if (config.batchVersion === 2 || config.batchVersion === 3 || config.batchVersion === 4) {
    const systemComparison = config.batchVersion === 4, thinking = config.batchVersion === 3 || systemComparison;
    const baseline = await readSemanticModelComparison(root, config.comparison!, thinking ? SEMANTIC_PRO_MODEL : SEMANTIC_MODEL,
      systemComparison ? SEMANTIC_THINKING_PARAMETERS : SEMANTIC_PARAMETERS);
    for (const [path, sha] of Object.entries(baseline.pins)) assert.equal(config.artifactPins[path], sha, 'Comparison baseline must be frozen');
    const requests = JSON.parse((await pinnedRead(root, `${profile.directory}/requests.json`)).toString());
    assert.ok(Array.isArray(requests)); assert.equal(requests.length, 1); assert.equal(requests[0].id, 'raw-only');
    (systemComparison ? assertSemanticSystemOnlyRequest : thinking ? assertSemanticThinkingOnlyRequest : assertSemanticModelOnlyRequest)(baseline.original.body, requests[0].body);
    assert.deepEqual(requests[0].input, baseline.original.input);
    assert.equal(requests[0].requestSha256, semanticHash(JSON.stringify(requests[0].body)));
    assert.equal(config.promptSha256, semanticHash(requests[0].body.messages[0].content));
  }
  if (phaseId === SEMANTIC_RECHECK_PHASE || isSemanticBatch(phaseId)) {
    const prior = JSON.parse((await pinnedRead(root, `${profile.directory}/prior-budget.json`)).toString());
    assert.equal(prior.entries.length, config.priorBudget.count);
    assert.equal(semanticHash(JSON.stringify(prior.entries)), config.priorBudget.entriesSha256, 'Prior budget snapshot differs from configuration');
  }
  return { config, configSha256 };
}
function validatedBudget(state: BudgetState, config: Pick<SemanticPhaseConfig, 'phaseId' | 'model' | 'reservationMicros' | 'sharedLimitMicros' | 'priorBudget' | 'cases'>): BudgetState {
  const order = config.cases.map(item => item.id), prefix = `${config.phaseId}:`;
  assert.equal(state.batchId, 'D09-S1-20260906-01'); assert.equal(state.currency, 'CNY'); assert.equal(state.limitMicros, config.sharedLimitMicros);
  assert.equal(state.blocked, false, 'Shared budget is blocked'); assert.ok(Array.isArray(state.entries));
  assert.ok(state.entries.length >= config.priorBudget.count);
  assert.equal(semanticHash(JSON.stringify(state.entries.slice(0, config.priorBudget.count))), config.priorBudget.entriesSha256, 'Previous shared ledger entries changed');
  const ids = new Set<string>();
  for (const entry of state.entries) {
    assert.ok(entry.operationId && !ids.has(entry.operationId)); ids.add(entry.operationId);
    assert.equal(entry.status, 'settled', 'Unknown or unfinished cost stops the phase');
    assert.ok(Number.isSafeInteger(entry.actualMicros) && entry.actualMicros !== null && entry.actualMicros >= 0);
    assert.ok(Number.isSafeInteger(entry.reservedMicros) && entry.reservedMicros > 0);
  }
  let lastCase = -1; const counts = new Map<number, number>();
  for (const entry of state.entries.slice(config.priorBudget.count)) {
    assert.ok(entry.operationId.startsWith(prefix), 'Unexpected concurrent evaluation');
    assert.equal(entry.model, config.model); assert.equal(entry.reservedMicros, config.reservationMicros);
    const caseIndex = order.findIndex(id => entry.operationId.startsWith(`${prefix}${id}:`));
    assert.ok(caseIndex >= 0 && caseIndex >= lastCase && caseIndex <= lastCase + 1, 'Ledger phase cases are out of order');
    const count = (counts.get(caseIndex) ?? 0) + 1; counts.set(caseIndex, count);
    assert.ok(count <= config.cases[caseIndex]!.maxAttempts, 'Ledger case limit exceeded'); lastCase = caseIndex;
  }
  return state;
}
export function semanticPeakEstimate(usage: unknown, model: SemanticModel = SEMANTIC_MODEL, thinking = false): number | null {
  const profile = semanticModelProfile(model);
  if (!usage || typeof usage !== 'object') return null;
  const value = usage as Record<string, unknown>;
  const valid = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  if (!valid(value.prompt_tokens) || !valid(value.completion_tokens)) return null;
  if (value.total_tokens !== undefined && (!valid(value.total_tokens) || value.total_tokens !== value.prompt_tokens + value.completion_tokens)) return null;
  // Reasoning is a component of completion_tokens, not an additional charge or a deduction.
  if (thinking && value.completion_tokens_details !== undefined) {
    const details = value.completion_tokens_details;
    if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
    const reasoning = (details as Record<string, unknown>).reasoning_tokens;
    if (reasoning !== undefined && (!valid(reasoning) || reasoning > value.completion_tokens)) return null;
  }
  const estimate = value.prompt_tokens * profile.inputRate + value.completion_tokens * profile.outputRate;
  return Number.isSafeInteger(estimate) ? estimate : null;
}
export async function reviewedSemanticCount(root: string, configSha256: string, phaseId: SemanticPhaseId = SEMANTIC_PHASE): Promise<number> {
  const profile = semanticPhaseProfile(phaseId);
  const batchConfig = isSemanticBatch(phaseId) ? (await loadSemanticPhase(root, true, phaseId)).config : undefined;
  const order = batchConfig ? batchConfig.cases.map(item => item.id) : profile.order;
  let reviews: { caseId: string; runId: string; reviewedBy: string; passed: boolean; fingerprints: Record<string, string> }[];
  try { reviews = JSON.parse((await pinnedRead(root, `${profile.directory}/reviews.json`)).toString()); }
  catch (error) { if (isMissing(error)) return 0; throw error; }
  assert.ok(Array.isArray(reviews) && reviews.length <= order.length);
  for (const [i, review] of reviews.entries()) {
    assert.equal(review.caseId, order[i]); assert.equal(review.reviewedBy, 'W0-I'); assert.equal(review.passed, true);
    assert.match(review.runId, /^semantic-[a-z0-9-]+$/);
    assert.deepEqual(keys(review.fingerprints), ['attempts.json', 'manifest.json', 'result.json', 'state.sqlite']);
    const directory = `${profile.directory}/runs/${review.runId}`;
    for (const [name, sha] of Object.entries(review.fingerprints)) assert.equal(semanticHash(await pinnedRead(root, `${directory}/${name}`)), sha, 'Reviewed evidence changed');
    const manifest = JSON.parse((await pinnedRead(root, `${directory}/manifest.json`)).toString());
    const result = JSON.parse((await pinnedRead(root, `${directory}/result.json`)).toString());
    const claim = JSON.parse((await pinnedRead(root, `${profile.directory}/claims/${review.caseId}.json`)).toString());
    if (phaseId !== SEMANTIC_PHASE) { assert.equal(manifest.phaseId, phaseId); assert.equal(claim.phaseId, phaseId); }
    assert.equal(manifest.configSha256, configSha256); assert.equal(manifest.caseId, review.caseId); assert.equal(manifest.passed, true);
    assert.equal(manifest.origin, 'real_provider'); assert.equal(manifest.model, batchConfig?.model ?? SEMANTIC_MODEL);
    assert.ok(manifest.attempts >= 1 && manifest.attempts <= (review.caseId === 'closure' ? 2 : 1));
    assert.equal(result.passed, true); assert.equal(result.id, review.caseId); assert.equal(claim.runId, review.runId); assert.equal(claim.configSha256, configSha256);
  }
  return reviews.length;
}
export interface SemanticExpansionProof { firstAttempt: 1; status: 'needs_sources'; zeroTableWrites: true; requiredSources: number; expandedInputSha256: string }

/** Holds the existing shared backend lock for one reviewed case, never a whole unreviewed batch. */
export async function beginSemanticCase(root: string, runId: string, signal: AbortSignal, phaseId: SemanticPhaseId = SEMANTIC_PHASE) {
  signal.throwIfAborted(); assert.match(runId, /^semantic-[a-z0-9-]+$/);
  const profile = semanticPhaseProfile(phaseId), prefix = `${phaseId}:`;
  const loaded = await loadSemanticPhase(root, true, phaseId), { config, configSha256 } = loaded;
  const index = await reviewedSemanticCount(root, configSha256, phaseId), selected = config.cases[index], caseId = selected?.id;
  assert.ok(caseId, 'All semantic cases have already been reviewed');
  const phasePath = `${root}/${profile.directory}`, runPath = `${phasePath}/runs/${runId}`;
  await absent(`${phasePath}/claims/${caseId}.json`); await absent(runPath);
  // Read-only checks and both budget limits precede lock/claim and any caller credential callback.
  const budgetState = async () => validatedBudget(JSON.parse((await pinnedRead(root, ledgerPath)).toString()), config);
  const checkFunds = (state: BudgetState) => {
    const entries = state.entries.slice(config.priorBudget.count);
    assert.ok(entries.length < config.maxAttempts, 'Phase generation limit reached');
    assert.ok(entries.reduce((s, e) => s + e.actualMicros!, 0) + config.reservationMicros <= config.phaseLimitMicros, 'Phase budget cannot reserve next call');
    assert.ok(state.entries.reduce((s, e) => s + (e.actualMicros ?? e.reservedMicros), 0) + config.reservationMicros <= config.sharedLimitMicros, 'Shared budget cannot reserve next call');
    assert.ok(entries.filter(e => e.operationId.startsWith(`${prefix}${caseId}:`)).length < selected!.maxAttempts, 'Case attempt limit reached');
  };
  checkFunds(await budgetState());
  const lockPath = `${root}/.local/model-evaluation/backend.lock`, lock = await open(lockPath, 'wx');
  let released = false, claimed = false, attempts = 0, settled = 0;
  const release = async () => { if (!released) { released = true; await lock.close(); await unlink(lockPath); } };
  try {
    await lock.writeFile(JSON.stringify({ phase: phaseId, runId, pid: process.pid }) + '\n');
    // A competing batch may have settled between the first read and acquiring this lock.
    const rechecked = await loadSemanticPhase(root, true, phaseId); assert.equal(rechecked.configSha256, configSha256);
    checkFunds(await budgetState()); signal.throwIfAborted();
    await mkdir(`${phasePath}/claims`, { recursive: true }); await mkdir(`${phasePath}/runs`, { recursive: true });
    await writeFile(`${phasePath}/claims/${caseId}.json`, JSON.stringify({ phaseId, runId, caseId, configSha256 }) + '\n', { flag: 'wx' });
    claimed = true;
    await mkdir(runPath);
  } catch (error) {
    try { if (claimed) await writeFile(`${phasePath}/STOPPED.json`, JSON.stringify({ phaseId, caseId, runId, reason: 'Claimed case setup failed before any call' }) + '\n', { flag: 'wx' }); }
    finally { await release(); }
    throw error;
  }
  const stop = async (reason: string) => {
    try { await writeFile(`${phasePath}/STOPPED.json`, JSON.stringify({ phaseId, caseId, runId, reason, attempts, at: new Date().toISOString() }) + '\n', { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  };
  const budget = new EvaluationBudget(`${root}/${ledgerPath}`, 'D09-S1-20260906-01', config.sharedLimitMicros);
  return {
    phaseId, directory: profile.directory, caseId, runPath, config, configSha256, get attempts() { return attempts; },
    async prepareAttempt(input: MemoryTurnInput, promptSha256: string, inputUpperBound: number, credential: () => string, proof?: SemanticExpansionProof): Promise<EndpointConfig> {
      input = structuredClone(input);
      assert.equal(released, false); signal.throwIfAborted();
      const refreshed = await loadSemanticPhase(root, true, phaseId); assert.equal(refreshed.configSha256, configSha256, 'Configuration changed mid-case');
      assert.equal(await reviewedSemanticCount(root, configSha256, phaseId), index, 'Review order changed mid-case');
      assert.equal(promptSha256, config.promptSha256); assert.ok(Number.isSafeInteger(inputUpperBound) && inputUpperBound > 2048 && inputUpperBound <= SEMANTIC_INPUT_LIMIT);
      assert.equal(attempts, settled, 'Previous attempt has not settled'); assert.ok(attempts < (caseId === 'closure' ? 2 : 1));
      if (attempts === 1) {
        assert.equal(caseId, 'closure'); assert.ok(proof); assert.equal(proof.firstAttempt, 1); assert.equal(proof.status, 'needs_sources');
        assert.equal(proof.zeroTableWrites, true); assert.ok(Number.isSafeInteger(proof.requiredSources) && proof.requiredSources > 0);
        assert.equal(proof.expandedInputSha256, config.inputHashes['closure:expanded']);
      } else assert.equal(proof, undefined);
      assert.equal(semanticInputHash(input), config.inputHashes[attempts === 0 ? caseId : 'closure:expanded'], 'Actual input differs from pinned original');
      checkFunds(await budgetState());
      const ordinal = ++attempts, operationId = `${prefix}${caseId}:${runId}:${ordinal}`;
      await writeFile(`${phasePath}/claims/${caseId}-${ordinal}.json`, JSON.stringify({ operationId, inputSha256: semanticInputHash(input), promptSha256, inputUpperBound, proof: proof ?? null }) + '\n', { flag: 'wx' });
      let authorized = false, keyRead = false, didSettle = false;
      return { endpoint: SEMANTIC_ENDPOINT, model: config.model,
        apiKey: () => { signal.throwIfAborted(); assert.equal(released, false); assert.equal(keyRead, false, 'No duplicate credential/request access'); keyRead = true; return credential(); },
        authorizer: { authorize: async (request, requestSignal) => {
          requestSignal.throwIfAborted(); signal.throwIfAborted(); assert.equal(released, false); assert.equal(authorized, false, 'Attempt cannot be reused'); authorized = true;
          assert.equal(request.operation, 'memory_turn'); assert.equal(request.model, config.model); assert.equal(request.endpoint, SEMANTIC_ENDPOINT); assert.deepEqual(request.scope, input.scope);
          await budget.reserve(operationId, request.model, config.reservationMicros, { operationIdPrefix: prefix, limitMicros: config.phaseLimitMicros, maxCalls: config.maxAttempts });
          return { settle: async (outcome: CallOutcome) => {
            assert.equal(didSettle, false); didSettle = true;
            const estimate = semanticPeakEstimate(outcome.usage, config.model, config.batchVersion === 3 || config.batchVersion === 4);
            await budget.settle(operationId, estimate); settled++;
            await appendFile(`${runPath}/settlements.jsonl`, JSON.stringify({ operationId, scope: request.scope, ...outcome, estimatedMicros: estimate, billVerified: false, unknownReservationRetained: estimate === null }) + '\n', { mode: 0o600 });
            const usage = outcome.usage as { prompt_tokens?: number; completion_tokens?: number } | null;
            if (outcome.status !== 'success' || estimate === null || estimate > config.reservationMicros ||
                (usage?.prompt_tokens ?? Infinity) > SEMANTIC_INPUT_LIMIT || (usage?.completion_tokens ?? Infinity) > semanticModelProfile(config.model).maximumOutputTokens) {
              await stop('Transport, cancellation or unknown/excessive usage failure'); throw new Error('Semantic transport or cost failed; phase stopped');
            }
          } };
        } },
      };
    },
    async finish(passed: boolean): Promise<void> {
      try { if (!passed || attempts === 0 || settled !== attempts) await stop('Case failed or did not finish all claimed attempts; no retry'); }
      finally { await release(); }
    },
  };
}
