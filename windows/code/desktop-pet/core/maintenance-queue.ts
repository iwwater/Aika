import type { CharacterId, MemoryMaintenanceInput, MemoryPort, TurnScope } from '../contracts/index.js';

/** One serial queue per role. Frontend turn aborts never become background lifetime signals. */
export class RoleMaintenanceQueue {
  private readonly queues = new Map<CharacterId, Promise<void>>();
  private readonly lifetime = new AbortController();
  constructor(
    private readonly memory: MemoryPort,
    private readonly loadInput: (scope: TurnScope, text: string) => MemoryMaintenanceInput | Promise<MemoryMaintenanceInput>,
    private readonly reportFailure: (scope: TurnScope, error: unknown) => void,
  ) {}
  enqueue(scope: TurnScope, text: string): void {
    if (this.lifetime.signal.aborted) return;
    const originalScope = Object.freeze({ ...scope });
    const previous = this.queues.get(scope.characterId) ?? Promise.resolve();
    const next = previous.then(async () => {
      this.lifetime.signal.throwIfAborted();
      // Read current records only when this job starts, avoiding stale queued content snapshots.
      const input = await this.loadInput(originalScope, text);
      if (input.scope.characterId !== originalScope.characterId || input.scope.sessionId !== originalScope.sessionId || input.scope.turnId !== originalScope.turnId || input.scope.generation !== originalScope.generation) throw new Error('Maintenance input scope changed');
      if (input.messages.some(m => m.characterId !== originalScope.characterId) || input.relevantMemories.some(m => m.characterId !== originalScope.characterId)) throw new Error('Maintenance input contains another character');
      this.lifetime.signal.throwIfAborted();
      await this.memory.maintain(input, this.lifetime.signal);
    }).catch(error => { if (!this.lifetime.signal.aborted) this.reportFailure(originalScope, error); });
    this.queues.set(scope.characterId, next);
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.queues.values()]); }
  async close(): Promise<void> { this.lifetime.abort(); await this.drain(); }
}
