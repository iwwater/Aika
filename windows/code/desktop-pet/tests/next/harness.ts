// NEXT-01 contract harness: replaces dependencies only; the code under test is always upstream production code.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CapturedInput, DesktopEvent, DialogueContext, DialogueReply, DialogueRequest, PlaybackEvent, PerceptionResult, TtsResult, TurnScope } from '../../contracts/index.js';
import type { DialoguePorts } from '../../core/dialogue-pipeline.js';
import { COMPANION_ID } from '../../contracts/character.js';
import { MemoryMediaStore } from '../../media/store.js';

/** Single-slot controllable promise for injecting late, failing or never-settling dependency responses. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Deterministic scheduler hop. Logic assertions must never wait on real timeouts. */
export const tick = (): Promise<void> => new Promise<void>(done => { setImmediate(done); });

/** Injectable clock for anything that records timestamps; keeps runs byte-identical. */
export function virtualClock(start = '2026-09-19T00:00:00.000Z') {
  let current = Date.parse(start);
  return {
    now: (): string => new Date(current).toISOString(),
    advance: (ms: number): void => { current += ms; }
  };
}

export const nextScope = (turnId: string, generation = 1, sessionId = 'session-a'): TurnScope =>
  Object.freeze({ characterId: COMPANION_ID, sessionId, turnId, generation });

export const okPerception = (scope: TurnScope, transcript: string): PerceptionResult =>
  ({ scope, transcript, modalities: [], cues: [], status: 'complete' });

export const baseContext = (scope: TurnScope, recent: readonly { id: string; role: 'user' | 'assistant'; text: string }[] = []): DialogueContext => ({
  scope,
  characterPrompt: '朋友角色',
  recent: recent.map(message => ({ characterId: scope.characterId, id: message.id, role: message.role, text: message.text, createdAt: virtualClock().now() })),
  summary: '',
  memories: [],
  perception: null,
  inputTokenBudget: 5000
});

export interface ReplyPlan { gate?: ReturnType<typeof deferred<void>>; text?: string; failure?: Error; }

export interface FakePorts {
  ports: DialoguePorts;
  events: DesktopEvent[];
  appended: { scope: TurnScope; roles: string[]; texts: string[] }[];
  released: string[];
  replyCalls: DialogueRequest[];
  contextCalls: TurnScope[];
  contexts: DialogueContext[];
  callOrder: string[];
  media: MemoryMediaStore;
  playbackHandles: { input: TtsResult; emit: (event: PlaybackEvent) => void }[];
  playbackStopCalls: TurnScope[];
  playbackGate: ReturnType<typeof deferred<void>>;
}

/** In-memory DialoguePorts double. `plans` gates or fails replies keyed by turnId to inject lateness and provider errors. */
export function fakePorts(options: { outputMode?: 'voice' | 'text'; context?: (scope: TurnScope) => DialogueContext; plans?: Map<string, ReplyPlan>; perception?: (input: CapturedInput) => Promise<PerceptionResult> } = {}): FakePorts {
  const events: DesktopEvent[] = [];
  const appended: { scope: TurnScope; roles: string[]; texts: string[] }[] = [];
  const released: string[] = [];
  const replyCalls: DialogueRequest[] = [];
  const contextCalls: TurnScope[] = [];
  const contexts: DialogueContext[] = [];
  const callOrder: string[] = [];
  const media = new MemoryMediaStore();
  const playbackHandles: { input: TtsResult; emit: (event: PlaybackEvent) => void }[] = [];
  const playbackStopCalls: TurnScope[] = [];
  const playbackGate = deferred<void>();
  const plans = options.plans ?? new Map<string, ReplyPlan>();
  const ports: DialoguePorts = {
    ...(options.outputMode ? { outputMode: options.outputMode } : {}),
    perception: { perceive: options.perception ?? (async input => okPerception(input.scope, '你好呀')) },
    dialogue: {
      reply: async request => {
        replyCalls.push(request);
        const plan = plans.get(request.scope.turnId);
        if (plan?.gate) await plan.gate.promise;
        if (plan?.failure) throw plan.failure;
        return { scope: request.scope, text: plan?.text ?? '我在。', expression: { emotion: 'calm', intensity: 0.3, delivery: '温和自然', gesture: null } };
      }
    },
    tts: {
      synthesize: async input => ({ scope: input.scope, audio: await media.put(input.scope, new Uint8Array([0, 0, 0, 0]), 'audio/wav'), expression: input.expression, durationMs: 1000, synchronization: 'amplitude' })
    },
    playback: {
      play: async (input, emit) => { playbackHandles.push({ input, emit }); await playbackGate.promise; },
      stop: async scope => { playbackStopCalls.push(scope); }
    },
    memory: {
      context: async (scope, _text, perception) => {
        contextCalls.push(scope);
        callOrder.push('context');
        const produced = options.context ? options.context(scope) : baseContext(scope);
        contexts.push(produced);
        return produced;
      },
      append: async (scope, messages) => {
        appended.push({ scope, roles: messages.map(m => m.role), texts: messages.map(m => m.text) });
        callOrder.push(`append:${messages.map(m => m.role).join('+')}`);
      },
      maintain: async () => []
    },
    mediaStore: {
      put: (scope, bytes, mimeType) => media.put(scope, bytes, mimeType),
      read: (scope, asset) => media.read(scope, asset),
      releaseScope: async scope => { released.push(scope.turnId); }
    }
  };
  return { ports, events, appended, released, replyCalls, contextCalls, contexts, callOrder, media, playbackHandles, playbackStopCalls, playbackGate };
}

export interface TempStore { filename: string; cleanup(): Promise<void>; }

/** Absolute-path SQLite file in a fresh temp dir; `assertDatabaseFileIdentity` requires an absolute path. */
export async function tempStore(prefix = 'next-contract-'): Promise<TempStore> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { filename: resolve(dir, 'companion.sqlite'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}
