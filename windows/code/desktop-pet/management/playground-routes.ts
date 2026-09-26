// UIR-04: Playground management chat facade routes.
// Exposes /api/playground/session, /turns, /turns/:id, and /turns/:id/cancel
// Dispatches directly to the official BackendSession / TurnPort authority.

import { ManagementError, type PlaygroundManagementPort, type PlaygroundTurnSubmitInput } from '../contracts/management.js';

export function playgroundRoute(
  method: string | undefined,
  port: PlaygroundManagementPort | undefined,
  pathname: string,
  body: () => Promise<Record<string, unknown>>,
  query: URLSearchParams
): Promise<unknown> | unknown {
  if (!port) {
    throw new ManagementError('unavailable', '当前环境未装载正式 Playground 调试后端。');
  }

  // 1. GET /api/playground/session
  if (pathname === '/api/playground/session') {
    if (method !== 'GET') throw new ManagementError('not_found', '请求方法不支持。');
    const userId = query.get('user') || 'default-user';
    const characterId = query.get('character') || 'companion';
    const characterInstanceId = query.get('instance') || 'default-instance';
    return port.session({ userId, characterId, characterInstanceId });
  }

  // 2. POST /api/playground/turns (submit text turn)
  if (pathname === '/api/playground/turns') {
    if (method !== 'POST') throw new ManagementError('not_found', '请求方法不支持。');
    return body().then(payload => {
      const operationId = String(payload.operationId || '').trim();
      const text = String(payload.text || '').trim();
      const sessionId = String(payload.sessionId || '').trim();
      const rawPairing = payload.pairing as Record<string, unknown> | undefined;

      if (!operationId) throw new ManagementError('invalid_request', '缺少 operationId 幂等编号。');
      if (!text) throw new ManagementError('invalid_request', '提交文本不能为空。');
      if (!sessionId) throw new ManagementError('invalid_request', '缺少 sessionId。');

      const pairing = {
        userId: String(rawPairing?.userId || 'default-user'),
        characterId: String(rawPairing?.characterId || 'companion'),
        characterInstanceId: String(rawPairing?.characterInstanceId || 'default-instance')
      };

      const input: PlaygroundTurnSubmitInput = {
        operationId,
        pairing,
        sessionId,
        expectedConfigRevision: payload.expectedConfigRevision !== undefined ? Number(payload.expectedConfigRevision) : undefined,
        text
      };

      return port.submitTurn(input);
    });
  }

  // 3. GET /api/playground/turns/:id & POST /api/playground/turns/:id/cancel
  const turnMatch = pathname.match(/^\/api\/playground\/turns\/([^/]+)(\/cancel)?$/);
  if (turnMatch) {
    const turnId = decodeURIComponent(turnMatch[1]!);
    const isCancel = turnMatch[2] === '/cancel';

    if (isCancel) {
      if (method !== 'POST') throw new ManagementError('not_found', '取消操作只接受 POST。');
      return port.cancelTurn(turnId);
    } else {
      if (method !== 'GET') throw new ManagementError('not_found', '查询操作只接受 GET。');
      return Promise.resolve(port.getTurn(turnId)).then(turn => {
        if (!turn) throw new ManagementError('not_found', '指定的轮次不存在。');
        return turn;
      });
    }
  }

  throw new ManagementError('not_found', '未识别的 Playground 路由。');
}
