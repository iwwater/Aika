import test from 'node:test';
import assert from 'node:assert/strict';
import { playgroundRoute } from '../../management/playground-routes.js';
import type { PlaygroundManagementPort, PlaygroundTurnView } from '../../contracts/management.js';

const body = (value: Record<string, unknown>) => async () => value;

test('UIR-04 Playground Routes: exposes session, turns submission, query and cancel', async () => {
  const turnsStore = new Map<string, PlaygroundTurnView>();

  const fakePort: PlaygroundManagementPort = {
    session(pairing) {
      return {
        pairing: pairing || { userId: 'u', characterId: 'c', characterInstanceId: 'i' },
        sessionId: 'test-session-123',
        capabilities: {
          canSubmitText: true,
          canCancel: true,
          hasStt: false,
          hasTts: true
        },
        effectiveConfigRevision: 4,
        status: 'idle'
      };
    },
    async submitTurn(input) {
      const turn: PlaygroundTurnView = {
        turnId: `t-${input.operationId}`,
        operationId: input.operationId,
        status: 'running',
        text: input.text,
        reply: `Echo: ${input.text}`,
        traceRef: `trace-${input.operationId}`,
        startedAt: new Date().toISOString()
      };
      turnsStore.set(turn.turnId, turn);
      return turn;
    },
    getTurn(turnId) {
      return turnsStore.get(turnId) || null;
    },
    async cancelTurn(turnId) {
      const turn = turnsStore.get(turnId);
      if (turn) turn.status = 'cancelled';
      return { cancelled: !!turn, turnId };
    }
  };

  // 1. GET /api/playground/session
  const session = await playgroundRoute('GET', fakePort, '/api/playground/session', body({}), new URLSearchParams('user=alice&character=companion')) as { sessionId: string; status: string };
  assert.equal(session.sessionId, 'test-session-123');
  assert.equal(session.status, 'idle');

  // 2. POST /api/playground/turns
  const submitted = await playgroundRoute('POST', fakePort, '/api/playground/turns', body({
    operationId: 'op-42',
    sessionId: 'test-session-123',
    pairing: { userId: 'alice', characterId: 'companion', characterInstanceId: 'inst-1' },
    text: '测试问题：今天天气怎么样？'
  }), new URLSearchParams()) as PlaygroundTurnView;

  assert.equal(submitted.operationId, 'op-42');
  assert.equal(submitted.turnId, 't-op-42');
  assert.ok(submitted.reply?.includes('今天天气怎么样？'));

  // 3. GET /api/playground/turns/:id
  const fetched = await playgroundRoute('GET', fakePort, '/api/playground/turns/t-op-42', body({}), new URLSearchParams()) as PlaygroundTurnView;
  assert.equal(fetched.turnId, 't-op-42');

  // 4. POST /api/playground/turns/:id/cancel
  const cancelRes = await playgroundRoute('POST', fakePort, '/api/playground/turns/t-op-42/cancel', body({}), new URLSearchParams()) as { cancelled: boolean };
  assert.equal(cancelRes.cancelled, true);
  const afterCancel = await fakePort.getTurn('t-op-42');
  assert.equal(afterCancel?.status, 'cancelled');

  // 5. Port unavailable check
  assert.throws(() => playgroundRoute('GET', undefined, '/api/playground/session', body({}), new URLSearchParams()), /未装载正式 Playground 调试后端/);
});
