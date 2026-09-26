/**
 * core/input-text-source.ts
 *
 * N082-03: Input text and IME committed text source.
 * Extracts committed text segments from supported apps while strictly refusing
 * password/protected fields, in-progress compositions, and keystroke logs.
 */

import type { SourceGrant, InputTextCandidate } from '../contracts/companion-mode.js';

export interface RawInputCommitEvent {
  readonly commitId: string;
  readonly appIdentity: string;
  readonly inputMethod: string;
  readonly isPassword: boolean;
  readonly text: string;
  readonly isComposing?: boolean;
  readonly isCancelled?: boolean;
  readonly completeness: 'committed' | 'partial_correction' | 'replacement';
  readonly occurredAt?: string | null;
}

export interface InputTextSourceOptions {
  readonly maxFragmentBytes?: number; // 64 KiB cap
  readonly now?: () => string;
}

export class InputTextSource {
  private readonly maxFragmentBytes: number;
  private readonly now: () => string;
  private closed = false;
  private readonly seenCommits = new Set<string>();

  constructor(options: InputTextSourceOptions = {}) {
    this.maxFragmentBytes = options.maxFragmentBytes ?? 65_536; // 64 KiB
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(
    _grant: SourceGrant,
  ): Promise<{ close: () => Promise<void> }> {
    this.closed = false;
    this.seenCommits.clear();
    return {
      close: async () => {
        this.closed = true;
        this.seenCommits.clear();
      },
    };
  }

  /**
   * Process one raw commit event.
   * Rejects password controls, active composition intermediates, and cancelled inputs.
   */
  processCommit(grant: SourceGrant, event: RawInputCommitEvent): InputTextCandidate | null {
    if (this.closed) return null;
    if (grant.state !== 'active') return null;

    // 1. Password and protected control safeguard
    if (event.isPassword) {
      return null;
    }

    // 2. Composition intermediate or cancelled sequence safeguard
    if (event.isComposing || event.isCancelled) {
      return null;
    }

    // 3. Deduplication by commitId
    if (this.seenCommits.has(event.commitId)) {
      return null;
    }
    this.seenCommits.add(event.commitId);

    // 4. Empty text safeguard
    const rawText = event.text ?? '';
    if (!rawText.trim()) return null;

    // 5. Fragment byte cap (64 KiB)
    let text = rawText;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.maxFragmentBytes) {
      text = Buffer.from(text, 'utf8').subarray(0, this.maxFragmentBytes).toString('utf8');
    }

    const now = this.now();
    const candidate: InputTextCandidate = {
      id: `input-${event.commitId}`,
      revision: 1,
      pairing: grant.pairing,
      sourceKind: 'input_text',
      grantId: grant.grantId,
      grantRevision: grant.revision,
      modeGeneration: 1,
      nativeEventId: event.commitId,
      occurredAt: event.occurredAt ?? now,
      receivedAt: now,
      origin: 'input_method',
      confidence: 1.0,
      state: 'pending',
      expiresAt: grant.expiresAt,
      payloadRef: `input://${event.commitId}`,
      adapterId: 'uia-text-adapter-v1',
      adapterVersion: '1.0.0',
      appIdentity: event.appIdentity,
      inputMethod: event.inputMethod,
      commitId: event.commitId,
      text,
      completeness: event.completeness,
      captureMethod: 'ui_automation',
      textByteCount: Buffer.byteLength(text, 'utf8'),
    };

    return candidate;
  }
}
