import { isProductCharacter, type CharacterId, type TurnScope } from '../contracts/index.js';

export class MemoryRuleError extends Error {}

export function assertCharacter(value: CharacterId): void {
  if (!isProductCharacter(value)) throw new MemoryRuleError('unknown_character');
}

export function bindScope(scope: TurnScope, characterId: CharacterId): TurnScope {
  assertCharacter(characterId);
  if (scope.characterId !== characterId) throw new MemoryRuleError('character_mismatch');
  if (!scope.sessionId || !scope.turnId || !Number.isSafeInteger(scope.generation) || scope.generation < 0) {
    throw new MemoryRuleError('invalid_scope');
  }
  return Object.freeze({ characterId, sessionId: scope.sessionId, turnId: scope.turnId, generation: scope.generation });
}

export function sameScope(a: TurnScope, b: TurnScope): boolean {
  return a.characterId === b.characterId && a.sessionId === b.sessionId && a.turnId === b.turnId && a.generation === b.generation;
}

export function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new MemoryRuleError('invalid_timestamp');
  return parsed;
}
