import type { IncomingMessage } from 'node:http';
import { ManagementError } from '../contracts/management.js';
import type { ProjectIndexPort, ProjectIndexSave } from '../contracts/projects.js';

const invalid = (): never => { throw new ManagementError('invalid_request', '项目字段无效，请检查名称、摘要和入口。'); };
const text = (value: unknown, max: number): string => typeof value === 'string' && [...value].length <= max && !value.includes('\0') ? value : invalid();
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const integer = (value: unknown, min: number, max: number): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
const queryInteger = (value: string | null, fallback: number, max: number): number => value === null ? fallback : /^\d+$/.test(value) ? integer(Number(value), 0, max) : invalid();

/** Runs behind the management server's existing authentication and Origin checks. */
export async function projectRoute(req: IncomingMessage, url: URL, projects: ProjectIndexPort | undefined,
  body: () => Promise<Record<string, unknown>>, respond: (value: unknown) => void): Promise<boolean> {
  if (url.pathname !== '/api/projects' && !url.pathname.startsWith('/api/projects/')) return false;
  if (!projects) throw new ManagementError('unavailable', '项目索引暂时不可用，陪伴聊天仍可继续。');
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    respond(await projects.list({ query: text(url.searchParams.get('query') ?? '', 200), offset: queryInteger(url.searchParams.get('offset'), 0, 1000000), limit: integer(queryInteger(url.searchParams.get('limit'), 25, 100), 1, 100) })); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/projects/save') {
    const b = await body(), detail = object(b.detailRef);
    const input: ProjectIndexSave = {
      expectedVersion: integer(b.expectedVersion, 0, Number.MAX_SAFE_INTEGER), name: text(b.name, 120), abstract: text(b.abstract, 480),
      detailRef: { rootPath: text(detail.rootPath, 4096), ...(detail.entryFile === undefined ? {} : { entryFile: text(detail.entryFile, 1024) }) },
      ...(b.id === undefined ? {} : { id: text(b.id, 200) }),
    };
    if (b.codexTarget !== undefined) { const target = object(b.codexTarget); input.codexTarget = { hostId: text(target.hostId, 200), threadId: text(target.threadId, 200) }; }
    respond(await projects.save(input)); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/projects/remove') {
    const b = await body(); respond(await projects.remove(text(b.id, 200), integer(b.expectedVersion, 1, Number.MAX_SAFE_INTEGER))); return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/projects/')) {
    let id: string; try { id = decodeURIComponent(url.pathname.slice('/api/projects/'.length)); } catch { return invalid(); }
    if (!id || id.includes('/') || id.includes('\\')) return invalid();
    const item = await projects.get(text(id, 200));
    if (!item) throw new ManagementError('not_found', '没有找到这个项目，请刷新列表。');
    respond(item); return true;
  }
  throw new ManagementError('not_found', '没有这个项目操作。');
}
