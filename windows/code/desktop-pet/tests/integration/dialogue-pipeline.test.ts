import test from 'node:test';
import assert from 'node:assert/strict';
import { DialoguePipeline, type DialoguePorts } from '../../core/dialogue-pipeline.js';
import { TurnController } from '../../core/turn-controller.js';
import type { DesktopEvent, TurnScope } from '../../contracts/index.js';
function fixture() {
  const controller = new TurnController();
  const turn = controller.begin('text', 'hello');
  const released: TurnScope[] = []; const calls: string[] = []; const events: DesktopEvent[] = [];
  const expression = {emotion: 'calm', intensity: .4, delivery: 'gentle', gesture: null};
  const ports: DialoguePorts = {
    perception: {async perceive(input) { calls.push('perception'); return {scope: input.scope, transcript: 'hi', modalities: [], cues: [], status: 'complete'}; }},
    dialogue: {async reply(input) { calls.push('reply'); return {scope: input.scope, text: 'a complete reply', expression}; }},
    tts: {async synthesize(input) { calls.push('tts'); return {scope: input.scope, expression, audio: {id: 'a', uri: 'memory:a', temporary: true, mimeType: 'audio/wav'}, durationMs: 100, synchronization: 'amplitude'}; }},
    playback: {async play(input, emit) {
      calls.push('play'); emit({scope: input.scope, type: 'started', audioId: 'a', at: new Date().toISOString()});
      emit({scope: input.scope, type: 'amplitude', value: .5, at: new Date().toISOString()});
      emit({scope: input.scope, type: 'ended', at: new Date().toISOString()});
    }, async stop() {}},
    memory: {async context(scope) { calls.push('context'); return {scope, characterPrompt: 'friend', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 4000}; }, async append() { calls.push('append'); }, async maintain() { return []; }},
    mediaStore: {async put() { throw new Error('unused'); }, async read() { return new Uint8Array(); }, async releaseScope(scope) {released.push(scope);} }
  };
  const pipeline = new DialoguePipeline(ports, controller, e => events.push(e));
  return {pipeline, controller, turn, ports, released, calls, events};
}
test('text automatically routes through context, reply, TTS, actual playback and cleanup without perception', async () => {
  const f = fixture(); assert.deepEqual(await f.pipeline.run(f.turn.input, f.turn.signal), {status: 'played'});
  assert.deepEqual(f.calls, ['append', 'context', 'reply', 'append', 'tts', 'play']);
  assert.deepEqual(f.released, [f.turn.input.scope]);
  assert.equal(f.controller.snapshot()?.mouth, 0);
  assert.equal(f.events.some(e => e.type === 'presentation' && e.presentation.state === 'speaking' && e.presentation.mouth > 0), true);
});
test('cancellation during TTS discards late audio and releases original scope', async () => {
  const f = fixture(); const original = f.ports.tts.synthesize;
  f.ports.tts.synthesize = async (req, signal) => { f.controller.begin('text', 'new'); return original(req, signal); };
  assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'cancelled');
  assert.equal(f.calls.includes('play'), false);
  assert.deepEqual(f.released, [f.turn.input.scope]);
});
test('cross-character context is rejected before it reaches a model', async () => {
  const f = fixture(); const original = f.ports.memory.context;
  f.ports.memory.context = async (...args) => ({...await original(...args), memories: [{characterId: 'sweetheart', id: 'private', version: 1, text: 'other character', sourceIds: []}]});
  assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'failed');
  assert.equal(f.calls.includes('reply'), false);
  assert.equal(f.released.length, 1);
});
test('provider scope mismatch cannot play or write a reply into the current character', async () => {
  const f = fixture(); const original = f.ports.dialogue.reply;
  f.ports.dialogue.reply = async (...args) => ({...await original(...args), scope: {...f.turn.input.scope, characterId: 'sweetheart'}});
  assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'failed');
  assert.equal(f.calls.includes('tts'), false);
  assert.equal(f.calls.filter(v => v === 'append').length, 1);
});
test('resolving play without actual started/ended is a failure, not acceptance', async () => {
  const f = fixture(); f.ports.playback.play = async () => {};
  assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'failed');
  assert.equal(f.controller.snapshot()?.mouth, 0);
});
test('device playback errors remain failed rather than cancelled', async () => {
  const f = fixture(); f.ports.playback.play = async (input, emit) => {emit({scope: input.scope, type: 'error', message: 'device unavailable', at: new Date().toISOString()});};
  assert.deepEqual(await f.pipeline.run(f.turn.input, f.turn.signal), {status: 'failed', error: 'device unavailable'});
});
test('failed temporary media cleanup does not report a successful turn', async () => {
  const f = fixture(); f.ports.mediaStore.releaseScope = async () => {throw new Error('busy');};
  assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'failed');
  assert.equal(f.events.some(e => e.type === 'error' && e.message === '这一轮没有完成，请稍后再试。'), true);
  assert.equal(f.events.some(e => e.type === 'error' && e.message.includes('cleanup')), false);
});
test('text with unexpected captured media fails and cleans the scope', async () => {
  const f = fixture();
  const result = await f.pipeline.run(f.turn.input, f.turn.signal, {scope: f.turn.input.scope, audio: {id: 'unexpected', uri: 'memory:unexpected', mimeType: 'audio/wav', temporary: true}, images: [], inputEndedAt: '', captureStoppedAt: ''});
  assert.equal(result.status, 'failed'); assert.deepEqual(f.calls, []); assert.equal(f.released.length, 1);
});

test('actual recognized voice text is emitted with full scope before memory work; UI placeholders never persist', async () => {
  const f = fixture(); const turn = f.controller.begin('voice');
  const text = '这是这轮真正识别到的文字 <b>不解释成HTML</b>';
  f.ports.perception.perceive = async input => ({ scope: input.scope, transcript: text, modalities: [], cues: [], status: 'complete' });
  const appended: string[] = [];
  f.ports.memory.append = async (_scope, messages) => {
    if (messages[0]?.role === 'user') assert.deepEqual(f.events.find(e => e.type === 'transcript'), { type: 'transcript', scope: turn.input.scope, text });
    appended.push(...messages.map(m => m.text));
  };
  const captured = { scope: turn.input.scope, audio: { id: 'voice', uri: 'memory:voice', mimeType: 'audio/wav', temporary: true as const }, images: [], inputEndedAt: '', captureStoppedAt: '' };
  assert.equal((await f.pipeline.run(turn.input, turn.signal, captured)).status, 'played');
  assert.equal(f.events.filter(e => e.type === 'transcript').length, 1);
  assert.deepEqual(appended, [text, 'a complete reply']);
});

test('cancelled, wrong-scope, or failed perception cannot emit transcript or append user text', async () => {
  for (const kind of ['cancelled','wrong-scope','failed'] as const) {
    const f = fixture(); const turn = f.controller.begin('voice');
    f.ports.perception.perceive = async input => {
      if (kind === 'cancelled') f.controller.begin('text','new turn');
      return { scope: kind === 'wrong-scope' ? {...input.scope, generation: input.scope.generation + 1} : input.scope,
        transcript: '不应显示或写入', modalities: [], cues: [], status: kind === 'failed' ? 'failed' : 'complete' };
    };
    const captured = { scope: turn.input.scope, audio: { id: 'voice', uri: 'memory:voice', mimeType: 'audio/wav', temporary: true as const }, images: [], inputEndedAt: '', captureStoppedAt: '' };
    assert.equal((await f.pipeline.run(turn.input, turn.signal, captured)).status, kind === 'cancelled' ? 'cancelled' : 'failed');
    assert.equal(f.events.some(e => e.type === 'transcript'), false);
    assert.equal(f.calls.includes('append'), false);
  }
});

test('trusted text channel completes a real saved reply without TTS, playback or speaking presentation',async()=>{
 const f=fixture();f.ports.outputMode='text';assert.deepEqual(await f.pipeline.run(f.turn.input,f.turn.signal),{status:'replied'});
 assert.deepEqual(f.calls,['append','context','reply','append']);assert.equal(f.events.some(e=>e.type==='playback'||e.type==='presentation'&&e.presentation.state==='speaking'),false);
 assert.equal(f.events.filter(e=>e.type==='reply').length,1);assert.deepEqual(f.released,[f.turn.input.scope]);
});
