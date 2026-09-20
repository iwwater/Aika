import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { EvaluationBudget } from '../core/evaluation-budget.js';
import type { BudgetEntry } from '../core/evaluation-budget.js';
import type { CallAuthorizer, CallOutcome, CallRequest } from '../providers/transport.js';
import { readActiveTrialConfiguration, type TrialConfiguration, type TrialModel, type TrialOperation } from './trial-config.js';

const count = (n: unknown): number | null => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
const cost = (value: number): number | null => Number.isSafeInteger(Math.ceil(value)) && value >= 0 ? Math.ceil(value) : null;
export function estimateTrialMicros(model: TrialModel, operation: TrialOperation, outcome: CallOutcome): number | null {
  if (!outcome.usage || typeof outcome.usage !== 'object') return null;
  const usage = outcome.usage as Record<string, unknown>;
  if (operation === 'asr') {
    const seconds = usage.seconds;
    return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && model.audioMicrosPerSecond !== undefined ? cost(Math.ceil(seconds) * model.audioMicrosPerSecond) : null;
  }
  if (operation === 'tts') {
    const chars = count(usage.characters);
    return chars === null || model.characterMicros === undefined ? null : cost(chars * model.characterMicros);
  }
  const input = count(usage.prompt_tokens ?? usage.input_tokens), output = count(usage.completion_tokens ?? usage.output_tokens);
  if (input === null || output === null) return null;
  // DeepSeek completion_tokens already includes reasoning. Never add reasoning tokens a second time.
  return cost(input * model.inputMicrosPerToken + output * model.outputMicrosPerToken);
}

/** Each unknown requires its own pinned integration audit; unreviewed costs still stop. */
export async function assertReviewedUnknownCosts(entries: readonly BudgetEntry[], configuration: TrialConfiguration): Promise<void> {
  for (const entry of entries) {
    if (entry.status !== 'unknown') continue;
    const review = configuration.reviewedUnknownCosts?.find(review => review.operationId === entry.operationId);
    if (!review || review.model !== entry.model || review.reservedMicros !== entry.reservedMicros || entry.actualMicros !== null)
      throw new Error('Trial is stopped pending unknown-cost reconciliation');
    const bytes = await readFile(review.auditFile);
    if (createHash('sha256').update(bytes).digest('hex') !== review.auditSha256) throw new Error('Unknown-cost review changed');
    const audit = JSON.parse(bytes.toString('utf8'));
    if (!['unknown_reservation_upper_bound_correction','unknown_asr_duration_upper_bound_review','unknown_trial_reservation_upper_bound_review'].includes(audit.kind) || audit.status !== 'applied' || audit.actualChargeStillUnknown !== true
      || JSON.stringify(audit.correctedEntry) !== JSON.stringify(entry)) throw new Error('Unknown-cost review does not match reservation');
    const trialMemory = entry.operationId.startsWith(`W0-I:${configuration.phaseId}:memory_turn:`);
    if (trialMemory || audit.kind === 'unknown_trial_reservation_upper_bound_review') {
      const model = configuration.models.memory_turn;
      const maximum = Math.ceil(model.inputTokenLimit * model.inputMicrosPerToken + model.outputTokenLimit * model.outputMicrosPerToken);
      const fields = ['inputTokenLimit','outputTokenLimit','inputMicrosPerToken','outputMicrosPerToken'] as const;
      if (!trialMemory || audit.kind !== 'unknown_trial_reservation_upper_bound_review' || audit.phaseId !== configuration.phaseId
        || entry.model !== model.model || entry.reservedMicros !== model.reservationMicros
        || JSON.stringify(audit.originalEntry) !== JSON.stringify(entry) || !audit.bounds
        || fields.some(field => audit.bounds[field] !== model[field]) || !Number.isSafeInteger(maximum)
        || maximum <= 0 || maximum > entry.reservedMicros || audit.maximumMicros !== maximum)
        throw new Error('Trial memory upper-bound evidence changed');
    }
    if (audit.kind === 'unknown_asr_duration_upper_bound_review') {
      if (entry.model !== 'qwen3-asr-flash-2026-02-10' || audit.httpStatus !== 200 || audit.durationSeconds !== 167.6255
        || audit.priceMicrosPerSecond !== 220 || Math.ceil(audit.durationSeconds) * audit.priceMicrosPerSecond !== entry.reservedMicros
        || createHash('sha256').update(await readFile(audit.responseFile)).digest('hex') !== audit.responseSha256
        || createHash('sha256').update(await readFile(audit.audioFile)).digest('hex') !== audit.audioSha256) throw new Error('ASR upper-bound evidence changed');
    }
  }
}

/** Reuses the existing shared ledger and cross-process reservation lock, with one bounded trial prefix. */
export class TrialAuthorizer implements CallAuthorizer {
  private readonly budget: EvaluationBudget;
  private serial: Promise<unknown> = Promise.resolve();
  private halted = false;
  constructor(private readonly configuration: TrialConfiguration, private readonly configFile: string, private readonly activationFile: string,
    private readonly guardConfiguration: TrialConfiguration = configuration) {
    this.budget = new EvaluationBudget(configuration.budgetFile, configuration.budgetBatchId, configuration.limitMicros);
  }
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work); this.serial = next.catch(() => {}); return next;
  }
  async stop(reason: string): Promise<void> {
    this.halted = true;
    const activation = JSON.parse(await readFile(this.activationFile, 'utf8'));
    if (activation.phaseId !== this.configuration.phaseId || activation.status !== 'active') return;
    const temporary = `${this.activationFile}.${randomUUID()}.next`;
    await writeFile(temporary, JSON.stringify({ ...activation, status: 'stopped', stoppedAt: new Date().toISOString(), reason }) + '\n', { mode: 0o600 });
    await rename(temporary, this.activationFile);
  }
  async authorize(request: CallRequest, signal: AbortSignal): Promise<{ settle(outcome: CallOutcome): Promise<void> }> {
    if (this.halted) throw new Error('Trial is stopped');
    signal.throwIfAborted();
    const fresh = await readActiveTrialConfiguration(this.configFile, this.activationFile);
    if (JSON.stringify(fresh) !== JSON.stringify(this.guardConfiguration)) throw new Error('Trial configuration changed; restart with a reviewed configuration');
    if (request.operation === 'memory_maintenance') throw new Error('Legacy memory maintenance is disabled in the trial');
    const operation = request.operation as TrialOperation;
    const model = this.configuration.models[operation];
    if (!model || request.model !== model.model || request.endpoint !== model.endpoint) throw new Error('Trial call differs from its registered provider configuration');
    const prefix = `W0-I:${this.configuration.phaseId}:`;
    const id = `${prefix}${request.operation}:${randomUUID()}`;
    let reservation = model.reservationMicros;
    if (operation === 'asr') {
      if (typeof request.audioSeconds !== 'number' || !Number.isFinite(request.audioSeconds) || request.audioSeconds <= 0 || model.audioMicrosPerSecond === undefined) throw new Error('ASR audio duration required for budget reservation');
      reservation = Math.ceil(request.audioSeconds) * model.audioMicrosPerSecond;
      if (!Number.isSafeInteger(reservation) || reservation <= 0) throw new Error('ASR audio bound invalid');
    }
    if (operation === 'tts') {
      const characters = count(request.textCharacters);
      if (characters === null || model.characterMicros === undefined) throw new Error('Trial TTS requires its actual character bound');
      reservation = Math.max(reservation, Math.ceil(characters * model.characterMicros));
    }
    // Ledger availability is captured here and reused by settle: unlimited mode records accounting
    // only when a valid ledger is already present, so a missing ledger never blocks the call.
    let ledgerAvailable = false;
    await this.serialized(async () => {
      signal.throwIfAborted();
      if (this.halted) throw new Error('Trial is stopped');
      if (this.configuration.budgetMode === 'unlimited') {
        // Unlimited mode has no price/budget-ledger dependency: a missing or malformed ledger is
        // tolerated, but an existing valid ledger is still used for accounting. Stop/cancel, endpoint
        // and config consistency are enforced above this block.
        try {
          const state = JSON.parse(await readFile(this.configuration.budgetFile, 'utf8'));
          if (state.batchId === this.configuration.budgetBatchId && state.limitMicros === null && Array.isArray(state.entries)) {
            ledgerAvailable = true;
            await this.budget.reserve(id, request.model, reservation, undefined, 0);
          }
        } catch { ledgerAvailable = false; }
        return;
      }
      // A missing original ledger must not silently create an empty account under an existing allowance.
      const state = JSON.parse(await readFile(this.configuration.budgetFile, 'utf8'));
      if (state.batchId !== this.configuration.budgetBatchId || state.limitMicros !== this.configuration.limitMicros || !Array.isArray(state.entries)) throw new Error('Original shared trial ledger is unavailable');
      ledgerAvailable = true;
      if (this.configuration.purpose !== 'user-trial') await assertReviewedUnknownCosts(state.entries, this.configuration);
      if (this.configuration.purpose !== 'user-trial' && state.entries.filter((entry: { operationId: string }) => entry.operationId.startsWith(`${prefix}${operation}:`)).length >= (this.configuration.operationLimits[operation] ?? 0)) throw new Error('Trial operation call limit reached');
      await this.budget.reserve(id, request.model, reservation, this.configuration.purpose === 'user-trial' ? undefined : { operationIdPrefix: prefix,
        limitMicros: this.configuration.phaseLimitMicros, maxCalls: this.configuration.maxCalls },
        this.configuration.purpose==='user-trial'&&['memory_turn','summary'].includes(operation)
          ? ['admission','dialogue','tts','perception','asr'].reduce((total,slot)=>total+(this.configuration.models[slot as TrialOperation]?.reservationMicros??0),0):0);
    });
    return { settle: outcome => this.serialized(async () => {
      const actual = estimateTrialMicros(model, operation, outcome);
      // Unlimited mode keeps no ledger when none is present; an unknown cost stays null and is never
      // fabricated as zero. Bounded mode still records and enforces its reservations.
      if (!ledgerAvailable) return;
      await this.budget.settle(id, actual);
      if (this.configuration.budgetMode!=='unlimited'&&(actual !== null && actual > reservation || (this.configuration.purpose === 'smoke-text' && (actual === null || outcome.status !== 'success'))))
        await this.stop(actual === null ? 'unknown_cost' : actual > reservation ? 'reservation_exceeded' : 'provider_failure');
    }) };
  }
}
