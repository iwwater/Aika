import type { TurnScope } from './index.js';
import type { ForwardRequest, ForwardTargets, WorkExecutor } from './harness.js';
import type { ProjectEntry, CodexTaskTarget } from './projects.js';

/** Work v0.5.0: independent input display and brief verified-state speech; no engineering bodies/logs in companion memory or dialogue TTS. */
export const DESKTOP_WORK_VERSION = '0.5.0' as const;
export type WorkStage = 'idle' | 'classifying' | 'clarifying' | 'selecting' | 'confirming' | 'sending' | 'working' | 'completed' | 'failed' | 'unknown';
export interface WorkDraft {
  id: string; version: number; text: string; question?: string;
  projects: readonly Pick<ProjectEntry, 'id' | 'version' | 'name' | 'abstract' | 'detailRef'>[];
  targets: ForwardTargets['items'];
  /** Available for both open clarification and prepared confirmation. Choices are editing only. */
  executor?: WorkExecutor;
}
/** Snapshot of the last presented selected card, still current when this turn starts. Collapse alone does not revoke it. Host revalidates identities/versions. */
export interface WorkInputBinding {
  draftId: string; draftVersion: number;
  requestId?: string; requestVersion?: number;
}
export interface WorkConversationMessage {
  role: 'user' | 'assistant'; text: string; scope: TurnScope;
}
/** Minimal task-space context only. Model output never owns IDs or an executable action. */
export interface PendingWorkContext {
  stage: 'clarifying' | 'confirming';
  originalRequest: string; currentRequest: string; question?: string;
  conversation: readonly Pick<WorkConversationMessage, 'role' | 'text'>[];
  arrangement?: { executor: WorkExecutor; title: string; projectName?: string; targetName?: string };
}
export type WorkContinuationIntent =
  | { kind: 'confirm' | 'cancel' | 'companion' | 'new_work' }
  | { kind: 'supplement'; text: string; executionAuthorized: boolean }
  | { kind: 'clarify'; question: string };
export interface WorkSourceInput {
  /** Exact originating draft and scope, never inferred from the latest unrelated draft. */
  draftId: string; scope: TurnScope; text: string;
  provenance: 'original_input' | 'legacy_saved_input';
  /** Independent task dialogue for exact recovery; never companion conversation storage. */
  conversation?: readonly WorkConversationMessage[];
}
/** Brief trusted state sentence only; start authorizes its independent playback scope. */
export interface WorkSpeechEvent {
  noticeId: string; scope: TurnScope; inputEpoch: number;
  state: 'start' | 'end'; text?: string;
  /** Trusted current arrangement/clarification only; frontend may retain it after complete actual playback. */
  workBinding?: WorkInputBinding;
}
export interface DesktopWorkState {
  /** Increasing within this backend instance; a new backend_ready resets the UI sequence. */
  sequence: number;
  focus: 'companion' | 'work';
  stage: WorkStage;
  draft?: WorkDraft;
  confirmation?: ForwardRequest;
  /** Exact focused/selected work record. Never infer it from another background row. */
  activeRequestId?: string;
  /** Recoverable independent display, including exact confirmed request lookup. */
  sourceInput?: WorkSourceInput;
  /** Independent work panel only. Never append these bodies/results to the companion chat. */
  requests: readonly ForwardRequest[];
  /** All nonterminal confirmed records, independent of the short display list. */
  pendingCount?: number;
  /** Short result of the last explicit local reminder operation; no task execution claim. */
  reminderFeedback?: string;
  detail?: string;
}
export type DesktopWorkAction =
  | { type: 'clear_unknown_reminders'; records: readonly { id: string; expectedVersion: number }[] }
  | { type: 'open_native'; id: string }
  | { type: 'reprepare'; draftId: string; expectedVersion: number; text: string; executor: WorkExecutor; target?: CodexTaskTarget; projectId?: string; projectVersion?: number }
  | { type: 'replan'; draftId: string; expectedVersion: number; text: string }
  | { type: 'select'; draftId: string; expectedVersion: number; target: CodexTaskTarget; projectId?: string; projectVersion?: number }
  | { type: 'revise'; draftId: string; expectedVersion: number; text: string }
  | { type: 'confirm'; id: string; expectedVersion: number }
  | { type: 'dismiss'; draftId?: string }
  | { type: 'refresh'; id?: string }
  | { type: 'focus'; id?: string };
export type WorkIntent = { kind: 'companion' } | { kind: 'work' | 'clarify'; question?: string };
export interface DesktopWorkPort {
  /** Called for text and ASR transcript before ANY companion append or background maintenance. */
  route(scope: TurnScope, text: string, signal: AbortSignal): Promise<'companion' | 'handled'>;
  action(action: DesktopWorkAction): Promise<void>;
  onInput(): void;
  /** Called after creating a user turn, before capture/model work; absent binding never authorizes pending confirmation. */
  beginInput?(scope: TurnScope, binding?: WorkInputBinding): void;
  close(): Promise<void>;
}

/** Metadata only for planning; no project documents, chat history or prior outputs. */
export interface WorkPlanCatalog { projects: WorkDraft['projects']; targets: WorkDraft['targets'] }
export type WorkPlan = { kind: 'clarify'; question: string } | { kind: 'ready'; executor: WorkExecutor; title: string; text: string; reason: string; spokenSummary?: string; targetId?: string; projectId?: string; projectVersion?: number };
