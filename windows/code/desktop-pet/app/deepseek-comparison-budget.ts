import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { EvaluationBudget, type BudgetState } from '../core/evaluation-budget.js';
import type { CallAuthorizer, CallOutcome, CallRequest } from '../providers/transport.js';

export const DEEPSEEK_PHASE = 'deepseek-comparison-20260908';
export const DEEPSEEK_MODEL = 'deepseek-v4-flash';
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_RESERVATION = 3_700_000;
export const DEEPSEEK_PHASE_LIMIT = 5_000_000;
export const DEEPSEEK_INPUT_BOUND = 32_768;
export const DEEPSEEK_OUTPUT_BOUND = 393_216;
export const DEEPSEEK_WORST_MICROS = DEEPSEEK_INPUT_BOUND * 3 + DEEPSEEK_OUTPUT_BOUND * 9;
const prefix = `${DEEPSEEK_PHASE}:`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Peak CNY rates, all input charged as cache miss. No discount assumption or output cap. */
export function deepseekPeakEstimate(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const value = usage as Record<string, unknown>;
  const valid = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
  if (!valid(value.prompt_tokens) || !valid(value.completion_tokens)) return null;
  const result = value.prompt_tokens * 3 + value.completion_tokens * 9;
  return Number.isSafeInteger(result) ? result : null;
}

/** The runner holds the existing backend.lock. Phase and total checks share one budget transaction. */
export class DeepSeekComparisonAuthorizer implements CallAuthorizer {
  private readonly budget: EvaluationBudget;
  constructor(private readonly root: string, private readonly caseId: string) {
    assert.ok(['raw-only', 'closure', 'merge'].includes(caseId));
    this.budget = new EvaluationBudget(`${root}/.local/model-evaluation/budget.json`, 'D09-S1-20260906-01', 10_000_000);
  }
  async authorize(request: CallRequest, signal: AbortSignal): Promise<{ settle(outcome: CallOutcome): Promise<void> }> {
    assert.equal(request.operation, 'memory_turn', 'Comparison permits memory plans only');
    assert.equal(request.model, DEEPSEEK_MODEL); assert.equal(request.endpoint, DEEPSEEK_ENDPOINT);
    signal.throwIfAborted();
    const base = `${this.root}/.local/deepseek-comparison`;
    const baseline = JSON.parse(await readFile(`${base}/prior-budget.json`, 'utf8')) as { count: number; entriesSha256: string; estimatedMicros: number };
    const state = JSON.parse(await readFile(`${this.root}/.local/model-evaluation/budget.json`, 'utf8')) as BudgetState;
    assert.equal(baseline.count, 113); assert.equal(baseline.estimatedMicros, 195738);
    assert.equal(hash(state.entries.slice(0, baseline.count)), baseline.entriesSha256, 'Previous shared budget records changed');
    assert.ok(state.entries.slice(baseline.count).every(entry => entry.operationId.startsWith(prefix)), 'Unexpected concurrent evaluation activity');
    assert.ok(state.entries.every(entry => entry.status === 'settled'), 'Unsettled or unknown call requires reconciliation');
    const caseEntries = state.entries.filter(entry => entry.operationId.startsWith(`${prefix}${this.caseId}:`));
    assert.ok(caseEntries.length < (this.caseId === 'closure' ? 2 : 1), 'Per-case call limit reached');
    assert.ok(DEEPSEEK_WORST_MICROS <= DEEPSEEK_RESERVATION);
    const operationId = `${prefix}${this.caseId}:${randomUUID()}`;
    await this.budget.reserve(operationId, request.model, DEEPSEEK_RESERVATION, { operationIdPrefix: prefix, limitMicros: DEEPSEEK_PHASE_LIMIT, maxCalls: 4 });
    const startedAt = new Date().toISOString();
    return { settle: async outcome => {
      const estimate = deepseekPeakEstimate(outcome.usage);
      await this.budget.settle(operationId, estimate);
      await appendFile(`${this.root}/.local/model-evaluation/integrated-calls.jsonl`, JSON.stringify({ operationId, phase: DEEPSEEK_PHASE, scope: request.scope, operation: request.operation, model: request.model, startedAt, completedAt: new Date().toISOString(), status: outcome.status, requestId: outcome.requestId, estimatedCostCNY: estimate === null ? null : estimate / 1_000_000, estimateBasis: 'DeepSeek official CNY peak input3/output9 per million, all input cache miss', billVerified: false, unknownCostReservationRetained: estimate === null }) + '\n', { mode: 0o600 });
      // Preserve a transport failure's HTTP status; the failed attempt still retains its reservation.
      if ((estimate === null && outcome.status === 'success') || (estimate !== null && estimate > DEEPSEEK_RESERVATION)) throw new Error('DeepSeek cost is unknown or exceeds the reservation; phase stopped');
    } };
  }
}
