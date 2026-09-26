import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { EvaluationBudget } from '../core/evaluation-budget.js';
import type { CallAuthorizer, CallOutcome, CallRequest } from '../providers/transport.js';

export const EVALUATION_MODELS = {
  dialogue: 'qwen-plus-2025-12-01',
  memory_maintenance: 'qwen-plus-2025-12-01',
  memory_turn: 'qwen-plus-2025-12-01',
  summary: 'qwen-plus-2025-12-01',
  perception: 'qwen3.5-omni-flash-2026-03-15',
  tts: 'qwen3-tts-instruct-flash-2026-01-26',
} as const;
export const CHAT_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
export const TTS_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const counter = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** Published 2026-09-06 Beijing rates; estimates do not claim actual bill verification. */
export function estimateMicros(request: CallRequest, outcome: CallOutcome): number | null {
  if (!outcome.usage || typeof outcome.usage !== 'object') return null;
  const usage = outcome.usage as Record<string, unknown>;
  if (request.operation === 'tts') { const chars = counter(usage.characters); return chars === null ? null : Math.ceil(chars * 80); }
  const input = counter(usage.prompt_tokens ?? usage.input_tokens), output = counter(usage.completion_tokens ?? usage.output_tokens);
  if (input === null || output === null) return null;
  // Omni: conservatively price all input tokens at the higher audio rate until
  // modality-specific accounting is verified. Text-only output is requested.
  if (request.operation === 'perception') return Math.ceil(input * 18 + output * 13.3);
  // Qwen Plus non-thinking tier is based on this request's total input length.
  if (input <= 131_072) return Math.ceil(input * .8 + output * 2);
  if (input <= 262_144) return Math.ceil(input * 2.4 + output * 20);
  return Math.ceil(input * 4.8 + output * 48);
}
/** Sole integrated evaluation owner; this is a bounded project batch, not a perpetual app allowance. */
export class IntegratedEvaluationAuthorizer implements CallAuthorizer {
  private serialization: Promise<unknown> = Promise.resolve();
  private readonly budget: EvaluationBudget;
  constructor(private readonly evidenceRoot: string) {
    this.budget = new EvaluationBudget(`${evidenceRoot}/budget.json`, 'D09-S1-20260906-01', 10_000_000);
  }
  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const current = this.serialization.then(job); this.serialization = current.catch(() => {}); return current;
  }
  async authorize(request: CallRequest, signal: AbortSignal): Promise<{ settle(outcome: CallOutcome): Promise<void> }> {
    if (request.operation === 'admission' || request.operation === 'asr') throw new Error('Admission requires a separately registered trial configuration');
    if (request.model !== EVALUATION_MODELS[request.operation] || request.endpoint !== (request.operation === 'tts' ? TTS_ENDPOINT : CHAT_ENDPOINT)) throw new Error('Operation is outside the approved Beijing evaluation configuration');
    signal.throwIfAborted();
    const operationId = `W0-I:${request.scope.turnId}:${request.operation}:${randomUUID()}`;
    await this.serialize(() => this.budget.reserve(operationId, request.model, 1_000_000));
    const startedAt = new Date().toISOString();
    return { settle: async outcome => {
      const estimate = estimateMicros(request, outcome);
      await this.serialize(async () => {
        await this.budget.settle(operationId, estimate);
        await appendFile(`${this.evidenceRoot}/integrated-calls.jsonl`, JSON.stringify({ operationId, scope: request.scope, operation: request.operation, model: request.model, startedAt, completedAt: new Date().toISOString(), status: outcome.status, requestId: outcome.requestId, estimatedCostCNY: estimate === null ? null : estimate / 1_000_000, estimateBasis: request.operation === 'perception' ? 'upper_bound_all_input_at_audio_rate' : 'published_rate_times_reported_usage', billVerified: false, unknownCostReservationRetained: estimate === null }) + '\n', { mode: 0o600 });
      });
    } };
  }
}
