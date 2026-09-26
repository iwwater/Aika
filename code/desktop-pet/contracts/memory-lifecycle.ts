import type { CharacterId, ConversationMessage, DialogueContext, MemoryChange, MemoryChangeResult, MemoryMaintenanceInput, MemoryPort, PerceptionResult, Scoped, TurnScope } from './index.js';

/** Host-owned in-process lifecycle state. Counts are not a semantic permission or durable job ledger. */
export interface MemoryPendingSnapshot {
  readonly characterId: CharacterId;
  readonly revision: number;
  readonly queued: number;
  readonly running: number;
}
export interface MemoryPendingObservation {
  readonly snapshot: MemoryPendingSnapshot;
  /** Reject any same-role queue transition since capture, even if the count returned to zero. */
  assertCurrent(): void;
}

/** Readable current-role evidence. Deleted payloads never enter normal model input. */
export interface MemorySource extends Scoped {
  readonly origin?: import('./index.js').RecordOrigin;
  readonly id: string;
  readonly version: number;
  readonly kind: 'transcript' | 'memory' | 'summary';
  readonly text: string;
  readonly createdAt: string;
  readonly messageRole: ConversationMessage['role'] | null;
  /** Versioned lineage metadata, including unavailable ancestors; never permission to read their payloads. */
  readonly sourceVersions?: readonly SourceVersion[];
  /** False for display-only assistant messages; they cannot support extraction or summaries. */
  readonly evidenceEligible?: boolean;
}
export interface SourceVersion { readonly id: string; readonly version: number }
/** One contiguous, exact excerpt. Coordinates count Unicode code points without normalization. */
export interface SourceRetention {
  readonly source: SourceVersion;
  /** Plan-local f<number> alias. Storage alone allocates permanent, scope-bound fragment IDs. */
  readonly fragmentId: string;
  readonly start: number;
  readonly end: number;
  /** Existing surviving sources or declared fragments; final dependencies must form a DAG. */
  readonly supportSourceIds: readonly string[];
}
export type MemoryRequestKind = 'none' | 'correction' | 'forget';
export interface MemoryTurnInput extends MemoryMaintenanceInput {
  readonly currentMessageId: string;
  readonly sources: readonly MemorySource[];
}
/** Resolve the current utterance, including references to recent raw text without a long-term record. */
export interface MemoryTurnPlan extends Scoped {
  /** Optional additive extraction; commit atomically with the captured strict plan. */
  readonly dynamics?: import('./memory-dynamics.js').MemoryDynamicsPlan;
  readonly request: MemoryRequestKind;
  readonly changes: readonly MemoryChange[];
  readonly suppressSources: readonly SourceVersion[];
  /** Absent on 0.2 snapshots means []; 0.3 model output explicitly includes the field. */
  readonly retainSources?: readonly SourceRetention[];
  readonly clarification: string | null;
  readonly reason: string;
}
export interface MemoryTurnOutcome extends Scoped {
  readonly request: MemoryRequestKind;
  readonly status: 'unchanged' | 'applied' | 'needs_clarification' | 'rejected';
  readonly results: readonly MemoryChangeResult[];
  readonly affectedIds: readonly string[];
  readonly retrievalInvalidated: boolean;
  readonly clarification: string | null;
  /** Stable diagnostic only, without source text; supplied for every rejected 0.3 outcome. */
  readonly rejectionCode?: string | null;
}
export interface MemoryTurnProvider {
  plan(input: MemoryTurnInput, signal: AbortSignal): Promise<MemoryTurnPlan>;
}
/** Called before dialogue context/reply. Application serializes jobs for the original role. */
export interface MemoryTurnPort extends MemoryPort {
  prepareTurn(scope: TurnScope, currentMessageId: string, text: string, signal: AbortSignal): Promise<MemoryTurnOutcome>;
  /** Revalidate an issued context before exposing its reply or audio; throws if recalled sources became invalid. */
  assertContextCurrent(context: DialogueContext): void;
}
/** Lifecycle implementations reject assistant writes through ordinary MemoryPort.append. */
export interface AssistantMemoryPort {
  appendAssistant(scope: TurnScope, message: ConversationMessage, context: DialogueContext,
    currentMessageId: string, signal: AbortSignal): Promise<void>;
}
/** Additive capability. Existing lifecycle 0.3 callers retain synchronous preparation semantics. */
export const BACKGROUND_MEMORY_CONTRACT_VERSION = '0.2.0' as const;
export type ForegroundMemoryRequest = MemoryRequestKind | 'uncertain';
export interface PendingMemoryMutation {
  readonly request: Exclude<ForegroundMemoryRequest, 'none'>;
  /** Unknown targets require conservative isolation until the strict result is committed. */
  readonly sources: null;
}
export interface MemoryTurnPending extends Scoped {
  readonly request: ForegroundMemoryRequest;
  readonly status: 'pending';
}
export interface BackgroundMemoryPort extends MemoryTurnPort, AssistantMemoryPort {
  /** Short durable privacy registration, before enqueue/context; never waits for the model writer. */
  beginPendingMutation?(scope: TurnScope, currentMessageId: string, pending: PendingMemoryMutation): void | Promise<void>;
  /** Explicit user cancellation only; release this pending guard without reviving sources, invalidate in-flight tickets. */
  cancelPendingMutation?(scope: TurnScope, currentMessageId: string): void | Promise<void>;
  pendingMutations?(characterId: CharacterId): readonly { readonly scope: TurnScope; readonly currentMessageId: string; readonly intent: Exclude<ForegroundMemoryRequest, 'none'>; readonly status: 'pending' | 'failed' }[];
  /** Full strict planning/commit on a background lifetime; must never replace foreground identity. */
  prepareBackgroundTurn(scope: TurnScope, currentMessageId: string, text: string, signal: AbortSignal): Promise<MemoryTurnOutcome>;
  /** Read an issued, committed snapshot after validating this stored user message and its full scope.
   * This does not resolve a memory request and must not fabricate a completed/unchanged outcome.
   * All foreground turns use committed snapshots without waiting for strict writes; pending mutation privacy guards apply.
   */
  foregroundContext(scope: TurnScope, currentMessageId: string, text: string, perception: PerceptionResult | null,
    signal: AbortSignal): Promise<DialogueContext>;
}
export interface SummaryInput extends Scoped {
  readonly sources: readonly MemorySource[];
}
export interface SummaryProposal extends Scoped {
  readonly text: string;
  readonly sourceVersions: readonly SourceVersion[];
}
export interface SummaryResult extends Scoped {
  readonly status: 'applied' | 'unchanged' | 'rejected';
  readonly summaryId: string | null;
  readonly reason: string | null;
}
export interface SummaryProvider {
  summarize(input: SummaryInput, signal: AbortSignal): Promise<SummaryProposal>;
}
/** Thresholds and bounded model input are explicit constructor configuration, not product limits. */
export interface SummaryPort {
  summarizePending(scope: TurnScope, signal: AbortSignal): Promise<SummaryResult>;
}
