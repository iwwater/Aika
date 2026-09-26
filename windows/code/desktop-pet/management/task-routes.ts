import type { IncomingMessage } from 'node:http';
import { ManagementError } from '../contracts/management.js';
import type { ForwardingPort, ForwardPrepare, ForwardRequest } from '../contracts/harness.js';

export interface TaskManagement extends ForwardingPort { sendConfirmed(id: string): Promise<ForwardRequest>; toolStatus(id: string): Promise<ForwardRequest> }
const invalid = (): never => { throw new ManagementError('invalid_request', '任务字段无效，请重新核对。'); };
const text = (value: unknown, max: number): string => typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : invalid();
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const version = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : invalid();
export async function taskRoute(req: IncomingMessage, url: URL, tasks: TaskManagement | undefined,
  body: () => Promise<Record<string, unknown>>, respond: (value: unknown) => void): Promise<boolean> {
  if (url.pathname !== '/api/tasks' && !url.pathname.startsWith('/api/tasks/') && !url.pathname.startsWith('/api/harness-tools/')) return false;
  if (!tasks) throw new ManagementError('unavailable', '任务连接暂时不可用，陪伴聊天仍可继续。');
  if (req.method === 'GET' && url.pathname === '/api/tasks') { respond(await tasks.snapshot()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/tasks/targets') { respond(await tasks.targets(text(url.searchParams.get('query') ?? '', 200))); return true; }
  if (req.method !== 'POST') throw new ManagementError('not_found', '没有这个任务操作。');
  const b = await body();
  if (url.pathname === '/api/tasks/prepare') {
    const target = object(b.target); const input: ForwardPrepare = { text: text(b.text, 20000), target: { threadId: text(target.threadId, 200), hostId: text(target.hostId, 200) },
      ...(b.projectId === undefined ? {} : { projectId: text(b.projectId, 200), projectVersion: version(b.projectVersion) }) };
    if (b.projectId === undefined && b.projectVersion !== undefined) return invalid();
    respond(await tasks.prepare(input)); return true;
  }
  const id = text(b.id, 200);
  if (url.pathname === '/api/tasks/confirm') { respond(await tasks.confirm(id, version(b.expectedVersion))); return true; }
  if (url.pathname === '/api/tasks/refresh') { respond(await tasks.refresh(id)); return true; }
  if (url.pathname === '/api/harness-tools/send-confirmed') { respond(await tasks.sendConfirmed(id)); return true; }
  if (url.pathname === '/api/harness-tools/status') { respond(await tasks.toolStatus(id)); return true; }
  throw new ManagementError('not_found', '没有这个任务操作。');
}
