import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleMemoryLedger } from '../../memory/ledger.js';
import { QwenMemoryMaintenanceProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';
import { MemoryMediaStore } from '../../media/store.js';
import { TurnPlayback } from '../../media/playback.js';
import { pcm16Wav } from '../../media/wav.js';
import { TurnController } from '../../core/turn-controller.js';
import { DialoguePipeline } from '../../core/dialogue-pipeline.js';

const at = '2026-09-06T10:00:00Z';
test('integrated maintenance adapter and ledger update a surviving memory after its transcript expires', async () => {
  const scope = {characterId: 'companion' as const, sessionId: 's', turnId: 't', generation: 1};
  const ledger = new RoleMemoryLedger('companion');
  ledger.append(scope, [{characterId: 'companion', id: 'source', role: 'user', text: 'I like tea', createdAt: at}]);
  ledger.apply({scope, operationId: 'initial', reason: 'remember', createdAt: at, operation: {type: 'add', id: 'm', text: 'likes tea', sourceIds: ['source']}}, at);
  ledger.expireTranscripts(scope, ['source']);
  const ticket = ledger.captureMaintenance(scope);
  const transport = new ProviderTransport((async () => new Response(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({changes: [{reason: 'merge description based on existing memory', operation: {type: 'update', id: 'm', expectedVersion: 1, text: 'Enjoys drinking tea', sourceIds: ['m']}}]})}}]}), {status: 200})) as typeof fetch);
  const provider = new QwenMemoryMaintenanceProvider({endpoint: 'https://provider.invalid/test', model: 'test-only', apiKey: () => 'synthetic-key', authorizer: {async authorize() {return {async settle() {}};}}}, transport);
  const changes = await provider.propose(ticket.input, new AbortController().signal);
  const results = ledger.completeMaintenance(ticket, changes, at);
  assert.equal(results[0]?.status, 'applied');
  assert.equal(ledger.contextRecords(scope).recent.length, 0);
  assert.equal(ledger.contextRecords(scope).memories[0]?.text, 'Enjoys drinking tea');
  assert.equal(ledger.inspect(scope, 'source')?.message, null);
});
test('integrated dialogue and media playback complete normally and release the actual media store', async () => {
  const controller = new TurnController(), store = new MemoryMediaStore();
  const turn = controller.begin('text', 'hello');
  const expression = {emotion: 'calm', intensity: .5, delivery: 'gentle', gesture: null};
  const playback = new TurnPlayback({async open(_bytes, audioId, emit) {
    emit({type: 'started', at, audioId}); emit({type: 'amplitude', at, value: .5}); emit({type: 'ended', at});
    return {done: Promise.resolve(), stop() {}};
  }}, store);
  const pipeline = new DialoguePipeline({
    mediaStore: store, playback,
    perception: {async perceive() {throw new Error('Text cannot capture');}},
    memory: {async append() {}, async context(scope) {return {scope, characterPrompt: 'companion', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 1000};}, async maintain() {return [];}},
    dialogue: {async reply(input) {return {scope: input.scope, text: 'hello back', expression};}},
    tts: {async synthesize(input) {const audio = await store.put(input.scope, pcm16Wav(new Float32Array([0,.2,-.2,0]),24000), 'audio/wav'); return {scope: input.scope, audio, expression, durationMs: null, synchronization: 'amplitude'};}}
  }, controller, () => {});
  assert.equal((await pipeline.run(turn.input, turn.signal)).status, 'played');
  assert.equal(store.count, 0);
  assert.equal(controller.snapshot()?.mouth, 0);
});
