import test from 'node:test';
import assert from 'node:assert/strict';
import type { CharacterId, MemoryMaintenanceInput, MemoryPort, TurnScope } from '../../contracts/index.js';
import { RoleMaintenanceQueue } from '../../core/maintenance-queue.js';
const scope = (characterId: CharacterId, turnId: string): TurnScope => ({ characterId, turnId, sessionId: 's', generation: 1 });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function port(maintain: MemoryPort['maintain']): MemoryPort { return { maintain, async append() {}, async context() { throw new Error('Unused'); } }; }
function input(s: TurnScope): MemoryMaintenanceInput { return { scope: s, messages: [], relevantMemories: [] }; }

test('maintenance serializes each role, rereads at execution, and preserves original role across frontend activity', async () => {
  let finish!: () => void, revision = 1;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const calls: string[] = [], reads: string[] = [];
  const q = new RoleMaintenanceQueue(port(async (i, signal) => { calls.push(i.scope.characterId + ':' + i.scope.turnId); assert.equal(signal.aborted, false); if (i.scope.turnId === 'one') await gate; return []; }), s => { reads.push(`${s.turnId}:${revision}`); return input(s); }, () => assert.fail('unexpected maintenance failure'));
  q.enqueue(scope('friend', 'one'), 'first'); q.enqueue(scope('friend', 'two'), 'second'); q.enqueue(scope('sweetheart', 'three'), 'third');
  await tick(); assert.deepEqual(calls, ['friend:one', 'sweetheart:three']); assert.deepEqual(reads, ['one:1', 'three:1']);
  revision = 2; finish(); await q.drain(); assert.equal(reads.at(-1), 'two:2'); assert.equal(calls.at(-1), 'friend:two');
});

test('failed maintenance cannot poison later work and mismatched role data never reaches the writer', async () => {
  const failures: string[] = [], calls: string[] = [];
  const q = new RoleMaintenanceQueue(port(async i => { calls.push(i.scope.turnId); return []; }), s => s.turnId === 'bad' ? { ...input(s), messages: [{ characterId: 'sweetheart', id: 'x', role: 'user', text: 'private', createdAt: '2026-09-06T00:00:00Z' }] } : input(s), s => failures.push(s.turnId));
  q.enqueue(scope('friend', 'bad'), ''); q.enqueue(scope('friend', 'good'), ''); await q.drain();
  assert.deepEqual(failures, ['bad']); assert.deepEqual(calls, ['good']);
});

test('closing cancels in-flight maintenance and never starts the pending role job', async () => {
  const calls: string[] = [];
  const q = new RoleMaintenanceQueue(port(async (i, signal) => { calls.push(i.scope.turnId); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return []; }), input, () => assert.fail('shutdown is not a provider error'));
  q.enqueue(scope('friend', 'one'), ''); q.enqueue(scope('friend', 'two'), ''); await tick(); await q.close();
  assert.deepEqual(calls, ['one']); q.enqueue(scope('friend', 'three'), ''); await q.drain(); assert.deepEqual(calls, ['one']);
});
