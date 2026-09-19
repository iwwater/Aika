import test from 'node:test';
import assert from 'node:assert/strict';
import type { DesktopEvent, DialogueReply, TurnScope } from '../../contracts/index.js';
import { DesktopRuntime, type RuntimePorts } from '../../core/desktop-runtime.js';
import { MemoryMediaStore } from '../../media/store.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function harness() {
  const events: DesktopEvent[] = [], scopes: TurnScope[] = [], played: string[] = [];
  let starts = 0, finishes = 0;
  const mediaStore = new MemoryMediaStore();
  const ports: RuntimePorts = {
    mediaStore,
    capture: {
      async start() { starts++; }, async stop() {},
      async finish(scope) { finishes++; return { scope, audio: await mediaStore.put(scope, Uint8Array.of(1), 'audio/wav'), images: [], inputEndedAt: new Date().toISOString(), captureStoppedAt: new Date().toISOString() }; },
    },
    perception: { async perceive(input) { return { scope: input.scope, transcript: '语音输入', modalities: [], cues: [], status: 'complete' }; } },
    memory: { async append() {}, async maintain() { return []; }, async context(scope) { return { scope, characterPrompt: scope.characterId, recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 1000 }; } },
    dialogue: { async reply(request) { scopes.push(request.scope); return { scope: request.scope, text: '收到', expression: { emotion: 'calm', intensity: .4, delivery: '自然', gesture: null } }; } },
    tts: { async synthesize(input) { return { ...input, audio: await mediaStore.put(input.scope, Uint8Array.of(1), 'audio/wav'), durationMs: 1, synchronization: 'amplitude' }; } },
    playback: { async stop() {}, async play(input, emit) { played.push(input.scope.characterId); emit({ scope: input.scope, at: new Date().toISOString(), type: 'started', audioId: input.audio.id, timingBasis: 'device_observed' }); emit({ scope: input.scope, at: new Date().toISOString(), type: 'ended' }); } },
  };
  const saved: TurnScope[] = [];
  const runtime = new DesktopRuntime(ports, event => events.push(event), scope => saved.push(scope));
  return { runtime, ports, events, scopes, played, saved, mediaStore, counts: () => ({ starts, finishes }) };
}

test('desktop text command automatically speaks without acquiring either capture device', async () => {
  const h = harness(); await h.runtime.dispatch({ type: 'submit_text', text: '你好' }); await h.runtime.drain();
  assert.deepEqual(h.counts(), { starts: 0, finishes: 0 }); assert.deepEqual(h.played, ['companion']);
  assert.equal(h.mediaStore.count, 0); assert.equal(h.saved[0]?.characterId, 'companion');
});

test('permission wait never blocks cancel and late permission cannot start the cancelled turn', async () => {
  const h = harness(), ready = deferred<void>(); let stopped = false;
  h.ports.capture.start = async () => ready.promise;
  h.ports.capture.stop = async () => { stopped = true; };
  await h.runtime.dispatch({ type: 'start_voice' });
  await h.runtime.dispatch({ type: 'finish_voice' });
  await h.runtime.dispatch({ type: 'cancel' }); assert.equal(stopped, true);
  ready.resolve(); await h.runtime.drain();
  assert.equal(h.counts().finishes, 0); assert.deepEqual(h.played, []);
});

test('audio-only partial perception emits unchanged transcript and duplicate finish still submits once', async () => {
  const h = harness();
  h.ports.perception.perceive = async input => {
    assert.equal(input.images.length, 0);
    return { scope: input.scope, transcript: '下午好啊', emotion: 'happy', cues: [], status: 'partial', modalities: [
      { modality: 'audio', status: 'used', inputIds: [input.audio.id], detail: 'Synthetic pipeline input' },
      { modality: 'image', status: 'missing', inputIds: [], detail: 'No camera frame available at release' },
    ] };
  };
  const reply = h.ports.dialogue.reply;
  h.ports.dialogue.reply = (request, signal) => { assert.equal(request.text, '下午好啊'); return reply(request, signal); };
  await h.runtime.dispatch({ type: 'start_voice' });
  await Promise.all([h.runtime.dispatch({ type: 'finish_voice' }), h.runtime.dispatch({ type: 'finish_voice' })]);
  await h.runtime.drain(); assert.deepEqual(h.counts(), { starts: 1, finishes: 1 }); assert.equal(h.played.length, 1);
  assert.deepEqual(h.events.filter(e => e.type === 'transcript').map(e => e.text), ['下午好啊']);
  assert.equal(h.events.some(e => e.type === 'error'), false); assert.equal(h.mediaStore.count, 0);
});

test('replacement turn while old model result is pending prevents late TTS', async () => {
  const h = harness(), pending = deferred<DialogueReply>();
  const normal = h.ports.dialogue.reply;
  h.ports.dialogue.reply = (request, signal) => request.text === 'old' ? pending.promise : normal(request, signal);
  await h.runtime.dispatch({ type: 'submit_text', text: 'old' }); await tick();
  const old = h.events.find((e): e is Extract<DesktopEvent, { type: 'turn' }> => e.type === 'turn')!.input.scope;
  await h.runtime.dispatch({ type: 'submit_text', text: 'new' });
  pending.resolve({ scope: old, text: 'late', expression: { emotion: 'calm', intensity: .2, delivery: '', gesture: null } });
  await h.runtime.drain(); assert.deepEqual(h.played, ['companion']); assert.equal(h.mediaStore.count, 0);
});

test('capture failure is reported and later text input remains usable', async () => {
  const h = harness(); h.ports.capture.start = async () => { throw new Error('Microphone permission denied'); };
  await h.runtime.dispatch({ type: 'start_voice' }); await h.runtime.drain();
  assert.ok(h.events.some(e => e.type === 'error' && e.message === 'Microphone permission denied'));
  await h.runtime.dispatch({ type: 'submit_text', text: '继续' }); await h.runtime.drain(); assert.equal(h.played.length, 1);
  await h.runtime.close(); await assert.rejects(h.runtime.dispatch({ type: 'start_voice' }), /closed/);
});

test('cleanup failure blocks replacement turn and a later cancel can recover', async () => {
  const h = harness(); await h.runtime.dispatch({ type: 'start_voice' });
  h.ports.playback.stop = async () => { throw new Error('stop failed'); };
  await assert.rejects(h.runtime.dispatch({ type: 'submit_text', text: 'unsafe replacement' }), /cleanup/);
  assert.equal(h.events.filter(e => e.type === 'turn').length, 1);
  await assert.rejects(h.runtime.dispatch({ type: 'cancel' }), /cleanup/);
  h.ports.playback.stop = async () => {};
  await h.runtime.dispatch({ type: 'cancel' }); await h.runtime.drain();
});

test('voice cancel and immediate retry preserve distinct client intent and emit turn before capture request', async () => {
  const h = harness(); const pending = deferred<void>(); const starts: string[] = [];
  h.ports.capture.start = async scope => {
    const event = h.events.find((e): e is Extract<DesktopEvent,{type:'turn'}> => e.type === 'turn' && e.input.scope.turnId === scope.turnId);
    assert.ok(event, 'the matching turn must be emitted before capture starts');
    starts.push(event.input.clientRequestId!);
    if (starts.length === 1) await pending.promise;
  };
  const first = h.runtime.dispatch({type:'start_voice',clientRequestId:'voice-first'});
  const cancel = h.runtime.dispatch({type:'cancel'});
  const retry = h.runtime.dispatch({type:'start_voice',clientRequestId:'voice-retry'});
  await Promise.all([first,cancel,retry]);
  const turns = h.events.filter((e):e is Extract<DesktopEvent,{type:'turn'}> => e.type === 'turn');
  assert.deepEqual(turns.map(e=>e.input.clientRequestId), ['voice-first','voice-retry']);
  assert.deepEqual(starts,['voice-first','voice-retry']);
  assert.notEqual(turns[0]!.input.scope.turnId, turns[1]!.input.scope.turnId);
  assert.ok(h.events.some(e=>e.type==='presentation' && e.presentation.scope.turnId===turns[0]!.input.scope.turnId && e.presentation.state==='idle'));
  pending.resolve(); await h.runtime.dispatch({type:'finish_voice'}); await h.runtime.drain();
  assert.equal(h.counts().finishes, 1); assert.equal(h.scopes[0]?.turnId, turns[1]!.input.scope.turnId);
});
