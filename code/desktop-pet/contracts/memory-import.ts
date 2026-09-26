import type { CharacterId } from './character.js';

/** Local, user-started historical companion import. No transcript payload in management status. */
export const MEMORY_IMPORT_CONTRACT_VERSION = '0.1.0' as const;
export interface MemoryImportSource {
  readonly kind: 'codex-project' | 'text-export';
  readonly projectName: string;
  /** Exact local project directory, or supported export file. Never a remote URL. */
  readonly path: string;
}
export interface MemoryImportConfiguration {
  readonly model: string;
  readonly endpointHost: string;
  readonly batchMessages: number;
  readonly maxInputBytes: number;
  readonly maxOutputTokens: number;
  readonly concurrency: 1;
  readonly timeoutMs: number;
  readonly budgetMode: 'unlimited' | 'bounded';
  readonly limitMicros: number | null;
  readonly inputMicrosPerToken: number;
  readonly outputMicrosPerToken: number;
  readonly currency: 'CNY';
  readonly textExportFormat: string;
}
export type MemoryImportStatus = 'discovering' | 'running' | 'paused' | 'failed' | 'completed';
export interface MemoryImportJob {
  readonly id: string;
  readonly revision: number;
  readonly characterId: CharacterId;
  readonly source: MemoryImportSource;
  readonly sourceFingerprint: string | null;
  readonly status: MemoryImportStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly discoveredMessages: number;
  readonly processedMessages: number;
  readonly skippedMessages: number;
  readonly totalBatches: number;
  readonly completedBatches: number;
  readonly importedMemories: number;
  readonly estimatedCalls: number;
  readonly estimatedMicros: number | null;
  readonly actualCalls: number;
  /** Local token-based estimate, never a supplier bill. */
  readonly accountedMicros: number;
  readonly unknownCostCalls: number;
  readonly failures: readonly { readonly item: string; readonly code: string }[];
  readonly configuration: MemoryImportConfiguration;
}
export interface MemoryImportSnapshot {
  readonly instanceId: string;
  readonly configuration: MemoryImportConfiguration;
  readonly jobs: readonly MemoryImportJob[];
}
export interface MemoryImportStart {
  readonly instanceId: string;
  readonly operationId: string;
  readonly characterId: CharacterId;
  readonly source: MemoryImportSource;
}
export interface MemoryImportAction {
  readonly instanceId: string;
  readonly jobId: string;
  readonly expectedRevision: number;
}
export interface MemoryImportManagement {
  snapshot(): MemoryImportSnapshot | Promise<MemoryImportSnapshot>;
  start(input: MemoryImportStart): MemoryImportJob | Promise<MemoryImportJob>;
  pause(input: MemoryImportAction): MemoryImportJob | Promise<MemoryImportJob>;
  resume(input: MemoryImportAction): MemoryImportJob | Promise<MemoryImportJob>;
  close(): void | Promise<void>;
}
