// N075-01/R4: Distillation Scheduling Policy (codifying R-TODO-18).
//
// Hard timing invariants:
// 1. Raw User Transcript: ALWAYS immediate durable write before foreground reply.
// 2. Privacy mutations (correction / forget / uncertain): ALWAYS immediate pending privacy guard.
//    Never delayed, never batched, never suppressed by queue throttling.
// 3. Ordinary additive memory (request === 'none'): Background planning and commit.
//    Foreground reply NEVER blocks on it. In N075-01, dispatched per-turn to the background
//    lifecycle queue; policy interface permits future batch/idle throttling without altering
//    lifecycle contracts.
// 4. Summary: Background, threshold-based (minMessages <= count <= maxMessages).
// 5. Assistant Transcript: Written immediately upon response generation against issued context.

import type { ForegroundMemoryRequest } from '../contracts/memory-lifecycle.js';

export type DistillationUrgency =
  | 'immediate_transcript'
  | 'immediate_privacy'
  | 'background_distillation'
  | 'threshold_summary';

export interface DistillationScheduleDecision {
  readonly urgency: DistillationUrgency;
  readonly immediateActionRequired: boolean;
  readonly shouldQueueBackgroundWork: boolean;
  readonly reason: string;
}

export interface DistillationPolicyOptions {
  /** Mode: per-turn (default in N075-01 for immediate validation) or batched. */
  readonly mode?: 'per_turn' | 'batched' | 'idle';
  /** For batched mode: number of turns before background distillation is scheduled. */
  readonly batchThreshold?: number;
}

export class DistillationScheduler {
  private turnCounter = 0;

  constructor(private readonly options: DistillationPolicyOptions = {}) {}

  /**
   * Evaluates the scheduling decision for an incoming foreground memory request.
   * Invariant: privacy-sensitive requests ('correction', 'forget', 'uncertain') ALWAYS
   * trigger immediate privacy action and can NEVER be deferred by batching.
   */
  evaluateForegroundRequest(request: ForegroundMemoryRequest): DistillationScheduleDecision {
    if (request === 'correction' || request === 'forget' || request === 'uncertain') {
      return Object.freeze({
        urgency: 'immediate_privacy',
        immediateActionRequired: true,
        shouldQueueBackgroundWork: true,
        reason: 'privacy_guard_must_apply_immediately_before_foreground_context',
      });
    }

    this.turnCounter++;
    const isBatched = this.options.mode === 'batched';
    const threshold = this.options.batchThreshold ?? 5;
    const shouldQueue = !isBatched || this.turnCounter % threshold === 0;

    return Object.freeze({
      urgency: 'background_distillation',
      immediateActionRequired: false,
      shouldQueueBackgroundWork: shouldQueue,
      reason: shouldQueue
        ? 'ordinary_additive_memory_queued_for_background_lifecycle'
        : 'batched_mode_accumulating_turns_before_distillation',
    });
  }

  /**
   * Invariant: Raw transcript must always be durably written immediately.
   */
  evaluateTranscript(): DistillationScheduleDecision {
    return Object.freeze({
      urgency: 'immediate_transcript',
      immediateActionRequired: true,
      shouldQueueBackgroundWork: false,
      reason: 'raw_transcript_requires_immediate_durable_commit',
    });
  }

  /**
   * Invariant: Summaries are triggered in the background only when message threshold is reached.
   */
  evaluateSummary(unsummarizedCount: number, minMessages: number): DistillationScheduleDecision {
    const ready = unsummarizedCount >= minMessages;
    return Object.freeze({
      urgency: 'threshold_summary',
      immediateActionRequired: false,
      shouldQueueBackgroundWork: ready,
      reason: ready
        ? 'unsummarized_transcript_count_reached_threshold'
        : 'insufficient_messages_for_summary_threshold',
    });
  }

  resetCounter(): void {
    this.turnCounter = 0;
  }
}
