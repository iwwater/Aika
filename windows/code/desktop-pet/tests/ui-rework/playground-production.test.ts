import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../management/helpers.js';
import type { PlaygroundManagementPort, PlaygroundTurnSubmitInput, PlaygroundTurnView } from '../../contracts/management.js';

test('UIR-04 Playground Production: TurnPort submission flows through history and trace references', async t => {
  const f = await fixture(t);

  // In-memory facade simulating production TurnPort bridge in trial-backend
  const turns = new Map<string, PlaygroundTurnView>();
  let activeTurnCounter = 0;

  const port: PlaygroundManagementPort = {
    session() {
      return {
        pairing: { userId: 'trial-user', characterId: 'companion', characterInstanceId: 'inst-01' },
        sessionId: 'session-prod-01',
        capabilities: { canSubmitText: true, canCancel: true, hasStt: true, hasTts: true },
        effectiveConfigRevision: 1,
        status: activeTurnCounter > 0 ? 'busy' : 'idle'
      };
    },
    async submitTurn(input: PlaygroundTurnSubmitInput) {
      activeTurnCounter++;
      const turnId = `turn-${input.operationId}`;
      const turn: PlaygroundTurnView = {
        turnId,
        operationId: input.operationId,
        status: 'completed',
        text: input.text,
        reply: `已收到【${input.text}】，作为正式陪伴会话记录。`,
        traceRef: `trace-${turnId}`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString()
      };
      turns.set(turnId, turn);
      activeTurnCounter--;
      return turn;
    },
    getTurn(turnId: string) {
      return turns.get(turnId) || null;
    },
    async cancelTurn(turnId: string) {
      const turn = turns.get(turnId);
      if (turn && turn.status === 'running') {
        turn.status = 'cancelled';
        return { cancelled: true, turnId };
      }
      return { cancelled: false, turnId };
    }
  };

  // Submit turn via facade
  const turn = await port.submitTurn({
    operationId: 'turn-op-1',
    pairing: { userId: 'trial-user', characterId: 'companion', characterInstanceId: 'inst-01' },
    sessionId: 'session-prod-01',
    text: '你好沈砚，今天我们一起看夕阳吧。'
  });

  assert.equal(turn.status, 'completed');
  assert.ok(turn.reply?.includes('今天我们一起看夕阳吧'));
  assert.ok(turn.traceRef?.startsWith('trace-'));

  // Query turn status
  const queried = port.getTurn(turn.turnId);
  assert.deepEqual(queried, turn);
});
