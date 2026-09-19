/** Project index v0.1.0. Metadata only; independent of companion memory and task execution. */
export const PROJECT_INDEX_VERSION = '0.1.0' as const;

export interface ProjectDetailReference {
  /** Explicitly registered absolute local project directory. No URL or credential. */
  rootPath: string;
  /** Optional relative documentation entry; never an absolute path or parent traversal. */
  entryFile?: string;
}
export interface CodexTaskTarget {
  /** Existing App task identity. The transport must independently verify this target. */
  threadId: string;
  hostId: string;
}
export interface ProjectEntry {
  id: string;
  name: string;
  abstract: string;
  detailRef: ProjectDetailReference;
  codexTarget?: CodexTaskTarget;
  version: number;
  updatedAt: string;
}
export interface ProjectIndexQuery { query?: string; offset?: number; limit?: number }
export interface ProjectIndexPage { items: readonly ProjectEntry[]; total: number; offset: number; limit: number }
export interface ProjectIndexSave {
  /** Omit for creation. IDs are assigned by the store, stable across rename and restart. */
  id?: string;
  /** Zero for creation; current item version for changes. */
  expectedVersion: number;
  name: string;
  abstract: string;
  detailRef: ProjectDetailReference;
  codexTarget?: CodexTaskTarget;
}
export interface ProjectIndexPort {
  list(query: ProjectIndexQuery): Promise<ProjectIndexPage>;
  get(id: string): Promise<ProjectEntry | null>;
  save(input: ProjectIndexSave): Promise<ProjectEntry>;
  /** Remove the index card only. Never delete the project, Codex task or companion facts. */
  remove(id: string, expectedVersion: number): Promise<{ id: string; removed: true }>;
  close(): Promise<void>;
}
