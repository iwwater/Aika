import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import type { MemoryTurnInput } from '../contracts/memory-lifecycle.js';
import { buildMemoryTurnFormat } from '../providers/memory-turn-format.js';
import { loadMemoryTrial, type MemoryTrialBundle } from './memory-trial.js';
import { DEEPSEEK_ENDPOINT, DEEPSEEK_MODEL, DEEPSEEK_PHASE, DEEPSEEK_RESERVATION } from './deepseek-comparison-budget.js';

export const comparisonHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const COMPARISON_PROMPT_SHA = '69a69d32fb7183337f8597a89477275ec5320699d71ada53d168db29ee9e389f';
export const comparisonOrder = ['raw-only', 'closure', 'merge'] as const;
export function normalizedComparisonInput(input: MemoryTurnInput): MemoryTurnInput {
  const sort = <T extends { id: string }>(values: readonly T[]) => [...values].sort((a, b) => a.id.localeCompare(b.id));
  return { ...input, sources: sort(input.sources), messages: sort(input.messages), relevantMemories: sort(input.relevantMemories) };
}
export async function assertComparisonOpen(root: string): Promise<void> {
  const directory = `${root}/.local/deepseek-comparison`;
  for (const name of ['STOPPED.json', 'COMPLETED.json']) {
    try { await access(`${directory}/${name}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new Error('DeepSeek comparison has ended; no further calls allowed');
  }
}
export async function loadDeepSeekComparison(root: string): Promise<{ bundle: MemoryTrialBundle; expanded: MemoryTurnInput; configSha256: string }> {
  await assertComparisonOpen(root);
  const directory = `${root}/.local/deepseek-comparison`;
  const manifest = JSON.parse(await readFile(`${directory}/inputs-manifest.json`, 'utf8'));
  const board = JSON.parse(await readFile(`${root}/docs/agent/blackboard/CURRENT.json`, 'utf8'));
  assert.equal(board.publication_pending, false);
  const configBytes = await readFile(`${directory}/config.json`), config = JSON.parse(configBytes.toString());
  assert.equal(comparisonHash(configBytes), manifest.configSha256);
  assert.equal(comparisonHash(configBytes), board.deepseek_comparison.config_sha256);
  assert.equal(config.phase_id, DEEPSEEK_PHASE); assert.equal(config.model, DEEPSEEK_MODEL); assert.equal(config.endpoint, DEEPSEEK_ENDPOINT);
  assert.equal(config.max_calls, 4); assert.equal(config.phase_limit_micros, 5_000_000); assert.equal(config.shared_limit_micros, 10_000_000);
  assert.equal(config.pricing.reservation_micros, DEEPSEEK_RESERVATION);
  assert.equal(config.prompt_sha256, COMPARISON_PROMPT_SHA); assert.equal(config.max_tokens_added, false);
  assert.deepEqual(config.request_parameters, { stream: false, thinking: { type: 'disabled' }, response_format: { type: 'json_object' } });
  assert.deepEqual(config.cases, comparisonOrder.map(id => ({ id, max_calls: id === 'closure' ? 2 : 1 })));
  assert.equal(comparisonHash(await readFile(`${directory}/prior-budget.json`)), manifest.priorBudgetSha256);
  const oldStopHash = comparisonHash(await readFile(`${root}/.local/prompt-trial-inputs/STOPPED.json`));
  assert.equal(oldStopHash, manifest.oldStopSha256); assert.equal(oldStopHash, config.old_stopped_record_sha256);
  const known = await loadMemoryTrial(root, 'known');
  assert.equal(comparisonHash(await readFile(`${root}/.local/prompt-trial-inputs/known.json`)), config.known_bundle_sha256);
  const bytes = await readFile(`${directory}/inputs.json`); assert.equal(comparisonHash(bytes), manifest.inputsSha256);
  const bundle = JSON.parse(bytes.toString()) as MemoryTrialBundle;
  assert.deepEqual(bundle, { ...known, cases: comparisonOrder.map(id => known.cases.find(item => item.id === id)) });
  for (const fixture of bundle.cases) assert.equal(comparisonHash(buildMemoryTurnFormat(fixture.input, 'quoted-v2').system), COMPARISON_PROMPT_SHA);
  const expandedBytes = await readFile(`${root}/.local/source-budget-v2/complete-input.json`);
  assert.equal(comparisonHash(expandedBytes), manifest.expandedInputSha256);
  return { bundle, expanded: JSON.parse(expandedBytes.toString()) as MemoryTurnInput, configSha256: manifest.configSha256 };
}

/** Reviews are written by W0-I after inspecting each actual result. Assertions alone cannot advance. */
export async function reviewedComparisonCount(root: string, bundle: MemoryTrialBundle, configSha256: string): Promise<number> {
  const directory = `${root}/.local/deepseek-comparison`;
  let approvals: { caseId: string; runId: string; passed: boolean; reviewedBy: string; fingerprints: Record<string, string> }[];
  try { approvals = JSON.parse(await readFile(`${directory}/approvals.json`, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  assert.ok(Array.isArray(approvals) && approvals.length <= 3);
  const names = ['manifest.json', 'scenarios.json', 'review.json', 'model-responses.json', 'plan-traces.json'].sort();
  for (const [index, approval] of approvals.entries()) {
    const fixture = bundle.cases[index]!;
    assert.equal(approval.caseId, fixture.id); assert.equal(approval.passed, true); assert.equal(approval.reviewedBy, 'W0-I');
    assert.match(approval.runId, /^lifecycle-deepseek-[a-z0-9-]+$/);
    assert.deepEqual(Object.keys(approval.fingerprints).sort(), names);
    const path = `${root}/.local/${approval.runId}`;
    for (const name of names) assert.equal(comparisonHash(await readFile(`${path}/${name}`)), approval.fingerprints[name], 'Reviewed comparison evidence changed');
    const manifest = JSON.parse(await readFile(`${path}/manifest.json`, 'utf8'));
    const result = JSON.parse(await readFile(`${path}/scenarios.json`, 'utf8'));
    const review = JSON.parse(await readFile(`${path}/review.json`, 'utf8'));
    const claim = JSON.parse(await readFile(`${directory}/${fixture.id}-call-owner.json`, 'utf8'));
    assert.equal(manifest.configSha256, configSha256); assert.equal(manifest.model, DEEPSEEK_MODEL);
    assert.equal(manifest.promptSha256, COMPARISON_PROMPT_SHA); assert.equal(manifest.selectedCaseId, fixture.id);
    assert.ok(manifest.generationCalls >= 1 && manifest.generationCalls <= fixture.maxPlans);
    assert.deepEqual(result.checks, [{ id: fixture.id, passed: true }]); assert.equal(result.selectedCaseId, fixture.id);
    assert.equal(review.passed, true); assert.equal(review.reviewedBy, 'W0-I'); assert.equal(review.selectedCaseId, fixture.id);
    assert.equal(claim.runId, approval.runId); assert.equal(claim.configSha256, configSha256);
  }
  return approvals.length;
}
