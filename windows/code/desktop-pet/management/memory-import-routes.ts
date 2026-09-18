import type { IncomingMessage } from 'node:http';
import { isProductCharacter } from '../contracts/character.js';
import type { MemoryImportManagement, MemoryImportSource } from '../contracts/memory-import.js';
import { ManagementError } from '../contracts/management.js';
const str = (value: unknown, max = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', '导入信息不完整或无效。');
  return value;
};
async function invoke<T>(work: () => T | Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof ManagementError) throw error;
    const code = (error as {code?:unknown})?.code;
    if (code === 'invalid_state' || code === 'version_conflict' || code === 'source_changed')
      throw new ManagementError('version_conflict', '导入状态或来源已变化，请刷新后核对。');
    if (code === 'invalid_source_entry' || code === 'unsupported_export' || code === 'ambiguous_project')
      throw new ManagementError('invalid_request', '来源信息无效，请核对项目位置与导出格式。');
    if (code === 'source_unavailable') throw new ManagementError('unavailable', '指定来源暂时无法读取。');
    throw error;
  }
}
export async function memoryImportRoute(req: IncomingMessage, url: URL, port: MemoryImportManagement | undefined,
  body: () => Promise<Record<string, unknown>>, send: (value: unknown) => void): Promise<boolean> {
  if (!url.pathname.startsWith('/api/memory-import')) return false;
  if (!port) throw new ManagementError('unavailable', '旧聊天导入尚未就绪。');
  if (req.method === 'GET' && url.pathname === '/api/memory-import') { send(await invoke(() => port.snapshot())); return true; }
  if (req.method !== 'POST') throw new ManagementError('not_found', '没有这个导入操作。');
  const b = await body(), instanceId = str(b.instanceId);
  if (url.pathname === '/api/memory-import/start') {
    if (!isProductCharacter(b.characterId)) throw new ManagementError('invalid_request', '仅可导入当前陪伴角色。');
    const source = b.source as Partial<MemoryImportSource> | null;
    if (!source || !['codex-project','text-export'].includes(String(source.kind))) throw new ManagementError('invalid_request', '请选择支持的聊天来源。');
    const characterId = b.characterId;
    send(await invoke(() => port.start({ instanceId, characterId, operationId: str(b.operationId), source: {
      kind: source.kind!, projectName: str(source.projectName), path: str(source.path, 4096),
    } }))); return true;
  }
  if (url.pathname === '/api/memory-import/pause' || url.pathname === '/api/memory-import/resume') {
    if (!Number.isSafeInteger(b.expectedRevision) || Number(b.expectedRevision) < 1) throw new ManagementError('invalid_request', '导入版本无效，请刷新。');
    const action = { instanceId, jobId: str(b.jobId), expectedRevision: Number(b.expectedRevision) };
    send(await invoke(() => url.pathname.endsWith('/pause') ? port.pause(action) : port.resume(action)));  return true;
  }
  throw new ManagementError('not_found', '没有这个导入操作。');
}
