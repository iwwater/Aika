import { ManagementError } from '../contracts/management.js';
import type { CaptureGrant, GrantScopeType, Observation } from '../contracts/perception.js';

export interface PerceptionManagementPort {
  status(): unknown;
  issue(input: { scopeType: GrantScopeType; destination: 'local' | 'cloud'; userConfirmed: boolean }): CaptureGrant;
  capture(input: { grantId: string; mimeType: string; imageBase64: string }): Promise<Observation>;
  attach(observationId: string, userConfirmed: boolean): void;
  revoke(grantId: string): { revoked: boolean };
  clear(observationId: string): { cleared: true };
}

export async function perceptionRoute(method: string | undefined, port: PerceptionManagementPort | undefined,
  pathname: string, body: () => Promise<Record<string, unknown>>, send: (value: unknown) => void): Promise<boolean> {
  if (!pathname.startsWith('/api/perception')) return false;
  if (!port) throw new ManagementError('unavailable', '当前运行实例未装配授权感知。');
  if (method === 'GET' && pathname === '/api/perception') { send(port.status()); return true; }
  if (method === 'POST' && pathname === '/api/perception/grants') {
    const value = await body();
    const scopeType = value.scopeType;
    if (scopeType !== 'window' && scopeType !== 'region' && scopeType !== 'screen') throw new ManagementError('invalid_request', '采集范围无效。');
    if (value.destination !== 'local' && value.destination !== 'cloud') throw new ManagementError('invalid_request', '处理目的地无效。');
    if (value.userConfirmed !== true) throw new ManagementError('forbidden', '需要先确认本次采集操作。');
    try { send({ grant: port.issue({ scopeType: scopeType as GrantScopeType, destination: value.destination,
      userConfirmed: true }) }); return true; }
    catch (error) { throw safePerceptionError(error); }
  }
  if (method === 'POST' && pathname === '/api/perception/captures') {
    const value = await body();
    if (typeof value.grantId !== 'string' || typeof value.mimeType !== 'string' || typeof value.imageBase64 !== 'string') {
      throw new ManagementError('invalid_request', '采集帧字段无效。');
    }
    try { send({ observation: await port.capture({ grantId: value.grantId, mimeType: value.mimeType, imageBase64: value.imageBase64 }) }); return true; }
    catch (error) { throw safePerceptionError(error); }
  }
  if (method === 'POST' && pathname === '/api/perception/attach') {
    const value = await body();
    if (typeof value.observationId !== 'string' || value.observationId.length > 128) throw new ManagementError('invalid_request', '观察编号无效。');
    if (value.userConfirmed !== true) throw new ManagementError('forbidden', '需要先确认将观察附加到下一轮对话。');
    try { port.attach(value.observationId, true); send({ attached: true, expiresInMs: 120_000 }); return true; }
    catch (error) { throw safePerceptionError(error); }
  }
  const revoke = /^\/api\/perception\/grants\/([^/]+)$/.exec(pathname);
  if (method === 'DELETE' && revoke) { send(port.revoke(decodeURIComponent(revoke[1]!))); return true; }
  const clear = /^\/api\/perception\/observations\/([^/]+)$/.exec(pathname);
  if (method === 'DELETE' && clear) {
    try { send(port.clear(decodeURIComponent(clear[1]!))); return true; }
    catch (error) { throw safePerceptionError(error); }
  }
  throw new ManagementError('not_found', '没有这个授权感知操作。');
}

function safePerceptionError(error: unknown): ManagementError {
  const code = error instanceof Error ? error.message : '';
  if (code === 'capture_confirmation_required' || code === 'observation_attach_confirmation_required') return new ManagementError('forbidden', '需要先确认本次采集或附加操作。');
  if (code.includes('_perception_engine_unavailable')) return new ManagementError('unavailable', '所选处理目的地没有可用的感知引擎。');
  if (code.startsWith('capture_') || code.startsWith('observation_')) return new ManagementError('invalid_request', '采集或观察数据无效、已过期或不属于当前配对。');
  return new ManagementError('unavailable', '授权感知操作未完成；原始图像与内部错误不会写入诊断。');
}
