// FIX61-06: knowledge library contract types, shared by the store, the context assembly and the UI.
// A knowledge library is an independent reference collection. It is not a second Memory, not a second
// character, and not a second application database.
import type { CharacterId } from './index.js';

export type KnowledgeErrorCode = 'invalid_request' | 'not_found' | 'version_conflict' | 'unavailable';
export class KnowledgeError extends Error {
  constructor(readonly code: KnowledgeErrorCode, message: string) { super(message); this.name = 'KnowledgeError'; }
}

export interface KnowledgeLibrary {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly createdAt: string;
}
export interface KnowledgeDocument {
  readonly id: string;
  readonly libraryId: string;
  readonly sourceName: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly revision: number;
  readonly createdAt: string;
}

export interface KnowledgeDocumentContent extends KnowledgeDocument {
  readonly text: string;
}
/**
 * One bounded, stable knowledge block. `ordinal` is its position in the library's stable document
 * order; `locator` is a Unicode code point range inside the source document, so every delivered
 * character can be traced back to a document, a revision and a span.
 */
export interface KnowledgeBlock {
  readonly documentId: string;
  readonly documentRevision: number;
  readonly libraryId: string;
  readonly sourceName: string;
  readonly ordinal: number;
  readonly text: string;
  readonly locator: { readonly start: number; readonly end: number };
}
export interface KnowledgeSelection {
  readonly libraryId: string;
  readonly libraryRevision: number;
  /**
   * Knowledge revocation revision. Every import, document edit, document removal, library deletion and
   * activation change raises it. A snapshot or turn that pinned an older value must not be delivered.
   */
  readonly revision: number;
  readonly blocks: readonly KnowledgeBlock[];
  /** Blocks that did not fit the budget. Non-zero means the whole library was NOT read. */
  readonly omittedCount: number;
  readonly inputTokens: number;
}

/** Read-only view the management page renders; never carries document bodies in bulk. */
export interface KnowledgeSnapshot {
  readonly revision: number;
  readonly activeLibraryId: string | null;
  readonly libraries: readonly (KnowledgeLibrary & { readonly documentCount: number; readonly bytes: number })[];
}
export interface KnowledgeManagement {
  snapshot(): Promise<KnowledgeSnapshot>;
  create(name: string): Promise<KnowledgeSnapshot>;
  rename(libraryId: string, name: string, expectedRevision: number): Promise<KnowledgeSnapshot>;
  importDocuments(libraryId: string, files: readonly { sourceName: string; text: string }[]): Promise<KnowledgeSnapshot>;
  documents(libraryId: string): Promise<readonly KnowledgeDocument[]>;
  documentContent?(libraryId: string, documentId: string): Promise<KnowledgeDocumentContent | null>;
  removeDocument(libraryId: string, documentId: string, expectedRevision: number): Promise<KnowledgeSnapshot>;
  deleteLibrary(libraryId: string, expectedRevision: number): Promise<KnowledgeSnapshot>;
  activate(expectedRevision: number, libraryId: string | null): Promise<KnowledgeSnapshot>;
}
export type KnowledgeCharacterId = CharacterId;
