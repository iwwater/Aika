import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductionPlaygroundPort } from '../../management/playground-port.js';
import type { DesktopCommand } from '../../contracts/index.js';
import type { BackendToDesktop } from '../../contracts/desktop-bridge.js';
import { startManagementServer } from '../../management/server.js';
import { fixture } from '../management/helpers.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';

test('UIR-04 Production Playground Port: full turn lifecycle, real turnId, cancel, idempotency', async t => {
  const commandsSent: DesktopCommand[] = [];
  let cancelled = false;

  const pairing = {
    userId: 'user-001',
    characterId: 'companion',
    characterInstanceId: 'inst-001',
  };

  const port = new ProductionPlaygroundPort({
    sendCommand: (cmd: DesktopCommand) => {
      commandsSent.push(cmd);
      // Simulate backend runtime turn execution
      if (cmd.type === 'submit_text') {
        const turnId = `official-turn-${Date.now()}`;
        // 1. Emit turn event
        setTimeout(() => {
          port.observeDesktopMessage({
            channel: 'event',
            event: {
              type: 'turn',
              input: {
                kind: 'text',
                text: cmd.text,
                startedAt: new Date().toISOString(),
                ...(cmd.clientRequestId ? { clientRequestId: cmd.clientRequestId } : {}),
                scope: {
                  turnId,
                  sessionId: 'session-live-01',
                  characterId: 'companion',
                  generation: 1,
                },
              },
            },
          });
        }, 10);

        // 2. Emit reply event
        setTimeout(() => {
          port.observeDesktopMessage({
            channel: 'event',
            event: {
              type: 'reply',
              reply: {
                scope: {
                  turnId,
                  sessionId: 'session-live-01',
                  characterId: 'companion',
                  generation: 1,
                },
                text: `回复：${cmd.text}，已记录到正式历史。`,
                expression: {
                  emotion: 'neutral',
                  intensity: 1,
                  delivery: 'natural',
                  gesture: null,
                },
              },
            },
          });
        }, 30);

        // 3. Emit playback ended event
        setTimeout(() => {
          port.observeDesktopMessage({
            channel: 'event',
            event: {
              type: 'playback',
              playback: {
                type: 'ended',
                at: new Date().toISOString(),
                scope: {
                  turnId,
                  sessionId: 'session-live-01',
                  characterId: 'companion',
                  generation: 1,
                },
              },
            },
          });
        }, 50);
      }
    },
    cancelCurrent: () => {
      cancelled = true;
    },
    pairing,
    sessionId: 'session-live-01',
    getConfigRevision: () => 3,
    hasStt: () => true,
    hasTts: () => true,
  });

  // 1. Check session info
  const session = port.session();
  assert.equal(session.sessionId, 'session-live-01');
  assert.equal(session.effectiveConfigRevision, 3);
  assert.equal(session.capabilities.canSubmitText, true);
  assert.equal(session.capabilities.hasStt, true);
  assert.equal(session.status, 'idle');

  // 2. Submit Turn with unique operationId
  const opId = 'op-text-1';
  const turn = await port.submitTurn({
    operationId: opId,
    pairing,
    sessionId: 'session-live-01',
    text: '今天天气真好。',
  });

  assert.equal(turn.status, 'completed');
  assert.ok(turn.turnId.startsWith('official-turn-'));
  assert.equal(turn.operationId, opId);
  assert.equal(turn.reply, '回复：今天天气真好。，已记录到正式历史。');
  assert.ok(turn.completedAt);

  // 3. Verify getTurn
  const retrieved = port.getTurn(turn.turnId);
  assert.deepEqual(retrieved, turn);

  // 4. Test Idempotency: submitting same opId returns cached completed turn without resending command
  const commandsBefore = commandsSent.length;
  const duplicate = await port.submitTurn({
    operationId: opId,
    pairing,
    sessionId: 'session-live-01',
    text: '今天天气真好。',
  });
  assert.deepEqual(duplicate, turn);
  assert.equal(commandsSent.length, commandsBefore, 'Duplicate operationId must not send a new command');

  // 5. Test Cancellation of running turn
  const opCancel = 'op-cancel-1';
  let cancelTurnId = '';

  const cancelPort = new ProductionPlaygroundPort({
    sendCommand: (cmd: DesktopCommand) => {
      if (cmd.type === 'submit_text') {
        cancelTurnId = `official-turn-cancel-${Date.now()}`;
        setTimeout(() => {
          cancelPort.observeDesktopMessage({
            channel: 'event',
            event: {
              type: 'turn',
              input: {
                kind: 'text',
                text: cmd.text,
                startedAt: new Date().toISOString(),
                ...(cmd.clientRequestId ? { clientRequestId: cmd.clientRequestId } : {}),
                scope: {
                  turnId: cancelTurnId,
                  sessionId: 'session-live-01',
                  characterId: 'companion',
                  generation: 1,
                },
              },
            },
          });
        }, 10);
      }
    },
    cancelCurrent: () => {
      cancelled = true;
    },
    pairing,
    sessionId: 'session-live-01',
    getConfigRevision: () => 1,
  });

  const runningPromise = cancelPort.submitTurn({
    operationId: opCancel,
    pairing,
    sessionId: 'session-live-01',
    text: '长文本正在生成中，准备取消...',
  });

  // Wait 15ms for turnId to be assigned, then cancel
  await new Promise(r => setTimeout(r, 20));
  const cancelResult = await cancelPort.cancelTurn(cancelTurnId);
  assert.equal(cancelResult.cancelled, true);
  assert.equal(cancelResult.turnId, cancelTurnId);
  assert.equal(cancelled, true);

  const cancelledTurn = cancelPort.getTurn(cancelTurnId);
  assert.equal(cancelledTurn?.status, 'cancelled');
});

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

test('UIR-04 Server Routes: without playground port returns 503 unavailable', async t => {
  const f = await fixture(t);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const token = randomBytes(32).toString('hex');

  const server = await startManagementServer({
    uiRoot: 'management/ui',
    settings,
    token,
    port: 0,
    memory: { characters: () => [] } as any,
    snapshot: () => ({
      apiVersion: 1,
      runtime: { instanceId: 'i', pid: 1, sourceRevision: 'r', startedAt: '', observedAt: '', characterId: 'companion', sessionId: '', online: true },
      modules: [],
      events: [],
      adapters: [],
      credentials: [],
      characters: [{ id: 'companion', label: '青梅竹马', revision: 1 }],
      settings: settings.snapshot(),
    }),
  });

  t.after(() => server.close());

  // 1. GET /api/playground/session without port -> 503
  const resSession = await fetch(`${server.origin}/api/playground/session`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(resSession.status, 503);
  const jsonSession = await resSession.json() as { error: { code: string; message: string } };
  assert.equal(jsonSession.error.code, 'unavailable');
  assert.ok(jsonSession.error.message.includes('未装载正式 Playground'));

  // 2. POST /api/playground/turns without port -> 503
  const resTurn = await fetch(`${server.origin}/api/playground/turns`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: server.origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operationId: 'op-1',
      sessionId: 's-1',
      text: 'hello',
    }),
  });
  assert.equal(resTurn.status, 503);
  const jsonTurn = await resTurn.json() as { error: { code: string; message: string } };
  assert.equal(jsonTurn.error.code, 'unavailable');
});
