import test from 'node:test';
import assert from 'node:assert/strict';
import type { BackendToDesktop } from '../../contracts/desktop-bridge.js';
import type { TtsResult, TurnScope } from '../../contracts/index.js';
import { DesktopDeviceBridge } from '../../app/desktop-device-bridge.js';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav, inspectPcmWav } from '../../media/wav.js';
const scope: TurnScope = { characterId: 'friend', sessionId: 's', turnId: 't', generation: 1 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const at = '2026-09-06T00:00:00Z';
const images=(length=3)=>Array.from({length},()=>({mimeType:'image/jpeg',base64:'AQID'}));
function harness() {
  const sent: BackendToDesktop[] = [], store = new MemoryMediaStore();
  const bridge = new DesktopDeviceBridge(store, message => sent.push(message), 1000);
  return { sent, store, bridge };
}
const lastId = (sent: BackendToDesktop[]) => (sent.at(-1) as { requestId: string }).requestId;
test('capture waits for ready ack and imports bytes into a new local scope', async () => {
  const h = harness(); const ready = h.bridge.capture.start(scope, new AbortController().signal);
  h.bridge.receive({ channel: 'ack', requestId: lastId(h.sent) }); await ready;
  const result = h.bridge.capture.finish(scope);
  h.bridge.receive({ channel: 'capture', requestId: lastId(h.sent), result: { scope, audio: { id: 'remote', mimeType: 'audio/wav', base64: 'AQID' }, images: images(), inputEndedAt: at, captureStoppedAt: at } });
  const captured = await result;
  assert.equal(captured.images.length,3);
  assert.notEqual(captured.audio.id, 'remote'); assert.deepEqual(await h.store.read(scope, captured.audio), Uint8Array.of(1, 2, 3));
  await assert.rejects(h.store.read({ ...scope, characterId: 'sweetheart' }, captured.audio), /unavailable/);
  await h.store.releaseScope(scope); h.bridge.close();
});
test('capture rejects a result for another role and malformed bytes leave no partial media', async () => {
  const h = harness(); const foreign = h.bridge.capture.finish(scope);
  h.bridge.receive({ channel: 'capture', requestId: lastId(h.sent), result: { scope: { ...scope, characterId: 'sweetheart' }, images: [], inputEndedAt: at, captureStoppedAt: at } });
  await assert.rejects(foreign, /scope/);
  const bad = h.bridge.capture.finish(scope);
  h.bridge.receive({ channel: 'capture', requestId: lastId(h.sent), result: { scope, audio: { mimeType: 'audio/wav', base64: 'AQID' }, images: [...images(2),{ mimeType: 'image/png', base64: '**bad**' }], inputEndedAt: at, captureStoppedAt: at } });
  await assert.rejects(bad, /encoding/); assert.equal(h.store.count, 0); h.bridge.close();
});
test('bridge accepts each actual zero-to-three frame count without inventing images',async()=>{
 for(const count of [0,1,2,3]){
  const h=harness(),pending=h.bridge.capture.finish(scope);
  h.bridge.receive({channel:'capture',requestId:lastId(h.sent),result:{scope,audio:{mimeType:'audio/wav',base64:'AQID'},images:images(count),inputEndedAt:at,captureStoppedAt:at}});
  const captured=await pending;assert.equal(captured.images.length,count);assert.equal(h.store.count,count+1);
  assert.deepEqual(await h.store.read(scope,captured.audio),Uint8Array.of(1,2,3));await h.store.releaseScope(scope);h.bridge.close();
 }
});
test('bridge rejects excess and old nine-frame production capture before any media is stored',async()=>{
 for(const count of [4,9]){
  const h=harness(),pending=h.bridge.capture.finish(scope);
  h.bridge.receive({channel:'capture',requestId:lastId(h.sent),result:{scope,audio:{mimeType:'audio/wav',base64:'AQID'},images:images(count),inputEndedAt:at,captureStoppedAt:at}});
  await assert.rejects(pending,/at most three/);assert.equal(h.store.count,0);h.bridge.close();
 }
});
test('play stays pending until actual terminal feedback and transfers bytes without reusing URI', async () => {
  const h = harness(), types: string[] = [];
  const tts: TtsResult = { scope, audio: await h.store.put(scope, Uint8Array.of(4, 5, 6), 'audio/wav'), expression: { emotion: 'calm', intensity: .4, delivery: '', gesture: null }, durationMs: 3, synchronization: 'amplitude' };
  let done = false;
  const play = h.bridge.playback.play(tts, event => types.push(event.type), new AbortController().signal).then(() => { done = true; });
  await tick(); const message = h.sent.at(-1);
  assert.equal(message?.channel, 'play'); if (message?.channel !== 'play') throw Error('Expected play');
  assert.equal(message.audioBase64, 'BAUG'); assert.equal(done, false);
  for (const event of [{ type: 'started', audioId: tts.audio.id, timingBasis: 'audio_output_timestamp' }, { type: 'amplitude', value: .4 }, { type: 'ended' }]) h.bridge.receive({ channel: 'playback', requestId: message.requestId, event: { scope, at, ...event } });
  await play; assert.deepEqual(types, ['started', 'amplitude', 'ended']);
  assert.equal(h.bridge.receive({ channel: 'playback', requestId: message.requestId, event: { scope, at, type: 'amplitude', value: 1 } }), false);
  await h.store.releaseScope(scope); h.bridge.close();
});
test('cancel rejects pending permission without waiting for a late ack', async () => {
  const h = harness(), controller = new AbortController();
  const start = h.bridge.capture.start(scope, controller.signal), id = lastId(h.sent);
  controller.abort(); await assert.rejects(start, { name: 'AbortError' });
  assert.equal(h.bridge.receive({ channel: 'ack', requestId: id }), false);
  const stop = h.bridge.capture.stop(scope); h.bridge.receive({ channel: 'ack', requestId: lastId(h.sent) }); await stop; h.bridge.close();
});
test('EOF rejects pending devices and later requests cannot be sent', async () => {
  const h = harness(); const start = h.bridge.capture.start(scope, new AbortController().signal); h.bridge.close();
  await assert.rejects(start, /closed/); await assert.rejects(h.bridge.capture.finish(scope), /closed/);
  assert.equal(h.sent.length, 1);
});


test('capture bridge sends start immediately, waits for actual readiness and preserves first and final PCM across transfer', async () => {
  const h = harness(), controller = new AbortController();
  try {
    let ready = false;
    const pendingStart = h.bridge.capture.start(scope, controller.signal).then(() => { ready = true; });
    assert.equal(h.sent.length, 1, 'start is emitted synchronously without a timer');
    assert.equal(h.sent[0]?.channel, 'capture_start');
    await tick(); assert.equal(ready, false, 'a queued device request is not recording readiness');
    h.bridge.receive({ channel: 'ack', requestId: lastId(h.sent) }); await pendingStart;
    const pcm = new Float32Array(2051); pcm[0] = .5; pcm[127] = -.25; pcm[2047] = .125; pcm[2050] = -.5;
    const original = pcm16Wav(pcm, 24000), expected = original.slice();
    const pendingCapture = h.bridge.capture.finish(scope);
    h.bridge.receive({ channel: 'capture', requestId: lastId(h.sent), result: {
      scope, audio: { mimeType: 'audio/wav', base64: Buffer.from(original).toString('base64') },
      images: [], inputEndedAt: at, captureStoppedAt: at,
    } });
    const captured = await pendingCapture; original.fill(0);
    const actual = await h.store.read(scope, captured.audio);
    assert.deepEqual(actual, expected, 'clearing transfer buffers cannot erase first block or final partial block');
    assert.equal(inspectPcmWav(actual).data.length, 2051 * 2); assert.equal(captured.images.length, 0);
  } finally { controller.abort(); await h.store.releaseScope(scope); h.bridge.close(); }
});
