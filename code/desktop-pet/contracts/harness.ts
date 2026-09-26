import type { CodexTaskTarget, ProjectEntry } from './projects.js';

/** Thin forwarding receipts v0.1.0. Harness/Codex own execution; no local work queue. */
export type WorkExecutor = 'codex' | 'harness';
export type ForwardPhase = 'awaiting_confirmation' | 'forwarding' | 'accepted' | 'completed' | 'unknown' | 'unavailable';
export interface ForwardRequest {
  id: string;
  version: number;
  phase: ForwardPhase;
  text: string;
  /** Missing executor in older records means codex. Harness has no fabricated Codex target. */
  executor?: WorkExecutor;
  target?: CodexTaskTarget & { title?: string };
  plan?: { title: string; reason: string; spokenSummary?: string };
  project?: Pick<ProjectEntry, 'id' | 'name' | 'version' | 'detailRef'> & { source?: 'index' | 'task_directory' };
  createdAt: string;
  confirmedAt?: string;
  /** Explicitly cleared reminder for this exact unknown state; original task remains unchanged. */
  reminderCleared?: boolean;
  harnessSessionId?: string;
  appTurnId?: string;
  /** Allowlisted tool names from exact pending native approval events; never raw arguments/reasons. */
  nativeApprovalTools?: string[];
  nativeStatus?: 'working'|'approval'|'completed'|'failed'|'unknown';
  /** Local native session URL, never a launcher credential. */
  nativeSessionUrl?: string;
  /** Project/task view only. Never feed to ordinary companion context, summary or memory. */
  result?: string;
  detail?: string;
}
export interface ForwardPrepare { text: string; executor?: WorkExecutor; target?: CodexTaskTarget; projectId?: string; projectVersion?: number; plan?: { title: string; reason: string; spokenSummary?: string } }
export const FORWARD_TARGET_LIMIT = 1000;
/** Search is applied before this bounded list. Older providers may omit limit. */
export interface ForwardTargets { limit?: typeof FORWARD_TARGET_LIMIT; items: readonly { threadId: string; hostId: 'local'; title: string; projectPath: string }[] }
export interface ForwardSnapshot {
  requests: readonly ForwardRequest[];
  connection: { harness: 'ready' | 'unavailable' | 'authentication_required' | 'incompatible'; codex: 'compatible' | 'incompatible'; preset: 'ready' | 'unavailable' };
}
export interface ForwardingPort {
  snapshot(): Promise<ForwardSnapshot>;
  targets(query: string): Promise<ForwardTargets>;
  prepare(input: ForwardPrepare): Promise<ForwardRequest>;
  /** Once confirmed, repeat calls only return the recorded state; never resend. */
  confirm(id: string, expectedVersion: number): Promise<ForwardRequest>;
  /** Read the exact returned App turn; unknown never triggers another send. */
  refresh(id: string): Promise<ForwardRequest>;
  close(): Promise<void>;
}
