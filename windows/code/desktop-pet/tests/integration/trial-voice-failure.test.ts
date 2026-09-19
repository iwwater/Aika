import test from 'node:test';
import assert from 'node:assert/strict';
import type { BackendToDesktop } from '../../contracts/desktop-bridge.js';
import type { TurnScope } from '../../contracts/index.js';
import { DesktopDeviceBridge } from '../../app/desktop-device-bridge.js';
import { BackendSession, type BackendPorts } from '../../app/backend-session.js';
import { MemoryMediaStore } from '../../media/store.js';

const scope: TurnScope = { characterId: 'friend', sessionId: 'voice-session', turnId: 'voice-turn', generation: 1 };

// Exercise the production bridge without requesting any browser/native devices.
test('failed voice start gives safe recording guidance and rejects late replies', async () => {
  const sent: BackendToDesktop[] = [];
  const bridge = new DesktopDeviceBridge(new MemoryMediaStore(), message => sent.push(message));
  try {
    const started = bridge.capture.start(scope, new AbortController().signal);
    const request = sent.at(-1);
    assert.equal(request?.channel, 'capture_start');
    if (request?.channel !== 'capture_start') throw new Error('Expected capture request');
    bridge.receive({ channel: 'rpc_error', requestId: request.requestId,
      message: 'private diagnostic: https://example.invalid/?token=DO_NOT_ECHO' });
    await assert.rejects(started, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /DO_NOT_ECHO|example\.invalid/);
      assert.match(error.message, /录音/);
      assert.match(error.message, /重试|重启|检查/);
      return true;
    });
    assert.equal(bridge.receive({ channel: 'ack', requestId: request.requestId }), false);
    const retry = bridge.capture.start({ ...scope, turnId: 'retry', generation: 2 }, new AbortController().signal);
    const retryRequest = sent.at(-1);
    if (retryRequest?.channel !== 'capture_start') throw new Error('Expected retry request');
    bridge.receive({ channel: 'ack', requestId: retryRequest.requestId });
    await retry;
  } finally { bridge.close(); }
});

test('explicit capture stop cancels a pending start and ignores its late readiness', async () => {
  const sent: BackendToDesktop[] = [];
  const bridge = new DesktopDeviceBridge(new MemoryMediaStore(), message => sent.push(message), 30);
  try {
    const started = bridge.capture.start(scope, new AbortController().signal);
    const rejected = assert.rejects(started, { name: 'AbortError' });
    const startRequest = sent.at(-1);
    if (startRequest?.channel !== 'capture_start') throw new Error('Expected start request');
    const stopped = bridge.capture.stop(scope);
    const stopRequest = sent.at(-1);
    if (stopRequest?.channel !== 'capture_stop') throw new Error('Expected stop request');
    bridge.receive({ channel: 'ack', requestId: stopRequest.requestId });
    await stopped;
    await rejected;
    assert.equal(bridge.receive({ channel: 'ack', requestId: startRequest.requestId }), false);
  } finally { bridge.close(); }
});

test('voice failure crosses the actual backend session with scope, cleanup and retry intact', async () => {
  const sent: BackendToDesktop[] = [], store = new MemoryMediaStore();
  let downstreamCalls = 0;
  const forbidden = async (): Promise<never> => { downstreamCalls++; throw new Error('No model or memory work is expected'); };
  const ports: BackendPorts = {
    mediaStore: store,
    perception: { perceive: forbidden }, dialogue: { reply: forbidden }, tts: { synthesize: forbidden },
    memory: { append: forbidden, context: forbidden, maintain: forbidden,
      maintenanceInput(owner) { return { scope: owner, messages: [], relevantMemories: [] }; } },
  };
  const session = new BackendSession(ports, message => {
    sent.push(message);
    if (message.channel === 'stop' || message.channel === 'capture_stop') queueMicrotask(() => {
      void session.receiveLine(JSON.stringify({ channel: 'ack', requestId: message.requestId }));
    });
  }, () => {});
  const command = (value: unknown) => session.receiveLine(JSON.stringify({ channel: 'command', command: value }));
  try {
    await command({ type: 'start_voice' });
    const start = sent.find(m => m.channel === 'capture_start');
    if (start?.channel !== 'capture_start') throw new Error('Expected start request');
    await session.receiveLine(JSON.stringify({ channel: 'rpc_error', requestId: start.requestId, message: 'PRIVATE_DIAGNOSTIC' }));
    await session.drain();
    const error = sent.find(m => m.channel === 'event' && m.event.type === 'error');
    if (error?.channel !== 'event' || error.event.type !== 'error') throw new Error('Expected scoped error');
    assert.deepEqual(error.event.scope, start.scope);
    assert.match(error.event.message, /录音/); assert.doesNotMatch(error.event.message, /PRIVATE_DIAGNOSTIC/);
    assert.ok(sent.some(m => m.channel === 'capture_stop' && m.scope.turnId === start.scope.turnId));
    assert.equal(store.count, 0);
    await command({ type: 'cancel' });
    const boundary = sent.length;
    await session.receiveLine(JSON.stringify({ channel: 'rpc_error', requestId: start.requestId, message: 'LATE_FAILURE' }));
    assert.equal(sent.length, boundary);
    await command({ type: 'start_voice' });
    const retry = sent.at(-1);
    if (retry?.channel !== 'capture_start') throw new Error('Expected retry');
    assert.equal(retry.scope.characterId, 'companion');
    await session.receiveLine(JSON.stringify({ channel: 'ack', requestId: retry.requestId }));
    await command({ type: 'cancel' });
    await session.drain();
    assert.equal(downstreamCalls, 0);
  } finally { await session.close(); }
});

test('structured device failures are scoped and only known code-stage pairs guide the user', async () => {
  const sent: BackendToDesktop[] = [];
  const bridge = new DesktopDeviceBridge(new MemoryMediaStore(), message => sent.push(message));
  try {
    for (const [failure, expected] of [
      [{ code: 'permission_denied', stage: 'get_user_media' }, /系统设置/],
      [{ code: 'capture_module_failed', stage: 'audio_worklet' }, /录音组件/],
      [{ code: 'capture_start_failed', stage: 'camera_preview' }, /摄像头/],
      [{ code: 'PRIVATE_CODE', stage: 'PRIVATE_STAGE' }, /录音启动失败/],
      [{ code: 'permission_denied', stage: 'audio_worklet' }, /录音启动失败/],
    ] as const) {
      const started = bridge.capture.start(scope, new AbortController().signal);
      const request = sent.at(-1);
      if (request?.channel !== 'capture_start') throw new Error('Expected start');
      assert.equal(bridge.receive({ channel: 'rpc_error', requestId: request.requestId,
        scope: { ...scope, characterId: 'sweetheart' }, error: failure, message: 'PRIVATE_MESSAGE' }), false);
      bridge.receive({ channel: 'rpc_error', requestId: request.requestId, scope, error: failure, message: 'PRIVATE_MESSAGE' });
      await assert.rejects(started, (error: unknown) => {
        assert.ok(error instanceof Error); assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /PRIVATE/); return true;
      });
    }
  } finally { bridge.close(); }
});
