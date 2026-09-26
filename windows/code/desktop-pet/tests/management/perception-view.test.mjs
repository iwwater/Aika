import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerceptionSession } from '../../management/ui/perception-session.mjs';

const frame = () => new Blob(['small-frame'], { type: 'image/jpeg' });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('perception waits for source selection and a separate cloud confirmation', async () => {
  const calls = [], track = { stopCount: 0, stop() { this.stopCount++; }, getSettings: () => ({ displaySurface: 'window' }) };
  const client = { async request(path, options = {}) {
    calls.push([path, options]);
    if (path.endsWith('/grants')) return { grant: { grantId: 'grant-1' } };
    if (path.endsWith('/captures')) return { observation: { observationId: 'obs-1', capturedAt: '2026-09-25T00:00:00Z' } };
    return {};
  } };
  const session = createPerceptionSession({ client,
    mediaDevices: { async getDisplayMedia(options) {
      assert.deepEqual(options, { audio: false, video: { frameRate: { ideal: 5, max: 10 } } });
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    } }, encodeFrame: async value => { assert.equal(value, session.state.frame); return 'aW1hZ2U='; } });

  await session.selectSource();
  assert.equal(session.state.phase, 'streaming');
  assert.equal(calls.length, 0, 'opening source selector must not contact the management API');
  session.freeze(frame());
  assert.equal(track.stopCount, 1, 'freezing a frame stops capture immediately');
  await assert.rejects(session.sendToCloud(false), /确认/);
  assert.equal(calls.length, 0);

  const observation = await session.sendToCloud(true);
  assert.equal(observation.observationId, 'obs-1');
  assert.equal(session.state.phase, 'observed');
  assert.equal(calls[0][0], '/api/perception/grants');
  assert.deepEqual(calls[0][1].body, { scopeType: 'window', destination: 'cloud', userConfirmed: true });
  assert.equal(calls[1][0], '/api/perception/captures');
  assert.equal(calls[1][1].body.mimeType, 'image/jpeg');
  assert.equal(calls[1][1].body.imageBase64, 'aW1hZ2U=');
  await assert.rejects(session.attachToNextTurn(false), /确认/);
  await session.attachToNextTurn(true);
  assert.equal(calls[2][0], '/api/perception/attach');
  assert.equal(session.state.phase, 'attached');
  await session.clear();
  assert.deepEqual(calls.slice(3).map(call => call[0]), [
    '/api/perception/grants/grant-1', '/api/perception/observations/obs-1',
  ]);
  assert.equal(session.state.phase, 'idle');
});

test('cancellation revokes a grant that arrives after the user cleared the request', async () => {
  const grantResponse = deferred(), calls = [];
  const client = { request(path, options = {}) {
    calls.push([path, options]);
    if (path.endsWith('/grants')) return grantResponse.promise;
    if (path.endsWith('/captures')) throw new Error('capture should not run after cancellation');
    return Promise.resolve({});
  } };
  const session = createPerceptionSession({ client, encodeFrame: async () => 'aW1hZ2U=' });
  session.state.phase = 'streaming';
  session.state.scopeType = 'screen';
  session.freeze(frame());
  const pending = session.sendToCloud(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][0], '/api/perception/grants');
  await session.clear();
  grantResponse.resolve({ grant: { grantId: 'grant-late' } });
  assert.equal(await pending, null);
  assert.deepEqual(calls.map(call => call[0]), [
    '/api/perception/grants', '/api/perception/grants/grant-late',
  ]);
  assert.equal(session.state.grantId, null);
  assert.equal(session.state.phase, 'idle');
});

test('leaving the page aborts an upload, revokes its grant and clears a late observation', async () => {
  const captureResponse = deferred(), calls = [];
  const client = { request(path, options = {}) {
    calls.push([path, options]);
    if (path.endsWith('/grants')) return Promise.resolve({ grant: { grantId: 'grant-active' } });
    if (path.endsWith('/captures')) return captureResponse.promise;
    return Promise.resolve({});
  } };
  const session = createPerceptionSession({ client, encodeFrame: async () => 'aW1hZ2U=' });
  session.state.phase = 'streaming'; session.state.scopeType = 'window'; session.freeze(frame());
  const pending = session.sendToCloud(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[1][0], '/api/perception/captures');
  await session.leave();
  captureResponse.resolve({ observation: { observationId: 'obs-late' } });
  assert.equal(await pending, null);
  assert.deepEqual(calls.slice(2).map(call => call[0]), [
    '/api/perception/grants/grant-active', '/api/perception/observations/obs-late',
  ]);
  assert.equal(session.state.phase, 'idle');
  assert.equal(session.state.observation, null);
});
