import test from 'node:test';
import assert from 'node:assert/strict';
import { DialoguePipeline, type DialoguePorts } from '../../core/dialogue-pipeline.js';
import { TurnController } from '../../core/turn-controller.js';
import type { ConversationMessage, DesktopEvent, DialogueRequest } from '../../contracts/index.js';
import type { MemoryTurnOutcome } from '../../contracts/memory-lifecycle.js';
function fixture() {
  const controller = new TurnController(), turn = controller.begin('text', '忘记那件事');
  const calls: string[] = [], events: DesktopEvent[] = [], saved: ConversationMessage[] = [];
  let stale = false, lastRequest: DialogueRequest | undefined;
  const outcome: MemoryTurnOutcome = { scope: turn.input.scope, request: 'forget', status: 'applied', results: [], affectedIds: ['raw'], retrievalInvalidated: true, clarification: null };
  const ports: DialoguePorts = {
    memory: { async append(_scope, messages) { calls.push('append'); saved.push(...messages); }, async context(scope) { calls.push('context'); return { scope, characterPrompt: 'friend', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 10000 }; }, async maintain() { throw new Error('duplicate maintenance'); } },
    memoryLifecycle: { async prepareTurn() { calls.push('prepare'); return outcome; }, assertContextCurrent() { if (stale) throw new Error('stale context'); }, async appendAssistant(_scope, message, context, currentId, signal) { signal.throwIfAborted(); if (stale) throw new Error('stale context'); assert.equal(currentId, saved[0]?.id); assert.equal(context.scope.turnId, turn.input.scope.turnId); calls.push('appendAssistant'); saved.push(message); } },
    perception: { async perceive() { throw new Error('text must not capture'); } },
    dialogue: { async reply(request) { calls.push('reply'); lastRequest = request; return { scope: request.scope, text: '已经处理好了。', expression: { emotion: 'calm', intensity: .2, delivery: 'gentle', gesture: null } }; } },
    tts: { async synthesize(reply) { calls.push('tts'); return { scope: reply.scope, audio: { id: 'a', uri: 'ephemeral:a', mimeType: 'audio/wav', temporary: true }, expression: reply.expression, durationMs: 100, synchronization: 'amplitude' }; } },
    playback: { async play(audio, emit) { calls.push('play'); emit({ scope: audio.scope, type: 'started', at: new Date().toISOString(), audioId: 'a' }); emit({ scope: audio.scope, type: 'ended', at: new Date().toISOString() }); }, async stop() { calls.push('stop'); } },
    mediaStore: { async put() { throw new Error('unused'); }, async read() { throw new Error('unused'); }, async releaseScope() { calls.push('release'); } },
  };
  return { controller, turn, calls, events, saved, outcome, ports, invalidate: () => { stale = true; }, request: () => lastRequest, pipeline: new DialoguePipeline(ports, controller, e => events.push(e)) };
}
test('memory commits before context and reply; actual outcome is passed without a duplicate maintenance call', async () => {
  const f = fixture(); assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'played');
  assert.deepEqual(f.calls, ['append', 'prepare', 'context', 'reply', 'appendAssistant', 'tts', 'play', 'release']);
  assert.equal(f.request()?.memoryOutcome?.status, 'applied');
});
test('rejected or incomplete mutation cannot yield an acknowledgement, saved assistant response or audio', async () => {
  for (const bad of [{ status: 'rejected' as const }, { retrievalInvalidated: false }, { status: 'unchanged' as const }]) {
    const f = fixture(); f.ports.memoryLifecycle!.prepareTurn = async () => ({ ...f.outcome, ...bad });
    assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'failed');
    assert.equal(f.saved.length, 1); assert.equal(f.calls.includes('reply'), false); assert.equal(f.calls.includes('tts'), false);
  }
});
test('ambiguous target speaks the resolver clarification and skips the dialogue model', async () => {
  const f = fixture(); f.ports.memoryLifecycle!.prepareTurn = async () => ({ ...f.outcome, status: 'needs_clarification', results: [], affectedIds: [], retrievalInvalidated: false, clarification: '你想忘记哪一件事？' });
  assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'played');
  assert.equal(f.calls.includes('reply'), false); assert.equal(f.saved[1]?.text, '你想忘记哪一件事？');
});
test('a wrong-role preparation result stops before context or provider work', async () => {
  const f = fixture(); f.ports.memoryLifecycle!.prepareTurn = async () => ({ ...f.outcome, scope: { ...f.outcome.scope, characterId: 'sweetheart' } });
  assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'failed'); assert.deepEqual(f.calls, ['append', 'release']);
});
test('invalidated sources during dialogue discard its old answer before saving or exposing it', async () => {
  const f = fixture(), original = f.ports.dialogue.reply;
  f.ports.dialogue.reply = async (...args) => { const reply = await original(...args); f.invalidate(); return reply; };
  assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'failed');
  assert.equal(f.saved.length, 1); assert.equal(f.events.some(e => e.type === 'reply'), false); assert.equal(f.calls.includes('tts'), false);
});
test('invalidated sources during synthesis release the generated audio without playing it', async () => {
  const f = fixture(), original = f.ports.tts.synthesize;
  f.ports.tts.synthesize = async (...args) => { const audio = await original(...args); f.invalidate(); return audio; };
  assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'failed'); assert.equal(f.calls.includes('play'), false); assert.equal(f.calls.at(-1), 'release');
});
test('source invalidation during playback requests a device stop and suppresses further mouth events', async () => {
  const f = fixture(); f.ports.playback.play = async (audio, emit) => {
    emit({ scope: audio.scope, type: 'started', audioId: 'a', at: new Date().toISOString() }); f.invalidate();
    emit({ scope: audio.scope, type: 'amplitude', value: .7, at: new Date().toISOString() });
    emit({ scope: audio.scope, type: 'stopped', at: new Date().toISOString() });
  };
  assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'failed'); assert.equal(f.calls.filter(x => x === 'stop').length, 1);
  assert.equal(f.events.some(e => e.type === 'playback' && e.playback.type === 'amplitude'), false);
});

test('assistant provenance rejection prevents saving, exposing and synthesizing an otherwise valid reply', async () => {
  const f = fixture();
  f.ports.memoryLifecycle!.appendAssistant = async () => { throw new Error('stale_issued_context'); };
  assert.equal((await f.pipeline.run(f.turn.input, f.turn.signal)).status, 'failed');
  assert.equal(f.saved.length, 1);
  assert.equal(f.events.some(event => event.type === 'reply'), false);
  assert.equal(f.calls.includes('tts'), false);
});
