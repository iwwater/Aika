import type { TurnScope } from '../contracts/index.js';

export function scopeKey(scope: TurnScope): string {
  return JSON.stringify([scope.characterId, scope.sessionId, scope.turnId, scope.generation]);
}
export function assertScope(expected: TurnScope, actual: TurnScope): void {
  if (scopeKey(expected) !== scopeKey(actual)) throw new Error('Media belongs to a different turn');
}
export function abortError(): DOMException { return new DOMException('Turn cancelled', 'AbortError'); }
export function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }
/** Cancellation releases the caller immediately; the owner must dispose late resources. */
export async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  let cancel: () => void = () => {};
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      cancel = () => reject(abortError());
      signal.addEventListener('abort', cancel, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', cancel); }
}
