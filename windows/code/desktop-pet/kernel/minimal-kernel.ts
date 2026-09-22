/**
 * K65-03: the optional-feature-free kernel entry.
 *
 * This module owns the turn port and a real bounded recent-history store.  It deliberately imports no
 * TTS, STT, wake, visual, WeChat, Electron or native engine module.  Those capabilities are attached by
 * later packages through the public contracts; a text-only installation remains useful without them.
 */
import { randomUUID } from 'node:crypto';
import { NextTurnPort, type TurnPortEvent, type TurnPortSubmission } from '../core/turn-port.js';
import type { ConversationMessage, DialogueContext, DialogueProvider, MediaAsset, MediaStorePort, MemoryPort, PerceptionProvider, PlaybackPort, TtsProvider, TurnScope } from '../contracts/index.js';

export interface KernelDialogueOptions {
  readonly dialogue: DialogueProvider;
  readonly characterPrompt?: string;
  readonly inputTokenBudget?: number;
  readonly history?: RecentHistory;
}

/** The minimal product package's only persistence obligation: bounded, scoped recent turns. */
export class RecentHistory implements MemoryPort {
  private readonly records = new Map<string, ConversationMessage[]>();
  constructor(private readonly maxMessages = 24, private readonly inputTokenBudget = 8_192) {
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) throw new RangeError('maxMessages must be a positive integer');
    if (!Number.isSafeInteger(inputTokenBudget) || inputTokenBudget < 1) throw new RangeError('inputTokenBudget must be a positive integer');
  }
  async context(scope: TurnScope, _text: string, perception: import('../contracts/index.js').PerceptionResult | null, _signal: AbortSignal): Promise<DialogueContext> {
    const messages = this.records.get(scope.characterId) ?? [];
    return Object.freeze({ scope, characterPrompt: 'You are a helpful desktop companion.', recent: messages.slice(-this.maxMessages), summary: '', memories: [], perception, inputTokenBudget: this.inputTokenBudget });
  }
  async append(scope: TurnScope, messages: readonly ConversationMessage[]): Promise<void> {
    const current = this.records.get(scope.characterId) ?? [];
    const next = [...current, ...messages].slice(-this.maxMessages);
    this.records.set(scope.characterId, next.map(message => Object.freeze({ ...message })));
  }
  async maintain(): Promise<readonly never[]> { return []; }
  snapshot(characterId: string): readonly ConversationMessage[] { return [...(this.records.get(characterId) ?? [])]; }
}

/** Explicit unavailable capability adapters; these fail only if a caller requests the absent feature. */
const unavailable = (name: string): Error => new Error(`${name} capability is not installed in the minimal kernel`);
const noPerception: PerceptionProvider = { async perceive() { throw unavailable('perception'); } };
const noTts: TtsProvider = { async synthesize() { throw unavailable('tts'); } };
const noPlayback: PlaybackPort = { async play() { throw unavailable('playback'); }, async stop() {} };

class EphemeralMedia implements MediaStorePort {
  private readonly values = new Map<string, Uint8Array>();
  async put(scope: TurnScope, bytes: Uint8Array, mimeType: string): Promise<MediaAsset> {
    const id = `${scope.turnId}:${randomUUID()}`;
    this.values.set(id, new Uint8Array(bytes));
    return Object.freeze({ id, uri: `memory://${id}`, mimeType, temporary: true });
  }
  async read(_scope: TurnScope, asset: MediaAsset): Promise<Uint8Array> { return new Uint8Array(this.values.get(asset.id) ?? []); }
  async releaseScope(scope: TurnScope): Promise<void> { for (const id of this.values.keys()) if (id.startsWith(`${scope.turnId}:`)) this.values.delete(id); }
}

export class MinimalKernel {
  readonly history: RecentHistory;
  private readonly port: NextTurnPort;
  constructor(options: KernelDialogueOptions) {
    this.history = options.history ?? new RecentHistory(24, options.inputTokenBudget ?? 8_192);
    this.port = new NextTurnPort({
      outputMode: 'text', perception: noPerception, dialogue: options.dialogue, tts: noTts, playback: noPlayback,
      memory: this.history, mediaStore: new EphemeralMedia(),
    });
  }
  identity(): { readonly characterId: string; readonly sessionId: string } { return this.port.identity(); }
  subscribe(listener: (event: TurnPortEvent) => void): () => void { return this.port.subscribe(listener); }
  submit(submission: TurnPortSubmission): Promise<TurnScope> { return this.port.submit(submission); }
  cancel(scope?: TurnScope): void { this.port.cancel(scope); }
  close(): void { this.port.cancel(); }
}

export function createMinimalKernel(options: KernelDialogueOptions): MinimalKernel { return new MinimalKernel(options); }
