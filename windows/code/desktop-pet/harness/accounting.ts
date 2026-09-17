import { EvaluationBudget } from '../core/evaluation-budget.js';
import type { RelayMetrics } from './connection.js';

/** Uses the existing approved DeepSeek Flash peak tariff; cache uses the uncached ceiling. */
export function harnessAccounting(budget: EvaluationBudget): (metrics: RelayMetrics) => Promise<void> {
  let tail = Promise.resolve();
  return metrics => {
    const next = tail.then(async () => {
      if (!metrics.usage || !metrics.model || metrics.model.provider !== 'deepseek-official' || metrics.model.model !== 'deepseek-flash') throw Error('Harness usage cannot yet be priced');
      const u = metrics.usage, upper = (u.uncachedInputTokens + u.cacheReadTokens + u.cacheWriteTokens) * 2 + u.outputTokens * 8;
      await budget.recordExternalEstimate('harness-relay:' + metrics.sessionId + ':', 'deepseek-flash', upper);
    });
    tail = next.catch(() => {}); return next;
  };
}
