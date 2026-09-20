// FIX61-06: knowledge library management routes and the UI-facing port.
// Every write is revision-checked; the page can never silently overwrite another window's change.
import { ManagementError } from '../contracts/management.js';
import { KnowledgeError, type KnowledgeManagement, type KnowledgeSnapshot } from '../contracts/knowledge.js';
import type { KnowledgeLibraryStore } from '../memory/knowledge-library.js';

const safe = <T>(work: () => Promise<T> | T): Promise<T> => Promise.resolve().then(work).catch((error: unknown) => {
  if (error instanceof ManagementError) throw error;
  if (error instanceof KnowledgeError) {
    const code = error.code === 'version_conflict' ? 'version_conflict' : error.code === 'not_found' ? 'not_found' : 'invalid_request';
    throw new ManagementError(code, error.message);
  }
  throw new ManagementError('internal_error', '这次知识库操作未完成，原始内容未对外输出。');
});

/** Read-only projection: counts and sizes, never bulk document bodies. */
async function snapshot(store: KnowledgeLibraryStore): Promise<KnowledgeSnapshot> {
  const active = store.active();
  return {
    revision: active.revision,
    activeLibraryId: active.libraryId,
    libraries: store.list().map(library => {
      const documents = store.documents(library.id);
      return { ...library, documentCount: documents.length, bytes: documents.reduce((sum, document) => sum + document.bytes, 0) };
    })
  };
}

export function knowledgeManagement(store: KnowledgeLibraryStore): KnowledgeManagement {
  return {
    snapshot: () => safe(() => snapshot(store)),
    create: name => safe(async () => { store.create(name); return snapshot(store); }),
    rename: (libraryId, name, expectedRevision) => safe(async () => { store.rename(libraryId, name, expectedRevision); return snapshot(store); }),
    importDocuments: (libraryId, files) => safe(async () => { await store.importDocuments(libraryId, files); return snapshot(store); }),
    documents: libraryId => safe(() => store.documents(libraryId)),
    removeDocument: (libraryId, documentId, expectedRevision) => safe(async () => { await store.removeDocument(libraryId, documentId, expectedRevision); return snapshot(store); }),
    deleteLibrary: (libraryId, expectedRevision) => safe(async () => { await store.deleteLibrary(libraryId, expectedRevision); return snapshot(store); }),
    activate: (expectedRevision, libraryId) => safe(async () => { await store.activate(expectedRevision, libraryId); return snapshot(store); })
  };
}

const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', '文本字段无效。');
  return value;
};
const revision = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ManagementError('invalid_request', '修订号无效。');
  return parsed;
};

/** /api/knowledge/* — same local-session authorization as every other management route. */
export async function knowledgeRoute(method: string | undefined, port: KnowledgeManagement | undefined, pathname: string, body: () => Promise<Record<string, unknown>>): Promise<unknown> {
  if (!port) throw new ManagementError('unavailable', '当前版本尚未接入知识库。');
  if (pathname === '/api/knowledge') {
    if (method === 'GET') return port.snapshot();
    throw new ManagementError('not_found', '没有这个知识库操作。');
  }
  if (pathname === '/api/knowledge/libraries') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个知识库操作。');
    const payload = await body();
    return port.create(text(payload.name, 80));
  }
  if (pathname === '/api/knowledge/rename') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个知识库操作。');
    const payload = await body();
    return port.rename(text(payload.libraryId, 80), text(payload.name, 80), revision(payload.expectedRevision));
  }
  if (pathname === '/api/knowledge/activate') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个知识库操作。');
    const payload = await body();
    const libraryId = payload.libraryId === null || payload.libraryId === undefined ? null : text(payload.libraryId, 80);
    return port.activate(revision(payload.expectedRevision), libraryId);
  }
  if (pathname === '/api/knowledge/import') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个知识库操作。');
    const payload = await body();
    if (!Array.isArray(payload.files)) throw new ManagementError('invalid_request', '请选择要导入的文件。');
    const files = payload.files.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ManagementError('invalid_request', '文件内容无效。');
      const item = entry as Record<string, unknown>;
      return { sourceName: text(item.sourceName, 200), text: text(item.text, 2 * 1024 * 1024 + 1) };
    });
    return port.importDocuments(text(payload.libraryId, 80), files);
  }
  if (pathname === '/api/knowledge/documents') {
    if (method !== 'GET') throw new ManagementError('not_found', '没有这个知识库操作。');
    throw new ManagementError('invalid_request', '请使用带 libraryId 的接口。');
  }
  if (pathname === '/api/knowledge/documents/list') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个知识库操作。');
    const payload = await body();
    return port.documents(text(payload.libraryId, 80));
  }
  if (pathname === '/api/knowledge/documents/remove') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个知识库操作。');
    const payload = await body();
    return port.removeDocument(text(payload.libraryId, 80), text(payload.documentId, 80), revision(payload.expectedRevision));
  }
  if (pathname === '/api/knowledge/libraries/delete') {
    if (method !== 'POST') throw new ManagementError('not_found', '没有这个知识库操作。');
    const payload = await body();
    return port.deleteLibrary(text(payload.libraryId, 80), revision(payload.expectedRevision));
  }
  throw new ManagementError('not_found', '没有这个知识库接口。');
}
