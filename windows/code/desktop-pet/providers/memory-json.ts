import type { MemoryChange, MemoryMaintenanceInput, MemoryOperation } from '../contracts/index.js';
import { type JsonRecord, object, string } from './transport.js';

export function completedText(raw: JsonRecord): string {
  if (!Array.isArray(raw.choices) || raw.choices.length !== 1) throw new Error('Missing model choice');
  const choice = object(raw.choices[0]);
  if (choice.finish_reason !== 'stop') throw new Error('Model reply was not completed normally');
  return string(object(choice.message).content);
}
export function assertRoleInput(input: MemoryMaintenanceInput): void {
  if (input.messages.some(message => message.characterId !== input.scope.characterId) || input.relevantMemories.some(memory => memory.characterId !== input.scope.characterId)) throw new Error('Cross-character model context refused');
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Expected string array');
  return value as string[];
}

export function exactFields(value: JsonRecord, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new Error('Invalid memory JSON fields');
}
export function nonempty(value: unknown): string {
  const result = string(value);
  if (!result.trim()) throw new Error('Memory field must not be empty');
  return result;
}

export function parseMemoryChanges(rawChanges: unknown, input: MemoryMaintenanceInput, allowedSources?: ReadonlySet<string>): readonly MemoryChange[] {
    if (!Array.isArray(rawChanges)) throw new Error('Missing memory change array');
    const known = new Map(input.relevantMemories.map(memory => [memory.id, memory]));
    const sources = allowedSources ?? new Set([...input.messages.map(message => message.id), ...input.relevantMemories.map(memory => memory.id)]);
    const sourceIds = (value: unknown) => { const ids = strings(value); if (!ids.length || ids.some(id => !sources.has(id))) throw new Error('Memory cites an unavailable source'); return ids; };
    const target = (value: JsonRecord) => {
      const id = string(value.id), memory = known.get(id);
      if (!memory || !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1 || value.expectedVersion !== memory.version) throw new Error('Memory target/version not in this character context');
      return { id, expectedVersion: memory.version };
    };
    return rawChanges.map((rawChange, index) => {
      const change = object(rawChange); exactFields(change, ['reason', 'operation']);
      const op = object(change.operation); let operation: MemoryOperation;
      switch (op.type) {
        case 'add':
          exactFields(op, ['type', 'id', 'text', 'sourceIds']);
          if (known.has(string(op.id))) throw new Error('New memory ID already exists');
          operation = { type: 'add', id: nonempty(op.id), text: nonempty(op.text), sourceIds: sourceIds(op.sourceIds) }; break;
        case 'update':
          exactFields(op, ['type', 'id', 'expectedVersion', 'text', 'sourceIds']);
          operation = { type: 'update', ...target(op), text: nonempty(op.text), sourceIds: sourceIds(op.sourceIds) }; break;
        case 'soft_delete': case 'restore':
          exactFields(op, ['type', 'id', 'expectedVersion']);
          operation = { type: op.type, ...target(op) }; break;
        case 'merge': {
          exactFields(op, ['type', 'targets', 'replacement']);
          if (!Array.isArray(op.targets) || op.targets.length < 2) throw new Error('Merge needs at least two targets');
          const targets = op.targets.map(value => { const item = object(value); exactFields(item, ['id', 'expectedVersion']); return target(item); }), replacement = object(op.replacement);
          exactFields(replacement, ['id', 'text', 'sourceIds']);
          if (new Set(targets.map(value => value.id)).size !== targets.length) throw new Error('Repeated merge target');
          operation = { type: 'merge', targets, replacement: { id: nonempty(replacement.id), text: nonempty(replacement.text), sourceIds: sourceIds(replacement.sourceIds) } }; break;
        }
        default: throw new Error('Unsupported memory operation');
      }
      const reason = string(change.reason); if (!reason.trim()) throw new Error('Memory reason required');
      return { scope: input.scope, operationId: `${input.scope.turnId}:memory:${index}`, reason, createdAt: new Date().toISOString(), operation };
    });
}
