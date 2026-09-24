import type { IncomingMessage } from 'node:http';
import { ManagementError } from '../contracts/management.js';
import type { WorkProtocolManagement } from '../contracts/work-protocol.js';
import type { WorkProtocol, WorkRequest } from '../contracts/perception.js';

const bad = (): never => { throw new ManagementError('invalid_request', '工作协议请求字段无效。'); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad();
const str = (value: unknown, max = 20000): string => typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : bad();
const revision = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : bad();
const nonNegativeRevision = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : bad();
const operationId = (value: unknown): string => {
  const id = str(value, 160);
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(id)) bad();
  return id;
};

function mapError(error: unknown): never {
  if (error instanceof ManagementError) throw error;
  const message = error instanceof Error ? error.message : '';
  if (/revision_conflict/.test(message)) throw new ManagementError('version_conflict', '工作请求已更新，请刷新后重新核对。');
  if (/request_not_found/.test(message)) throw new ManagementError('not_found', '工作请求不存在。');
  if (/pairing_mismatch/.test(message)) throw new ManagementError('forbidden', '工作请求不属于当前用户。');
  if (/operation_forgotten/.test(message)) throw new ManagementError('version_conflict', '这项请求已经遗忘，不能再次执行。');
  throw new ManagementError('unavailable', '工作协议操作未完成；没有自动重试。');
}

export async function workProtocolRoute(req: IncomingMessage, url: URL, service: WorkProtocolManagement | undefined,
  body: () => Promise<Record<string, unknown>>, respond: (value: unknown) => void): Promise<boolean> {
  if (url.pathname !== '/api/work-protocol' && !url.pathname.startsWith('/api/work-protocol/')) return false;
  if (!service) throw new ManagementError('unavailable', 'ACP/MCP 工作协议运行时尚未接入当前实例。');
  try {
    if (req.method === 'GET' && url.pathname === '/api/work-protocol') { respond(service.snapshot()); return true; }
    if (req.method === 'GET' && url.pathname === '/api/work-protocol/tools') { respond({ tools: await service.listTools() }); return true; }
    if (req.method === 'PUT' && url.pathname === '/api/work-protocol/profiles') {
      const value = await body();
      respond({ profiles: await service.saveProfiles(nonNegativeRevision(value.expectedRevision), value.profiles) }); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/work-protocol/prepare') {
      const value = await body(), target = object(value.target), protocol = value.protocol;
      if (protocol !== 'acp' && protocol !== 'mcp') bad();
      const permissionGrant = value.permissionGrant ?? [];
      if (!Array.isArray(permissionGrant) || permissionGrant.length > 100 || permissionGrant.some(item => typeof item !== 'string')) bad();
      let toolCall: WorkRequest['toolCall'];
      if (value.toolCall !== undefined) {
        const raw = object(value.toolCall), args = object(raw.arguments);
        toolCall = { name: str(raw.name, 128), arguments: args };
      }
      const request = service.prepare({ protocol: protocol as WorkProtocol, executorId: str(value.executorId, 128),
        target: { title: str(target.title, 500), ...(target.directory === undefined ? {} : { directory: str(target.directory, 2048) }),
          ...(target.projectId === undefined ? {} : { projectId: str(target.projectId, 200) }) },
        instruction: str(value.instruction, 20000), permissionGrant: permissionGrant as string[], ...(toolCall ? { toolCall } : {}) });
      respond({ request }); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/work-protocol/revise') {
      const value = await body();
      respond({ request: service.revise(operationId(value.operationId), revision(value.expectedRevision), object(value.updates) as never) }); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/work-protocol/confirm') {
      const value = await body();
      respond({ receipt: await service.confirm(operationId(value.operationId), revision(value.expectedRevision)) }); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/work-protocol/cancel') {
      const value = await body();
      respond({ receipt: await service.cancel(operationId(value.operationId), revision(value.expectedRevision)) }); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/work-protocol/forget') {
      const value = await body(); service.forget(operationId(value.operationId)); respond({ forgotten: true }); return true;
    }
    throw new ManagementError('not_found', '没有这个工作协议操作。');
  } catch (error) { mapError(error); }
}
