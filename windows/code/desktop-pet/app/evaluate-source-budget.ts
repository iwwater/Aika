/** Actual SQLite/provenance workload and production serialization, with zero network or model calls. */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import type { TurnScope } from '../contracts/index.js';
import type { MemorySource, MemoryTurnInput } from '../contracts/memory-lifecycle.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../memory/sqlite-store.js';
import { SqliteLifecycleMemoryPort } from '../memory/sqlite-lifecycle-port.js';
import { confirmedInvitationPolicy } from '../companion/invitations.js';
import { QwenMemoryTurnProvider } from '../providers/qwen-memory-lifecycle.js';
import { MEMORY_TURN_PROMPT } from '../providers/memory-lifecycle-prompt.js';
import { ProviderTransport } from '../providers/transport.js';
import { contextInputUpperBound, memoryTurnInputUpperBound, summaryInputUpperBound } from './input-budgets.js';

export async function evaluateSourceBudget(root: string, runId: string): Promise<void> {
  if (!root.startsWith('/') || !/^source-budget-[a-z0-9-]+$/.test(runId)) throw new Error('Explicit probe paths required');
  const out = `${root}/.local/${runId}`;
  await mkdir(out, { recursive: false });
  const sessionId = randomUUID(), scope = (): TurnScope => ({ characterId: 'friend', sessionId, turnId: randomUUID(), generation: 1 });
  const store = new SqliteMemoryStore({ filename: `${out}/synthetic.sqlite`, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
  const unchanged = (input: MemoryTurnInput) => ({ scope: input.scope, request: 'none' as const, changes: [], suppressSources: [], retainSources: [], clarification: null, reason: 'Controlled serialization probe, no semantic decisions' });
  const memory = new SqliteLifecycleMemoryPort(store, {
    context: { inputTokenBudget: 32_768, maxRecentMessages: 24, maxMemories: 32, summaryLimit: 8, countTokens: contextInputUpperBound, relevance: () => 1 },
    turn: { provider: { async plan(input) { return unchanged(input); } }, inputTokenBudget: 32_768, countTokens: memoryTurnInputUpperBound },
    summary: { provider: { async summarize() { throw new Error('Summary must not run'); } }, minMessages: 4, maxMessages: 4, inputTokenBudget: 32_768, countTokens: summaryInputUpperBound },
  });
  const user = (owned: TurnScope, text: string) => ({ characterId: owned.characterId, id: `${owned.turnId}:user`, role: 'user' as const, text, createdAt: store.now() });
  try {
    const originScope = scope(), origin = user(originScope, '我的猫叫团子'); await memory.append(originScope, [origin]);
    const seeded = store.apply({ scope: originScope, operationId: randomUUID(), createdAt: store.now(), reason: 'Synthetic user-supported seed', operation: { type: 'add', id: 'fixture-cat-memory', text: '用户养了一只名叫团子的猫', sourceIds: [origin.id] } });
    if (seeded.status !== 'applied') throw new Error('Synthetic seed failed');
    for (let index = 0; index < 20; index++) {
      const owned = scope(), message = user(owned, '今天聊聊日常安排'); await memory.append(owned, [message]);
      const signal = new AbortController().signal;
      const outcome = await memory.prepareTurn(owned, message.id, message.text, signal);
      if (outcome.status !== 'unchanged') throw new Error('Ordinary controlled turn failed');
      const context = await memory.context(owned, message.text, null, signal);
      await memory.appendAssistant(owned, { characterId: owned.characterId, id: `${owned.turnId}:assistant`, role: 'assistant', text: '收到，我们聊今天的安排。', createdAt: store.now() }, context, message.id, signal);
    }
    const owned = scope(), current = user(owned, '忘记我养猫和猫咪名字这件事。'); await memory.append(owned, [current]);
    const raw = store.visible(owned, 'transcript'), memories = store.visible(owned, 'memory');
    const ordered = [store.inspect(owned, current.id)!, ...raw.filter(record => record.id !== current.id), ...memories];
    const sources: MemorySource[] = ordered.map(record => ({ scope: owned, id: record.id, version: record.version, kind: record.kind as MemorySource['kind'], text: record.text, createdAt: record.createdAt, messageRole: record.message?.role ?? null, sourceVersions: record.sources, evidenceEligible: record.evidenceEligible ?? record.message?.role !== 'assistant' }));
    const input: MemoryTurnInput = { scope: owned, currentMessageId: current.id, sources, messages: raw.map(record => record.message!), relevantMemories: memories.map(record => ({ characterId: owned.characterId, id: record.id, version: record.version, text: record.text, sourceIds: record.sources.map(ref => ref.id) })) };
    let captured: { messages: { role: string; content: string }[] } | undefined;
    const transport = new ProviderTransport(async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ request: 'none', changes: [], suppressSources: [], retainSources: [], clarification: null, reason: 'Injected response: measures serialization only, does not execute forgetting' }) } }] });
    });
    await new QwenMemoryTurnProvider({ endpoint: 'https://fixture.invalid/completions', model: 'fixture', apiKey: () => 'fixture-only', authorizer: { async authorize() { return { async settle() {} }; } } }, transport).plan(input, new AbortController().signal);
    if (!captured) throw new Error('Production serialization was not captured');
    const wireBytes = captured.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0);
    await writeFile(`${out}/complete-input.json`, JSON.stringify(input, null, 2) + '\n', { flag: 'wx' });
    await writeFile(`${out}/serialized-messages.json`, JSON.stringify(captured.messages, null, 2) + '\n', { flag: 'wx' });
    await writeFile(`${out}/manifest.json`, JSON.stringify({ codeRef: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), actualSqlite: true, actualAssistantPort: true, actualProvider: false, networkCalls: 0, synthetic: true, ordinaryTurns: 20, rawRecords: raw.length, longMemories: memories.length, ancestorReferences: sources.reduce((sum, source) => sum + (source.sourceVersions?.length ?? 0), 0), productionWireBytesIncludingSystem: wireBytes, framingReserveBytes: 2048, inputUpperBound: memoryTurnInputUpperBound(input), oldUncompressedUpperBound: Buffer.byteLength(JSON.stringify(input)) + Buffer.byteLength(MEMORY_TURN_PROMPT) + 2048, unchangedInputBudget: 32_768, snapshotSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), forgetApplied: false, originalOlderCounterexampleReplayed: false, limitation: 'Fresh actual SQLite workload, not the old incomplete snapshot; complete payload measured through production adapter with injected transport. No semantic forgetting or timing acceptance.', retention: 'Synthetic database and complete source snapshot pinned for necessary-source expansion and large closure validation.' }, null, 2) + '\n', { flag: 'wx' });
  } finally { store.close(); }
}
