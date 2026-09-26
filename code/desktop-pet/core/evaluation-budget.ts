import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface BudgetEntry {
  operationId: string;
  model: string;
  reservedMicros: number;
  actualMicros: number | null;
  status: 'reserved' | 'settled' | 'unknown';
}
export interface BudgetState {
  batchId: string;
  currency: 'CNY';
  limitMicros: number | null;
  budgetMode?: 'bounded' | 'unlimited';
  blocked: boolean;
  entries: BudgetEntry[];
}
export interface BudgetScopeLimit {
  operationIdPrefix: string;
  limitMicros: number;
  maxCalls: number;
}
/** Explicit evaluation-only accounting. Estimates must be conservative; unknown billed calls retain reservations. */
export class EvaluationBudget {
  constructor(private readonly file: string, private readonly batchId: string, private readonly limitMicros: number | null) {
    if ((limitMicros!==null&&(!Number.isSafeInteger(limitMicros) || limitMicros <= 0)) || !batchId) throw new Error('Explicit batch and valid accounting limit required');
  }
  private async transaction<T>(mutate: (state: BudgetState) => T): Promise<T> {
    await mkdir(dirname(this.file), {recursive: true});
    const lockFile = `${this.file}.lock`;
    // A live or interrupted writer is never silently displaced.
    const lock = await open(lockFile, 'wx');
    try {
      let state: BudgetState;
      try { state = JSON.parse(await readFile(this.file, 'utf8')) as BudgetState; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        state = {batchId: this.batchId, currency: 'CNY', limitMicros: this.limitMicros, ...(this.limitMicros===null?{budgetMode:'unlimited' as const}:{}), blocked: false, entries: []};
      }
      if (state.batchId !== this.batchId || state.limitMicros !== this.limitMicros || state.currency !== 'CNY') throw new Error('Budget batch/configuration mismatch');
      if((state.limitMicros===null)!==(state.budgetMode==='unlimited'))throw new Error('Budget accounting mode mismatch');
      if (!Array.isArray(state.entries) || state.entries.some(e => !Number.isSafeInteger(e.reservedMicros) || e.reservedMicros <= 0 || (e.actualMicros !== null && (!Number.isSafeInteger(e.actualMicros) || e.actualMicros < 0)))) throw new Error('Invalid budget state');
      const result = mutate(state);
      const temporary = `${this.file}.next`;
      const output = await open(temporary, 'w', 0o600);
      try { await output.writeFile(JSON.stringify(state, null, 2) + '\n'); await output.sync(); }
      finally { await output.close(); }
      await rename(temporary, this.file);
      return result;
    } finally { await lock.close(); await unlink(lockFile); }
  }
  async reserve(operationId: string, model: string, upperBoundMicros: number, scope?: BudgetScopeLimit, foregroundHeadroomMicros = 0): Promise<void> {
    if(!Number.isSafeInteger(foregroundHeadroomMicros)||foregroundHeadroomMicros<0)throw new Error('Invalid foreground budget headroom');
    if (!operationId || !model || !Number.isSafeInteger(upperBoundMicros) || upperBoundMicros <= 0) throw new Error('Invalid call reservation');
    if (scope && (!scope.operationIdPrefix || !operationId.startsWith(scope.operationIdPrefix) || !Number.isSafeInteger(scope.limitMicros) || scope.limitMicros <= 0 || !Number.isSafeInteger(scope.maxCalls) || scope.maxCalls <= 0)) throw new Error('Invalid scoped budget configuration');
    await this.transaction(state => {
      if (state.limitMicros!==null&&state.blocked) throw new Error('Budget is blocked pending reconciliation');
      if (state.entries.some(e => e.operationId === operationId)) throw new Error('Call operation already reserved; do not repeat network access');
      if (scope && state.limitMicros!==null) {
        const entries = state.entries.filter(entry => entry.operationId.startsWith(scope.operationIdPrefix));
        if (entries.length >= scope.maxCalls) throw new Error('Phase generation limit reached');
        if (entries.reduce((sum, entry) => sum + (entry.actualMicros ?? entry.reservedMicros), 0) + upperBoundMicros > scope.limitMicros) throw new Error('Phase budget cannot cover the next worst-case call');
      }
      const committed = state.entries.reduce((sum, e) => sum + (e.actualMicros ?? e.reservedMicros), 0);
      if (state.limitMicros!==null&&committed + upperBoundMicros > state.limitMicros) throw new Error('Shared evaluation budget exhausted');
      // A background reservation cannot take funds required by the foreground.
      // Check inside the same ledger lock; refusal adds no charge/reservation.
      if (state.limitMicros!==null&&committed + upperBoundMicros + foregroundHeadroomMicros > state.limitMicros) throw new Error('Background reservation would block foreground');
      state.entries.push({operationId, model, reservedMicros: upperBoundMicros, actualMicros: null, status: 'reserved'});
    });
  }
  async settle(operationId: string, actualMicros: number | null): Promise<void> {
    if (actualMicros !== null && (!Number.isSafeInteger(actualMicros) || actualMicros < 0)) throw new Error('Invalid cost');
    await this.transaction(state => {
      const entry = state.entries.find(e => e.operationId === operationId);
      if (!entry) throw new Error('Unknown reservation');
      if (entry.status === 'settled') {
        if (entry.actualMicros !== actualMicros) throw new Error('Settlement conflict');
        return;
      }
      entry.actualMicros = actualMicros;
      entry.status = actualMicros === null ? 'unknown' : 'settled';
      if (state.limitMicros!==null&&actualMicros !== null && actualMicros > entry.reservedMicros) state.blocked = true;
    });
  }
  async snapshot(): Promise<BudgetState> { return this.transaction(state => structuredClone(state)); }
  /** Imported cumulative provider usage, after an external Harness request. Never presented as its actual bill. */
  async recordExternalEstimate(prefix: string, model: string, upperBoundMicros: number): Promise<void> {
    if (!prefix || !prefix.endsWith(':') || !model || !Number.isSafeInteger(upperBoundMicros) || upperBoundMicros < 0) throw new Error('Invalid external usage estimate');
    await this.transaction(state => {
      const previous = state.entries.filter(entry => entry.operationId.startsWith(prefix));
      if (previous.some(entry => entry.model !== model)) throw new Error('External usage model changed');
      const covered = previous.reduce((sum, entry) => sum + entry.reservedMicros, 0);
      // Out-of-order/repeated snapshots cannot duplicate costs or erase a prior estimate.
      if (upperBoundMicros <= covered) return;
      state.entries.push({ operationId: prefix + upperBoundMicros, model, reservedMicros: upperBoundMicros - covered, actualMicros: null, status: 'unknown' });
    });
  }
}
