// FIX61-09 shared harness: fake clock, real SQLite prefix store, real lifecycle port, real provider.
// The port, the store, the assembly and the provider are all production code; only the model transport
// is a fixture, and no part of the composition root under test is faked.
import { createHash } from 'node:crypto';
import type { DialogueContext, TurnScope } from '../../contracts/index.js';
import type { KnowledgeSelection } from '../../contracts/knowledge.js';
import type { MemoryTurnProvider } from '../../contracts/memory-lifecycle.js';
import type { SqliteMemoryStore } from '../../memory/sqlite-store.js';
import { PrefixSnapshotStore } from '../../memory/prefix-snapshot.js';
import type { SqliteLifecycleOptions, SqlitePrefixOptions } from '../../memory/sqlite-lifecycle-port.js';
import { OpenAiCompatibleDialogueProvider } from '../../providers/aika-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';
import { lifecycle } from '../memory/lifecycle-fixture.js';

export const HOUR = 3_600_000;
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface FakeClock { now(): string; advance(ms: number): void; at(): number }
export function fakeClock(start = '2026-09-06T12:00:00.000Z'): FakeClock {
  let time = Date.parse(start);
  return { now: () => new Date(time).toISOString(), advance: (ms: number) => { time += ms; }, at: () => time };
}

export interface PrefixHarness {
  readonly clock: FakeClock;
  readonly mode?: 'next-start' | 'interval';
  readonly intervalMs?: number;
  readonly tokenBudget?: number;
  readonly protocol?: string;
  readonly model?: string;
  readonly books?: () => KnowledgeSelection | null | Promise<KnowledgeSelection | null>;
  readonly identity?: (scope: TurnScope) => string;
  readonly maxMemories?: number;
  readonly summaryLimit?: number;
  readonly onBuildFailure?: (error: unknown) => void;
  readonly knowledgeRevision?: () => number | null;
  readonly suffixBytes?: number;
}

/** A production SqliteLifecycleMemoryPort with FIX61-09 snapshots enabled. */
export function prefixPort(store: SqliteMemoryStore, turn: MemoryTurnProvider['plan'] | undefined, harness: PrefixHarness) {
  const clock = harness.clock;
  const snapshots = new PrefixSnapshotStore(store.rawDatabaseForKnowledge(), { clock: () => clock.now(), ...(harness.mode ? { mode: harness.mode } : {}), ...(harness.intervalMs === undefined ? {} : { intervalMs: harness.intervalMs }) });
  const prefix: SqlitePrefixOptions = {
    store: snapshots,
    clock: () => clock.now(),
    countTokens: (context: DialogueContext, currentText: string) => JSON.stringify(context).length + currentText.length,
    tokenBudget: harness.tokenBudget ?? 200000,
    identity: harness.identity ?? ((scope: TurnScope) => store.prompt(scope)),
    binding: () => ({ protocol: harness.protocol ?? 'openai-compatible', model: harness.model ?? 'fixture-model' }),
    maxMemories: harness.maxMemories ?? 6,
    summaryLimit: harness.summaryLimit ?? 4,
    ...(harness.suffixBytes === undefined ? {} : { suffixBytes: harness.suffixBytes }),
    ...(harness.books ? { books: harness.books } : {}),
    ...(harness.knowledgeRevision ? { knowledgeRevision: harness.knowledgeRevision } : {}),
    onBuildFailure: (error: unknown) => { harness.onBuildFailure?.(error); if (process.env.FIX61_09_TRACE) console.error('[prefix-build-failure]', error); },
  };
  const override: Partial<SqliteLifecycleOptions> = { prefix };
  const port = lifecycle(store, turn, undefined, override);
  return { port, snapshots };
}

/**
 * The pre-FIX61-09 dynamic mode: the same production port with NO prefix configuration at all, so identity,
 * summary, knowledge, memories and history are assembled from live retrieval on every single turn. This is
 * the exact behaviour 09-E compares the frozen mode against.
 */
export function dynamicPort(store: SqliteMemoryStore, turn: MemoryTurnProvider['plan'] | undefined) {
  return lifecycle(store, turn, undefined, {});
}

export interface WireCall { readonly url: string; readonly messages: { role: string; content: string }[]; readonly body: Record<string, unknown> }
/** Real provider + real transport; the fetch fixture only replays a two-frame SSE answer. */
export function wire() {
  const calls: WireCall[] = [];
  const transport = new ProviderTransport((async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    calls.push({ url: String(url), messages: body.messages, body: body as unknown as Record<string, unknown> });
    const frames = [
      JSON.stringify({ choices: [{ delta: { content: '好' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { content: '。' }, finish_reason: 'stop' }] }),
      '[DONE]'
    ].map(frame => 'data: ' + frame + String.fromCharCode(13, 10, 13, 10)).join('');
    return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch);
  const provider = new OpenAiCompatibleDialogueProvider(transport, {
    endpoint: 'https://unit.invalid/v1/chat/completions', model: 'fixture-model', apiKey: () => 'test-only-key',
    authorizer: { async authorize() { return { async settle() {} }; } }
  }, 'CONSTRUCTOR-FALLBACK-MUST-NOT-SHADOW');
  return { calls, provider };
}

/**
 * The frozen region of one serialized request: the stable system block plus the frozen history the
 * snapshot pinned, exactly as the provider placed them. Everything after it is the dynamic suffix.
 */
export function frozenRegion(call: WireCall, context: DialogueContext): string {
  const prefix = context.prefix;
  if (!prefix) throw new Error('the context carries no frozen prefix');
  const end = 1 + prefix.messages.length;
  const head = call.messages[0];
  if (!head || head.role !== 'system') throw new Error('the stable block must be the first request part');
  if (head.content !== prefix.text) throw new Error('the system block is not the frozen text byte for byte');
  const frozen = call.messages.slice(1, end).map(item => ({ role: item.role, content: item.content }));
  const expected = prefix.messages.map(item => ({ role: item.role, content: item.text }));
  if (JSON.stringify(frozen) !== JSON.stringify(expected)) throw new Error('the frozen history is not in snapshot order');
  return JSON.stringify(call.messages.slice(0, end));
}

export function dynamicSuffix(call: WireCall, context: DialogueContext): string {
  const prefix = context.prefix;
  const end = prefix ? 1 + prefix.messages.length : 0;
  return call.messages.slice(end).map(item => item.role + ':' + item.content).join(String.fromCharCode(10));
}

export function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export function knowledgeSelection(libraryId: string, revision: number, blocks: readonly { documentId: string; ordinal: number; text: string }[]): KnowledgeSelection {
  return {
    libraryId, libraryRevision: 1, revision,
    blocks: blocks.map(block => ({ documentId: block.documentId, documentRevision: 1, libraryId, sourceName: block.documentId + '.md', ordinal: block.ordinal, text: block.text, locator: { start: 0, end: block.text.length } })),
    omittedCount: 0,
    inputTokens: blocks.reduce((sum, block) => sum + block.text.length, 0),
  };
}

/**
 * FIX61-06 production readers backed by a tiny in-process library state, so an activation change, a
 * document removal and a library switch raise the real KnowledgeSelection revision the way the store does.
 */
export function knowledgeBooks(initial: { libraryId: string; blocks: readonly { documentId: string; ordinal: number; text: string }[] } | null) {
  let state = initial;
  let revision = 1;
  const reads: number[] = [];
  return {
    reads,
    get revision() { return revision; },
    read: (): KnowledgeSelection | null => { reads.push(revision); return state ? knowledgeSelection(state.libraryId, revision, state.blocks) : null; },
    removeDocument: (documentId: string) => { revision++; if (state) state = { ...state, blocks: state.blocks.filter(block => block.documentId !== documentId) }; },
    switchTo: (next: { libraryId: string; blocks: readonly { documentId: string; ordinal: number; text: string }[] } | null) => { revision++; state = next; },
  };
}

/** Counts whole-library retrieval calls without faking the production retrieval itself. */
export function countingStore(store: SqliteMemoryStore) {
  const counts = { rank: 0, contextRecords: 0 };
  const rank = store.recall.rank.bind(store.recall);
  store.recall.rank = (...args: Parameters<typeof rank>) => { counts.rank++; return rank(...args); };
  const records = store.contextRecords.bind(store);
  store.contextRecords = (...args: Parameters<typeof records>) => { counts.contextRecords++; return records(...args); };
  return counts;
}
